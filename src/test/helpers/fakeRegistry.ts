// A local fake of the npm registry (story 8.2), in the `fakeCloud.ts` style: one HTTP server on 127.0.0.1
// serving small fake tarballs of the assistant runtime, so the install runs end to end with no network.
//   - `fakeRuntime(version, platform)`: a fake `@anthropic-ai/claude-agent-sdk` (a `sdk.mjs` that exports
//     `query` and `createSdkMcpServer`) and a fake `@anthropic-ai/claude-agent-sdk-<platform>` (a `claude`
//     shell script, mode 0755), as npm packs them (gzip'd ustar, everything under `package/`);
//   - `serve(version, platform)` adds them, and `manifest(...)` gives the runtime manifest pointed at this
//     server, with each tarball's real sha512 integrity;
//   - `corrupt`: a path answered with other bytes than the manifest's hash; `failStatus`: a path answered
//     with that status; `hold`: every tarball request waits until `release()` (a slow download, to cancel);
// Every request is recorded. `FakeProxy` refuses every `CONNECT` (407), recording each. `tarball` builds any
// archive (unsafe ones included) for the unpacking tests.

import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import type { RuntimeManifest, RuntimePackage } from '../../adapters/assistant/runtime';

export const SDK = '@anthropic-ai/claude-agent-sdk';

export interface TarEntry {
	readonly name: string;
	readonly content?: string | Buffer;
	readonly mode?: number;
	/** `0` file (default), `5` folder, `2` symlink, `1` hard link, `3` char device, `x` pax header. */
	readonly type?: string;
	readonly linkname?: string;
}

function header(entry: TarEntry, size: number): Buffer {
	const h = Buffer.alloc(512);
	const write = (text: string, at: number, length: number) => h.write(text.slice(0, length), at, length, 'utf8');
	const octal = (n: number, at: number, length: number) => write(`${n.toString(8).padStart(length - 1, '0')}\0`, at, length);
	write(entry.name, 0, 100);
	octal(entry.mode ?? (entry.type === '5' ? 0o755 : 0o644), 100, 8);
	octal(0, 108, 8);
	octal(0, 116, 8);
	octal(size, 124, 12);
	octal(0, 136, 12);
	h.write('        ', 148, 8, 'latin1');
	h.write(entry.type ?? '0', 156, 1, 'latin1');
	write(entry.linkname ?? '', 157, 100);
	h.write('ustar\0', 257, 6, 'latin1');
	h.write('00', 263, 2, 'latin1');
	let sum = 0;
	for (const b of h) {
		sum += b;
	}
	h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
	return h;
}

