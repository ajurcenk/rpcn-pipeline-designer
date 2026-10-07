import * as assert from 'assert';
import * as path from 'path';
import {
	ArgsEnvironment, ArgsResult, buildLintCommand, buildRunCommand, describeArgsFailure,
} from '../../../adapters/redpandaConnect/args';
import { BinaryState } from '../../../adapters/redpandaConnect/binary';
import { FORBIDDEN_ARGS } from '../../../core/args';

// Rows of the plan's I/O & edge-case matrix. Pure: no binaries are spawned and no files need to exist.
const HOME = path.resolve('/home/tester');
const WS = path.resolve('/work/space');
const BIN = path.resolve('/opt/rc/redpanda-connect');
const RPK = path.resolve('/usr/bin/rpk');
const A = path.join(WS, 'a.yaml');
const B = path.join(WS, 'b.yaml');

const standalone: BinaryState = { kind: 'ok', path: BIN, version: '4.112.0', invocation: [BIN] };
const rpk: BinaryState = { kind: 'ok', path: RPK, version: '4.112.0', invocation: [RPK, 'connect'] };

function environment(overrides: Partial<ArgsEnvironment> = {}): ArgsEnvironment {
	return {
		resourceFilesSetting: [],
		envFileSetting: '',
		homeDir: HOME,
		workspaceFolder: WS,
		processEnv: { PATH: '/usr/bin', FOO: 'bar' },
		...overrides,
	};
}

function ok(result: ArgsResult) {
	assert.strictEqual(result.kind, 'ok', JSON.stringify(result));
	if (result.kind !== 'ok') {
		throw new Error('unreachable');
	}
	return result;
}

