import * as assert from 'assert';
import { buildLintArgs, buildRunArgs, escapeGlob, FORBIDDEN_ARGS } from '../../core/args';

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
		assert.deepStrictEqual(buildLintArgs({ invocation: [], targets: ['/a'], resourceFiles: [] }), { kind: 'emptyInvocation' });
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

suite('core/args lint target escaping (2.4 review)', () => {
	test('lint targets are glob-escaped on POSIX; run targets and resources are not', () => {
		const input = { invocation: ['/b'], targets: ['/w/[client]/a*?.yaml'], resourceFiles: ['/w/res/*.yaml'] };
		const lint = buildLintArgs(input);
		assert.ok(lint.kind === 'ok');
		assert.deepStrictEqual(lint.argv.slice(-3), ['--resources', '/w/res/*.yaml', '/w/\\[client]/a\\*\\?.yaml']);
		const run = buildRunArgs(input);
		assert.ok(run.kind === 'ok');
		assert.strictEqual(run.argv[run.argv.length - 1], '/w/[client]/a*?.yaml');
	});

	test('a backslash in a POSIX file name is escaped too; win32 targets are left alone', () => {
		assert.strictEqual(escapeGlob('/w/a\\b.yaml'), '/w/a\\\\b.yaml');
		const win = buildLintArgs({ invocation: ['C:\\b.exe'], targets: ['C:\\w\\[x].yaml'], resourceFiles: [], platform: 'win32' });
		assert.ok(win.kind === 'ok');
		assert.strictEqual(win.argv[win.argv.length - 1], 'C:\\w\\[x].yaml');
	});
});
