// RedpandaConnect adapter: the `redpandaConnect.env` setting (ticket 29) as an env file. Lint, Run,
// the live Bloblang parse and the test run pass it as their last `--env-file`, after
// `redpandaConnect.envFile`'s, so its variables win over that file's and over VS Code's environment
// (probed on 4.100.0 and 4.112.0: `--env-file` beats the process environment, the last of several
// wins). No `vscode` import: `args.ts` reads the setting, this module validates, encodes and writes.
//
// The file: `KEY="value"` lines with `\`, `"`, newline and carriage return escaped (probed: the
// binaries read each value back exactly, and `${…}` in a value is not expanded), in
// `<globalStorage>/env-setting/` (folder 0700, file 0600), named by an HMAC-SHA256 of its content
// keyed with a random 32-byte key kept in that folder (`key`, 0600, created once), so the same
// variables reuse one file, a change makes a new one, and the name (in every argv) cannot be used to
// confirm a guessed value offline. Files are written atomically (a temporary file renamed into
// place), so a file that exists is complete. Global storage is shared by every VS Code window, so
// at activation (`sweep`) only files that are not current in this window and are more than a day
// old go; `write` refreshes a file's mtime each time it returns it, so a file in use by any window
// is never a day old.
//
// A key must match `[A-Za-z_][A-Za-z0-9_]*` and a value be a string; others are left out and logged
// once per distinct setting value, naming the keys. Values are never logged or put in a message.

import { createHmac, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isEnvName } from '../../shared/bloblangProtocol';
import { ENV_SETTING } from './commandLine';

export { ENV_SETTING };
/** The folder under the extension's global storage that holds the generated files. */
export const ENV_SETTING_FOLDER = 'env-setting';

/**
 * Whether `name` is a valid variable name (`[A-Za-z_][A-Za-z0-9_]*`); `secretEnv.ts` (ticket 30)
 * shares it. The rule is the shared protocol's `isEnvName` (ticket 32: the test panel's names). Pure.
 */
export function isValidEnvName(name: string): boolean {
	return isEnvName(name);
}
const FILE = /^env-[0-9a-f]{64}\.env$/;
/** The HMAC key's file in the folder. */
export const KEY_FILE = 'key';
/** How old a file that is not current must be before the sweep removes it. */
export const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

export interface EnvSettingVariables {
	/** The valid variables, sorted by key. */
	readonly variables: readonly (readonly [string, string])[];
	/** The keys left out (a bad name or a value that is not a string), in the setting's order. */
	readonly invalid: readonly string[];
}

/** The valid variables of a raw setting value; anything but a plain object holds none. Pure. */
export function validateEnvSetting(raw: unknown): EnvSettingVariables {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return { variables: [], invalid: [] };
	}
	const variables: [string, string][] = [];
	const invalid: string[] = [];
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (isEnvName(key) && typeof value === 'string') {
			variables.push([key, value]);
		} else {
			invalid.push(key);
		}
	}
	variables.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return { variables, invalid };
}

/** One value in double quotes, with `\`, `"`, `\n` and `\r` escaped. Pure. */
export function encodeEnvValue(value: string): string {
	return `"${value.replace(/[\\"\n\r]/g, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : `\\${c}`))}"`;
}

/** The env file's content: one `KEY="value"` line per variable. Pure. */
export function encodeEnvFile(variables: readonly (readonly [string, string])[]): string {
	return variables.map(([key, value]) => `${key}=${encodeEnvValue(value)}\n`).join('');
}

/** The file name for a content: `env-<HMAC-SHA256(key, content)>.env`. Pure. */
export function envFileName(content: string, key: Buffer): string {
	return `env-${createHmac('sha256', key).update(content, 'utf8').digest('hex')}.env`;
}

/** The log line for the left-out keys of a setting value (names only, never values). */
export function invalidKeysLine(invalid: readonly string[]): string {
	return `${ENV_SETTING}: left out ${invalid.map((k) => JSON.stringify(k)).join(', ')}: a name must match [A-Za-z_][A-Za-z0-9_]* and a value be a string.`;
}

export type EnvSettingWrite =
	| { readonly kind: 'ok'; readonly path: string }
	| { readonly kind: 'failed'; readonly path: string; readonly reason: string };

/** The generated env files in one folder (`<globalStorage>/env-setting`). */
export class EnvSettingFiles {
	/** Contents already written (or found) this session, by content. */
	private readonly written = new Map<string, string>();
	/** Setting values whose left-out keys were logged. */
	private readonly reported = new Set<string>();
	/** The HMAC key, read (or created) once per session. */
	private key: Buffer | undefined;

	constructor(readonly dir: string, private readonly log: (line: string) => void = () => undefined) {}

	/** The folder for `storageDir` (`context.globalStorageUri.fsPath`). */
	static in(storageDir: string, log?: (line: string) => void): EnvSettingFiles {
		return new EnvSettingFiles(path.join(storageDir, ENV_SETTING_FOLDER), log);
	}