suite('adapters/redpandaConnect args', () => {
	test('LINT_PLAIN', () => {
		const result = ok(buildLintCommand(standalone, { targets: [A] }, environment()));
		assert.strictEqual(result.command, BIN);
		assert.deepStrictEqual(result.args, ['lint', '--deprecated', '--skip-env-var-check', A]);
		assert.deepStrictEqual(result.env, { PATH: '/usr/bin', FOO: 'bar', NO_COLOR: '1' });
	});

	test('NO_COLOR overrides an inherited value', () => {
		const result = ok(buildLintCommand(standalone, { targets: [A] }, environment({ processEnv: { NO_COLOR: '0' } })));
		assert.deepStrictEqual(result.env, { NO_COLOR: '1' });
	});

	test('LINT_RPK', () => {
		const result = ok(buildLintCommand(rpk, { targets: [A] }, environment()));
		assert.strictEqual(result.command, RPK);
		assert.deepStrictEqual(result.args, ['connect', 'lint', '--deprecated', '--skip-env-var-check', A]);
	});

	test('LINT_MULTI: targets in order after all flags', () => {
		const result = ok(buildLintCommand(standalone, { targets: [B, A] },
			environment({ resourceFilesSetting: ['r.yaml'], envFileSetting: '.env' })));
		assert.deepStrictEqual(result.args, ['lint', '--deprecated', '--skip-env-var-check',
			'--resources', path.join(WS, 'r.yaml'), '--env-file', path.join(WS, '.env'), B, A]);
	});

	test('RUN_PLAIN', () => {
		const result = ok(buildRunCommand(standalone, { targets: [A] }, environment()));
		assert.strictEqual(result.command, BIN);
		assert.deepStrictEqual(result.args, ['run', '--set', 'http.enabled=false', A]);
		assert.strictEqual(result.env.NO_COLOR, '1');
	});

	test('RUN_PLAIN under rpk', () => {
		const result = ok(buildRunCommand(rpk, { targets: [A] }, environment()));
		assert.deepStrictEqual([result.command, ...result.args], [RPK, 'connect', 'run', '--set', 'http.enabled=false', A]);
	});

	test('RESOURCES: setting entries in order, deduped, identical for lint and run', () => {
		const env = environment({ resourceFilesSetting: ['r1.yaml', 'r2.yaml', `${WS}/r1.yaml`] });
		const request = { targets: [A] };
		const expected = ['--resources', path.join(WS, 'r1.yaml'), '--resources', path.join(WS, 'r2.yaml')];
		const lint = ok(buildLintCommand(standalone, request, env));
		const run = ok(buildRunCommand(standalone, request, env));
		assert.deepStrictEqual(lint.args, ['lint', '--deprecated', '--skip-env-var-check', ...expected, A]);
		assert.deepStrictEqual(run.args, ['run', '--set', 'http.enabled=false', ...expected, A]);
	});

	test('RESOURCES: an absolute setting entry is kept; blank and non-string entries are ignored', () => {
		const abs = path.resolve('/etc/rc/r.yaml');
		const result = ok(buildLintCommand(standalone, { targets: [A] },
			environment({ resourceFilesSetting: [abs, '  ', 42, ''] })));
		assert.deepStrictEqual(result.args, ['lint', '--deprecated', '--skip-env-var-check', '--resources', abs, A]);
	});

	test('RESOURCES: a malformed setting value is ignored, not thrown', () => {
		const result = ok(buildLintCommand(standalone, { targets: [A] },
			environment({ resourceFilesSetting: 'r.yaml', envFileSetting: 7 })));
		assert.deepStrictEqual(result.args, ['lint', '--deprecated', '--skip-env-var-check', A]);
	});

	test('TILDE_PATHS', () => {
		const env = environment({ envFileSetting: '~/rc.env', resourceFilesSetting: ['~/r.yaml'], workspaceFolder: undefined });
		const lint = ok(buildLintCommand(standalone, { targets: [A] }, env));
		assert.deepStrictEqual(lint.args, ['lint', '--deprecated', '--skip-env-var-check',
			'--resources', path.join(HOME, 'r.yaml'), '--env-file', path.join(HOME, 'rc.env'), A]);
		const run = ok(buildRunCommand(standalone, { targets: [A] }, env));
		assert.deepStrictEqual(run.args, ['run', '--set', 'http.enabled=false',
			'--resources', path.join(HOME, 'r.yaml'), '--env-file', path.join(HOME, 'rc.env'), A]);
	});

	test('RESOURCES: an unnormalized absolute setting entry dedupes with a relative one', () => {
		const result = ok(buildLintCommand(standalone, { targets: [A] },
			environment({ resourceFilesSetting: ['r1.yaml', `${WS}/./r1.yaml`] })));
		assert.deepStrictEqual(result.args, ['lint', '--deprecated', '--skip-env-var-check', '--resources', path.join(WS, 'r1.yaml'), A]);
	});

	test('an ok state with an empty invocation is reported as emptyInvocation', () => {
		const broken: BinaryState = { kind: 'ok', path: BIN, version: '4.112.0', invocation: [] };
		for (const build of [buildLintCommand, buildRunCommand]) {
			const result = build(broken, { targets: [A] }, environment());
			assert.deepStrictEqual(result, { kind: 'emptyInvocation' });
			assert.strictEqual(describeArgsFailure({ kind: 'emptyInvocation' }), 'Internal error: the Redpanda Connect binary state has an empty invocation.');
		}
	});

	test('ENV_FILE: identical --env-file for lint and run', () => {
		const env = environment({ envFileSetting: '.env' });
		const lint = ok(buildLintCommand(standalone, { targets: [A] }, env));
		const run = ok(buildRunCommand(standalone, { targets: [A] }, env));
		assert.deepStrictEqual(lint.args, ['lint', '--deprecated', '--skip-env-var-check', '--env-file', path.join(WS, '.env'), A]);
		assert.deepStrictEqual(run.args, ['run', '--set', 'http.enabled=false', '--env-file', path.join(WS, '.env'), A]);
	});

	test('ENV_FILE: a nested relative path resolves against the workspace', () => {
		const result = ok(buildRunCommand(standalone, { targets: [A] }, environment({ envFileSetting: 'conf/dev.env' })));
		assert.deepStrictEqual(result.args, ['run', '--set', 'http.enabled=false', '--env-file', path.join(WS, 'conf', 'dev.env'), A]);
	});

	test('NO_TARGET: lint with zero files', () => {
		const result = buildLintCommand(standalone, { targets: [] }, environment());
		assert.deepStrictEqual(result, { kind: 'targetCount', expected: 'atLeastOne', actual: 0 });
		assert.strictEqual(describeArgsFailure(result), 'Lint needs at least one file.');
	});

	test('NO_TARGET: run with zero or two files', () => {
		assert.deepStrictEqual(buildRunCommand(standalone, { targets: [] }, environment()),
			{ kind: 'targetCount', expected: 'exactlyOne', actual: 0 });
		const two = buildRunCommand(standalone, { targets: [A, B] }, environment());
		assert.deepStrictEqual(two, { kind: 'targetCount', expected: 'exactlyOne', actual: 2 });
		assert.strictEqual(describeArgsFailure(two), 'Run needs exactly one file, got 2.');
	});

	test('NOT_OK: every non-ok state is reported, not built', () => {
		const states: BinaryState[] = [
			{ kind: 'unresolved' },
			{ kind: 'missing' },
			{ kind: 'invalid', path: BIN, reason: 'belowMinimum', version: '4.63.0' },
		];
		for (const state of states) {
			for (const build of [buildLintCommand, buildRunCommand]) {
				const result = build(state, { targets: [A] }, environment());
				assert.deepStrictEqual(result, { kind: 'binaryUnavailable', state: state.kind });
				assert.strictEqual(describeArgsFailure(result), `Redpanda Connect binary is unavailable (${state.kind}).`);
			}
		}
	});

	test('BAD_SETTING_PATH: relative envFile with no workspace folder', () => {
		for (const value of ['.env', 'conf/dev.env']) {
			for (const build of [buildLintCommand, buildRunCommand]) {
				const result = build(standalone, { targets: [A] }, environment({ envFileSetting: value, workspaceFolder: undefined }));
				assert.deepStrictEqual(result, {
					kind: 'unusableSetting', setting: 'redpandaConnect.envFile', value, reason: 'relativePathWithoutWorkspace',
				});
				assert.strictEqual(describeArgsFailure(result),
					`redpandaConnect.envFile "${value}" is a relative path, but no workspace folder is open.`);
			}
		}
	});

	test('BAD_SETTING_PATH: relative resourceFiles entry with no workspace folder', () => {
		const result = buildLintCommand(standalone, { targets: [A] },
			environment({ resourceFilesSetting: ['~/ok.yaml', 'r.yaml'], workspaceFolder: undefined }));
		assert.deepStrictEqual(result, {
			kind: 'unusableSetting', setting: 'redpandaConnect.resourceFiles', value: 'r.yaml', reason: 'relativePathWithoutWorkspace',
		});
	});

	test('relative target paths are reported, not passed', () => {
		assert.deepStrictEqual(buildLintCommand(standalone, { targets: ['a.yaml'] }, environment()),
			{ kind: 'relativePath', role: 'target', path: 'a.yaml' });
		assert.deepStrictEqual(buildRunCommand(standalone, { targets: ['a.yaml'] }, environment()),
			{ kind: 'relativePath', role: 'target', path: 'a.yaml' });
	});

	test('acceptance: lint and run for the same file carry identical --resources and --env-file', () => {
		const env = environment({ resourceFilesSetting: ['r1.yaml', '~/shared.yaml', 'r3.yaml'], envFileSetting: '~/rc.env' });
		const request = { targets: [A] };
		const fileFlags = (args: readonly string[]) => args.filter((_, i) =>
			['--resources', '--env-file'].includes(args[i]) || ['--resources', '--env-file'].includes(args[i - 1]));
		const lint = ok(buildLintCommand(standalone, request, env));
		const run = ok(buildRunCommand(standalone, request, env));
		assert.deepStrictEqual(fileFlags(lint.args), fileFlags(run.args));
		assert.strictEqual(fileFlags(lint.args).length, 8);
	});

	test('acceptance: no built argv contains --verbose, -v, - or --chilled', () => {
		const env = environment({ resourceFilesSetting: ['r1.yaml'], envFileSetting: '.env' });
		for (const state of [standalone, rpk]) {
			for (const build of [buildLintCommand, buildRunCommand]) {
				const result = ok(build(state, { targets: [A] }, env));
				for (const forbidden of FORBIDDEN_ARGS) {
					assert.ok(![result.command, ...result.args].includes(forbidden), forbidden);
				}
			}
		}
	});
});
