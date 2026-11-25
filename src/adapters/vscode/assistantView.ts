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
// Story 8.2: nothing starts, either, without the assistant runtime (the Agent SDK and this platform's
// Claude Code binary, which the extension never ships; the user installs them: `assistantRuntime.ts`):
// `runtimeMissing` (Install assistant runtime…), `runtimeInstalling`, `runtimeOutdated` (another version
// installed: Update assistant runtime…), `runtimeFailed` (the reason, with Retry), `unavailable` (no binary
// package exists for this platform); or when `redpandaConnect.assistant.skillsPath` is no usable checkout
// (`badSkillsPath`, with why). A valid `skillsPath` is the skills copy a run uses (its plugin, and the
// shell and read rules' copy) instead of the bundled one; the view says "Skills: local copy". A runtime
// that passed the view's check but that the host cannot load ends the run as `runtimeMissing`: the
// request cleared, no "run started" line, no error line.
//
// Story 8.12: the view is a chat (the prototype's option A). Each request is a turn: the message as typed
// (a leading `/design`; `/build` and `/test` are listed but do not run yet), its step rows (`step` and
// `stepDone`, plus the run's own lines), the reply (`reply`, joined, at most 20,000 characters), and once
// it ends the files it changed. Before a run's first write to a path the host sends the file's content
// (`fileChanging`), kept in memory only; at the end each snapshotted file whose content differs is a file
// row with its +N/−N, a click opening `vscode.diff` against an `rpcn-assistant-before:` copy. Keep drops
// the snapshots; Undo restores every file (deleting those the turn created), asking first when a file
// changed after the turn. A new Send keeps the previous turn's changes. New conversation stops a run
// first, then clears the turns and their snapshots. At most 50 turns, 200 steps each.
//
// Every text posted or logged is masked: the key (and any credential-looking value) and the home folder.
// As the metrics tab: the webview posts `ready` each time it loads and gets the whole state; `receive`
// is the integration tests' seam; `posted` keeps the last messages (capped).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	askedText, COMMAND_HINTS, COMMAND_SKILLS, isPick, MAX_REPLY_CHARS, MAX_REQUEST_CHARS, MAX_STEPS, MAX_TURNS, OPEN_NOTE_ACTION, OPEN_NOTE_LABEL, orderOptions, parseAssistantWebviewMessage, parseCommand,
	undoLaterEditsText,
	type AssistantAccess as AccessState, type AssistantChipView, type AssistantCommand, type AssistantFileView, type AssistantOutcome, type AssistantReview, type AssistantStepView,
	type AssistantTurnView, type SkillsPathProblem, type AssistantHostMessage, type AssistantNoteView, type AssistantQuestionsView, type AssistantStateMessage, type AssistantStatus,
} from '../../shared/assistantProtocol';
import { lineDiff } from '../../shared/lineDiff';
import { errorText } from '../../shared/errorText';
import { designNoteStatus, isDesignNote } from '../../core/designNote';
import { RPCN_SKILLS, SNAPSHOT_MAX_BYTES, type AssistantEvent, type AssistantHost, type AssistantHostFactory, type AssistantQuestion } from '../assistant/host';
import type { RuntimeView } from './assistantRuntime';
import { INSTALL_RUNTIME_COMMAND, UPDATE_RUNTIME_COMMAND, type AssistantRuntime } from './assistantRuntime';
import { isInside } from '../assistant/rules';
import type { BinaryState } from '../redpandaConnect/binary';
import { findOnPath } from '../redpandaConnect/process';
import { webviewHtml } from '../graphPanel/html';
import { SET_UP_ASSISTANT_ACCESS_COMMAND, usableBaseUrl, type AssistantAccess, type AssistantAccessOverrides } from './assistantAccess';

export const ASSISTANT_VIEW_ID = 'redpandaConnect.assistant';
export const RUN_ASSISTANT_COMMAND = 'redpandaConnect.assistant.run';
/** How many of the posted messages `posted` keeps (test seam). */
const MAX_POSTED = 200;

/** How a run request ended: it ran (done, stopped or failed), or why it did not start (story 8.12: `disabled`, a command not offered yet). */
export type AssistantRunOutcome = 'done' | 'stopped' | 'error' | 'busy' | 'empty' | 'disabled' | Exclude<AccessState, 'ready'>;

/** Story 8.12: how an Undo ended. */
export type AssistantUndoOutcome = 'undone' | 'cancelled' | 'none';

/** Story 8.12: the scheme of a file's copy from before a turn (the left side of its diff, read-only). */
export const BEFORE_SCHEME = 'rpcn-assistant-before';

/** What a test may replace: the approval modal; story 8.12: Undo's question, an info message, opening a link. */
export interface AssistantViewUi {
	/** Asks to allow a call; `true`: allowed. */
	approve(summary: string, detail: string | undefined): Thenable<boolean>;
	/** Undo over later edits: `true` to go on. */
	confirmUndo(message: string): Thenable<boolean>;
	info(message: string): Thenable<unknown>;
	openExternal(uri: vscode.Uri): Thenable<boolean>;
	/** Manual check 3: puts text on the clipboard (the webview's own clipboard does not work in the view). */
	writeClipboard(text: string): Thenable<void>;
}

