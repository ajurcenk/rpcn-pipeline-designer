// Process spawning for the RedpandaConnect adapter. This module is the only place in
// the extension that imports `child_process` (AD-9). Interpretation of the output
// (version floor, rpk plugin detection, binaryState) lives in `binary.ts` and `src/core`.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_VERSION_TIMEOUT_MS = 10_000;

/** Raw outcome of running `<invocation…> --version`. */
export type VersionProbe =
	/** The process exited (or was killed by a signal, `exitCode: null`) before the timeout. */
	| { kind: 'exited'; exitCode: number | null; stdout: string; stderr: string }
	/** The process did not exit within the timeout and was killed. */
	| { kind: 'timeout'; timeoutMs: number; stderr: string }
	/** The executable does not exist. */
	| { kind: 'notFound' }
	/** The executable exists but could not be started (permissions, missing `#!` interpreter, …). */
	| { kind: 'spawnError'; message: string };

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
): Promise<VersionProbe> {
	const [command, ...prefixArgs] = invocation;
	return new Promise<VersionProbe>((resolve) => {
		if (!command) {
			resolve({ kind: 'spawnError', message: 'empty invocation' });
			return;
		}

		let stdout = '';
		let stderr = '';
		let settled = false;
		let timer: NodeJS.Timeout | undefined;

		const finish = (result: VersionProbe) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(result);
			}
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, [...prefixArgs, '--version'], {
				env: { ...process.env, NO_COLOR: '1' },
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

function spawnFailure(command: string, err: unknown): VersionProbe {
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	// ENOENT also covers an existing script whose `#!` interpreter is missing.
	if (code === 'ENOENT' && !fs.existsSync(command)) {
		return { kind: 'notFound' };
	}
	return { kind: 'spawnError', message: err instanceof Error ? err.message : String(err) };
}
