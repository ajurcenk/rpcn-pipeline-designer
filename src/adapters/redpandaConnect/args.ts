// RedpandaConnect adapter: the lint/run argument builder bound to VS Code's settings (AD-9). Lint
// (AD-12) and Run (AD-13) get their `{ command, args, env }` here, so they pass identical
// `--resources` and `--env-file` arguments; the Bloblang test run and live parse (AD-21) build theirs
// in `bloblangRunner.ts` from the same settings (`commandSettings`). Resource files come from the
// `redpandaConnect.resourceFiles` setting only; nothing detects them (AD-9, AD-18). The command
// lines themselves are built in `commandLine.ts` (no `vscode`), the flags in `src/core/args`; this
// module reads and resolves the settings. It spawns nothing and never checks whether resource or env
// files exist (lint and run report missing files). Run a result as
// `runProcess([command], args, …, { env })`. The two settings are `resource`-scoped (ticket 4): each
// is read for the config the command is for, and a relative value its own workspace folder's
// settings define resolves against that folder; a workspace or user value against the first one.

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildLintArgs, buildRunArgs } from '../../core/args';
import { BinaryState, firstWorkspaceFolderPath, resolveSettingPath } from './binary';
import { HomeOf, userHomeLookup } from './userHome';
import {
	type ArgsFailure, type ArgsFiles, type ArgsResult, buildCommandLine, type CommandLine, type CommandSettings,
	describeArgsFailure, ENV_FILE_SETTING, type EnvFileResult, RESOURCE_FILES_SETTING,
} from './commandLine';

export type { ArgsFailure, ArgsFiles, ArgsResult, CommandLine, EnvFileResult };
export { describeArgsFailure, ENV_FILE_SETTING, RESOURCE_FILES_SETTING };

/** Everything the builder reads from the outside world, as plain values. */
export interface ArgsEnvironment {
	/** Raw `redpandaConnect.resourceFiles` value (may be malformed user input). */
	readonly resourceFilesSetting: unknown;
	/** Raw `redpandaConnect.envFile` value (may be malformed user input). */
	readonly envFileSetting: unknown;
	readonly homeDir: string;
	/** Other users' homes, for `~user` (story 2); `undefined` (Windows): `~` only. */
	readonly homeOf?: HomeOf;
	/** File-system path of the first workspace folder, if any. */
	readonly workspaceFolder: string | undefined;
	/** Per setting, the folder a value its folder's settings define resolves against (ticket 4); else `workspaceFolder`. */
	readonly settingFolders?: { readonly resourceFiles?: string; readonly envFile?: string };
	/** The environment children inherit; `NO_COLOR=1` is added on top. */
	readonly processEnv: NodeJS.ProcessEnv;
}

export interface ArgsRequest {
	/** Absolute target config paths. Lint: at least one. Run: exactly one. */
	readonly targets: readonly string[];
}

/** Builds the `lint` command line (the settings of its first target's folder, ticket 4). Never throws. */
export function buildLintCommand(state: BinaryState, request: ArgsRequest, env: ArgsEnvironment = defaultArgsEnvironment(targetUri(request))): ArgsResult {
	return buildCommandLine(buildLintArgs, state, request.targets, commandSettings(() => env));
}

/** Builds the `run` command line (the settings of its target's folder, ticket 4). Never throws. */
export function buildRunCommand(state: BinaryState, request: ArgsRequest, env: ArgsEnvironment = defaultArgsEnvironment(targetUri(request))): ArgsResult {
	return buildCommandLine(buildRunArgs, state, request.targets, commandSettings(() => env));
}

/** The first target as a URI, for reading its folder's settings; none for a relative one (reported as such). */
function targetUri(request: ArgsRequest): vscode.Uri | undefined {
	const first = request.targets[0];
	return first !== undefined && path.isAbsolute(first) ? vscode.Uri.file(first) : undefined;
}

/**
 * The settings as `commandLine.ts` reads them, from the environment `env` gives (called on each
 * read, so with `defaultArgsEnvironment` a read happens only when a builder needs it).
 */
export function commandSettings(env: () => ArgsEnvironment = defaultArgsEnvironment): CommandSettings {
	return {
		files: () => resolveArgsFiles(env()),
		envFile: () => resolveEnvFile(env()),
		processEnv: () => env().processEnv,
	};
}

