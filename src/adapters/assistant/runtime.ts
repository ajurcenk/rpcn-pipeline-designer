// Story 8.2 (AD-26): the assistant runtime, installed by the user. The extension never ships Anthropic's
// Claude Agent SDK or its Claude Code binary; the user installs them (Install assistant runtime…, after
// agreeing to Anthropic's terms: `src/adapters/vscode/assistantRuntime.ts`). This module, with no `vscode`
// import, does the work:
//   - the manifest (`assets/agent-runtime.json`, written by `scripts/gen-agent-runtime.mjs` from
//     package-lock.json): the pinned `sdkVersion`, the registry, and for the SDK and each platform package
//     its tarball's path, version and sha512 integrity;
//   - the runtime's state for this platform: `<root>/<sdkVersion>/node_modules/@anthropic-ai/…`, where
//     `<root>` is `<globalStorage>/agent-runtime`; nothing is ever looked up by module name (no ancestor
//     `node_modules`, no `NODE_PATH`);
//   - the download, over HTTPS (http only to a loopback registry, the tests' fake), through the agent the
//     caller builds (`registryAgent`: a proxy tunnel, extra CAs);
//   - the sha512 check of each tarball, before anything is unpacked;
//   - the unpacking: gzip'd ustar (npm's tarballs), each entry confined to the target folder (no absolute
//     path, no `..`, no link pointing outside, nothing through a link, no device), into a temporary folder
//     beside the runtime, swapped in by rename once complete;
//   - removal.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { Writable, type Duplex } from 'stream';
import * as tls from 'tls';
import * as zlib from 'zlib';
import { binaryName, SDK_PACKAGE } from './platform';

export interface RuntimePackage {
	readonly version: string;
	/** The tarball's path on the registry (`/@anthropic-ai/…/-/….tgz`). */
	readonly path: string;
	/** `sha512-<base64>`, from package-lock.json. */
	readonly integrity: string;
}

export interface RuntimeManifest {
	readonly sdkVersion: string;
	/** The registry's origin (`https://registry.npmjs.org`). */
	readonly registry: string;
	/** The SDK and every platform binary package, by name. */
	readonly packages: Readonly<Record<string, RuntimePackage>>;
}

/** The folder in the extension's global storage the runtime lives in. */
export const RUNTIME_FOLDER = 'agent-runtime';
/** Written into a version's folder last, before the swap: a folder with it is complete. */
export const RUNTIME_MARKER = 'runtime.json';
const EXACT = /^\d+\.\d+\.\d+$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The manifest from its parsed JSON; throws with what is wrong. */
export function parseManifest(v: unknown): RuntimeManifest {
	if (!isObject(v) || typeof v.sdkVersion !== 'string' || !EXACT.test(v.sdkVersion) || typeof v.registry !== 'string' || !isObject(v.packages)) {
		throw new Error('the assistant runtime manifest is malformed');
	}
	const packages: Record<string, RuntimePackage> = {};
	for (const [name, p] of Object.entries(v.packages)) {
		if (!isObject(p) || typeof p.version !== 'string' || typeof p.path !== 'string' || !p.path.startsWith('/') || typeof p.integrity !== 'string' || !SHA512.test(p.integrity)) {
			throw new Error(`the assistant runtime manifest's ${name} entry is malformed`);
		}
		packages[name] = { version: p.version, path: p.path, integrity: p.integrity };
	}
	if (packages[SDK_PACKAGE]?.version !== v.sdkVersion) {
		throw new Error(`the assistant runtime manifest has no ${SDK_PACKAGE}@${v.sdkVersion}`);
	}
	return { sdkVersion: v.sdkVersion, registry: v.registry.replace(/\/+$/, ''), packages };
}

