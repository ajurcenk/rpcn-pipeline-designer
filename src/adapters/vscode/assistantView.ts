// The RPCN AI Assistant view (AD-26, story 8.1): a webview view in its own activity-bar container. It
// is the vscode side of the host port (`src/adapters/assistant/host.ts`): it sees only `AssistantHost`,
// made per run by the host factory (the Agent SDK adapter; a suite's fake in tests).
//
// A request (the view's box, or the hidden `redpandaConnect.assistant.run` command) runs `rpcn-design`
// when it can start: assistant access is set up (a key in the secret storage, a usable base URL), the
// binary AD-9 resolved is `ok`, and a folder is open; otherwise the view says why and nothing starts.
// While it runs: each `progress` event is a line; a `question` shows as cards (the skill's pick first)
// and the answers go back with `answer`; an `approval` asks in a modal and the choice goes back with
// `approve`; a `fileWritten` design note is read from disk, and the view shows it with its frontmatter
// `status` (stage from files: never from the conversation). Stop cancels the run. The run's `result`
// ends it (done or stopped), an `error` ends it with a masked error line; a new request works after both.
//
// Every text posted or logged is masked: the key (and any credential-looking value) and the home folder.
// As the metrics tab: the webview posts `ready` each time it loads and gets the whole state; `receive`
// is the integration tests' seam; `posted` keeps the last messages (capped).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	MAX_PROGRESS_LINES, MAX_REQUEST_CHARS, orderOptions, parseAssistantWebviewMessage,
	type AssistantAccess as AccessState, type AssistantHostMessage, type AssistantNoteView, type AssistantQuestionsView, type AssistantStateMessage, type AssistantStatus,
} from '../../shared/assistantProtocol';
import { errorText } from '../../shared/errorText';
import { designNoteStatus, isDesignNote } from '../../core/designNote';
import type { AssistantEvent, AssistantHost, AssistantHostFactory, AssistantQuestion } from '../assistant/host';
import { isInside } from '../assistant/rules';
import type { BinaryState } from '../redpandaConnect/binary';
import { findOnPath } from '../redpandaConnect/process';
import { webviewHtml } from '../graphPanel/html';
import { SET_UP_ASSISTANT_ACCESS_COMMAND, usableBaseUrl, type AssistantAccess, type AssistantAccessOverrides } from './assistantAccess';

export const ASSISTANT_VIEW_ID = 'redpandaConnect.assistant';
export const RUN_ASSISTANT_COMMAND = 'redpandaConnect.assistant.run';
/** How many of the posted messages `posted` keeps (test seam). */
const MAX_POSTED = 200;

/** How a run request ended: it ran (done, stopped or failed), or why it did not start. */
export type AssistantRunOutcome = 'done' | 'stopped' | 'error' | 'busy' | 'empty' | Exclude<AccessState, 'ready'>;

/** What a test may replace: the approval modal. */
export interface AssistantViewUi {
	/** Asks to allow a call; `true`: allowed. */
	approve(summary: string, detail: string | undefined): Thenable<boolean>;
}

export interface AssistantViewOptions {
	readonly extensionUri: vscode.Uri;
	readonly storageDir: string;
	readonly log: (line: string) => void;
	readonly access: AssistantAccess;
	readonly binaryState: () => BinaryState;
	/** Fires when the binary state may have changed. */
	readonly onBinaryChange: vscode.Event<unknown>;
	readonly hostFactory: AssistantHostFactory;
	/** Review 7: whether `uv` is on the PATH (default: looked up on `PATH` at each check). */
	readonly uvAvailable?: () => boolean;
}

/** Test seam: the access, plus the binary state and the workspace folder a request sees (`null`: back to the real one). */
export interface AssistantTestAccess extends AssistantAccessOverrides {
	readonly binary?: BinaryState | null;
	readonly workspace?: string | null;
	/** Review 7: whether `uv` is found. */
	readonly uv?: boolean | null;
}

/**
 * Review 14: `text` with the home folder replaced by `~` only where it is a whole path prefix: followed by a
 * path separator, or at the end of the text or a word (`/home/u2` is not `/home/u`'s).
 */
export function maskHome(text: string, homes: readonly string[]): string {
	let out = text;
	for (const home of [...new Set(homes)].filter((h) => h.length > 1).sort((a, b) => b.length - a.length)) {
		const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		out = out.replace(new RegExp(`${escaped}(?=[\\\\/]|$|[\\s"'\`,;:)\\]}])`, 'g'), '~');
	}
	return out;
}

/** The bundled skills copy (`assets/rpcn-skills`, story 8.1). */
export function bundledSkillsDir(extensionUri: vscode.Uri): string {
	return path.join(extensionUri.fsPath, 'assets', 'rpcn-skills');
}

