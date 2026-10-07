import * as assert from 'assert';
import * as path from 'path';
import { ArgsEnvironment } from '../../../adapters/redpandaConnect/args';
import { BinaryState } from '../../../adapters/redpandaConnect/binary';
import { lintFile } from '../../../adapters/redpandaConnect/lint';
import { ProcessOutcome, SpawnOptions } from '../../../adapters/redpandaConnect/process';

const WS = path.resolve('/ws');
const FILE = path.join(WS, 'a.yaml');
const BIN = path.resolve('/bin/redpanda-connect');
const OK: BinaryState = { kind: 'ok', path: BIN, version: '4.112.0', invocation: [BIN] };
const ENV: ArgsEnvironment = {
	resourceFilesSetting: ['r.yaml'], envFileSetting: '', homeDir: '/home/u', workspaceFolder: WS, processEnv: { FOO: 'bar' },
};

interface Call { invocation: readonly string[]; args: readonly string[]; timeoutMs: number; options: SpawnOptions }

function fakeRun(outcome: ProcessOutcome, calls: Call[] = []) {
	return async (invocation: readonly string[], args: readonly string[], timeoutMs: number, options: SpawnOptions) => {
		calls.push({ invocation, args, timeoutMs, options });
		return outcome;
	};
}

const exited = (exitCode: number | null, stderr = ''): ProcessOutcome => ({ kind: 'exited', exitCode, stdout: '', stderr });

suite('adapters/redpandaConnect lintFile', () => {
	test('runs the builder argv with the builder env and a 30 s timeout', async () => {
		const calls: Call[] = [];
		const result = await lintFile(OK, FILE, { argsEnvironment: ENV, run: fakeRun(exited(0), calls) });
		assert.deepStrictEqual(result, { kind: 'findings', findings: [], logLines: [] });
		assert.deepStrictEqual(calls[0].invocation, [BIN]);
		assert.deepStrictEqual(calls[0].args, ['lint', '--deprecated', '--skip-env-var-check', '--resources', path.join(WS, 'r.yaml'), FILE]);
		assert.strictEqual(calls[0].timeoutMs, 30_000);
		assert.deepStrictEqual(calls[0].options, { env: { FOO: 'bar', NO_COLOR: '1' } });
	});

	test('NO_BINARY: skipped without running anything', async () => {
		const calls: Call[] = [];
		for (const state of [{ kind: 'unresolved' }, { kind: 'missing', reason: 'x' }] as BinaryState[]) {
			assert.deepStrictEqual(await lintFile(state, FILE, { argsEnvironment: ENV, run: fakeRun(exited(0), calls) }), { kind: 'skipped' });
		}
		assert.strictEqual(calls.length, 0);
	});

	test('BUILDER_FAIL: one log line from describeArgsFailure', async () => {
		const result = await lintFile(OK, FILE, { argsEnvironment: { ...ENV, workspaceFolder: undefined }, run: fakeRun(exited(0)) });
		assert.deepStrictEqual(result, {
			kind: 'failed',
			logLine: 'Lint a.yaml: redpandaConnect.resourceFiles "r.yaml" is a relative path, but no workspace folder is open.',
		});
	});

	test('findings for the file are kept; other paths and unparsed lines become log lines', async () => {
		const stderr = `${FILE}(6,1) field nope not recognised\n${path.join(WS, 'r.yaml')}(2,1) field x not recognised\nboom\n`;
		const result = await lintFile(OK, FILE, { argsEnvironment: ENV, run: fakeRun(exited(1, stderr)) });
		assert.strictEqual(result.kind, 'findings');
		if (result.kind !== 'findings') { return; }
		assert.deepStrictEqual(result.findings.map((f) => [f.line, f.message]), [[6, 'field nope not recognised']]);
		assert.deepStrictEqual(result.logLines, [
			'Lint a.yaml: unrecognised output: boom',
			`Lint a.yaml: finding for another file: ${path.join(WS, 'r.yaml')}(2) field x not recognised`,
		]);
	});

	test('CRASH: other exit codes, signals, timeouts and spawn failures are one log line', async () => {
		const cases: [ProcessOutcome, string][] = [
			[exited(2, '\npanic: nil map\n'), 'Lint a.yaml: Redpanda Connect exited with code 2: panic: nil map'],
			[exited(null), 'Lint a.yaml: Redpanda Connect was stopped by a signal.'],
			[{ kind: 'timeout', timeoutMs: 30_000, stderr: '' }, 'Lint a.yaml: no result after 30 s; stopped.'],
			[{ kind: 'notFound' }, 'Lint a.yaml: the Redpanda Connect binary was not found.'],
			[{ kind: 'spawnError', message: 'EACCES' }, 'Lint a.yaml: could not start Redpanda Connect: EACCES'],
			[exited(1, ''), 'Lint a.yaml: Redpanda Connect exited with code 1 but reported no findings.'],
		];
		for (const [outcome, logLine] of cases) {
			assert.deepStrictEqual(await lintFile(OK, FILE, { argsEnvironment: ENV, run: fakeRun(outcome) }), { kind: 'failed', logLine });
		}
	});

	test('an unnormalised printed path still matches the file', async () => {
		const result = await lintFile(OK, FILE, { argsEnvironment: ENV, run: fakeRun(exited(1, `${WS}/./a.yaml(3,1) x\n`)) });
		assert.strictEqual(result.kind === 'findings' && result.findings.length, 1);
	});

	test('log lines are capped at 20 plus one summary line', async () => {
		const stderr = Array.from({ length: 30 }, (_, i) => `noise ${i}`).join('\n') + `\n${FILE}(2,1) x\n`;
		const result = await lintFile(OK, FILE, { argsEnvironment: ENV, run: fakeRun(exited(1, stderr)) });
		assert.ok(result.kind === 'findings');
		assert.strictEqual(result.logLines.length, 21);
		assert.strictEqual(result.logLines[20], 'Lint a.yaml: … 10 more lines not shown.');
		assert.strictEqual(result.findings.length, 1);
	});

	test('a target with glob characters is escaped in the argv, and its findings still match', async () => {
		const file = path.join(WS, '[client]', 'a.yaml');
		const calls: Call[] = [];
		const result = await lintFile(OK, file, { argsEnvironment: { ...ENV, resourceFilesSetting: [] },
			run: fakeRun(exited(1, `${file}(4,1) field nope not recognised\n`), calls) });
		if (process.platform !== 'win32') {
			assert.strictEqual(calls[0].args[calls[0].args.length - 1], path.join(WS, '\\[client]', 'a.yaml'));
		}
		assert.ok(result.kind === 'findings');
		assert.deepStrictEqual(result.findings.map((f) => f.line), [4]);
	});
});