/** The manifest in a file (`assets/agent-runtime.json`). */
export function readManifest(file: string): RuntimeManifest {
	return parseManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** This platform's binary package's name (`@anthropic-ai/claude-agent-sdk-linux-x64`). */
export function binaryPackage(platform: string): string {
	return `${SDK_PACKAGE}-${platform}`;
}

/** A package's folder in a runtime (or a `node_modules`-shaped) folder. */
export function packageDir(modules: string, name: string): string {
	return path.join(modules, ...name.split('/'));
}

/** What loading needs: the SDK's entry (`sdk.mjs`) and the Claude Code binary, at `version`. */
export interface RuntimeFiles {
	readonly version: string;
	readonly sdk: string;
	readonly binary: string;
}

export type RuntimeStatus =
	/** No binary package exists for this platform. */
	| { readonly kind: 'unavailable'; readonly platform: string }
	| { readonly kind: 'missing'; readonly platform: string }
	/** Another version is installed, not the pin. */
	| { readonly kind: 'outdated'; readonly platform: string; readonly installed: string }
	/** `dev`: the development override (the repository's `node_modules`, Development and Test only). */
	| { readonly kind: 'installed'; readonly platform: string; readonly files: RuntimeFiles; readonly dev: boolean };

export interface RuntimeStatusOptions {
	/** `<globalStorage>/agent-runtime`. */
	readonly root: string;
	readonly manifest: RuntimeManifest;
	/** The platform as the binary packages name it (`platformLabel`). */
	readonly platform: string;
	/** The development override: a `node_modules` folder (only ever passed in Development and Test). */
	readonly devModules?: string;
	/** Whether a file is there and executable (default: `fs`). */
	readonly executable?: (file: string) => boolean;
}

export function isExecutable(file: string): boolean {
	try {
		if (!fs.statSync(file).isFile()) {
			return false;
		}
		fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function versionAt(dir: string): string | undefined {
	try {
		const v = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version;
		return typeof v === 'string' ? v : undefined;
	} catch {
		return undefined;
	}
}

/** The SDK and the binary in a `node_modules`-shaped folder, at `version` (`undefined`: not all there). */
export function filesIn(modules: string, version: string, platform: string, executable: (file: string) => boolean = isExecutable): RuntimeFiles | undefined {
	const sdkDir = packageDir(modules, SDK_PACKAGE);
	const binDir = packageDir(modules, binaryPackage(platform));
	const sdk = path.join(sdkDir, 'sdk.mjs');
	const binary = path.join(binDir, binaryName(platform.split('-')[0]));
	if (versionAt(sdkDir) !== version || versionAt(binDir) !== version || !fs.existsSync(sdk) || !executable(binary)) {
		return undefined;
	}
	return { version, sdk, binary };
}

/** A version folder's marker: its version and platform (`undefined`: none, or not readable). */
function markerAt(dir: string): { readonly sdkVersion: string; readonly platform: string } | undefined {
	try {
		const m = JSON.parse(fs.readFileSync(path.join(dir, RUNTIME_MARKER), 'utf8')) as Record<string, unknown>;
		return typeof m.sdkVersion === 'string' && typeof m.platform === 'string' ? { sdkVersion: m.sdkVersion, platform: m.platform } : undefined;
	} catch {
		return undefined;
	}
}

/** The installed versions under `root` (complete folders only, whatever their version), newest name last. */
export function installedVersions(root: string): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch {
		return [];
	}
	return names.filter((n) => !n.startsWith('.') && markerAt(path.join(root, n))?.sdkVersion === n).sort(compareVersions);
}

/** Compares `x.y.z` versions by their numeric parts (anything else after them, as text). */
export function compareVersions(a: string, b: string): number {
	const pa = a.split('.').map((x) => parseInt(x, 10));
	const pb = b.split('.').map((x) => parseInt(x, 10));
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (Number.isNaN(pa[i]) ? -1 : pa[i] ?? -1) - (Number.isNaN(pb[i]) ? -1 : pb[i] ?? -1);
		if (d !== 0) {
			return d;
		}
	}
	return a < b ? -1 : a > b ? 1 : 0;
}

/** The runtime's state for this platform. */
export function runtimeStatus(options: RuntimeStatusOptions): RuntimeStatus {
	const { root, manifest, platform } = options;
	if (!manifest.packages[binaryPackage(platform)]) {
		return { kind: 'unavailable', platform };
	}
	const version = manifest.sdkVersion;
	const dir = path.join(root, version);
	const marker = markerAt(dir);
	const installed = marker?.sdkVersion === version && marker.platform === platform ? filesIn(path.join(dir, 'node_modules'), version, platform, options.executable) : undefined;
	if (installed) {
		return { kind: 'installed', platform, files: installed, dev: false };
	}
	if (options.devModules) {
		const dev = filesIn(options.devModules, version, platform, options.executable);
		if (dev) {
			return { kind: 'installed', platform, files: dev, dev: true };
		}
	}
	const other = installedVersions(root).filter((v) => v !== version);
	return other.length > 0 ? { kind: 'outdated', platform, installed: other[other.length - 1] } : { kind: 'missing', platform };
}

// ---------------------------------------------------------------------------------------------------
// The download.

/** Whether a registry origin may be used: `https:`, or `http:` on a loopback host; no credentials in it. */
export function usableRegistry(url: string): boolean {
	try {
		const u = new URL(url);
		return (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))) && u.username === '' && u.password === '';
	} catch {
		return false;
	}
}

