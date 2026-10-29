// RedpandaConnect adapter: secret environment variables (ticket 30). The `redpandaConnect.secretEnv`
// setting (resource-scoped, a list of names, safe to commit) declares them; their values live in VS
// Code's secret storage on this machine, one entry per workspace folder (or for the window when the
// config is in no folder), under `redpandaConnect.secret:<folder URI or "window">:<NAME>`. The
// `vscode` side (`src/adapters/vscode/secrets.ts`) loads the values of the declared names into a
// `SecretValues` at activation and on every change, so lint, Run, the live Bloblang parse and the
// test run build their environment synchronously: `args.ts` adds each declared secret that has a
// value to the child's process environment (never a file, never an argv). A name the `env` setting
// or the env file also sets is still passed: the binary's own precedence (`--env-file` beats the
// process environment) lets their value win; that is logged once, naming the variable and the
// winning source. A declared name with no value here is logged once per name and folder. No value
// is ever logged or put in a message, and `maskSecrets` replaces loaded values in text from the
// binary (output lines, messages, the test panel's error results). No `vscode` import.

import * as fs from 'fs';
import { readEnvFile } from '../../core/envFileRead';
import { ENV_FILE_SETTING, ENV_SETTING } from './commandLine';
import { isValidEnvName } from './envSetting';

export const SECRET_ENV_SETTING = 'redpandaConnect.secretEnv';
/** The commands (their palette titles are in `package.json`). */
export const SET_SECRET_COMMAND = 'redpandaConnect.setSecret';
export const REMOVE_SECRET_COMMAND = 'redpandaConnect.removeSecret';
export const CLEAR_SECRETS_COMMAND = 'redpandaConnect.clearSecrets';
export const SET_SECRET_TITLE = 'Redpanda Connect: Set secret variable';
/** The scope of a config in no workspace folder. */
export const WINDOW_SCOPE = 'window';
const KEY_PREFIX = 'redpandaConnect.secret:';
/** What a secret value in text is replaced with. */
export const SECRET_MASK = '•••••';
/** Values shorter than this are not masked (they would mask ordinary text). */
export const MIN_MASKED_LENGTH = 4;
/** Logged once when a command starts before the first load of the secrets has finished. */
export const STILL_LOADING_LINE = `${SECRET_ENV_SETTING}: the secrets are still loading, so this command runs without them.`;

/** `text` with each of `values` that is `MIN_MASKED_LENGTH` or longer replaced by `SECRET_MASK`. Pure. */
export function maskSecrets(text: string, values: Iterable<string>): string {
	const masked = [...new Set(values)].filter((v) => v.length >= MIN_MASKED_LENGTH).sort((a, b) => b.length - a.length);
	return masked.reduce((out, value) => out.split(value).join(SECRET_MASK), text);
}

/** The secret storage key of `name` in `scope` (a folder URI string, or `WINDOW_SCOPE`). Pure. */
export function secretKey(scope: string, name: string): string {
	return `${KEY_PREFIX}${scope}:${name}`;
}

/** Whether a secret storage key is one of ours. Pure. */
export function isSecretKey(key: string): boolean {
	return key.startsWith(KEY_PREFIX);
}

/** The scope and name of one of our keys (the name is after the last `:`). Pure. */
export function parseSecretKey(key: string): { readonly scope: string; readonly name: string } | undefined {
	if (!isSecretKey(key)) {
		return undefined;
	}
	const rest = key.slice(KEY_PREFIX.length);
	const at = rest.lastIndexOf(':');
	return at <= 0 ? undefined : { scope: rest.slice(0, at), name: rest.slice(at + 1) };
}

/** Why a name typed in "Set secret variable" is refused; `undefined` when it is fine. Pure. */
export function secretNameProblem(name: string): string | undefined {
	return isValidEnvName(name) ? undefined : 'A name must match [A-Za-z_][A-Za-z0-9_]*.';
}

export interface DeclaredSecretNames {
	/** The valid names, in the setting's order, without duplicates. */
	readonly names: readonly string[];
	/** The entries left out (not a string, or not a valid name), as strings. */
	readonly invalid: readonly string[];
}

/** The declared names of a raw `secretEnv` value; anything but an array declares none. Pure. */
export function declaredSecretNames(raw: unknown): DeclaredSecretNames {
	if (!Array.isArray(raw)) {
		return { names: [], invalid: [] };
	}
	const names: string[] = [];
	const invalid: string[] = [];
	for (const entry of raw as unknown[]) {
		if (typeof entry === 'string' && isValidEnvName(entry)) {
			if (!names.includes(entry)) {
				names.push(entry);
			}
		} else {
			invalid.push(typeof entry === 'string' ? entry : JSON.stringify(entry) ?? String(entry));
		}
	}
	return { names, invalid };
}

/**
 * The names an env file's content sets, as the binary reads it (`envFileRead.ts`, re-probed
 * 2026-10-28): `NAME=…` and `NAME = …` are applied; reading stops at a line starting with a space;
 * a file the binary rejects (`export NAME=`, `NAME: v`, …) sets none. Pure.
 */
export function envFileNames(content: string): Set<string> {
	const read = readEnvFile(content);
	return new Set(read.problem?.kind === 'rejected' ? [] : read.variables.map((v) => v.name));
}

/** The log line for a declared name without a value here (the name only). */
export function noValueLine(name: string, scopeLabel: string): string {
	return `${SECRET_ENV_SETTING}: ${name} has no value on this machine for ${scopeLabel}, so commands run without it; set it with "${SET_SECRET_TITLE}".`;
}

/**
 * Ticket 38: the license variables, which the binary's license lookup reads from its process
 * environment only (never from an `--env-file`).
 */
