// RedpandaConnect adapter: the shared lint/run argument builder (AD-9). Lint (AD-12) and Run
// (AD-13) both get their `{ command, args, env }` here, so they pass identical `--resources` and
// `--env-file` arguments. The flags themselves live in `src/core/args`. This module spawns nothing
// and never checks whether resource or env files exist (lint and run report missing files).

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ArgvInput, ArgvResult, buildLintArgs, buildRunArgs } from '../../core/args';
import { BinaryState, firstWorkspaceFolderPath, resolveSettingPath } from './binary';

export const RESOURCE_FILES_SETTING = 'redpandaConnect.resourceFiles';
export const ENV_FILE_SETTING = 'redpandaConnect.envFile';

/** Everything the builder reads from the outside world, as plain values. */
export interface ArgsEnvironment {
	/** Raw `redpandaConnect.resourceFiles` value (may be malformed user input). */
	readonly resourceFilesSetting: unknown;
	/** Raw `redpandaConnect.envFile` value (may be malformed user input). */
	readonly envFileSetting: unknown;
	readonly homeDir: string;
	/** File-system path of the first workspace folder, if any. */
	readonly workspaceFolder: string | undefined;
	/** The environment children inherit; `NO_COLOR=1` is added on top. */
	readonly processEnv: NodeJS.ProcessEnv;
}

export interface CommandLine {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
}

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
	/** A caller-supplied target or detected resource path is not absolute (a programming error upstream). */
	| { readonly kind: 'relativePath'; readonly role: 'target' | 'detectedResource'; readonly path: string };

export type ArgsResult = ({ readonly kind: 'ok' } & CommandLine) | ArgsFailure;

export interface ArgsRequest {
	/** Absolute target config paths. Lint: at least one. Run: exactly one. */
	readonly targets: readonly string[];
	/** Absolute resource files found by detection (AD-18); appended after the setting's entries. */
	readonly detectedResourceFiles?: readonly string[];
}

/** Builds the `lint` command line. Never throws. */
export function buildLintCommand(state: BinaryState, request: ArgsRequest, env: ArgsEnvironment = defaultArgsEnvironment()): ArgsResult {
	return buildCommand(buildLintArgs, state, request, env);
}

/** Builds the `run` command line. Never throws. */
export function buildRunCommand(state: BinaryState, request: ArgsRequest, env: ArgsEnvironment = defaultArgsEnvironment()): ArgsResult {
	return buildCommand(buildRunArgs, state, request, env);
}

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
		case 'relativePath':
			return `Internal error: ${failure.role === 'target' ? 'target' : 'detected resource'} path "${failure.path}" is not absolute.`;
	}
}

/** Reads the two settings, home dir, workspace folder and `process.env`. */
export function defaultArgsEnvironment(): ArgsEnvironment {
	const config = vscode.workspace.getConfiguration('redpandaConnect');
	return {
		resourceFilesSetting: config.get<unknown>('resourceFiles', []),
		envFileSetting: config.get<unknown>('envFile', ''),
		homeDir: os.homedir(),
		workspaceFolder: firstWorkspaceFolderPath(),
		processEnv: process.env,
	};
}

type FileSetting = { readonly kind: 'path'; readonly path: string } | { readonly kind: 'relativeWithoutWorkspace' };

/**
 * The `binaryPath` path rules for a file setting: `~` expands, a relative path (including a bare
 * name such as `.env`, which for files is never a PATH lookup) resolves against the workspace folder.
 */
export function resolveFileSettingPath(setting: string, homeDir: string, workspaceFolder: string | undefined): FileSetting {
	const resolved = resolveSettingPath(setting, homeDir, workspaceFolder);
	if (resolved.kind !== 'command') {
		return resolved;
	}
	return workspaceFolder
		? { kind: 'path', path: path.resolve(workspaceFolder, resolved.name) }
		: { kind: 'relativeWithoutWorkspace' };
}

function buildCommand(
	buildArgv: (input: ArgvInput) => ArgvResult,
	state: BinaryState,
	request: ArgsRequest,
	env: ArgsEnvironment,
): ArgsResult {
	if (state.kind !== 'ok') {
		return { kind: 'binaryUnavailable', state: state.kind };
	}

	for (const target of request.targets) {
		if (!path.isAbsolute(target)) {
			return { kind: 'relativePath', role: 'target', path: target };
		}
	}
	const detected = request.detectedResourceFiles ?? [];
	for (const resource of detected) {
		if (!path.isAbsolute(resource)) {
			return { kind: 'relativePath', role: 'detectedResource', path: resource };
		}
	}

	const resourceFiles: string[] = [];
	for (const raw of stringList(env.resourceFilesSetting)) {
		const resolved = resolveFileSettingPath(raw, env.homeDir, env.workspaceFolder);
		if (resolved.kind === 'relativeWithoutWorkspace') {
			return { kind: 'unusableSetting', setting: RESOURCE_FILES_SETTING, value: raw, reason: 'relativePathWithoutWorkspace' };
		}
		resourceFiles.push(path.normalize(resolved.path));
	}
	resourceFiles.push(...detected.map((p) => path.normalize(p)));

	let envFile: string | undefined;
	const envSetting = typeof env.envFileSetting === 'string' ? env.envFileSetting.trim() : '';
	if (envSetting) {
		const resolved = resolveFileSettingPath(envSetting, env.homeDir, env.workspaceFolder);
		if (resolved.kind === 'relativeWithoutWorkspace') {
			return { kind: 'unusableSetting', setting: ENV_FILE_SETTING, value: envSetting, reason: 'relativePathWithoutWorkspace' };
		}
		envFile = resolved.path;
	}

	const result = buildArgv({ invocation: state.invocation, targets: request.targets, resourceFiles, envFile });
	switch (result.kind) {
		case 'targetCount':
			return result;
		case 'noInvocation':
			return { kind: 'emptyInvocation' };
		case 'ok': {
			const [command, ...args] = result.argv;
			return { kind: 'ok', command, args, env: { ...env.processEnv, NO_COLOR: '1' } };
		}
	}
}

/** The trimmed, non-empty strings of a `string[]` setting; anything else is ignored. */
function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter((v) => v.length > 0);
}
