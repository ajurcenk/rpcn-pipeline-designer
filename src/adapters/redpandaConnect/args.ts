// RedpandaConnect adapter: the lint/run argument builder bound to VS Code's settings (AD-9). Lint
// (AD-12) and Run (AD-13) get their `{ command, args, env }` here, so they pass identical
// `--resources` and `--env-file` arguments; the Bloblang test run and live parse (AD-21) build theirs
// in `bloblangRunner.ts` from the same settings (`commandSettings`). Resource files come from the
// `redpandaConnect.resourceFiles` setting only; nothing detects them (AD-9, AD-18). The command
// lines themselves are built in `commandLine.ts` (no `vscode`), the flags in `src/core/args`; this
// module reads and resolves the settings. It spawns nothing and never checks whether resource or env
// files exist (lint and run report missing files). Run a result as
// `runProcess([command], args, …, { env })`.

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildLintArgs, buildRunArgs } from '../../core/args';
import { BinaryState, firstWorkspaceFolderPath, resolveSettingPath } from './binary';
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
	/** File-system path of the first workspace folder, if any. */
	readonly workspaceFolder: string | undefined;
	/** The environment children inherit; `NO_COLOR=1` is added on top. */
	readonly processEnv: NodeJS.ProcessEnv;
}

export interface ArgsRequest {
	/** Absolute target config paths. Lint: at least one. Run: exactly one. */
	readonly targets: readonly string[];
}

/** Builds the `lint` command line. Never throws. */
export function buildLintCommand(state: BinaryState, request: ArgsRequest, env: ArgsEnvironment = defaultArgsEnvironment()): ArgsResult {
	return buildCommandLine(buildLintArgs, state, request.targets, commandSettings(() => env));
}

/** Builds the `run` command line. Never throws. */
export function buildRunCommand(state: BinaryState, request: ArgsRequest, env: ArgsEnvironment = defaultArgsEnvironment()): ArgsResult {
	return buildCommandLine(buildRunArgs, state, request.targets, commandSettings(() => env));
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
function resolveFileSettingPath(setting: string, homeDir: string, workspaceFolder: string | undefined): FileSetting {
	const resolved = resolveSettingPath(setting, homeDir, workspaceFolder);
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
		const resolved = resolveFileSettingPath(raw, env.homeDir, env.workspaceFolder);
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
	const resolved = resolveFileSettingPath(envSetting, env.homeDir, env.workspaceFolder);
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
