// Process spawning for the RedpandaConnect adapter. This module is the only place in
// the extension that imports `child_process` (AD-9). Interpretation of the output
// (version floor, rpk plugin detection, binaryState) lives in `binary.ts` and `src/core`.
// Two runners: `runProcess` (buffered, one-shot, timeout-killed: version, list, lint) and
// `runStreaming` (long-lived, output as it arrives, stopped by signal: Run, AD-13). Both force
// `NO_COLOR=1` on top of the caller's env, use no shell and ignore stdin. No `vscode` import:
// the corpus harness runs this module in plain Node.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { errorText } from './text';

export const DEFAULT_VERSION_TIMEOUT_MS = 10_000;
/** Per `list --format …` run; json-full is ~2.6 MB and takes a few seconds on a cold start. */
export const DEFAULT_LIST_TIMEOUT_MS = 60_000;

/** Raw outcome of running `<invocation…> <args…>`. */
export type ProcessOutcome =
	/** The process exited (or was killed by a signal, `exitCode: null`) before the timeout. */
	| { kind: 'exited'; exitCode: number | null; stdout: string; stderr: string }
	/** The process did not exit within the timeout and was killed. */
	| { kind: 'timeout'; timeoutMs: number; stderr: string }
	/** The executable does not exist. */
	| { kind: 'notFound' }
	/** The executable exists but could not be started (permissions, missing `#!` interpreter, …). */
	| { kind: 'spawnError'; message: string };

/** What a caller may set for the child. */
export interface SpawnOptions {
	/** The child's whole environment (default `process.env`); `NO_COLOR=1` is always forced on top. */
	readonly env?: NodeJS.ProcessEnv;
	/** Working directory (default: the extension host's); a missing one is a `spawnError`, never `notFound`. */
	readonly cwd?: string;
}

