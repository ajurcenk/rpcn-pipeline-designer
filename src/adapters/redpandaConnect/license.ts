// RedpandaConnect adapter: the Environment view's **Check license** (ticket 38). The binary reports
// its Enterprise license only in a `run`'s startup log, so the check runs a tiny config that ends at
// once (one `generate` message into `drop`, no HTTP server, logfmt at INFO) with the commands' own
// `run` command line (`buildCommandLine(buildRunArgs, …)`: the config's `--resources`, `--env-file`s,
// secrets and `NO_COLOR`), so its answer is the one Run gets, and reads the license line
// (`src/core/licenseLog.ts`). The temporary config lives in `storageDir` and is removed on every
// path. The extension never passes `--redpanda-license`. No `vscode` import. Never throws or rejects.

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { buildRunArgs } from '../../core/args';
import { type LicenseLogResult, readLicenseLog } from '../../core/licenseLog';
import type { BloblangCommand, RunFunction } from './bloblangRunner';
import { buildCommandLine, describeArgsFailure } from './commandLine';
import { runProcess } from './process';
import { errorText, firstNonEmptyLine } from './text';

export const LICENSE_CHECK_TIMEOUT_MS = 15_000;

/** The config the check runs: one empty message into `drop`, so the run ends at once. */
export const LICENSE_CHECK_CONFIG = [
	'http:',
	'  enabled: false',
	'logger:',
	'  level: INFO',
	'  format: logfmt',
	'input:',
	'  generate:',
	'    count: 1',
	'    interval: ""',
	'    mapping: root = {}',
	'output:',
	'  drop: {}',
	'',
].join('\n');

export type LicenseCheckResult = LicenseLogResult | { readonly kind: 'error'; readonly reason: string };

export interface LicenseCheckDependencies {
	readonly timeoutMs?: number;
	/** The child's working directory (Run's: the workspace folder, else the file's folder). */
	readonly cwd?: string;
	readonly run?: RunFunction;
}

/** Runs the license check with `command`'s binary and settings. */
export async function checkLicense(command: BloblangCommand, storageDir: string, deps: LicenseCheckDependencies = {}): Promise<LicenseCheckResult> {
	if (command.state.kind !== 'ok') {
		return { kind: 'error', reason: 'No Redpanda Connect binary was found.' };
	}
	const file = path.join(storageDir, `license-check-${randomBytes(8).toString('hex')}.yaml`);
	try {
		await fs.promises.mkdir(storageDir, { recursive: true });
		await fs.promises.writeFile(file, LICENSE_CHECK_CONFIG, 'utf8');
		const built = buildCommandLine(buildRunArgs, command.state, [file], command.settings);
		if (built.kind !== 'ok') {
			return { kind: 'error', reason: describeArgsFailure(built) };
		}
		const timeoutMs = deps.timeoutMs ?? LICENSE_CHECK_TIMEOUT_MS;
		const outcome = await (deps.run ?? runProcess)([built.command], built.args, timeoutMs, { env: built.env, ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}) });
		switch (outcome.kind) {
			case 'notFound':
				return { kind: 'error', reason: 'The Redpanda Connect binary was not found.' };
			case 'spawnError':
				return { kind: 'error', reason: `Could not start Redpanda Connect: ${outcome.message}` };
			case 'timeout': {
				const read = readLicenseLog(outcome.stderr);
				return read.kind !== 'none' ? read : { kind: 'error', reason: `The check run gave no result after ${outcome.timeoutMs / 1000} s; stopped.` };
			}
			case 'exited': {
				const read = readLicenseLog(`${outcome.stderr}\n${outcome.stdout}`);
				if (read.kind !== 'none' || outcome.exitCode === 0) {
					return read;
				}
				const line = firstErrorLine(outcome.stderr) ?? firstNonEmptyLine(outcome.stdout);
				return { kind: 'error', reason: `The check run failed (exit ${outcome.exitCode ?? 'by a signal'})${line ? `: ${line}` : '.'}` };
			}
			default:
				return outcome satisfies never;
		}
	} catch (err) {
		return { kind: 'error', reason: `Could not run the check: ${errorText(err)}` };
	} finally {
		try {
			await fs.promises.rm(file, { force: true });
		} catch {
			// Best effort: a leftover file in the extension's storage harms nothing (it holds no value).
		}
	}
}

/** The first `level=error` line's message (with its `error`/`lint` field), else the first line. */
function firstErrorLine(stderr: string): string | undefined {
	const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const error = lines.find((l) => /\blevel=(error|fatal)\b/.test(l));
	if (!error) {
		return lines[0];
	}
	const msg = /\bmsg="((?:[^"\\]|\\.)*)"/.exec(error)?.[1];
	const detail = /\b(?:error|lint)="((?:[^"\\]|\\.)*)"/.exec(error)?.[1];
	return msg ? [msg, detail].filter(Boolean).join(': ').replace(/\\"/g, '"') : error;
}
