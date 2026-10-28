// RedpandaConnect adapter: the Bloblang run and parse orchestration (AD-21, tickets 4.2, 4.5, 4.7,
// 4.8), with no `vscode` import (ticket 4.12), so the corpus harness runs the real code in plain
// Node. Its inputs: the binary state, the settings as `commandLine.ts` reads them (`CommandSettings`:
// VS Code's through `args.ts`'s `commandSettings`, or plain values in the harness), and the spawn
// function. The command lines are `commandLine.ts`'s, the ones lint and Run use. `bloblang.ts` binds
// the state and the settings and delegates here.
//
// The test run writes the one-message config from `src/core/bloblangRun` to a temporary file in
// `storageDir`, runs it with `run` (the argv from `src/core/args.ts`: the same `--resources` and
// `--env-file` as Run) through the one-shot spawn site with a timeout, deletes the file once the
// child exited, and reads the output with `parseRunOutput`. `classify` (4.8): a run stopped by
// `Config lint error` is parsed with `blobl` (`parseMapping`), so a Bloblang parse error becomes
// `parseError` with the binary's mapping-relative position (the run's own lint positions are
// config-relative and unreliable, spike 4.1 Q1), and any other lint message stays `error` (with the
// names an unset `${VAR}` message lists, ticket 32: `missingVariables`); the
// file positions of `parseError` and `failed` come from the caller's `locate` (4.3's position map).
// The live parse (4.5): `parseMapping` writes the Bloblang to a temporary file the same way and runs
// `blobl --file` on it, stdin closed (parse only), read with `parseBloblParseOutput`. Never throws
// or rejects.

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { buildRunArgs } from '../../core/args';
import { BloblParseOutcome, parseBloblParseOutput } from '../../core/bloblangParse';
import { missingVariablesOf, parseRunOutput, testConfig, type RunOutcome } from '../../core/bloblangRun';
import type { BloblangProcessorKind, BloblangResult, InputMeta } from '../../shared/bloblangProtocol';
import type { BinaryState } from './binary';
import { type ArgsResult, buildBloblCommandLine, buildCommandLine, type CommandSettings, describeArgsFailure } from './commandLine';
import { ProcessOutcome, runProcess, SpawnOptions } from './process';
import { errorText } from './text';

export const MAPPING_TEST_TIMEOUT_MS = 10_000;
/** The live parse's timeout (4.5): one launch takes ~0.2 s, ~0.42 s through rpk (spike 4.1). */
export const MAPPING_PARSE_TIMEOUT_MS = 5_000;

/** A 1-based line and char of the YAML document (a `vscode.Position`'s line and character plus 1). */
export interface FilePosition {
	readonly line: number;
	readonly char: number;
}

/** The spawn function: `runProcess`'s signature. */
export type RunFunction = (invocation: readonly string[], args: readonly string[], timeoutMs: number, options: SpawnOptions) => Promise<ProcessOutcome>;

/** What the children are started from: the binary state and where the settings are read. */
export interface BloblangCommand {
	readonly state: BinaryState;
	readonly settings: CommandSettings;
}

export interface RunnerTestDependencies {
	/**
	 * From the mapping's 1-based `line` and `char` to the document's (4.3's position map). Without
	 * it, the mapping's own position (as if the mapping were the whole file).
	 */
	readonly locate?: (line: number, char: number) => FilePosition;
	readonly timeoutMs?: number;
	/** The child's working directory (Run's: the workspace folder, else the file's folder). */
	readonly cwd?: string;
	readonly run?: RunFunction;
}

export interface RunnerParseDependencies {
	readonly timeoutMs?: number;
	readonly cwd?: string;
	readonly run?: RunFunction;
}

/**
 * Runs `source` as a `kind` processor once on `content` with metadata `meta`; a `generate` kind
 * (ticket 16) runs it as a `mapping` processor on one empty message, `content` and `meta` unused
 * (`testConfig`). The temporary config lives in `storageDir` (created when missing) and is removed
 * after the child exits.
 */
