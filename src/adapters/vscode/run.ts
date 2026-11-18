// Run and Stop (AD-13, EXPERIENCE Run control). Each file (AD-1 key) gets one Pseudoterminal,
// "Redpanda Connect: <file name>", reused on re-run, over a child the RedpandaConnect adapter
// spawns with the builder's argv (nothing is typed into a shell). Run auto-saves a dirty file;
// untitled files cannot Run. Stop sends SIGINT, then SIGKILL after a grace period; a second Stop
// while stopping kills at once. One status-bar item follows the active editor's file: Stop while
// running, then the exit status. Ctrl+C in the terminal stops; closing the terminal kills.
// A run the user stopped shows "Pipeline stopped" whatever its exit code (Redpanda Connect exits
// 0 on SIGINT), and a Stop during a re-run's wait cancels the restart (user, 2026-10-07 review).
// The editor-title buttons follow each editor's own file through path lists (`resourcePath in …`,
// which also matches in remote windows); the palette follows the focused editor.
// Ticket 7.2 (AD-25): each run gets a port picked free on 127.0.0.1 (`freePort`) and serves its
// metrics there (`portOf`); `onDidChangeRun` fires when a run starts, stops or changes port. A run
// whose output says `address already in use` within its first seconds (the port was taken between the
// check and the child's bind; Redpanda Connect then runs on without its HTTP server) is restarted once
// with a new free port; a second time, the error is shown and the run goes on.

import * as path from 'path';
import * as vscode from 'vscode';
import { ArgsResult, buildRunCommand, describeArgsFailure } from '../redpandaConnect/args';
import { BinaryState } from '../redpandaConnect/binary';
import { runStreaming, StreamingChild, StreamingExit } from '../redpandaConnect/process';
import { activeSecretValues } from '../redpandaConnect/secretEnv';
import { freePort } from '../metrics/source';
import { isCloudSecretName } from '../../core/envUsage';
import { isEnvName } from '../../shared/bloblangProtocol';
import { SET_MISSING_COMMAND } from './environmentView';

export const RUN_COMMAND = 'redpandaConnect.run';
export const STOP_COMMAND = 'redpandaConnect.stop';
export const RUN_UNTITLED_COMMAND = 'redpandaConnect.runUntitled';
export const REVEAL_RUN_COMMAND = 'redpandaConnect.revealRun';
export const ACTIVE_DETECTED_KEY = 'redpandaConnect.activeEditorDetected';
export const ACTIVE_RUNNING_KEY = 'redpandaConnect.activeEditorRunning';
/** `fsPath`s of detected files, for the editor-title `resourcePath in …` clauses. */
export const DETECTED_PATHS_KEY = 'redpandaConnect.detectedPaths';

export const UNTITLED_MESSAGE = 'Save the file to run it.';
export const NOT_DETECTED_MESSAGE = 'This file is not a Redpanda Connect config.';
export const NOT_ON_DISK_MESSAGE = 'Run needs a file on disk.';
/** Ticket 46: the refusal's button. */
export const SET_VARIABLES_ACTION = 'Set…';

/**
 * Ticket 46: the refusal for a run that would stop on unset variables (names only, never a value).
 * A `${secrets.NAME}` is said to be set only by Redpanda Cloud.
 */
export function unsetVariablesMessage(fileName: string, names: readonly string[]): string {
	const cloud = names.filter(isCloudSecretName);
	const list = names.join(', ');
	const head = names.length === 1
		? `Can't run ${fileName}: the environment variable ${list} is not set.`
		: `Can't run ${fileName}: the environment variables ${list} are not set.`;
	return cloud.length === 0 ? head : `${head} Only Redpanda Cloud sets ${cloud.join(', ')}: a local Run cannot.`;
}
/** Ticket 46: a further Run's message while a refusal for the file is open (names only, no button). */
export function unsetVariablesReminder(fileName: string, names: readonly string[]): string {
	return `Can't run ${fileName}: ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not set. Use the open message, or set them from the Environment view.`;
}
/** SIGINT, then SIGKILL after this long (user decision 2026-10-07, ticket 2.7). */
export const STOP_GRACE_MS = 10_000;
/** Ticket 7.2: how long after the start a bind failure in the output restarts the run with a new port. */
export const BIND_WINDOW_MS = 10_000;
/**
 * Ticket 7.2: what Redpanda Connect writes when its HTTP server cannot bind the run's metrics port
 * (`HTTP Server error: listen tcp 127.0.0.1:<port>: bind: address already in use`). Another address's
 * bind error (a component's own server) is not the metrics port's.
 */