export interface ProxyConfig {
	/** The proxy URL (`http.proxy`, else `HTTPS_PROXY` / `HTTP_PROXY`); empty or `undefined`: none. */
	readonly proxy?: string;
	/** Hosts not proxied (`NO_PROXY`, `http.noProxy`): a name, `.suffix` or `*.suffix`, `*` for all. */
	readonly noProxy?: readonly string[];
	/** `http.proxyStrictSSL` (default `true`): `false` accepts any certificate. */
	readonly strictSSL?: boolean;
	/** Extra CA certificates (PEM), such as `NODE_EXTRA_CA_CERTS`'s. */
	readonly ca?: readonly string[];
}

/** Whether `host` (and its port) is excluded from the proxy by `noProxy`. Loopback hosts never go through one. */
export function bypassesProxy(host: string, port: string, noProxy: readonly string[] = []): boolean {
	const name = host.toLowerCase().replace(/^\[|\]$/g, '');
	if (LOOPBACK.has(name)) {
		return true;
	}
	for (const raw of noProxy.flatMap((e) => e.split(','))) {
		const entry = raw.trim().toLowerCase();
		if (!entry) {
			continue;
		}
		if (entry === '*') {
			return true;
		}
		const [pattern, entryPort] = entry.includes(':') && !entry.startsWith('[') ? entry.split(':') : [entry, undefined];
		if (entryPort && entryPort !== port) {
			continue;
		}
		const suffix = pattern.replace(/^\*/, '');
		if (name === suffix.replace(/^\./, '') || (suffix.startsWith('.') && name.endsWith(suffix))) {
			return true;
		}
	}
	return false;
}

/** The proxy a request to `target` goes through (`undefined`: direct). */
export function proxyFor(target: URL, config: ProxyConfig): URL | undefined {
	if (!config.proxy) {
		return undefined;
	}
	const port = target.port || (target.protocol === 'https:' ? '443' : '80');
	if (bypassesProxy(target.hostname, port, config.noProxy)) {
		return undefined;
	}
	let proxy: URL;
	try {
		proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(config.proxy) ? config.proxy : `http://${config.proxy}`);
	} catch {
		throw new Error('the proxy setting is not a URL');
	}
	if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
		throw new Error(`the proxy scheme ${proxy.protocol.replace(/:$/, '')}:// is not supported (only http:// and https:// proxies)`);
	}
	return proxy;
}

/** The text of a proxy's refusal. */
export function proxyRefusedText(status: number | undefined): string {
	return `the proxy refused the connection (${status ?? 'no status'})`;
}

/**
 * An HTTPS agent whose connections are tunnelled through an HTTP(S) proxy with `CONNECT`. The handshake is
 * written on a plain socket (`net` / `tls`), and `download` sends its requests through `http.ClientRequest`
 * itself: VS Code's extension host patches `https.get` and, with `http.proxySupport: override`, replaces a
 * request's agent with its own, so the proxy chosen here would otherwise be dropped.
 */
export class TunnelAgent extends https.Agent {
	/** How long the proxy may take to answer `CONNECT` (`download` sets its idle timeout). */
	handshakeTimeoutMs = 60_000;

	constructor(readonly proxy: URL, options: https.AgentOptions) {
		super(options);
	}

