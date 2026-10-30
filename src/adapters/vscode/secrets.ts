// The VS Code side of secret environment variables (ticket 30): `context.secrets` holds the values,
// `secretEnv.ts`'s `SecretValues` keeps the declared ones in memory for the commands. Loaded at
// activation and again on the secret storage's change event (for our keys), on a
// `redpandaConnect.secretEnv` change and on a workspace folder change; only the latest load is kept,
// and `onDidChange` fires when a load changes a value (the live Bloblang check then re-parses).
//
// The secret storage cannot list its keys on 1.100, so the keys this extension stored are recorded
// in `globalState` (not synced) for "Clear stored secrets". Three commands: "Set secret variable"
// (the folder in a multi-root workspace, a name, then the value in a password input; the name is
// added to that folder's `secretEnv`), "Remove secret variable" (ticket 39: a stored value, or a
// declared name without one; for a value, the value only or the value and its name) and "Clear
// stored secrets" (every recorded key, after a confirmation). No value is ever
// logged or shown in a message. The composition root makes `values` the one the commands read
// (`setActiveSecretValues`).

import * as vscode from 'vscode';
import {
	CLEAR_SECRETS_COMMAND, declaredSecretNames, isSecretKey, parseSecretKey, REMOVE_SECRET_COMMAND, SECRET_ENV_SETTING,
	SecretValues, secretKey, secretNameProblem, SET_SECRET_COMMAND, WINDOW_SCOPE,
} from '../redpandaConnect/secretEnv';
import type { SettingLevel } from './environmentModel';
import {
	nameRemovedText, newVariableLevel, pickSecretRemoval, type SecretRemovalChoice, SETTING_TARGETS, settingsLevelText,
} from './environmentView';

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
	readonly updateSetting?: (config: vscode.WorkspaceConfiguration, value: unknown[] | undefined, target: vscode.ConfigurationTarget) => Thenable<void>;
	readonly notify?: (kind: 'error' | 'info', message: string) => void;
	/** Ticket 39 test seams: "Remove secret variable"'s value-only / value-and-name pick and its confirmation for a name without a value. */
	readonly pickRemoval?: (name: string, where: string) => Thenable<SecretRemovalChoice | undefined>;
	readonly confirmRemoveName?: (name: string, where: string) => Thenable<boolean>;
}

/**
 * Ticket 39: what removing a name did. `ok`: everything asked was done (a name declared nowhere
 * counts as removed); `where`: the settings it left (noting when other folders' configs use that
 * list too); `nowApplies`: the less specific list that applies to the folder once its emptied list is
 * removed (`appliesTo`: to what); `stillDeclaredIn`: that list, when it still holds the name.
 */
export interface NameRemoval {
	readonly ok: boolean;
	readonly where?: string;
	readonly nowApplies?: string;
	readonly appliesTo?: string;
	readonly stillDeclaredIn?: string;
}

