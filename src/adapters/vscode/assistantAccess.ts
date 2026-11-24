// The RPCN AI Assistant's minimal access (AD-26, story 8.1; story 8.3 completes it with the model list,
// Test connection, Forget and the access states):
//   - the settings `redpandaConnect.assistant.model` (default `claude-opus-5-5`), `.baseUrl` and `.auth`
//     (`bearer`, the default, or `x-api-key`), user settings only (a workspace may not send the key elsewhere);
//   - the key in VS Code's secret storage only, under `redpandaConnect.assistant.apiKey`, set by
//     Set up assistant access… (a password box; stored only once given; Escape stores nothing; one
//     at a time). It reaches the agent only through its environment (`src/adapters/assistant/env.ts`);
//   - `mask`: every key value this window has held, any `Bearer …`, `authorization` or `x-api-key`
//     value, for the output channel's global mask and every text the view shows.

import * as vscode from 'vscode';
import type { AssistantAuth } from '../assistant/host';
import { maskCredentials, CREDENTIAL_MASK } from '../cloud/errors';
import { errorText } from '../../shared/errorText';

export const ASSISTANT_KEY_SECRET = 'redpandaConnect.assistant.apiKey';
/** Review 3: the base URL the stored key was set up for (a changed setting sends nothing until set up again). */
export const ASSISTANT_KEY_URL_SECRET = 'redpandaConnect.assistant.apiKeyBaseUrl';
/** Review 17: shorter keys are refused (masking needs a few characters to be safe). */
export const MIN_KEY_CHARS = 8;
export const SET_UP_ASSISTANT_ACCESS_COMMAND = 'redpandaConnect.assistant.setUpAccess';
export const DEFAULT_ASSISTANT_MODEL = 'claude-opus-5-5';
export const DEFAULT_ASSISTANT_BASE_URL = 'https://api.anthropic.com';
export const ASSISTANT_ACCESS_STORED_MESSAGE = 'Assistant access is set up: the key is in VS Code\'s secret storage.';
export const BAD_BASE_URL_SET_UP_MESSAGE = 'redpandaConnect.assistant.baseUrl must be an https:// URL (http:// only for localhost); fix the setting first.';
export const ASSISTANT_SET_UP_RUNNING = 'Set up assistant access is already running; finish it first.';

export interface AssistantSettings {
	readonly model: string;
	readonly baseUrl: string;
	readonly auth: AssistantAuth;
}

export type SetUpAssistantAccessResult = 'stored' | 'cancelled' | 'busy' | 'failed';

/** What a test may replace: the password box and the messages. */
export interface AssistantAccessUi {
	input(options: vscode.InputBoxOptions): Thenable<string | undefined>;
	showInfo(message: string): Thenable<unknown>;
	showError(message: string): Thenable<unknown>;
}

/** What `setAccessForTest` changes: a key stored (`null`: removed) and settings held in memory (`null`: back to the setting). */
export interface AssistantAccessOverrides {
	readonly key?: string | null;
	readonly model?: string | null;
	readonly baseUrl?: string | null;
	readonly auth?: AssistantAuth | null;
	/** The base URL the stored key is recorded for (set with `key`: the base URL then in effect). */
	readonly keyBaseUrl?: string;
}

const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Review 3: whether `url` is an `https:` URL, or `http:` on a loopback host, without credentials in it. */
export function usableBaseUrl(url: string): boolean {
	try {
		const u = new URL(url);
		const scheme = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
		return scheme && u.username === '' && u.password === '';
	} catch {
		return false;
	}
}

/** A base URL compared as the endpoint it names (`undefined`: not a URL). */
export function normalBaseUrl(url: string | undefined): string | undefined {
	if (!url) {
		return undefined;
	}
	try {
		return new URL(url).href.replace(/\/+$/, '');
	} catch {
		return undefined;
	}
}

export class AssistantAccess implements vscode.Disposable {
	ui: AssistantAccessUi = {
		input: (options) => vscode.window.showInputBox(options),
		showInfo: (message) => vscode.window.showInformationMessage(message),
		showError: (message) => vscode.window.showErrorMessage(message),
	};
	/** Every key value this window has held (masked even after it is replaced or removed). */
	private readonly kept = new Set<string>();
	private key: string | undefined;
	private keyUrl: string | undefined;
	private overrides: { model?: string; baseUrl?: string; auth?: AssistantAuth } = {};
	private settingUp = false;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly subscriptions: vscode.Disposable[] = [];
	/** Settles once the key was first read from the secret storage. */
	readonly ready: Promise<void>;