	// Node's agent takes a connection from `createConnection`'s callback when it returns nothing.
	override createConnection(options: http.ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void): undefined {
		const host = (options.hostname ?? options.host ?? 'localhost').replace(/^\[|\]$/g, '');
		const port = Number(options.port ?? 443);
		const authority = `${host.includes(':') ? `[${host}]` : host}:${port}`;
		const proxyHost = this.proxy.hostname.replace(/^\[|\]$/g, '');
		const proxyPort = Number(this.proxy.port || (this.proxy.protocol === 'https:' ? 443 : 80));
		const auth = this.proxy.username
			? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`).toString('base64')}\r\n`
			: '';
		let done = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (err: Error | null, socket?: Duplex) => {
			if (!done) {
				done = true;
				if (timer) {
					clearTimeout(timer);
				}
				raw.off('end', onEnd);
				raw.off('close', onEnd);
				callback?.(err, socket as Duplex);
			}
		};
		const raw: net.Socket = this.proxy.protocol === 'https:'
			? tls.connect({ host: proxyHost, port: proxyPort, servername: net.isIP(proxyHost) ? undefined : proxyHost, rejectUnauthorized: this.options.rejectUnauthorized, ca: this.options.ca })
			: net.connect({ host: proxyHost, port: proxyPort });
		let head = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			head = Buffer.concat([head, chunk]);
			const end = head.indexOf('\r\n\r\n');
			if (end < 0) {
				if (head.length > 16_384) {
					raw.destroy();
					finish(new Error('the proxy answered CONNECT with no end of headers'));
				}
				return;
			}
			raw.off('data', onData);
			raw.off('error', onError);
			const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1', 0, end))?.[1]);
			if (status !== 200) {
				raw.destroy();
				finish(new Error(proxyRefusedText(Number.isFinite(status) ? status : undefined)));
				return;
			}
			const rest = head.subarray(end + 4);
			if (rest.length > 0) {
				raw.unshift(rest);
			}
			const tlsOptions = options as tls.ConnectionOptions;
			finish(null, tls.connect({
				rejectUnauthorized: this.options.rejectUnauthorized, ca: this.options.ca,
				...(tlsOptions.servername ? { servername: tlsOptions.servername } : net.isIP(host) ? {} : { servername: host }),
				// With a socket given, `host` is only what the certificate is checked against.
				host, socket: raw,
			}));
		};
		const onError = (err: Error) => finish(new Error(`the proxy could not be reached: ${err.message}`));
		const onEnd = () => {
			raw.destroy();
			finish(new Error('the proxy closed the connection before answering CONNECT'));
		};
		timer = setTimeout(() => {
			raw.destroy();
			finish(new Error('the proxy did not answer CONNECT in time'));
		}, this.handshakeTimeoutMs);
		raw.on('data', onData);
		raw.once('error', onError);
		raw.once('end', onEnd);
		raw.once('close', onEnd);
		raw.once(this.proxy.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
			raw.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
		});
		return undefined;
	}
}

/** The OS certificate store, where Node can read it (`tls.getCACertificates('system')`, Node 22.15+); else none. */
export function systemCertificates(): string[] {
	const get = (tls as unknown as { getCACertificates?: (type: string) => string[] }).getCACertificates;
	if (typeof get !== 'function') {
		return [];
	}
	try {
		return get('system');
	} catch {
		return [];
	}
}

/**
 * The agent for a request to `target`: through the proxy when one applies (a `TunnelAgent`, with the extra
 * CAs added to Node's own, and `strictSSL`); else a plain HTTPS agent with the same, which VS Code's own
 * proxy support may still replace (it then applies its own proxy resolution and certificates);
 * `undefined`: Node's default (a direct `http:` loopback request).
 */
export function registryAgent(target: URL, config: ProxyConfig): http.Agent | undefined {
	if (target.protocol !== 'https:') {
		return undefined;
	}
	const system = systemCertificates();
	const extra = [...system, ...(config.ca ?? [])];
	const options: https.AgentOptions = {
		keepAlive: false,
		rejectUnauthorized: config.strictSSL !== false,
		...(extra.length > 0 ? { ca: [...tls.rootCertificates, ...extra] } : {}),
	};
	const proxy = proxyFor(target, config);
	return proxy ? new TunnelAgent(proxy, options) : new https.Agent(options);
}

/** A download's progress: bytes so far, of `total` when the registry says. */
export type DownloadProgress = (bytes: number, total: number | undefined) => void;

export interface DownloadOptions {
	readonly signal: AbortSignal;
	/** The agent for a URL (`registryAgent`). */
	readonly agentFor: (url: URL) => http.Agent | undefined;
	readonly onProgress?: DownloadProgress;
	/** No data this long ends the download (default 60 s). */
	readonly idleTimeoutMs?: number;
}

export class RuntimeCancelled extends Error {
	constructor() {
		super('cancelled');
		this.name = 'RuntimeCancelled';
	}
}

const MAX_REDIRECTS = 3;

