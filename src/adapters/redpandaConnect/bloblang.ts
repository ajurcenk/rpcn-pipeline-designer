// RedpandaConnect adapter: the Bloblang test run (AD-21, tickets 4.2, 4.7). Writes the one-message config
// from `src/core/bloblangRun` to a temporary file under the extension's global storage, runs it
// with `run` through the shared builder (AD-9: the same `--resources` and `--env-file` as Run) and
// the one-shot spawn site with a timeout, deletes the file once the child exited, and reads the
// output with `parseRunOutput`. Never throws or rejects. Ticket 4.8 classifies the outcome: a run
// stopped by `Config lint error` is parsed with `blobl` (`parseMapping`), so a Bloblang parse error
// becomes `parseError` with the binary's mapping-relative position (the run's own lint positions are
// config-relative and unreliable, spike 4.1 Q1), and any other lint message stays `error`; the file
// positions of `parseError` and `failed` come from the caller's `locate` (4.3's position map). Beside it, the live parse (ticket 4.5):
// `parseMapping` writes the Bloblang to a temporary file the same way and runs `blobl --file` on
// it, stdin closed (parse only), read with `parseBloblParseOutput`.

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BloblParseOutcome, parseBloblParseOutput } from '../../core/bloblangParse';
import { parseRunOutput, testConfig, type RunOutcome } from '../../core/bloblangRun';
import type { BloblangProcessorKind, BloblangResult, InputMeta } from '../../shared/bloblangProtocol';
import { ArgsEnvironment, buildBloblCommand, buildRunCommand, describeArgsFailure } from './args';
import { BinaryState } from './binary';
import { ProcessOutcome, runProcess, SpawnOptions } from './process';
import { errorText } from './text';

export const MAPPING_TEST_TIMEOUT_MS = 10_000;
/** The live parse's timeout (4.5): one launch takes ~0.2 s, ~0.42 s through rpk (spike 4.1). */
export const MAPPING_PARSE_TIMEOUT_MS = 5_000;
/** The message of a test run with no usable binary; nothing is spawned (4.8 adds the real state). */
export const NO_BINARY_MESSAGE = 'No Redpanda Connect binary.';

/** A 1-based line and char of the YAML document (a `vscode.Position`'s line and character plus 1). */
export interface FilePosition {
	readonly line: number;
	readonly char: number;
}

export interface MappingTestDependencies {
	readonly argsEnvironment?: ArgsEnvironment;
	/**
	 * From the mapping's 1-based `line` and `char` to the document's (4.3's position map). Without
	 * it, the mapping's own position (as if the mapping were the whole file).
	 */
	readonly locate?: (line: number, char: number) => FilePosition;
	readonly timeoutMs?: number;
	/** The child's working directory (Run's: the workspace folder, else the file's folder). */
	readonly cwd?: string;
	readonly run?: (invocation: readonly string[], args: readonly string[], timeoutMs: number, options: SpawnOptions) => Promise<ProcessOutcome>;
}

export interface MappingTestOutcome {
	readonly result: BloblangResult;
	readonly durationMs: number;
	/** What ran it (`rpk connect 4.112.0`); `null` with no usable binary. */
	readonly binary: string | null;
}

/** The binary as the panel names it: `rpk connect 4.112.0`, `redpanda-connect 4.112.0`. */
export function binaryLabel(state: BinaryState): string | null {
	if (state.kind !== 'ok') {
		return null;
	}
	const [command, ...rest] = state.invocation;
	return [path.basename(command ?? state.path), ...rest, state.version].join(' ');
}

/**
 * Runs `source` as a `kind` processor once on `content` with metadata `meta`, with the current binary. The temporary
 * config lives in `storageDir` (created when missing) and is removed after the child exits.
 */
