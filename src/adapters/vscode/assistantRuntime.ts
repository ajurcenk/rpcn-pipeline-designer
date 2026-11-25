// Story 8.2 (AD-26): the assistant runtime's VS Code side. The extension never ships Anthropic's Claude
// Agent SDK or its Claude Code binary; the user installs them here:
//   - Install assistant runtime… (`redpandaConnect.assistant.installRuntime`): a modal names what will be
//     downloaded and links Anthropic's terms; only "Agree and install" goes on (Escape installs nothing).
//     The agreement is remembered in `globalState` for that SDK version only. Then, under a progress
//     notification with Cancel, `runtime.ts` downloads the pinned SDK and this platform's binary package
//     from the registry in `assets/agent-runtime.json`, checks each against its pinned sha512, and unpacks
//     them into `<globalStorage>/agent-runtime/<sdkVersion>/`, swapped in only once complete;
//   - Update assistant runtime… (`…updateRuntime`): the same, when another version is installed (the old
//     one is removed after the new one is in place);
//   - Remove assistant runtime (`…removeRuntime`): deletes the folder.
// The download honours `http.proxy`, `http.noProxy`, `http.proxyStrictSSL`, `HTTPS_PROXY` / `HTTP_PROXY`,
// `NO_PROXY` and `NODE_EXTRA_CA_CERTS`. Nothing installs or changes while a run goes.
//
// The development override (the repository's `node_modules`, at the pinned version) is only passed in
// `ExtensionMode.Development` and Test (`src/extension.ts`); a test turns it off with `setForTest`.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { errorText } from '../../shared/errorText';
import { unavailableText } from '../../shared/assistantProtocol';
import { hostPlatform } from '../assistant/platform';
import {
	binaryPackage, installRuntime, readManifest, registryAgent, removeRuntime, runtimeStatus, RuntimeCancelled, RUNTIME_FOLDER,
	type ProxyConfig, type RuntimeManifest, type RuntimeStatus,
} from '../assistant/runtime';
import { SDK_PACKAGE } from '../assistant/platform';

export const INSTALL_RUNTIME_COMMAND = 'redpandaConnect.assistant.installRuntime';
export const UPDATE_RUNTIME_COMMAND = 'redpandaConnect.assistant.updateRuntime';
export const REMOVE_RUNTIME_COMMAND = 'redpandaConnect.assistant.removeRuntime';
/** Anthropic's terms for the SDK and Claude Code (the SDK's own LICENSE.md points here). */
export const RUNTIME_TERMS_URL = 'https://code.claude.com/docs/en/legal-and-compliance';
/** `globalState`: the SDK versions whose terms the user agreed to. */
export const RUNTIME_TERMS_KEY = 'redpandaConnect.assistant.runtimeTermsAgreed';
export const AGREE_AND_INSTALL = 'Agree and install';
export const READ_TERMS = 'Read Anthropic\'s terms';
export const RUNTIME_BUSY_TEXT = 'The assistant is running; stop it first.';

export type RuntimeInstallOutcome = 'installed' | 'current' | 'declined' | 'cancelled' | 'failed' | 'unavailable' | 'busy';
export type RuntimeRemoveOutcome = 'removed' | 'none' | 'busy' | 'failed';

/** What a test may replace: the terms modal, the link, the progress notification and the messages. */
export interface AssistantRuntimeUi {
	/** The terms modal; `AGREE_AND_INSTALL`, `READ_TERMS`, or `undefined` (Escape). */
	agree(message: string, detail: string): Thenable<string | undefined>;
	openTerms(url: string): Thenable<unknown>;
	/** Runs `task` under a cancellable progress notification; `cancel` is called when the user cancels. */
	progress<T>(title: string, task: (report: (message: string) => void) => Promise<T>, cancel: () => void): Thenable<T>;
	showInfo(message: string): Thenable<unknown>;
	showError(message: string): Thenable<unknown>;
}

