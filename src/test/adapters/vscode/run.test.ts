import * as assert from 'assert';
import * as vscode from 'vscode';
import { ArgsResult } from '../../../adapters/redpandaConnect/args';
import { BinaryState } from '../../../adapters/redpandaConnect/binary';
import { SpawnOptions, StreamingChild, StreamingExit, StreamingHandlers } from '../../../adapters/redpandaConnect/process';
import {
	ACTIVE_DETECTED_KEY, ACTIVE_RUNNING_KEY, DETECTED_PATHS_KEY, exitLine, NOT_DETECTED_MESSAGE, NOT_ON_DISK_MESSAGE, RunController, RunHost,
	STOP_GRACE_MS, statusText, UNTITLED_MESSAGE,
} from '../../../adapters/vscode/run';

const BIN = '/bin/redpanda-connect';
const OK: BinaryState = { kind: 'ok', path: BIN, version: '4.112.0', invocation: [BIN] };

class FakeChild implements StreamingChild {
	readonly signals: string[] = [];
	readonly stops: number[] = [];
	private resolveExit!: (e: StreamingExit) => void;
	readonly exited = new Promise<StreamingExit>((r) => { this.resolveExit = r; });
	/** Whether the child exits on SIGINT (else only on SIGKILL, which `stop` sends after the grace, like the real one). */
	constructor(readonly handlers: StreamingHandlers, readonly spawnOptions: SpawnOptions, private readonly honoursInt = true,
		private readonly intDelayMs = 0) {}
	kill(signal: NodeJS.Signals = 'SIGTERM'): void {
		this.signals.push(signal);
		if (signal === 'SIGKILL' || signal === 'SIGTERM') {
			this.end({ kind: 'exited', exitCode: null, signal });
		}
	}
	stop(graceMs: number): Promise<StreamingExit> {
		this.stops.push(graceMs);
		this.signals.push('SIGINT');
		if (this.honoursInt) {
			setTimeout(() => this.end({ kind: 'exited', exitCode: 0, signal: null }), this.intDelayMs);
		} else {
			const timer = setTimeout(() => this.kill('SIGKILL'), graceMs);
			void this.exited.then(() => clearTimeout(timer));
		}
		return this.exited;
	}
	end(exit: StreamingExit): void {
		this.resolveExit(exit);
	}
}

interface FakeTerminal { name: string; pty: vscode.Pseudoterminal; shown: number; disposed: boolean; output: string }

function fakeDoc(name: string, options: { untitled?: boolean; dirty?: boolean; saveOk?: boolean } = {}) {
	const uri = options.untitled ? vscode.Uri.parse(`untitled:${name}`) : vscode.Uri.file(`/ws/${name}`);
	const doc = {
		uri, isUntitled: !!options.untitled, isDirty: !!options.dirty, saves: 0,
		save: async () => { doc.saves++; doc.isDirty = false; return options.saveOk ?? true; },
	};
	return doc;
}
type FakeDoc = ReturnType<typeof fakeDoc>;

const tick = () => new Promise((r) => setTimeout(r, 10));