export function addressInUse(port: number): RegExp {
	return new RegExp(`127\\.0\\.0\\.1:${port}(?!\\d)[^\\n]*address already in use`, 'i');
}

/** Ticket 7.2: the error shown when a run's metrics port was taken twice. */
export function portTakenMessage(fileName: string, port: number): string {
	return `${fileName} runs without metrics: 127.0.0.1:${port} was already in use, also after a restart with another port.`;
}

/** Ticket 7.2: a run's change, as `onDidChangeRun` gives it. */
export interface RunChange {
	/** The file's URI string (AD-1 key). */
	readonly uri: string;
	readonly phase: RunPhase | undefined;
	/** The metrics port while the run lives. */
	readonly port: number | undefined;
}

export const terminalName = (fsPath: string) => `Redpanda Connect: ${path.basename(fsPath)}`;

/** The status-bar text for a run; `stopped` when the user stopped it. */
export function statusText(phase: RunPhase, exit: StreamingExit | undefined, stopped = false): string {
	switch (phase) {
		case 'running':
			return '$(debug-stop) Stop pipeline';
		case 'stopping':
			return '$(loading~spin) Stopping…';
		case 'exited':
			if (!exit || exit.kind !== 'exited') {
				return '$(error) Pipeline failed to start';
			}
			if (stopped || exit.exitCode === null) {
				return '$(circle-slash) Pipeline stopped';
			}
			return exit.exitCode === 0 ? '$(pass) Pipeline exited (code 0)' : `$(error) Pipeline exited (code ${exit.exitCode})`;
	}
}

/** The terminal's last line for `exit`; `stopped` when the user stopped it. */
export function exitLine(exit: StreamingExit, stopped = false): string {
	switch (exit.kind) {
		case 'exited':
			if (stopped && exit.exitCode !== null) {
				return `Redpanda Connect stopped (exit code ${exit.exitCode}).`;
			}
			return exit.exitCode === null
				? `Redpanda Connect stopped by ${exit.signal ?? 'a signal'}.`
				: `Redpanda Connect exited with code ${exit.exitCode}.`;
		case 'notFound':
			return 'Could not start Redpanda Connect: the binary was not found.';
		case 'spawnError':
			return `Could not start Redpanda Connect: ${exit.message}`;
	}
}

export type RunPhase = 'running' | 'stopping' | 'exited';

/** What the controller needs from the binary owner. */
export interface RunBinary {
	readonly state: BinaryState;
	/** Resolves the binary (single-flight); used when Run is clicked before the first resolution. */
	refresh(): PromiseLike<BinaryState>;
	showBinaryWarning(): boolean;
}

export interface RunDetection {
	isDetected(uri: string | vscode.Uri): boolean;
	detectedUris(): string[];
	readonly onDidChangeDetection: vscode.Event<{ readonly uri: string; readonly detected: boolean }>;
}

/** The slice of the VS Code API the controller uses (tests pass fakes). */
export interface RunHost {
	createTerminal(options: vscode.ExtensionTerminalOptions): vscode.Terminal;
	createStatusBarItem(): vscode.StatusBarItem;
	activeDocument(): vscode.TextDocument | undefined;
	readonly onDidChangeActiveTextEditor: vscode.Event<unknown>;
	findDocument(uri: vscode.Uri): vscode.TextDocument | undefined;
	showInformationMessage(message: string): void;
	showErrorMessage(message: string): void;
	setContext(key: string, value: boolean | string[]): void;
	/** Working directory for a run of `uri`: its workspace folder, else its directory. */
	cwdFor(uri: vscode.Uri): string;
	/** Ticket 46: an error with one button; resolves with the button chosen (default: VS Code's). */
	showErrorPrompt?(message: string, action: string): Thenable<string | undefined>;
	/** Ticket 46: sets one variable for `uri`'s folder; resolves with the name set, `undefined` when none was (default: `SET_MISSING_COMMAND`). */
	setVariable?(name: string, uri: vscode.Uri): Thenable<string | undefined>;
}