	/**
	 * Logs the left-out keys of `raw` once per distinct value; returns its valid variables.
	 * (The dedup key is the value itself, kept in memory only.)
	 */
	variables(raw: unknown): EnvSettingVariables {
		const result = validateEnvSetting(raw);
		if (result.invalid.length > 0) {
			const key = stableKey(raw);
			if (!this.reported.has(key)) {
				this.reported.add(key);
				this.log(invalidKeysLine(result.invalid));
			}
		}
		return result;
	}

	/**
	 * Writes `content` (if no complete file holds it yet) and returns its path, its mtime refreshed.
	 * Never throws; an unreadable or uncreatable key is a failure too.
	 */
	write(content: string): EnvSettingWrite {
		const cached = this.written.get(content);
		if (cached !== undefined && touch(cached)) {
			return { kind: 'ok', path: cached };
		}
		let file = path.join(this.dir, KEY_FILE);
		let temp: string | undefined;
		try {
			fs.mkdirSync(path.dirname(this.dir), { recursive: true });
			try {
				fs.mkdirSync(this.dir, { mode: 0o700 });
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw err;
				}
			}
			fs.chmodSync(this.dir, 0o700);
			file = path.join(this.dir, envFileName(content, this.loadKey(true)));
			temp = path.join(this.dir, `.tmp-${randomBytes(8).toString('hex')}`);
			fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
			fs.renameSync(temp, file);
			temp = undefined;
			this.written.set(content, file);
			return { kind: 'ok', path: file };
		} catch (err) {
			if (temp) {
				try {
					fs.rmSync(temp, { force: true });
				} catch {
					// The folder itself is unusable (`ENOTDIR`): nothing was written.
				}
			}
			const reason = err instanceof Error ? err.message : String(err);
			return { kind: 'failed', path: file, reason };
		}
	}

	/**
	 * Removes the generated files whose content is not in `current` (none is, without a readable
	 * key) and leftover temporary files, each only when its mtime is more than a day before `now`:
	 * another window may be using a newer one. Called at activation only. Never throws; returns what
	 * it could not remove.
	 */
	sweep(current: Iterable<string>, now: number = Date.now()): string[] {
		let key: Buffer | undefined;
		try {
			key = this.loadKey(false);
		} catch {
			key = undefined;
		}
		const keep = new Set(key ? [...current].map((c) => envFileName(c, key)) : []);
		let names: string[];
		try {
			names = fs.readdirSync(this.dir);
		} catch {
			return [];
		}
		const failed: string[] = [];
		for (const name of names) {
			if (!((FILE.test(name) && !keep.has(name)) || name.startsWith('.tmp-'))) {
				continue;
			}
			const at = path.join(this.dir, name);
			try {
				if (now - fs.statSync(at).mtimeMs > SWEEP_AGE_MS) {
					fs.rmSync(at, { force: true });
				}
			} catch {
				failed.push(name);
			}
		}
		return failed;
	}

	/**
	 * The HMAC key, cached for the session: read from the folder's `key` file, or (with `create`)
	 * created once, atomically (written to a temporary file with `wx`, then linked into place, so a
	 * racing window either wins or reads the complete key). Throws when it cannot be read or created;
	 * without `create`, a missing key is `undefined`.
	 */
	private loadKey(create: true): Buffer;
	private loadKey(create: false): Buffer | undefined;
	private loadKey(create: boolean): Buffer | undefined {
		if (this.key) {
			return this.key;
		}
		const keyFile = path.join(this.dir, KEY_FILE);
		const read = (): Buffer | undefined => {
			try {
				const key = fs.readFileSync(keyFile);
				if (key.length !== 32) {
					throw new Error(`${keyFile} is not a 32-byte key.`);
				}
				return key;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
					return undefined;
				}
				throw err;
			}
		};
		let key = read();
		if (!key && create) {
			const temp = path.join(this.dir, `.tmp-${randomBytes(8).toString('hex')}`);
			try {
				fs.writeFileSync(temp, randomBytes(32), { mode: 0o600, flag: 'wx' });
				try {
					fs.linkSync(temp, keyFile);
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
						throw err;
					}
				}
			} finally {
				try {
					fs.rmSync(temp, { force: true });
				} catch {
					// Nothing to clean up.
				}
			}
			key = read();
			if (!key) {
				throw new Error(`${keyFile} could not be created.`);
			}
		}
		this.key = key;
		return key;
	}
}

/** The content for a raw setting value, or `undefined` when it holds no valid variable. Pure. */
export function envSettingContent(raw: unknown): string | undefined {
	const { variables } = validateEnvSetting(raw);
	return variables.length > 0 ? encodeEnvFile(variables) : undefined;
}

/** Sets a file's mtime to now; `false` when it is gone (or can't be touched). */
function touch(file: string): boolean {
	try {
		const now = new Date();
		fs.utimesSync(file, now, now);
		return true;
	} catch {
		return false;
	}
}

function stableKey(raw: unknown): string {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return JSON.stringify(raw) ?? String(raw);
	}
	const entries = Object.entries(raw as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return JSON.stringify(entries);
}

let active: EnvSettingFiles | undefined;

/** Sets the files the extension's commands write to (at activation). */
export function setActiveEnvSettingFiles(files: EnvSettingFiles | undefined): void {
	active = files;
}

/** The files set at activation; `undefined` before (or outside the extension). */
export function activeEnvSettingFiles(): EnvSettingFiles | undefined {
	return active;
}