/** Downloads `url` into `file`; resolves with its `sha512-<base64>` integrity. */
export function download(url: string, file: string, options: DownloadOptions, redirects = 0): Promise<string> {
	return new Promise((resolve, reject) => {
		if (options.signal.aborted) {
			reject(new RuntimeCancelled());
			return;
		}
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			reject(new Error(`not a URL: ${url}`));
			return;
		}
		if (!usableRegistry(target.origin)) {
			reject(new Error(`${target.origin} is not an https:// registry`));
			return;
		}
		const agent = options.agentFor(target);
		if (agent instanceof TunnelAgent) {
			agent.handshakeTimeoutMs = options.idleTimeoutMs ?? 60_000;
		}
		const headers = { accept: 'application/octet-stream' };
		// Through a tunnel: a `ClientRequest` of its own (see `TunnelAgent`); otherwise `https.get`, which in VS Code
		// keeps its own proxy resolution and certificates.
		const request = agent instanceof TunnelAgent
			? new http.ClientRequest({
				protocol: 'https:', hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 443, path: `${target.pathname}${target.search}`,
				method: 'GET', headers, agent, _defaultAgent: https.globalAgent,
			} as http.ClientRequestArgs)
			: (target.protocol === 'https:' ? https.get : http.get)(target, { ...(agent ? { agent } : {}), headers });
		if (agent instanceof TunnelAgent) {
			request.end();
		}
		const onAbort = () => request.destroy(new RuntimeCancelled());
		options.signal.addEventListener('abort', onAbort, { once: true });
		const fail = (err: Error) => {
			options.signal.removeEventListener('abort', onAbort);
			reject(options.signal.aborted ? new RuntimeCancelled() : err);
		};
		request.setTimeout(options.idleTimeoutMs ?? 60_000, () => request.destroy(new Error('the registry did not answer in time')));
		request.once('error', fail);
		request.once('response', (res) => {
			const status = res.statusCode ?? 0;
			if (status >= 300 && status < 400 && res.headers.location) {
				res.resume();
				options.signal.removeEventListener('abort', onAbort);
				if (redirects >= MAX_REDIRECTS) {
					reject(new Error('the registry redirected too many times'));
					return;
				}
				download(new URL(res.headers.location, target).href, file, options, redirects + 1).then(resolve, reject);
				return;
			}
			if (status !== 200) {
				res.resume();
				fail(new Error(`the registry answered ${status} for ${target.pathname}`));
				return;
			}
			const total = Number(res.headers['content-length']) || undefined;
			const hash = crypto.createHash('sha512');
			let bytes = 0;
			const out = fs.createWriteStream(file);
			res.on('data', (chunk: Buffer) => {
				hash.update(chunk);
				bytes += chunk.length;
				options.onProgress?.(bytes, total);
			});
			pipeline(res, out).then(() => {
				options.signal.removeEventListener('abort', onAbort);
				if (options.signal.aborted) {
					reject(new RuntimeCancelled());
				} else if (total !== undefined && bytes !== total) {
					reject(new Error(`the download of ${target.pathname} ended early`));
				} else {
					resolve(`sha512-${hash.digest('base64')}`);
				}
			}, fail);
		});
	});
}

/** The error of a tarball whose hash is not the pinned one. */
export function integrityText(name: string): string {
	return `${name} didn't match the expected integrity; nothing was unpacked`;
}

/** Whether two `sha512-` integrities are the same (in constant time). */
export function sameIntegrity(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------------------------------
// The unpacking.

export class UnsafeArchive extends Error {
	constructor(entry: string, why: string) {
		super(`the archive is unsafe: ${JSON.stringify(entry)} ${why}`);
		this.name = 'UnsafeArchive';
	}
}

/** An entry's path relative to the target, without npm's first folder (`package/`); throws when unsafe. */
export function safeEntryPath(raw: string): string | undefined {
	const name = raw.replace(/\0.*$/s, '');
	if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) {
		throw new UnsafeArchive(name, 'is an absolute path');
	}
	const parts = name.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
	if (parts.includes('..')) {
		throw new UnsafeArchive(name, 'goes up with ..');
	}
	const rest = parts.slice(1);
	return rest.length > 0 ? rest.join('/') : undefined;
}

