// The RPCN AI Assistant's access (AD-26, story 8.1; story 8.3: the set-up's steps and test call, Test
// connection, Forget, the model list and the sticky access failures):
//   - the settings `redpandaConnect.assistant.model` (default `claude-opus-5-5`), `.baseUrl` and `.auth`
//     (`bearer`, the default, or `x-api-key`), user settings only (a workspace may not send the key elsewhere);
//   - the key in VS Code's secret storage only, under `redpandaConnect.assistant.apiKey`, set by
//     Set up assistant access… (a password box; stored only once given; Escape stores nothing; one
//     at a time). It reaches the agent only through its environment (`src/adapters/assistant/env.ts`);
//   - `mask`: every key value this window has held, any `Bearer …`, `authorization` or `x-api-key`
//     value, for the output channel's global mask and every text the view shows.
// Story 8.3:
//   - Set up assistant access… asks for the base URL (prefilled), the auth (the current first) and the
//     key; Escape at any step changes nothing. The test call (`GET /v1/models`, `endpoint.ts`) follows;
//     only when it passes are the base URL and auth written (Global) and the key stored with its base URL.
//     A failure stores nothing and shows its classified text, with Try again.
//   - Test connection runs the same call with the stored key; Forget deletes both secrets after a modal
//     confirm. Both are commands.
//   - The model list of the last passing call, in memory only, fetched again when the pick opens once it
//     is over 10 minutes old. `chooseModel` (the composer's chip) is a quick pick of it with Other….
//   - The sticky failure: `keyRefused` (also a 403, forbidden) or `modelNotAllowed`, set by a failed Test
//     connection or a run's error, cleared by a passing set-up or Test connection (and `modelNotAllowed`
//     by a change of the model setting); `unreachable` is held too, but a run may start in it and the
//     next run's start clears it.

import * as vscode from 'vscode';
import type { AssistantAuth } from '../assistant/host';
import { classifyEndpointError, costMark, listModels, type EndpointFailure, type EndpointModel, type ListModelsRequest, type ListModelsResult } from '../assistant/endpoint';
import { registryAgent } from '../assistant/runtime';
import { maskCredentials, CREDENTIAL_MASK } from '../cloud/errors';
import { errorText } from '../../shared/errorText';
import { KEY_REFUSED_TEXT, modelNotAllowedText, unreachableText } from '../../shared/assistantProtocol';
import { proxyConfigFor } from './assistantRuntime';

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
export const TEST_CONNECTION_COMMAND = 'redpandaConnect.assistant.testConnection';
export const FORGET_ACCESS_COMMAND = 'redpandaConnect.assistant.forgetAccess';
export const TRY_AGAIN_LABEL = 'Try again';
export const FORGET_LABEL = 'Forget';
export const OTHER_MODEL_LABEL = 'Other…';
/** The model list is fetched again when the pick opens once it is older than this. */
export const MODEL_LIST_MAX_AGE_MS = 10 * 60_000;
export const NO_MODEL_LIST_TEXT = 'The endpoint is reachable but gives no model list.';
export const FORGET_CONFIRM_TEXT = 'Forget assistant access? The key and the base URL it was set up for are deleted from VS Code\'s secret storage.';
export const ACCESS_FORGOTTEN_TEXT = 'Assistant access is forgotten: the key is deleted from VS Code\'s secret storage.';
export const NO_ACCESS_TO_TEST_TEXT = 'Assistant access isn\'t set up: run Set up assistant access… first.';
export const NO_ACCESS_TO_FORGET_TEXT = 'No assistant access is set up; there is nothing to forget.';
export const BASE_URL_CHANGED_TEST_TEXT = 'The base URL changed since the key was set up; set up access again. Nothing was sent.';

export interface AssistantSettings {
	readonly model: string;
	readonly baseUrl: string;
	readonly auth: AssistantAuth;
}

export type SetUpAssistantAccessResult = 'stored' | 'cancelled' | 'busy' | 'failed';

/** Story 8.3: how Test connection ended: the models listed, reachable with no list, a failure's kind, or why it sent nothing. */
export type TestConnectionResult = 'ok' | 'noList' | EndpointFailure['kind'] | 'noAccess' | 'baseUrlChanged' | 'badBaseUrl';