export interface RunOptions {
	readonly binary: RunBinary;
	readonly detection: RunDetection;
	readonly log: (line: string) => void;
	readonly host?: RunHost;
	/** The run's command line; `httpPort` is the port picked for its metrics (ticket 7.2). */
	readonly build?: (state: BinaryState, fsPath: string, httpPort: number | undefined) => ArgsResult;
	readonly spawn?: typeof runStreaming;
	/** Ticket 7.2: a port free on 127.0.0.1 (default: `freePort`); a rejection runs without metrics. */
	readonly freePort?: () => Promise<number>;
	readonly graceMs?: number;
	/** Ticket 46: the variables a run of `uri` would stop on (none: no check). */
	readonly unsetVariables?: (uri: vscode.Uri) => readonly string[];
}

/** How much of a run's output `outputOf` keeps (ticket 9). */
const TRANSCRIPT_LIMIT = 65_536;

/** A Pseudoterminal that buffers writes until VS Code opens it and reports Ctrl+C and close. */
class RunPty implements vscode.Pseudoterminal {
	private readonly writer = new vscode.EventEmitter<string>();
	private readonly pending: string[] = [];
	private opened = false;
	/** What was written, as given, in chunks (test seam, ticket 9: a terminal's content can't be read through the API). */
	private readonly chunks: string[] = [];
	private chunkLength = 0;
	readonly onDidWrite = this.writer.event;

	/** The last 64 KiB written; kept in chunks, trimmed only when over twice that, so a write stays cheap. */
	get transcript(): string {
		return this.chunks.join('').slice(-TRANSCRIPT_LIMIT);
	}

	constructor(private readonly onInterrupt: () => void, private readonly onClosed: () => void) {}

	open(): void {
		this.opened = true;
		for (const text of this.pending.splice(0)) {
			this.writer.fire(text);
		}
	}

	close(): void {
		this.onClosed();
		this.writer.dispose();
	}

	handleInput(data: string): void {
		if (data.includes('\x03')) {
			this.onInterrupt();
		}
	}

	/** Writes `text` with `\n` as `\r\n` (a terminal needs both). */
	write(text: string): void {
		this.chunks.push(text);
		this.chunkLength += text.length;
		if (this.chunkLength > 2 * TRANSCRIPT_LIMIT) {
			const kept = this.chunks.join('').slice(-TRANSCRIPT_LIMIT);
			this.chunks.splice(0, this.chunks.length, kept);
			this.chunkLength = kept.length;
		}
		const converted = text.replace(/\r?\n/g, '\r\n');
		if (this.opened) {
			this.writer.fire(converted);
		} else {
			this.pending.push(converted);
		}
	}
}

interface Session {
	readonly key: string;
	readonly fsPath: string;
	terminal?: vscode.Terminal;
	pty?: RunPty;
	child?: StreamingChild;
	phase?: RunPhase;
	exit?: StreamingExit;
	/** A Run is being prepared (save, stop of the previous run); further Runs are ignored. */
	busy: boolean;
	/** The user stopped the current run (Stop, Ctrl+C, closing the terminal, a re-run). */
	stopRequested: boolean;
	/** A Stop or close during a re-run's wait: the restart is cancelled. */
	restartCancelled: boolean;
	/** Ticket 7.2: the 127.0.0.1 port the current child serves its metrics on. */
	port?: number;
}

export function defaultRunHost(): RunHost {
	return {
		createTerminal: (options) => vscode.window.createTerminal(options),
		createStatusBarItem: () => vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50),
		activeDocument: () => vscode.window.activeTextEditor?.document,
		onDidChangeActiveTextEditor: vscode.window.onDidChangeActiveTextEditor,
		findDocument: (uri) => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()),
		// Ticket 30: loaded secret values are masked in messages.
		showInformationMessage: (message) => { void vscode.window.showInformationMessage(activeSecretValues()?.mask(message) ?? message); },
		showErrorMessage: (message) => { void vscode.window.showErrorMessage(activeSecretValues()?.mask(message) ?? message); },
		setContext: (key, value) => { void vscode.commands.executeCommand('setContext', key, value); },
		cwdFor: (uri) => vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath),
	};
}