/** Whether `child` is `parent` or inside it (both resolved). */
function within(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Throws when a folder on the way from `dest` to `file` is a link (writing through it could leave `dest`). */
function noLinkOnTheWay(dest: string, file: string, entry: string): void {
	let at = dest;
	for (const part of path.relative(dest, path.dirname(file)).split(path.sep).filter(Boolean)) {
		at = path.join(at, part);
		let st: fs.Stats;
		try {
			st = fs.lstatSync(at);
		} catch {
			return;
		}
		if (st.isSymbolicLink()) {
			throw new UnsafeArchive(entry, 'is written through a link');
		}
	}
}

interface TarHeader {
	readonly name: string;
	readonly type: string;
	readonly size: number;
	readonly mode: number;
	readonly linkname: string;
}

function octal(block: Buffer, start: number, length: number): number {
	const field = block.subarray(start, start + length);
	if (field[0] & 0x80) {
		// Base-256 (GNU): sizes over 8 GB; not a tarball of ours.
		let v = 0;
		for (let i = 1; i < field.length; i++) {
			v = v * 256 + field[i];
		}
		return v;
	}
	const text = field.toString('latin1').replace(/\0.*$/s, '').trim();
	return text ? parseInt(text, 8) : 0;
}

function headerOf(block: Buffer): TarHeader | undefined {
	if (block.every((b) => b === 0)) {
		return undefined;
	}
	let sum = 0;
	for (let i = 0; i < 512; i++) {
		sum += i >= 148 && i < 156 ? 32 : block[i];
	}
	if (sum !== octal(block, 148, 8)) {
		throw new Error('the archive is corrupt (a header checksum does not match)');
	}
	const field = (start: number, length: number) => block.toString('utf8', start, start + length).replace(/\0.*$/s, '');
	const magic = block.toString('latin1', 257, 262);
	const prefix = magic === 'ustar' ? field(345, 155) : '';
	const name = field(0, 100);
	return {
		name: prefix ? `${prefix}/${name}` : name,
		type: String.fromCharCode(block[156] || 0x30),
		size: octal(block, 124, 12),
		mode: octal(block, 100, 8),
		linkname: field(157, 100),
	};
}

/** Pax extended header records (`<len> <key>=<value>\n`). */
function paxOf(data: Buffer): Record<string, string> {
	const out: Record<string, string> = {};
	let at = 0;
	while (at < data.length) {
		const space = data.indexOf(0x20, at);
		if (space < 0) {
			break;
		}
		const length = parseInt(data.toString('latin1', at, space), 10);
		if (!(length > 0)) {
			break;
		}
		const record = data.toString('utf8', space + 1, at + length - 1);
		const eq = record.indexOf('=');
		if (eq > 0) {
			out[record.slice(0, eq)] = record.slice(eq + 1);
		}
		at += length;
	}
	return out;
}

/** A streaming tar reader that writes each entry under `dest`, confined to it. */
class TarExtractor extends Writable {
	private buffer: Buffer = Buffer.alloc(0);
	private entry: { header: TarHeader; remaining: number; padding: number; fd?: number; meta?: Buffer[]; file?: string } | undefined;
	private pax: Record<string, string> = {};
	private longName: string | undefined;
	private longLink: string | undefined;
	private ended = false;
	readonly files: string[] = [];

	constructor(private readonly dest: string) {
		super();
	}

	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
		try {
			this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
			this.consume();
			callback();
		} catch (err) {
			this.closeEntry();
			callback(err as Error);
		}
	}

	override _final(callback: (err?: Error | null) => void): void {
		this.closeEntry();
		callback(this.entry && this.entry.remaining > 0 ? new Error('the archive ended in the middle of a file') : null);
	}

	override _destroy(err: Error | null, callback: (err?: Error | null) => void): void {
		this.closeEntry();
		callback(err);
	}

	private closeEntry(): void {
		if (this.entry?.fd !== undefined) {
			fs.closeSync(this.entry.fd);
			this.entry.fd = undefined;
		}
	}

	private consume(): void {
		for (;;) {
			if (this.ended) {
				this.buffer = Buffer.alloc(0);
				return;
			}
			if (this.entry) {
				if (this.entry.remaining > 0) {
					if (this.buffer.length === 0) {
						return;
					}
					const take = Math.min(this.entry.remaining, this.buffer.length);
					const data = this.buffer.subarray(0, take);
					if (this.entry.fd !== undefined) {
						fs.writeSync(this.entry.fd, data);
					} else if (this.entry.meta) {
						this.entry.meta.push(Buffer.from(data));
					}
					this.entry.remaining -= take;
					this.buffer = this.buffer.subarray(take);
					if (this.entry.remaining > 0) {
						return;
					}
				}
				if (this.buffer.length < this.entry.padding) {
					return;
				}
				this.buffer = this.buffer.subarray(this.entry.padding);
				this.finishEntry();
				continue;
			}
			if (this.buffer.length < 512) {
				return;
			}
			const block = this.buffer.subarray(0, 512);
			this.buffer = this.buffer.subarray(512);
			const header = headerOf(block);
			if (!header) {
				this.ended = true;
				continue;
			}
			this.startEntry(header);
		}
	}

	private startEntry(header: TarHeader): void {
		const padding = (512 - (header.size % 512)) % 512;
		const entry: NonNullable<TarExtractor['entry']> = { header, remaining: header.size, padding };
		this.entry = entry;
		switch (header.type) {
			case 'x':
			case 'g':
			case 'L':
			case 'K':
				entry.meta = [];
				return;
		}
		const name = this.pax.path ?? this.longName ?? header.name;
		const linkname = this.pax.linkpath ?? this.longLink ?? header.linkname;
		this.pax = {};
		this.longName = undefined;
		this.longLink = undefined;
		const rel = safeEntryPath(name);
		if (rel === undefined) {
			return;
		}
		const target = path.resolve(this.dest, rel);
		if (!within(this.dest, target) || target === this.dest) {
			throw new UnsafeArchive(name, 'is outside the target folder');
		}
		noLinkOnTheWay(this.dest, target, name);
		switch (header.type) {
			case '0':
			case '7': {
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.rmSync(target, { force: true });
				entry.fd = fs.openSync(target, 'w', (header.mode & 0o755) | 0o600);
				entry.file = target;
				this.files.push(rel);
				return;
			}
			case '5':
				fs.mkdirSync(target, { recursive: true });
				return;
			case '1':
			case '2':
				// npm's tarballs of the SDK and its binary hold only files and folders: any link is refused (a chain of
				// links can point outside however each one's text reads).
				throw new UnsafeArchive(name, `is a ${header.type === '2' ? 'symbolic' : 'hard'} link${linkname ? ` (to ${JSON.stringify(linkname)})` : ''}; links are not unpacked`);
			default:
				throw new UnsafeArchive(name, `is of an unsupported type (${JSON.stringify(header.type)})`);
		}
	}

	private finishEntry(): void {
		const entry = this.entry!;
		this.entry = undefined;
		if (entry.fd !== undefined) {
			fs.closeSync(entry.fd);
			if (entry.file && process.platform !== 'win32') {
				fs.chmodSync(entry.file, (entry.header.mode & 0o755) | 0o600);
			}
			return;
		}
		if (entry.meta) {
			const data = Buffer.concat(entry.meta);
			switch (entry.header.type) {
				case 'x':
					this.pax = paxOf(data);
					break;
				case 'L':
					this.longName = data.toString('utf8').replace(/\0.*$/s, '');
					break;
				case 'K':
					this.longLink = data.toString('utf8').replace(/\0.*$/s, '');
					break;
			}
		}
	}
}

