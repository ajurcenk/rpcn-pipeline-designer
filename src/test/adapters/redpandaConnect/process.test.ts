import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildRunCommand } from '../../../adapters/redpandaConnect/args';
import { findOnPath, readVersion, runList, runProcess, runStreaming, STREAM_CLOSE_GRACE_MS, StreamingChild, StreamingExit } from '../../../adapters/redpandaConnect/process';
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

suite('adapters/redpandaConnect runList', () => {
	let dir: string;
	setup(() => { dir = makeTempDir(); });
	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	test('runs <invocation…> list --format <format> with NO_COLOR=1 and returns stdout', async () => {
		const bin = writeFakeBinary(dir, 'rpk', '[ "$NO_COLOR" = "1" ] || exit 3\nprintf "%s|" "$@"');
		assert.deepStrictEqual(await runList([bin, 'connect'], 'jsonschema'), {
			kind: 'exited', exitCode: 0, stdout: 'connect|list|--format|jsonschema|', stderr: '',
		});
		const full = await runList([bin], 'json-full');
		assert.strictEqual(full.kind === 'exited' && full.stdout, 'list|--format|json-full|');
	});

	test('large stdout is returned whole', async () => {
		const bin = writeFakeBinary(dir, 'rc', 'head -c 3000000 /dev/zero | tr "\\\\0" a');
		const result = await runList([bin], 'json-full');
		assert.strictEqual(result.kind === 'exited' && result.stdout.length, 3_000_000);
	});

	test('a hanging list times out', async () => {
		const bin = writeFakeBinary(dir, 'rc', 'exec sleep 30');
		assert.deepStrictEqual(await runList([bin], 'jsonschema', 200), { kind: 'timeout', timeoutMs: 200, stderr: '' });
	});
});

suite('adapters/redpandaConnect runProcess caller options', () => {
	let dir: string;
	setup(() => { dir = makeTempDir(); });
	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	test('CALLER_ENV: the caller env is the whole environment, with NO_COLOR=1 forced', async () => {
		const bin = writeFakeBinary(dir, 'env-dump', 'echo "FOO=$FOO NO_COLOR=$NO_COLOR HOME=${HOME:-unset}"');
		const outcome = await runProcess([bin], [], 5_000, { env: { FOO: 'bar', NO_COLOR: '0', PATH: process.env.PATH } });
		assert.deepStrictEqual(outcome, { kind: 'exited', exitCode: 0, stdout: 'FOO=bar NO_COLOR=1 HOME=unset\n', stderr: '' });
	});

	test('DEFAULT_ENV: no env means process.env plus NO_COLOR=1', async () => {
		const bin = writeFakeBinary(dir, 'env-dump', 'echo "SENTINEL=$RPCN_TEST_SENTINEL NO_COLOR=$NO_COLOR"');
		process.env.RPCN_TEST_SENTINEL = 'from-host';
		try {
			const outcome = await runProcess([bin], [], 5_000);
			assert.deepStrictEqual(outcome, { kind: 'exited', exitCode: 0, stdout: 'SENTINEL=from-host NO_COLOR=1\n', stderr: '' });
		} finally {
			delete process.env.RPCN_TEST_SENTINEL;
		}
	});

	test('acceptance: a builder CommandLine with a custom env runs through the spawn site', async () => {
		const bin = writeFakeBinary(dir, 'redpanda-connect', 'echo "FOO=$FOO NO_COLOR=$NO_COLOR ARGS=$*"');
		const target = path.join(dir, 'a.yaml');
		const built = buildRunCommand({ kind: 'ok', path: bin, version: '4.112.0', invocation: [bin] }, { targets: [target] }, {
			resourceFilesSetting: [], envFileSetting: '', homeDir: dir, workspaceFolder: dir,
			processEnv: { FOO: 'custom', NO_COLOR: '0', PATH: process.env.PATH },
		});
		assert.strictEqual(built.kind, 'ok');
		if (built.kind !== 'ok') { return; }
		const expected = `FOO=custom NO_COLOR=1 ARGS=run --set http.enabled=false ${target}\n`;
		assert.deepStrictEqual(await runProcess([built.command], built.args, 5_000, { env: built.env }),
			{ kind: 'exited', exitCode: 0, stdout: expected, stderr: '' });
		let out = '';
		const child = runStreaming([built.command], built.args, { onStdout: (c) => { out += c; } }, { env: built.env });
		assert.deepStrictEqual(await child.exited, { kind: 'exited', exitCode: 0, signal: null });
		assert.strictEqual(out, expected);
	});

	test('BAD_CWD: a missing working directory is a spawnError naming it, not notFound', async () => {
		const bin = writeFakeBinary(dir, 'ok', 'exit 0');
		const missing = path.join(dir, 'nope');
		for (const command of [bin, 'sh']) {
			assert.deepStrictEqual(await runProcess([command], [], 5_000, { cwd: missing }),
				{ kind: 'spawnError', message: `working directory "${missing}" does not exist` });
		}
		assert.deepStrictEqual(await runProcess([bin], [], 5_000, { cwd: bin }),
			{ kind: 'spawnError', message: `working directory "${bin}" is not a directory` });
	});

	test('CWD: the child runs in the given directory', async () => {
		const bin = writeFakeBinary(dir, 'where', 'pwd -P');
		const outcome = await runProcess([bin], [], 5_000, { cwd: dir });
		assert.deepStrictEqual(outcome, { kind: 'exited', exitCode: 0, stdout: `${fs.realpathSync(dir)}\n`, stderr: '' });
	});
});

