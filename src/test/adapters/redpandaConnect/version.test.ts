import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { findOnPath, readVersion } from '../../../adapters/redpandaConnect/version';
import { makeTempDir, rpkScript, VERSION_4_112_SCRIPT, writeFakeBinary } from '../../helpers/fakeBinary';

suite('adapters/redpandaConnect findOnPath', () => {
	let dir: string;
	setup(() => { dir = makeTempDir(); });
	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	test('finds an executable on PATH, skipping missing dirs', () => {
		const bin = writeFakeBinary(dir, 'redpanda-connect', VERSION_4_112_SCRIPT);
		assert.strictEqual(findOnPath('redpanda-connect', ['/nonexistent-dir', '', dir].join(path.delimiter)), bin);
	});

	test('skips non-executable files and directories', () => {
		fs.writeFileSync(path.join(dir, 'redpanda-connect'), 'not executable', { mode: 0o644 });
		fs.mkdirSync(path.join(dir, 'rpk'));
		assert.strictEqual(findOnPath('redpanda-connect', dir), undefined);
		assert.strictEqual(findOnPath('rpk', dir), undefined);
	});

	test('returns undefined for an empty or unset PATH', () => {
		assert.strictEqual(findOnPath('redpanda-connect', ''), undefined);
		assert.strictEqual(findOnPath('redpanda-connect', undefined), undefined);
	});
});

suite('adapters/redpandaConnect readVersion', () => {
	let dir: string;
	setup(() => { dir = makeTempDir(); });
	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	test('runs <binary> --version with NO_COLOR=1', async () => {
		const bin = writeFakeBinary(dir, 'redpanda-connect', VERSION_4_112_SCRIPT);
		assert.deepStrictEqual(await readVersion([bin]), {
			kind: 'exited', exitCode: 0, stdout: 'Version: 4.112.0\nDate: 2026-10-02T08:48:17Z\n', stderr: '',
		});
	});

	test('runs an argv prefix without a shell: rpk connect --version', async () => {
		const rpk = writeFakeBinary(dir, 'rpk', rpkScript('4.112.0'));
		const result = await readVersion([rpk, 'connect']);
		assert.strictEqual(result.kind === 'exited' && result.stdout.split('\n')[0], 'Version: 4.112.0');
	});

	test('shell metacharacters in an argument are passed literally', async () => {
		const bin = writeFakeBinary(dir, 'echo-args', 'printf "%s|" "$@"');
		const result = await readVersion([bin, '$(echo pwned); x']);
		assert.strictEqual(result.kind === 'exited' && result.stdout, '$(echo pwned); x|--version|');
	});

	test('a non-zero exit is reported with stdout and stderr', async () => {
		const bin = writeFakeBinary(dir, 'rc', 'echo out; echo "boom" >&2; exit 4');
		assert.deepStrictEqual(await readVersion([bin]), { kind: 'exited', exitCode: 4, stdout: 'out\n', stderr: 'boom\n' });
	});

	test('a missing path is notFound', async () => {
		assert.deepStrictEqual(await readVersion([path.join(dir, 'does-not-exist')]), { kind: 'notFound' });
	});

	test('a hanging binary times out', async () => {
		const bin = writeFakeBinary(dir, 'rc', 'exec sleep 30');
		const result = await readVersion([bin], 200);
		assert.deepStrictEqual(result, { kind: 'timeout', timeoutMs: 200, stderr: '' });
	});

	test('a non-exec wrapper whose child holds the pipes still times out on time', async () => {
		const bin = writeFakeBinary(dir, 'rc', 'sleep 3');
		const started = Date.now();
		const result = await readVersion([bin], 200);
		const elapsed = Date.now() - started;
		assert.strictEqual(result.kind, 'timeout');
		assert.ok(elapsed < 1500, `resolved after ${elapsed} ms`);
	});

	test('an existing script with a missing interpreter is a spawn error, not notFound', async () => {
		const file = path.join(dir, 'rc');
		fs.writeFileSync(file, '#!/nonexistent/interpreter\n', { mode: 0o755 });
		assert.strictEqual((await readVersion([file])).kind, 'spawnError');
	});

	test('a non-executable path is a spawn error, not a throw', async () => {
		const file = path.join(dir, 'plain');
		fs.writeFileSync(file, 'x', { mode: 0o644 });
		assert.strictEqual((await readVersion([file])).kind, 'spawnError');
	});

	test('an empty invocation is a spawn error', async () => {
		assert.strictEqual((await readVersion([])).kind, 'spawnError');
	});
});
