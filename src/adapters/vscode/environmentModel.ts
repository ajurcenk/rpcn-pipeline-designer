// Pure (no `vscode` import): what the Environment view (ticket 31) shows for one config, from the
// four sources as plain values. The precedence is the commands' own (tickets 29 and 30): the
// `redpandaConnect.env` setting (its generated env file comes last, so it wins) over the
// `redpandaConnect.envFile` file over the secrets (process environment) over VS Code's environment.
// Each source's variable is `used` when the commands get its value, `overridden` when a stronger
// source sets the same name, `noValue` (a declared secret without a value on this machine) or
// `ignored` (an env file the binary rejects). VS Code's environment is listed for the names the
// config uses only. Every command's environment also gets `NO_COLOR=1` from the extension, over
// the secrets and VS Code's environment (the binary reads the env files after it): the `extension`
// source, listed when the config uses `NO_COLOR` or another source sets it. A name the config uses
// without a default that no source gives is missing.

import type { EnvFileProblem, EnvFileRead } from '../../core/envFileRead';
import type { EnvUse } from '../../core/envUsage';

export type EnvSource = 'setting' | 'envFile' | 'extension' | 'secret' | 'process';
/** Strongest first. */
export const PRECEDENCE: readonly EnvSource[] = ['setting', 'envFile', 'extension', 'secret', 'process'];
/** What the extension adds to every command's environment (`commandLine.ts`). */
export const EXTENSION_ENV: Readonly<Record<string, string>> = { NO_COLOR: '1' };
export type SettingLevel = 'user' | 'workspace' | 'folder';
export type VariableState = 'used' | 'overridden' | 'noValue' | 'ignored';

export interface EnvironmentInputs {
	/** The valid `redpandaConnect.env` variables, merged, each with the level whose value wins. */
	readonly setting: readonly { readonly name: string; readonly value: string; readonly level: SettingLevel }[];
	/** The declared secrets, with their value on this machine (if any). */
	readonly secrets: readonly { readonly name: string; readonly value: string | undefined }[];
	/** The resolved `redpandaConnect.envFile`: its path and how it reads (or why it can't be read). */
	readonly envFile?: { readonly path: string; readonly read: EnvFileRead | { readonly error: string } };
	/** Why `redpandaConnect.envFile` cannot be resolved (a relative path without a folder). */
	readonly envFileUnusable?: string;
	/** VS Code's environment (`process.env`). */
	readonly processEnv: Readonly<Record<string, string | undefined>>;
	/** The variables the config uses. */
	readonly usage: readonly EnvUse[];
}

export interface EnvironmentVariable {
	readonly source: EnvSource;
	readonly name: string;
	/** `undefined` for a secret without a value. */
	readonly value: string | undefined;
	readonly state: VariableState;
	/** The source whose value the commands get instead (`overridden` only). */
	readonly overriddenBy?: EnvSource;
	/** Whether the config uses the name. */
	readonly referenced: boolean;
	/** `setting` only: the level its value comes from. */
	readonly level?: SettingLevel;
	/** `envFile` only: the line that sets it. */
	readonly line?: number;
}

export interface EnvironmentGroup {
	readonly source: EnvSource;
	readonly variables: readonly EnvironmentVariable[];
}

export interface EnvironmentModel {
	/** One per source, strongest first; `extension` only when it has a variable. */
	readonly groups: readonly EnvironmentGroup[];
	/** The resolved env file, if one is set. */
	readonly envFilePath?: string;
	/** Why the env file is not (fully) used: unreadable, unresolvable, rejected or read only in part. */
	readonly envFileNote?: string;
	/** The used names (without a default) that no source gives, in the config's order. */
	readonly missing: readonly string[];
}

/** The note for a problem the binary has with the env file. Pure. */
export function envFileProblemNote(problem: EnvFileProblem): string {
	return problem.kind === 'rejected'
		? `The binary will not use this file: line ${problem.line} is rejected (${problem.reason}), so the commands fail.`
		: problem.keepsLine
			? `The binary stops reading this file at line ${problem.line}: the rest of that line and the lines after it are not set.`
			: `The binary stops reading this file at line ${problem.line}: that line and the ones after it are not set.`;
}

/** The view's model for one config. Pure. */
export function environmentModel(inputs: EnvironmentInputs): EnvironmentModel {
	const referenced = new Set(inputs.usage.map((u) => u.name));
	const read = inputs.envFile && !('error' in inputs.envFile.read) ? inputs.envFile.read : undefined;
	const fileRejected = read?.problem?.kind === 'rejected';
	const candidates: Record<EnvSource, Omit<EnvironmentVariable, 'state' | 'source' | 'referenced'>[]> = {
		setting: inputs.setting.map((v) => ({ name: v.name, value: v.value, level: v.level })),
		envFile: (read?.variables ?? []).map((v) => ({ name: v.name, value: v.value, line: v.line })),
		extension: [],
		secret: inputs.secrets.map((v) => ({ name: v.name, value: v.value })),
		process: inputs.usage
			.filter((u) => inputs.processEnv[u.name] !== undefined)
			.map((u) => ({ name: u.name, value: inputs.processEnv[u.name] })),
	};
	candidates.extension = Object.entries(EXTENSION_ENV)
		.filter(([name]) => referenced.has(name) || (['setting', 'envFile', 'secret'] as const).some((s) => candidates[s].some((v) => v.name === name)))
		.map(([name, value]) => ({ name, value }));
	const gives = (source: EnvSource, v: { value: string | undefined }) => v.value !== undefined && !(source === 'envFile' && fileRejected);
	const winner = new Map<string, EnvSource>();
	for (const source of PRECEDENCE) {
		for (const v of candidates[source]) {
			if (!winner.has(v.name) && gives(source, v)) {
				winner.set(v.name, source);
			}
		}
	}
	const groups = PRECEDENCE.filter((source) => source !== 'extension' || candidates.extension.length > 0).map((source): EnvironmentGroup => ({
		source,
		variables: candidates[source].map((v): EnvironmentVariable => {
			const won = winner.get(v.name);
			const state: VariableState = source === 'envFile' && fileRejected ? 'ignored'
				: v.value === undefined ? 'noValue'
					: won === source ? 'used' : 'overridden';
			return {
				...v,
				source,
				state,
				referenced: referenced.has(v.name),
				...(state === 'overridden' || (state === 'noValue' && won) ? { overriddenBy: won } : {}),
			};
		}),
	}));
	let envFileNote: string | undefined;
	if (inputs.envFileUnusable) {
		envFileNote = inputs.envFileUnusable;
	} else if (inputs.envFile && 'error' in inputs.envFile.read) {
		envFileNote = `The file cannot be read (${inputs.envFile.read.error}).`;
	} else if (read?.problem) {
		envFileNote = envFileProblemNote(read.problem);
	}
	return {
		groups,
		...(inputs.envFile ? { envFilePath: inputs.envFile.path } : {}),
		...(envFileNote ? { envFileNote } : {}),
		missing: inputs.usage.filter((u) => u.required && !winner.has(u.name)).map((u) => u.name),
	};
}
