// The VS Code side of secret environment variables (ticket 30): `context.secrets` holds the values,
// `secretEnv.ts`'s `SecretValues` keeps the declared ones in memory for the commands. Loaded at
// activation and again on the secret storage's change event (for our keys), on a
// `redpandaConnect.secretEnv` change and on a workspace folder change; only the latest load is kept,
// and `onDidChange` fires when a load changes a value (the live Bloblang check then re-parses).
//
// The secret storage cannot list its keys on 1.100, so the keys this extension stored are recorded
// in `globalState` (not synced) for "Clear stored secrets". Three commands: "Set secret variable"
// (the folder in a multi-root workspace, a name, then the value in a password input; the name is
// added to that folder's `secretEnv`), "Remove secret variable" (the value only: the declared name
// stays) and "Clear stored secrets" (every recorded key, after a confirmation). No value is ever
// logged or shown in a message. The composition root makes `values` the one the commands read
// (`setActiveSecretValues`).

import * as vscode from 'vscode';
import {
	CLEAR_SECRETS_COMMAND, declaredSecretNames, isSecretKey, parseSecretKey, REMOVE_SECRET_COMMAND, SECRET_ENV_SETTING,
	SecretValues, secretKey, secretNameProblem, SET_SECRET_COMMAND, WINDOW_SCOPE,
} from '../redpandaConnect/secretEnv';

/** How long a load trusts this window's write over an older value read back. */
const WRITE_SETTLE_MS = 5_000;

/** The `globalState` key of the recorded secret storage keys. */
export const SECRET_KEYS_STATE = 'redpandaConnect.secretKeys';

/** What the extension needs from `context.secrets` (tests may pass a fake). */
export interface SecretStore {
	get(key: string): Thenable<string | undefined>;
	store(key: string, value: string): Thenable<void>;
	delete(key: string): Thenable<void>;
	readonly onDidChange: vscode.Event<{ readonly key: string }>;
}

export interface SecretVariablesOptions {
	readonly store: SecretStore;
	/** `context.globalState`, for the recorded keys. */
	readonly memento: vscode.Memento;
	readonly log: (line: string) => void;
	/** Test seams: the settle window (default `WRITE_SETTLE_MS`), the setting write and the messages. */
	readonly settleMs?: number;
	readonly updateSetting?: (config: vscode.WorkspaceConfiguration, value: string[], target: vscode.ConfigurationTarget) => Thenable<void>;
	readonly notify?: (kind: 'error' | 'info', message: string) => void;
}

/** A scope: a workspace folder, or the window (no folder). */
type Scope = vscode.WorkspaceFolder | undefined;

