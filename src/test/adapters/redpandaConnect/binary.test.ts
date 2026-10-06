import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	BinaryState, describeState, RedpandaConnect, ResolveEnvironment, resolveBinaryState, resolveSettingPath,
} from '../../../adapters/redpandaConnect/binary';
import { makeTempDir, RPK_NO_PLUGIN_SCRIPT, rpkScript, versionScript, writeFakeBinary } from '../../helpers/fakeBinary';

// Rows of the plan's I/O & edge-case matrix. Every test uses an isolated PATH, HOME and
// workspace folder so the developer's real rpk / redpanda-connect are never found.
suite('adapters/redpandaConnect resolveBinaryState', () => {
	let root: string;
	let pathDir: string;
	let env: ResolveEnvironment;

	setup(() => {
		root = makeTempDir('rpcn-resolve-');
		pathDir = path.join(root, 'path');
		fs.mkdirSync(pathDir);
		env = { binaryPathSetting: '', envPath: pathDir, homeDir: path.join(root, 'home'), workspaceFolder: undefined };
	});
	teardown(() => fs.rmSync(root, { recursive: true, force: true }));

	/** A valid standalone on PATH. */
	const withStandaloneOnPath = () => writeFakeBinary(pathDir, 'redpanda-connect', versionScript('4.112.0'));

	test('SETTING_OK', async () => {
		const bin = writeFakeBinary(root, 'rc', versionScript('4.112.0'));
		const { state, message } = await resolveBinaryState({ ...env, binaryPathSetting: bin });
		assert.deepStrictEqual(state, { kind: 'ok', path: bin, version: '4.112.0', invocation: [bin] });
		assert.strictEqual(message, `Redpanda Connect 4.112.0 (${bin})`);
	});

	test('SETTING_V_PREFIX: v4.100.0 is ok and normalized', async () => {
		const bin = writeFakeBinary(root, 'rc', versionScript('v4.100.0'));
		const { state } = await resolveBinaryState({ ...env, binaryPathSetting: bin });
		assert.deepStrictEqual(state, { kind: 'ok', path: bin, version: '4.100.0', invocation: [bin] });
	});

	test('SETTING_OLD: below 4.100.0 is invalid', async () => {
		const bin = writeFakeBinary(root, 'rc', versionScript('4.63.0'));
		const { state, message } = await resolveBinaryState({ ...env, binaryPathSetting: bin });
		assert.deepStrictEqual(state, { kind: 'invalid', path: bin, reason: 'belowMinimum', version: '4.63.0' });
		assert.strictEqual(message, `Redpanda Connect 4.63.0 (${bin}) is older than the minimum supported version 4.100.0.`);
	});

	test('SETTING_OLD: a pre-release of 4.100.0 is below the floor', async () => {
		const bin = writeFakeBinary(root, 'rc', versionScript('4.100.0-rc1'));
		const { state } = await resolveBinaryState({ ...env, binaryPathSetting: bin });
		assert.deepStrictEqual(state, { kind: 'invalid', path: bin, reason: 'belowMinimum', version: '4.100.0-rc1' });
	});

	test('SETTING_MISSING: nonexistent file is missing', async () => {
		const missing = path.join(root, 'nope', 'redpanda-connect');
		const { state, message } = await resolveBinaryState({ ...env, binaryPathSetting: missing });
		assert.deepStrictEqual(state, { kind: 'missing' });
		assert.strictEqual(message, 'No Redpanda Connect binary found: neither "rpk" nor "redpanda-connect" is on PATH, '
			+ `and no binary was found at redpandaConnect.binaryPath "${missing}".`);
	});

	test('SETTING_BAD: non-zero exit is invalid', async () => {
		const bin = writeFakeBinary(root, 'rc', 'echo "" >&2; echo "boom: bad flag" >&2; exit 4');
		const { state, message } = await resolveBinaryState({ ...env, binaryPathSetting: bin });
		assert.deepStrictEqual(state, {
			kind: 'invalid', path: bin, reason: 'nonZeroExit', detail: 'exit code 4: boom: bad flag',
		});
		assert.strictEqual(message, `Redpanda Connect version check failed (${bin}): non-zero exit, exit code 4: boom: bad flag`);
	});

	test('SETTING_BAD: no Version line is invalid', async () => {
		const bin = writeFakeBinary(root, 'rc', 'echo hello; echo warn >&2');
		const { state } = await resolveBinaryState({ ...env, binaryPathSetting: bin });
		assert.deepStrictEqual(state, { kind: 'invalid', path: bin, reason: 'noVersionLine', detail: 'exit code 0: warn' });
	});

	test('SETTING_BAD: an unparseable version is invalid', async () => {
		const bin = writeFakeBinary(root, 'rc', 'echo "Version: dev"');
		const { state } = await resolveBinaryState({ ...env, binaryPathSetting: bin });
		assert.deepStrictEqual(state, { kind: 'invalid', path: bin, reason: 'unparseableVersion', detail: '"Version: dev"' });
	});

	test('SETTING_BAD: a timeout is invalid', async () => {
		const bin = writeFakeBinary(root, 'rc', 'exec sleep 30');
		const { state } = await resolveBinaryState({ ...env, binaryPathSetting: bin }, 200);
		assert.deepStrictEqual(state, { kind: 'invalid', path: bin, reason: 'timeout', detail: 'timed out after 200 ms' });
	});

	test('SETTING_BAD: a non-executable file is invalid, never a throw', async () => {
		const file = path.join(root, 'plain');
		fs.writeFileSync(file, 'x', { mode: 0o644 });
		const { state } = await resolveBinaryState({ ...env, binaryPathSetting: file });
		assert.strictEqual(state.kind === 'invalid' && state.reason, 'spawnError');
	});

	test('RPK_OK: rpk on PATH runs as rpk connect and wins over redpanda-connect', async () => {
		withStandaloneOnPath();
		const rpk = writeFakeBinary(pathDir, 'rpk', rpkScript('4.112.0'));
		const { state, message } = await resolveBinaryState(env);
		assert.deepStrictEqual(state, { kind: 'ok', path: rpk, version: '4.112.0', invocation: [rpk, 'connect'] });
		assert.strictEqual(message, `Redpanda Connect 4.112.0 (${rpk} connect)`);
	});

	test('RPK_NO_PLUGIN: falls through to redpanda-connect', async () => {
		writeFakeBinary(pathDir, 'rpk', RPK_NO_PLUGIN_SCRIPT);
		const rc = withStandaloneOnPath();
		const { state } = await resolveBinaryState(env);
		assert.deepStrictEqual(state, { kind: 'ok', path: rc, version: '4.112.0', invocation: [rc] });
	});

	test('RPK_NO_PLUGIN with nothing else: missing, and the log says rpk connect install has not been run', async () => {
		const rpk = writeFakeBinary(pathDir, 'rpk', RPK_NO_PLUGIN_SCRIPT);
		const { state, message } = await resolveBinaryState(env);
		assert.deepStrictEqual(state, { kind: 'missing' });
		assert.ok(message.includes(`rpk was found at ${rpk}`), message);
		assert.ok(message.includes('"rpk connect install" has not been run'), message);
	});

	test('STANDALONE_OK: redpanda-connect on PATH', async () => {
		const rc = withStandaloneOnPath();
		const { state } = await resolveBinaryState(env);
		assert.deepStrictEqual(state, { kind: 'ok', path: rc, version: '4.112.0', invocation: [rc] });
	});

	test('NOTHING: missing', async () => {
		const { state, message } = await resolveBinaryState(env);
		assert.deepStrictEqual(state, { kind: 'missing' });
		assert.strictEqual(message, 'No Redpanda Connect binary found: neither "rpk" nor "redpanda-connect" is on PATH, '
			+ 'and redpandaConnect.binaryPath is not set.');
	});

	test('an unusable rpk falls through to a usable redpanda-connect', async () => {
		writeFakeBinary(pathDir, 'rpk', rpkScript('4.63.0'));
		const rc = withStandaloneOnPath();
		const { state } = await resolveBinaryState(env);
		assert.deepStrictEqual(state, { kind: 'ok', path: rc, version: '4.112.0', invocation: [rc] });
	});

	test('an unusable rpk with nothing else is reported as invalid', async () => {
		const rpk = writeFakeBinary(pathDir, 'rpk', rpkScript('4.63.0'));
		const { state } = await resolveBinaryState(env);
		assert.deepStrictEqual(state, { kind: 'invalid', path: rpk, reason: 'belowMinimum', version: '4.63.0' });
	});

	test('SETTING_TILDE: ~ expands to the home directory', async () => {
		fs.mkdirSync(path.join(env.homeDir, 'bin'), { recursive: true });
		const bin = writeFakeBinary(path.join(env.homeDir, 'bin'), 'rc', versionScript('4.112.0'));
		const { state } = await resolveBinaryState({ ...env, binaryPathSetting: '~/bin/rc' });
		assert.deepStrictEqual(state, { kind: 'ok', path: bin, version: '4.112.0', invocation: [bin] });
	});

	test('SETTING_TILDE: a missing ~ path reports where it resolved to', async () => {
		const { state, message } = await resolveBinaryState({ ...env, binaryPathSetting: '~/bin/rc' });
		assert.deepStrictEqual(state, { kind: 'missing' });
		assert.ok(message.includes(`(resolved to ${path.join(env.homeDir, 'bin', 'rc')})`), message);
	});

	test('SETTING_RELATIVE: resolved against the first workspace folder', async () => {
		const ws = path.join(root, 'ws');
		fs.mkdirSync(path.join(ws, 'bin'), { recursive: true });
		const bin = writeFakeBinary(path.join(ws, 'bin'), 'rc', versionScript('4.112.0'));
		const { state } = await resolveBinaryState({ ...env, binaryPathSetting: 'bin/rc', workspaceFolder: ws });
		assert.deepStrictEqual(state, { kind: 'ok', path: bin, version: '4.112.0', invocation: [bin] });
	});

	test('SETTING_RELATIVE_NO_WS: invalid relativePathWithoutWorkspace', async () => {
		const { state, message } = await resolveBinaryState({ ...env, binaryPathSetting: 'bin/rc' });
		assert.deepStrictEqual(state, { kind: 'invalid', path: 'bin/rc', reason: 'relativePathWithoutWorkspace' });
		assert.strictEqual(message, 'redpandaConnect.binaryPath "bin/rc" is a relative path, but no workspace folder is open.');
	});

	test('SETTING_BARE_NAME: a name without a separator is looked up on PATH, not in the workspace', async () => {
		const bin = writeFakeBinary(pathDir, 'my-connect', versionScript('4.112.0'));
		const ws = path.join(root, 'ws');
		fs.mkdirSync(ws);
		writeFakeBinary(ws, 'my-connect', versionScript('4.63.0'));
		const { state } = await resolveBinaryState({ ...env, binaryPathSetting: 'my-connect', workspaceFolder: ws });
		assert.deepStrictEqual(state, { kind: 'ok', path: bin, version: '4.112.0', invocation: [bin] });
	});

	test('SETTING_BARE_NAME: missing when not on PATH', async () => {
		const { state, message } = await resolveBinaryState({ ...env, binaryPathSetting: 'my-connect' });
		assert.deepStrictEqual(state, { kind: 'missing' });
		assert.strictEqual(message, 'No Redpanda Connect binary found: neither "rpk" nor "redpanda-connect" is on PATH, '
			+ 'and redpandaConnect.binaryPath "my-connect" is not on PATH.');
	});

	test('RPK_NO_PLUGIN with an invalid redpanda-connect: the log keeps the rpk hint', async () => {
		const rpk = writeFakeBinary(pathDir, 'rpk', RPK_NO_PLUGIN_SCRIPT);
		const rc = writeFakeBinary(pathDir, 'redpanda-connect', versionScript('4.63.0'));
		const { state, message } = await resolveBinaryState(env);
		assert.deepStrictEqual(state, { kind: 'invalid', path: rc, reason: 'belowMinimum', version: '4.63.0' });
		assert.ok(message.startsWith(`Redpanda Connect 4.63.0 (${rc}) is older than`), message);
		assert.ok(message.endsWith(`(rpk was found at ${rpk} but "rpk connect install" has not been run.)`), message);
	});

	test('PATH_WINS: a usable rpk on PATH beats the setting', async () => {
		const rpk = writeFakeBinary(pathDir, 'rpk', rpkScript('4.112.0'));
		const counter = path.join(root, 'setting-runs');
		const bin = writeFakeBinary(root, 'rc', versionScript('4.112.0', { counterFile: counter }));
		const { state } = await resolveBinaryState({ ...env, binaryPathSetting: bin });
		assert.deepStrictEqual(state, { kind: 'ok', path: rpk, version: '4.112.0', invocation: [rpk, 'connect'] });
		assert.strictEqual(fs.existsSync(counter), false, 'the setting must not be probed');
	});

	test('PATH_WINS: a usable redpanda-connect on PATH beats the setting', async () => {
		const rc = withStandaloneOnPath();
		const bin = writeFakeBinary(root, 'rc', versionScript('4.112.0'));
		const { state } = await resolveBinaryState({ ...env, binaryPathSetting: bin });
		assert.deepStrictEqual(state, { kind: 'ok', path: rc, version: '4.112.0', invocation: [rc] });
	});

	test('PATH_INVALID_FALLBACK: an old redpanda-connect on PATH falls back to an ok setting', async () => {
		writeFakeBinary(pathDir, 'redpanda-connect', versionScript('4.63.0'));
		const bin = writeFakeBinary(root, 'rc', versionScript('4.112.0'));
		const { state } = await resolveBinaryState({ ...env, binaryPathSetting: bin });
		assert.deepStrictEqual(state, { kind: 'ok', path: bin, version: '4.112.0', invocation: [bin] });
	});

	test('PATH_INVALID_FALLBACK: when the setting also fails, the PATH invalid is reported', async () => {
		const rc = writeFakeBinary(pathDir, 'redpanda-connect', versionScript('4.63.0'));
		const bin = writeFakeBinary(root, 'rc', 'exit 1');
		const { state } = await resolveBinaryState({ ...env, binaryPathSetting: bin });
		assert.deepStrictEqual(state, { kind: 'invalid', path: rc, reason: 'belowMinimum', version: '4.63.0' });
	});

	test('PATH_INVALID_FALLBACK: a missing setting keeps the PATH invalid', async () => {
		const rc = writeFakeBinary(pathDir, 'redpanda-connect', versionScript('4.63.0'));
		const { state } = await resolveBinaryState({ ...env, binaryPathSetting: path.join(root, 'nope') });
		assert.deepStrictEqual(state, { kind: 'invalid', path: rc, reason: 'belowMinimum', version: '4.63.0' });
	});

	test('SETTING_RPK: a setting pointing at rpk runs as rpk connect', async () => {
		fs.mkdirSync(path.join(root, 'tools'));
		const rpk = writeFakeBinary(path.join(root, 'tools'), 'rpk', rpkScript('4.112.0'));
		const { state, message } = await resolveBinaryState({ ...env, binaryPathSetting: rpk });
		assert.deepStrictEqual(state, { kind: 'ok', path: rpk, version: '4.112.0', invocation: [rpk, 'connect'] });
		assert.strictEqual(message, `Redpanda Connect 4.112.0 (${rpk} connect)`);
	});

	test('SETTING_RPK: a bare rpk.exe setting found on PATH runs as rpk connect, not rpk --version', async () => {
		// The PATH pass looks for `rpk` only (plus `.exe` on win32), so on POSIX only the setting finds this file.
		const rpk = writeFakeBinary(pathDir, 'rpk.exe', rpkScript('4.112.0'));
		const { state } = await resolveBinaryState({ ...env, binaryPathSetting: 'rpk.exe' });
		assert.deepStrictEqual(state, { kind: 'ok', path: rpk, version: '4.112.0', invocation: [rpk, 'connect'] });
	});

	test('SETTING_RPK: a setting rpk without its plugin is missing with the install hint', async () => {
		fs.mkdirSync(path.join(root, 'tools'));
		const rpk = writeFakeBinary(path.join(root, 'tools'), 'rpk', RPK_NO_PLUGIN_SCRIPT);
		const { state, message } = await resolveBinaryState({ ...env, binaryPathSetting: rpk });
		assert.deepStrictEqual(state, { kind: 'missing' });
		assert.ok(message.includes('"rpk connect install" has not been run'), message);
	});

	test('PATH_INVALID_FALLBACK: a setting rpk without its plugin adds its hint to the PATH invalid line', async () => {
		const rc = writeFakeBinary(pathDir, 'redpanda-connect', versionScript('4.63.0'));
		fs.mkdirSync(path.join(root, 'tools'));
		const rpk = writeFakeBinary(path.join(root, 'tools'), 'rpk', RPK_NO_PLUGIN_SCRIPT);
		const { state, message } = await resolveBinaryState({ ...env, binaryPathSetting: rpk });
		assert.deepStrictEqual(state, { kind: 'invalid', path: rc, reason: 'belowMinimum', version: '4.63.0' });
		assert.ok(message.startsWith(`Redpanda Connect 4.63.0 (${rc}) is older than`), message);
		assert.ok(message.endsWith(`(redpandaConnect.binaryPath "${rpk}" is rpk, but "rpk connect install" has not been run.)`), message);
	});

	test('a whitespace-only setting counts as unset', async () => {
		const rc = withStandaloneOnPath();
		const { state } = await resolveBinaryState({ ...env, binaryPathSetting: '   ' });
		assert.deepStrictEqual(state, { kind: 'ok', path: rc, version: '4.112.0', invocation: [rc] });
	});
});

