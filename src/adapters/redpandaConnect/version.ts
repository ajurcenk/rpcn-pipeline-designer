// Minimal RedpandaConnect adapter: resolves the binary and reads its version.
// This module is the only place that spawns processes (AD-9). The full
// resolution order, version floor and `binaryState` arrive in ticket 1.3.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseVersionOutput } from '../../core/version';

export const DEFAULT_BINARY = 'redpanda-connect';
export const DEFAULT_VERSION_TIMEOUT_MS = 10_000;

export type BinarySource = 'setting' | 'path';

export type VersionResult =
	| { kind: 'ok'; path: string; version: string; source: BinarySource }
	| { kind: 'notFound'; requested: string; source: BinarySource }
	| {
		kind: 'failed';
		path: string;
		source: BinarySource;
		/** Process exit code; `null` when it was killed or never started. */
		exitCode: number | null;
		/** First non-empty stderr line, or '' if none. */
		stderrFirstLine: string;
		reason: 'nonZeroExit' | 'noVersionLine' | 'timeout' | 'spawnError';
		/** Extra detail for `timeout` / `spawnError`. */
		detail?: string;
	};

export type ResolvedBinary =
	| { kind: 'resolved'; path: string; source: BinarySource }
	| { kind: 'notFound'; requested: string; source: BinarySource };

/** Writes one line to the "Redpanda Connect" output channel owned by `src/extension.ts`. */
export type LogLine = (line: string) => void;

/**
 * Reads `redpandaConnect.binaryPath`, resolves the binary, runs `<binary> --version`
 * and logs the outcome through `log`. Never rejects.
 */
export async function checkConfiguredBinaryVersion(
	log: LogLine,
	timeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
): Promise<VersionResult> {
	const setting = vscode.workspace.getConfiguration('redpandaConnect').get<string>('binaryPath', '');
	const resolved = resolveBinary(setting);
	const result = resolved.kind === 'notFound'
		? resolved
		: await readVersion(resolved.path, resolved.source, timeoutMs);
	log(describeVersionResult(result));
	return result;
}

export function describeVersionResult(result: VersionResult): string {
	switch (result.kind) {
		case 'ok':
			return `Redpanda Connect ${result.version} (${result.path})`;
		case 'notFound':
			return result.source === 'setting'
				? `No Redpanda Connect binary found at redpandaConnect.binaryPath "${result.requested}".`
				: `No Redpanda Connect binary found: redpandaConnect.binaryPath is not set and "${result.requested}" is not on PATH.`;
		case 'failed': {
			const exit = result.exitCode === null ? 'no exit code' : `exit code ${result.exitCode}`;
			const why = result.reason === 'noVersionLine' ? 'no "Version:" line in output'
				: result.reason === 'nonZeroExit' ? 'non-zero exit'
				: result.detail ?? result.reason;
			const stderr = result.stderrFirstLine ? `: ${result.stderrFirstLine}` : '';
			return `Redpanda Connect version check failed (${result.path}): ${why}, ${exit}${stderr}`;
		}
	}
}

/**
 * The `binaryPath` setting wins when set; otherwise `redpanda-connect` is looked up on PATH.
 * A setting without a path separator is treated as a command name and looked up on PATH too.
 */
export function resolveBinary(
	binaryPathSetting: string | undefined,
	envPath: string | undefined = process.env.PATH,
): ResolvedBinary {
	const setting = (binaryPathSetting ?? '').trim();
	const source: BinarySource = setting ? 'setting' : 'path';
	const requested = setting || DEFAULT_BINARY;

	if (requested.includes('/') || requested.includes('\\')) {
		return { kind: 'resolved', path: requested, source };
	}
	const found = findOnPath(requested, envPath);
	return found ? { kind: 'resolved', path: found, source } : { kind: 'notFound', requested, source };
}

function findOnPath(command: string, envPath: string | undefined): string | undefined {
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

/** Spawns `<binaryPath> --version` with `NO_COLOR=1` and a timeout. Never rejects. */
export function readVersion(
	binaryPath: string,
	source: BinarySource,
	timeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
): Promise<VersionResult> {
	return new Promise<VersionResult>((resolve) => {
		let stdout = '';
		let stderr = '';
		let settled = false;

		const finish = (result: VersionResult) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(result);
			}
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(binaryPath, ['--version'], {
				env: { ...process.env, NO_COLOR: '1' },
				shell: false,
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (err) {
			resolve(spawnFailure(binaryPath, source, err));
			return;
		}

		// Resolve here rather than on 'close': a grandchild holding the pipes can delay 'close'.
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			finish({
				kind: 'failed', path: binaryPath, source, exitCode: null, stderrFirstLine: firstNonEmptyLine(stderr),
				reason: 'timeout', detail: `timed out after ${timeoutMs} ms`,
			});
		}, timeoutMs);

		child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
		child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });

		child.on('error', (err) => finish(spawnFailure(binaryPath, source, err)));

		child.on('close', (code) => {
			const stderrFirstLine = firstNonEmptyLine(stderr);
			if (code !== 0) {
				finish({ kind: 'failed', path: binaryPath, source, exitCode: code, stderrFirstLine, reason: 'nonZeroExit' });
				return;
			}
			const version = parseVersionOutput(stdout);
			finish(version
				? { kind: 'ok', path: binaryPath, version, source }
				: { kind: 'failed', path: binaryPath, source, exitCode: code, stderrFirstLine, reason: 'noVersionLine' });
		});
	});
}

function spawnFailure(binaryPath: string, source: BinarySource, err: unknown): VersionResult {
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	// ENOENT also covers an existing script whose `#!` interpreter is missing.
	if (code === 'ENOENT' && !fs.existsSync(binaryPath)) {
		return { kind: 'notFound', requested: binaryPath, source };
	}
	return {
		kind: 'failed', path: binaryPath, source, exitCode: null, stderrFirstLine: '',
		reason: 'spawnError', detail: err instanceof Error ? err.message : String(err),
	};
}

function firstNonEmptyLine(text: string): string {
	return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
}