suite('adapters/vscode RunController', () => {
	let docs: FakeDoc[];
	let active: FakeDoc | undefined;
	let terminals: FakeTerminal[];
	let children: FakeChild[];
	let contexts: Map<string, boolean | string[]>;
	let intDelayMs: number;
	let deferOpen: boolean;
	let refreshes: number;
	let refreshTo: BinaryState;
	let infos: string[];
	let errors: string[];
	let logs: string[];
	let warnings: number;
	let state: BinaryState;
	let detected: Set<string>;
	let honoursInt: boolean;
	let status: { text: string; tooltip?: string; command?: vscode.Command; visible: boolean };
	let built: (s: BinaryState, p: string) => ArgsResult;
	const activeChange = new vscode.EventEmitter<unknown>();
	const detectionChange = new vscode.EventEmitter<{ uri: string; detected: boolean }>();
	let controller: RunController;

	function make(): void {
		const host: RunHost = {
			createTerminal: (options) => {
				const t: FakeTerminal = { name: options.name, pty: options.pty, shown: 0, disposed: false, output: '' };
				options.pty.onDidWrite((text) => { t.output += text; });
				if (deferOpen) {
					setTimeout(() => options.pty.open(undefined), 5); // VS Code opens the pty later
				} else {
					options.pty.open(undefined);
				}
				terminals.push(t);
				return {
					name: options.name,
					show: () => { t.shown++; },
					dispose: () => { t.disposed = true; options.pty.close(); },
				} as unknown as vscode.Terminal;
			},
			createStatusBarItem: () => ({
				get text() { return status.text; }, set text(v: string) { status.text = v; },
				get tooltip() { return status.tooltip; }, set tooltip(v) { status.tooltip = v as string; },
				get command() { return status.command; }, set command(v) { status.command = v as vscode.Command; },
				show: () => { status.visible = true; }, hide: () => { status.visible = false; }, dispose: () => undefined,
			}) as unknown as vscode.StatusBarItem,
			activeDocument: () => active as unknown as vscode.TextDocument,
			onDidChangeActiveTextEditor: activeChange.event,
			findDocument: (uri) => docs.find((d) => d.uri.toString() === uri.toString()) as unknown as vscode.TextDocument,
			showInformationMessage: (m) => { infos.push(m); },
			showErrorMessage: (m) => { errors.push(m); },
			setContext: (k, v) => { contexts.set(k, v); },
			cwdFor: () => '/ws',
		};
		controller = new RunController({
			binary: {
				get state() { return state; },
				refresh: async () => { refreshes++; state = refreshTo; return state; },
				showBinaryWarning: () => { warnings++; return true; },
			},
			detection: {
				isDetected: (u) => detected.has(u.toString()), detectedUris: () => [...detected],
				onDidChangeDetection: detectionChange.event,
			},
			log: (l) => logs.push(l),
			host,
			build: (s, p) => built(s, p),
			spawn: (invocation, args, handlers, options) => {
				const child = new FakeChild(handlers ?? {}, options ?? {}, honoursInt, intDelayMs);
				children.push(child);
				return child;
			},
			graceMs,
		});
	}
	let graceMs: number | undefined;

	setup(() => {
		docs = [fakeDoc('a.yaml'), fakeDoc('b.yaml')];
		active = docs[0];
		terminals = [];
		children = [];
		contexts = new Map();
		infos = [];
		errors = [];
		logs = [];
		warnings = 0;
		state = OK;
		detected = new Set(docs.map((d) => d.uri.toString()));
		honoursInt = true;
		intDelayMs = 0;
		deferOpen = false;
		refreshes = 0;
		refreshTo = OK;
		graceMs = 50;
		status = { text: '', visible: false };
		built = (_s, p) => ({ kind: 'ok', command: BIN, args: ['run', '--set', 'http.enabled=false', p], env: { NO_COLOR: '1', FOO: 'x' } });
		make();
	});

	teardown(() => controller.dispose());

	test('RUN: terminal named after the file, $ line, streamed output, Stop in the status bar, context keys', async () => {
		await controller.run();
		assert.strictEqual(terminals.length, 1);
		assert.strictEqual(terminals[0].name, 'Redpanda Connect: a.yaml');
		assert.deepStrictEqual(children[0].spawnOptions, { env: { NO_COLOR: '1', FOO: 'x' }, cwd: '/ws' });
		children[0].handlers.onStdout?.('tick\n');
		children[0].handlers.onStderr?.('level=info msg=x\n');
		assert.strictEqual(terminals[0].output,
			`\x1b[2m$ ${BIN} run --set http.enabled=false /ws/a.yaml\x1b[0m\r\ntick\r\nlevel=info msg=x\r\n`);
		assert.deepStrictEqual([status.text, status.visible, status.command?.command], ['$(debug-stop) Stop pipeline', true, 'redpandaConnect.stop']);
		assert.strictEqual(contexts.get(ACTIVE_DETECTED_KEY), true);
		assert.strictEqual(contexts.get(ACTIVE_RUNNING_KEY), true);
		assert.strictEqual(controller.phaseOf(docs[0].uri), 'running');
	});

	test('DIRTY: saved first; a failed save runs nothing', async () => {
		docs[0].isDirty = true;
		await controller.run();
		assert.strictEqual(docs[0].saves, 1);
		assert.strictEqual(children.length, 1);
		docs[1] = fakeDoc('b.yaml', { dirty: true, saveOk: false });
		await controller.run(docs[1].uri);
		assert.strictEqual(children.length, 1);
		assert.deepStrictEqual(logs, ['Run b.yaml: the file could not be saved; not running.']);
	});

	test('STOP: SIGINT with the grace; exit status and exit line; terminal stays', async () => {
		await controller.run();
		controller.stop();
		await tick();
		assert.deepStrictEqual(children[0].stops, [50]);
		assert.strictEqual(status.text, '$(circle-slash) Pipeline stopped', 'a stop the user asked for, though the exit code is 0');
		assert.strictEqual(status.command?.command, 'redpandaConnect.revealRun');
		assert.ok(terminals[0].output.endsWith('Redpanda Connect stopped (exit code 0).\r\n'));
		assert.strictEqual(terminals[0].disposed, false);
		assert.strictEqual(contexts.get(ACTIVE_RUNNING_KEY), false);
	});

	test('STOP_ESCALATE: a second Stop while stopping kills at once', async () => {
		honoursInt = false;
		await controller.run();
		controller.stop();
		assert.strictEqual(status.text, '$(loading~spin) Stopping…');
		controller.stop();
		await tick();
		assert.deepStrictEqual(children[0].signals, ['SIGINT', 'SIGKILL']);
		assert.strictEqual(status.text, '$(circle-slash) Pipeline stopped');
		assert.ok(terminals[0].output.endsWith('Redpanda Connect stopped by SIGKILL.\r\n'));
	});

	test('RERUN: the terminal is reused after exit', async () => {
		await controller.run();
		children[0].end({ kind: 'exited', exitCode: 1, signal: null });
		await tick();
		assert.strictEqual(status.text, '$(error) Pipeline exited (code 1)');
		assert.ok(terminals[0].output.endsWith('Redpanda Connect exited with code 1.\r\n'));
		controller.stop(); // Stop after the run ended changes nothing
		assert.strictEqual(status.text, '$(error) Pipeline exited (code 1)');
		await controller.run();
		assert.strictEqual(terminals.length, 1);
		assert.strictEqual(children.length, 2);
		assert.strictEqual(status.text, '$(debug-stop) Stop pipeline');
	});

	test('RERUN_RUNNING: Run while running stops, then starts in the same terminal', async () => {
		await controller.run();
		await controller.run();
		assert.deepStrictEqual(children[0].signals, ['SIGINT']);
		assert.strictEqual(children.length, 2);
		assert.strictEqual(terminals.length, 1);
		await tick();
		assert.strictEqual(controller.phaseOf(docs[0].uri), 'running', 'the old exit does not overwrite the new run');
	});

	test('CLOSED_TERMINAL / CLOSE_WHILE_RUNNING: closing kills the run; the next Run opens a new terminal', async () => {
		await controller.run();
		terminals[0].pty.close();
		await tick();
		assert.deepStrictEqual(children[0].signals, ['SIGKILL']);
		await controller.run();
		assert.strictEqual(terminals.length, 2);
		assert.strictEqual(terminals[1].name, 'Redpanda Connect: a.yaml');
	});

	test('CTRL_C: Ctrl+C in the terminal stops; other input is ignored', async () => {
		await controller.run();
		terminals[0].pty.handleInput?.('abc');
		assert.deepStrictEqual(children[0].signals, []);
		terminals[0].pty.handleInput?.('\x03');
		assert.deepStrictEqual(children[0].signals, ['SIGINT']);
	});

	test('UNTITLED / NOT_DETECTED: no run, the message', async () => {
		const untitled = fakeDoc('Untitled-1', { untitled: true });
		docs.push(untitled);
		detected.add(untitled.uri.toString());
		await controller.run(untitled.uri);
		detected.delete(docs[1].uri.toString());
		await controller.run(docs[1].uri);
		const virtual = { ...fakeDoc('v.yaml'), uri: vscode.Uri.parse('vscode-vfs://github/x/v.yaml') };
		docs.push(virtual);
		detected.add(virtual.uri.toString());
		await controller.run(virtual.uri);
		assert.deepStrictEqual(infos, [UNTITLED_MESSAGE, NOT_DETECTED_MESSAGE, NOT_ON_DISK_MESSAGE]);
		assert.strictEqual(children.length, 0);
	});

	test('NO_BINARY: the binary warning again, one log line, no terminal', async () => {
		state = { kind: 'missing' } as BinaryState;
		await controller.run();
		assert.strictEqual(warnings, 1);
		assert.deepStrictEqual(logs, ['Run a.yaml: no usable Redpanda Connect binary.']);
		assert.strictEqual(terminals.length, 0);
	});

	test('BUILDER_FAIL: an error notification and a log line, no terminal', async () => {
		built = () => ({ kind: 'unusableSetting', setting: 'redpandaConnect.resourceFiles', value: 'r.yaml', reason: 'relativePathWithoutWorkspace' });
		await controller.run();
		const message = 'redpandaConnect.resourceFiles "r.yaml" is a relative path, but no workspace folder is open.';
		assert.deepStrictEqual(errors, [`Can't run a.yaml: ${message}`]);
		assert.deepStrictEqual(logs, [`Run a.yaml: ${message}`]);
		assert.strictEqual(terminals.length, 0);
	});

	test('SPAWN_FAIL: the terminal says why; the status shows failed', async () => {
		await controller.run();
		children[0].end({ kind: 'spawnError', message: 'EACCES' });
		await tick();
		assert.ok(terminals[0].output.endsWith('Could not start Redpanda Connect: EACCES\r\n'));
		assert.strictEqual(status.text, '$(error) Pipeline failed to start');
		assert.deepStrictEqual(logs, ['Run a.yaml: Could not start Redpanda Connect: EACCES']);
	});

	test('TWO_FILES: two terminals; the status item follows the active editor', async () => {
		await controller.run(docs[0].uri);
		await controller.run(docs[1].uri);
		assert.deepStrictEqual(terminals.map((t) => t.name), ['Redpanda Connect: a.yaml', 'Redpanda Connect: b.yaml']);
		children[1].end({ kind: 'exited', exitCode: 2, signal: null });
		await tick();
		assert.strictEqual(status.text, '$(debug-stop) Stop pipeline', 'a.yaml is active and still running');
		active = docs[1];
		activeChange.fire(undefined);
		assert.strictEqual(status.text, '$(error) Pipeline exited (code 2)');
		active = fakeDoc('never-run.yaml');
		activeChange.fire(undefined);
		assert.strictEqual(status.visible, false);
	});

	test('DISPOSE: running children are killed and terminals closed', async () => {
		await controller.run(docs[0].uri);
		await controller.run(docs[1].uri);
		controller.dispose();
		assert.deepStrictEqual(children.map((c) => c.signals), [['SIGKILL'], ['SIGKILL']]);
		assert.ok(terminals.every((t) => t.disposed));
	});

	test('a second Run while one is being prepared is ignored', async () => {
		docs[0].isDirty = true;
		await Promise.all([controller.run(), controller.run()]);
		assert.strictEqual(children.length, 1);
	});

	test('status and exit wording', () => {
		assert.strictEqual(statusText('exited', { kind: 'notFound' }), '$(error) Pipeline failed to start');
		assert.strictEqual(exitLine({ kind: 'notFound' }), 'Could not start Redpanda Connect: the binary was not found.');
		assert.strictEqual(exitLine({ kind: 'exited', exitCode: null, signal: 'SIGINT' }), 'Redpanda Connect stopped by SIGINT.');
	});

	test('the production grace is 10 s', async () => {
		controller.dispose();
		graceMs = undefined;
		make();
		await controller.run();
		controller.stop();
		assert.strictEqual(STOP_GRACE_MS, 10_000);
		assert.deepStrictEqual(children[0].stops, [10_000]);
	});

	test('STOP_ESCALATE by the grace alone: Stopping…, then SIGKILL, then Pipeline stopped', async () => {
		honoursInt = false;
		await controller.run();
		controller.stop();
		assert.strictEqual(status.text, '$(loading~spin) Stopping…');
		await new Promise((r) => setTimeout(r, 100));
		assert.deepStrictEqual(children[0].signals, ['SIGINT', 'SIGKILL']);
		assert.strictEqual(status.text, '$(circle-slash) Pipeline stopped');
	});

	test('writes before VS Code opens the terminal are kept, including the $ line', async () => {
		deferOpen = true;
		await controller.run();
		children[0].handlers.onStdout?.('early\n');
		assert.strictEqual(terminals[0].output, '');
		await tick();
		assert.strictEqual(terminals[0].output, `\x1b[2m$ ${BIN} run --set http.enabled=false /ws/a.yaml\x1b[0m\r\nearly\r\n`);
	});

	test('Stop during a re-run\'s wait cancels the restart', async () => {
		intDelayMs = 30; // the old run takes a moment to exit on SIGINT
		await controller.run();
		const rerun = controller.run();
		await tick();
		controller.stop(); // phase is stopping: SIGKILL, and the restart is cancelled
		await rerun;
		assert.strictEqual(children.length, 1, 'no new run started');
		assert.deepStrictEqual(children[0].signals, ['SIGINT', 'SIGKILL']);
		assert.strictEqual(status.text, '$(circle-slash) Pipeline stopped');
	});

	test('closing the terminal during a re-run\'s wait cancels the restart', async () => {
		intDelayMs = 30;
		await controller.run();
		const rerun = controller.run();
		await tick();
		terminals[0].pty.close();
		await rerun;
		assert.strictEqual(children.length, 1);
		assert.strictEqual(terminals.length, 1, 'no terminal reopened');
	});

	test('a Run while the re-run is waiting is ignored with a log line', async () => {
		intDelayMs = 30;
		await controller.run();
		const rerun = controller.run();
		await controller.run();
		await rerun;
		assert.ok(logs.includes('Run a.yaml: already starting; ignored.'));
		assert.strictEqual(children.length, 2);
	});

	test('Run before the binary has resolved waits for the resolution', async () => {
		state = { kind: 'unresolved' } as BinaryState;
		await controller.run();
		assert.strictEqual(refreshes, 1);
		assert.strictEqual(children.length, 1);
		state = { kind: 'unresolved' } as BinaryState;
		refreshTo = { kind: 'missing' } as BinaryState;
		await controller.run(docs[1].uri);
		assert.strictEqual(warnings, 1);
	});

	test('context keys: detected paths for the editor title; detection changes refresh them', async () => {
		assert.deepStrictEqual(contexts.get(DETECTED_PATHS_KEY), ['/ws/a.yaml', '/ws/b.yaml']);
		detected.delete(docs[0].uri.toString());
		detectionChange.fire({ uri: docs[0].uri.toString(), detected: false });
		assert.strictEqual(contexts.get(ACTIVE_DETECTED_KEY), false);
		assert.deepStrictEqual(contexts.get(DETECTED_PATHS_KEY), ['/ws/b.yaml']);
	});
});