export class RunController implements vscode.Disposable {
	private readonly sessions = new Map<string, Session>();
	/** Ticket 46: the files whose unset-variables refusal (or its Set… chain) is open. */
	private readonly refusing = new Set<string>();
	private readonly host: RunHost;
	private readonly status: vscode.StatusBarItem;
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly graceMs: number;
	/** Whether the status bar item is shown (`statusBarText`). */
	private statusShown = false;
	private disposed = false;
	private readonly runChanged = new vscode.EventEmitter<RunChange>();
	/** Ticket 7.2: a run started, stopped or got another port. */
	readonly onDidChangeRun = this.runChanged.event;

	constructor(private readonly options: RunOptions) {
		this.host = options.host ?? defaultRunHost();
		this.graceMs = options.graceMs ?? STOP_GRACE_MS;
		this.status = this.host.createStatusBarItem();
		this.subscriptions.push(
			this.status,
			this.runChanged,
			this.host.onDidChangeActiveTextEditor(() => this.refreshUi()),
			options.detection.onDidChangeDetection(() => this.refreshUi()),
		);
		this.refreshUi();
	}

	/** Registers the commands (Run, Stop, the disabled untitled entry, reveal). */
	registerCommands(): vscode.Disposable[] {
		return [
			vscode.commands.registerCommand(RUN_COMMAND, (uri?: vscode.Uri) => this.run(uri)),
			vscode.commands.registerCommand(STOP_COMMAND, (uri?: vscode.Uri) => this.stop(uri)),
			vscode.commands.registerCommand(RUN_UNTITLED_COMMAND, () => this.host.showInformationMessage(UNTITLED_MESSAGE)),
			vscode.commands.registerCommand(REVEAL_RUN_COMMAND, (uri?: vscode.Uri) => this.reveal(uri)),
		];
	}

	/** What `uri`'s run terminal was given to show, its last 64 KiB; `undefined` before its first run (test seam, ticket 9). */
	outputOf(uri: vscode.Uri): string | undefined {
		return this.sessions.get(uri.toString())?.pty?.transcript;
	}

	/** The status bar item's text while it is shown (the active file's run); `undefined` while hidden (test seam, ticket 9). */
	get statusBarText(): string | undefined {
		return this.statusShown ? this.status.text : undefined;
	}

	/** The phase of `uri`'s run, or `undefined` if it has not run this session (tests, epic 3). */
	phaseOf(uri: vscode.Uri): RunPhase | undefined {
		return this.sessions.get(uri.toString())?.phase;
	}

	/** Ticket 7.2: the 127.0.0.1 port `uri`'s run serves its metrics on, while it runs (or stops). */
	portOf(uri: vscode.Uri | string): number | undefined {
		const session = this.sessions.get(uri.toString());
		return session?.phase === 'running' || session?.phase === 'stopping' ? session.port : undefined;
	}

	/** Runs `uri` (default: the active editor's file). Never throws. */
	async run(uri?: vscode.Uri): Promise<void> {
		try {
			const doc = uri ? this.host.findDocument(uri) : this.host.activeDocument();
			if (!doc) {
				this.options.log(`Run: ${uri ? `${uri.toString()} is not open` : 'no active editor'}.`);
				return;
			}
			if (doc.isUntitled) {
				this.host.showInformationMessage(UNTITLED_MESSAGE);
				return;
			}
			if (doc.uri.scheme !== 'file') {
				this.host.showInformationMessage(NOT_ON_DISK_MESSAGE);
				return;
			}
			if (!this.options.detection.isDetected(doc.uri)) {
				this.host.showInformationMessage(NOT_DETECTED_MESSAGE);
				return;
			}
			const session = this.session(doc.uri);
			if (session.busy) {
				this.options.log(`Run ${path.basename(session.fsPath)}: already starting; ignored.`);
				return;
			}
			session.busy = true;
			try {
				await this.start(session, doc);
			} finally {
				session.busy = false;
			}
		} catch (err) {
			this.options.log(`Run failed: ${String(err)}`);
		}
	}

