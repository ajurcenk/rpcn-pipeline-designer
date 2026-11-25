import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { firstMissingFolder, linkTarget, maskHome, removeEmptyFolders, SKILLS_CHECKOUT_FILES, skillsCopy, turnFiles, type TurnSnapshot } from '../../../adapters/vscode/assistantView';
import { parseCommand, undoLaterEditsText } from '../../../shared/assistantProtocol';
import { normalBaseUrl, usableBaseUrl } from '../../../adapters/vscode/assistantAccess';
import { proxyConfigFor } from '../../../adapters/vscode/assistantRuntime';

// Story 8.1 review: the home mask at path boundaries only (review 14), and the usable base URLs (review 3).
suite('assistant view masks and base URLs (story 8.1)', () => {
	test('review 14: the home folder is masked only as a whole path prefix', () => {
		const homes = ['/home/u'];
		assert.strictEqual(maskHome('read /home/u/notes.txt', homes), 'read ~/notes.txt');
		assert.strictEqual(maskHome('cwd is /home/u', homes), 'cwd is ~');
		assert.strictEqual(maskHome('"/home/u" and (/home/u)', homes), '"~" and (~)');
		assert.strictEqual(maskHome('/home/user2/x and /home/u2', homes), '/home/user2/x and /home/u2');
		assert.strictEqual(maskHome('/home/u.bak/x', homes), '/home/u.bak/x');
		assert.strictEqual(maskHome('/a/b', ['', '/']), '/a/b', 'no empty or root home');
	});

	test('review 3: https, or http on loopback only; no credentials in the URL', () => {
		assert.ok(usableBaseUrl('https://api.anthropic.com'));
		assert.ok(usableBaseUrl('http://127.0.0.1:4000'));
		assert.ok(usableBaseUrl('http://localhost:4000/v1'));
		assert.ok(usableBaseUrl('http://[::1]:4000'));
		assert.ok(!usableBaseUrl('http://adp.example.com'));
		assert.ok(!usableBaseUrl('http://127.0.0.1.example.com'));
		assert.ok(!usableBaseUrl('https://user:pw@adp.example.com'));
		assert.ok(!usableBaseUrl('ftp://adp.example.com'));
		assert.ok(!usableBaseUrl('not a url'));
		assert.strictEqual(normalBaseUrl('https://ADP.example.com/v1/'), 'https://adp.example.com/v1');
		assert.strictEqual(normalBaseUrl('https://adp.example.com'), 'https://adp.example.com');
		assert.strictEqual(normalBaseUrl(undefined), undefined);
	});
});

// Story 8.2: `redpandaConnect.assistant.skillsPath`: the bundled copy when unset, a checkout only with its
// manifest and its three skills, never the workspace or a folder in or around it.
suite('assistant skills copy (story 8.2)', () => {
	let dir: string;
	const checkout = (at: string) => {
		for (const f of SKILLS_CHECKOUT_FILES) {
			fs.mkdirSync(path.dirname(path.join(at, f)), { recursive: true });
			fs.writeFileSync(path.join(at, f), '{}');
		}
	};
	setup(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-skills-path-')));
	});
	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	test('empty: the bundled copy; a checkout: that local copy', () => {
		assert.deepStrictEqual(skillsCopy(undefined, '/ext/assets/rpcn-skills', undefined), { kind: 'bundled', dir: '/ext/assets/rpcn-skills' });
		assert.deepStrictEqual(skillsCopy('  ', '/b', undefined), { kind: 'bundled', dir: '/b' });
		checkout(dir);
		assert.deepStrictEqual(skillsCopy(` ${dir}${path.sep} `, '/b', undefined), { kind: 'local', dir });
		assert.deepStrictEqual(skillsCopy(`~${path.sep}${path.basename(dir)}`, '/b', undefined, path.dirname(dir)), { kind: 'local', dir }, '~ expands');
		assert.deepStrictEqual(skillsCopy(dir, '/b', path.join(os.tmpdir(), 'elsewhere-ws')), { kind: 'local', dir }, 'a workspace elsewhere');
	});

	test('review 8: a value that is not a string counts as unset', () => {
		for (const v of [42, true, null, ['/x'], { path: '/x' }]) {
			assert.deepStrictEqual(skillsCopy(v, '/b', undefined), { kind: 'bundled', dir: '/b' }, JSON.stringify(v));
		}
	});

	test('review 7, 15: a relative path, a missing folder, or no full checkout: each its own reason', () => {
		const bad = (problem: string) => ({ kind: 'bad', problem });
		assert.deepStrictEqual(skillsCopy('rpcn-skills', '/b', undefined), bad('notAbsolute'));
		assert.deepStrictEqual(skillsCopy('~user/rpcn-skills', '/b', undefined), bad('notAbsolute'), 'only ~ and ~/ expand');
		assert.deepStrictEqual(skillsCopy(path.join(dir, 'nope'), '/b', undefined), bad('notFound'));
		fs.writeFileSync(path.join(dir, 'file'), '');
		assert.deepStrictEqual(skillsCopy(path.join(dir, 'file'), '/b', undefined), bad('notFound'), 'a file is no folder');
		assert.deepStrictEqual(skillsCopy(dir, '/b', undefined), bad('notCheckout'));
		fs.mkdirSync(path.join(dir, '.claude-plugin', 'plugin.json'), { recursive: true });
		assert.deepStrictEqual(skillsCopy(dir, '/b', undefined), bad('notCheckout'), 'plugin.json must be a file');
		fs.rmSync(path.join(dir, '.claude-plugin'), { recursive: true });
		checkout(dir);
		fs.rmSync(path.join(dir, 'skills', 'rpcn-test', 'SKILL.md'));
		assert.deepStrictEqual(skillsCopy(dir, '/b', undefined), bad('notCheckout'), 'every rpcn skill is needed');
	});

	test('review 1: the workspace itself, a folder inside it, or one containing it is refused', () => {
		const ws = path.join(dir, 'ws');
		checkout(ws);
		checkout(path.join(ws, 'skills-in-ws'));
		checkout(dir);
		assert.deepStrictEqual(skillsCopy(ws, '/b', ws), { kind: 'bad', problem: 'inWorkspace' });
		assert.deepStrictEqual(skillsCopy(path.join(ws, 'skills-in-ws'), '/b', ws), { kind: 'bad', problem: 'inWorkspace' });
		assert.deepStrictEqual(skillsCopy(dir, '/b', ws), { kind: 'bad', problem: 'inWorkspace' }, 'containing it');
		fs.symlinkSync(ws, path.join(dir, 'link-to-ws'));
		assert.deepStrictEqual(skillsCopy(path.join(dir, 'link-to-ws'), '/b', ws), { kind: 'bad', problem: 'inWorkspace' }, 'through a symlink');
		// Multi-root: inside any of the folders, not only the first.
		assert.deepStrictEqual(skillsCopy(path.join(ws, 'skills-in-ws'), '/b', [path.join(os.tmpdir(), 'other-ws'), ws]), { kind: 'bad', problem: 'inWorkspace' }, 'a second folder');
		assert.deepStrictEqual(skillsCopy(path.join(ws, 'skills-in-ws'), '/b', [path.join(os.tmpdir(), 'other-ws')]).kind, 'local');
	});
});