/** A gzip'd ustar archive of `entries`. */
export function tarball(entries: readonly TarEntry[]): Buffer {
	const parts: Buffer[] = [];
	for (const e of entries) {
		const data = typeof e.content === 'string' ? Buffer.from(e.content) : e.content ?? Buffer.alloc(0);
		parts.push(header(e, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	parts.push(Buffer.alloc(1024));
	return zlib.gzipSync(Buffer.concat(parts));
}

/** A pax header entry setting `path` (for names over 100 characters). */
export function paxPath(name: string): TarEntry {
	const body = (len: number) => `${len} path=${name}\n`;
	let len = body(0).length;
	while (body(len).length !== len) {
		len = body(len).length;
	}
	return { name: 'PaxHeader', type: 'x', content: body(len) };
}

export const FAKE_SDK_MJS = 'export const query = () => { throw new Error("fake SDK"); };\nexport const createSdkMcpServer = () => ({});\n';
export const FAKE_CLAUDE = '#!/bin/sh\necho fake-claude\n';

/** The fake runtime's two tarballs for `version` and `platform`. */
export function fakeRuntime(version: string, platform: string): { readonly sdk: Buffer; readonly binary: Buffer } {
	const bin = platform.startsWith('win32') ? 'claude.exe' : 'claude';
	return {
		sdk: tarball([
			{ name: 'package/package.json', content: JSON.stringify({ name: SDK, version, type: 'module', main: 'sdk.mjs' }) },
			{ name: 'package/sdk.mjs', content: FAKE_SDK_MJS },
			{ name: 'package/LICENSE.md', content: 'Fake.\n' },
		]),
		binary: tarball([
			{ name: 'package/package.json', content: JSON.stringify({ name: `${SDK}-${platform}`, version }) },
			{ name: `package/${bin}`, content: FAKE_CLAUDE, mode: 0o755 },
		]),
	};
}

export function integrityOf(data: Buffer): string {
	return `sha512-${crypto.createHash('sha512').update(data).digest('base64')}`;
}

export const tarballPath = (name: string, version: string) => `/${name}/-/${name.split('/')[1]}-${version}.tgz`;

export class FakeRegistry {
	readonly requests: { readonly method: string; readonly url: string; readonly headers: http.IncomingHttpHeaders }[] = [];
	readonly files = new Map<string, Buffer>();
	/** Paths answered with other bytes than the manifest's hash. */
	readonly corrupt = new Set<string>();
	/** Paths answered with a status instead. */
	readonly failStatus = new Map<string, number>();
	hold = false;
	private held: (() => void)[] = [];
	private server: http.Server | undefined;
	private port = 0;

	private secure = false;

	get url(): string {
		return `${this.secure ? 'https' : 'http'}://127.0.0.1:${this.port}`;
	}

	/** Starts it, over TLS with `tlsOptions` (`selfSignedCert`). */
	async start(tlsOptions?: { readonly key: string; readonly cert: string }): Promise<void> {
		this.secure = tlsOptions !== undefined;
		const handler: http.RequestListener = (req, res) => {
			this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
			const answer = () => {
				const p = (req.url ?? '').split('?')[0];
				const status = this.failStatus.get(p);
				const file = this.files.get(p);
				if (status !== undefined || !file) {
					res.writeHead(status ?? 404, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ error: 'Not found' }));
					return;
				}
				const body = this.corrupt.has(p) ? Buffer.concat([file, Buffer.from('tampered')]) : file;
				res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
				// Two writes, so a held request has started its body.
				res.write(body.subarray(0, 16));
				if (this.hold) {
					this.held.push(() => res.end(body.subarray(16)));
				} else {
					res.end(body.subarray(16));
				}
			};
			answer();
		};
		this.server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);
		await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
		this.port = (this.server!.address() as net.AddressInfo).port;
	}

	async stop(): Promise<void> {
		this.release();
		this.server?.closeAllConnections();
		await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
	}

	/** Ends every held request. */
	release(): void {
		const held = this.held;
		this.held = [];
		held.forEach((f) => f());
	}

	reset(): void {
		this.requests.length = 0;
		this.corrupt.clear();
		this.failStatus.clear();
		this.hold = false;
		this.release();
	}

	/** Serves the fake runtime's tarballs for `version` and `platform` (or the given ones). */
	serve(version: string, platform: string, tarballs = fakeRuntime(version, platform)): void {
		this.files.set(tarballPath(SDK, version), tarballs.sdk);
		this.files.set(tarballPath(`${SDK}-${platform}`, version), tarballs.binary);
	}

	/** The manifest for what is served at `version` (platform packages: `platforms`; each with its real integrity). */
	manifest(version: string, platforms: readonly string[], registry = this.url): RuntimeManifest {
		const entry = (name: string): RuntimePackage => {
			const p = tarballPath(name, version);
			const data = this.files.get(p) ?? Buffer.from('not served');
			return { version, path: p, integrity: integrityOf(data) };
		};
		const packages: Record<string, RuntimePackage> = { [SDK]: entry(SDK) };
		for (const platform of platforms) {
			packages[`${SDK}-${platform}`] = entry(`${SDK}-${platform}`);
		}
		return { sdkVersion: version, registry, packages };
	}
}

/** A self-signed certificate for 127.0.0.1 (`openssl`; `undefined` when it is not there). */
export function selfSignedCert(): { readonly key: string; readonly cert: string } | undefined {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-cert-'));
	try {
		execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
			'-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore', timeout: 20_000 });
		return { key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'), cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8') };
	} catch {
		return undefined;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * A proxy that refuses every `CONNECT` with 407 (and every plain request with 403); with `accept`, it
 * tunnels each `CONNECT` to the host and port asked for instead.
 */
export class FakeProxy {
	readonly connects: string[] = [];
	accept = false;
	/** Tunnelled sockets (an http server no longer tracks them): destroyed on `stop`. */
	private readonly sockets = new Set<net.Socket>();
	private server: http.Server | undefined;
	private port = 0;

	get url(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	async start(): Promise<void> {
		this.server = http.createServer((_req, res) => {
			res.writeHead(403);
			res.end();
		});
		this.server.on('connect', (req: http.IncomingMessage, socket: import('net').Socket) => {
			this.connects.push(req.url ?? '');
			this.sockets.add(socket);
			socket.on('close', () => this.sockets.delete(socket));
			if (!this.accept) {
				socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
				return;
			}
			const [host, port] = (req.url ?? '').split(':');
			const upstream = net.connect(Number(port), host, () => {
				this.sockets.add(upstream);
				upstream.on('close', () => this.sockets.delete(upstream));
				socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				upstream.pipe(socket);
				socket.pipe(upstream);
			});
			upstream.on('error', () => socket.destroy());
			socket.on('error', () => upstream.destroy());
		});
		await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
		this.port = (this.server!.address() as net.AddressInfo).port;
	}

	async stop(): Promise<void> {
		this.sockets.forEach((x) => x.destroy());
		this.server?.closeAllConnections();
		await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
	}
}
