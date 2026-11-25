import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { REPO_ROOT } from '../helpers/fakeBinary';

// Story 8.2: scripts/gen-agent-runtime.mjs (the runtime manifest from the lockfile) and scripts/check-vsix.mjs
// (one VSIX, no Anthropic package in it), unit-tested on built inputs; no network, no packaging.

/** A script's exports (ESM, loaded by its file URL). */
async function load(name: string): Promise<Record<string, (...args: never[]) => unknown>> {
	const url = pathToFileURL(path.join(REPO_ROOT, 'scripts', name)).href;
	return import(url) as Promise<Record<string, (...args: never[]) => unknown>>;
}

const SDK = '@anthropic-ai/claude-agent-sdk';
const SHA = (c: string) => `sha512-${c.repeat(86)}==`;

suite('gen-agent-runtime.mjs (story 8.2)', () => {
	const lock = () => ({
		packages: {
			[`node_modules/${SDK}`]: {
				version: '1.2.3', resolved: `https://registry.npmjs.org/${SDK}/-/claude-agent-sdk-1.2.3.tgz`, integrity: SHA('a'),
				optionalDependencies: { [`${SDK}-linux-x64`]: '1.2.3', [`${SDK}-darwin-arm64`]: '1.2.3' },
			},
			[`node_modules/${SDK}-linux-x64`]: { version: '1.2.3', resolved: `https://registry.npmjs.org/${SDK}-linux-x64/-/claude-agent-sdk-linux-x64-1.2.3.tgz`, integrity: SHA('b') },
			[`node_modules/${SDK}-darwin-arm64`]: { version: '1.2.3', resolved: `https://registry.npmjs.org/${SDK}-darwin-arm64/-/claude-agent-sdk-darwin-arm64-1.2.3.tgz`, integrity: SHA('c') },
		},
	});
	const pkg = (v = '1.2.3') => ({ dependencies: { [SDK]: v } });

	test('the manifest: the exact pin, and each package\'s path, version and integrity from the lockfile', async () => {
		const { manifestFrom } = await load('gen-agent-runtime.mjs') as unknown as { manifestFrom: (p: unknown, l: unknown) => unknown };
		assert.deepStrictEqual(manifestFrom(pkg(), lock()), {
			sdkVersion: '1.2.3',
			registry: 'https://registry.npmjs.org',
			packages: {
				[SDK]: { version: '1.2.3', path: `/${SDK}/-/claude-agent-sdk-1.2.3.tgz`, integrity: SHA('a') },
				[`${SDK}-darwin-arm64`]: { version: '1.2.3', path: `/${SDK}-darwin-arm64/-/claude-agent-sdk-darwin-arm64-1.2.3.tgz`, integrity: SHA('c') },
				[`${SDK}-linux-x64`]: { version: '1.2.3', path: `/${SDK}-linux-x64/-/claude-agent-sdk-linux-x64-1.2.3.tgz`, integrity: SHA('b') },
			},
		});
	});

	test('no exact pin, a missing or other-version entry, no sha512, or a tarball off the registry: refused', async () => {
		const { manifestFrom } = await load('gen-agent-runtime.mjs') as unknown as { manifestFrom: (p: unknown, l: unknown) => unknown };
		assert.throws(() => manifestFrom(pkg('^1.2.3'), lock()), /exact x\.y\.z/);
		assert.throws(() => manifestFrom({}, lock()), /exact x\.y\.z/);
		const l1 = lock();
		delete (l1.packages as Record<string, unknown>)[`node_modules/${SDK}-linux-x64`];
		assert.throws(() => manifestFrom(pkg(), l1), /no node_modules\/@anthropic-ai\/claude-agent-sdk-linux-x64/);
		const l2 = lock();
		l2.packages[`node_modules/${SDK}-linux-x64`].integrity = 'sha1-abc';
		assert.throws(() => manifestFrom(pkg(), l2), /no sha512 integrity/);
		const l3 = lock();
		l3.packages[`node_modules/${SDK}-linux-x64`].resolved = 'https://evil.example/x.tgz';
		assert.throws(() => manifestFrom(pkg(), l3), /not on https:\/\/registry\.npmjs\.org/);
		const l4 = lock();
		l4.packages[`node_modules/${SDK}-linux-x64`].version = '1.2.4';
		assert.throws(() => manifestFrom(pkg(), l4), /not 1\.2\.3/);
	});

	test('--check passes on the repository; an unknown argument fails', () => {
		const run = (...args: string[]) => spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'gen-agent-runtime.mjs'), ...args], {
			cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20_000,
		});
		const ok = run('--check');
		assert.strictEqual(ok.status, 0, ok.stderr);
		assert.strictEqual(run('--bogus').status, 1);
	});
});

