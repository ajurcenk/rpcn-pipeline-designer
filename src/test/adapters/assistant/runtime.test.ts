import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import {
	bypassesProxy, download, extractTarball, installRuntime, installedVersions, parseManifest, proxyFor, proxyRefusedText, readManifest, registryAgent,
	removeRuntime, RuntimeCancelled, TunnelAgent, runtimeStatus, safeEntryPath, sameIntegrity, UnsafeArchive, usableRegistry, type RuntimeManifest,
} from '../../../adapters/assistant/runtime';
import { REPO_ROOT } from '../../helpers/fakeBinary';
import { FakeProxy, FakeRegistry, fakeRuntime, integrityOf, paxPath, SDK, selfSignedCert, tarball } from '../../helpers/fakeRegistry';

// Story 8.2: the assistant runtime's manifest, state, download, integrity check, confined unpacking, swap
// and removal, against a fake registry and fake tarballs (never the real registry).
suite('assistant runtime (story 8.2)', () => {
	let dir: string;
	setup(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-runtime-')));
	});
	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	const write = (name: string, data: Buffer) => {
		const file = path.join(dir, name);
		fs.writeFileSync(file, data);
		return file;
	};
	/** Everything under a folder, relative, sorted. */
	const tree = (at: string) => (fs.existsSync(at) ? fs.readdirSync(at, { recursive: true }).map(String).sort() : []);

	suite('the manifest', () => {
		test('the shipped manifest: the exact pin of package.json, the SDK and every platform package with a sha512', () => {
			const m = readManifest(path.join(REPO_ROOT, 'assets', 'agent-runtime.json'));
			const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
			assert.strictEqual(m.sdkVersion, pkg.dependencies[SDK]);
			assert.strictEqual(m.registry, 'https://registry.npmjs.org');
			for (const p of ['linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64']) {
				assert.ok(m.packages[`${SDK}-${p}`]?.integrity.startsWith('sha512-'), p);
			}
		});

		test('a malformed manifest is refused with why', () => {
			const good = { sdkVersion: '1.2.3', registry: 'https://r.example/', packages: { [SDK]: { version: '1.2.3', path: '/x.tgz', integrity: integrityOf(Buffer.from('x')) } } };
			assert.strictEqual(parseManifest(good).registry, 'https://r.example');
			assert.throws(() => parseManifest({ ...good, sdkVersion: '^1.2.3' }), /malformed/);
			assert.throws(() => parseManifest({ ...good, packages: { [SDK]: { ...good.packages[SDK], integrity: 'sha1-abc' } } }), /entry is malformed/);
			assert.throws(() => parseManifest({ ...good, packages: { [SDK]: { ...good.packages[SDK], version: '1.2.4' } } }), /no @anthropic-ai\/claude-agent-sdk@1.2.3/);
			assert.throws(() => parseManifest(null), /malformed/);
		});
	});

	suite('the unpacking: confined to the target folder', () => {
		const target = () => path.join(dir, 'out');

		test('npm\'s package/ dropped; the executable bit kept; a pax path', async () => {
			const long = `package/${'d'.repeat(60)}/${'f'.repeat(60)}.txt`;
			const file = write('ok.tgz', tarball([
				{ name: 'package/', type: '5' },
				{ name: 'package/package.json', content: '{}' },
				{ name: 'package/bin/claude', content: '#!/bin/sh\n', mode: 0o755 },
				paxPath(long),
				{ name: 'truncated-by-pax', content: 'long' },
			]));
			const files = await extractTarball(file, target());
			assert.deepStrictEqual(files.sort(), ['bin/claude', `${'d'.repeat(60)}/${'f'.repeat(60)}.txt`, 'package.json'].sort());
			assert.ok(fs.statSync(path.join(target(), 'bin', 'claude')).mode & 0o100, 'executable');
			assert.ok(!(fs.statSync(path.join(target(), 'package.json')).mode & 0o111), 'not executable');
		});

		test('an absolute path, .., a link pointing outside, a write through a link, a device: refused', async () => {
			const cases: [string, Parameters<typeof tarball>[0]][] = [
				['absolute', [{ name: '/etc/evil', content: 'x' }]],
				['dot-dot', [{ name: 'package/../../evil', content: 'x' }]],
				['windows drive', [{ name: 'C:\\evil', content: 'x' }]],
				['link outside', [{ name: 'package/out', type: '2', linkname: '../../evil' }]],
				['absolute link', [{ name: 'package/out', type: '2', linkname: '/etc/passwd' }]],
				['through a link', [{ name: 'package/sub', type: '2', linkname: '.' }, { name: 'package/sub/x', content: 'x' }]],
				['hard link outside', [{ name: 'package/h', type: '1', linkname: '../../etc/passwd' }]],
				['device', [{ name: 'package/dev', type: '3' }]],
				['link inside', [{ name: 'package/a', content: 'x' }, { name: 'package/link', type: '2', linkname: 'a' }]],
				['hard link inside', [{ name: 'package/a', content: 'x' }, { name: 'package/hard', type: '1', linkname: 'package/a' }]],
				// A chain: each link's text stays inside, together they reach the parent; then a hard link through it.
				['link chain', [
					{ name: 'package/s2', type: '2', linkname: '.' },
					{ name: 'package/s1', type: '2', linkname: 's2/..' },
					{ name: 'package/stolen', type: '1', linkname: 'package/s1/secret' },
				]],
			];
			for (const [label, entries] of cases) {
				const out = path.join(dir, `out-${label.replace(/\W/g, '')}`);
				const file = write(`${label.replace(/\W/g, '')}.tgz`, tarball(entries));
				await assert.rejects(extractTarball(file, out), (err: Error) => err instanceof UnsafeArchive, label);
			}
			assert.ok(!fs.existsSync(path.join(dir, '..', 'evil')) && !fs.existsSync(path.join(path.dirname(dir), 'evil')), 'nothing written outside');
			assert.ok(!fs.existsSync(path.join(dir, 'out-linkchain', 'stolen')), 'nothing copied in');
			assert.ok(!fs.existsSync(path.join(dir, 'out-linkchain', 's1')), 'no link made');
		});

		test('safeEntryPath', () => {
			assert.strictEqual(safeEntryPath('package/a/b'), 'a/b');
			assert.strictEqual(safeEntryPath('package/./a//b'), 'a/b');
			assert.strictEqual(safeEntryPath('package/'), undefined);
			assert.throws(() => safeEntryPath('package/a/../../b'), UnsafeArchive);
			assert.throws(() => safeEntryPath('\\\\server\\x'), UnsafeArchive);
		});

		test('a corrupt archive (a bad header checksum, cut short) is an error', async () => {
			const good = zlib.gunzipSync(tarball([{ name: 'package/a', content: 'hello' }]));
			good[10] ^= 0xff;
			await assert.rejects(extractTarball(write('bad.tgz', zlib.gzipSync(good)), target()), /checksum/);
			const cut = zlib.gunzipSync(tarball([{ name: 'package/a', content: 'x'.repeat(2000) }])).subarray(0, 1024);
			await assert.rejects(extractTarball(write('cut.tgz', zlib.gzipSync(cut)), path.join(dir, 'cut')), /ended in the middle/);
		});
	});

	suite('install, state and removal against a fake registry', () => {
		let registry: FakeRegistry;
		const platform = 'linux-x64';
		const root = () => path.join(dir, 'agent-runtime');
		const signal = () => new AbortController().signal;
		const install = (manifest: RuntimeManifest, s = signal(), agentFor = () => undefined) => installRuntime({ root: root(), manifest, platform, signal: s, agentFor });
		suiteSetup(async () => {
			registry = new FakeRegistry();
			await registry.start();
		});
		suiteTeardown(async () => registry.stop());
		setup(() => {
			registry.reset();
			registry.files.clear();
			registry.serve('1.0.0', platform);
		});

		test('missing, then installed (the binary executable), then removed', async () => {
			const manifest = registry.manifest('1.0.0', [platform, 'darwin-arm64']);
			assert.deepStrictEqual(runtimeStatus({ root: root(), manifest, platform }), { kind: 'missing', platform });
			const files = await install(manifest);
			assert.deepStrictEqual(registry.requests.map((r) => r.url), [manifest.packages[SDK].path, manifest.packages[`${SDK}-${platform}`].path], 'exactly two downloads');
			const v = path.join(root(), '1.0.0', 'node_modules', '@anthropic-ai');
			assert.deepStrictEqual(files, { version: '1.0.0', sdk: path.join(v, 'claude-agent-sdk', 'sdk.mjs'), binary: path.join(v, 'claude-agent-sdk-linux-x64', 'claude') });
			assert.ok(fs.statSync(files.binary).mode & 0o111, 'claude keeps its executable bit');
			assert.deepStrictEqual(runtimeStatus({ root: root(), manifest, platform }), { kind: 'installed', platform, files, dev: false });
			assert.deepStrictEqual(fs.readdirSync(root()), ['1.0.0'], 'no temporary folder or tarball left');
			assert.ok(!tree(root()).some((f) => f.endsWith('.tgz')));
			removeRuntime(root());
			assert.ok(!fs.existsSync(root()));
			assert.strictEqual(runtimeStatus({ root: root(), manifest, platform }).kind, 'missing');
		});

		test('a platform with no binary package: unavailable, and install refuses', async () => {
			const manifest = registry.manifest('1.0.0', [platform]);
			assert.deepStrictEqual(runtimeStatus({ root: root(), manifest, platform: 'aix-ppc64' }), { kind: 'unavailable', platform: 'aix-ppc64' });
			await assert.rejects(installRuntime({ root: root(), manifest, platform: 'aix-ppc64', signal: signal(), agentFor: () => undefined }), /no Claude Code binary package exists for aix-ppc64/);
		});

		test('a bad hash: nothing unpacked, nothing left', async () => {
			const manifest = registry.manifest('1.0.0', [platform]);
			registry.corrupt.add(manifest.packages[`${SDK}-${platform}`].path);
			await assert.rejects(install(manifest), /claude-agent-sdk-linux-x64 didn't match the expected integrity; nothing was unpacked/);
			assert.deepStrictEqual(tree(root()), []);
		});

		test('a registry error, or no registry at all: an error, nothing left', async () => {
			const manifest = registry.manifest('1.0.0', [platform]);
			registry.failStatus.set(manifest.packages[SDK].path, 503);
			await assert.rejects(install(manifest), /the registry answered 503/);
			assert.deepStrictEqual(tree(root()), []);
			await assert.rejects(install({ ...manifest, registry: 'http://127.0.0.1:1' }), /ECONNREFUSED/);
			assert.deepStrictEqual(tree(root()), []);
			await assert.rejects(install({ ...manifest, registry: 'http://registry.example' }), /not an https:\/\/ registry/);
		});

		test('cancel during the download: nothing left', async () => {
			const manifest = registry.manifest('1.0.0', [platform]);
			registry.hold = true;
			const abort = new AbortController();
			const going = install(manifest, abort.signal);
			const until = Date.now() + 5000;
			while (registry.requests.length === 0 && Date.now() < until) {
				await new Promise((r) => setTimeout(r, 10));
			}
			abort.abort();
			await assert.rejects(going, (err: Error) => err instanceof RuntimeCancelled);
			assert.deepStrictEqual(tree(root()), []);
		});

		test('an unsafe tarball (its hash matching): refused, nothing left, nothing outside', async () => {
			registry.serve('1.0.0', platform, { ...fakeRuntime('1.0.0', platform), binary: tarball([{ name: 'package/../../../escaped', content: 'x' }]) });
			const manifest = registry.manifest('1.0.0', [platform]);
			await assert.rejects(install(manifest), (err: Error) => err instanceof UnsafeArchive);
			assert.deepStrictEqual(tree(root()), []);
			assert.ok(!fs.existsSync(path.join(dir, 'escaped')) && !fs.existsSync(path.join(path.dirname(dir), 'escaped')));
		});

		test('a tarball of another package or version is refused', async () => {
			registry.serve('1.0.0', platform, { ...fakeRuntime('1.0.0', platform), binary: fakeRuntime('9.9.9', platform).binary });
			await assert.rejects(install(registry.manifest('1.0.0', [platform])), /holds @anthropic-ai\/claude-agent-sdk-linux-x64@9.9.9/);
			assert.deepStrictEqual(tree(root()), []);
		});

		test('versions compare by their numbers: 0.3.329 is newer than 0.3.99', async () => {
			fs.mkdirSync(root(), { recursive: true });
			for (const v of ['0.3.99', '0.3.329', '0.10.0']) {
				registry.serve(v, platform);
				await installRuntime({ root: path.join(dir, `r-${v}`), manifest: registry.manifest(v, [platform]), platform, signal: signal(), agentFor: () => undefined });
				fs.renameSync(path.join(dir, `r-${v}`, v), path.join(root(), v));
			}
			assert.deepStrictEqual(installedVersions(root()), ['0.3.99', '0.3.329', '0.10.0']);
			assert.deepStrictEqual(runtimeStatus({ root: root(), manifest: registry.manifest('1.0.0', [platform]), platform }), { kind: 'outdated', platform, installed: '0.10.0' });
		});

		test('another window\'s fresh leftovers are kept; an hour-old one is removed; a reinstall keeps nothing old', async () => {
			fs.mkdirSync(path.join(root(), '.tmp-fresh'), { recursive: true });
			fs.mkdirSync(path.join(root(), '.tmp-stale'));
			const old = new Date(Date.now() - 2 * 60 * 60_000);
			fs.utimesSync(path.join(root(), '.tmp-stale'), old, old);
			await install(registry.manifest('1.0.0', [platform]));
			assert.deepStrictEqual(fs.readdirSync(root()).sort(), ['.tmp-fresh', '1.0.0']);
			await install(registry.manifest('1.0.0', [platform]));
			assert.deepStrictEqual(fs.readdirSync(root()).sort(), ['.tmp-fresh', '1.0.0'], 'the previous copy is gone once the new one is in');
		});

		test('a new pin: the old version is outdated; the new install removes it; the binary gone: missing', async () => {
			await install(registry.manifest('1.0.0', [platform]));
			registry.serve('1.1.0', platform);
			const next = registry.manifest('1.1.0', [platform]);
			assert.deepStrictEqual(runtimeStatus({ root: root(), manifest: next, platform }), { kind: 'outdated', platform, installed: '1.0.0' });
			const files = await install(next);
			assert.deepStrictEqual(installedVersions(root()), ['1.1.0'], 'the old one removed');
			fs.rmSync(files.binary);
			assert.deepStrictEqual(runtimeStatus({ root: root(), manifest: next, platform }), { kind: 'missing', platform });
		});

		test('a foreign SDK (an ancestor node_modules, NODE_PATH) is never the runtime; the dev override only when passed', async () => {
			const foreign = path.join(dir, 'node_modules');
			const ext = path.join(dir, 'ext-node-modules');
			for (const at of [foreign, ext]) {
				const sdkTgz = write('sdk.tgz', fakeRuntime('1.0.0', platform).sdk);
				const binTgz = write('bin.tgz', fakeRuntime('1.0.0', platform).binary);
				await extractTarball(sdkTgz, path.join(at, '@anthropic-ai', 'claude-agent-sdk'));
				await extractTarball(binTgz, path.join(at, '@anthropic-ai', 'claude-agent-sdk-linux-x64'));
			}
			const before = process.env.NODE_PATH;
			process.env.NODE_PATH = foreign;
			try {
				const manifest = registry.manifest('1.0.0', [platform]);
				assert.deepStrictEqual(runtimeStatus({ root: root(), manifest, platform }), { kind: 'missing', platform });
				const dev = runtimeStatus({ root: root(), manifest, platform, devModules: ext });
				assert.strictEqual(dev.kind, 'installed');
				assert.ok(dev.kind === 'installed' && dev.dev && dev.files.sdk.startsWith(ext));
				assert.strictEqual(runtimeStatus({ root: root(), manifest: { ...manifest, sdkVersion: '2.0.0', packages: { ...manifest.packages, [SDK]: { ...manifest.packages[SDK], version: '2.0.0' } } }, platform, devModules: ext }).kind, 'missing', 'the override at another version is not used');
			} finally {
				if (before === undefined) {
					delete process.env.NODE_PATH;
				} else {
					process.env.NODE_PATH = before;
				}
			}
		});

		test('the download gives the tarball\'s sha512', async () => {
			const p = registry.manifest('1.0.0', [platform]).packages[SDK].path;
			const got = await download(`${registry.url}${p}`, path.join(dir, 'x.tgz'), { signal: signal(), agentFor: () => undefined });
			assert.ok(sameIntegrity(got, integrityOf(registry.files.get(p)!)));
			assert.ok(!sameIntegrity(got, integrityOf(Buffer.from('other'))));
		});
	});

	suite('the proxy', () => {
		test('which hosts go through it', () => {
			const target = new URL('https://registry.npmjs.org/x');
			assert.strictEqual(proxyFor(target, {}), undefined);
			assert.strictEqual(proxyFor(target, { proxy: 'proxy.corp:3128' })?.href, 'http://proxy.corp:3128/');
			assert.strictEqual(proxyFor(target, { proxy: 'http://p:1', noProxy: ['.npmjs.org'] }), undefined);
			assert.strictEqual(proxyFor(target, { proxy: 'http://p:1', noProxy: ['example.com, *.npmjs.org'] }), undefined);
			assert.strictEqual(proxyFor(target, { proxy: 'http://p:1', noProxy: ['registry.npmjs.org:80'] })?.host, 'p:1', 'another port');
			assert.ok(bypassesProxy('localhost', '80') && bypassesProxy('[::1]', '80') && bypassesProxy('x.y', '443', ['*']));
			assert.ok(!bypassesProxy('npmjs.org.evil', '443', ['.npmjs.org']));
			assert.ok(usableRegistry('https://r.example') && usableRegistry('http://127.0.0.1:4') && !usableRegistry('http://r.example') && !usableRegistry('https://u:p@r.example'));
		});

		test('a proxy that refuses: the download fails with why, through the CONNECT tunnel', async () => {
			const proxy = new FakeProxy();
			await proxy.start();
			try {
				const target = 'https://registry.example.invalid/@anthropic-ai/x.tgz';
				await assert.rejects(
					download(target, path.join(dir, 'x.tgz'), { signal: new AbortController().signal, agentFor: (u) => registryAgent(u, { proxy: proxy.url }) }),
					new RegExp(proxyRefusedText(407).replace(/[()]/g, '\\$&')),
				);
				assert.deepStrictEqual(proxy.connects, ['registry.example.invalid:443']);
			} finally {
				await proxy.stop();
			}
		});

		test('an unsupported proxy scheme fails with that reason, never direct', async () => {
			assert.throws(() => proxyFor(new URL('https://r.example'), { proxy: 'socks5://p:1' }), /proxy scheme socks5:\/\/ is not supported/);
			await assert.rejects(download('https://registry.example.invalid/x.tgz', path.join(dir, 'x.tgz'), {
				signal: new AbortController().signal, agentFor: (u) => registryAgent(u, { proxy: 'socks5://p:1' }),
			}), /not supported/);
		});

		test('a proxy that accepts the connection and ends it, or never answers: the download fails', async () => {
			const opened: net.Socket[] = [];
			const server = net.createServer((socket) => {
				opened.push(socket);
				socket.end();
			});
			const silent = net.createServer((socket) => opened.push(socket));
			await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
			await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
			try {
				const url = (srv: net.Server) => `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
				await assert.rejects(download('https://registry.example.invalid/x.tgz', path.join(dir, 'x.tgz'), {
					signal: new AbortController().signal, agentFor: () => new TunnelAgent(new URL(url(server)), {}),
				}), /closed the connection before answering CONNECT/);
				await assert.rejects(download('https://registry.example.invalid/x.tgz', path.join(dir, 'y.tgz'), {
					signal: new AbortController().signal, idleTimeoutMs: 300, agentFor: () => new TunnelAgent(new URL(url(silent)), {}),
				}), /did not answer CONNECT in time/);
			} finally {
				opened.forEach((c) => c.destroy());
				await new Promise((r) => server.close(r));
				await new Promise((r) => silent.close(r));
			}
		});

		test('a proxy that tunnels: the tarball comes over TLS through it, checked against the extra CA', async function () {
			const cert = selfSignedCert();
			if (!cert) {
				this.skip();
			}
			const registry = new FakeRegistry();
			await registry.start(cert);
			const proxy = new FakeProxy();
			proxy.accept = true;
			await proxy.start();
			try {
				registry.serve('1.0.0', 'linux-x64');
				const p = registry.manifest('1.0.0', ['linux-x64']).packages[SDK].path;
				const tunnel = new TunnelAgent(new URL(proxy.url), { ca: [cert!.cert] });
				const got = await download(`${registry.url}${p}`, path.join(dir, 'x.tgz'), { signal: new AbortController().signal, agentFor: () => tunnel });
				assert.ok(sameIntegrity(got, integrityOf(registry.files.get(p)!)));
				assert.strictEqual(proxy.connects.length, 1, 'through the proxy');
				// Without the CA, the self-signed registry is refused (strictSSL); with strictSSL off, accepted.
				await assert.rejects(download(`${registry.url}${p}`, path.join(dir, 'y.tgz'), { signal: new AbortController().signal, agentFor: () => new TunnelAgent(new URL(proxy.url), {}) }),
					/self.signed|certificate/i);
				// registryAgent's extra CA and strictSSL, observed through downloads (the loopback target is proxied here
				// by asking for the agent of a non-loopback URL with the same proxy).
				const viaProxy = (config: Parameters<typeof registryAgent>[1]) => () => registryAgent(new URL('https://registry.example'), config);
				assert.ok(viaProxy({ proxy: proxy.url })() instanceof TunnelAgent);
				await download(`${registry.url}${p}`, path.join(dir, 'z.tgz'), { signal: new AbortController().signal, agentFor: viaProxy({ proxy: proxy.url, ca: [cert!.cert] }) });
				await download(`${registry.url}${p}`, path.join(dir, 'w.tgz'), { signal: new AbortController().signal, agentFor: viaProxy({ proxy: proxy.url, strictSSL: false }) });
			} finally {
				await proxy.stop();
				await registry.stop();
			}
		});
	});
});