const scopeOf = (folder: Scope): string => (folder ? folder.uri.toString() : WINDOW_SCOPE);
const labelOf = (folder: Scope): string => (folder ? `folder "${folder.name}"` : 'this window');
const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class SecretVariables implements vscode.Disposable {
	readonly values: SecretValues;
	private readonly emitter = new vscode.EventEmitter<void>();
	private readonly subscriptions: vscode.Disposable[] = [];
	/** Bumped by every load and every write, so only the latest load applies. */
	private generation = 0;
	private latest: Promise<void> = Promise.resolve();
	private disposed = false;
	/**
	 * This window's own writes, by key (`undefined`: removed), for `WRITE_SETTLE_MS`: the secret
	 * storage can briefly return an older value after a write, even after it returned the new one
	 * (seen on 1.143.1 when one key is set twice in a row), and a load must not undo the write.
	 */
	private readonly written = new Map<string, { readonly value: string | undefined; readonly until: number }>();
	/** The reload when the last write's settle window ends, so another window's change still arrives. */
	private settleTimer: NodeJS.Timeout | undefined;
	/** Updates of the recorded keys, one at a time (each reads, filters and writes the list). */
	private recording: Promise<void> = Promise.resolve();

	/** Fires when a value the commands read changed. */
	readonly onDidChange: vscode.Event<void> = this.emitter.event;

	constructor(private readonly options: SecretVariablesOptions) {
		this.values = new SecretValues(options.log);
		this.subscriptions.push(
			this.emitter,
			options.store.onDidChange((e) => {
				if (isSecretKey(e.key)) {
					void this.reload();
				}
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration(SECRET_ENV_SETTING)) {
					void this.reload();
				}
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => void this.reload()),
		);
		void this.reload();
	}

	/** Resolves when the latest load (started before the call) has finished. Never rejects. */
	get settled(): Promise<void> {
		return this.latest;
	}

	/** Loads the values of the names each scope declares; never rejects. */
	reload(): Promise<void> {
		const generation = ++this.generation;
		const load = async () => {
			const keys = new Set<string>();
			for (const folder of [undefined, ...(vscode.workspace.workspaceFolders ?? [])]) {
				const raw = vscode.workspace.getConfiguration('redpandaConnect', folder?.uri).get<unknown>('secretEnv', []);
				for (const name of declaredSecretNames(raw).names) {
					keys.add(secretKey(scopeOf(folder), name));
				}
			}
			const loaded = new Map<string, string>();
			let failure: string | undefined;
			await Promise.all([...keys].map(async (key) => {
				try {
					const value = this.settle(key, await this.options.store.get(key));
					if (value !== undefined) {
						loaded.set(key, value);
					}
				} catch (err) {
					failure ??= reasonOf(err);
					const parsed = parseSecretKey(key);
					const previous = parsed && this.values.get(parsed.scope, parsed.name);
					if (previous !== undefined) {
						loaded.set(key, previous);
					}
				}
			}));
			if (failure !== undefined) {
				this.options.log(`${SECRET_ENV_SETTING}: could not read the secret storage: ${failure}`);
			}
			if (generation === this.generation && !this.disposed && this.values.replace(loaded)) {
				this.emitter.fire();
			}
		};
		const run = load().catch((err) => this.options.log(`${SECRET_ENV_SETTING}: could not load the secrets: ${reasonOf(err)}`));
		this.latest = run;
		return run;
	}

	/** What a load keeps for `key`, given the value it read: this window's newer write, if any. */
	private settle(key: string, read: string | undefined): string | undefined {
		const write = this.written.get(key);
		if (!write) {
			return read;
		}
		if (Date.now() > write.until) {
			this.written.delete(key);
			return read;
		}
		return write.value;
	}

	/** Notes this window's write of `key` and applies it to the values the commands read. */
	private wrote(key: string, value: string | undefined): void {
		this.generation++;
		const settleMs = this.options.settleMs ?? WRITE_SETTLE_MS;
		this.written.set(key, { value, until: Date.now() + settleMs });
		this.values.put(key, value);
		if (this.settleTimer) {
			clearTimeout(this.settleTimer);
		}
		this.settleTimer = setTimeout(() => {
			this.settleTimer = undefined;
			if (!this.disposed) {
				void this.reload();
			}
		}, settleMs + 50);
	}

	/** The secret storage keys this extension recorded as stored. */
	recordedKeys(): string[] {
		const raw = this.options.memento.get<unknown>(SECRET_KEYS_STATE, []);
		return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
	}

	/**
	 * Stores `value` for `name` in `folder` (the window without one) and adds `name` to that scope's
	 * `secretEnv`. A refused name, a failing store or a name that cannot be added to the setting
	 * (the stored value is then removed again) stores nothing and returns `false`, with an error
	 * message (never the value).
	 */
	async set(folder: Scope, name: string, value: string): Promise<boolean> {
		const problem = secretNameProblem(name);
		if (problem) {
			this.notify('error', `Can't set the secret variable: ${problem}`);
			return false;
		}
		const key = secretKey(scopeOf(folder), name);
		try {
			await this.options.store.store(key, value);
		} catch (err) {
			const reason = value ? reasonOf(err).split(value).join('…') : reasonOf(err);
			this.options.log(`${SECRET_ENV_SETTING}: could not store ${name} for ${labelOf(folder)}: ${reason}`);
			this.notify('error', `Could not store the secret variable ${name}: ${reason}`);
			return false;
		}
		this.wrote(key, value);
		await this.record(key, true);
		// Declared first, so a re-parse the change triggers sees both the name and the value.
		const declareProblem = await this.declare(folder, name);
		if (declareProblem !== undefined) {
			this.options.log(`${SECRET_ENV_SETTING}: ${name} could not be added to the setting, so its value is not kept: ${declareProblem}`);
			this.notify('error', `Could not set the secret variable ${name}: it could not be added to ${SECRET_ENV_SETTING}: ${declareProblem}`);
			try {
				await this.options.store.delete(key);
			} catch (err) {
				this.options.log(`${SECRET_ENV_SETTING}: could not remove ${name} for ${labelOf(folder)} again: ${reasonOf(err)}`);
			}
			this.wrote(key, undefined);
			await this.record(key, false);
			this.emitter.fire();
			await this.reload();
			return false;
		}
		this.emitter.fire();
		await this.reload();
		return true;
	}

	/** Removes the value of `name` in `folder` (the declared name stays). `false` when that fails. */
	async remove(folder: Scope, name: string): Promise<boolean> {
		const key = secretKey(scopeOf(folder), name);
		try {
			await this.options.store.delete(key);
		} catch (err) {
			this.options.log(`${SECRET_ENV_SETTING}: could not remove ${name} for ${labelOf(folder)}: ${reasonOf(err)}`);
			this.notify('error', `Could not remove the secret variable ${name}: ${reasonOf(err)}`);
			return false;
		}
		this.wrote(key, undefined);
		this.emitter.fire();
		await this.record(key, false);
		await this.reload();
		return true;
	}

	/**
	 * Removes every recorded key (and every loaded one) from the secret storage, once `confirm`
	 * resolves `true`; returns how many were removed (0 when cancelled).
	 */
	async clear(confirm: (count: number) => Thenable<boolean> = confirmClear): Promise<number> {
		const keys = [...new Set([...this.recordedKeys(), ...this.values.keys()])];
		if (keys.length === 0) {
			this.notify('info', 'There are no stored secret variables.');
			return 0;
		}
		if (!(await confirm(keys.length))) {
			return 0;
		}
		const left: string[] = [];
		let failure: string | undefined;
		for (const key of keys) {
			try {
				await this.options.store.delete(key);
			} catch (err) {
				left.push(key);
				failure ??= reasonOf(err);
			}
		}
		for (const key of keys.filter((k) => !left.includes(k))) {
			this.wrote(key, undefined);
		}
		this.emitter.fire();
		await this.serialized(async () => {
			await this.options.memento.update(SECRET_KEYS_STATE, this.recordedKeys().filter((k) => !keys.includes(k) || left.includes(k)));
		});
		if (failure !== undefined) {
			this.options.log(`${SECRET_ENV_SETTING}: could not remove ${left.length} stored secret(s): ${failure}`);
			this.notify('error', `Could not remove ${left.length} stored secret variable(s): ${failure}`);
		}
		await this.reload();
		return keys.length - left.length;
	}

	/** "Set secret variable": a folder (multi-root), a name, then the value (password input). */
	async setCommand(): Promise<void> {
		const folder = await pickFolder('Set a secret variable for which folder?');
		if (folder === null) {
			return;
		}
		const name = await vscode.window.showInputBox({
			title: `Secret variable for ${labelOf(folder)}`,
			prompt: 'The variable name, as ${NAME} reads it. It is added to redpandaConnect.secretEnv; the value is kept in the secret storage on this machine.',
			placeHolder: 'API_TOKEN',
			ignoreFocusOut: true,
			validateInput: (text) => secretNameProblem(text.trim()),
		});
		if (name === undefined) {
			return;
		}
		const trimmed = name.trim();
		const value = await vscode.window.showInputBox({
			title: `Value of ${trimmed} for ${labelOf(folder)}`,
			prompt: 'Kept in the secret storage on this machine, never in a settings file.',
			password: true,
			ignoreFocusOut: true,
		});
		if (value === undefined) {
			return;
		}
		await this.setAndTell(folder, trimmed, value);
	}

	/** `set`, then "Secret variable X is set" when it worked (the command's last step). */
	async setAndTell(folder: Scope, name: string, value: string): Promise<boolean> {
		const ok = await this.set(folder, name, value);
		if (ok) {
			this.notify('info', `Secret variable ${name} is set for ${labelOf(folder)}.`);
		}
		return ok;
	}

	/** "Remove secret variable": a folder (multi-root), then one of its stored names. */
	async removeCommand(): Promise<void> {
		const folder = await pickFolder('Remove a secret variable of which folder?');
		if (folder === null) {
			return;
		}
		const scope = scopeOf(folder);
		const names = new Set<string>();
		for (const key of [...this.recordedKeys(), ...this.values.keys()]) {
			const parsed = parseSecretKey(key);
			if (parsed?.scope === scope) {
				names.add(parsed.name);
			}
		}
		if (names.size === 0) {
			this.notify('info', `No secret variable is stored for ${labelOf(folder)}.`);
			return;
		}
		const name = await vscode.window.showQuickPick([...names].sort(), {
			title: `Remove a secret variable of ${labelOf(folder)}`,
			placeHolder: 'The value is removed from the secret storage; the name stays in redpandaConnect.secretEnv.',
		});
		if (name !== undefined && await this.remove(folder, name)) {
			this.notify('info', `Secret variable ${name} is removed for ${labelOf(folder)}.`);
		}
	}

	/** "Clear stored secrets", after a confirmation. */
	async clearCommand(): Promise<void> {
		const removed = await this.clear();
		if (removed > 0) {
			this.notify('info', `Removed ${removed} stored secret variable(s).`);
		}
	}

	registerCommands(): vscode.Disposable[] {
		return [
			vscode.commands.registerCommand(SET_SECRET_COMMAND, () => this.setCommand()),
			vscode.commands.registerCommand(REMOVE_SECRET_COMMAND, () => this.removeCommand()),
			vscode.commands.registerCommand(CLEAR_SECRETS_COMMAND, () => this.clearCommand()),
		];
	}

	dispose(): void {
		this.disposed = true;
		if (this.settleTimer) {
			clearTimeout(this.settleTimer);
		}
		this.subscriptions.forEach((s) => s.dispose());
	}

	private notify(kind: 'error' | 'info', message: string): void {
		if (this.options.notify) {
			this.options.notify(kind, message);
		} else if (kind === 'error') {
			void vscode.window.showErrorMessage(message);
		} else {
			void vscode.window.showInformationMessage(message);
		}
	}

	private record(key: string, stored: boolean): Promise<void> {
		return this.serialized(async () => {
			const keys = this.recordedKeys().filter((k) => k !== key);
			await this.options.memento.update(SECRET_KEYS_STATE, stored ? [...keys, key] : keys);
		});
	}

	/** Runs `update` after every earlier update of the recorded keys; never rejects. */
	private serialized(update: () => Promise<void>): Promise<void> {
		const next = this.recording.then(update).catch((err) => {
			this.options.log(`${SECRET_ENV_SETTING}: could not record the stored keys: ${reasonOf(err)}`);
		});
		this.recording = next;
		return next;
	}

	/**
	 * Adds `name` to `secretEnv` at the folder level (multi-root), the workspace level (one folder)
	 * or the user level (no folder). When that level has no value yet, it starts from the effective
	 * list, so the names of a less specific level are not hidden (lists do not merge). Returns why
	 * it failed, if it did.
	 */
	private async declare(folder: Scope, name: string): Promise<string | undefined> {
		const config = vscode.workspace.getConfiguration('redpandaConnect', folder?.uri);
		const target = !folder
			? vscode.ConfigurationTarget.Global
			: vscode.workspace.workspaceFile
				? vscode.ConfigurationTarget.WorkspaceFolder
				: vscode.ConfigurationTarget.Workspace;
		const inspected = config.inspect<unknown>('secretEnv');
		const atTarget = target === vscode.ConfigurationTarget.Global
			? inspected?.globalValue
			: target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.workspaceFolderValue;
		const base = Array.isArray(atTarget) ? atTarget : (Array.isArray(config.get<unknown>('secretEnv')) ? config.get<unknown[]>('secretEnv')! : []);
		if (base.includes(name)) {
			return undefined;
		}
		try {
			const next = [...base.filter((n): n is string => typeof n === 'string'), name];
			await (this.options.updateSetting ? this.options.updateSetting(config, next, target) : config.update('secretEnv', next, target));
			return undefined;
		} catch (err) {
			return reasonOf(err);
		}
	}
}

/** The label of the pick item for configs outside every workspace folder (the window's secrets). */
export const NO_FOLDER_LABEL = 'No folder (files outside the workspace folders)';

/**
 * The folder to act on: with folders open, a pick among them and "No folder" (`undefined`, the
 * window's secrets, declared in the user settings); `null` when cancelled; `undefined` with none.
 */
async function pickFolder(title: string): Promise<Scope | null> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) {
		return undefined;
	}
	const active = vscode.window.activeTextEditor?.document.uri;
	const current = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
	const ordered = current ? [current, ...folders.filter((f) => f !== current)] : [...folders];
	const items: { label: string; description?: string; folder: Scope }[] = [
		...ordered.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
		{ label: NO_FOLDER_LABEL, description: 'declared in the user settings', folder: undefined },
	];
	const picked = await vscode.window.showQuickPick(items, { title });
	return picked ? picked.folder : null;
}

async function confirmClear(count: number): Promise<boolean> {
	const action = 'Remove';
	const answer = await vscode.window.showWarningMessage(
		`Remove the ${count} secret variable value(s) this extension stored on this machine? The names in ${SECRET_ENV_SETTING} stay.`,
		{ modal: true },
		action,
	);
	return answer === action;
}