suite('adapters/redpandaConnect runStreaming', function () {
	this.timeout(20_000);
	let dir: string;
	let children: StreamingChild[];
	setup(() => {
		dir = makeTempDir();
		children = [];
	});
	teardown(async () => {
		// A failed test must not leave its waiter running.
		children.forEach((c) => c.kill('SIGKILL'));
		await Promise.all(children.map((c) => c.exited));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** `runStreaming`, tracked for teardown. */
	function spawnTracked(...args: Parameters<typeof runStreaming>): StreamingChild {
		const child = runStreaming(...args);
		children.push(child);
		return child;
	}

	/** Prints `tick` (stdout) and `log` (stderr), then waits for a signal; INT exits 0 when `trapInt`. */
	function waiter(trapInt: boolean): string {
		return writeFakeBinary(dir, 'waiter', [
			trapInt ? "trap 'echo bye; exit 0' INT" : "trap '' INT",
			'echo tick',
			'echo log >&2',
			'while :; do sleep 0.05; done',
		].join('\n'));
	}

	/** Resolves once `predicate` holds, polling every 10 ms. */
	async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
		const end = Date.now() + timeoutMs;
		while (!predicate()) {
			assert.ok(Date.now() < end, 'timed out');
			await new Promise((r) => setTimeout(r, 10));
		}
	}

	test('STREAM_BEFORE_EXIT / STREAM_STDERR: output arrives while the child runs, per stream', async () => {
		let out = '';
		let err = '';
		let exited = false;
		const child = spawnTracked([waiter(true)], [], { onStdout: (c) => { out += c; }, onStderr: (c) => { err += c; } });
		void child.exited.then(() => { exited = true; });
		await until(() => out === 'tick\n' && err === 'log\n');
		assert.strictEqual(exited, false);
		await child.stop(5_000);
	});

	test('STOP_GRACEFUL: SIGINT ends a child that handles it; no SIGKILL', async () => {
		let out = '';
		const child = spawnTracked([waiter(true)], [], { onStdout: (c) => { out += c; } });
		await until(() => out.includes('tick'));
		const exit = await child.stop(5_000);
		assert.deepStrictEqual(exit, { kind: 'exited', exitCode: 0, signal: null });
		assert.strictEqual(out, 'tick\nbye\n', 'output written while stopping is delivered before exited');
	});

	test('STOP_ESCALATE: a child ignoring SIGINT is killed after the grace period', async () => {
		let out = '';
		const child = spawnTracked([waiter(false)], [], { onStdout: (c) => { out += c; } });
		await until(() => out.includes('tick'));
		const started = Date.now();
		const exit = await child.stop(300);
		assert.ok(Date.now() - started >= 280, `stopped after ${Date.now() - started} ms`);
		assert.deepStrictEqual(exit, { kind: 'exited', exitCode: null, signal: 'SIGKILL' });
	});

	test('EXIT_CODE and KILL_AFTER_EXIT', async () => {
		const child = spawnTracked([writeFakeBinary(dir, 'three', 'exit 3')], []);
		const exit = await child.exited;
		assert.deepStrictEqual(exit, { kind: 'exited', exitCode: 3, signal: null });
		child.kill('SIGKILL');
		assert.strictEqual(await child.stop(10), exit);
	});

	test('kill sends the given signal', async () => {
		let out = '';
		const child = spawnTracked([waiter(false)], [], { onStdout: (c) => { out += c; } });
		await until(() => out.includes('tick'));
		child.kill('SIGTERM');
		assert.deepStrictEqual(await child.exited, { kind: 'exited', exitCode: null, signal: 'SIGTERM' });
	});

	test('CALLER_ENV and CWD reach the streaming child', async () => {
		let out = '';
		const bin = writeFakeBinary(dir, 'env-dump', 'echo "FOO=$FOO NO_COLOR=$NO_COLOR"; pwd -P');
		const child = spawnTracked([bin], [], { onStdout: (c) => { out += c; } }, { env: { FOO: 'bar', NO_COLOR: '' }, cwd: dir });
		assert.deepStrictEqual(await child.exited, { kind: 'exited', exitCode: 0, signal: null });
		assert.strictEqual(out, `FOO=bar NO_COLOR=1\n${fs.realpathSync(dir)}\n`);
	});

	test('the invocation prefix comes before args (rpk connect …)', async () => {
		let out = '';
		const bin = writeFakeBinary(dir, 'args', 'echo "$@"');
		const child = spawnTracked([bin, 'connect'], ['run', 'a.yaml'], { onStdout: (c) => { out += c; } });
		await child.exited;
		assert.strictEqual(out, 'connect run a.yaml\n');
	});

	test('NOT_FOUND / SPAWN_ERROR / EMPTY_COMMAND resolve exited, never throw', async () => {
		const calls: string[] = [];
		const handlers = { onStdout: (c: string) => calls.push(c), onStderr: (c: string) => calls.push(c) };
		const missing = runStreaming([path.join(dir, 'nope')], [], handlers);
		assert.deepStrictEqual(await missing.exited, { kind: 'notFound' });
		const plain = path.join(dir, 'plain');
		fs.writeFileSync(plain, 'not executable', { mode: 0o644 });
		const failed: StreamingExit = await runStreaming([plain], [], handlers).exited;
		assert.strictEqual(failed.kind, 'spawnError');
		const empty = runStreaming([], [], handlers);
		assert.deepStrictEqual(await empty.exited, { kind: 'spawnError', message: 'empty invocation' });
		empty.kill();
		assert.deepStrictEqual(await empty.stop(10), { kind: 'spawnError', message: 'empty invocation' });
		missing.kill();
		assert.deepStrictEqual(calls, []);
	});

	test('stop is idempotent: a second call neither re-signals nor shortens the grace', async () => {
		let out = '';
		const bin = writeFakeBinary(dir, 'counter', [
			"trap 'echo int' INT",
			'echo tick',
			'i=0; while [ $i -lt 40 ]; do sleep 0.05; i=$((i+1)); done',
			'exit 7',
		].join('\n'));
		const child = spawnTracked([bin], [], { onStdout: (c) => { out += c; } });
		await until(() => out.includes('tick'));
		const first = child.stop(10_000);
		const second = child.stop(1);
		assert.deepStrictEqual(await second, { kind: 'exited', exitCode: 7, signal: null }, 'no SIGKILL from the second call');
		assert.strictEqual(await first, await second);
		assert.strictEqual(out.split('int').length - 1, 1, `one SIGINT: ${JSON.stringify(out)}`);
	});

	test('stop grace is clamped: NaN or negative → immediate SIGKILL, huge → a real wait', async () => {
		for (const grace of [Number.NaN, -5]) {
			let out = '';
			const child = spawnTracked([waiter(false)], [], { onStdout: (c) => { out += c; } });
			await until(() => out.includes('tick'));
			assert.deepStrictEqual(await child.stop(grace), { kind: 'exited', exitCode: null, signal: 'SIGKILL' });
		}
		let out = '';
		const child = spawnTracked([waiter(true)], [], { onStdout: (c) => { out += c; } });
		await until(() => out.includes('tick'));
		assert.deepStrictEqual(await child.stop(2 ** 40), { kind: 'exited', exitCode: 0, signal: null }, 'SIGINT honoured, no 1 ms SIGKILL');
	});

	test('a throwing handler is swallowed; later chunks and exited still arrive', async () => {
		const chunks: string[] = [];
		const bin = writeFakeBinary(dir, 'three-lines', 'echo a; sleep 0.1; echo b; sleep 0.1; echo c; exit 4');
		const child = spawnTracked([bin], [], { onStdout: (c) => { chunks.push(c); throw new Error('boom'); } });
		assert.deepStrictEqual(await child.exited, { kind: 'exited', exitCode: 4, signal: null });
		assert.strictEqual(chunks.join(''), 'a\nb\nc\n');
	});

	test('a grandchild holding the pipes: exited resolves after the close grace; later output is dropped', async function () {
		this.timeout(STREAM_CLOSE_GRACE_MS + 10_000);
		let out = '';
		let exitedAt = 0;
		const bin = writeFakeBinary(dir, 'forker', 'echo early; (sleep 4; echo late) & exit 0');
		const started = Date.now();
		const child = spawnTracked([bin], [], { onStdout: (c) => { out += c; } });
		const exit = await child.exited;
		exitedAt = Date.now() - started;
		assert.deepStrictEqual(exit, { kind: 'exited', exitCode: 0, signal: null });
		assert.ok(exitedAt >= STREAM_CLOSE_GRACE_MS - 50 && exitedAt < 3_900, `exited after ${exitedAt} ms`);
		await new Promise((r) => setTimeout(r, 4_500 - exitedAt));
		assert.strictEqual(out, 'early\n');
	});

	test('BAD_CWD: the streaming runner reports a missing working directory', async () => {
		const missing = path.join(dir, 'nope');
		assert.deepStrictEqual(await runStreaming(['sh'], [], {}, { cwd: missing }).exited,
			{ kind: 'spawnError', message: `working directory "${missing}" does not exist` });
	});
});