export const LICENSE_ENV_NAMES: ReadonlySet<string> = new Set(['REDPANDA_LICENSE', 'REDPANDA_LICENSE_FILEPATH']);

/**
 * The log line for a secret another source also sets (the names only). For a license variable
 * (ticket 38) the other source wins for `${NAME}` only: the license uses the secret.
 */
export function clashLine(name: string, winner: string, scopeLabel: string): string {
	return LICENSE_ENV_NAMES.has(name)
		? `${SECRET_ENV_SETTING}: ${name} is also set by ${winner}, whose value wins for \${${name}} in configs for ${scopeLabel}; the license uses the secret (the binary reads the license from its process environment only).`
		: `${SECRET_ENV_SETTING}: ${name} is also set by ${winner}, whose value wins over the secret for ${scopeLabel}.`;
}

/** The log line for left-out `secretEnv` entries. */
export function invalidNamesLine(invalid: readonly string[]): string {
	return `${SECRET_ENV_SETTING}: left out ${invalid.map((n) => JSON.stringify(n)).join(', ')}: a name must match [A-Za-z_][A-Za-z0-9_]*.`;
}

/** What a command's environment needs to add the secrets of its config. */
export interface SecretEnvRequest {
	/** The config's folder URI string, or `WINDOW_SCOPE`. */
	readonly scope: string;
	/** How log lines name the scope (`folder "b"`, `this window`). */
	readonly scopeLabel: string;
	/** Raw `redpandaConnect.secretEnv` value for the config (may be malformed user input). */
	readonly declared: unknown;
	/** The names the `redpandaConnect.env` setting sets for the config. */
	readonly envSettingNames: ReadonlySet<string>;
	/** The resolved `redpandaConnect.envFile` path, if any; read for its names only. */
	readonly envFile: string | undefined;
}

/**
 * The secret values this window knows, by storage key, kept in memory so a command reads them
 * synchronously. Filled by the `vscode` side; read by `args.ts`.
 */
export class SecretValues {
	private values = new Map<string, string>();
	private readonly reported = new Set<string>();
	private isLoaded = false;

	constructor(private readonly log: (line: string) => void = () => undefined) {}

	/** Whether the first load finished (before it, a missing value is not logged). */
	get loaded(): boolean {
		return this.isLoaded;
	}

	get(scope: string, name: string): string | undefined {
		return this.values.get(secretKey(scope, name));
	}

	/** Sets (or, with `undefined`, removes) one value. */
	put(key: string, value: string | undefined): void {
		if (value === undefined) {
			this.values.delete(key);
		} else {
			this.values.set(key, value);
		}
	}

	/** Replaces every value (a finished load); `true` when anything changed. */
	replace(values: ReadonlyMap<string, string>): boolean {
		const changed = values.size !== this.values.size || [...values].some(([k, v]) => this.values.get(k) !== v);
		this.values = new Map(values);
		this.isLoaded = true;
		return changed;
	}

	/** The keys held now. */
	keys(): string[] {
		return [...this.values.keys()];
	}

	/** `text` with the loaded values masked: those of `scope` (a folder URI string, or `WINDOW_SCOPE`), else all. */
	mask(text: string, scope?: string): string {
		const values = scope === undefined
			? [...this.values.values()]
			: [...this.values].filter(([key]) => parseSecretKey(key)?.scope === scope).map(([, value]) => value);
		return maskSecrets(text, values);
	}

	/**
	 * The variables to add to a command's process environment: each declared name with a value here.
	 * Logs (once each) left-out entries, names without a value, names the `env` setting or the env
	 * file also sets (their value wins in the binary) and a command before the first load. Never
	 * throws; an unreadable env file has no names.
	 */
	environment(request: SecretEnvRequest): Record<string, string> {
		const { names, invalid } = declaredSecretNames(request.declared);
		if (invalid.length > 0) {
			this.once(`invalid|${JSON.stringify(invalid)}`, () => invalidNamesLine(invalid));
		}
		const env: Record<string, string> = {};
		if (!this.isLoaded && names.length > 0) {
			this.once('loading', () => STILL_LOADING_LINE);
		}
		let fileNames: Set<string> | undefined;
		for (const name of names) {
			const value = this.get(request.scope, name);
			if (value === undefined) {
				if (this.isLoaded) {
					this.once(`none|${request.scope}|${name}`, () => noValueLine(name, request.scopeLabel));
				}
				continue;
			}
			env[name] = value;
			if (request.envSettingNames.has(name)) {
				this.once(`clash|${request.scope}|${name}|env`, () => clashLine(name, ENV_SETTING, request.scopeLabel));
				continue;
			}
			fileNames ??= readEnvFileNames(request.envFile);
			if (fileNames.has(name)) {
				this.once(`clash|${request.scope}|${name}|file`, () => clashLine(name, `the ${ENV_FILE_SETTING} file`, request.scopeLabel));
			}
		}
		return env;
	}

	private once(key: string, line: () => string): void {
		if (!this.reported.has(key)) {
			this.reported.add(key);
			this.log(line());
		}
	}
}

function readEnvFileNames(file: string | undefined): Set<string> {
	if (file === undefined) {
		return new Set();
	}
	try {
		return envFileNames(fs.readFileSync(file, 'utf8'));
	} catch {
		return new Set();
	}
}

let active: SecretValues | undefined;

/** Sets the values the extension's commands read (at activation). */
export function setActiveSecretValues(values: SecretValues | undefined): void {
	active = values;
}

/** The values set at activation; `undefined` before (or outside the extension). */
export function activeSecretValues(): SecretValues | undefined {
	return active;
}