/** Looks `command` up on `envPath`: the bare name, plus `.exe` on win32. Returns the first executable file. */
export function findOnPath(command: string, envPath: string | undefined): string | undefined {
	// With `shell: false`, only real executables can be spawned on win32 (.cmd/.bat give EINVAL).
	const extensions = process.platform === 'win32' ? ['', '.exe'] : [''];
	for (const dir of (envPath ?? '').split(path.delimiter)) {
		if (!dir) {
			continue;
		}
		for (const ext of extensions) {
			const candidate = path.join(dir, command + ext);
			if (isExecutableFile(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

function isExecutableFile(candidate: string): boolean {
	try {
		if (!fs.statSync(candidate).isFile()) {
			return false;
		}
		if (process.platform !== 'win32') {
			fs.accessSync(candidate, fs.constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Spawns `<invocation[0]> <invocation[1..]> --version` (for example `[rpk, 'connect']`)
 * with `NO_COLOR=1`, no shell and a timeout. Never rejects.
 */
export function readVersion(
	invocation: readonly string[],
	timeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
): Promise<ProcessOutcome> {
	return runProcess(invocation, ['--version'], timeoutMs);
}

/** Output formats of `list --format <format>` the extension reads (AD-10). */
export type ListFormat = 'jsonschema' | 'json-full';

/** Spawns `<invocation…> list --format <format>` like `readVersion`. Never rejects. */
export function runList(
	invocation: readonly string[],
	format: ListFormat,
	timeoutMs = DEFAULT_LIST_TIMEOUT_MS,
): Promise<ProcessOutcome> {
	return runProcess(invocation, ['list', '--format', format], timeoutMs);
}

/**
 * The one-shot runner (AD-9): `<invocation[0]> <invocation[1..]> <args…>` with `NO_COLOR=1`,
 * no shell, stdin ignored and a timeout (SIGKILL). Never rejects. Exported for argv built by
 * `src/core/args.ts` (lint) and for the corpus harness.
 */
export function runProcess(
	invocation: readonly string[],
	args: readonly string[],
	timeoutMs: number,
	options: SpawnOptions = {},
): Promise<ProcessOutcome> {
	const [command, ...prefixArgs] = invocation;
	return new Promise<ProcessOutcome>((resolve) => {
		if (!command) {
			resolve({ kind: 'spawnError', message: 'empty invocation' });
			return;
		}

		let stdout = '';
		let stderr = '';
		let settled = false;
		let timer: NodeJS.Timeout | undefined;

		const finish = (result: ProcessOutcome) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(result);
			}
		};

		const badCwd = cwdProblem(options);
		if (badCwd) {
			finish({ kind: 'spawnError', message: badCwd });
			return;
		}

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, [...prefixArgs, ...args], {
				env: childEnv(options),
				cwd: options.cwd,
				shell: false,
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (err) {
			finish(spawnFailure(command, err));
			return;
		}

		// Resolve here rather than on 'close': a grandchild holding the pipes can delay 'close'.
		timer = setTimeout(() => {
			child.kill('SIGKILL');
			finish({ kind: 'timeout', timeoutMs, stderr });
		}, timeoutMs);

		child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
		child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });

		child.on('error', (err) => finish(spawnFailure(command, err)));
		child.on('close', (exitCode) => finish({ kind: 'exited', exitCode, stdout, stderr }));
	});
}

/** How a streaming child ended. */
export type StreamingExit =
	/** The process exited; `signal` is set (and `exitCode` null) when a signal ended it. */
	| { kind: 'exited'; exitCode: number | null; signal: NodeJS.Signals | null }
	| { kind: 'notFound' }
	| { kind: 'spawnError'; message: string };

/**
 * Output callbacks, given at spawn time so no early chunk is missed. Never called after `exited`
 * resolves; an exception a callback throws is swallowed (it must not crash the host).
 */
export interface StreamingHandlers {
	/** A UTF-8 stdout chunk, as it arrives (not split into lines). */
	readonly onStdout?: (chunk: string) => void;
	/** A UTF-8 stderr chunk, as it arrives (not split into lines). */
	readonly onStderr?: (chunk: string) => void;
}

/** A long-lived child process (AD-13). */
export interface StreamingChild {
	/**
	 * Resolves exactly once and never rejects: after the last output chunk, or
	 * `STREAM_CLOSE_GRACE_MS` after exit when a grandchild still holds the pipes (later output is
	 * dropped).
	 */
	readonly exited: Promise<StreamingExit>;
	/** Sends `signal` (default SIGTERM); a no-op once the process has exited. */
	kill(signal?: NodeJS.Signals): void;
	/**
	 * SIGINT, then SIGKILL if still running after `graceMs` (clamped to 0 … 2^31-1 ms; NaN → 0);
	 * resolves with the exit. Only the first call signals; later calls just wait.
	 */
	stop(graceMs: number): Promise<StreamingExit>;
}

/**
 * After the process exits, how long `exited` waits for its pipes to close: a grandchild holding
 * them must not keep `exited` pending. Output arriving in that time is delivered; then the pipes
 * are destroyed.
 */
export const STREAM_CLOSE_GRACE_MS = 2_000;

/** Largest delay `setTimeout` honours; larger values fire after about 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The streaming runner (AD-9, AD-13): spawns like `runProcess`, without a timeout, and delivers
 * output as it arrives. Never throws; failures to start resolve `exited`.
 */
export function runStreaming(
	invocation: readonly string[],
	args: readonly string[],
	handlers: StreamingHandlers = {},
	options: SpawnOptions = {},
): StreamingChild {
	const [command, ...prefixArgs] = invocation;
	let resolveExit!: (exit: StreamingExit) => void;
	const exited = new Promise<StreamingExit>((resolve) => { resolveExit = resolve; });
	let settled = false;
	let closeTimer: NodeJS.Timeout | undefined;
	const finish = (exit: StreamingExit) => {
		if (!settled) {
			settled = true;
			clearTimeout(closeTimer);
			resolveExit(exit);
		}
	};
	const inert: StreamingChild = { exited, kill: () => undefined, stop: () => exited };

	if (!command) {
		finish({ kind: 'spawnError', message: 'empty invocation' });
		return inert;
	}
	const badCwd = cwdProblem(options);
	if (badCwd) {
		finish({ kind: 'spawnError', message: badCwd });
		return inert;
	}
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(command, [...prefixArgs, ...args], {
			env: childEnv(options),
			cwd: options.cwd,
			shell: false,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (err) {
		finish(streamingFailure(command, err));
		return inert;
	}

	const deliver = (handler: ((chunk: string) => void) | undefined) => (chunk: string) => {
		if (!settled) {
			try {
				handler?.(chunk);
			} catch {
				// A consumer bug must not become an uncaught exception from the pipe.
			}
		}
	};
	child.stdout?.setEncoding('utf8').on('data', deliver(handlers.onStdout));
	child.stderr?.setEncoding('utf8').on('data', deliver(handlers.onStderr));
	child.on('error', (err) => {
		// 'error' also fires when a kill fails on a live process; only a failure to start ends it.
		if (child.pid === undefined) {
			finish(streamingFailure(command, err));
		}
	});
	child.on('exit', (exitCode, signal) => {
		closeTimer = setTimeout(() => {
			finish({ kind: 'exited', exitCode, signal });
			child.stdout?.destroy();
			child.stderr?.destroy();
		}, STREAM_CLOSE_GRACE_MS);
	});
	child.on('close', (exitCode, signal) => finish({ kind: 'exited', exitCode, signal }));

	const running = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
	const kill = (signal: NodeJS.Signals = 'SIGTERM') => {
		if (running()) {
			child.kill(signal);
		}
	};
	let stopping = false;
	return {
		exited,
		kill,
		stop: (graceMs) => {
			if (!stopping && running()) {
				stopping = true;
				kill('SIGINT');
				const grace = Number.isNaN(graceMs) ? 0 : Math.min(Math.max(graceMs, 0), MAX_TIMER_MS);
				const escalate = setTimeout(() => kill('SIGKILL'), grace);
				void exited.then(() => clearTimeout(escalate));
			}
			return exited;
		},
	};
}

function streamingFailure(command: string, err: unknown): StreamingExit {
	const failure = spawnFailure(command, err);
	return failure.kind === 'notFound' ? failure : { kind: 'spawnError', message: errorText(err) };
}

/** Why `options.cwd` cannot be used, or `undefined`. Node reports a missing cwd as the command's ENOENT. */
function cwdProblem(options: SpawnOptions): string | undefined {
	if (options.cwd === undefined) {
		return undefined;
	}
	try {
		return fs.statSync(options.cwd).isDirectory() ? undefined : `working directory "${options.cwd}" is not a directory`;
	} catch {
		return `working directory "${options.cwd}" does not exist`;
	}
}

function childEnv(options: SpawnOptions): NodeJS.ProcessEnv {
	return { ...(options.env ?? process.env), NO_COLOR: '1' };
}

function spawnFailure(command: string, err: unknown): ProcessOutcome {
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	// ENOENT also covers an existing script whose `#!` interpreter is missing.
	if (code === 'ENOENT' && !fs.existsSync(command)) {
		return { kind: 'notFound' };
	}
	return { kind: 'spawnError', message: errorText(err) };
}
