import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CommandSettings } from '../../../adapters/redpandaConnect/commandLine';
import { checkLicense, LICENSE_CHECK_CONFIG } from '../../../adapters/redpandaConnect/license';
import type { ProcessOutcome } from '../../../adapters/redpandaConnect/process';

// Ticket 38: the license check's command line, temporary config and reading of the outcome.
suite('adapters/redpandaConnect license', () => {
	const state = { kind: 'ok', path: '/bin/fake', version: '4.112.0', invocation: ['/bin/fake'] } as const;
	const settings: CommandSettings = {
		files: () => ({ kind: 'ok', resourceFiles: ['/r.yaml'], envFile: '/w/.env' }),
		envFile: () => ({ kind: 'ok', path: '/w/.env' }),
		processEnv: () => ({ REDPANDA_LICENSE: 'lic-value-38' }),
	};
	let dir: string;
	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-license-'));
	});
	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	function fake(outcome: ProcessOutcome | Error) {
		const calls: { args: readonly string[]; env: NodeJS.ProcessEnv | undefined; cwd: string | undefined; config: string }[] = [];
		const run = async (invocation: readonly string[], args: readonly string[], _t: number, options: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
			const file = args[args.length - 1];
			calls.push({ args: [...invocation, ...args], env: options.env, cwd: options.cwd, config: fs.readFileSync(file, 'utf8') });
			if (outcome instanceof Error) {
				throw outcome;
			}
			return outcome;
		};
		return { calls, run };
	}
	const exited = (stderr: string, exitCode = 0): ProcessOutcome => ({ kind: 'exited', exitCode, stdout: '', stderr });

	test('NO_FLAG: the commands\' run command line (resources, env file, the environment), no --redpanda-license; the config is removed', async () => {
		const f = fake(exited('level=info msg="Successfully loaded Redpanda license" expires_at="2027-03-09T15:18:26-05:00" license_org=o license_type=enterprise'));
		const result = await checkLicense({ state, settings }, dir, { run: f.run, cwd: '/w' });
		assert.deepStrictEqual(result, { kind: 'loaded', licenseType: 'enterprise', expiresAt: '2027-03-09T15:18:26-05:00' });
		const [call] = f.calls;
		assert.deepStrictEqual(call.args.slice(0, 2), ['/bin/fake', 'run']);
		assert.ok(call.args.join(' ').includes('--resources /r.yaml'), JSON.stringify(call.args));
		assert.ok(call.args.join(' ').includes('--env-file /w/.env'), JSON.stringify(call.args));
		assert.ok(!call.args.some((a) => a.includes('license') && a.startsWith('--')), JSON.stringify(call.args));
		assert.ok(!call.args.join(' ').includes('lic-value-38'));
		assert.strictEqual(call.env?.REDPANDA_LICENSE, 'lic-value-38');
		assert.strictEqual(call.env?.NO_COLOR, '1');
		assert.strictEqual(call.cwd, '/w');
		assert.strictEqual(call.config, LICENSE_CHECK_CONFIG);
		assert.deepStrictEqual(fs.readdirSync(dir), [], 'the temporary config is removed');
	});

	test('FAILED and NO_LINE; a failing run without a license line is an error with its message', async () => {
		assert.deepStrictEqual(await checkLicense({ state, settings }, dir, { run: fake(exited('level=error msg="Failed to read Redpanda License" error="bad"')).run }),
			{ kind: 'failed', reason: 'bad' });
		assert.deepStrictEqual(await checkLicense({ state, settings }, dir, { run: fake(exited('level=info msg="Running"')).run }), { kind: 'none' });
		assert.deepStrictEqual(await checkLicense({ state, settings }, dir, { run: fake(exited('level=error msg="Config lint error" lint="r.yaml(1,1) bad"', 1)).run }),
			{ kind: 'error', reason: 'The check run failed (exit 1): Config lint error: r.yaml(1,1) bad' });
		assert.deepStrictEqual(fs.readdirSync(dir), []);
	});

	test('CHECK_FAILS: no binary, not found, a timeout, a settings failure, a throw; the config is removed on every path', async () => {
		assert.strictEqual((await checkLicense({ state: { kind: 'missing' }, settings }, dir)).kind, 'error');
		assert.deepStrictEqual(await checkLicense({ state, settings }, dir, { run: fake({ kind: 'notFound' }).run }),
			{ kind: 'error', reason: 'The Redpanda Connect binary was not found.' });
		assert.deepStrictEqual(await checkLicense({ state, settings }, dir, { run: fake({ kind: 'timeout', timeoutMs: 15_000, stderr: '' }).run }),
			{ kind: 'error', reason: 'The check run gave no result after 15 s; stopped.' });
		const relative: CommandSettings = { ...settings, files: () => ({ kind: 'unusableSetting', setting: 'redpandaConnect.envFile', value: '.env', reason: 'relativePathWithoutWorkspace' }) };
		assert.strictEqual((await checkLicense({ state, settings: relative }, dir, { run: fake(exited('')).run })).kind, 'error');
		assert.match(JSON.stringify(await checkLicense({ state, settings }, dir, { run: fake(new Error('boom')).run })), /boom/);
		assert.deepStrictEqual(fs.readdirSync(dir), []);
	});
});
