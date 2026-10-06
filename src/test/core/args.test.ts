import * as assert from 'assert';
import { buildLintArgs, buildRunArgs, FORBIDDEN_ARGS } from '../../core/args';

const BIN = '/opt/rc/redpanda-connect';

suite('core/args', () => {
	test('lint: invocation, subcommand, flags, resources, env file, targets', () => {
		assert.deepStrictEqual(buildLintArgs({
			invocation: [BIN], targets: ['/w/a.yaml', '/w/b.yaml'], resourceFiles: ['/w/r1.yaml'], envFile: '/w/.env',
		}), {
			kind: 'ok',
			argv: [BIN, 'lint', '--deprecated', '--skip-env-var-check', '--resources', '/w/r1.yaml',
				'--env-file', '/w/.env', '/w/a.yaml', '/w/b.yaml'],
		});
	});

	test('run: --set http.enabled=false before file flags and the single target', () => {
		assert.deepStrictEqual(buildRunArgs({
			invocation: ['/usr/bin/rpk', 'connect'], targets: ['/w/a.yaml'], resourceFiles: ['/w/r1.yaml'], envFile: '/w/.env',
		}), {
			kind: 'ok',
			argv: ['/usr/bin/rpk', 'connect', 'run', '--set', 'http.enabled=false', '--resources', '/w/r1.yaml',
				'--env-file', '/w/.env', '/w/a.yaml'],
		});
	});

	test('resource files are deduplicated, first occurrence wins', () => {
		const result = buildLintArgs({ invocation: [BIN], targets: ['/w/a.yaml'], resourceFiles: ['/w/r1.yaml', '/w/r2.yaml', '/w/r1.yaml'] });
		assert.deepStrictEqual(result, {
			kind: 'ok',
			argv: [BIN, 'lint', '--deprecated', '--skip-env-var-check', '--resources', '/w/r1.yaml', '--resources', '/w/r2.yaml', '/w/a.yaml'],
		});
	});

	test('target counts', () => {
		assert.deepStrictEqual(buildLintArgs({ invocation: [BIN], targets: [], resourceFiles: [] }),
			{ kind: 'targetCount', expected: 'atLeastOne', actual: 0 });
		assert.deepStrictEqual(buildRunArgs({ invocation: [BIN], targets: [], resourceFiles: [] }),
			{ kind: 'targetCount', expected: 'exactlyOne', actual: 0 });
		assert.deepStrictEqual(buildRunArgs({ invocation: [BIN], targets: ['/a', '/b'], resourceFiles: [] }),
			{ kind: 'targetCount', expected: 'exactlyOne', actual: 2 });
	});

	test('an empty invocation is not built', () => {
		assert.deepStrictEqual(buildLintArgs({ invocation: [], targets: ['/a'], resourceFiles: [] }), { kind: 'noInvocation' });
	});

	test('no forbidden argument appears', () => {
		for (const build of [buildLintArgs, buildRunArgs]) {
			const result = build({ invocation: [BIN], targets: ['/w/a.yaml'], resourceFiles: ['/w/r.yaml'], envFile: '/w/.env' });
			assert.strictEqual(result.kind, 'ok');
			if (result.kind === 'ok') {
				for (const forbidden of FORBIDDEN_ARGS) {
					assert.ok(!result.argv.includes(forbidden), forbidden);
				}
			}
		}
	});
});
