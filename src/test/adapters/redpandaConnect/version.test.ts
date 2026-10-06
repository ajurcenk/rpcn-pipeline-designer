import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { describeVersionResult, readVersion, resolveBinary } from '../../../adapters/redpandaConnect/version';
import { makeTempDir, VERSION_4_112_SCRIPT, writeFakeBinary } from '../../helpers/fakeBinary';

suite('adapters/redpandaConnect resolveBinary', () => {
	let dir: string;
	setup(() => { dir = makeTempDir(); });
	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	test('uses the setting as-is when it is a path', () => {
		assert.deepStrictEqual(resolveBinary('/opt/rpcn/redpanda-connect', ''), {
			kind: 'resolved', path: '/opt/rpcn/redpanda-connect', source: 'setting',
		});
	});

	test('finds redpanda-connect on PATH when the setting is empty', () => {
		const bin = writeFakeBinary(dir, 'redpanda-connect', VERSION_4_112_SCRIPT);
		const envPath = ['/nonexistent-dir', dir].join(path.delimiter);
		assert.deepStrictEqual(resolveBinary('', envPath), { kind: 'resolved', path: bin, source: 'path' });
		assert.deepStrictEqual(resolveBinary(undefined, envPath), { kind: 'resolved', path: bin, source: 'path' });
	});

	test('skips non-executable files on PATH', () => {
		fs.writeFileSync(path.join(dir, 'redpanda-connect'), 'not executable', { mode: 0o644 });
		assert.deepStrictEqual(resolveBinary('', dir), { kind: 'notFound', requested: 'redpanda-connect', source: 'path' });
	});

	test('reports notFound when nothing is on PATH', () => {
		assert.deepStrictEqual(resolveBinary('', dir), { kind: 'notFound', requested: 'redpanda-connect', source: 'path' });
	});

	test('looks up a bare command name from the setting on PATH', () => {
		const bin = writeFakeBinary(dir, 'my-connect', VERSION_4_112_SCRIPT);
		assert.deepStrictEqual(resolveBinary('my-connect', dir), { kind: 'resolved', path: bin, source: 'setting' });
		assert.deepStrictEqual(resolveBinary('other', dir), { kind: 'notFound', requested: 'other', source: 'setting' });
	});
});

suite('adapters/redpandaConnect readVersion', () => {
	let dir: string;
	setup(() => { dir = makeTempDir(); });
	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	test('HAPPY_PATH: parses the version (and passes NO_COLOR=1)', async () => {
		const bin = writeFakeBinary(dir, 'redpanda-connect', VERSION_4_112_SCRIPT);
		const result = await readVersion(bin, 'path');
		assert.deepStrictEqual(result, { kind: 'ok', path: bin, version: '4.112.0', source: 'path' });
		assert.strictEqual(describeVersionResult(result), `Redpanda Connect 4.112.0 (${bin})`);
	});

	test('NO_BINARY: a missing configured path is notFound', async () => {
		const missing = path.join(dir, 'does-not-exist');
		const result = await readVersion(missing, 'setting');
		assert.deepStrictEqual(result, { kind: 'notFound', requested: missing, source: 'setting' });
		assert.match(describeVersionResult(result), /^No Redpanda Connect binary found/);
	});

	test('BAD_OUTPUT: non-zero exit reports exit code and first stderr line', async () => {
		const bin = writeFakeBinary(dir, 'rc', 'echo "" >&2; echo "boom: bad flag" >&2; echo "second" >&2; exit 4');
		const result = await readVersion(bin, 'setting');
		assert.deepStrictEqual(result, {
			kind: 'failed', path: bin, source: 'setting', exitCode: 4, stderrFirstLine: 'boom: bad flag', reason: 'nonZeroExit',
		});
		const line = describeVersionResult(result);
		assert.match(line, /exit code 4/);
		assert.match(line, /boom: bad flag/);
	});

	test('BAD_OUTPUT: exit 0 without a Version line', async () => {
		const bin = writeFakeBinary(dir, 'rc', 'echo "hello"; echo "warn" >&2; exit 0');
		const result = await readVersion(bin, 'setting');
		assert.deepStrictEqual(result, {
			kind: 'failed', path: bin, source: 'setting', exitCode: 0, stderrFirstLine: 'warn', reason: 'noVersionLine',
		});
		assert.match(describeVersionResult(result), /exit code 0: warn$/);
	});

	test('a hanging binary times out', async () => {
		const bin = writeFakeBinary(dir, 'rc', 'exec sleep 30');
		const result = await readVersion(bin, 'setting', 200);
		assert.strictEqual(result.kind, 'failed');
		assert.strictEqual(result.kind === 'failed' && result.reason, 'timeout');
	});

	test('a non-exec wrapper whose child holds the pipes still times out on time', async () => {
		const bin = writeFakeBinary(dir, 'rc', 'sleep 3');
		const started = Date.now();
		const result = await readVersion(bin, 'setting', 200);
		const elapsed = Date.now() - started;
		assert.strictEqual(result.kind === 'failed' && result.reason, 'timeout');
		assert.ok(elapsed < 1500, `resolved after ${elapsed} ms`);
	});

	test('an existing script with a missing interpreter is a spawn error, not notFound', async () => {
		const file = path.join(dir, 'rc');
		fs.writeFileSync(file, '#!/nonexistent/interpreter\n', { mode: 0o755 });
		const result = await readVersion(file, 'setting');
		assert.strictEqual(result.kind, 'failed');
		assert.strictEqual(result.kind === 'failed' && result.reason, 'spawnError');
	});

	test('a non-executable path is a spawn error, not a throw', async () => {
		const file = path.join(dir, 'plain');
		fs.writeFileSync(file, 'x', { mode: 0o644 });
		const result = await readVersion(file, 'setting');
		assert.strictEqual(result.kind, 'failed');
		assert.strictEqual(result.kind === 'failed' && result.reason, 'spawnError');
	});
});