export class AssistantView implements vscode.WebviewViewProvider, vscode.Disposable {
	ui: AssistantViewUi = {
		approve: async (summary, detail) => {
			const pick = await vscode.window.showWarningMessage(`The assistant asks to ${summary}.`, { modal: true, ...(detail ? { detail } : {}) }, 'Allow', 'Deny');
			return pick === 'Allow';
		},
	};
	/** The last messages posted to the webview, in order (test seam). */
	readonly posted: AssistantHostMessage[] = [];
	/** How many runs started (test seam: "nothing starts"). */
	runsStarted = 0;
	/** Review 8, test seam: the idle timeout handed to each run's host (`undefined`: the host's 5 minutes). */
	idleTimeoutMs: number | undefined;
	/** Review 2: a run is claimed (from the first line of `run`, before any await) until it ends. */
	private claimed = false;
	private view: vscode.WebviewView | undefined;
	private ready = false;
	private viewSubscriptions: vscode.Disposable[] = [];
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private factory: AssistantHostFactory;
	private host: AssistantHost | undefined;
	private testBinary: BinaryState | undefined;
	private testWorkspace: string | undefined;
	private testUv: boolean | undefined;
	private status: AssistantStatus = 'idle';
	private request: string | null = null;
	private progress: string[] = [];
	/** Review 5: the open questions and approvals by id, oldest first (the oldest question's cards are shown). */
	private readonly openQuestions = new Map<string, readonly AssistantQuestion[]>();
	private readonly openApprovals = new Set<string>();
	private noteFile: string | undefined;
	private note: AssistantNoteView | null = null;
	private error: string | null = null;
	private workspace: string | undefined;

	constructor(private readonly options: AssistantViewOptions) {
		this.factory = options.hostFactory;
		this.subscriptions.push(
			this.changed,
			options.access.onDidChange(() => this.post()),
			options.onBinaryChange(() => this.post()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.post()),
		);
	}

	register(): vscode.Disposable[] {
		return [
			vscode.window.registerWebviewViewProvider(ASSISTANT_VIEW_ID, this),
			vscode.commands.registerCommand(RUN_ASSISTANT_COMMAND, async (request?: unknown) => {
				await vscode.commands.executeCommand(`${ASSISTANT_VIEW_ID}.focus`);
				// Review 23: the webview's limit too.
				return typeof request === 'string' && request.length <= MAX_REQUEST_CHARS ? this.run(request) : 'empty';
			}),
		];
	}

	dispose(): void {
		this.host?.cancel();
		this.viewSubscriptions.forEach((s) => s.dispose());
		this.subscriptions.forEach((s) => s.dispose());
	}

	/** Test seam: the factory each run's host is made with (`undefined`: the Agent SDK's). */
	setHostFactory(factory: AssistantHostFactory | undefined): void {
		this.factory = factory ?? this.options.hostFactory;
	}

	/** Test seam: see `AssistantTestAccess`. */
	async setAccessForTest(next: AssistantTestAccess): Promise<void> {
		if (next.binary !== undefined) {
			this.testBinary = next.binary ?? undefined;
		}
		if (next.workspace !== undefined) {
			this.testWorkspace = next.workspace ?? undefined;
		}
		if (next.uv !== undefined) {
			this.testUv = next.uv ?? undefined;
		}
		await this.options.access.setAccessForTest(next);
		this.post();
	}

	get visible(): boolean {
		return this.view?.visible === true;
	}

	/** Whether a run is going. */
	get running(): boolean {
		return this.host !== undefined;
	}

	private uvFound(): boolean {
		return this.testUv ?? (this.options.uvAvailable ? this.options.uvAvailable() : findOnPath('uv', process.env.PATH) !== undefined);
	}

	private binary(): BinaryState {
		return this.testBinary ?? this.options.binaryState();
	}

	private workspaceFolder(): string | undefined {
		return this.testWorkspace ?? vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri.fsPath;
	}

	/** Whether a request can start now, and if not, why. */
	accessState(): AccessState {
		const settings = this.options.access.settings();
		if (!this.options.access.hasKey) {
			return 'noAccess';
		}
		if (!usableBaseUrl(settings.baseUrl)) {
			return 'badBaseUrl';
		}
		if (!this.options.access.keyMatchesBaseUrl) {
			return 'baseUrlChanged';
		}
		if (this.binary().kind !== 'ok') {
			return 'noBinary';
		}
		if (!this.uvFound()) {
			return 'noUv';
		}
		return this.workspaceFolder() ? 'ready' : 'noWorkspace';
	}

	/** `text` as the view shows and logs it: credentials and the home folder masked. */
	mask(text: string): string {
		return maskHome(this.options.access.mask(text), [os.homedir(), process.env.HOME ?? '']);
	}