	constructor(private readonly options: { readonly store: vscode.SecretStorage; readonly log: (line: string) => void }) {
		this.ready = this.reload();
		this.subscriptions.push(
			this.changed,
			options.store.onDidChange((e) => {
				if (e.key === ASSISTANT_KEY_SECRET || e.key === ASSISTANT_KEY_URL_SECRET) {
					void this.reload();
				}
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('redpandaConnect.assistant')) {
					this.changed.fire();
				}
			}),
		);
	}

	register(): vscode.Disposable[] {
		return [vscode.commands.registerCommand(SET_UP_ASSISTANT_ACCESS_COMMAND, () => this.setUpAccess())];
	}

	dispose(): void {
		this.subscriptions.forEach((s) => s.dispose());
	}

	private async reload(): Promise<void> {
		try {
			const [key, url] = await Promise.all([this.options.store.get(ASSISTANT_KEY_SECRET), this.options.store.get(ASSISTANT_KEY_URL_SECRET)]);
			this.hold(key, url);
		} catch (err) {
			this.options.log(`Assistant: could not read the key from the secret storage: ${this.mask(errorText(err))}`);
			this.hold(undefined, undefined);
		}
	}

	private hold(key: string | undefined, url: string | undefined): void {
		this.key = key || undefined;
		this.keyUrl = normalBaseUrl(url);
		if (this.key) {
			this.kept.add(this.key);
		}
		this.changed.fire();
	}

	/** The settings, as read now (with a test's overrides). */
	settings(): AssistantSettings {
		const config = vscode.workspace.getConfiguration('redpandaConnect.assistant');
		const auth = this.overrides.auth ?? config.get<string>('auth');
		return {
			model: (this.overrides.model ?? config.get<string>('model') ?? '').trim() || DEFAULT_ASSISTANT_MODEL,
			baseUrl: (this.overrides.baseUrl ?? config.get<string>('baseUrl') ?? '').trim() || DEFAULT_ASSISTANT_BASE_URL,
			auth: auth === 'x-api-key' ? 'x-api-key' : 'bearer',
		};
	}

	/** The key, once read; `undefined` when none is stored. */
	async apiKey(): Promise<string | undefined> {
		await this.ready;
		return this.key;
	}

	/** Whether a key is held now. */
	get hasKey(): boolean {
		return this.key !== undefined;
	}

	/** Review 3: whether the held key was set up for the base URL in effect now (a key set up for another sends nothing). */
	get keyMatchesBaseUrl(): boolean {
		return this.keyUrl !== undefined && this.keyUrl === normalBaseUrl(this.settings().baseUrl);
	}

	/** `text` with every key value held, and any credential-looking header value, masked. */
	mask(text: string): string {
		return maskCredentials(text, [...this.kept])
			.replace(/\b(x-api-key)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, `$1$2${CREDENTIAL_MASK}`)
			.replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, CREDENTIAL_MASK);
	}

	/**
	 * Set up assistant access…: the key in a password box, stored in the secret storage once given.
	 * Escape: nothing stored. One at a time: another request while one runs is refused. Never throws.
	 */
	async setUpAccess(): Promise<SetUpAssistantAccessResult> {
		if (this.settingUp) {
			void this.ui.showInfo(ASSISTANT_SET_UP_RUNNING);
			return 'busy';
		}
		this.settingUp = true;
		try {
			const { baseUrl, auth } = this.settings();
			if (!usableBaseUrl(baseUrl)) {
				void this.ui.showError(BAD_BASE_URL_SET_UP_MESSAGE);
				return 'failed';
			}
			let host = baseUrl;
			try {
				host = new URL(baseUrl).host;
			} catch {
				// shown as set
			}
			const key = await this.ui.input({
				title: 'Set up assistant access',
				prompt: `The API key for ${host} (sent as ${auth === 'x-api-key' ? 'x-api-key' : 'a bearer token'}). `
					+ 'It is kept in VS Code\'s secret storage and passed to the assistant only in its environment. Escape cancels.',
				password: true,
				ignoreFocusOut: true,
				validateInput: (text) => (text.trim().length >= MIN_KEY_CHARS ? undefined : `Enter the key (at least ${MIN_KEY_CHARS} characters).`),
			});
			const value = key?.trim();
			if (!value) {
				return 'cancelled';
			}
			if (value.length < MIN_KEY_CHARS) {
				void this.ui.showError(`The key is too short (at least ${MIN_KEY_CHARS} characters); nothing was stored.`);
				return 'failed';
			}
			this.kept.add(value);
			try {
				// The URL first: a key is never held without the endpoint it was set up for.
				await this.options.store.store(ASSISTANT_KEY_URL_SECRET, normalBaseUrl(baseUrl) ?? baseUrl);
				await this.options.store.store(ASSISTANT_KEY_SECRET, value);
			} catch (err) {
				const reason = this.mask(errorText(err));
				this.options.log(`Assistant: could not store the key in the secret storage: ${reason}`);
				void this.ui.showError(`Could not store the key in the secret storage: ${reason}`);
				return 'failed';
			}
			this.hold(value, baseUrl);
			this.options.log('Assistant: access set up (the key is in the secret storage).');
			void this.ui.showInfo(ASSISTANT_ACCESS_STORED_MESSAGE);
			return 'stored';
		} catch (err) {
			const reason = this.mask(errorText(err));
			this.options.log(`Assistant: Set up assistant access failed: ${reason}`);
			void this.ui.showError(`Set up assistant access failed: ${reason}`);
			return 'failed';
		} finally {
			this.settingUp = false;
		}
	}

	/** Test seam: store or remove the key, and hold settings in memory instead of the settings. */
	async setAccessForTest(next: AssistantAccessOverrides): Promise<void> {
		// The settings first, so a key given with them is recorded for their base URL.
		for (const name of ['model', 'baseUrl', 'auth'] as const) {
			const value = next[name];
			if (value === null) {
				delete this.overrides[name];
			} else if (value !== undefined) {
				(this.overrides as Record<string, string>)[name] = value;
			}
		}
		if (next.key !== undefined) {
			if (next.key === null) {
				await this.options.store.delete(ASSISTANT_KEY_SECRET);
				await this.options.store.delete(ASSISTANT_KEY_URL_SECRET);
				this.hold(undefined, undefined);
			} else {
				this.kept.add(next.key);
				const url = next.keyBaseUrl ?? this.settings().baseUrl;
				await this.options.store.store(ASSISTANT_KEY_URL_SECRET, url);
				await this.options.store.store(ASSISTANT_KEY_SECRET, next.key);
				this.hold(next.key, url);
			}
		}
		this.changed.fire();
	}

	/** Test seam (review 22): the value stored under a secret storage key, read back. */
	storedSecret(key: string): Thenable<string | undefined> {
		return this.options.store.get(key);
	}
}
