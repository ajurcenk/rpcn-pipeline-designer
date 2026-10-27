import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	encodeEnvFile, encodeEnvValue, ENV_SETTING_FOLDER, envFileName, envSettingContent, EnvSettingFiles, KEY_FILE, SWEEP_AGE_MS,
	validateEnvSetting,
} from '../../../adapters/redpandaConnect/envSetting';

// Ticket 29: the `redpandaConnect.env` setting's validation, encoding and file.
suite('adapters/redpandaConnect envSetting', () => {
	let dir: string;
	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-env-setting-'));
	});
	teardown(() => {
		fs.chmodSync(dir, 0o700);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('ESCAPES: backslash, double quote, newline and carriage return are escaped; the rest is kept as is', () => {
		assert.strictEqual(encodeEnvValue(''), '""');
		assert.strictEqual(encodeEnvValue('a b # c'), '"a b # c"');
		assert.strictEqual(encodeEnvValue('say "hi"'), '"say \\"hi\\""');
		assert.strictEqual(encodeEnvValue('C:\\dir\\'), '"C:\\\\dir\\\\"');
		assert.strictEqual(encodeEnvValue('one\ntwo\r\n'), '"one\\ntwo\\r\\n"');
		assert.strictEqual(encodeEnvValue('${HOME} $X'), '"${HOME} $X"');
		assert.strictEqual(encodeEnvValue('ünïcødé ✓'), '"ünïcødé ✓"');
		assert.strictEqual(encodeEnvFile([['A', '1'], ['B', 'x"y']]), 'A="1"\nB="x\\"y"\n');
	});

	test('INVALID: bad names and non-string values are left out, in the setting\'s order; the rest sorted by name', () => {
		assert.deepStrictEqual(validateEnvSetting({ '1X': 'v', OK: 5, GOOD: 'g', _a1: '', 'A-B': 'x', N: null }), {
			variables: [['GOOD', 'g'], ['_a1', '']],
			invalid: ['1X', 'OK', 'A-B', 'N'],
		});
		assert.deepStrictEqual(validateEnvSetting({ Z: 'z', A: 'a' }).variables, [['A', 'a'], ['Z', 'z']]);
	});

	test('EMPTY: unset, {} and anything but an object hold no variables', () => {
		for (const raw of [undefined, null, {}, [], 'A=1', 5]) {
			assert.deepStrictEqual(validateEnvSetting(raw), { variables: [], invalid: [] }, JSON.stringify(raw));
			assert.strictEqual(envSettingContent(raw), undefined);
		}
		assert.strictEqual(envSettingContent({ '1X': 'v' }), undefined);
	});

	test('the name is the content\'s keyed hash: the same variables in any order give one name; a change or another key, another', () => {
		const key = Buffer.alloc(32, 1);
		const a = envSettingContent({ A: '1', B: '2' })!;
		assert.strictEqual(a, envSettingContent({ B: '2', A: '1' }));
		assert.match(envFileName(a, key), /^env-[0-9a-f]{64}\.env$/);
		assert.strictEqual(envFileName(a, key), envFileName(a, Buffer.alloc(32, 1)));
		assert.notStrictEqual(envFileName(a, key), envFileName(envSettingContent({ A: '1', B: '3' })!, key));
		assert.notStrictEqual(envFileName(a, key), envFileName(a, Buffer.alloc(32, 2)));
		assert.notStrictEqual(envFileName(a, key), `env-${createHash('sha256').update(a).digest('hex')}.env`, 'not the bare sha256');
	});

	test('write: under env-setting, owner-only, the exact content; the same content reuses the file', () => {
		const files = EnvSettingFiles.in(dir);
		assert.strictEqual(files.dir, path.join(dir, ENV_SETTING_FOLDER));
		const content = encodeEnvFile([['API_TOKEN', 't']]);
		const first = files.write(content);
		assert.ok(first.kind === 'ok', JSON.stringify(first));
		assert.strictEqual(path.dirname(first.path), files.dir);
		const keyFile = path.join(files.dir, KEY_FILE);
		const key = fs.readFileSync(keyFile);
		assert.strictEqual(key.length, 32);
		assert.strictEqual(path.basename(first.path), envFileName(content, key));
		assert.strictEqual(fs.readFileSync(first.path, 'utf8'), 'API_TOKEN="t"\n');
		if (process.platform !== 'win32') {
			assert.strictEqual(fs.statSync(first.path).mode & 0o777, 0o600);
			assert.strictEqual(fs.statSync(keyFile).mode & 0o777, 0o600);
			assert.strictEqual(fs.statSync(files.dir).mode & 0o777, 0o700);
		}
		// The fast path does not rewrite the file but refreshes its mtime.
		const ino = fs.statSync(first.path).ino;
		const old = new Date(Date.now() - 2 * SWEEP_AGE_MS);
		fs.utimesSync(first.path, old, old);
		assert.deepStrictEqual(files.write(content), first);
		assert.strictEqual(fs.statSync(first.path).ino, ino, 'not rewritten');
		assert.ok(Date.now() - fs.statSync(first.path).mtimeMs < 60_000, 'mtime refreshed');
		// Another session in the same folder reads the same key, so the same content has the same name.
		assert.deepStrictEqual(EnvSettingFiles.in(dir).write(content), first);
		assert.deepStrictEqual(fs.readFileSync(keyFile), key, 'the key is created once');
		// Removed by something else (another window's sweep): written again.
		fs.rmSync(first.path);
		assert.deepStrictEqual(files.write(content), first);
		assert.ok(fs.existsSync(first.path));
		assert.deepStrictEqual(fs.readdirSync(files.dir).sort(), [path.basename(first.path), KEY_FILE].sort(), 'no temporary file is left');
	});

	test('write: an existing folder with other permissions is made owner-only', function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		fs.mkdirSync(path.join(dir, ENV_SETTING_FOLDER), { mode: 0o755 });
		const files = EnvSettingFiles.in(dir);
		assert.strictEqual(files.write('A="1"\n').kind, 'ok');
		assert.strictEqual(fs.statSync(files.dir).mode & 0o777, 0o700);
	});

	test('WRITE_FAILS: an unwritable storage folder gives the reason and the path, never a value; nothing throws', function () {
		if (process.platform === 'win32' || process.getuid?.() === 0) {
			this.skip();
		}
		fs.chmodSync(dir, 0o500);
		const files = EnvSettingFiles.in(dir);
		const result = files.write(encodeEnvFile([['SECRET', 'hunter2']]));
		assert.strictEqual(result.kind, 'failed');
		assert.ok(result.kind === 'failed');
		assert.strictEqual(path.dirname(result.path), files.dir);
		assert.match(result.reason, /EACCES|permission/i);
		assert.ok(!result.reason.includes('hunter2'));
		// An unreadable key (a folder in its place): a failure naming the key file.
		fs.chmodSync(dir, 0o700);
		fs.mkdirSync(files.dir, { mode: 0o700 });
		fs.mkdirSync(path.join(files.dir, KEY_FILE));
		const noKey = EnvSettingFiles.in(dir).write('A="1"\n');
		assert.ok(noKey.kind === 'failed', JSON.stringify(noKey));
		assert.strictEqual(noKey.path, path.join(files.dir, KEY_FILE));
		fs.rmSync(files.dir, { recursive: true });
		// The env-setting folder is a regular file (ENOTDIR on the write): a failure, not a throw.
		fs.chmodSync(dir, 0o700);
		fs.writeFileSync(files.dir, '');
		const notDir = files.write('A="1"\n');
		assert.strictEqual(notDir.kind, 'failed', JSON.stringify(notDir));
		fs.rmSync(files.dir);
		// A storage path under a regular file.
		const file = path.join(os.tmpdir(), `rpcn-env-setting-file-${process.pid}`);
		fs.writeFileSync(file, '');
		try {
			assert.strictEqual(EnvSettingFiles.in(file).write('A="1"\n').kind, 'failed');
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	test('INVALID logging: once per distinct setting value, naming the keys, never the values', () => {
		const lines: string[] = [];
		const files = EnvSettingFiles.in(dir, (l) => lines.push(l));
		const raw = { '1X': 'secret-one', OK: 5, GOOD: 'secret-two' };
		assert.deepStrictEqual(files.variables(raw).variables, [['GOOD', 'secret-two']]);
		files.variables({ GOOD: 'secret-two', OK: 5, '1X': 'secret-one' });
		assert.strictEqual(lines.length, 1, JSON.stringify(lines));
		assert.match(lines[0], /redpandaConnect\.env/);
		assert.match(lines[0], /"1X", "OK"/);
		assert.ok(!lines[0].includes('secret'));
		assert.ok(!lines[0].includes('GOOD'));
		files.variables({ '1X': 'other' });
		assert.strictEqual(lines.length, 2);
		files.variables({ GOOD: 'g' });
		assert.strictEqual(lines.length, 2, 'a valid value logs nothing');
	});

	test('sweep: removes only files not current and more than a day old (temporary leftovers too); keeps current, fresh and foreign files', () => {
		const files = EnvSettingFiles.in(dir);
		const write = (content: string) => {
			const result = files.write(content);
			assert.ok(result.kind === 'ok', JSON.stringify(result));
			return result.path;
		};
		const age = (file: string) => {
			const old = new Date(Date.now() - SWEEP_AGE_MS - 60_000);
			fs.utimesSync(file, old, old);
		};
		const currentOld = write('A="1"\n');
		const staleOld = write('A="0"\n');
		const staleFresh = write('A="2"\n'); // another window's, in use
		const tmpOld = path.join(files.dir, '.tmp-0123');
		const tmpFresh = path.join(files.dir, '.tmp-4567');
		fs.writeFileSync(tmpOld, '');
		fs.writeFileSync(tmpFresh, '');
		fs.writeFileSync(path.join(files.dir, 'notes.txt'), '');
		for (const file of [currentOld, staleOld, tmpOld, path.join(files.dir, 'notes.txt'), path.join(files.dir, KEY_FILE)]) {
			age(file);
		}
		// A new session (activation) reads the key from the folder.
		assert.deepStrictEqual(EnvSettingFiles.in(dir).sweep(['A="1"\n']), []);
		assert.deepStrictEqual(fs.readdirSync(files.dir).sort(),
			[currentOld, staleFresh, tmpFresh].map((f) => path.basename(f)).concat('notes.txt', KEY_FILE).sort());
		assert.deepStrictEqual(EnvSettingFiles.in(path.join(dir, 'missing')).sweep([]), [], 'no folder: nothing to do');
	});
});
