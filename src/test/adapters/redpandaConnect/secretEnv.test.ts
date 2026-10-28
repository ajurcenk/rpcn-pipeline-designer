import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	type ArgsEnvironment, type ArgsResult, buildLintCommand, buildRunCommand, commandSettings,
} from '../../../adapters/redpandaConnect/args';
import { BinaryState } from '../../../adapters/redpandaConnect/binary';
import { buildBloblCommandLine } from '../../../adapters/redpandaConnect/commandLine';
import { EnvSettingFiles } from '../../../adapters/redpandaConnect/envSetting';
import {
	clashLine, declaredSecretNames, envFileNames, isSecretKey, maskSecrets, noValueLine, parseSecretKey, SECRET_MASK, secretKey,
	secretNameProblem, SecretValues, STILL_LOADING_LINE, WINDOW_SCOPE,
} from '../../../adapters/redpandaConnect/secretEnv';

const FOLDER = 'file:///work/b';
const LABEL = 'folder "b"';

// Ticket 30: secret variables, their names, keys, in-memory values and log lines.
suite('adapters/redpandaConnect secretEnv', () => {
	test('names: ticket 29\'s rule; non-strings and bad names are left out; duplicates once', () => {
		assert.strictEqual(secretNameProblem('API_TOKEN'), undefined);
		assert.strictEqual(secretNameProblem('_x1'), undefined);
		for (const bad of ['', '1X', 'A-B', 'A B', 'é']) {
			assert.ok(secretNameProblem(bad), bad);
		}
		assert.deepStrictEqual(declaredSecretNames(['A', '1X', 5, 'B', 'A']), { names: ['A', 'B'], invalid: ['1X', '5'] });
		for (const raw of [undefined, null, 'A', { A: 1 }]) {
			assert.deepStrictEqual(declaredSecretNames(raw), { names: [], invalid: [] }, JSON.stringify(raw));
		}
	});

	test('keys: per folder URI or the window; ours are told apart and parsed back', () => {
		assert.strictEqual(secretKey(FOLDER, 'A'), 'redpandaConnect.secret:file:///work/b:A');
		assert.strictEqual(secretKey(WINDOW_SCOPE, 'A'), 'redpandaConnect.secret:window:A');
		assert.ok(isSecretKey(secretKey(FOLDER, 'A')));
		assert.ok(!isSecretKey('other.key'));
		assert.deepStrictEqual(parseSecretKey(secretKey(FOLDER, 'A')), { scope: FOLDER, name: 'A' });
		assert.strictEqual(parseSecretKey('other'), undefined);
	});

	test('env file names: only NAME=… lines, as the binary reads them; export, spaces, NAME: v and comments are not', () => {
		// Ticket 31: export, NAME: v and a bare name make the binary reject the whole file, so each is checked on its own.
		assert.deepStrictEqual([...envFileNames('A=1\n# G=6\nE_1="x"\r\n  C=3\nD=4\n')].sort(), ['A', 'E_1']);
		for (const rejected of ['A=1\nexport B=2\n', 'A=1\nF: 5\n', 'A=1\nH\n', 'A=1\nnot a line\n']) {
			assert.deepStrictEqual([...envFileNames(rejected)], [], rejected);
		}
	});

	test('ticket 31: env file names: spaces around = are applied, as the binary applies them', () => {
		assert.deepStrictEqual([...envFileNames('API_TOKEN = x\nB =2\nC= 3\n')].sort(), ['API_TOKEN', 'B', 'C']);
	});

	test('masking: values of 4+ characters become •••••, longer ones first; shorter ones are kept', () => {
		assert.strictEqual(SECRET_MASK, '•••••');
		assert.strictEqual(maskSecrets('a tok-30 b tok-30-long c abc', ['tok-30', 'tok-30-long', 'abc']), `a ${SECRET_MASK} b ${SECRET_MASK} c abc`);
		const values = new SecretValues();
		values.replace(new Map([[secretKey(FOLDER, 'A'), 'in-folder'], [secretKey(WINDOW_SCOPE, 'A'), 'in-window']]));
		assert.strictEqual(values.mask('in-folder in-window', FOLDER), `${SECRET_MASK} in-window`);
		assert.strictEqual(values.mask('in-folder in-window'), `${SECRET_MASK} ${SECRET_MASK}`);
	});

	test('EVERY_COMMAND / NO_VALUE / CLASH: values for the scope; a name without a value and a clash are each logged once, by name', () => {
		const lines: string[] = [];
		const values = new SecretValues((l) => lines.push(l));
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-secret-env-'));
		try {
			const envFile = path.join(dir, '.env');
			fs.writeFileSync(envFile, 'FILE_TOO=from-file\n');
			values.replace(new Map([
				[secretKey(FOLDER, 'TOKEN'), 'tok-30-a'],
				[secretKey(FOLDER, 'FILE_TOO'), 'tok-30-b'],
				[secretKey(FOLDER, 'ENV_TOO'), 'tok-30-c'],
				[secretKey(WINDOW_SCOPE, 'TOKEN'), 'tok-30-window'],
			]));
			const request = {
				scope: FOLDER, scopeLabel: LABEL, declared: ['TOKEN', 'MISSING', 'FILE_TOO', 'ENV_TOO'],
				envSettingNames: new Set(['ENV_TOO']), envFile,
			};
			// A clashing secret is still passed: the binary lets the env file / generated file win.
			const all = { TOKEN: 'tok-30-a', FILE_TOO: 'tok-30-b', ENV_TOO: 'tok-30-c' };
			assert.deepStrictEqual(values.environment(request), all);
			assert.deepStrictEqual(values.environment(request), all);
			assert.deepStrictEqual(lines, [
				noValueLine('MISSING', LABEL),
				clashLine('FILE_TOO', 'the redpandaConnect.envFile file', LABEL),
				clashLine('ENV_TOO', 'redpandaConnect.env', LABEL),
			]);
			assert.match(lines[0], /MISSING has no value on this machine for folder "b".*"Redpanda Connect: Set secret variable"/);
			assert.ok(!lines.some((l) => l.includes('tok-30')), 'no value is logged');
			// The window's value is the window's only.
			assert.deepStrictEqual(values.environment({ ...request, scope: WINDOW_SCOPE, declared: ['TOKEN'] }), { TOKEN: 'tok-30-window' });
			// A missing env file has no names.
			assert.deepStrictEqual(values.environment({ ...request, declared: ['FILE_TOO'], envFile: path.join(dir, 'nope') }), { FILE_TOO: 'tok-30-b' });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('before the first load, a missing value is not logged; CHANGE / REMOVE take effect at once', () => {
		const lines: string[] = [];
		const values = new SecretValues((l) => lines.push(l));
		const request = { scope: FOLDER, scopeLabel: LABEL, declared: ['A'], envSettingNames: new Set<string>(), envFile: undefined };
		assert.deepStrictEqual(values.environment(request), {});
		assert.deepStrictEqual(values.environment(request), {});
		assert.deepStrictEqual(lines, [STILL_LOADING_LINE], 'still loading: told once, no names');
		lines.length = 0;
		assert.strictEqual(values.replace(new Map()), false);
		values.put(secretKey(FOLDER, 'A'), 'one');
		assert.deepStrictEqual(values.environment(request), { A: 'one' });
		values.put(secretKey(FOLDER, 'A'), 'two');
		assert.deepStrictEqual(values.environment(request), { A: 'two' });
		values.put(secretKey(FOLDER, 'A'), undefined);
		assert.deepStrictEqual(values.environment(request), {});
		assert.deepStrictEqual(lines, [noValueLine('A', LABEL)]);
		assert.strictEqual(values.replace(new Map([[secretKey(FOLDER, 'A'), 'x']])), true);
		assert.strictEqual(values.replace(new Map([[secretKey(FOLDER, 'A'), 'x']])), false);
	});
});

suite('adapters/redpandaConnect args: secret variables (ticket 30)', () => {
	const WS = path.resolve('/work/space');
	const A = path.join(WS, 'a.yaml');
	const BIN = '/usr/local/bin/redpanda-connect';
	const standalone: BinaryState = { kind: 'ok', path: BIN, version: '4.112.0', invocation: [BIN] };
	const ok = (result: ArgsResult) => {
		assert.strictEqual(result.kind, 'ok', JSON.stringify(result));
		return result as Extract<ArgsResult, { kind: 'ok' }>;
	};
	const environment = (overrides: Partial<ArgsEnvironment> = {}): ArgsEnvironment => ({
		resourceFilesSetting: [], envFileSetting: '', homeDir: '/home/u', workspaceFolder: WS,
		processEnv: { PATH: '/usr/bin', TOKEN: 'from-process' }, ...overrides,
	});
	const all = (env: ArgsEnvironment) => [
		ok(buildLintCommand(standalone, { targets: [A] }, env)),
		ok(buildRunCommand(standalone, { targets: [A] }, env)),
		ok(buildBloblCommandLine(standalone, path.join(WS, 'm.blobl'), commandSettings(() => env))),
	];

	test('EVERY_COMMAND: lint, run and blobl get the declared secrets in their environment, over the process\'s; never in the argv', () => {
		const values = new SecretValues();
		values.replace(new Map([[secretKey(FOLDER, 'TOKEN'), 'tok-30-secret']]));
		const env = environment({ secretEnvSetting: ['TOKEN'], secretScope: { scope: FOLDER, label: LABEL }, secretValues: values });
		const plain = all(environment());
		const got = all(env);
		for (const [i, line] of got.entries()) {
			assert.deepStrictEqual(line.env, { PATH: '/usr/bin', TOKEN: 'tok-30-secret', NO_COLOR: '1' });
			assert.deepStrictEqual(line.args, plain[i].args, 'the argv is unchanged');
			assert.ok(!line.args.some((a) => a.includes('tok-30')));
		}
	});

	test('EMPTY: secretEnv unset or [] (or no values): argv and environment exactly as ticket 29', () => {
		const values = new SecretValues();
		values.replace(new Map([[secretKey(FOLDER, 'TOKEN'), 'tok-30-secret']]));
		const base = environment({ envFileSetting: '.env', resourceFilesSetting: ['r.yaml'] });
		for (const secretEnvSetting of [undefined, [], ['OTHER'], 'TOKEN']) {
			const env = { ...base, secretEnvSetting, secretScope: { scope: FOLDER, label: LABEL }, secretValues: values };
			assert.deepStrictEqual(all(env), all(base), JSON.stringify(secretEnvSetting));
		}
	});

	test('CLASH: a name the env setting sets is still passed (its generated file wins in the binary), told once', () => {
		const lines: string[] = [];
		const values = new SecretValues((l) => lines.push(l));
		values.replace(new Map([[secretKey(FOLDER, 'TOKEN'), 'tok-30-secret']]));
		const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-args-secret-'));
		try {
			const env = environment({
				envSetting: { TOKEN: 'from-setting' }, envSettingFiles: EnvSettingFiles.in(storage),
				secretEnvSetting: ['TOKEN'], secretScope: { scope: FOLDER, label: LABEL }, secretValues: values,
			});
			const run = ok(buildRunCommand(standalone, { targets: [A] }, env));
			assert.strictEqual(run.env.TOKEN, 'tok-30-secret');
			assert.deepStrictEqual(lines, [clashLine('TOKEN', 'redpandaConnect.env', LABEL)]);
		} finally {
			fs.rmSync(storage, { recursive: true, force: true });
		}
	});
});