export interface AssistantRuntimeOptions {
	readonly extensionUri: vscode.Uri;
	/** The extension's global storage folder. */
	readonly storageDir: string;
	readonly globalState: vscode.Memento;
	readonly log: (line: string) => void;
	/** Masks a text shown or logged (credentials, the home folder). */
	readonly mask: (text: string) => string;
	/** The development override's `node_modules` (only in Development and Test). */
	readonly devModules?: string;
	/** Whether an assistant run is going (nothing installs or is removed meanwhile). */
	readonly running: () => boolean;
}

/** Test seam: the manifest, the folder, the override, the platform and the proxy (`null`: back to the real one). */
export interface AssistantRuntimeTestOverrides {
	readonly manifest?: RuntimeManifest | null;
	readonly root?: string | null;
	readonly devOverride?: boolean | null;
	readonly platform?: string | null;
	readonly proxy?: ProxyConfig | null;
	/** `null`: forget every agreement to the terms. */
	readonly agreed?: null;
}

/** The runtime as the view shows it. */
export type RuntimeView =
	| RuntimeStatus
	| { readonly kind: 'installing'; readonly platform: string }
	| { readonly kind: 'failed'; readonly platform: string; readonly error: string };

const MB = 1024 * 1024;

/** The proxy settings for a request to `target`: VS Code's, then the environment's. */
export function proxyConfigFor(target: URL, http: { get<T>(key: string): T | undefined }, env: NodeJS.ProcessEnv = process.env): ProxyConfig {
	// `http.proxySupport: off`: no proxy, from the settings or the environment.
	const off = http.get<string>('proxySupport') === 'off';
	const setting = (http.get<string>('proxy') ?? '').trim();
	const fromEnv = target.protocol === 'https:'
		? env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
		: env.HTTP_PROXY ?? env.http_proxy;
	const noProxy = [env.NO_PROXY ?? env.no_proxy ?? '', ...(http.get<string[]>('noProxy') ?? [])].filter((e) => typeof e === 'string' && e.trim() !== '');
	const ca: string[] = [];
	const extra = env.NODE_EXTRA_CA_CERTS;
	if (extra) {
		try {
			ca.push(fs.readFileSync(extra, 'utf8'));
		} catch {
			// An unreadable file adds nothing (Node itself warns about it at start).
		}
	}
	return { proxy: off ? undefined : setting || fromEnv || undefined, noProxy, strictSSL: http.get<boolean>('proxyStrictSSL') !== false, ca };
}