/** Story 8.12: what a reply's link opens: an http(s) page, a file in the workspace, or nothing. */
export type LinkTarget = { readonly kind: 'external'; readonly url: string } | { readonly kind: 'file'; readonly path: string } | undefined;

/** Story 8.12: a reply link's target. Only `http(s)` URLs and paths inside the workspace (relative or absolute, a `#…` dropped); anything else none. */
export function linkTarget(href: string, workspace: string | undefined): LinkTarget {
	const h = href.trim();
	if (/^https?:\/\//i.test(h)) {
		try {
			const url = new URL(h);
			return url.protocol === 'http:' || url.protocol === 'https:' ? { kind: 'external', url: url.toString() } : undefined;
		} catch {
			return undefined;
		}
	}
	if (!workspace || h === '' || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) {
		return undefined;
	}
	let file = h.replace(/[#?].*$/, '');
	try {
		file = decodeURIComponent(file);
	} catch {
		return undefined;
	}
	if (file === '') {
		return undefined;
	}
	const abs = path.resolve(workspace, file);
	return isInside(workspace, abs) && abs !== path.resolve(workspace) ? { kind: 'file', path: abs } : undefined;
}

/** Story 8.12: a snapshot from before a turn's first write to a file (`before` `null`: it did not exist). */
export interface TurnSnapshot {
	readonly before: string | null;
	readonly tooLarge: boolean;
}

/** Story 8.12: a file a turn changed, as its row shows it, with what Undo needs. */
export interface TurnFile extends AssistantFileView {
	readonly abs: string;
	readonly before: string | null;
	/** Its content when the turn ended (`null`: gone). */
	readonly after: string | null;
}

/**
 * Story 8.12: a turn's file rows: each snapshotted file whose content now differs (a file over 1 MB: when
 * the turn wrote it), in the order first written. `read` gives a file's content now (`null`: none).
 */
export function turnFiles(
	snapshots: ReadonlyMap<string, TurnSnapshot>, written: ReadonlySet<string>, workspace: string, read: (abs: string) => string | null,
	sizeOf: (abs: string) => number | null = fileSize,
): TurnFile[] {
	const files: TurnFile[] = [];
	for (const [abs, snap] of snapshots) {
		const rel = path.relative(workspace, abs).split(path.sep).join('/');
		if (snap.tooLarge) {
			if (written.has(abs)) {
				files.push({ abs, path: rel, before: null, after: null, added: 0, removed: 0, created: false, tooLarge: true });
			}
			continue;
		}
		// Over 1 MB after the turn (created or grown that big): no content kept, so no diff and no undo.
		const size = sizeOf(abs);
		if (size !== null && size > SNAPSHOT_MAX_BYTES) {
			files.push({ abs, path: rel, before: null, after: null, added: 0, removed: 0, created: snap.before === null, tooLarge: true });
			continue;
		}
		const after = read(abs);
		if (after !== snap.before) {
			const { added, removed } = lineDiff(snap.before, after);
			files.push({ abs, path: rel, before: snap.before, after, added, removed, created: snap.before === null, tooLarge: false });
		}
	}
	return files;
}

/** A file's size (`null`: no file). */
function fileSize(file: string): number | null {
	try {
		return fs.statSync(file).size;
	} catch {
		return null;
	}
}

/**
 * Story 8.12: the topmost folder of `file`'s path below `workspace` that does not exist yet (the folder
 * a write of `file` would create), or `undefined` when its folder exists.
 */
export function firstMissingFolder(workspace: string, file: string): string | undefined {
	const parts = path.relative(workspace, path.dirname(file)).split(path.sep).filter((p) => p !== '' && p !== '.');
	let dir = workspace;
	for (const part of parts) {
		dir = path.join(dir, part);
		if (!fs.existsSync(dir)) {
			return dir;
		}
	}
	return undefined;
}

/** Story 8.12: removes `dir` and the folders in it, bottom-up, only where they hold no file; whether `dir` went. */
export function removeEmptyFolders(dir: string): boolean {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	let empty = true;
	for (const e of entries) {
		if (!(e.isDirectory() && !e.isSymbolicLink() && removeEmptyFolders(path.join(dir, e.name)))) {
			empty = false;
		}
	}
	if (!empty) {
		return false;
	}
	try {
		fs.rmdirSync(dir);
		return true;
	} catch {
		return false;
	}
}

function readText(file: string): string | null {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return null;
	}
}

/** Story 8.12: one turn, as the view keeps it. */
interface Turn {
	readonly id: string;
	readonly command: AssistantCommand;
	readonly text: string;
	readonly skill: string;
	readonly workspace: string;
	steps: AssistantStepView[];
	reply: string;
	readonly snapshots: Map<string, TurnSnapshot>;
	readonly written: Set<string>;
	/** The folders the turn's writes created (the topmost new one of each), for Undo to remove when empty. */
	readonly createdFolders: Set<string>;
	/** Manual check 2: the approvals decided, by the step (tool call) they were for. */
	readonly decisions: Map<string, 'allowed' | 'denied'>;
	files: TurnFile[];
	review: AssistantReview;
	noteFile: string | undefined;
	note: AssistantNoteView | null;
	outcome: AssistantOutcome;
	notice: string | null;
	/** The masked view, until the turn changes. */
	view: AssistantTurnView | undefined;
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
	/**
	 * Story 8.2: the assistant runtime. Review 4: looked up when the view loads or becomes visible, a run
	 * starts, an install or removal ends, or a test's access changes.
	 */
	readonly runtime: AssistantRuntime;
}

/** Test seam: the access, plus the binary state and the workspace folder a request sees (`null`: back to the real one). */
export interface AssistantTestAccess extends AssistantAccessOverrides {
	readonly binary?: BinaryState | null;
	readonly workspace?: string | null;
	/** Review 7: whether `uv` is found. */
	readonly uv?: boolean | null;
}

/** Story 8.2: the skills copy a run uses. */
export interface SkillsCopy {
	readonly kind: 'bundled' | 'local';
	readonly dir: string;
}

/** Story 8.2: what a `skillsPath` value gives: a copy, or why it is no checkout to use (`badSkillsPath`). */
export type SkillsChoice = SkillsCopy | { readonly kind: 'bad'; readonly problem: SkillsPathProblem };

/** The files a `skillsPath` folder must hold to count as an `rpcn-skills` checkout (review 7). */
export const SKILLS_CHECKOUT_FILES: readonly string[] = [
	path.join('.claude-plugin', 'plugin.json'),
	...RPCN_SKILLS.map((skill) => path.join('skills', skill, 'SKILL.md')),
];

function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * Story 8.2: the skills copy for a `skillsPath` value. Anything but a non-empty string (review 8): the
 * bundled copy. Otherwise `~` or a leading `~/` expands to the home folder (nothing else does); the path
 * must be absolute, an existing folder, hold `SKILLS_CHECKOUT_FILES`, and (review 1) be neither the
 * workspace folder, nor inside it, nor contain it: the agent may write in the workspace, and the copy's
 * scripts run without asking.
 */
export function skillsCopy(setting: unknown, bundled: string, workspaces: string | undefined | readonly string[], home: string = os.homedir()): SkillsChoice {
	const value = typeof setting === 'string' ? setting.trim() : '';
	if (!value) {
		return { kind: 'bundled', dir: bundled };
	}
	const expanded = value === '~' ? home : /^~[\\/]/.test(value) ? path.join(home, value.slice(2)) : value;
	if (!path.isAbsolute(expanded)) {
		return { kind: 'bad', problem: 'notAbsolute' };
	}
	const dir = path.resolve(expanded);
	let folder = false;
	try {
		folder = fs.statSync(dir).isDirectory();
	} catch {
		folder = false;
	}
	if (!folder) {
		return { kind: 'bad', problem: 'notFound' };
	}
	if (!SKILLS_CHECKOUT_FILES.every((f) => isFile(path.join(dir, f)))) {
		return { kind: 'bad', problem: 'notCheckout' };
	}
	const folders = typeof workspaces === 'string' ? [workspaces] : workspaces ?? [];
	if (folders.some((workspace) => isInside(workspace, dir) || isInside(dir, workspace))) {
		return { kind: 'bad', problem: 'inWorkspace' };
	}
	return { kind: 'local', dir };
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
		confirmUndo: async (message) => (await vscode.window.showWarningMessage(message, { modal: true }, 'Undo')) === 'Undo',
		info: (message) => vscode.window.showInformationMessage(message),
		openExternal: (uri) => vscode.env.openExternal(uri),
		writeClipboard: (text) => vscode.env.clipboard.writeText(text),
	};
	/** The last messages posted to the webview, in order (test seam). */
	readonly posted: AssistantHostMessage[] = [];
	/** How many runs started (test seam: "nothing starts"). */
	runsStarted = 0;
	/** Review 8, test seam: the idle timeout handed to each run's host (`undefined`: the host's 5 minutes). */
	idleTimeoutMs: number | undefined;
	/** Review 2: a run is claimed (from the first line of `run`, before any await) until it ends. */
	private claimed = false;
	/** Story 8.12: the claimed run, until it ends (New conversation waits for it). */
	private going: Promise<AssistantRunOutcome> | undefined;
	private view: vscode.WebviewView | undefined;
	private ready = false;
	private viewSubscriptions: vscode.Disposable[] = [];
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly beforeChanged = new vscode.EventEmitter<vscode.Uri>();
	private factory: AssistantHostFactory;
	private host: AssistantHost | undefined;
	private testBinary: BinaryState | undefined;
	private testWorkspace: string | undefined;
	private testUv: boolean | undefined;
	/** Review 3: a run's host found the runtime gone after the view's check passed (until the next lookup). */
	private hostRuntimeGone = false;
	private status: AssistantStatus = 'idle';
	/** Story 8.12: the conversation, oldest first. */
	private turns: Turn[] = [];
	private turnSeq = 0;
	private stepSeq = 0;
	/** The turn of the run going now. */
	private current: Turn | undefined;
	/** Review 5: the open questions and approvals by id, oldest first (the oldest question's cards are shown). */
	private readonly openQuestions = new Map<string, readonly AssistantQuestion[]>();
	private readonly openApprovals = new Set<string>();
	private error: string | null = null;

	constructor(private readonly options: AssistantViewOptions) {
		this.factory = options.hostFactory;
		this.subscriptions.push(
			this.changed,
			this.beforeChanged,
			options.access.onDidChange(() => {
				// The mask may have changed: every turn is masked again.
				this.turns.forEach((t) => (t.view = undefined));
				this.post();
			}),
			// Any lookup of the runtime (an install or removal ending among them) replaces what a run's host found.
			options.runtime.onDidChange(() => {
				this.hostRuntimeGone = false;
				this.post();
			}),
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
			// Story 8.12: the left side of a file row's diff (the copy from before the turn; empty for a new file).
			vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, {
				onDidChange: this.beforeChanged.event,
				provideTextDocumentContent: (uri) => this.beforeContent(uri),
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
		this.lookUp();
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

	/** Every workspace folder on disk (the test seam's folder too): `skillsPath` may be in or around none of them. */
	private workspaceFolders(): string[] {
		const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
		return this.testWorkspace ? [this.testWorkspace, ...folders] : folders;
	}

	private workspaceFolder(): string | undefined {
		return this.testWorkspace ?? vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri.fsPath;
	}

	/** Story 8.2, review 4: looks the runtime up again (clears a host's `runtimeMissing`). */
	private lookUp(): RuntimeView {
		this.hostRuntimeGone = false;
		this.options.runtime.refresh();
		return this.runtime();
	}

	/** Story 8.2: the runtime, as last looked up (or as a run's host found it). */
	runtime(): RuntimeView {
		const view = this.options.runtime.view();
		return this.hostRuntimeGone && view.kind === 'installed' ? { kind: 'missing', platform: view.platform } : view;
	}

	/** Story 8.2: the skills copy a run uses, or why `skillsPath` gives none. */
	skills(): SkillsChoice {
		return skillsCopy(vscode.workspace.getConfiguration('redpandaConnect.assistant').get<unknown>('skillsPath'), bundledSkillsDir(this.options.extensionUri), this.workspaceFolders());
	}

	/** Whether a request can start now, and if not, why. */
	accessState(): AccessState {
		return this.access().state;
	}

	private access(): { readonly state: AccessState; readonly runtime: RuntimeView; readonly skills: SkillsChoice } {
		const runtime = this.runtime();
		const skills = this.skills();
		const state: AccessState = runtime.kind === 'unavailable' ? 'unavailable'
			: runtime.kind === 'installing' ? 'runtimeInstalling'
				: runtime.kind === 'failed' ? 'runtimeFailed'
					: runtime.kind === 'outdated' ? 'runtimeOutdated'
						: runtime.kind === 'missing' ? 'runtimeMissing'
							: skills.kind === 'bad' ? 'badSkillsPath' : this.accessRest();
		return { state, runtime, skills };
	}

	private accessRest(): AccessState {
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

	private pinned(): string {
		try {
			return this.options.runtime.manifest().sdkVersion;
		} catch {
			return '';
		}
	}

	/** `text` as the view shows and logs it: credentials and the home folder masked. */
	mask(text: string): string {
		return maskHome(this.options.access.mask(text), [os.homedir(), process.env.HOME ?? '']);
	}

	/** Story 8.12: a turn as posted (masked; kept until the turn changes). */
	private turnView(t: Turn): AssistantTurnView {
		if (t.view) {
			return t.view;
		}
		const ended = t.outcome !== 'running';
		const note = t.note && t.review !== 'undone' ? t.note : null;
		const chips: AssistantChipView[] = ended && t.command === 'design' && note
			? (['build', 'test'] as const).map((command) => ({ label: `/${command}`, command, enabled: COMMAND_HINTS[command] === null, hint: COMMAND_HINTS[command] }))
			: [];
		t.view = {
			id: t.id,
			command: t.command,
			text: this.mask(t.text),
			skill: t.skill,
			steps: t.steps.map((s) => ({ id: s.id, label: this.mask(s.label), mark: s.mark, result: this.mask(s.result), ...(s.detail ? { detail: this.mask(s.detail) } : {}) })),
			reply: this.mask(t.reply),
			files: t.files.map((f) => ({ path: this.mask(f.path), added: f.added, removed: f.removed, created: f.created, tooLarge: f.tooLarge })),
			review: t.review,
			note: note ? { file: this.mask(note.file), status: note.status === null ? null : this.mask(note.status) } : null,
			actions: ended && note ? [{ id: OPEN_NOTE_ACTION, label: OPEN_NOTE_LABEL, enabled: true, hint: null }] : [],
			chips,
			outcome: t.outcome,
			notice: t.notice === null ? null : this.mask(t.notice),
		};
		return t.view;
	}

	/** Story 8.12: this conversation's latest note (not undone) is `ready`. */
	private designReady(): boolean {
		for (let i = this.turns.length - 1; i >= 0; i--) {
			const t = this.turns[i];
			if (t.note && t.review !== 'undone') {
				return t.note.status === 'ready';
			}
		}
		return false;
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
		const access = this.access();
		const folder = this.workspaceFolder();
		return {
			type: 'state',
			access: access.state,
			platform: access.runtime.kind === 'unavailable' ? access.runtime.platform : null,
			runtime: {
				pinned: this.pinned(),
				installed: access.runtime.kind === 'outdated' ? access.runtime.installed : null,
				error: access.runtime.kind === 'failed' ? this.mask(access.runtime.error) : null,
			},
			skills: access.skills.kind === 'bad' ? null : access.skills.kind,
			skillsProblem: access.skills.kind === 'bad' ? access.skills.problem : null,
			status: this.status,
			turns: this.turns.map((t) => this.turnView(t)),
			folder: folder ? this.mask(path.basename(folder)) : null,
			designReady: this.designReady(),
			questions,
			error: this.error === null ? null : this.mask(this.error),
		};
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.viewSubscriptions.forEach((s) => s.dispose());
		this.view = view;
		this.ready = false;
		this.lookUp();
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, 'dist')] };
		view.webview.html = webviewHtml(view.webview, this.options.extensionUri, 'assistant', 'RPCN AI Assistant');
		this.viewSubscriptions = [
			view.webview.onDidReceiveMessage((raw: unknown) => this.receive(raw)),
			view.onDidChangeVisibility(() => {
				if (!view.visible) {
					// Not retained while hidden: the page loads again (and posts `ready`) when shown.
					this.ready = false;
				} else {
					this.lookUp();
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
				await this.run(m.request, m.command);
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
			case 'installRuntimeRequested':
				await vscode.commands.executeCommand(INSTALL_RUNTIME_COMMAND);
				break;
			case 'updateRuntimeRequested':
				await vscode.commands.executeCommand(UPDATE_RUNTIME_COMMAND);
				break;
			case 'openFileDiff':
				await this.openFileDiff(m.turn, m.path);
				break;
			case 'keepTurn':
				this.keep(m.turn);
				break;
			case 'undoTurn':
				await this.undo(m.turn);
				break;
			case 'turnAction':
				await this.turnAction(m.turn, m.action);
				break;
			case 'openLink':
				await this.openLink(m.href);
				break;
			case 'newConversation':
				await this.newConversation();
				break;
			case 'copyText':
				// Masked again: the text came from the view, which shows only masked text.
				try {
					await this.ui.writeClipboard(this.mask(m.text));
				} catch (err) {
					this.options.log(`Assistant: could not copy to the clipboard: ${this.mask(errorText(err))}`);
				}
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

	/**
	 * Runs one message (its slash command, else `command`; story 8.12: only `design` runs, through
	 * `rpcn-design`); settles when the run ends (or did not start). Never throws.
	 */
	run(request: string, command: AssistantCommand = 'design'): Promise<AssistantRunOutcome> {
		const text = request.trim();
		const parsed = parseCommand(text);
		const cmd = parsed.command ?? command;
		if (!parsed.rest) {
			return Promise.resolve('empty');
		}
		if (COMMAND_HINTS[cmd] !== null) {
			return Promise.resolve('disabled');
		}
		// Review 2: claimed before the first await, released on every exit.
		if (this.claimed) {
			return Promise.resolve('busy');
		}
		this.claimed = true;
		const going = this.runClaimed(text, cmd, parsed.rest).finally(() => {
			this.claimed = false;
			if (this.going === going) {
				this.going = undefined;
			}
		});
		this.going = going;
		return going;
	}

	private async runClaimed(text: string, command: AssistantCommand, prompt: string): Promise<AssistantRunOutcome> {
		await this.options.access.ready;
		const apiKey = await this.options.access.apiKey();
		// Review 1, 3: looked up again, and the skills path checked against the workspace, at each run's start.
		const runtime = this.lookUp();
		const { state: access, skills } = this.access();
		const binary = this.binary();
		const workspace = this.workspaceFolder();
		if (access !== 'ready' || binary.kind !== 'ok' || !workspace || !apiKey || skills.kind === 'bad' || runtime.kind !== 'installed' || this.options.runtime.busy) {
			this.post();
			return this.options.runtime.busy ? 'runtimeInstalling' : access === 'ready' ? 'noAccess' : access;
		}
		const turn = this.addTurn(command, text, workspace);
		this.closeOpen();
		this.error = null;
		const settings = this.options.access.settings();
		let host: AssistantHost;
		try {
			host = this.factory({
				...settings,
				apiKey,
				workspace,
				skillsDir: skills.dir,
				rpcnBinary: binary.path,
				runtime: runtime.files,
				storageDir: this.options.storageDir,
				baseEnv: process.env,
				log: (line) => this.options.log(this.mask(line)),
				...(this.idleTimeoutMs !== undefined ? { idleTimeoutMs: this.idleTimeoutMs } : {}),
			});
		} catch (err) {
			this.error = errorText(err);
			this.status = 'error';
			this.endTurn(turn, 'error');
			this.post();
			return 'error';
		}
		// Story 8.12: a new Send keeps the previous turn's changes (only once its host is made: a failed one keeps their Undo).
		for (const t of this.turns) {
			if (t !== turn && t.review === 'pending') {
				this.settleReview(t, 'kept');
			}
		}
		this.host = host;
		this.current = turn;
		this.runsStarted++;
		this.status = 'running';
		this.post();
		// Review 3: "started" only once the host takes the run (its first event that is not `unavailable`).
		let accepted = false;
		const started = `Assistant: a design run started (${settings.model}${skills.kind === 'local' ? ', the local skills copy' : ''}).`;
		try {
			await host.start({ prompt, skill: 'rpcn-design' }, (event) => {
				if (this.host === host) {
					if (!accepted && !(event.type === 'error' && event.runtimeMissing)) {
						accepted = true;
						this.options.log(started);
					}
					this.event(host, turn, event);
				}
			});
		} catch (err) {
			// The port never rejects; an adapter that does is an error of the run.
			this.event(host, turn, { type: 'error', message: errorText(err) });
		}
		// The listener changed the status meanwhile (TypeScript cannot tell).
		const ended = (): AssistantStatus => this.status;
		if (ended() === 'running' || ended() === 'question' || ended() === 'approval') {
			this.event(host, turn, { type: 'error', message: 'The assistant ended without a result.' });
		}
		this.host = undefined;
		this.current = undefined;
		this.closeOpen();
		if (this.turns.includes(turn)) {
			this.endTurn(turn, ended() === 'done' ? 'done' : ended() === 'stopped' ? 'stopped' : 'error');
		}
		this.post();
		const status = ended();
		if (this.hostRuntimeGone) {
			return 'runtimeMissing';
		}
		return status === 'done' ? 'done' : status === 'stopped' ? 'stopped' : 'error';
	}

	private addTurn(command: AssistantCommand, text: string, workspace: string): Turn {
		const turn: Turn = {
			id: `t${++this.turnSeq}`, command, text, skill: COMMAND_SKILLS[command], workspace, steps: [], reply: '', snapshots: new Map(), written: new Set(), createdFolders: new Set(), decisions: new Map(),
			files: [], review: 'none', noteFile: undefined, note: null, outcome: 'running', notice: null, view: undefined,
		};
		this.turns.push(turn);
		if (this.turns.length > MAX_TURNS) {
			this.turns.splice(0, this.turns.length - MAX_TURNS);
		}
		return turn;
	}

	/** Story 8.12: the turn's run ended: its open steps closed, its file rows from the snapshots, its note read. */
	private endTurn(turn: Turn, outcome: Exclude<AssistantOutcome, 'running'>): void {
		turn.outcome = outcome;
		turn.steps = turn.steps.map((s) => (s.mark === 'running' ? { ...s, mark: outcome === 'done' ? 'ok' : 'failed', result: outcome === 'stopped' ? 'stopped' : s.result } : s));
		turn.files = turnFiles(turn.snapshots, turn.written, turn.workspace, readText);
		turn.review = turn.files.some((f) => !f.tooLarge) ? 'pending' : 'none';
		if (turn.review === 'none') {
			turn.snapshots.clear();
			turn.createdFolders.clear();
		}
		this.readNote(turn);
		turn.view = undefined;
	}

	private event(host: AssistantHost, turn: Turn, event: AssistantEvent): void {
		switch (event.type) {
			case 'progress':
				this.addStep(turn, { id: `p${++this.stepSeq}`, label: event.text, mark: 'info', result: '' });
				break;
			case 'step':
				this.addStep(turn, { id: event.id, label: event.label, mark: 'running', result: '', ...(event.detail ? { detail: event.detail } : {}) });
				break;
			case 'stepDone': {
				const i = turn.steps.findIndex((s) => s.id === event.id && s.mark === 'running');
				if (i >= 0) {
					// Manual check 2: an approval's outcome is the step's result when it has no other (denied: always).
					const decision = turn.decisions.get(event.id);
					const result = decision === 'denied' ? 'denied' : event.result.slice(0, 60) || decision || '';
					turn.steps[i] = { ...turn.steps[i], mark: event.ok ? 'ok' : 'failed', result };
				}
				break;
			}
			case 'reply':
				this.addReply(turn, event.text);
				break;
			case 'fileChanging':
				// The first snapshot of a path in the turn wins; only files in its workspace folder.
				if (isInside(turn.workspace, event.path) && !turn.snapshots.has(event.path)) {
					turn.snapshots.set(event.path, { before: event.tooLarge ? null : event.before, tooLarge: event.tooLarge === true });
					// A new file: the folder its write will create (looked up now, before the write), for Undo.
					const folder = event.before === null && !event.tooLarge ? firstMissingFolder(turn.workspace, event.path) : undefined;
					if (folder) {
						turn.createdFolders.add(folder);
					}
				}
				break;
			case 'question':
				this.openQuestions.set(event.id, event.questions);
				this.status = this.openStatus();
				break;
			case 'approval':
				this.openApprovals.add(event.id);
				this.status = this.openStatus();
				// Manual check 2: the approval folds into its tool's step row; with no such row, one row of its own.
				if (!(event.stepId && turn.steps.some((s) => s.id === event.stepId && s.mark === 'running'))) {
					this.addStep(turn, { id: event.id, label: `Asks to ${event.summary}`, mark: 'running', result: '' });
				}
				void this.askApproval(host, turn, event.id, event.summary, event.detail, event.stepId);
				break;
			case 'withdrawn':
				// Review 5: the agent no longer waits for it (its request was aborted).
				this.openQuestions.delete(event.id);
				this.openApprovals.delete(event.id);
				this.status = this.openStatus();
				break;
			case 'fileWritten':
				turn.written.add(event.path);
				if (isDesignNote(path.basename(event.path)) && isInside(turn.workspace, event.path)) {
					turn.noteFile = event.path;
					this.readNote(turn);
				}
				break;
			case 'result':
				this.closeOpen();
				this.status = event.stopped ? 'stopped' : 'done';
				if (!event.stopped && turn.reply === '' && event.text) {
					this.addReply(turn, event.text);
				}
				this.options.log(`Assistant: the run ${event.stopped ? 'was stopped' : 'ended'}.`);
				break;
			case 'error':
				this.closeOpen();
				if (event.runtimeMissing) {
					// Story 8.2, review 3: the runtime went after the view's check: its state shows (until the next
					// lookup), not an error line, and the request is not left as if it ran: its turn goes.
					this.hostRuntimeGone = true;
					this.status = 'idle';
					this.error = null;
					this.turns = this.turns.filter((t) => t !== turn);
					this.options.log('Assistant: the assistant runtime is not installed; nothing ran.');
					break;
				}
				this.status = 'error';
				this.error = event.message;
				this.options.log(`Assistant: the run failed: ${this.mask(event.message)}`);
				break;
		}
		turn.view = undefined;
		this.post();
	}

	private addStep(turn: Turn, step: AssistantStepView): void {
		turn.steps.push(step);
		if (turn.steps.length > MAX_STEPS) {
			turn.steps.splice(0, turn.steps.length - MAX_STEPS);
		}
		turn.view = undefined;
	}

	private addReply(turn: Turn, text: string): void {
		if (turn.reply.length >= MAX_REPLY_CHARS || text.trim() === '') {
			return;
		}
		const joined = turn.reply === '' ? text.trim() : `${turn.reply}\n\n${text.trim()}`;
		turn.reply = joined.length > MAX_REPLY_CHARS ? `${joined.slice(0, MAX_REPLY_CHARS - 1)}…` : joined;
		turn.view = undefined;
	}

	private async askApproval(host: AssistantHost, turn: Turn, id: string, summary: string, detail: string | undefined, stepId: string | undefined): Promise<void> {
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
		const decision = allowed ? 'allowed' : 'denied';
		const own = turn.steps.findIndex((s) => s.id === id);
		if (own >= 0) {
			turn.steps[own] = { ...turn.steps[own], mark: allowed ? 'ok' : 'failed', result: decision };
		} else if (stepId) {
			turn.decisions.set(stepId, decision);
			const at = turn.steps.findIndex((s) => s.id === stepId);
			if (at >= 0 && turn.steps[at].result === '') {
				turn.steps[at] = { ...turn.steps[at], result: decision };
			}
		}
		turn.view = undefined;
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
		const turn = this.current;
		if (!asked || !host || !turn || answers.length !== asked.length || answers.some((a) => a.trim() === '')) {
			return;
		}
		// Review 20: the answers come by card index, and go back under each question's own (unmasked) text.
		const back: Record<string, string> = {};
		asked.forEach((q, i) => {
			back[q.question] = answers[i];
		});
		this.openQuestions.delete(id);
		this.status = this.openStatus();
		// Manual check 1: the question's own step row says what came of it (no second "Answered" row).
		const kept = asked.filter((q, i) => q.options.some((o) => isPick(o.label) && o.label === answers[i])).length;
		const label = askedText(asked.length, kept);
		let at = -1;
		for (let i = turn.steps.length - 1; i >= 0 && at < 0; i--) {
			if (turn.steps[i].mark === 'running' && turn.steps[i].label.startsWith('Asking ')) {
				at = i;
			}
		}
		if (at >= 0) {
			turn.steps[at] = { ...turn.steps[at], label };
			turn.view = undefined;
		} else {
			this.addStep(turn, { id: `p${++this.stepSeq}`, label, mark: 'info', result: '' });
		}
		host.answer(id, back);
		this.post();
	}

	/** The note the turn wrote, read from disk: its file and its frontmatter `status` (gone: none). */
	private readNote(turn: Turn): void {
		const file = turn.noteFile;
		if (!file) {
			return;
		}
		const text = readText(file);
		turn.note = text === null ? null : { file: path.relative(turn.workspace, file).split(path.sep).join('/'), status: designNoteStatus(text) };
		turn.view = undefined;
	}

	private turn(id: string): Turn | undefined {
		return this.turns.find((t) => t.id === id);
	}

	/** Story 8.12: the turn's changes are settled (kept or undone): its snapshots go. */
	private settleReview(turn: Turn, review: 'kept' | 'undone'): void {
		turn.review = review;
		turn.snapshots.clear();
		turn.createdFolders.clear();
		turn.files = turn.files.map((f) => ({ ...f, before: null, after: null }));
		turn.view = undefined;
	}

	/** Story 8.12: Keep: the turn's snapshots dropped, its buttons gone (the rows stay, as text). */
	keep(turnId: string): boolean {
		const turn = this.turn(turnId);
		if (!turn || turn.review !== 'pending') {
			return false;
		}
		this.settleReview(turn, 'kept');
		this.options.log('Assistant: the turn\'s changes kept.');
		this.post();
		return true;
	}

	/**
	 * Story 8.12: Undo: every file restored to its copy from before the turn (a file it created deleted;
	 * one over 1 MB left alone). A file changed since the turn ended asks first. A file that cannot be
	 * restored is an error line in the turn; the others are still restored.
	 */
	async undo(turnId: string): Promise<AssistantUndoOutcome> {
		const turn = this.turn(turnId);
		if (!turn || turn.review !== 'pending') {
			return 'none';
		}
		const files = turn.files.filter((f) => !f.tooLarge);
		const edited = files.filter((f) => readText(f.abs) !== f.after);
		if (edited.length > 0) {
			let go = false;
			try {
				go = await this.ui.confirmUndo(this.mask(undoLaterEditsText(edited.map((f) => f.path))));
			} catch (err) {
				this.options.log(`Assistant: the undo prompt failed: ${this.mask(errorText(err))}`);
			}
			if (!go || turn.review !== 'pending') {
				return 'cancelled';
			}
		}
		const failed: string[] = [];
		for (const f of files) {
			const uri = vscode.Uri.file(f.abs);
			try {
				if (f.before === null) {
					if (fs.existsSync(f.abs)) {
						await vscode.workspace.fs.delete(uri, { useTrash: false });
					}
				} else {
					await vscode.workspace.fs.writeFile(uri, Buffer.from(f.before, 'utf8'));
				}
			} catch (err) {
				failed.push(`${f.path} (${errorText(err)})`);
			}
		}
		// The folders the turn created for its new files go too, where they hold no file now (never a file).
		for (const folder of turn.createdFolders) {
			removeEmptyFolders(folder);
		}
		turn.notice = failed.length > 0 ? `Could not undo ${failed.join('; ')}.` : null;
		this.settleReview(turn, 'undone');
		this.readNote(turn);
		this.options.log(failed.length > 0 ? `Assistant: the turn was undone, except: ${this.mask(failed.join('; '))}` : 'Assistant: the turn was undone.');
		this.post();
		return 'undone';
	}

	/** Story 8.12: the left side of a file row's diff: `/<turn>/<path>` → its copy from before the turn. */
	private beforeContent(uri: vscode.Uri): string {
		const [, turnId, ...rest] = uri.path.split('/');
		const rel = rest.join('/');
		return this.turn(turnId ?? '')?.files.find((f) => f.path === rel)?.before ?? '';
	}

	/** Story 8.12: a file row's diff: its copy from before the turn (empty for a new file) ↔ the file now. */
	async openFileDiff(turnId: string, shown: string): Promise<boolean> {
		const turn = this.turn(turnId);
		const file = turn?.review === 'pending' ? turn.files.find((f) => !f.tooLarge && this.mask(f.path) === shown) : undefined;
		if (!turn || !file) {
			return false;
		}
		if (!fs.existsSync(file.abs)) {
			await this.ui.info(this.mask(`${file.path} no longer exists, so there is no diff to show.`));
			return false;
		}
		const left = vscode.Uri.from({ scheme: BEFORE_SCHEME, path: `/${turn.id}/${file.path}` });
		this.beforeChanged.fire(left);
		try {
			await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(file.abs), `${path.basename(file.abs)} (before the turn) ↔ now`, { preview: true });
			return true;
		} catch (err) {
			this.options.log(`Assistant: could not open the diff of ${this.mask(file.path)}: ${this.mask(errorText(err))}`);
			return false;
		}
	}

	/** Story 8.12: a next-step button (this story: Open note). */
	async turnAction(turnId: string, action: string): Promise<void> {
		const turn = this.turn(turnId);
		if (action === OPEN_NOTE_ACTION && turn?.noteFile && turn.review !== 'undone' && fs.existsSync(turn.noteFile)) {
			await vscode.window.showTextDocument(vscode.Uri.file(turn.noteFile), { preview: false });
		}
	}

	/** Story 8.12: a reply's link: an http(s) page in the browser, a workspace file in the editor; anything else nothing. */
	async openLink(href: string): Promise<LinkTarget> {
		const target = linkTarget(href, this.workspaceFolder());
		if (target?.kind === 'external') {
			await this.ui.openExternal(vscode.Uri.parse(target.url, true));
		} else if (target?.kind === 'file' && fs.existsSync(target.path) && fs.statSync(target.path).isFile()) {
			await vscode.window.showTextDocument(vscode.Uri.file(target.path), { preview: true });
		} else {
			return undefined;
		}
		return target;
	}

	/** Story 8.12: New conversation: a run going is stopped first; then the turns and their snapshots go. */
	async newConversation(): Promise<void> {
		// A run claimed but not yet started has no host to stop: tried again until no run is going.
		while (this.going) {
			const going = this.going;
			this.stop();
			await Promise.race([going, new Promise((r) => setTimeout(r, 100))]);
		}
		this.turns = [];
		this.current = undefined;
		this.closeOpen();
		this.error = null;
		this.status = 'idle';
		this.options.log('Assistant: a new conversation.');
		this.post();
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