export async function runMappingTest(
	command: BloblangCommand,
	kind: BloblangProcessorKind,
	source: string,
	content: string,
	meta: InputMeta,
	storageDir: string,
	deps: RunnerTestDependencies = {},
): Promise<BloblangResult> {
	const file = path.join(storageDir, `bloblang-test-${randomBytes(8).toString('hex')}.yaml`);
	try {
		await fs.promises.mkdir(storageDir, { recursive: true });
		await fs.promises.writeFile(file, testConfig(kind, source, content, meta), 'utf8');
	} catch (err) {
		await remove(file);
		return { kind: 'error', message: `Could not write the test config: ${errorText(err)}` };
	}
	try {
		const built = buildCommandLine(buildRunArgs, command.state, [file], command.settings);
		if (built.kind !== 'ok') {
			return { kind: 'error', message: describeArgsFailure(built) };
		}
		const timeoutMs = deps.timeoutMs ?? MAPPING_TEST_TIMEOUT_MS;
		const outcome = await (deps.run ?? runProcess)([built.command], built.args, timeoutMs, spawnOptions(built, deps.cwd));
		switch (outcome.kind) {
			case 'notFound':
				return { kind: 'error', message: 'The Redpanda Connect binary was not found.' };
			case 'spawnError':
				return { kind: 'error', message: `Could not start Redpanda Connect: ${outcome.message}` };
			case 'timeout':
				return { kind: 'error', message: `No result after ${outcome.timeoutMs / 1000} s; stopped.` };
			case 'exited':
				return await classify(parseRunOutput(outcome.exitCode, outcome.stdout, outcome.stderr, { content, meta }), command, source, storageDir, deps);
		}
	} catch (err) {
		return { kind: 'error', message: errorText(err) };
	} finally {
		await remove(file);
	}
}

/**
 * A run outcome as the panel shows it (4.8): a lint stop is a `parseError` when `blobl` finds one
 * (its message, excerpt and mapping position, plus the file position), else `error` with the lint
 * message verbatim; a `failed` with a mapping line gets its file line.
 */
export async function classify(
	outcome: RunOutcome,
	command: BloblangCommand,
	source: string,
	storageDir: string,
	deps: RunnerTestDependencies,
): Promise<BloblangResult> {
	const locate = deps.locate ?? ((line: number, char: number): FilePosition => ({ line, char }));
	if (outcome.kind === 'lint') {
		const parsed = await parseMapping(command, source, storageDir, {
			...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
			...(deps.run ? { run: deps.run } : {}),
		});
		if (parsed.kind !== 'parseError') {
			// Ticket 32: the variables an unset `${VAR}` stopped it on, when it names any.
			const missing = missingVariablesOf(outcome.message);
			return missing.length > 0 ? { kind: 'error', message: outcome.message, missingVariables: missing } : { kind: 'error', message: outcome.message };
		}
		const at = locate(parsed.line, parsed.char);
		return {
			kind: 'parseError',
			message: parsed.message,
			excerpt: parsed.excerpt,
			mappingLine: parsed.line,
			mappingChar: parsed.char,
			fileLine: at.line,
			fileChar: at.char,
		};
	}
	if (outcome.kind === 'failed' && outcome.mappingLine !== undefined) {
		return { ...outcome, fileLine: locate(outcome.mappingLine, 1).line };
	}
	return outcome;
}

/**
 * Parses `source` with `blobl --file` (AD-21), stdin closed, so nothing is mapped. The temporary
 * file lives in `storageDir` (created when missing) and is removed on every path.
 */
export async function parseMapping(
	command: BloblangCommand,
	source: string,
	storageDir: string,
	deps: RunnerParseDependencies = {},
): Promise<BloblParseOutcome> {
	const file = path.join(storageDir, `bloblang-parse-${randomBytes(8).toString('hex')}.blobl`);
	try {
		await fs.promises.mkdir(storageDir, { recursive: true });
		await fs.promises.writeFile(file, source, 'utf8');
		const built = buildBloblCommandLine(command.state, file, command.settings);
		if (built.kind !== 'ok') {
			return { kind: 'other', message: describeArgsFailure(built) };
		}
		const timeoutMs = deps.timeoutMs ?? MAPPING_PARSE_TIMEOUT_MS;
		const outcome = await (deps.run ?? runProcess)([built.command], built.args, timeoutMs, spawnOptions(built, deps.cwd));
		switch (outcome.kind) {
			case 'notFound':
				return { kind: 'other', message: 'The Redpanda Connect binary was not found.' };
			case 'spawnError':
				return { kind: 'other', message: `Could not start Redpanda Connect: ${outcome.message}` };
			case 'timeout':
				return { kind: 'other', message: `blobl gave no result after ${outcome.timeoutMs / 1000} s; stopped.` };
			case 'exited':
				return parseBloblParseOutput(outcome.exitCode, outcome.stderr);
		}
	} catch (err) {
		return { kind: 'other', message: `Could not parse the mapping: ${errorText(err)}` };
	} finally {
		await remove(file);
	}
}

/** The child's env (the command line's, `NO_COLOR=1` included) and working directory. */
function spawnOptions(built: Extract<ArgsResult, { kind: 'ok' }>, cwd: string | undefined): SpawnOptions {
	return { env: built.env, ...(cwd !== undefined ? { cwd } : {}) };
}

async function remove(file: string): Promise<void> {
	try {
		await fs.promises.rm(file, { force: true });
	} catch {
		// Best effort: a leftover file in the extension's storage harms nothing.
	}
}