export class AssistantRuntime implements vscode.Disposable {
	ui: AssistantRuntimeUi = {
		agree: (message, detail) => vscode.window.showWarningMessage(message, { modal: true, detail }, AGREE_AND_INSTALL, READ_TERMS),
		openTerms: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
		progress: (title, task, cancel) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
			token.onCancellationRequested(cancel);
			return task((message) => progress.report({ message }));
		}),
		showInfo: (m) => vscode.window.showInformationMessage(m),
		showError: (m) => vscode.window.showErrorMessage(m),
	};
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private status: RuntimeStatus | undefined;
	private installing: AbortController | undefined;
	private failure: string | undefined;
	private testManifest: RuntimeManifest | undefined;
	private testRoot: string | undefined;
	private testDev: boolean | undefined;
	private testPlatform: string | undefined;
	private testProxy: ProxyConfig | undefined;
	private shipped: RuntimeManifest | undefined;

	constructor(private readonly options: AssistantRuntimeOptions) {}

	register(): vscode.Disposable[] {
		return [
			vscode.commands.registerCommand(INSTALL_RUNTIME_COMMAND, () => this.install()),
			vscode.commands.registerCommand(UPDATE_RUNTIME_COMMAND, () => this.install()),
			vscode.commands.registerCommand(REMOVE_RUNTIME_COMMAND, () => this.remove()),
		];
	}

	dispose(): void {
		this.installing?.abort();
		this.changed.dispose();
	}

	/** Test seam: see `AssistantRuntimeTestOverrides`. */
	async setForTest(next: AssistantRuntimeTestOverrides): Promise<void> {
		if (next.agreed === null) {
			await this.options.globalState.update(RUNTIME_TERMS_KEY, undefined);
		}
		if (next.manifest !== undefined) {
			this.testManifest = next.manifest ?? undefined;
		}
		if (next.root !== undefined) {
			this.testRoot = next.root ?? undefined;
		}
		if (next.devOverride !== undefined) {
			this.testDev = next.devOverride ?? undefined;
		}
		if (next.platform !== undefined) {
			this.testPlatform = next.platform ?? undefined;
		}
		if (next.proxy !== undefined) {
			this.testProxy = next.proxy ?? undefined;
		}
		this.failure = undefined;
		this.refresh();
	}

	/** The manifest in effect (`assets/agent-runtime.json`, read once). */
	manifest(): RuntimeManifest {
		if (this.testManifest) {
			return this.testManifest;
		}
		this.shipped ??= readManifest(path.join(this.options.extensionUri.fsPath, 'assets', 'agent-runtime.json'));
		return this.shipped;
	}

	/** `<globalStorage>/agent-runtime`: the only place the runtime is installed and loaded from. */
	root(): string {
		return this.testRoot ?? path.join(this.options.storageDir, RUNTIME_FOLDER);
	}

	platform(): string {
		return this.testPlatform ?? hostPlatform();
	}

	/** Whether an install is going. */
	get busy(): boolean {
		return this.installing !== undefined;
	}

	/** Looks the runtime up again (on the view loading or showing, a run starting, an install ending). */
	refresh(): RuntimeStatus {
		const devModules = this.testDev === false ? undefined : this.options.devModules;
		try {
			this.status = runtimeStatus({ root: this.root(), manifest: this.manifest(), platform: this.platform(), ...(devModules ? { devModules } : {}) });
		} catch (err) {
			this.options.log(`Assistant: the runtime manifest could not be read: ${this.options.mask(errorText(err))}`);
			this.status = { kind: 'missing', platform: this.platform() };
		}
		this.changed.fire();
		return this.status;
	}

	/** The runtime as last looked up, with an install going or failed. */
	view(): RuntimeView {
		const status = this.status ?? this.refresh();
		if (status.kind === 'unavailable') {
			return status;
		}
		// Before `installed`: an install over the development override shows as installing.
		if (this.installing) {
			return { kind: 'installing', platform: status.platform };
		}
		if (status.kind === 'installed') {
			return status;
		}
		if (this.failure !== undefined) {
			return { kind: 'failed', platform: status.platform, error: this.failure };
		}
		return status;
	}

	/** What the terms modal says (the packages, the registry, the terms). */
	termsDetail(manifest: RuntimeManifest, platform: string): string {
		const names = [SDK_PACKAGE, binaryPackage(platform)];
		return [
			'The RPCN AI Assistant runs Anthropic\'s Claude Agent SDK and its Claude Code binary. This extension doesn\'t include them; it downloads them now from',
			`${manifest.registry}:`,
			...names.map((n) => `  • ${n} ${manifest.packages[n].version}`),
			'checks each against the hash pinned in the extension, and keeps them in the extension\'s storage.',
			'',
			`They are Anthropic's software, used under Anthropic's terms (${RUNTIME_TERMS_URL}). Choose "${AGREE_AND_INSTALL}" only if you agree to them.`,
		].join('\n');
	}

	private agreed(version: string): boolean {
		const v = this.options.globalState.get<unknown>(RUNTIME_TERMS_KEY);
		return Array.isArray(v) && v.includes(version);
	}

	/** Install (or update to) the pinned runtime, after the user's agreement. Never throws. */
	async install(): Promise<RuntimeInstallOutcome> {
		if (this.installing || this.options.running()) {
			void this.ui.showError(RUNTIME_BUSY_TEXT);
			return 'busy';
		}
		const status = this.refresh();
		if (status.kind === 'unavailable') {
			void this.ui.showError(unavailableText(status.platform));
			return 'unavailable';
		}
		if (status.kind === 'installed' && !status.dev) {
			void this.ui.showInfo(`The assistant runtime ${status.files.version} is already installed.`);
			return 'current';
		}
		let manifest: RuntimeManifest;
		try {
			manifest = this.manifest();
		} catch (err) {
			return this.failed(err);
		}
		const platform = this.platform();
		if (!this.agreed(manifest.sdkVersion)) {
			for (;;) {
				const pick = await this.ui.agree(`Install the assistant runtime (Claude Agent SDK ${manifest.sdkVersion})?`, this.termsDetail(manifest, platform));
				if (pick === READ_TERMS) {
					await this.ui.openTerms(RUNTIME_TERMS_URL);
					continue;
				}
				if (pick !== AGREE_AND_INSTALL) {
					this.options.log('Assistant: the runtime install was declined; nothing was downloaded.');
					return 'declined';
				}
				break;
			}
			const before = this.options.globalState.get<unknown>(RUNTIME_TERMS_KEY);
			await this.options.globalState.update(RUNTIME_TERMS_KEY, [...new Set([...(Array.isArray(before) ? before.filter((x) => typeof x === 'string') : []), manifest.sdkVersion])]);
		}
		if (this.installing || this.options.running()) {
			void this.ui.showError(RUNTIME_BUSY_TEXT);
			return 'busy';
		}
		const abort = new AbortController();
		this.installing = abort;
		this.failure = undefined;
		this.changed.fire();
		const root = this.root();
		this.options.log(`Assistant: installing the runtime (${SDK_PACKAGE}@${manifest.sdkVersion}, ${binaryPackage(platform)}) from ${manifest.registry}.`);
		try {
			await this.ui.progress('Installing the assistant runtime', async (report) => {
				let last = '';
				const proxy = this.testProxy;
				await installRuntime({
					root, manifest, platform, signal: abort.signal,
					agentFor: (url) => registryAgent(url, proxy ?? proxyConfigFor(url, vscode.workspace.getConfiguration('http'))),
					onProgress: (name, bytes, total) => {
						const text = `${name}: ${(bytes / MB).toFixed(0)}${total ? ` of ${(total / MB).toFixed(0)}` : ''} MB`;
						if (text !== last) {
							last = text;
							report(text);
						}
					},
				});
			}, () => abort.abort());
			this.options.log(`Assistant: the runtime ${manifest.sdkVersion} is installed.`);
			void this.ui.showInfo(`The assistant runtime ${manifest.sdkVersion} is installed.`);
			return 'installed';
		} catch (err) {
			if (err instanceof RuntimeCancelled || abort.signal.aborted) {
				this.options.log('Assistant: the runtime install was cancelled; nothing was kept.');
				return 'cancelled';
			}
			return this.failed(err);
		} finally {
			if (this.installing === abort) {
				this.installing = undefined;
			}
			this.refresh();
		}
	}

	private failed(err: unknown): 'failed' {
		this.failure = this.options.mask(errorText(err));
		this.options.log(`Assistant: the runtime install failed: ${this.failure}`);
		void this.ui.showError(`The assistant runtime couldn't be installed: ${this.failure}`);
		return 'failed';
	}

	/** Test seam (and the progress notification's Cancel): stops the install going. */
	cancel(): void {
		this.installing?.abort();
	}

	/** Deletes the installed runtime. */
	async remove(): Promise<RuntimeRemoveOutcome> {
		if (this.installing || this.options.running()) {
			void this.ui.showError(RUNTIME_BUSY_TEXT);
			return 'busy';
		}
		const root = this.root();
		const there = fs.existsSync(root);
		try {
			removeRuntime(root);
		} catch (err) {
			const why = this.options.mask(errorText(err));
			this.options.log(`Assistant: the runtime could not be removed: ${why}`);
			void this.ui.showError(`The assistant runtime couldn't be removed: ${why}`);
			this.refresh();
			return 'failed';
		}
		this.failure = undefined;
		this.refresh();
		this.options.log(there ? 'Assistant: the runtime was removed.' : 'Assistant: no runtime was installed.');
		if (there) {
			void this.ui.showInfo('The assistant runtime was removed.');
		}
		return there ? 'removed' : 'none';
	}
}