export async function runMappingTest(
	state: BinaryState,
	kind: BloblangProcessorKind,
	source: string,
	content: string,
	meta: InputMeta,
	storageDir: string,
	deps: MappingTestDependencies = {},
): Promise<MappingTestOutcome> {
	const started = Date.now();
	const binary = binaryLabel(state);
	const done = (result: BloblangResult): MappingTestOutcome => ({ result, durationMs: Date.now() - started, binary });
	if (state.kind !== 'ok') {
		return done({ kind: 'error', message: NO_BINARY_MESSAGE });
	}
	const file = path.join(storageDir, `bloblang-test-${randomBytes(8).toString('hex')}.yaml`);
	try {
		await fs.promises.mkdir(storageDir, { recursive: true });
		await fs.promises.writeFile(file, testConfig(kind, source, content, meta), 'utf8');
	} catch (err) {
		await remove(file);
		return done({ kind: 'error', message: `Could not write the test config: ${errorText(err)}` });
	}
	try {
		const built = buildRunCommand(state, { targets: [file] }, deps.argsEnvironment);
		if (built.kind !== 'ok') {
			return done({ kind: 'error', message: describeArgsFailure(built) });
		}
		const timeoutMs = deps.timeoutMs ?? MAPPING_TEST_TIMEOUT_MS;
		const outcome = await (deps.run ?? runProcess)([built.command], built.args, timeoutMs, {
			env: built.env,
			...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
		});
		switch (outcome.kind) {
			case 'notFound':
				return done({ kind: 'error', message: 'The Redpanda Connect binary was not found.' });
			case 'spawnError':
				return done({ kind: 'error', message: `Could not start Redpanda Connect: ${outcome.message}` });
			case 'timeout':
				return done({ kind: 'error', message: `No result after ${outcome.timeoutMs / 1000} s; stopped.` });
			case 'exited':
				return done(await classify(parseRunOutput(outcome.exitCode, outcome.stdout, outcome.stderr, { content, meta }), state, source, storageDir, deps));
		}
	} catch (err) {
		return done({ kind: 'error', message: errorText(err) });
	} finally {
		await remove(file);
	}
}

/**
 * A run outcome as the panel shows it (4.8): a lint stop is a `parseError` when `blobl` finds one
 * (its message, excerpt and mapping position, plus the file position), else `error` with the lint
 * message verbatim; a `failed` with a mapping line gets its file line.
 */
async function classify(
	outcome: RunOutcome,
	state: BinaryState,
	source: string,
	storageDir: string,
	deps: MappingTestDependencies,
): Promise<BloblangResult> {
	const locate = deps.locate ?? ((line: number, char: number): FilePosition => ({ line, char }));
	if (outcome.kind === 'lint') {
		const parsed = await parseMapping(state, source, storageDir, {
			...(deps.argsEnvironment ? { argsEnvironment: deps.argsEnvironment } : {}),
			...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
			...(deps.run ? { run: deps.run } : {}),
		});
		if (parsed.kind !== 'parseError') {
			return { kind: 'error', message: outcome.message };
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

export interface MappingParseDependencies {
	readonly argsEnvironment?: ArgsEnvironment;
	readonly timeoutMs?: number;
	readonly cwd?: string;
	readonly run?: (invocation: readonly string[], args: readonly string[], timeoutMs: number, options: SpawnOptions) => Promise<ProcessOutcome>;
}

/**
 * Parses `source` with the current binary's `blobl --file` (AD-21), stdin closed, so nothing is
 * mapped. The temporary file lives in `storageDir` (created when missing) and is removed on every
 * path. With no usable binary nothing is spawned (`other`); callers do not call it then.
 */
export async function parseMapping(
	state: BinaryState,
	source: string,
	storageDir: string,
	deps: MappingParseDependencies = {},
): Promise<BloblParseOutcome> {
	if (state.kind !== 'ok') {
		return { kind: 'other', message: NO_BINARY_MESSAGE };
	}
	const file = path.join(storageDir, `bloblang-parse-${randomBytes(8).toString('hex')}.blobl`);
	try {
		await fs.promises.mkdir(storageDir, { recursive: true });
		await fs.promises.writeFile(file, source, 'utf8');
		const built = buildBloblCommand(state, file, deps.argsEnvironment);
		if (built.kind !== 'ok') {
			return { kind: 'other', message: describeArgsFailure(built) };
		}
		const timeoutMs = deps.timeoutMs ?? MAPPING_PARSE_TIMEOUT_MS;
		const outcome = await (deps.run ?? runProcess)([built.command], built.args, timeoutMs, {
			env: built.env,
			...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
		});
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

async function remove(file: string): Promise<void> {
	try {
		await fs.promises.rm(file, { force: true });
	} catch {
		// Best effort: a leftover file in the extension's storage harms nothing.
	}
}
