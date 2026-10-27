// RedpandaConnect adapter: the one place lint, run and `blobl` command lines are built from a
// binary state and the resolved settings (AD-9), and why one can't be built, with its message. No
// `vscode` import (ticket 4.12): `args.ts` binds it to VS Code's settings, and `bloblangRunner.ts`
// (the Bloblang orchestration the corpus harness runs in plain Node) uses it as is. The settings are
// read through `CommandSettings`, lazily and in the order the checks need them, so a bad setting is
// reported only once the binary and the targets are fine. Never throws unless a settings read does.

import * as path from 'path';
import { type ArgvInput, type ArgvResult, buildBloblArgs } from '../../core/args';
import type { BinaryState } from './binary';

export const RESOURCE_FILES_SETTING = 'redpandaConnect.resourceFiles';
export const ENV_FILE_SETTING = 'redpandaConnect.envFile';
export const ENV_SETTING = 'redpandaConnect.env';

export type ArgsFailure =
	/** `binaryState` is not `ok`. */
	| { readonly kind: 'binaryUnavailable'; readonly state: BinaryState['kind'] }
	/** `binaryState` is `ok` but its invocation is empty (should not happen). */
	| { readonly kind: 'emptyInvocation' }
	/** Lint got no target, or run did not get exactly one. */
	| { readonly kind: 'targetCount'; readonly expected: 'atLeastOne' | 'exactlyOne'; readonly actual: number }
	/** A setting value cannot be turned into an absolute path. */
	| {
		readonly kind: 'unusableSetting';
		readonly setting: typeof RESOURCE_FILES_SETTING | typeof ENV_FILE_SETTING;
		readonly value: string;
		readonly reason: 'relativePathWithoutWorkspace';
	}
	/**
	 * The env file generated from `redpandaConnect.env` (ticket 29) could not be written; the command
	 * does not run (the user's variables are never dropped silently). `reason` never holds a value.
	 */
	| { readonly kind: 'envSettingUnwritable'; readonly path: string | undefined; readonly reason: string }
	/** A caller-supplied target path is not absolute (a programming error upstream). */
	| { readonly kind: 'relativePath'; readonly role: 'target'; readonly path: string };

/** The output-channel line for a failure. */
export function describeArgsFailure(failure: ArgsFailure): string {
	switch (failure.kind) {
		case 'binaryUnavailable':
			return `Redpanda Connect binary is unavailable (${failure.state}).`;
		case 'targetCount':
			return failure.expected === 'atLeastOne'
				? 'Lint needs at least one file.'
				: `Run needs exactly one file, got ${failure.actual}.`;
		case 'emptyInvocation':
			return 'Internal error: the Redpanda Connect binary state has an empty invocation.';
		case 'unusableSetting':
			return `${failure.setting} "${failure.value}" is a relative path, but no workspace folder is open.`;
		case 'envSettingUnwritable':
			return failure.path === undefined
				? `${ENV_SETTING}: the variables could not be written to an env file: ${failure.reason}`
				: `${ENV_SETTING}: the variables could not be written to ${failure.path}: ${failure.reason}`;
		case 'relativePath':
			return `Internal error: target path "${failure.path}" is not absolute.`;
	}
}

/** The two file settings as absolute paths. */
export interface ArgsFiles {
	readonly kind: 'ok';
	/** `--resources` paths, normalized, in the setting's order. */
	readonly resourceFiles: readonly string[];
	/** The `--env-file` path; `undefined` when unset. */
	readonly envFile: string | undefined;
}

/** The env file setting as an absolute path (`undefined` when unset). */
export type EnvFileResult = { readonly kind: 'ok'; readonly path: string | undefined } | ArgsFailure;

/** Where the builders read the settings and the children's environment from, when they need them. */
export interface CommandSettings {
	/** Both file settings (lint and run). */
	readonly files: () => ArgsFiles | ArgsFailure;
	/** The env file setting only (`blobl` takes no `--resources`). */
	readonly envFile: () => EnvFileResult;
	/**
	 * The env file generated from `redpandaConnect.env` (ticket 29), written on the call; passed as the
	 * last `--env-file`. Absent (the corpus harness) or `path: undefined` (the setting is empty): none.
	 */
	readonly settingEnvFile?: () => EnvFileResult;
	/** The environment children inherit; `NO_COLOR=1` is added on top. */
	readonly processEnv: () => NodeJS.ProcessEnv;
}

export interface CommandLine {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
}

export type ArgsResult = ({ readonly kind: 'ok' } & CommandLine) | ArgsFailure;

/**
 * The `lint` or `run` command line (`buildArgv` is `buildLintArgs` or `buildRunArgs`): the binary,
 * then the targets (absolute), then the settings, then the argv.
 */
export function buildCommandLine(
	buildArgv: (input: ArgvInput) => ArgvResult,
	state: BinaryState,
	targets: readonly string[],
	settings: CommandSettings,
): ArgsResult {
	if (state.kind !== 'ok') {
		return { kind: 'binaryUnavailable', state: state.kind };
	}
	const relative = relativeTarget(targets);
	if (relative) {
		return relative;
	}
	const files = settings.files();
	if (files.kind !== 'ok') {
		return files;
	}
	const generated = settingEnvFile(settings);
	if (generated.kind !== 'ok') {
		return generated;
	}
	const result = buildArgv({
		invocation: state.invocation, targets, resourceFiles: files.resourceFiles, envFiles: [files.envFile, generated.path], platform: process.platform,
	});
	return result.kind === 'ok' ? commandLine(result.argv, settings) : result;
}

/**
 * The `blobl --file <mappingFile>` command line of the live parse (AD-21, ticket 4.5), with the same
 * `--env-file`s (`envFile`'s, then `redpandaConnect.env`'s generated one) and `NO_COLOR` as lint and run.
 */
export function buildBloblCommandLine(state: BinaryState, mappingFile: string, settings: CommandSettings): ArgsResult {
	if (state.kind !== 'ok') {
		return { kind: 'binaryUnavailable', state: state.kind };
	}
	const relative = relativeTarget([mappingFile]);
	if (relative) {
		return relative;
	}
	const envFile = settings.envFile();
	if (envFile.kind !== 'ok') {
		return envFile;
	}
	const generated = settingEnvFile(settings);
	if (generated.kind !== 'ok') {
		return generated;
	}
	const result = buildBloblArgs({ invocation: state.invocation, mappingFile, envFiles: [envFile.path, generated.path] });
	return result.kind === 'ok' ? commandLine(result.argv, settings) : result;
}

/** The generated env file of `redpandaConnect.env`, if the settings provide one. */
function settingEnvFile(settings: CommandSettings): EnvFileResult {
	return settings.settingEnvFile ? settings.settingEnvFile() : { kind: 'ok', path: undefined };
}

/** The failure for the first target that is not absolute, if any. */
function relativeTarget(targets: readonly string[]): ArgsFailure | undefined {
	const target = targets.find((t) => !path.isAbsolute(t));
	return target === undefined ? undefined : { kind: 'relativePath', role: 'target', path: target };
}

/** A built argv as a command line whose child env carries `NO_COLOR=1`. */
function commandLine(argv: readonly string[], settings: CommandSettings): ArgsResult {
	const [command, ...args] = argv;
	return { kind: 'ok', command, args, env: { ...settings.processEnv(), NO_COLOR: '1' } };
}