	/** Stops `uri`'s run (default: the active editor's file); a second Stop kills. Never throws. */
	stop(uri?: vscode.Uri): void {
		const key = (uri ?? this.host.activeDocument()?.uri)?.toString();
		const session = key ? this.sessions.get(key) : undefined;
		if (!session?.child) {
			return;
		}
		if (session.busy) {
			session.restartCancelled = true; // a Stop during a re-run's wait cancels the restart
		}
		if (session.phase === 'running' || session.phase === 'stopping') {
			session.stopRequested = true;
		}
		if (session.phase === 'running') {
			session.phase = 'stopping';
			void session.child.stop(this.graceMs);
			this.fireChange(session);
		} else if (session.phase === 'stopping') {
			session.child.kill('SIGKILL');
		}
		this.refreshUi();
	}

	private fireChange(session: Session): void {
		if (!this.disposed) {
			this.runChanged.fire({ uri: session.key, phase: session.phase, port: this.portOf(session.key) });
		}
	}

	/** Ticket 7.2: a free port, or none (the run then goes without metrics; logged). */
	private async pickPort(name: string): Promise<number | undefined> {
		try {
			return await (this.options.freePort ?? freePort)();
		} catch (err) {
			this.options.log(`Run ${name}: no free port for its metrics (${String(err)}); running without them.`);
			return undefined;
		}
	}

	private buildFor(state: BinaryState, fsPath: string, port: number | undefined): ArgsResult {
		return (this.options.build ?? ((s, p, httpPort) => buildRunCommand(s, { targets: [p], httpPort })))(state, fsPath, port);
	}

	dispose(): void {
		this.disposed = true;
		this.runChanged.dispose();
		for (const session of this.sessions.values()) {
			session.child?.kill('SIGKILL');
			session.terminal?.dispose();
		}
		this.sessions.clear();
		for (const d of this.subscriptions.splice(0)) {
			d.dispose();
		}
	}

	private session(uri: vscode.Uri): Session {
		const key = uri.toString();
		let session = this.sessions.get(key);
		if (!session) {
			session = { key, fsPath: uri.fsPath, busy: false, stopRequested: false, restartCancelled: false };
			this.sessions.set(key, session);
		}
		return session;
	}

	private async start(session: Session, doc: vscode.TextDocument): Promise<void> {
		const name = path.basename(session.fsPath);
		if (doc.isDirty && !(await doc.save())) {
			this.options.log(`Run ${name}: the file could not be saved; not running.`);
			return;
		}
		let state = this.options.binary.state;
		if (state.kind === 'unresolved') {
			state = await this.options.binary.refresh(); // clicked before the first resolution finished
		}
		if (state.kind !== 'ok') {
			this.options.log(`Run ${name}: no usable Redpanda Connect binary.`);
			this.options.binary.showBinaryWarning();
			return;
		}
		const port = await this.pickPort(name);
		const built = this.buildFor(state, session.fsPath, port);
		if (built.kind !== 'ok') {
			const message = describeArgsFailure(built);
			this.options.log(`Run ${name}: ${message}`);
			this.host.showErrorMessage(`Can't run ${name}: ${message}`);
			return;
		}
		// Ticket 46: a run that would stop on unset variables does not start.
		const unset = this.options.unsetVariables?.(doc.uri) ?? [];
		if (unset.length > 0) {
			this.options.log(`Run ${name}: not started; environment variables not set: ${unset.join(', ')}.`);
			// One refusal (and Set… chain) per file at a time: a further Run while it is open (it may sit in
			// the notification center) gets a plain message with no button.
			if (this.refusing.has(session.key)) {
				this.host.showErrorMessage(unsetVariablesReminder(name, unset));
			} else {
				this.refusing.add(session.key);
				void this.refuseUnset(doc.uri, name, unset).finally(() => this.refusing.delete(session.key));
			}
			return;
		}
		// Run while running: stop the current run (same grace), then start again in the same terminal.
		session.restartCancelled = false;
		if (session.child && (session.phase === 'running' || session.phase === 'stopping')) {
			const previous = session.child;
			session.stopRequested = true;
			if (session.phase === 'running') {
				session.phase = 'stopping';
				this.refreshUi();
			}
			await previous.stop(this.graceMs);
		}
		if (this.disposed || session.restartCancelled) {
			return;
		}
		this.launch(session, doc, built, port, state);
	}