/** Story 8.3: how Forget ended. */
export type ForgetAccessResult = 'forgotten' | 'cancelled' | 'none';

/** Story 8.3: the access failure held (masked texts are made from it when shown). */
export interface AccessFailure {
	/** `keyRefused` covers forbidden (a 403), with the endpoint's message. */
	readonly kind: 'keyRefused' | 'modelNotAllowed' | 'unreachable';
	/** The endpoint's message (unmasked), for a forbidden `keyRefused`; else `null`. */
	readonly message: string | null;
	/** The refused model, with `modelNotAllowed`. */
	readonly model: string | null;
	/** What found it: a run's error, or Test connection. */
	readonly origin: 'run' | 'test';
}

/** Story 8.3: a model pick's item (the model's id in `model`; `null`: Other…). */
export interface ModelPickItem extends vscode.QuickPickItem {
	readonly model: string | null;
}

/** What a test may replace: the input boxes, the auth and model picks, the confirm, the progress and the messages. */
export interface AssistantAccessUi {
	input(options: vscode.InputBoxOptions): Thenable<string | undefined>;
	pick<T extends vscode.QuickPickItem>(items: readonly T[], options: vscode.QuickPickOptions): Thenable<T | undefined>;
	/** A modal confirm: `true` when `action` was chosen. */
	confirm(message: string, action: string): Thenable<boolean>;
	/** Runs `task` while a progress notification says `title`. */
	progress<T>(title: string, task: () => Promise<T>): Thenable<T>;
	showInfo(message: string): Thenable<unknown>;
	/** An error message, with buttons (`actions`); resolves with the one chosen. */
	showError(message: string, ...actions: string[]): Thenable<string | undefined | unknown>;
}

/** Story 8.3: the access failure's text, as the set-up and Test connection show it (unmasked). */
export function failureText(failure: EndpointFailure, host: string): string {
	const why = failure.message.trim().replace(/[.\s]+$/, '');
	switch (failure.kind) {
		case 'keyRefused': return KEY_REFUSED_TEXT;
		case 'forbidden': return why ? `${KEY_REFUSED_TEXT} ${why}.` : KEY_REFUSED_TEXT;
		case 'modelNotAllowed': return failure.model ? modelNotAllowedText(failure.model) : `${why || 'The endpoint does not allow the model'}.`;
		case 'unreachable': return why ? `${unreachableText(host)} ${why.charAt(0).toUpperCase()}${why.slice(1)}.` : unreachableText(host);
		case 'other': return `The endpoint answered with an error${failure.status !== null ? ` (HTTP ${failure.status})` : ''}${why ? `: ${why}` : ''}.`;
	}
}

/** Story 8.3: the host a base URL names (itself when it is no URL). */
export function hostOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}