/**
 * Reads the two settings for `resource` (the config a command is for; ticket 4), home dir,
 * workspace folder and `process.env`. Without `resource`, the window's values.
 */
export function defaultArgsEnvironment(resource?: vscode.Uri): ArgsEnvironment {
	const config = vscode.workspace.getConfiguration('redpandaConnect', resource);
	const folder = resource ? vscode.workspace.getWorkspaceFolder(resource) : undefined;
	const folderPath = folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
	return {
		resourceFilesSetting: config.get<unknown>('resourceFiles', []),
		envFileSetting: config.get<unknown>('envFile', ''),
		homeDir: os.homedir(),
		homeOf: userHomeLookup(),
		workspaceFolder: firstWorkspaceFolderPath(),
		settingFolders: {
			resourceFiles: definingFolder(config.inspect('resourceFiles'), folderPath),
			envFile: definingFolder(config.inspect('envFile'), folderPath),
		},
		processEnv: process.env,
	};
}

/**
 * The folder a setting's value resolves against (ticket 4): `folderPath` (the config's own folder)
 * when that folder's settings define the value; `undefined` (the first folder) for a workspace or user value.
 */
export function definingFolder(inspected: { readonly workspaceFolderValue?: unknown } | undefined, folderPath: string | undefined): string | undefined {
	return folderPath !== undefined && inspected?.workspaceFolderValue !== undefined ? folderPath : undefined;
}

type FileSetting = { readonly kind: 'path'; readonly path: string } | { readonly kind: 'relativeWithoutWorkspace' };

/**
 * The `binaryPath` path rules for a file setting: `~` expands, a relative path (including a bare
 * name such as `.env`, which for files is never a PATH lookup) resolves against the workspace folder.
 */
function resolveFileSettingPath(setting: string, env: ArgsEnvironment, folder: string | undefined): FileSetting {
	const { homeDir } = env;
	const workspaceFolder = folder ?? env.workspaceFolder;
	const resolved = resolveSettingPath(setting, homeDir, workspaceFolder, env.homeOf);
	if (resolved.kind !== 'command') {
		return resolved;
	}
	return workspaceFolder
		? { kind: 'path', path: path.resolve(workspaceFolder, resolved.name) }
		: { kind: 'relativeWithoutWorkspace' };
}

/**
 * The `redpandaConnect.resourceFiles` and `redpandaConnect.envFile` settings as absolute paths
 * (resources first, so a bad resource setting is the failure reported). Never throws.
 */
function resolveArgsFiles(env: ArgsEnvironment): ArgsFiles | ArgsFailure {
	const resourceFiles: string[] = [];
	for (const raw of stringList(env.resourceFilesSetting)) {
		const resolved = resolveFileSettingPath(raw, env, env.settingFolders?.resourceFiles);
		if (resolved.kind === 'relativeWithoutWorkspace') {
			return { kind: 'unusableSetting', setting: RESOURCE_FILES_SETTING, value: raw, reason: 'relativePathWithoutWorkspace' };
		}
		resourceFiles.push(path.normalize(resolved.path));
	}
	const envFile = resolveEnvFile(env);
	return envFile.kind === 'ok' ? { kind: 'ok', resourceFiles, envFile: envFile.path } : envFile;
}

/** The `redpandaConnect.envFile` setting as an absolute path (`undefined` when unset). Never throws. */
function resolveEnvFile(env: ArgsEnvironment): EnvFileResult {
	const envSetting = typeof env.envFileSetting === 'string' ? env.envFileSetting.trim() : '';
	if (!envSetting) {
		return { kind: 'ok', path: undefined };
	}
	const resolved = resolveFileSettingPath(envSetting, env, env.settingFolders?.envFile);
	if (resolved.kind === 'relativeWithoutWorkspace') {
		return { kind: 'unusableSetting', setting: ENV_FILE_SETTING, value: envSetting, reason: 'relativePathWithoutWorkspace' };
	}
	return { kind: 'ok', path: resolved.path };
}

/** The trimmed, non-empty strings of a `string[]` setting; anything else is ignored. */
function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter((v) => v.length > 0);
}