/** A zip (stored, or with `method` set) of `files`. */
function zip(files: Record<string, string>, method = 0, zip64 = false): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const data = Buffer.from(content);
		const nameBuf = Buffer.from(name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(zip64 ? 0xffffffff : data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBuf, data);
		centrals.push(central, nameBuf);
		offset += 30 + nameBuf.length + data.length;
	}
	const cd = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, end]);
}

suite('check-vsix.mjs (story 8.2)', () => {
	type Entry = { name: string; read: () => Buffer };
	let problemsOf: (entries: Entry[]) => string[];
	let zipEntries: (buf: Buffer) => { entries: Entry[]; problems: string[] };
	suiteSetup(async () => {
		const m = await load('check-vsix.mjs') as unknown as { problemsOf: typeof problemsOf; zipEntries: typeof zipEntries };
		problemsOf = m.problemsOf;
		zipEntries = m.zipEntries;
	});
	const runtime = (v = '1.2.3', platform: unknown = { version: v, path: '/y.tgz', integrity: SHA('b') }) => JSON.stringify({
		sdkVersion: v, registry: 'https://registry.npmjs.org',
		packages: { [SDK]: { version: v, path: '/x.tgz', integrity: SHA('a') }, ...(platform ? { [`${SDK}-linux-x64`]: platform } : {}) },
	});
	const good = (): Record<string, string> => ({
		'extension.vsixmanifest': '<PackageManifest><Metadata><Identity Id="rpcn-pipeline-designer" Version="0.0.1" Publisher="ajurcenk"/></Metadata></PackageManifest>',
		'extension/package.json': JSON.stringify({ dependencies: { [SDK]: '1.2.3' } }),
		'extension/dist/extension.js': '',
		'extension/dist/native.wasm': '',
		'extension/assets/rpcn-skills/PIN': '888de77',
		'extension/assets/rpcn-skills/.claude-plugin/plugin.json': '{}',
		'extension/assets/rpcn-skills/skills/rpcn-design/SKILL.md': '#',
		'extension/assets/rpcn-skills/skills/rpcn-author/SKILL.md': '#',
		'extension/assets/rpcn-skills/skills/rpcn-test/SKILL.md': '#',
		'extension/assets/agent-runtime.json': runtime(),
	});
	const entries = (files: Record<string, string>): Entry[] => Object.entries(files).map(([name, c]) => ({ name, read: () => Buffer.from(c) }));

	test('the one universal VSIX passes', () => {
		assert.deepStrictEqual(problemsOf(entries(good())), []);
	});

	test('any Anthropic package, a claude binary, node_modules, a TargetPlatform: each a problem', () => {
		const files = {
			...good(),
			[`extension/dist/node_modules/${SDK}/sdk.mjs`]: '',
			[`extension/node_modules/${SDK}-linux-x64/package.json`]: '{}',
			'extension/dist/claude': '',
			'extension/node_modules/zod/index.js': '',
			'extension.vsixmanifest': '<PackageManifest><Metadata><Identity Id="x" TargetPlatform="linux-x64"/></Metadata></PackageManifest>',
		};
		const p = problemsOf(entries(files));
		assert.ok(p.some((x) => x.startsWith(`extension/dist/node_modules/${SDK}/sdk.mjs is Anthropic's Agent SDK`)), p.join('\n'));
		assert.ok(p.some((x) => x.startsWith(`extension/node_modules/${SDK}-linux-x64/package.json is Anthropic's Agent SDK`)));
		assert.ok(p.some((x) => x.startsWith('extension/dist/claude looks like a Claude Code binary')));
		assert.ok(p.some((x) => x.startsWith('extension/node_modules/zod/index.js is in a node_modules folder')));
		assert.ok(p.some((x) => x.includes('TargetPlatform=linux-x64')));
	});

	test('review 10: no exact SDK pin, or a manifest for another version: a problem', () => {
		for (const pin of ['^1.2.3', '~1.2.3', 'latest', undefined]) {
			const p = problemsOf(entries({ ...good(), 'extension/package.json': JSON.stringify({ dependencies: pin === undefined ? {} : { [SDK]: pin } }) }));
			assert.ok(p.some((x) => x.includes('does not pin @anthropic-ai/claude-agent-sdk to an exact x.y.z version')), `${pin}: ${p.join('\n')}`);
		}
		const p = problemsOf(entries({ ...good(), 'extension/assets/agent-runtime.json': runtime('1.2.4') }));
		assert.ok(p.some((x) => x.includes('is for 1.2.4, not the pinned 1.2.3')), p.join('\n'));
		const missing = good();
		delete missing['extension/assets/agent-runtime.json'];
		delete missing['extension/dist/native.wasm'];
		assert.deepStrictEqual(problemsOf(entries(missing)), ['extension/dist/native.wasm is missing', 'extension/assets/agent-runtime.json is missing']);
	});

	test('the three bundled skills are required', () => {
		const files = good();
		delete files['extension/assets/rpcn-skills/skills/rpcn-test/SKILL.md'];
		assert.deepStrictEqual(problemsOf(entries(files)), ['extension/assets/rpcn-skills/skills/rpcn-test/SKILL.md is missing']);
	});

	test('the manifest must list the platform packages at the pin, each with a sha512', () => {
		assert.deepStrictEqual(problemsOf(entries({ ...good(), 'extension/assets/agent-runtime.json': runtime('1.2.3', null) })),
			['extension/assets/agent-runtime.json lists no platform package']);
		const p = problemsOf(entries({ ...good(), 'extension/assets/agent-runtime.json': runtime('1.2.3', { version: '1.2.3', path: '/y.tgz', integrity: 'sha1-x' }) }));
		assert.strictEqual(p.length, 1);
		assert.ok(p[0].startsWith(`extension/assets/agent-runtime.json has ${SDK}-linux-x64 without 1.2.3 and a sha512 integrity`), p[0]);
	});

	test('review 11: invalid JSON, another compression method, ZIP64, not a zip: problem lines, no crash', () => {
		const p = problemsOf(entries({ ...good(), 'extension/package.json': '{not json' }));
		assert.ok(p.some((x) => x.startsWith('extension/package.json is not readable JSON')), p.join('\n'));
		assert.deepStrictEqual(zipEntries(Buffer.from('nope')).problems, ['the file is not a zip (no end of central directory)']);
		const stored = zipEntries(zip(good()));
		assert.deepStrictEqual(stored.problems, []);
		assert.deepStrictEqual(problemsOf(stored.entries), []);
		const deflated = zip({ a: 'x' }, 8);
		assert.deepStrictEqual(zipEntries(deflated).problems, []);
		assert.deepStrictEqual(zipEntries(zip({ a: 'x' }, 12)).problems, ['a uses compression method 12 (only stored and deflate are read)']);
		assert.deepStrictEqual(zipEntries(zip({ a: 'x' }, 0, true)).problems, ['a is a ZIP64 entry, which this check does not read']);
		const withBzip = zipEntries(zip({ ...good(), 'extension/package.json': '{}' }, 12));
		assert.ok(problemsOf(withBzip.entries).some((x) => x.startsWith('extension/package.json is not readable JSON')));
	});

	test('the CLI: --vsix on a built zip passes; on a bad one exits 1 with each problem', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-check-vsix-'));
		try {
			const run = (file: string) => spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'check-vsix.mjs'), '--vsix', file], {
				cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20_000,
			});
			fs.writeFileSync(path.join(tmp, 'good.vsix'), zip(good()));
			const ok = run(path.join(tmp, 'good.vsix'));
			assert.strictEqual(ok.status, 0, ok.stderr);
			assert.match(ok.stdout, /no Anthropic package/);
			fs.writeFileSync(path.join(tmp, 'bad.vsix'), zip({ ...good(), [`extension/dist/node_modules/${SDK}/sdk.mjs`]: '' }));
			const bad = run(path.join(tmp, 'bad.vsix'));
			assert.strictEqual(bad.status, 1);
			assert.match(bad.stderr, /is Anthropic's Agent SDK/);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