/** Story 8.3: a model's pick description: its cost mark, then its display name when that says more than the id. */
export function modelDescription(model: EndpointModel): string {
	const name = model.displayName && model.displayName !== model.id ? model.displayName : '';
	return [costMark(model.id) || costMark(name), name].filter((x) => x !== '').join('  ');
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

/** Manual check (8.3): how long after this window's own write an earlier own state read back is an echo. */
export const ECHO_WINDOW_MS = 5_000;

/** Manual check (8.3): the key and its base URL as one comparable value (in memory only). */
function secretState(key: string | undefined, url: string | undefined): string {
	return JSON.stringify([key ?? null, normalBaseUrl(url) ?? null]);
}

export class AssistantAccess implements vscode.Disposable {
	ui: AssistantAccessUi = {
		input: (options) => vscode.window.showInputBox(options),
		pick: (items, options) => vscode.window.showQuickPick(items, options),
		confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
		progress: (title, task) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task),
		showInfo: (message) => vscode.window.showInformationMessage(message),
		showError: (message, ...actions) => vscode.window.showErrorMessage(message, ...actions),
	};
	/** Story 8.3, test seam: the test call (`listModels`, with the window's proxy and CA handling). */
	endpoint: (request: ListModelsRequest) => Promise<ListModelsResult> = (request) => listModels({
		...request, agentFor: (url) => registryAgent(url, proxyConfigFor(url, vscode.workspace.getConfiguration('http'))),
	});
	/** Story 8.3, test seam: the test call's limit (`undefined`: 15 s). */
	endpointTimeoutMs: number | undefined;
	/** Story 8.3, test seam: the clock the model list's age is told by. */
	now: () => number = () => Date.now();
	/** Story 8.3: the last passing call's models (`null`: no list), in memory only: when, from which endpoint, sent how. */
	private list: { readonly models: readonly EndpointModel[] | null; readonly at: number; readonly baseUrl: string | undefined; readonly auth: AssistantAuth } | undefined;
	/** Story 8.3: the access failure held. */
	private held: AccessFailure | undefined;
	/** Every key value this window has held (masked even after it is replaced or removed). */
	private readonly kept = new Set<string>();
	private key: string | undefined;
	private keyUrl: string | undefined;
	private overrides: { model?: string; baseUrl?: string; auth?: AssistantAuth } = {};
	private settingUp = false;
	/** Manual check (8.3): the latest secret storage read (see `reload`). */
	private readGeneration = 0;
	/** Manual check (8.3): the states this window wrote, oldest first, with when (see `isEcho`). */
	private readonly ownStates: { readonly state: string; readonly at: number }[] = [];
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
					if (e.affectsConfiguration('redpandaConnect.assistant.model') && this.held?.kind === 'modelNotAllowed') {
						this.held = undefined;
					}
					if ((e.affectsConfiguration('redpandaConnect.assistant.baseUrl') || e.affectsConfiguration('redpandaConnect.assistant.auth')) && this.held?.kind === 'unreachable') {
						// Another endpoint: the unreachable one is not it.
						this.held = undefined;
					}
					this.changed.fire();
				}
			}),
		);
	}

	register(): vscode.Disposable[] {
		return [
			vscode.commands.registerCommand(SET_UP_ASSISTANT_ACCESS_COMMAND, () => this.setUpAccess()),
			vscode.commands.registerCommand(TEST_CONNECTION_COMMAND, () => this.testConnection()),
			vscode.commands.registerCommand(FORGET_ACCESS_COMMAND, () => this.forget()),
		];
	}

	dispose(): void {
		this.subscriptions.forEach((s) => s.dispose());
	}

	/**
	 * The key and its base URL read again from the secret storage. Manual check (8.3): each store or delete
	 * fires its own change, so reads overlap; only the latest one started (and none started before a set-up,
	 * a Forget or a test's change that holds a value itself) may apply what it read.
	 */
	private async reload(): Promise<void> {
		const generation = ++this.readGeneration;
		try {
			const [key, url] = await Promise.all([this.options.store.get(ASSISTANT_KEY_SECRET), this.options.store.get(ASSISTANT_KEY_URL_SECRET)]);
			if (generation === this.readGeneration && !this.isEcho(key, url)) {
				this.hold(key, url);
			}
		} catch (err) {
			if (generation === this.readGeneration) {
				this.options.log(`Assistant: could not read the key from the secret storage: ${this.mask(errorText(err))}`);
				this.hold(undefined, undefined);
			}
		}
	}

	/**
	 * Manual check (8.3): whether a read is VS Code's storage handing back one of this window's own earlier
	 * states shortly after a later write of ours (seen with secrets kept in application storage: the same
	 * keys deleted and stored in quick succession can briefly read back as an older state). Such a read is
	 * ignored; any other state (another window's change) is applied.
	 */
	private isEcho(key: string | undefined, url: string | undefined): boolean {
		const latest = this.ownStates.at(-1);
		if (!latest || this.now() - latest.at > ECHO_WINDOW_MS) {
			return false;
		}
		const state = secretState(key, url);
		return state !== latest.state && this.ownStates.slice(0, -1).some((s) => s.state === state);
	}

	/** Manual check (8.3): the secrets written (`key` `undefined`: both deleted), then held as this window's latest state. */
	private async writeSecrets(key: string | undefined, url: string | undefined): Promise<void> {
		if (key === undefined) {
			await this.options.store.delete(ASSISTANT_KEY_SECRET);
			await this.options.store.delete(ASSISTANT_KEY_URL_SECRET);
		} else {
			// The URL first: a key is never held without the endpoint it was set up for.
			await this.options.store.store(ASSISTANT_KEY_URL_SECRET, url ?? '');
			await this.options.store.store(ASSISTANT_KEY_SECRET, key);
		}
		// Any read that started before is stale; a read of an earlier state of ours soon after is an echo.
		this.readGeneration++;
		this.ownStates.push({ state: secretState(key, key === undefined ? undefined : url), at: this.now() });
		if (this.ownStates.length > 16) {
			this.ownStates.shift();
		}
		this.hold(key, key === undefined ? undefined : url);
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

	/** Story 8.3: the access failure held (`undefined`: none). */
	get failure(): AccessFailure | undefined {
		return this.held;
	}

	/** Story 8.3: the failure held changed (or went). */
	private setFailure(next: AccessFailure | undefined): void {
		const same = next?.kind === this.held?.kind && next?.model === this.held?.model && next?.message === this.held?.message && next?.origin === this.held?.origin;
		this.held = next;
		if (!same) {
			this.changed.fire();
		}
	}

	/** Story 8.3: a run is starting: an unreachable endpoint is not sticky, so it goes. */
	runStarting(): void {
		if (this.held?.kind === 'unreachable') {
			this.setFailure(undefined);
		}
	}

	/**
	 * Story 8.3: a run's error text, classified: key refused (and forbidden) and model not allowed are held
	 * (sticky), unreachable too (not sticky); anything else changes nothing. The classification is returned.
	 */
	recordRunError(text: string): EndpointFailure {
		const failure = classifyEndpointError(undefined, undefined, text);
		this.holdFailure(failure, 'run');
		return failure;
	}

	/** Story 8.3: a failure held as its access state (`other` holds nothing). */
	private holdFailure(failure: EndpointFailure, origin: AccessFailure['origin']): void {
		switch (failure.kind) {
			case 'keyRefused':
				this.setFailure({ kind: 'keyRefused', message: null, model: null, origin });
				break;
			case 'forbidden':
				this.setFailure({ kind: 'keyRefused', message: failure.message.trim() || null, model: null, origin });
				break;
			case 'modelNotAllowed':
				this.setFailure({ kind: 'modelNotAllowed', message: null, model: failure.model ?? this.settings().model, origin });
				break;
			case 'unreachable':
				// Not sticky, and never over a sticky one (an unreachable endpoint says nothing of the key).
				if (!this.held || this.held.kind === 'unreachable') {
					this.setFailure({ kind: 'unreachable', message: null, model: null, origin });
				}
				break;
			case 'other':
				break;
		}
	}

	/** Story 8.3: the test call against `baseUrl` with `key` (masked logging; never throws). */
	private async call(baseUrl: string, auth: AssistantAuth, key: string): Promise<ListModelsResult> {
		try {
			return await this.endpoint({ baseUrl, auth, key, ...(this.endpointTimeoutMs !== undefined ? { timeoutMs: this.endpointTimeoutMs } : {}) });
		} catch (err) {
			return { ok: false, failure: classifyEndpointError(undefined, undefined, errorText(err)) };
		}
	}

	/** Story 8.3: the cached list, when it is the endpoint's in effect now (the base URL and auth it was fetched with). */
	private get modelList(): { readonly models: readonly EndpointModel[] | null; readonly at: number } | undefined {
		const { baseUrl, auth } = this.settings();
		return this.list && this.list.baseUrl === normalBaseUrl(baseUrl) && this.list.auth === auth ? this.list : undefined;
	}

	/** Story 8.3: the list fetched now from `baseUrl` (sent as `auth`) cached; `undefined`: dropped. */
	private cacheModels(models: readonly EndpointModel[] | null | undefined, baseUrl?: string, auth?: AssistantAuth): void {
		this.list = models === undefined || baseUrl === undefined || auth === undefined ? undefined : { models, at: this.now(), baseUrl: normalBaseUrl(baseUrl), auth };
	}

	/** Story 8.3: the models listed by the last passing call (`null`: no list; `undefined`: no call passed yet, or another endpoint's). */
	cachedModels(): readonly EndpointModel[] | null | undefined {
		return this.modelList?.models;
	}

	/**
	 * Set up assistant access… (story 8.3): the base URL (prefilled with the setting), the auth (the current
	 * value first), the key (a password box); Escape at any step changes nothing. Then the test call: when it
	 * passes, the base URL and auth are written (Global) and the key stored with its base URL; when it fails,
	 * nothing is stored and the failure is shown with Try again. One at a time. Never throws.
	 */
	async setUpAccess(): Promise<SetUpAssistantAccessResult> {
		if (this.settingUp) {
			void this.ui.showInfo(ASSISTANT_SET_UP_RUNNING);
			return 'busy';
		}
		this.settingUp = true;
		try {
			const current = this.settings();
			const urlText = await this.ui.input({
				title: 'Set up assistant access (1/3): base URL',
				prompt: 'The Anthropic Messages API endpoint: Anthropic itself, or a proxy that serves the same API (for example Redpanda ADP). Escape cancels.',
				value: current.baseUrl,
				ignoreFocusOut: true,
				validateInput: (text) => (usableBaseUrl(text.trim()) ? undefined : 'An https:// URL (http:// only for localhost), with no user or password in it.'),
			});
			const baseUrl = urlText?.trim();
			if (!baseUrl) {
				return 'cancelled';
			}
			if (!usableBaseUrl(baseUrl)) {
				void this.ui.showError(BAD_BASE_URL_SET_UP_MESSAGE);
				return 'failed';
			}
			const auths: readonly (vscode.QuickPickItem & { readonly auth: AssistantAuth })[] = [
				{ auth: 'bearer', label: 'bearer', description: 'Authorization: Bearer' },
				{ auth: 'x-api-key', label: 'x-api-key', description: 'an x-api-key header' },
			];
			const ordered = [...auths.filter((a) => a.auth === current.auth), ...auths.filter((a) => a.auth !== current.auth)];
			const picked = await this.ui.pick(ordered, { title: 'Set up assistant access (2/3): how the key is sent', placeHolder: 'Escape cancels', ignoreFocusOut: true });
			if (!picked) {
				return 'cancelled';
			}
			const auth = picked.auth;
			const host = hostOf(baseUrl);
			const key = await this.ui.input({
				title: 'Set up assistant access (3/3): the key',
				prompt: `The API key for ${host} (sent as ${auth === 'x-api-key' ? 'x-api-key' : 'a bearer token'}). `
					+ 'It is tested first, then kept in VS Code\'s secret storage and passed to the assistant only in its environment. Escape cancels.',
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
			const result = await this.ui.progress(`Testing assistant access to ${host}…`, () => this.call(baseUrl, auth, value));
			if (!result.ok) {
				const text = this.mask(failureText(result.failure, host));
				this.options.log(`Assistant: Set up assistant access: the test call failed; nothing was stored: ${text}`);
				// The guard is released before the notification: it may stay unanswered; Try again starts a fresh set-up.
				this.settingUp = false;
				void Promise.resolve(this.ui.showError(`${text} Nothing was stored.`, TRY_AGAIN_LABEL)).then((action) => {
					if (action === TRY_AGAIN_LABEL) {
						void this.setUpAccess();
					}
				}, () => undefined);
				return 'failed';
			}
			try {
				await this.writeSecrets(value, normalBaseUrl(baseUrl) ?? baseUrl);
			} catch (err) {
				const reason = this.mask(errorText(err));
				this.options.log(`Assistant: could not store the key in the secret storage: ${reason}`);
				void this.ui.showError(`Could not store the key in the secret storage: ${reason}`);
				return 'failed';
			}
			this.cacheModels(result.models, baseUrl, auth);
			this.held = undefined;
			await this.writeSetting('baseUrl', baseUrl);
			await this.writeSetting('auth', auth);
			this.options.log(`Assistant: access set up (the key is in the secret storage; ${result.models ? `${result.models.length} models listed` : 'no model list'}).`);
			void this.ui.showInfo(result.models ? ASSISTANT_ACCESS_STORED_MESSAGE : `${ASSISTANT_ACCESS_STORED_MESSAGE} ${NO_MODEL_LIST_TEXT}`);
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

	/** Story 8.3: a user setting written (Global; only when it changes), a test's override of it dropped. */
	private async writeSetting(name: 'baseUrl' | 'auth' | 'model', value: string): Promise<void> {
		delete this.overrides[name];
		const config = vscode.workspace.getConfiguration('redpandaConnect.assistant');
		const inspect = config.inspect<string>(name);
		if (inspect?.globalValue === value || (inspect?.globalValue === undefined && inspect?.defaultValue === value)) {
			this.changed.fire();
			return;
		}
		await config.update(name, value, vscode.ConfigurationTarget.Global);
	}

	/**
	 * Story 8.3: Test connection: the test call with the stored key (only to the base URL it was set up
	 * for). Passing: the models cached, the failure held cleared, an info message. Failing: the failure held
	 * (as `recordRunError`), its text shown. Never throws.
	 */
	async testConnection(): Promise<TestConnectionResult> {
		await this.ready;
		const { baseUrl, auth } = this.settings();
		const key = this.key;
		if (!key) {
			void this.ui.showInfo(NO_ACCESS_TO_TEST_TEXT);
			return 'noAccess';
		}
		if (!usableBaseUrl(baseUrl)) {
			void this.ui.showError(BAD_BASE_URL_SET_UP_MESSAGE);
			return 'badBaseUrl';
		}
		if (!this.keyMatchesBaseUrl) {
			void this.ui.showError(BASE_URL_CHANGED_TEST_TEXT);
			return 'baseUrlChanged';
		}
		const host = hostOf(baseUrl);
		const result = await this.ui.progress(`Testing assistant access to ${host}…`, () => this.call(baseUrl, auth, key));
		if (result.ok) {
			this.cacheModels(result.models, baseUrl, auth);
			this.setFailure(undefined);
			const text = result.models ? `Assistant access works: ${host} answered with ${result.models.length} model${result.models.length === 1 ? '' : 's'}.` : `Assistant access works: ${host} answered. ${NO_MODEL_LIST_TEXT}`;
			this.options.log(`Assistant: Test connection: ${this.mask(text)}`);
			void this.ui.showInfo(this.mask(text));
			return result.models ? 'ok' : 'noList';
		}
		this.holdFailure(result.failure, 'test');
		const text = this.mask(failureText(result.failure, host));
		this.options.log(`Assistant: Test connection failed: ${text}`);
		void this.ui.showError(text);
		return result.failure.kind;
	}

	/** Story 8.3: Forget assistant access: both secrets deleted after a modal confirm; the model list and the failure go. Never throws. */
	async forget(): Promise<ForgetAccessResult> {
		await this.ready;
		if (!this.key && !this.keyUrl) {
			void this.ui.showInfo(NO_ACCESS_TO_FORGET_TEXT);
			return 'none';
		}
		let yes = false;
		try {
			yes = await this.ui.confirm(FORGET_CONFIRM_TEXT, FORGET_LABEL);
		} catch {
			yes = false;
		}
		if (!yes) {
			return 'cancelled';
		}
		try {
			await this.writeSecrets(undefined, undefined);
		} catch (err) {
			const reason = this.mask(errorText(err));
			this.options.log(`Assistant: could not delete the key from the secret storage: ${reason}`);
			void this.ui.showError(`Could not delete the key from the secret storage: ${reason}`);
			return 'cancelled';
		}
		this.cacheModels(undefined);
		this.held = undefined;
		this.options.log('Assistant: access forgotten (the key is deleted from the secret storage).');
		void this.ui.showInfo(ACCESS_FORGOTTEN_TEXT);
		return 'forgotten';
	}

	/**
	 * Story 8.3: the models for the pick: the cached list, fetched again first (with the stored key, to the
	 * base URL it was set up for) when there is none or it is older than 10 minutes. `null`: no list.
	 */
	async models(): Promise<readonly EndpointModel[] | null> {
		await this.ready;
		const list = this.modelList;
		const { baseUrl, auth } = this.settings();
		const key = this.key;
		if ((!list || this.now() - list.at > MODEL_LIST_MAX_AGE_MS) && key && usableBaseUrl(baseUrl) && this.keyMatchesBaseUrl) {
			const result = await this.ui.progress(`Fetching the models of ${hostOf(baseUrl)}…`, () => this.call(baseUrl, auth, key));
			if (result.ok) {
				this.cacheModels(result.models, baseUrl, auth);
			} else {
				this.options.log(`Assistant: the model list could not be fetched: ${this.mask(failureText(result.failure, hostOf(baseUrl)))}`);
			}
		}
		return this.modelList?.models ?? null;
	}

	/** Story 8.3: the model pick's items: the list (the current model checked; added first when the list lacks it), then Other…. */
	modelPickItems(models: readonly EndpointModel[] | null): ModelPickItem[] {
		const current = this.settings().model;
		const listed = models ?? [];
		const all = listed.some((m) => m.id === current) ? listed : [{ id: current, displayName: null }, ...listed];
		return [
			...all.map((m) => ({
				model: m.id, label: `${m.id === current ? '$(check) ' : ''}${this.mask(m.id)}`, description: this.mask(modelDescription(m)),
			})),
			{ model: null, label: OTHER_MODEL_LABEL, description: 'any model name' },
		];
	}

	/**
	 * Story 8.3: the composer's model chip (and Choose a model): a quick pick of the endpoint's models with
	 * Other… (an input box for any name). A name picked is written to `redpandaConnect.assistant.model`
	 * (Global); the next run uses it. Escape changes nothing. Resolves with the model written, or `undefined`.
	 */
	async chooseModel(): Promise<string | undefined> {
		try {
			const items = this.modelPickItems(await this.models());
			const current = this.settings().model;
			const picked = await this.ui.pick(items, { title: 'The assistant\'s model', placeHolder: `Now: ${this.mask(current)}. $$$, $$ and $ mark the relative cost by model family.` });
			if (!picked) {
				return undefined;
			}
			let model = picked.model;
			if (model === null) {
				const typed = await this.ui.input({
					title: 'The assistant\'s model',
					prompt: 'A model name the endpoint allows. Escape cancels.',
					value: current,
					validateInput: (text) => (/^\S{1,200}$/.test(text.trim()) ? undefined : 'A model name (no spaces).'),
				});
				model = typed?.trim() || null;
				if (!model || !/^\S{1,200}$/.test(model)) {
					return undefined;
				}
			}
			if (this.held?.kind === 'modelNotAllowed' && model !== current) {
				this.held = undefined;
			}
			await this.writeSetting('model', model);
			this.options.log(`Assistant: the model is ${this.mask(model)}.`);
			return model;
		} catch (err) {
			const reason = this.mask(errorText(err));
			this.options.log(`Assistant: the model could not be chosen: ${reason}`);
			void this.ui.showError(`The model could not be chosen: ${reason}`);
			return undefined;
		}
	}

	/** Test seam: store or remove the key, and hold settings in memory instead of the settings. */
	async setAccessForTest(next: AssistantAccessOverrides): Promise<void> {
		// The settings first, so a key given with them is recorded for their base URL.
		const model = this.settings().model;
		for (const name of ['model', 'baseUrl', 'auth'] as const) {
			const value = next[name];
			if (value === null) {
				delete this.overrides[name];
			} else if (value !== undefined) {
				(this.overrides as Record<string, string>)[name] = value;
			}
		}
		if (this.held?.kind === 'modelNotAllowed' && this.settings().model !== model) {
			this.held = undefined;
		}
		if (next.key !== undefined) {
			// Story 8.3: a key set or removed stands for a set-up or Forget: the failure held and the list go.
			this.held = undefined;
			this.cacheModels(undefined);
			if (next.key === null) {
				await this.writeSecrets(undefined, undefined);
			} else {
				this.kept.add(next.key);
				const url = next.keyBaseUrl ?? this.settings().baseUrl;
				await this.writeSecrets(next.key, url);
			}
		}
		this.changed.fire();
	}

	/** Test seam (review 22): the value stored under a secret storage key, read back. */
	storedSecret(key: string): Thenable<string | undefined> {
		return this.options.store.get(key);
	}
}