suite('adapters/redpandaConnect resolveSettingPath', () => {
	const home = path.resolve('/home/u');
	const ws = path.resolve('/ws');

	test('tilde forms', () => {
		assert.deepStrictEqual(resolveSettingPath('~', home, ws), { kind: 'path', path: home });
		assert.deepStrictEqual(resolveSettingPath('~/bin/rc', home, undefined), { kind: 'path', path: path.join(home, 'bin', 'rc') });
	});

	test('absolute paths are kept as written', () => {
		const abs = path.resolve('/opt/rpcn/redpanda-connect');
		assert.deepStrictEqual(resolveSettingPath(abs, home, ws), { kind: 'path', path: abs });
	});

	test('relative paths with a separator need a workspace', () => {
		assert.deepStrictEqual(resolveSettingPath('./bin/rc', home, ws), { kind: 'path', path: path.join(ws, 'bin', 'rc') });
		assert.deepStrictEqual(resolveSettingPath('bin\\rc', home, undefined), { kind: 'relativeWithoutWorkspace' });
		assert.deepStrictEqual(resolveSettingPath('~user/rc', home, undefined), { kind: 'relativeWithoutWorkspace' });
	});

	test('bare names are commands, whatever the workspace', () => {
		assert.deepStrictEqual(resolveSettingPath('redpanda-connect', home, ws), { kind: 'command', name: 'redpanda-connect' });
		assert.deepStrictEqual(resolveSettingPath('rpk', home, undefined), { kind: 'command', name: 'rpk' });
	});
});