/** Unpacks a gzip'd tarball into `dest` (npm's first folder dropped), confined to it; resolves with the files written. */
export async function extractTarball(file: string, dest: string, signal?: AbortSignal): Promise<string[]> {
	fs.mkdirSync(dest, { recursive: true });
	const real = fs.realpathSync(dest);
	const extractor = new TarExtractor(real);
	await pipeline(fs.createReadStream(file), zlib.createGunzip(), extractor, ...(signal ? [{ signal }] as const : []));
	return extractor.files;
}

// ---------------------------------------------------------------------------------------------------
// Install and remove.

export interface InstallOptions extends Omit<DownloadOptions, 'onProgress'> {
	readonly root: string;
	readonly manifest: RuntimeManifest;
	readonly platform: string;
	/** Which package is downloading, and how far. */
	readonly onProgress?: (name: string, bytes: number, total: number | undefined) => void;
}

/** How old a leftover `.tmp-*` / `.old-*` must be before an install removes it (another window may be installing). */
export const STALE_MS = 60 * 60_000;

/** Removes what an earlier install left behind (`.tmp-*`, `.old-*`) and last changed more than `STALE_MS` ago. */
function sweepStale(root: string, now = Date.now()): void {
	let names: string[] = [];
	try {
		names = fs.readdirSync(root);
	} catch {
		return;
	}
	for (const n of names.filter((x) => x.startsWith('.tmp-') || x.startsWith('.old-'))) {
		const at = path.join(root, n);
		try {
			if (now - fs.statSync(at).mtimeMs > STALE_MS) {
				fs.rmSync(at, { recursive: true, force: true });
			}
		} catch {
			// Gone meanwhile.
		}
	}
}