// Story 8.2: the runtime download's proxy settings: VS Code's first, then the environment's.
suite('assistant runtime proxy settings (story 8.2)', () => {
	const http = (values: Record<string, unknown>) => ({ get: <T>(key: string) => values[key] as T | undefined });
	const https = new URL('https://registry.npmjs.org/x');

	test('http.proxy wins over HTTPS_PROXY; NO_PROXY and http.noProxy both apply; proxyStrictSSL; extra CAs', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-proxy-'));
		try {
			fs.writeFileSync(path.join(dir, 'ca.pem'), 'PEM');
			const env = { HTTPS_PROXY: 'http://env:1', NO_PROXY: 'a.example', NODE_EXTRA_CA_CERTS: path.join(dir, 'ca.pem') };
			assert.deepStrictEqual(proxyConfigFor(https, http({ proxy: 'http://setting:2', noProxy: ['b.example'], proxyStrictSSL: false }), env),
				{ proxy: 'http://setting:2', noProxy: ['a.example', 'b.example'], strictSSL: false, ca: ['PEM'] });
			assert.deepStrictEqual(proxyConfigFor(https, http({ proxy: '' }), env).proxy, 'http://env:1');
			assert.deepStrictEqual(proxyConfigFor(https, http({}), { https_proxy: 'http://lower:3' }), { proxy: 'http://lower:3', noProxy: [], strictSSL: true, ca: [] });
			assert.strictEqual(proxyConfigFor(https, http({}), { NODE_EXTRA_CA_CERTS: path.join(dir, 'missing.pem') }).ca?.length, 0);
			assert.strictEqual(proxyConfigFor(https, http({}), {}).proxy, undefined);
			assert.strictEqual(proxyConfigFor(https, http({ proxy: 'http://setting:2', proxySupport: 'off' }), env).proxy, undefined, 'proxySupport off: none from settings or env');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

// Story 8.12: the chat's pure parts: the slash commands, a reply link's target, a turn's file rows.
suite('assistant chat turns (story 8.12)', () => {
	const ws = path.resolve('/w/project');

	test('a message\'s slash command, and the text after it; none: the text trimmed', () => {
		assert.deepStrictEqual(parseCommand('/design orders to an API'), { command: 'design', rest: 'orders to an API' });
		assert.deepStrictEqual(parseCommand('  /build\nnow'), { command: 'build', rest: 'now' });
		assert.deepStrictEqual(parseCommand('/test'), { command: 'test', rest: '' });
		assert.deepStrictEqual(parseCommand('/designer x'), { command: null, rest: '/designer x' });
		assert.deepStrictEqual(parseCommand(' orders /design '), { command: null, rest: 'orders /design' });
		assert.strictEqual(undoLaterEditsText(['a.yaml']), 'Undo will discard your edits to `a.yaml` since the turn.');
	});

	test('a link: http(s) opens outside; a path inside the workspace is a file; anything else nothing', () => {
		assert.deepStrictEqual(linkTarget('https://docs.redpanda.com/x', ws), { kind: 'external', url: 'https://docs.redpanda.com/x' });
		assert.deepStrictEqual(linkTarget('HTTP://localhost:4000/', ws), { kind: 'external', url: 'http://localhost:4000/' });
		assert.deepStrictEqual(linkTarget('orders.design.md#decisions', ws), { kind: 'file', path: path.join(ws, 'orders.design.md') });
		assert.deepStrictEqual(linkTarget('sub/a%20b.yaml', ws), { kind: 'file', path: path.join(ws, 'sub', 'a b.yaml') });
		for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'command:workbench.action.reloadWindow', 'vscode://x', '../outside.yaml', '/etc/passwd', '//evil.example/x', '#top', '', '%E0%A4%A']) {
			assert.strictEqual(linkTarget(bad, ws), undefined, bad);
		}
		assert.strictEqual(linkTarget('a.yaml', undefined), undefined, 'no workspace');
	});

	test('file rows: a changed or new file with its counts; an unchanged one none; one over 1 MB only when written', () => {
		const snaps = new Map<string, TurnSnapshot>([
			[path.join(ws, 'a.design.md'), { before: null, tooLarge: false }],
			[path.join(ws, 'same.yaml'), { before: 'x\n', tooLarge: false }],
			[path.join(ws, 'sub', 'edit.yaml'), { before: 'a\nb\n', tooLarge: false }],
			[path.join(ws, 'big.json'), { before: null, tooLarge: true }],
			[path.join(ws, 'big2.json'), { before: null, tooLarge: true }],
			[path.join(ws, 'denied.yaml'), { before: null, tooLarge: false }],
		]);
		const now: Record<string, string> = { 'a.design.md': '1\n2\n3\n', 'same.yaml': 'x\n', 'sub/edit.yaml': 'a\nc\n' };
		const read = (abs: string) => now[path.relative(ws, abs).split(path.sep).join('/')] ?? null;
		const rows = turnFiles(snaps, new Set([path.join(ws, 'big.json')]), ws, read);
		assert.deepStrictEqual(rows.map((r) => [r.path, r.added, r.removed, r.created, r.tooLarge]), [
			['a.design.md', 3, 0, true, false],
			['sub/edit.yaml', 1, 1, false, false],
			['big.json', 0, 0, false, true],
		]);
		assert.strictEqual(rows[1].before, 'a\nb\n');
		assert.strictEqual(rows[1].after, 'a\nc\n');
	});

	test('a file the turn created at 2 MB, or grew past 1 MB: too large (no content read, no diff, no undo)', () => {
		const snaps = new Map<string, TurnSnapshot>([
			[path.join(ws, 'created.json'), { before: null, tooLarge: false }],
			[path.join(ws, 'grown.json'), { before: 'small\n', tooLarge: false }],
		]);
		const read = () => {
			throw new Error('read');
		};
		const rows = turnFiles(snaps, new Set(), ws, read, () => 2 * 1024 * 1024);
		assert.deepStrictEqual(rows.map((r) => [r.path, r.tooLarge, r.created, r.before, r.after]), [['created.json', true, true, null, null], ['grown.json', true, false, null, null]]);
	});

	test('a real 2 MB file the turn created: too large', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-turn-files-'));
		try {
			const big = path.join(dir, 'big.json');
			fs.writeFileSync(big, 'x'.repeat(2 * 1024 * 1024));
			const rows = turnFiles(new Map([[big, { before: null, tooLarge: false }]]), new Set([big]), dir, () => assert.fail('no read'));
			assert.deepStrictEqual(rows.map((r) => [r.path, r.tooLarge, r.after]), [['big.json', true, null]]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('the folder a new file\'s write creates; empty folders removed bottom-up, never one holding a file', () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-turn-folders-')));
		try {
			fs.mkdirSync(path.join(dir, 'flows'));
			assert.strictEqual(firstMissingFolder(dir, path.join(dir, 'flows', 'x', 'y', 'a.yaml')), path.join(dir, 'flows', 'x'));
			assert.strictEqual(firstMissingFolder(dir, path.join(dir, 'flows', 'a.yaml')), undefined);
			assert.strictEqual(firstMissingFolder(dir, path.join(dir, 'a.yaml')), undefined);
			fs.mkdirSync(path.join(dir, 'flows', 'x', 'y', 'z'), { recursive: true });
			fs.mkdirSync(path.join(dir, 'flows', 'x', 'kept'), { recursive: true });
			fs.writeFileSync(path.join(dir, 'flows', 'x', 'kept', 'mine.txt'), 'mine');
			assert.strictEqual(removeEmptyFolders(path.join(dir, 'flows', 'x')), false);
			assert.ok(!fs.existsSync(path.join(dir, 'flows', 'x', 'y')), 'the empty ones went');
			assert.ok(fs.existsSync(path.join(dir, 'flows', 'x', 'kept', 'mine.txt')), 'the file stays');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
