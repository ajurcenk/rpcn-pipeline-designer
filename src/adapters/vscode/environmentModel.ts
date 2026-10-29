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

// --- Ticket 38: where the binary takes the Enterprise license from ---

/** The license string the binary reads first. */
export const LICENSE_VAR = 'REDPANDA_LICENSE';
/** The license file the binary reads when `LICENSE_VAR` is not set. */
export const LICENSE_FILE_VAR = 'REDPANDA_LICENSE_FILEPATH';
/** The file the binary reads when neither variable is set (Linux and macOS). */
export const DEFAULT_LICENSE_FILE = '/etc/redpanda/redpanda.license';
/** The sources the binary's license lookup reads: its process environment, strongest first. */
export const LICENSE_SOURCES = ['secret', 'process'] as const;
export type LicenseEnvSource = typeof LICENSE_SOURCES[number];

export type LicenseSource =
	| { readonly kind: 'string'; readonly from: LicenseEnvSource }
	| { readonly kind: 'file'; readonly path: string; readonly from: LicenseEnvSource | 'default' }
	| { readonly kind: 'none' };

export interface LicenseSourceInfo {
	readonly source: LicenseSource;
	/**
	 * The license variables `redpandaConnect.env` or the env file set: the binary reads them for
	 * `${NAME}` only, not for its license (it looks the license up in its process environment before
	 * it reads any `--env-file`; probed 2026-10-29 on 4.100.0 and 4.112.0).
	 */
	readonly notRead: readonly { readonly name: string; readonly source: 'setting' | 'envFile' }[];
	/**
	 * The values to mask in text: the license string from any source, and a license file path from a
	 * secret or VS Code's environment (sources the view masks).
	 */
	readonly values: readonly string[];
}

/**
 * Where the binary would take the license from for a config, from the view's inputs: `REDPANDA_LICENSE`
 * from the strongest process-environment source that sets it (a secret over VS Code's environment, as
 * the commands' environment is built), else `REDPANDA_LICENSE_FILEPATH` likewise, else the default
 * file when it exists. An empty value is not set (the binary ignores it). Pure.
 */
export function licenseSource(inputs: EnvironmentInputs, defaultFile: { readonly path: string; readonly exists: boolean }): LicenseSourceInfo {
	const secret = (name: string) => inputs.secrets.find((s) => s.name === name)?.value;
	const valueIn = (source: LicenseEnvSource, name: string) => (source === 'secret' ? secret(name) : inputs.processEnv[name]) || undefined;
	const strongest = (name: string) => LICENSE_SOURCES.find((s) => valueIn(s, name) !== undefined);
	const read = inputs.envFile && !('error' in inputs.envFile.read) ? inputs.envFile.read : undefined;
	const notRead: { name: string; source: 'setting' | 'envFile' }[] = [];
	const values: string[] = [];
	for (const name of [LICENSE_VAR, LICENSE_FILE_VAR]) {
		const inSetting = inputs.setting.find((v) => v.name === name)?.value;
		const inFile = read?.variables.filter((v) => v.name === name).pop()?.value;
		if (inSetting) {
			notRead.push({ name, source: 'setting' });
		}
		if (inFile) {
			notRead.push({ name, source: 'envFile' });
		}
		if (name === LICENSE_VAR) {
			values.push(...[inSetting, inFile, secret(name), inputs.processEnv[name]].filter((v): v is string => !!v));
		} else {
			values.push(...[secret(name), inputs.processEnv[name]].filter((v): v is string => !!v));
		}
	}
	const stringFrom = strongest(LICENSE_VAR);
	const fileFrom = strongest(LICENSE_FILE_VAR);
	const source: LicenseSource = stringFrom ? { kind: 'string', from: stringFrom }
		: fileFrom ? { kind: 'file', path: valueIn(fileFrom, LICENSE_FILE_VAR)!, from: fileFrom }
			: defaultFile.exists ? { kind: 'file', path: defaultFile.path, from: 'default' }
				: { kind: 'none' };
	return { source, notRead, values };
}