/**
 * Installs the pinned SDK and this platform's binary package into `<root>/<sdkVersion>/`: both downloaded
 * and verified first, then unpacked into a temporary folder in `root`, which is renamed into place once
 * complete; then every other version is removed. A failure or a cancel leaves no part of it behind.
 */
export async function installRuntime(options: InstallOptions): Promise<RuntimeFiles> {
	const { root, manifest, platform, signal } = options;
	const binPkg = binaryPackage(platform);
	if (!manifest.packages[binPkg]) {
		throw new Error(`no Claude Code binary package exists for ${platform}`);
	}
	if (!usableRegistry(manifest.registry)) {
		throw new Error(`${manifest.registry} is not an https:// registry`);
	}
	fs.mkdirSync(root, { recursive: true });
	sweepStale(root);
	const tmp = fs.mkdtempSync(path.join(root, '.tmp-'));
	try {
		const names = [SDK_PACKAGE, binPkg];
		const tarballs: string[] = [];
		for (const [i, name] of names.entries()) {
			const pkg = manifest.packages[name];
			const tarball = path.join(tmp, `download-${i}.tgz`);
			const integrity = await download(`${manifest.registry}${pkg.path}`, tarball, {
				...options,
				onProgress: (bytes, total) => options.onProgress?.(name, bytes, total),
			});
			if (!sameIntegrity(integrity, pkg.integrity)) {
				throw new Error(integrityText(name));
			}
			tarballs.push(tarball);
		}
		const modules = path.join(tmp, 'node_modules');
		for (const [i, name] of names.entries()) {
			if (signal.aborted) {
				throw new RuntimeCancelled();
			}
			const dir = packageDir(modules, name);
			await extractTarball(tarballs[i], dir, signal);
			const unpacked = (() => {
				try {
					return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
				} catch {
					return {};
				}
			})();
			if (unpacked.name !== name || unpacked.version !== manifest.packages[name].version) {
				throw new Error(`${name}'s tarball holds ${String(unpacked.name)}@${String(unpacked.version)}`);
			}
			fs.rmSync(tarballs[i], { force: true });
		}
		const binary = path.join(packageDir(modules, binPkg), binaryName(platform.split('-')[0]));
		if (!fs.existsSync(binary)) {
			throw new Error(`${binPkg} holds no ${path.basename(binary)}`);
		}
		if (process.platform !== 'win32') {
			fs.chmodSync(binary, 0o755);
		}
		if (signal.aborted) {
			throw new RuntimeCancelled();
		}
		const unpacked = filesIn(modules, manifest.sdkVersion, platform);
		if (!unpacked) {
			throw new Error('the unpacked runtime is incomplete');
		}
		fs.writeFileSync(path.join(tmp, RUNTIME_MARKER), `${JSON.stringify({ sdkVersion: manifest.sdkVersion, platform, packages: names }, null, 2)}\n`);
		const final = path.join(root, manifest.sdkVersion);
		let backup: string | undefined;
		if (fs.existsSync(final)) {
			backup = path.join(root, `.old-${crypto.randomBytes(6).toString('hex')}`);
			fs.renameSync(final, backup);
		}
		try {
			fs.renameSync(tmp, final);
		} catch (err) {
			if (backup) {
				fs.renameSync(backup, final);
			}
			throw err;
		}
		// Swapped in: only now the previous copy and the other versions go.
		if (backup) {
			fs.rmSync(backup, { recursive: true, force: true });
		}
		for (const other of installedVersions(root).filter((v) => v !== manifest.sdkVersion)) {
			fs.rmSync(path.join(root, other), { recursive: true, force: true });
		}
		const moved = (file: string) => path.join(final, path.relative(tmp, file));
		return { version: unpacked.version, sdk: moved(unpacked.sdk), binary: moved(unpacked.binary) };
	} catch (err) {
		fs.rmSync(tmp, { recursive: true, force: true });
		throw signal.aborted ? new RuntimeCancelled() : err;
	}
}

/** Removes every installed runtime (the whole `root`). */
export function removeRuntime(root: string): void {
	fs.rmSync(root, { recursive: true, force: true });
}