	/**
	 * Spawns `built` in the session's terminal. With `rebindState` (the first try), a bind failure in
	 * the output within `BIND_WINDOW_MS` restarts the run once with a new free port (ticket 7.2).
	 */
	private launch(session: Session, doc: vscode.TextDocument, built: ArgsResult & { readonly kind: 'ok' }, port: number | undefined, rebindState: BinaryState | undefined): void {
		const name = path.basename(session.fsPath);
		const pty = this.terminalFor(session);
		pty.write(`\x1b[2m$ ${[built.command, ...built.args].map(shellQuote).join(' ')}\x1b[0m\n`);
		const spawn = this.options.spawn ?? runStreaming;
		const startedAt = Date.now();
		let early = '';
		const inUse = port === undefined ? undefined : addressInUse(port);
		/** The bind failure was seen: the run is being restarted (or the error shown). */
		let bindFailed = false;
		// Declared before the spawn: a handler called during it sees no child yet.
		let child: StreamingChild | undefined;
		const onOutput = (chunk: string) => {
			pty.write(chunk);
			if (port === undefined || bindFailed || Date.now() - startedAt > BIND_WINDOW_MS) {
				return;
			}
			early = (early + chunk).slice(-4096);
			if (!child || !inUse?.test(early) || session.child !== child) {
				return;
			}
			bindFailed = true;
			if (rebindState) {
				void this.rebind(session, doc, child, port, rebindState);
			} else {
				this.options.log(`Run ${name}: 127.0.0.1:${port} was in use again; running without metrics.`);
				this.host.showErrorMessage(portTakenMessage(name, port));
			}
		};
		const spawned = spawn([built.command], built.args, { onStdout: onOutput, onStderr: onOutput },
			{ env: built.env, cwd: this.host.cwdFor(doc.uri) });
		child = spawned;
		session.child = spawned;
		session.port = port;
		session.phase = 'running';
		session.exit = undefined;
		session.stopRequested = false;
		this.refreshUi();
		this.fireChange(session);
		void spawned.exited.then((exit) => {
			// A child being replaced by `rebind` ends without a phase change (unless the user stopped it).
			if (session.child !== spawned || (bindFailed && rebindState && !session.stopRequested)) {
				return;
			}
			this.exited(session, exit);
		});
	}

	private exited(session: Session, exit: StreamingExit): void {
		session.phase = 'exited';
		session.exit = exit;
		session.pty?.write(`${exitLine(exit, session.stopRequested)}\n`);
		if (exit.kind !== 'exited') {
			this.options.log(`Run ${path.basename(session.fsPath)}: ${exitLine(exit)}`);
		}
		this.refreshUi();
		this.fireChange(session);
	}

	/** Ticket 7.2: stops `old` (its port was taken) and runs the file again once, with a new free port. */
	private async rebind(session: Session, doc: vscode.TextDocument, old: StreamingChild, port: number, state: BinaryState): Promise<void> {
		const name = path.basename(session.fsPath);
		this.options.log(`Run ${name}: 127.0.0.1:${port} was already in use; restarting with another port.`);
		session.pty?.write(`\x1b[2m127.0.0.1:${port} was already in use; restarting with another port.\x1b[0m\n`);
		const exit = await old.stop(this.graceMs);
		if (this.disposed || session.child !== old || session.stopRequested) {
			return; // stopped, closed or run again meanwhile: that path took over
		}
		const next = await this.pickPort(name);
		const built = this.buildFor(state, session.fsPath, next);
		if (this.disposed || session.child !== old || session.stopRequested || built.kind !== 'ok') {
			if (session.child === old && !this.disposed) {
				if (built.kind !== 'ok') {
					this.host.showErrorMessage(`Can't run ${name}: ${describeArgsFailure(built)}`);
				}
				this.exited(session, exit);
			}
			return;
		}
		this.launch(session, doc, built, next, undefined);
	}