	/** The state as posted (masked). */
	state(): AssistantStateMessage {
		const first = [...this.openQuestions][0];
		const q = first ? { id: first[0], asked: first[1] } : undefined;
		const questions: AssistantQuestionsView | null = q ? {
			id: q.id,
			questions: q.asked.map((x) => ({
				question: this.mask(x.question),
				header: this.mask(x.header),
				multiSelect: x.multiSelect,
				options: orderOptions(x.options.map((o) => ({ label: this.mask(o.label), description: this.mask(o.description) }))),
			})),
		} : null;
		return {
			type: 'state',
			access: this.accessState(),
			status: this.status,
			request: this.request === null ? null : this.mask(this.request),
			progress: this.progress.map((l) => this.mask(l)),
			questions,
			note: this.note ? { file: this.mask(this.note.file), status: this.note.status === null ? null : this.mask(this.note.status) } : null,
			error: this.error === null ? null : this.mask(this.error),
		};
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.viewSubscriptions.forEach((s) => s.dispose());
		this.view = view;
		this.ready = false;
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, 'dist')] };
		view.webview.html = webviewHtml(view.webview, this.options.extensionUri, 'assistant', 'RPCN AI Assistant');
		this.viewSubscriptions = [
			view.webview.onDidReceiveMessage((raw: unknown) => this.receive(raw)),
			view.onDidChangeVisibility(() => {
				if (!view.visible) {
					// Not retained while hidden: the page loads again (and posts `ready`) when shown.
					this.ready = false;
				}
				this.changed.fire();
			}),
			view.onDidDispose(() => {
				if (this.view === view) {
					this.view = undefined;
					this.ready = false;
					this.viewSubscriptions.forEach((s) => s.dispose());
					this.viewSubscriptions = [];
					this.changed.fire();
				}
			}),
		];
	}

	/** A message from the webview (a test seam too: the integration tests cannot click in it). */
	async receive(raw: unknown): Promise<void> {
		const m = parseAssistantWebviewMessage(raw);
		if (!m) {
			return;
		}
		switch (m.type) {
			case 'ready':
				this.ready = true;
				this.post();
				break;
			case 'runRequested':
				await this.run(m.request);
				break;
			case 'answered':
				this.answered(m.id, m.answers);
				break;
			case 'stopRequested':
				this.stop();
				break;
			case 'setUpAccessRequested':
				await vscode.commands.executeCommand(SET_UP_ASSISTANT_ACCESS_COMMAND);
				break;
			case 'openSettingsRequested':
				await vscode.commands.executeCommand('workbench.action.openSettings', 'redpandaConnect.assistant');
				break;
		}
	}

	/** Stops the run (nothing when none runs). */
	stop(): void {
		if (this.host) {
			this.options.log('Assistant: Stop.');
			this.host.cancel();
		}
	}

	/** Runs one request through `rpcn-design`; settles when the run ends (or did not start). Never throws. */
	async run(request: string): Promise<AssistantRunOutcome> {
		const prompt = request.trim();
		if (!prompt) {
			return 'empty';
		}
		// Review 2: claimed before the first await, released on every exit.
		if (this.claimed) {
			return 'busy';
		}
		this.claimed = true;
		try {
			return await this.runClaimed(prompt);
		} finally {
			this.claimed = false;
		}
	}

	private async runClaimed(prompt: string): Promise<AssistantRunOutcome> {
		await this.options.access.ready;
		const access = this.accessState();
		const binary = this.binary();
		const workspace = this.workspaceFolder();
		const apiKey = await this.options.access.apiKey();
		if (access !== 'ready' || binary.kind !== 'ok' || !workspace || !apiKey) {
			this.post();
			return access === 'ready' ? 'noAccess' : access;
		}
		const settings = this.options.access.settings();
		let host: AssistantHost;
		try {
			host = this.factory({
				...settings,
				apiKey,
				workspace,
				skillsDir: bundledSkillsDir(this.options.extensionUri),
				rpcnBinary: binary.path,
				storageDir: this.options.storageDir,
				baseEnv: process.env,
				log: (line) => this.options.log(this.mask(line)),
				...(this.idleTimeoutMs !== undefined ? { idleTimeoutMs: this.idleTimeoutMs } : {}),
			});
		} catch (err) {
			this.error = errorText(err);
			this.status = 'error';
			this.post();
			return 'error';
		}
		this.host = host;
		this.runsStarted++;
		this.workspace = workspace;
		this.status = 'running';
		this.request = prompt;
		this.progress = [];
		this.closeOpen();
		this.noteFile = undefined;
		this.note = null;
		this.error = null;
		this.options.log(`Assistant: a design run started (${settings.model}).`);
		this.post();
		try {
			await host.start({ prompt, skill: 'rpcn-design' }, (event) => {
				if (this.host === host) {
					this.event(host, event);
				}
			});
		} catch (err) {
			// The port never rejects; an adapter that does is an error of the run.
			this.event(host, { type: 'error', message: errorText(err) });
		}
		// The listener changed the status meanwhile (TypeScript cannot tell).
		const ended = (): AssistantStatus => this.status;
		if (ended() === 'running' || ended() === 'question' || ended() === 'approval') {
			this.event(host, { type: 'error', message: 'The assistant ended without a result.' });
		}
		this.host = undefined;
		this.closeOpen();
		this.readNote();
		this.post();
		const status = ended();
		return status === 'done' ? 'done' : status === 'stopped' ? 'stopped' : 'error';
	}

	private event(host: AssistantHost, event: AssistantEvent): void {
		switch (event.type) {
			case 'progress':
				this.addProgress(event.text);
				break;
			case 'question':
				this.openQuestions.set(event.id, event.questions);
				this.status = this.openStatus();
				break;
			case 'approval':
				this.openApprovals.add(event.id);
				this.status = this.openStatus();
				this.addProgress(`Asks to ${event.summary}`);
				void this.askApproval(host, event.id, event.summary, event.detail);
				break;
			case 'withdrawn':
				// Review 5: the agent no longer waits for it (its request was aborted).
				this.openQuestions.delete(event.id);
				this.openApprovals.delete(event.id);
				this.status = this.openStatus();
				break;
			case 'fileWritten':
				if (this.workspace && isDesignNote(path.basename(event.path)) && isInside(this.workspace, event.path)) {
					this.noteFile = event.path;
					this.readNote();
				}
				break;
			case 'result':
				this.closeOpen();
				this.status = event.stopped ? 'stopped' : 'done';
				this.options.log(`Assistant: the run ${event.stopped ? 'was stopped' : 'ended'}.`);
				break;
			case 'error':
				this.closeOpen();
				this.status = 'error';
				this.error = event.message;
				this.options.log(`Assistant: the run failed: ${this.mask(event.message)}`);
				break;
		}
		this.post();
	}

	private async askApproval(host: AssistantHost, id: string, summary: string, detail: string | undefined): Promise<void> {
		let allowed = false;
		try {
			allowed = await this.ui.approve(this.mask(summary), detail === undefined ? undefined : this.mask(detail));
		} catch (err) {
			this.options.log(`Assistant: the approval prompt failed: ${this.mask(errorText(err))}`);
		}
		if (this.host !== host || !this.openApprovals.has(id)) {
			return;
		}
		this.openApprovals.delete(id);
		this.addProgress(allowed ? 'Allowed' : 'Denied');
		this.status = this.openStatus();
		host.approve(id, allowed);
		this.post();
	}

	/** Review 5: while a run goes, `approval` while any approval is open, else `question` while any question is, else `running`. */
	private openStatus(): AssistantStatus {
		return this.openApprovals.size > 0 ? 'approval' : this.openQuestions.size > 0 ? 'question' : 'running';
	}

	private closeOpen(): void {
		this.openQuestions.clear();
		this.openApprovals.clear();
	}

	private answered(id: string, answers: readonly string[]): void {
		const asked = this.openQuestions.get(id);
		const host = this.host;
		if (!asked || !host || answers.length !== asked.length || answers.some((a) => a.trim() === '')) {
			return;
		}
		// Review 20: the answers come by card index, and go back under each question's own (unmasked) text.
		const back: Record<string, string> = {};
		asked.forEach((q, i) => {
			back[q.question] = answers[i];
		});
		this.openQuestions.delete(id);
		this.status = this.openStatus();
		this.addProgress(`Answered ${asked.length} question${asked.length === 1 ? '' : 's'}`);
		host.answer(id, back);
		this.post();
	}

	private addProgress(text: string): void {
		this.progress.push(text);
		if (this.progress.length > MAX_PROGRESS_LINES) {
			this.progress.splice(0, this.progress.length - MAX_PROGRESS_LINES);
		}
	}

	/** The note written in this run, read from disk: its file and its frontmatter `status`. */
	private readNote(): void {
		const file = this.noteFile;
		if (!file || !this.workspace) {
			return;
		}
		let text: string;
		try {
			text = fs.readFileSync(file, 'utf8');
		} catch {
			this.note = null;
			return;
		}
		this.note = { file: path.relative(this.workspace, file).split(path.sep).join('/'), status: designNoteStatus(text) };
	}

	private post(): void {
		const message = this.state();
		this.posted.push(message);
		if (this.posted.length > MAX_POSTED) {
			this.posted.splice(0, this.posted.length - MAX_POSTED);
		}
		if (this.view && this.ready) {
			void this.view.webview.postMessage(message);
		}
		this.changed.fire();
	}
}
