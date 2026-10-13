import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArgsEnvironment } from '../../../adapters/redpandaConnect/args';
import { BinaryState } from '../../../adapters/redpandaConnect/binary';
import { binaryLabel, MAPPING_TEST_TIMEOUT_MS, NO_BINARY_MESSAGE, runMappingTest } from '../../../adapters/redpandaConnect/bloblang';
import { ProcessOutcome, SpawnOptions } from '../../../adapters/redpandaConnect/process';

const WS = path.resolve('/ws');
const BIN = path.resolve('/bin/rpk');
const OK: BinaryState = { kind: 'ok', path: BIN, version: '4.112.0', invocation: [BIN, 'connect'] };
const ENV: ArgsEnvironment = {
	resourceFilesSetting: ['r.yaml'], envFileSetting: '.env', homeDir: '/home/u', workspaceFolder: WS, processEnv: { FOO: 'bar' },
};

interface Call { invocation: readonly string[]; args: readonly string[]; timeoutMs: number; options: SpawnOptions; config: string; exists: boolean }

suite('adapters/redpandaConnect runMappingTest (4.2, AD-21)', () => {
	let dir: string;
	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-blobl-test-'));
	});
	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	function fakeRun(outcome: ProcessOutcome, calls: Call[]) {
		return async (invocation: readonly string[], args: readonly string[], timeoutMs: number, options: SpawnOptions) => {
			const target = args[args.length - 1];
			calls.push({ invocation, args, timeoutMs, options, config: fs.readFileSync(target, 'utf8'), exists: fs.existsSync(target) });
			return outcome;
		};
	}

	test('runs the temp config with the Run builder (resources, env file, NO_COLOR) and a 10 s timeout, then removes it', async () => {
		const calls: Call[] = [];
		const storage = path.join(dir, 'storage');
		const outcome = await runMappingTest(OK, 'mutation', 'root.b = 2', '{"a":1}', storage, {
			argsEnvironment: ENV,
			cwd: dir,
			run: fakeRun({ kind: 'exited', exitCode: 0, stdout: '{"content":"{\\"a\\":1,\\"b\\":2}","meta":{}}\n', stderr: '' }, calls),
		});
		assert.deepStrictEqual(outcome.result, { kind: 'ok', content: '{"a":1,"b":2}' });
		assert.strictEqual(outcome.binary, 'rpk connect 4.112.0');
		assert.ok(outcome.durationMs >= 0);
		assert.strictEqual(calls.length, 1);
		const [call] = calls;
		assert.deepStrictEqual(call.invocation, [BIN]);
		const target = call.args[call.args.length - 1];
		assert.strictEqual(path.dirname(target), storage);
		assert.deepStrictEqual(call.args, [
			'connect', 'run', '--set', 'http.enabled=false',
			'--resources', path.join(WS, 'r.yaml'), '--env-file', path.join(WS, '.env'), target,
		]);
		assert.strictEqual(call.timeoutMs, MAPPING_TEST_TIMEOUT_MS);
		assert.strictEqual(call.options.env?.NO_COLOR, '1');
		assert.strictEqual(call.options.env?.FOO, 'bar');
		assert.strictEqual(call.options.cwd, dir);
		assert.ok(call.exists && call.config.includes('- mutation: "root.b = 2"'));
		assert.ok(!fs.existsSync(target), 'the temp config is removed');
		assert.deepStrictEqual(fs.readdirSync(storage), []);
	});

	test('RUN_ERROR: a non-zero exit gives the stderr text, and the temp file is still removed', async () => {
		const calls: Call[] = [];
		const outcome = await runMappingTest(OK, 'mapping', 'root = "${X}"', '{}', dir, {
			argsEnvironment: { ...ENV, resourceFilesSetting: [], envFileSetting: '' },
			run: fakeRun({ kind: 'exited', exitCode: 1, stdout: '', stderr: 'level=error msg="Config lint error"\n' }, calls),
		});
		assert.deepStrictEqual(outcome.result, { kind: 'error', message: 'level=error msg="Config lint error"' });
		assert.deepStrictEqual(fs.readdirSync(dir), []);
	});

	test('a timeout, a missing binary or a spawn failure is an error result', async () => {
		const env = { argsEnvironment: { ...ENV, resourceFilesSetting: [], envFileSetting: '' } };
		const cases: [ProcessOutcome, string][] = [
			[{ kind: 'timeout', timeoutMs: 10_000, stderr: '' }, 'No result after 10 s; stopped.'],
			[{ kind: 'notFound' }, 'The Redpanda Connect binary was not found.'],
			[{ kind: 'spawnError', message: 'EACCES' }, 'Could not start Redpanda Connect: EACCES'],
		];
		for (const [processOutcome, message] of cases) {
			const outcome = await runMappingTest(OK, 'mapping', 'root = this', '{}', dir, { ...env, run: fakeRun(processOutcome, []) });
			assert.deepStrictEqual(outcome.result, { kind: 'error', message });
		}
		assert.deepStrictEqual(fs.readdirSync(dir), []);
	});

	test('NO_BINARY: no spawn, no file', async () => {
		const calls: Call[] = [];
		for (const state of [{ kind: 'missing' }, { kind: 'unresolved' }] as BinaryState[]) {
			const outcome = await runMappingTest(state, 'mapping', 'root = this', '{}', dir, { run: fakeRun({ kind: 'notFound' }, calls) });
			assert.deepStrictEqual(outcome, { result: { kind: 'error', message: NO_BINARY_MESSAGE }, durationMs: outcome.durationMs, binary: null });
		}
		assert.strictEqual(calls.length, 0);
		assert.deepStrictEqual(fs.readdirSync(dir), []);
	});

	test('a builder failure (relative env file without a workspace) is an error result with no spawn', async () => {
		const calls: Call[] = [];
		const outcome = await runMappingTest(OK, 'mapping', 'root = this', '{}', dir, {
			argsEnvironment: { ...ENV, workspaceFolder: undefined, resourceFilesSetting: [] },
			run: fakeRun({ kind: 'notFound' }, calls),
		});
		assert.deepStrictEqual(outcome.result, {
			kind: 'error', message: 'redpandaConnect.envFile ".env" is a relative path, but no workspace folder is open.',
		});
		assert.strictEqual(calls.length, 0);
		assert.deepStrictEqual(fs.readdirSync(dir), []);
	});

	test('binaryLabel', () => {
		assert.strictEqual(binaryLabel(OK), 'rpk connect 4.112.0');
		assert.strictEqual(binaryLabel({ kind: 'ok', path: '/x/redpanda-connect', version: '4.100.0', invocation: ['/x/redpanda-connect'] }), 'redpanda-connect 4.100.0');
		assert.strictEqual(binaryLabel({ kind: 'missing' }), null);
	});
});
