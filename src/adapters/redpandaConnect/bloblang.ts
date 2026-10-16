// RedpandaConnect adapter: the Bloblang test run (AD-21, tickets 4.2, 4.7) and the live parse
// (ticket 4.5), bound to the extension: the binary state and the `redpandaConnect.resourceFiles` /
// `redpandaConnect.envFile` settings (AD-9: the same `--resources` and `--env-file` as Run). The
// orchestration itself (the temporary config or mapping file, the spawn with a timeout, reading the
// output and 4.8's classification of a lint stop through `blobl`) lives in `bloblangRunner.ts`, which
// has no `vscode` import (ticket 4.12: the corpus harness runs it in plain Node); this module reads
// the state and settings and delegates. Never throws or rejects.

import * as path from 'path';
import type { BloblParseOutcome } from '../../core/bloblangParse';
import type { BloblangProcessorKind, BloblangResult, InputMeta } from '../../shared/bloblangProtocol';
import { ArgsEnvironment, commandSettings } from './args';
import { BinaryState } from './binary';
import {
	type BloblangCommand, FilePosition, MAPPING_PARSE_TIMEOUT_MS, MAPPING_TEST_TIMEOUT_MS,
	parseMapping as parseWith, runMappingTest as runWith, RunFunction,
} from './bloblangRunner';

export { MAPPING_PARSE_TIMEOUT_MS, MAPPING_TEST_TIMEOUT_MS };
export type { FilePosition };
/** The message of a test run with no usable binary; nothing is spawned (4.8 adds the real state). */
export const NO_BINARY_MESSAGE = 'No Redpanda Connect binary.';

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
	readonly run?: RunFunction;
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
	return done(await runWith(commandOf(state, deps.argsEnvironment), kind, source, content, meta, storageDir, {
		...(deps.locate ? { locate: deps.locate } : {}),
		...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
		...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
		...(deps.run ? { run: deps.run } : {}),
	}));
}

export interface MappingParseDependencies {
	readonly argsEnvironment?: ArgsEnvironment;
	readonly timeoutMs?: number;
	readonly cwd?: string;
	readonly run?: RunFunction;
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
	return parseWith(commandOf(state, deps.argsEnvironment), source, storageDir, {
		...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
		...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
		...(deps.run ? { run: deps.run } : {}),
	});
}

/**
 * The runner's command: `state` and the settings of `argsEnvironment`, else VS Code's, read only
 * when the runner builds its command line (so a failing read gets the runner's message).
 */
function commandOf(state: BinaryState, argsEnvironment: ArgsEnvironment | undefined): BloblangCommand {
	return { state, settings: argsEnvironment ? commandSettings(() => argsEnvironment) : commandSettings() };
}