/** A scope: a workspace folder, or the window (no folder). */
export type Scope = vscode.WorkspaceFolder | undefined;

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
	 * Ticket 39: where `name` is declared for `folder` (the settings of the `secretEnv` list the
	 * config uses, as a message names them), `undefined` when that list does not hold it.
	 */
	declaredAt(folder: Scope, name: string): string | undefined {
		const used = usedSecretList(folder);
		return used && declaredSecretNames(used.list).names.includes(name) ? usedListText(folder, used.level) : undefined;
	}

	/**
	 * Ticket 39: removes `name` from the `secretEnv` list the config uses (its value is left as is),
	 * with an error message when the settings cannot be written.
	 */
	async removeName(folder: Scope, name: string): Promise<NameRemoval> {
		const removed = await this.undeclare(folder, name);
		if (removed.problem !== undefined) {
			this.options.log(`${SECRET_ENV_SETTING}: could not remove ${name} from ${removed.where} for ${labelOf(folder)}: ${removed.problem}`);
			this.notify('error', `Could not remove ${name} from ${SECRET_ENV_SETTING} in ${removed.where}: ${removed.problem}`);
			return { ok: false, ...(removed.where !== undefined ? { where: removed.where } : {}) };
		}
		await this.reload();
		return { ok: true, ...removed };
	}

	/**
	 * Ticket 39: removes the value of `name`, then its name. When the value cannot be removed nothing
	 * else changes; when the name cannot, the error says the value is removed and the name is not.
	 */
	async removeValueAndName(folder: Scope, name: string): Promise<NameRemoval> {
		if (!(await this.remove(folder, name))) {
			return { ok: false };
		}
		const removed = await this.undeclare(folder, name);
		if (removed.problem !== undefined) {
			this.options.log(`${SECRET_ENV_SETTING}: the value of ${name} for ${labelOf(folder)} is removed, but the name could not be removed from ${removed.where}: ${removed.problem}`);
			this.notify('error', `The value of the secret variable ${name} is removed, but its name is not: it could not be removed from ${SECRET_ENV_SETTING} in ${removed.where}: ${removed.problem}`);
			return { ok: false, ...(removed.where !== undefined ? { where: removed.where } : {}) };
		}
		await this.reload();
		return { ok: true, ...removed };
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

	/**
	 * "Set secret variable": a folder (multi-root), a name, then the value (password input). With
	 * `prefill` (ticket 31's Environment view, ticket 32's test panel), the folder is given and the
	 * name input starts with `prefill.name`. `input` is the input box (a test seam). Returns the
	 * name a value was set for (the user may edit the prefilled one), `undefined` when none was.
	 */
	async setCommand(
		prefill?: { readonly folder: Scope; readonly name?: string },
		input: (options: vscode.InputBoxOptions) => Thenable<string | undefined> = vscode.window.showInputBox,
	): Promise<string | undefined> {
		const folder = prefill ? prefill.folder : await pickFolder('Set a secret variable for which folder?');
		if (folder === null) {
			return undefined;
		}
		const name = await input({
			title: `Secret variable for ${labelOf(folder)}`,
			prompt: 'The variable name, as ${NAME} reads it. It is added to redpandaConnect.secretEnv; the value is kept in the secret storage on this machine.',
			placeHolder: 'API_TOKEN',
			...(prefill?.name !== undefined ? { value: prefill.name } : {}),
			ignoreFocusOut: true,
			validateInput: (text) => secretNameProblem(text.trim()),
		});
		if (name === undefined) {
			return undefined;
		}
		const trimmed = name.trim();
		const value = await input({
			title: `Value of ${trimmed} for ${labelOf(folder)}`,
			prompt: 'Kept in the secret storage on this machine, never in a settings file.',
			password: true,
			ignoreFocusOut: true,
		});
		if (value === undefined) {
			return undefined;
		}
		// The name set (ticket 32: the prefilled one can be edited), `undefined` when nothing was.
		return await this.setAndTell(folder, trimmed, value) ? trimmed : undefined;
	}

	/** `set`, then "Secret variable X is set" when it worked (the command's last step). */
	async setAndTell(folder: Scope, name: string, value: string): Promise<boolean> {
		const ok = await this.set(folder, name, value);
		if (ok) {
			this.notify('info', `Secret variable ${name} is set for ${labelOf(folder)}.`);
		}
		return ok;
	}

	/**
	 * "Remove secret variable": a folder (multi-root), then one of its stored names or (ticket 39) a
	 * declared name without a value. A stored one that is declared asks: the value only (the default)
	 * or the value and its name; one without a value is removed from the setting after a
	 * confirmation. Both name the settings file. `pick` is the name pick (a test seam).
	 */
	async removeCommand(
		pick: (items: RemoveItem[], options: vscode.QuickPickOptions) => Thenable<RemoveItem | undefined> = (items, options) => vscode.window.showQuickPick(items, options),
	): Promise<void> {
		const folder = await pickFolder('Remove a secret variable of which folder?');
		if (folder === null) {
			return;
		}
		const scope = scopeOf(folder);
		const stored = new Set<string>();
		for (const key of [...this.recordedKeys(), ...this.values.keys()]) {
			const parsed = parseSecretKey(key);
			if (parsed?.scope === scope) {
				stored.add(parsed.name);
			}
		}
		const declared = declaredSecretNames(vscode.workspace.getConfiguration('redpandaConnect', folder?.uri).get<unknown>('secretEnv', [])).names;
		const items: RemoveItem[] = [
			...[...stored].sort().map((name) => ({ label: name, description: 'value stored on this machine', name, hasValue: true })),
			...declared.filter((n) => !stored.has(n)).sort().map((name) => ({ label: name, description: `declared in ${SECRET_ENV_SETTING}, no value on this machine`, name, hasValue: false })),
		];
		if (items.length === 0) {
			this.notify('info', `No secret variable is stored or declared for ${labelOf(folder)}.`);
			return;
		}
		const picked = await pick(items, {
			title: `Remove a secret variable of ${labelOf(folder)}`,
			placeHolder: 'A stored value, or a declared name without one',
		});
		if (picked === undefined) {
			return;
		}
		const { name } = picked;
		const where = this.declaredAt(folder, name);
		if (!picked.hasValue) {
			if (where === undefined || !(await (this.options.confirmRemoveName ?? confirmRemoveName)(name, where))) {
				return;
			}
			const removed = await this.removeName(folder, name);
			if (removed.ok) {
				this.notify('info', nameRemovedText(name, removed.where ?? where, false, removed));
			}
			return;
		}
		const choice: SecretRemovalChoice | undefined = where === undefined ? 'value' : await (this.options.pickRemoval ?? pickSecretRemoval)(name, where);
		if (choice === 'both') {
			const removed = await this.removeValueAndName(folder, name);
			if (removed.ok) {
				this.notify('info', nameRemovedText(name, removed.where ?? where!, true, removed));
			}
		} else if (choice === 'value' && await this.remove(folder, name)) {
			this.notify('info', `Secret variable ${name} is removed for ${labelOf(folder)}${where ? `; the name stays in ${SECRET_ENV_SETTING}` : ''}.`);
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
			vscode.commands.registerCommand(SET_SECRET_COMMAND, () => this.setCommand().then(() => undefined)),
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
	 * Adds `name` to `secretEnv` at the level a new plain variable gets (`newVariableLevel`): the
	 * folder level with more than one workspace folder, the workspace level with one (also through a
	 * workspace file), the user level with none. Lists do not merge, so when a more specific level
	 * already has a list (a folder list from before bug 33), the name goes to that list instead, or
	 * it would be hidden. When the chosen level has no value yet, it starts from the effective list,
	 * so the names of a less specific level are not hidden either. Returns why it failed, if it did.
	 */
	private async declare(folder: Scope, name: string): Promise<string | undefined> {
		const config = vscode.workspace.getConfiguration('redpandaConnect', folder?.uri);
		const inspected = config.inspect<unknown>('secretEnv');
		const values = { user: inspected?.globalValue, workspace: inspected?.workspaceValue, folder: inspected?.workspaceFolderValue };
		const order = ['user', 'workspace', 'folder'] as const;
		const ruled = newVariableLevel(folder, vscode.workspace.workspaceFolders?.length ?? 0);
		const level = folder
			? order.slice(order.indexOf(ruled)).reverse().find((l) => Array.isArray(values[l])) ?? ruled
			: ruled;
		const target = SETTING_TARGETS[level];
		const atTarget = values[level];
		const base = Array.isArray(atTarget) ? atTarget : (Array.isArray(config.get<unknown>('secretEnv')) ? config.get<unknown[]>('secretEnv')! : []);
		if (base.includes(name)) {
			return undefined;
		}
		try {
			const next = [...base.filter((n): n is string => typeof n === 'string'), name];
			await this.writeSetting(config, next, target);
			return undefined;
		} catch (err) {
			return reasonOf(err);
		}
	}

	private writeSetting(config: vscode.WorkspaceConfiguration, value: unknown[] | undefined, target: vscode.ConfigurationTarget): Thenable<void> {
		return this.options.updateSetting ? this.options.updateSetting(config, value, target) : config.update('secretEnv', value, target);
	}

	/**
	 * Ticket 39: removes `name` from the `secretEnv` list the config uses (the most specific level that
	 * has a list: lists do not merge); a list left with no name is removed at that level, not kept as
	 * `[]`. Reports the settings it left, why the write failed, and the less specific list that still
	 * holds the name afterwards, if any. A name that list does not hold is left alone.
	 */
	private async undeclare(folder: Scope, name: string): Promise<{ readonly where?: string; readonly problem?: string; readonly nowApplies?: string; readonly appliesTo?: string; readonly stillDeclaredIn?: string }> {
		const used = usedSecretList(folder);
		if (!used || !used.list.includes(name)) {
			return {};
		}
		const where = usedListText(folder, used.level);
		const next = used.list.filter((n) => n !== name);
		try {
			await this.writeSetting(used.config, next.length > 0 ? next : undefined, SETTING_TARGETS[used.level]);
		} catch (err) {
			return { where, problem: reasonOf(err) };
		}
		// A folder's emptied list removed: a less specific list (another level's names) now applies to it.
		const after = next.length === 0 && used.level !== 'user' ? usedSecretList(folder) : undefined;
		if (!after || after.level === used.level) {
			return { where };
		}
		const nowApplies = settingsLevelText(folder, after.level);
		const appliesTo = folder ? 'this folder' : 'files outside the workspace folders';
		return { where, nowApplies, appliesTo, ...(declaredSecretNames(after.list).names.includes(name) ? { stillDeclaredIn: nowApplies } : {}) };
	}
}

/** Ticket 39: an item of "Remove secret variable"'s name pick. */
export interface RemoveItem extends vscode.QuickPickItem {
	readonly name: string;
	readonly hasValue: boolean;
}

/**
 * Ticket 39: the settings of the list at `level`, as a message names them, noting when the configs
 * of other folders use that list too (it is not the folder's own and folders are open).
 */
function usedListText(folder: Scope, level: SettingLevel): string {
	const text = settingsLevelText(folder, level);
	const count = vscode.workspace.workspaceFolders?.length ?? 0;
	if (folder) {
		return level !== 'folder' && count > 1 ? `${text}, also used by the other folders' configs` : text;
	}
	return count > 0 ? `${text}, also used by the workspace folders' configs` : text;
}

/**
 * Ticket 39: the `secretEnv` list `folder`'s configs use (the window's without one): the most
 * specific level that has a list, as `inspect` reads them.
 */
function usedSecretList(folder: Scope): { readonly config: vscode.WorkspaceConfiguration; readonly level: SettingLevel; readonly list: unknown[] } | undefined {
	const config = vscode.workspace.getConfiguration('redpandaConnect', folder?.uri);
	const inspected = config.inspect<unknown>('secretEnv');
	const values: Record<SettingLevel, unknown> = { user: inspected?.globalValue, workspace: inspected?.workspaceValue, folder: inspected?.workspaceFolderValue };
	const level = (['folder', 'workspace', 'user'] as const).find((l) => Array.isArray(values[l]));
	return level ? { config, level, list: values[level] as unknown[] } : undefined;
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

async function confirmRemoveName(name: string, where: string): Promise<boolean> {
	const action = 'Remove name';
	const answer = await vscode.window.showWarningMessage(
		`Remove ${name} from ${SECRET_ENV_SETTING} in ${where}? It has no value on this machine.`,
		{ modal: true },
		action,
	);
	return answer === action;
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
