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

import * as path from 'path';
import * as vscode from 'vscode';
import { ArgsResult, buildRunCommand, describeArgsFailure } from '../redpandaConnect/args';
import { BinaryState } from '../redpandaConnect/binary';
import { runStreaming, StreamingChild, StreamingExit } from '../redpandaConnect/process';

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
/** SIGINT, then SIGKILL after this long (user decision 2026-10-07, ticket 2.7). */
export const STOP_GRACE_MS = 10_000;

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
}

export interface RunOptions {
	readonly binary: RunBinary;
	readonly detection: RunDetection;
	readonly log: (line: string) => void;
	readonly host?: RunHost;
	readonly build?: (state: BinaryState, fsPath: string) => ArgsResult;
	readonly spawn?: typeof runStreaming;
	readonly graceMs?: number;
}

/** A Pseudoterminal that buffers writes until VS Code opens it and reports Ctrl+C and close. */
class RunPty implements vscode.Pseudoterminal {
	private readonly writer = new vscode.EventEmitter<string>();
	private readonly pending: string[] = [];
	private opened = false;
	readonly onDidWrite = this.writer.event;

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
}

export function defaultRunHost(): RunHost {
	return {
		createTerminal: (options) => vscode.window.createTerminal(options),
		createStatusBarItem: () => vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50),
		activeDocument: () => vscode.window.activeTextEditor?.document,
		onDidChangeActiveTextEditor: vscode.window.onDidChangeActiveTextEditor,
		findDocument: (uri) => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()),
		showInformationMessage: (message) => { void vscode.window.showInformationMessage(message); },
		showErrorMessage: (message) => { void vscode.window.showErrorMessage(message); },
		setContext: (key, value) => { void vscode.commands.executeCommand('setContext', key, value); },
		cwdFor: (uri) => vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath),
	};
}

export class RunController implements vscode.Disposable {
	private readonly sessions = new Map<string, Session>();
	private readonly host: RunHost;
	private readonly status: vscode.StatusBarItem;
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly graceMs: number;
	private disposed = false;

	constructor(private readonly options: RunOptions) {
		this.host = options.host ?? defaultRunHost();
		this.graceMs = options.graceMs ?? STOP_GRACE_MS;
		this.status = this.host.createStatusBarItem();
		this.subscriptions.push(
			this.status,
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

	/** The phase of `uri`'s run, or `undefined` if it has not run this session (tests, epic 3). */
	phaseOf(uri: vscode.Uri): RunPhase | undefined {
		return this.sessions.get(uri.toString())?.phase;
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
		} else if (session.phase === 'stopping') {
			session.child.kill('SIGKILL');
		}
		this.refreshUi();
	}

	dispose(): void {
		this.disposed = true;
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
		const built = (this.options.build ?? ((s, p) => buildRunCommand(s, { targets: [p] })))(state, session.fsPath);
		if (built.kind !== 'ok') {
			const message = describeArgsFailure(built);
			this.options.log(`Run ${name}: ${message}`);
			this.host.showErrorMessage(`Can't run ${name}: ${message}`);
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
		const pty = this.terminalFor(session);
		pty.write(`\x1b[2m$ ${[built.command, ...built.args].map(shellQuote).join(' ')}\x1b[0m\n`);
		const spawn = this.options.spawn ?? runStreaming;
		const child = spawn([built.command], built.args, { onStdout: (c) => pty.write(c), onStderr: (c) => pty.write(c) },
			{ env: built.env, cwd: this.host.cwdFor(doc.uri) });
		session.child = child;
		session.phase = 'running';
		session.exit = undefined;
		session.stopRequested = false;
		this.refreshUi();
		void child.exited.then((exit) => {
			if (session.child !== child) {
				return;
			}
			session.phase = 'exited';
			session.exit = exit;
			session.pty?.write(`${exitLine(exit, session.stopRequested)}\n`);
			if (exit.kind !== 'exited') {
				this.options.log(`Run ${name}: ${exitLine(exit)}`);
			}
			this.refreshUi();
		});
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
	}
}

/** Quotes an argument for the `$ …` display line only (nothing is ever run through a shell). */
function shellQuote(arg: string): string {
	return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
