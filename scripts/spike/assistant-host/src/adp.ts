// Spike 65: the ADP file, read as scripts/spike/adp-probe.mjs reads it (readEnvFile, readAdpAccess
// copied; keep the two in step). A regular file owned by you, mode 0600; anything else is refused
// before any request. The key is returned to the caller only, never logged.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const ADP_FILE = path.join(os.homedir(), '.config/rpcn-spike/adp.env');
export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface AdpAccess {
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly model: string;
	readonly headers: readonly (readonly [string, string])[];
}

/** Reads KEY=value lines from a file you own with mode 0600; refuses anything else. Keys lower-cased. */
export function readEnvFile(file: string, what: string): Record<string, string> {
	let st: fs.Stats;
	try { st = fs.lstatSync(file); } catch { throw new Error(`${what} file not found: ${file} (create it, mode 0600)`); }
	if (!st.isFile()) throw new Error(`${what} file is not a regular file (symlinks are refused): ${file} (put the file itself there)`);
	if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${what} file is not owned by you: ${file} (copy it into a file of your own)`);
	const mode = st.mode & 0o777;
	if (mode !== 0o600) throw new Error(`${what} file has mode ${mode.toString(8)}, must be 600: ${file} (run: chmod 600 ${file})`);
	const vals: Record<string, string> = {};
	for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!m) continue;
		let v = m[2].trim();
		if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
		vals[m[1].toLowerCase()] = v;
	}
	return vals;
}

/** `Name: value; Name2: value2` -> [[name, value], ...]; a pair without a colon is refused. */
export function parseHeaders(s: string | undefined, file: string): [string, string][] {
	const out: [string, string][] = [];
	for (const part of String(s ?? '').split(';')) {
		const p = part.trim();
		if (!p) continue;
		const i = p.indexOf(':');
		const name = i > 0 ? p.slice(0, i).trim() : '';
		if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new Error(`ADP file's ADP_HEADERS has a pair that is not \`Name: value\`: ${file} (separate pairs with ;)`);
		out.push([name, p.slice(i + 1).trim()]);
	}
	return out;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The ADP access (decision 2026-11-23): ADP_BASE_URL, ADP_API_KEY, ADP_MODEL, ADP_HEADERS. */
export function readAdpAccess(file: string = ADP_FILE): AdpAccess {
	const v = readEnvFile(file, 'ADP');
	const missing = ['adp_base_url', 'adp_api_key'].filter((k) => !v[k]);
	if (missing.length) throw new Error(`ADP file needs ${missing.map((k) => `${k.toUpperCase()}=`).join(', ')} line(s): ${file}`);
	let u: URL;
	try { u = new URL(v.adp_base_url); } catch { throw new Error(`ADP file's ADP_BASE_URL is not a URL: ${file}`); }
	if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) throw new Error(`ADP file's ADP_BASE_URL must be https (http only on localhost): ${file}`);
	if (u.username || u.password) throw new Error(`ADP file's ADP_BASE_URL must not hold a user or password: ${file}`);
	return { baseUrl: v.adp_base_url.replace(/\/+$/, ''), apiKey: v.adp_api_key, model: v.adp_model || DEFAULT_MODEL, headers: parseHeaders(v.adp_headers, file) };
}
