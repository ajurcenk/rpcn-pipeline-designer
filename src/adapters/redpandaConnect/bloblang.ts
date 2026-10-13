// RedpandaConnect adapter: the Bloblang test run (AD-21, ticket 4.2). Writes the one-message config
// from `src/core/bloblangRun` to a temporary file under the extension's global storage, runs it
// with `run` through the shared builder (AD-9: the same `--resources` and `--env-file` as Run) and
// the one-shot spawn site with a timeout, deletes the file once the child exited, and reads the
// output with `parseRunOutput`. Never throws or rejects.

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parseRunOutput, testConfig } from '../../core/bloblangRun';
import type { BloblangProcessorKind, BloblangResult } from '../../shared/bloblangProtocol';
import { ArgsEnvironment, buildRunCommand, describeArgsFailure } from './args';
import { BinaryState } from './binary';
import { ProcessOutcome, runProcess, SpawnOptions } from './process';
import { errorText } from './text';

export const MAPPING_TEST_TIMEOUT_MS = 10_000;
/** The message of a test run with no usable binary; nothing is spawned (4.8 adds the real state). */
export const NO_BINARY_MESSAGE = 'No Redpanda Connect binary.';

export interface MappingTestDependencies {
	readonly argsEnvironment?: ArgsEnvironment;
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
 * Runs `source` as a `kind` processor once on `content`, with the current binary. The temporary
 * config lives in `storageDir` (created when missing) and is removed after the child exits.
 */
export async function runMappingTest(
	state: BinaryState,
	kind: BloblangProcessorKind,
	source: string,
	content: string,
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
		await fs.promises.writeFile(file, testConfig(kind, source, content), 'utf8');
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
				return done(parseRunOutput(outcome.exitCode, outcome.stdout, outcome.stderr));
		}
	} catch (err) {
		return done({ kind: 'error', message: errorText(err) });
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
