import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArgsEnvironment } from '../../../adapters/redpandaConnect/args';
import { BinaryState } from '../../../adapters/redpandaConnect/binary';
import {
	binaryLabel, MAPPING_PARSE_TIMEOUT_MS, MAPPING_TEST_TIMEOUT_MS, NO_BINARY_MESSAGE, parseMapping, runMappingTest,
} from '../../../adapters/redpandaConnect/bloblang';
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
		const outcome = await runMappingTest(OK, 'mutation', 'root.b = 2', '{"a":1}', {}, storage, {
			argsEnvironment: ENV,
			cwd: dir,
			run: fakeRun({ kind: 'exited', exitCode: 0, stdout: '{"content":"{\\"a\\":1,\\"b\\":2}","meta":{}}\n', stderr: '' }, calls),
		});
		assert.deepStrictEqual(outcome.result, {
			kind: 'ok',
			content: '{"a":1,"b":2}',
			meta: {},
			changes: { fields: { added: ['b'], changed: [], removed: [] }, meta: { added: [], changed: [], removed: [] } },
		});
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

	test('META_IN: the metadata is set by the generate input and is the input of changes.meta', async () => {
		const calls: Call[] = [];
		const outcome = await runMappingTest(OK, 'mapping', 'root.k = @k', '{"a":1}', { k: 'v', gone: 'x' }, dir, {
			argsEnvironment: { ...ENV, resourceFilesSetting: [], envFileSetting: '' },
			run: fakeRun({ kind: 'exited', exitCode: 0, stdout: '{"content":"{\\"a\\":1,\\"k\\":\\"v\\"}","meta":{"k":"w","out":"x"}}\n', stderr: '' }, calls),
		});
		assert.ok(calls[0].config.includes('mapping: "root = \\"{\\\\\\"a\\\\\\":1}\\"\\x0Ameta \\"k\\" = \\"v\\"\\x0Ameta \\"gone\\" = \\"x\\""'), calls[0].config);
		assert.deepStrictEqual(outcome.result, {
			kind: 'ok',
			content: '{"a":1,"k":"v"}',
			meta: { k: 'w', out: 'x' },
			changes: { fields: { added: ['k'], changed: [], removed: [] }, meta: { added: ['out'], changed: ['k'], removed: ['gone'] } },
		});
	});

	test('RUN_ERROR: a non-zero exit gives the stderr text, and the temp file is still removed', async () => {
		const calls: Call[] = [];
		const outcome = await runMappingTest(OK, 'mapping', 'root = "${X}"', '{}', {}, dir, {
			argsEnvironment: { ...ENV, resourceFilesSetting: [], envFileSetting: '' },
			run: fakeRun({ kind: 'exited', exitCode: 1, stdout: '', stderr: 'level=error msg="Config lint error"\n' }, calls),
		});
		assert.deepStrictEqual(outcome.result, { kind: 'error', message: 'level=error msg="Config lint error"' });
		assert.deepStrictEqual(fs.readdirSync(dir), []);
	});

	/** A fake runner answering `run` with `runOutcome` and `blobl` with `bloblOutcome`; records each subcommand. */
	function routedRun(runOutcome: ProcessOutcome, bloblOutcome: ProcessOutcome, seen: string[]) {
		return async (_invocation: readonly string[], args: readonly string[]) => {
			const sub = args.includes('blobl') ? 'blobl' : 'run';
			seen.push(sub);
			return sub === 'blobl' ? bloblOutcome : runOutcome;
		};
	}
	const LINT_STDERR = 'time="t" level=error msg="Config lint error" @service=redpanda-connect lint="/x/c.yaml(16,24) required: expected comma or closing bracket, got: = 3\\n"\n'
		+ 'time="t" level=error msg="shutting down due to linter errors, to prevent shutdown run Redpanda Connect with --chilled" @service=redpanda-connect\n';

	test('PARSE (4.8): a lint stop that blobl parses as an error is parseError, with the mapping and the located file positions', async () => {
		const seen: string[] = [];
		const blobl = 'failed to parse mapping: line 2 char 10: required: expected query\n  |\n2 | root.c = = 3\n  |          ^---\n';
		const located: [number, number][] = [];
		const outcome = await runMappingTest(OK, 'mapping', 'root.a = 1\nroot.c = = 3', '{}', {}, dir, {
			argsEnvironment: { ...ENV, resourceFilesSetting: [], envFileSetting: '' },
			locate: (line, char) => {
				located.push([line, char]);
				return { line: line + 10, char: char + 6 };
			},
			run: routedRun({ kind: 'exited', exitCode: 1, stdout: '', stderr: LINT_STDERR }, { kind: 'exited', exitCode: 1, stdout: '', stderr: blobl }, seen),
		});
		assert.deepStrictEqual(seen, ['run', 'blobl']);
		assert.deepStrictEqual(located, [[2, 10]]);
		assert.deepStrictEqual(outcome.result, {
			kind: 'parseError',
			message: 'required: expected query',
			excerpt: '  |\n2 | root.c = = 3\n  |          ^---',
			mappingLine: 2,
			mappingChar: 10,
			fileLine: 12,
			fileChar: 16,
		});
		assert.deepStrictEqual(fs.readdirSync(dir), []);
		// Without `locate`, the file positions are the mapping's.
		const plain = await runMappingTest(OK, 'mapping', 'root.a = 1\nroot.c = = 3', '{}', {}, dir, {
			argsEnvironment: { ...ENV, resourceFilesSetting: [], envFileSetting: '' },
			run: routedRun({ kind: 'exited', exitCode: 1, stdout: '', stderr: LINT_STDERR }, { kind: 'exited', exitCode: 1, stdout: '', stderr: blobl }, []),
		});
		assert.deepStrictEqual(plain.result.kind === 'parseError' && [plain.result.fileLine, plain.result.fileChar], [2, 10]);
	});

	test('ENV_LINT (4.8): a lint stop that blobl does not see as a parse error is error with the lint message verbatim', async () => {
		const seen: string[] = [];
		const lint = 'level=error msg="Config lint error" lint="(1,1) required environment variables were not set: [API_TOKEN]"\n';
		const outcome = await runMappingTest(OK, 'mapping', 'root = "${API_TOKEN}"', '{}', {}, dir, {
			argsEnvironment: { ...ENV, resourceFilesSetting: [], envFileSetting: '' },
			run: routedRun(
				{ kind: 'exited', exitCode: 1, stdout: '', stderr: lint },
				{ kind: 'exited', exitCode: 1, stdout: '', stderr: 'failed to replace env vars: required environment variables were not set: [API_TOKEN]\n' },
				seen,
			),
		});
		assert.deepStrictEqual(seen, ['run', 'blobl']);
		assert.deepStrictEqual(outcome.result, { kind: 'error', message: lint.trim() });
		// A mapping blobl parses fine: the lint message too.
		const parses = await runMappingTest(OK, 'mapping', 'root = 1', '{}', {}, dir, {
			argsEnvironment: { ...ENV, resourceFilesSetting: [], envFileSetting: '' },
			run: routedRun({ kind: 'exited', exitCode: 1, stdout: '', stderr: lint }, { kind: 'exited', exitCode: 0, stdout: '', stderr: '' }, []),
		});
		assert.deepStrictEqual(parses.result, { kind: 'error', message: lint.trim() });
		assert.deepStrictEqual(fs.readdirSync(dir), []);
	});

	test('FAILED (4.8): a failed run with a mapping line gets the located file line; without one, no lines and no blobl', async () => {
		const seen: string[] = [];
		const env = { argsEnvironment: { ...ENV, resourceFilesSetting: [], envFileSetting: '' }, locate: (line: number) => ({ line: line + 7, char: 9 }) };
		const failed = await runMappingTest(OK, 'mapping', 'root.x = this.nope + 1', '{}', {}, dir, {
			...env,
			run: routedRun({ kind: 'exited', exitCode: 0, stdout: '{"error":"failed assignment (line 2): boom"}\n', stderr: '' }, { kind: 'notFound' }, seen),
		});
		assert.deepStrictEqual(failed.result, { kind: 'failed', message: 'failed assignment (line 2): boom', mappingLine: 2, fileLine: 9 });
		const bare = await runMappingTest(OK, 'mapping', 'root = this', '{}', {}, dir, {
			...env,
			run: routedRun({ kind: 'exited', exitCode: 0, stdout: '{"error":"boom"}\n', stderr: '' }, { kind: 'notFound' }, seen),
		});
		assert.deepStrictEqual(bare.result, { kind: 'failed', message: 'boom' });
		assert.deepStrictEqual(seen, ['run', 'run']);
	});

	test('a timeout, a missing binary or a spawn failure is an error result', async () => {
		const env = { argsEnvironment: { ...ENV, resourceFilesSetting: [], envFileSetting: '' } };
		const cases: [ProcessOutcome, string][] = [
			[{ kind: 'timeout', timeoutMs: 10_000, stderr: '' }, 'No result after 10 s; stopped.'],
			[{ kind: 'notFound' }, 'The Redpanda Connect binary was not found.'],
			[{ kind: 'spawnError', message: 'EACCES' }, 'Could not start Redpanda Connect: EACCES'],
		];
		for (const [processOutcome, message] of cases) {
			const outcome = await runMappingTest(OK, 'mapping', 'root = this', '{}', {}, dir, { ...env, run: fakeRun(processOutcome, []) });
			assert.deepStrictEqual(outcome.result, { kind: 'error', message });
		}
		assert.deepStrictEqual(fs.readdirSync(dir), []);
	});

	test('NO_BINARY: no spawn, no file', async () => {
		const calls: Call[] = [];
		for (const state of [{ kind: 'missing' }, { kind: 'unresolved' }] as BinaryState[]) {
			const outcome = await runMappingTest(state, 'mapping', 'root = this', '{}', {}, dir, { run: fakeRun({ kind: 'notFound' }, calls) });
			assert.deepStrictEqual(outcome, { result: { kind: 'error', message: NO_BINARY_MESSAGE }, durationMs: outcome.durationMs, binary: null });
		}
		assert.strictEqual(calls.length, 0);
		assert.deepStrictEqual(fs.readdirSync(dir), []);
	});

	test('a builder failure (relative env file without a workspace) is an error result with no spawn', async () => {
		const calls: Call[] = [];
		const outcome = await runMappingTest(OK, 'mapping', 'root = this', '{}', {}, dir, {
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

suite('adapters/redpandaConnect parseMapping (4.5, AD-21)', () => {
	let dir: string;
	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-blobl-parse-'));
	});
	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	interface ParseCall { args: readonly string[]; timeoutMs: number; options: SpawnOptions; text: string }
	function fakeRun(outcome: ProcessOutcome, calls: ParseCall[]) {
		return async (_invocation: readonly string[], args: readonly string[], timeoutMs: number, options: SpawnOptions) => {
			calls.push({ args, timeoutMs, options, text: fs.readFileSync(args[args.length - 1], 'utf8') });
			return outcome;
		};
	}

	test('writes the decoded Bloblang to a temp file, runs blobl --file with the env file and a 5 s timeout, removes the file', async () => {
		const calls: ParseCall[] = [];
		const storage = path.join(dir, 'storage');
		const stderr = 'failed to parse mapping: line 1 char 10: expected query\n  |\n1 | root.a = \n  |          ^---\n';
		const outcome = await parseMapping(OK, 'root.a = 😀\n', storage, {
			argsEnvironment: ENV,
			run: fakeRun({ kind: 'exited', exitCode: 1, stdout: '', stderr }, calls),
		});
		assert.deepStrictEqual(outcome, { kind: 'parseError', message: 'expected query', line: 1, char: 10, excerpt: '  |\n1 | root.a = \n  |          ^---' });
		assert.strictEqual(calls.length, 1);
		const file = calls[0].args[calls[0].args.length - 1];
		assert.deepStrictEqual(calls[0].args, ['connect', 'blobl', '--env-file', path.join(WS, '.env'), '--file', file]);
		assert.ok(path.basename(file).startsWith('bloblang-parse-') && path.dirname(file) === storage);
		assert.strictEqual(calls[0].text, 'root.a = 😀\n');
		assert.strictEqual(calls[0].timeoutMs, MAPPING_PARSE_TIMEOUT_MS);
		assert.strictEqual(MAPPING_PARSE_TIMEOUT_MS, 5_000);
		assert.strictEqual(calls[0].options.env?.NO_COLOR, '1');
		assert.deepStrictEqual(fs.readdirSync(storage), []);
	});

	test('exit 0 parses; timeout, not found and spawn errors are other; the file is removed on every path', async () => {
		const cases: [ProcessOutcome, unknown][] = [
			[{ kind: 'exited', exitCode: 0, stdout: '', stderr: '' }, { kind: 'ok' }],
			[{ kind: 'timeout', timeoutMs: 5_000, stderr: '' }, { kind: 'other', message: 'blobl gave no result after 5 s; stopped.' }],
			[{ kind: 'notFound' }, { kind: 'other', message: 'The Redpanda Connect binary was not found.' }],
			[{ kind: 'spawnError', message: 'EACCES' }, { kind: 'other', message: 'Could not start Redpanda Connect: EACCES' }],
		];
		for (const [processOutcome, expected] of cases) {
			const calls: ParseCall[] = [];
			assert.deepStrictEqual(await parseMapping(OK, 'root = this', dir, { argsEnvironment: ENV, run: fakeRun(processOutcome, calls) }), expected);
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(fs.readdirSync(dir), []);
		}
		const thrown = await parseMapping(OK, 'root = this', dir, { argsEnvironment: ENV, run: async () => { throw new Error('boom'); } });
		assert.deepStrictEqual(thrown, { kind: 'other', message: 'Could not parse the mapping: boom' });
		assert.deepStrictEqual(fs.readdirSync(dir), []);
	});

	test('NO_BINARY and a builder failure: no spawn, no file', async () => {
		const calls: ParseCall[] = [];
		assert.deepStrictEqual(await parseMapping({ kind: 'missing' }, 'root = this', dir, { run: fakeRun({ kind: 'notFound' }, calls) }),
			{ kind: 'other', message: NO_BINARY_MESSAGE });
		const failed = await parseMapping(OK, 'root = this', dir, {
			argsEnvironment: { ...ENV, workspaceFolder: undefined }, run: fakeRun({ kind: 'notFound' }, calls),
		});
		assert.deepStrictEqual(failed, { kind: 'other', message: 'redpandaConnect.envFile ".env" is a relative path, but no workspace folder is open.' });
		assert.strictEqual(calls.length, 0);
		assert.deepStrictEqual(fs.readdirSync(dir), []);
	});
});