suite('adapters/redpandaConnect RedpandaConnect (state owner)', () => {
	let root: string;
	let setting: string;
	let lines: string[];
	let events: BinaryState[];
	let rc: RedpandaConnect;

	const create = (timeoutMs?: number) => {
		rc = new RedpandaConnect({
			log: (line) => lines.push(line),
			timeoutMs,
			environment: () => ({ binaryPathSetting: setting, envPath: '', homeDir: root, workspaceFolder: undefined }),
		});
		rc.onDidChange((s) => events.push(s));
		return rc;
	};

	setup(() => {
		root = makeTempDir('rpcn-owner-');
		setting = '';
		lines = [];
		events = [];
	});
	teardown(() => {
		rc?.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('starts unresolved', () => {
		assert.deepStrictEqual(create().state, { kind: 'unresolved' });
	});

	test('SETTING_CHANGED: a trigger re-resolves and fires onDidChange, logging each change once', async () => {
		const good = writeFakeBinary(root, 'good', versionScript('4.112.0'));
		const old = writeFakeBinary(root, 'old', versionScript('4.63.0'));
		setting = good;
		create();
		await rc.refresh();
		assert.strictEqual(rc.state.kind, 'ok');

		setting = path.join(root, 'missing');
		rc.scheduleRefresh();
		await rc.refresh();
		assert.deepStrictEqual(rc.state, { kind: 'missing' });

		setting = old;
		rc.scheduleRefresh();
		await rc.refresh();
		assert.deepStrictEqual(rc.state, { kind: 'invalid', path: old, reason: 'belowMinimum', version: '4.63.0' });

		assert.deepStrictEqual(events.map((e) => e.kind), ['ok', 'missing', 'invalid']);
		assert.strictEqual(lines.length, 3);
		assert.deepStrictEqual(lines, [
			`Redpanda Connect 4.112.0 (${good})`,
			`No Redpanda Connect binary found: neither "rpk" nor "redpanda-connect" is on PATH, and no binary was found at redpandaConnect.binaryPath "${path.join(root, 'missing')}".`,
			describeState(rc.state),
		]);
	});

	test('SAME_STATE: refresh with nothing changed fires no event and logs nothing', async () => {
		setting = writeFakeBinary(root, 'good', versionScript('4.112.0'));
		create();
		await rc.refresh();
		await rc.refresh();
		await rc.refresh();
		assert.strictEqual(events.length, 1);
		assert.strictEqual(lines.length, 1);
	});

	test('SAME_STATE: missing -> missing fires no event but logs the new message', async () => {
		setting = path.join(root, 'a');
		create();
		await rc.refresh();
		setting = path.join(root, 'b');
		await rc.refresh();
		await rc.refresh();
		assert.deepStrictEqual(events, [{ kind: 'missing' }]);
		assert.deepStrictEqual(lines, [
			`No Redpanda Connect binary found: neither "rpk" nor "redpanda-connect" is on PATH, and no binary was found at redpandaConnect.binaryPath "${path.join(root, 'a')}".`,
			`No Redpanda Connect binary found: neither "rpk" nor "redpanda-connect" is on PATH, and no binary was found at redpandaConnect.binaryPath "${path.join(root, 'b')}".`,
		]);
	});

	test('SAME_STATE: missing -> missing logs the rpk-not-installed hint when it appears', async () => {
		const pathDir = path.join(root, 'path');
		fs.mkdirSync(pathDir);
		let envPath = '';
		rc = new RedpandaConnect({
			log: (line) => lines.push(line),
			environment: () => ({ binaryPathSetting: '', envPath, homeDir: root, workspaceFolder: undefined }),
		});
		rc.onDidChange((s) => events.push(s));
		await rc.refresh();
		writeFakeBinary(pathDir, 'rpk', RPK_NO_PLUGIN_SCRIPT);
		envPath = pathDir;
		await rc.refresh();
		assert.deepStrictEqual(events, [{ kind: 'missing' }]);
		assert.strictEqual(lines.length, 2);
		assert.ok(lines[1].includes('"rpk connect install" has not been run'), lines[1]);
	});

	test('SAME_STATE: varying stderr in an invalid result fires no event', async () => {
		setting = writeFakeBinary(root, 'flaky', 'echo "error in run $$" >&2; exit 1');
		create();
		await rc.refresh();
		await rc.refresh();
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].kind === 'invalid' && events[0].reason, 'nonZeroExit');
		assert.strictEqual(lines.length, 1, lines.join('\n'));
	});

	test('CONCURRENT: overlapping refresh() calls share one run and its result', async () => {
		const counter = path.join(root, 'runs');
		setting = writeFakeBinary(root, 'slow', versionScript('4.112.0', { counterFile: counter, sleepSeconds: 0.3 }));
		create();
		const first = rc.refresh();
		const second = rc.refresh();
		assert.strictEqual(first, second);
		const [a, b] = await Promise.all([first, second]);
		assert.deepStrictEqual(a, b);
		assert.strictEqual(a.kind, 'ok');
		assert.strictEqual(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1);
		assert.strictEqual(events.length, 1);
	});

	test('a trigger arriving mid-run schedules exactly one more run', async () => {
		const counter = path.join(root, 'runs');
		const slowOld = writeFakeBinary(root, 'slow-old', versionScript('4.63.0', { counterFile: counter, sleepSeconds: 0.3 }));
		const slowNew = writeFakeBinary(root, 'slow-new', versionScript('4.112.0', { counterFile: counter, sleepSeconds: 0.3 }));
		setting = slowOld;
		create();
		const run = rc.refresh();
		setting = slowNew;
		rc.scheduleRefresh();
		rc.scheduleRefresh();
		rc.scheduleRefresh();
		const joined = rc.refresh();
		const [final, joinedFinal] = await Promise.all([run, joined]);
		assert.strictEqual(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 2);
		assert.strictEqual(final.kind === 'ok' && final.path, slowNew);
		assert.deepStrictEqual(joinedFinal, final);
		assert.deepStrictEqual(events.map((e) => e.kind), ['invalid', 'ok']);
	});

	test('a trigger while idle starts a run', async () => {
		setting = writeFakeBinary(root, 'good', versionScript('4.112.0'));
		create();
		rc.scheduleRefresh();
		await rc.refresh();
		assert.strictEqual(rc.state.kind, 'ok');
	});

	test('after dispose, a finishing run neither changes state nor fires', async () => {
		setting = writeFakeBinary(root, 'slow', versionScript('4.112.0', { sleepSeconds: 0.3 }));
		create();
		const run = rc.refresh();
		rc.dispose();
		await run;
		assert.deepStrictEqual(rc.state, { kind: 'unresolved' });
		assert.strictEqual(events.length, 0);
		assert.strictEqual(lines.length, 0);
	});

	test('after dispose, refresh() spawns nothing and returns the current state', async () => {
		const counter = path.join(root, 'runs');
		setting = writeFakeBinary(root, 'good', versionScript('4.112.0', { counterFile: counter }));
		create();
		await rc.refresh();
		rc.dispose();
		const state = await rc.refresh();
		rc.scheduleRefresh();
		await new Promise((r) => setTimeout(r, 100));
		assert.strictEqual(state.kind, 'ok');
		assert.strictEqual(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1);
	});
});
