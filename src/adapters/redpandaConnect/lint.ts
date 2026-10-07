// RedpandaConnect adapter: lint one saved file (AD-12). Builds the argv with the shared builder
// (AD-9), runs it on the one-shot spawn site with the builder's env, and parses stderr with
// `src/core/lint`. Returns plain results; diagnostics are `src/adapters/vscode/diagnostics.ts`.

import * as path from 'path';
import { findingsForTarget, LintFinding } from '../../core/lint';
import { ArgsEnvironment, buildLintCommand, describeArgsFailure } from './args';
import { BinaryState } from './binary';
import { ProcessOutcome, runProcess, SpawnOptions } from './process';
import { firstNonEmptyLine } from './text';

export const LINT_TIMEOUT_MS = 30_000;
/** Log lines kept per lint run; the rest are summarised in one line. */
export const MAX_LINT_LOG_LINES = 20;

export type LintResult =
	/** Lint ran: findings for the file (possibly none), and log lines for output it could not use. */
	| { readonly kind: 'findings'; readonly findings: readonly LintFinding[]; readonly logLines: readonly string[] }
	/** No usable binary: nothing ran, nothing to log (the binary warning covers it). */
	| { readonly kind: 'skipped' }
	/** Lint could not run or crashed: one log line, no findings. */
	| { readonly kind: 'failed'; readonly logLine: string };

export interface LintDependencies {
	readonly argsEnvironment?: ArgsEnvironment;
	readonly timeoutMs?: number;
	readonly run?: (invocation: readonly string[], args: readonly string[], timeoutMs: number, options: SpawnOptions) => Promise<ProcessOutcome>;
}

/** Lints `fsPath` (absolute) with the current binary. Never throws or rejects. */
export async function lintFile(state: BinaryState, fsPath: string, deps: LintDependencies = {}): Promise<LintResult> {
	if (state.kind !== 'ok') {
		return { kind: 'skipped' };
	}
	const name = path.basename(fsPath);
	let built;
	try {
		built = buildLintCommand(state, { targets: [fsPath] }, deps.argsEnvironment);
	} catch (err) {
		return { kind: 'failed', logLine: `Lint ${name}: ${String(err)}` };
	}
	if (built.kind !== 'ok') {
		return { kind: 'failed', logLine: `Lint ${name}: ${describeArgsFailure(built)}` };
	}
	const timeoutMs = deps.timeoutMs ?? LINT_TIMEOUT_MS;
	const outcome = await (deps.run ?? runProcess)([built.command], built.args, timeoutMs, { env: built.env });
	switch (outcome.kind) {
		case 'notFound':
			return { kind: 'failed', logLine: `Lint ${name}: the Redpanda Connect binary was not found.` };
		case 'spawnError':
			return { kind: 'failed', logLine: `Lint ${name}: could not start Redpanda Connect: ${outcome.message}` };
		case 'timeout':
			return { kind: 'failed', logLine: `Lint ${name}: no result after ${outcome.timeoutMs / 1000} s; stopped.` };
		case 'exited':
			return interpret(name, fsPath, outcome.exitCode, outcome.stderr);
	}
}

function interpret(name: string, fsPath: string, exitCode: number | null, stderr: string): LintResult {
	if (exitCode === 0) {
		return { kind: 'findings', findings: [], logLines: [] };
	}
	if (exitCode !== 1) {
		const detail = firstNonEmptyLine(stderr);
		const how = exitCode === null ? 'was stopped by a signal' : `exited with code ${exitCode}`;
		return { kind: 'failed', logLine: `Lint ${name}: Redpanda Connect ${how}${detail ? `: ${detail}` : '.'}` };
	}
	const { findings, otherFiles, unparsed } = findingsForTarget(stderr, fsPath);
	const allLogLines = [
		...unparsed.map((l) => `Lint ${name}: unrecognised output: ${l}`),
		...otherFiles.map((f) => `Lint ${name}: finding for another file: ${f.path}(${f.line}) ${f.message}`),
	];
	const logLines = allLogLines.length > MAX_LINT_LOG_LINES
		? [...allLogLines.slice(0, MAX_LINT_LOG_LINES), `Lint ${name}: … ${allLogLines.length - MAX_LINT_LOG_LINES} more lines not shown.`]
		: allLogLines;
	if (findings.length === 0 && logLines.length === 0) {
		return { kind: 'failed', logLine: `Lint ${name}: Redpanda Connect exited with code 1 but reported no findings.` };
	}
	return { kind: 'findings', findings, logLines };
}