	/** Ticket 46: names the unset variables; "Set…" (when one is a name the settings take) sets each in turn; Escape, or a variable still unset after its set, stops. */
	private async refuseUnset(uri: vscode.Uri, name: string, unset: readonly string[]): Promise<void> {
		try {
			const message = unsetVariablesMessage(name, unset);
			const settable = unset.filter(isEnvName);
			if (settable.length === 0) {
				this.host.showErrorMessage(message);
				return;
			}
			const prompt = this.host.showErrorPrompt?.bind(this.host)
				?? ((m: string, a: string) => vscode.window.showErrorMessage(m, a));
			if (await prompt(message, SET_VARIABLES_ACTION) !== SET_VARIABLES_ACTION) {
				return;
			}
			const set = this.host.setVariable?.bind(this.host)
				?? ((n: string, u: vscode.Uri) => vscode.commands.executeCommand<string | undefined>(SET_MISSING_COMMAND, n, u));
			const stillUnset = () => this.options.unsetVariables?.(uri) ?? [];
			for (const variable of settable) {
				if (!stillUnset().includes(variable)) {
					continue; // set meanwhile
				}
				// A secret's prefilled name can be edited: the chain goes on only once this variable is set.
				if (await set(variable, uri) === undefined || stillUnset().includes(variable)) {
					return;
				}
			}
		} catch (err) {
			this.options.log(`Run ${name}: ${String(err)}`);
		}
	}

	/** The session's open terminal, or a new one (also after the user closed it). */
	private terminalFor(session: Session): RunPty {
		if (session.terminal && session.pty) {
			session.terminal.show(true);
			return session.pty;
		}
		const pty: RunPty = new RunPty(() => this.stop(vscode.Uri.parse(session.key)), () => {
			if (session.pty !== pty || this.disposed) {
				return; // dispose() kills the child itself
			}
			// Closing the terminal ends its run.
			session.terminal = undefined;
			session.pty = undefined;
			if (session.busy) {
				session.restartCancelled = true;
			}
			if (session.phase === 'running' || session.phase === 'stopping') {
				session.stopRequested = true;
				session.child?.kill('SIGKILL');
			}
		});
		session.pty = pty;
		session.terminal = this.host.createTerminal({ name: terminalName(session.fsPath), pty });
		session.terminal.show(true);
		return pty;
	}

	private reveal(uri?: vscode.Uri): void {
		const key = (uri ?? this.host.activeDocument()?.uri)?.toString();
		const session = key ? this.sessions.get(key) : undefined;
		session?.terminal?.show(false);
	}

	/** Context keys and the status item, for the active editor's file. */
	private refreshUi(): void {
		if (this.disposed) {
			return;
		}
		const doc = this.host.activeDocument();
		const session = doc ? this.sessions.get(doc.uri.toString()) : undefined;
		this.host.setContext(ACTIVE_DETECTED_KEY, !!doc && this.options.detection.isDetected(doc.uri));
		const running = session?.phase === 'running' || session?.phase === 'stopping';
		this.host.setContext(ACTIVE_RUNNING_KEY, running);
		this.host.setContext(DETECTED_PATHS_KEY, this.options.detection.detectedUris().map((u) => vscode.Uri.parse(u).fsPath));
		if (!session?.phase) {
			this.status.hide();
			this.statusShown = false;
			return;
		}
		this.status.text = statusText(session.phase, session.exit, session.stopRequested);
		const uri = vscode.Uri.parse(session.key);
		if (running) {
			this.status.tooltip = session.phase === 'running'
				? `Stop ${path.basename(session.fsPath)} (interrupt)`
				: `Stopping ${path.basename(session.fsPath)}; click to kill it now`;
			this.status.command = { title: 'Stop', command: STOP_COMMAND, arguments: [uri] };
		} else {
			this.status.tooltip = `Show the terminal for ${path.basename(session.fsPath)}`;
			this.status.command = { title: 'Show terminal', command: REVEAL_RUN_COMMAND, arguments: [uri] };
		}
		this.status.show();
		this.statusShown = true;
	}
}

/** Quotes an argument for the `$ …` display line only (nothing is ever run through a shell). */
function shellQuote(arg: string): string {
	return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
