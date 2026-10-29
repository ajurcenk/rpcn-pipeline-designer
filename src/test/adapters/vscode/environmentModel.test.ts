import * as assert from 'assert';
import { readEnvFile } from '../../../core/envFileRead';
import { envUsage } from '../../../core/envUsage';
import { type EnvironmentInputs, environmentModel, licenseSource } from '../../../adapters/vscode/environmentModel';

const base: EnvironmentInputs = { setting: [], secrets: [], processEnv: {}, usage: [] };
const states = (model: ReturnType<typeof environmentModel>) => Object.fromEntries(model.groups.map((g) => [
	g.source, g.variables.map((v) => `${v.name}:${v.state}${v.overriddenBy ? `>${v.overriddenBy}` : ''}`),
]));

// Ticket 31: the precedence and states the Environment view shows.
suite('adapters/vscode environmentModel', () => {
	test('SOURCES: the setting over the env file over secrets over VS Code\'s environment', () => {
		const model = environmentModel({
			setting: [{ name: 'TOPIC', value: 't', level: 'folder' }],
			secrets: [{ name: 'API_TOKEN', value: 's' }],
			envFile: { path: '/w/b/.env', read: readEnvFile('API_TOKEN=f\nBROKERS=k:9092\n') },
			processEnv: { HOME: '/home/u', PATH: '/bin' },
			usage: envUsage('a: ${TOPIC}\nb: ${API_TOKEN}\nc: ${BROKERS}\nd: ${HOME}'),
		});
		assert.deepStrictEqual(states(model), {
			setting: ['TOPIC:used'],
			envFile: ['API_TOKEN:used', 'BROKERS:used'],
			secret: ['API_TOKEN:overridden>envFile'],
			process: ['HOME:used'],
		});
		assert.deepStrictEqual(model.missing, []);
		assert.strictEqual(model.envFilePath, '/w/b/.env');
		assert.strictEqual(model.groups[0].variables[0].level, 'folder');
		assert.strictEqual(model.groups[1].variables[1].line, 2);
	});

	test('the setting wins over every source; a secret over VS Code\'s environment', () => {
		const model = environmentModel({
			...base,
			setting: [{ name: 'X', value: '1', level: 'user' }],
			secrets: [{ name: 'X', value: '2' }, { name: 'HOME', value: '3' }],
			envFile: { path: '/e', read: readEnvFile('X=4\n') },
			processEnv: { X: '5', HOME: '6' },
			usage: envUsage('${X} ${HOME}'),
		});
		assert.deepStrictEqual(states(model), {
			setting: ['X:used'], envFile: ['X:overridden>setting'], secret: ['X:overridden>setting', 'HOME:used'],
			process: ['X:overridden>setting', 'HOME:overridden>secret'],
		});
	});

	test('MISSING: used names nothing sets; a default or any source is not missing; a secret without a value is', () => {
		const model = environmentModel({
			...base,
			secrets: [{ name: 'ZONE', value: undefined }],
			processEnv: { HOME: '/h' },
			usage: envUsage('${REGION} ${PORT:8080} env("ZONE") ${HOME}'),
		});
		assert.deepStrictEqual(model.missing, ['REGION', 'ZONE']);
		assert.deepStrictEqual(states(model).secret, ['ZONE:noValue']);
	});

	test('VS Code\'s environment lists the used names only', () => {
		const model = environmentModel({ ...base, processEnv: { HOME: '/h', PATH: '/p' }, usage: envUsage('${HOME}') });
		assert.deepStrictEqual(states(model).process, ['HOME:used']);
	});

	test('BAD_ENV_FILE: a rejected file sets nothing, its rows are ignored, the note names the line', () => {
		const model = environmentModel({
			...base,
			envFile: { path: '/e', read: readEnvFile('A=1\nexport B=2\n') },
			usage: envUsage('${A}'),
		});
		assert.deepStrictEqual(states(model).envFile, ['A:ignored']);
		assert.deepStrictEqual(model.missing, ['A']);
		assert.match(model.envFileNote!, /will not use this file: line 2/);
	});

	test('a file read only in part, an unreadable or unusable file: noted', () => {
		assert.strictEqual(environmentModel({ ...base, envFile: { path: '/e', read: readEnvFile('A=1\n B=2\n') } }).envFileNote,
			'The binary stops reading this file at line 2: that line and the ones after it are not set.');
		assert.strictEqual(environmentModel({ ...base, envFile: { path: '/e', read: readEnvFile('A=1 2\nB=2\n') } }).envFileNote,
			'The binary stops reading this file at line 1: the rest of that line and the lines after it are not set.');
		assert.match(environmentModel({ ...base, envFile: { path: '/e', read: { error: 'ENOENT' } } }).envFileNote!, /cannot be read \(ENOENT\)/);
		assert.strictEqual(environmentModel({ ...base, envFileUnusable: 'why' }).envFileNote, 'why');
		assert.strictEqual(environmentModel(base).envFileNote, undefined);
	});

	test('NO_COLOR: the extension\'s 1, under the setting and the env file, over secrets and VS Code\'s environment; never missing', () => {
		const used = environmentModel({ ...base, processEnv: { NO_COLOR: '' }, secrets: [{ name: 'NO_COLOR', value: 's' }], usage: envUsage('${NO_COLOR}') });
		assert.deepStrictEqual(states(used), { setting: [], envFile: [], extension: ['NO_COLOR:used'], secret: ['NO_COLOR:overridden>extension'], process: ['NO_COLOR:overridden>extension'] });
		assert.strictEqual(used.groups.find((g) => g.source === 'extension')!.variables[0].value, '1');
		assert.deepStrictEqual(used.missing, []);
		const byFile = environmentModel({ ...base, envFile: { path: '/e', read: readEnvFile('NO_COLOR=0\n') } });
		assert.deepStrictEqual(states(byFile).extension, ['NO_COLOR:overridden>envFile']);
		const bySetting = environmentModel({ ...base, setting: [{ name: 'NO_COLOR', value: '0', level: 'user' }] });
		assert.deepStrictEqual(states(bySetting).extension, ['NO_COLOR:overridden>setting']);
		assert.ok(!environmentModel({ ...base, processEnv: { NO_COLOR: '1' } }).groups.some((g) => g.source === 'extension'), 'not listed when nothing uses or sets it');
	});
});

// Ticket 38: where the binary takes the Enterprise license from (its process environment only).
suite('adapters/vscode licenseSource', () => {
	const absent = { path: '/etc/redpanda/redpanda.license', exists: false };
	const present = { ...absent, exists: true };

	test('SOURCE_STRING: REDPANDA_LICENSE from a secret wins over VS Code\'s environment and over the file variable', () => {
		const info = licenseSource({
			...base,
			secrets: [{ name: 'REDPANDA_LICENSE', value: 'lic-secret' }],
			processEnv: { REDPANDA_LICENSE: 'lic-env', REDPANDA_LICENSE_FILEPATH: '/p' },
		}, present);
		assert.deepStrictEqual(info.source, { kind: 'string', from: 'secret' });
		assert.deepStrictEqual([...info.values].sort(), ['/p', 'lic-env', 'lic-secret'], 'the file path from VS Code\'s environment is masked too');
		assert.deepStrictEqual(licenseSource({ ...base, processEnv: { REDPANDA_LICENSE: 'lic-env' } }, absent).source, { kind: 'string', from: 'process' });
	});

	test('SOURCE_FILE: no string; REDPANDA_LICENSE_FILEPATH from a secret or VS Code\'s environment', () => {
		assert.deepStrictEqual(licenseSource({ ...base, processEnv: { REDPANDA_LICENSE_FILEPATH: '/p' } }, present).source, { kind: 'file', path: '/p', from: 'process' });
		assert.deepStrictEqual(licenseSource({ ...base, secrets: [{ name: 'REDPANDA_LICENSE_FILEPATH', value: '/s' }], processEnv: { REDPANDA_LICENSE_FILEPATH: '/p' } }, absent).source,
			{ kind: 'file', path: '/s', from: 'secret' });
	});

	test('SOURCE_DEFAULT / SOURCE_NONE: the default file when it exists, else none; empty values and secrets without a value are not set', () => {
		const empty = { ...base, secrets: [{ name: 'REDPANDA_LICENSE', value: undefined }], processEnv: { REDPANDA_LICENSE: '', REDPANDA_LICENSE_FILEPATH: '' } };
		assert.deepStrictEqual(licenseSource(empty, present).source, { kind: 'file', path: '/etc/redpanda/redpanda.license', from: 'default' });
		assert.deepStrictEqual(licenseSource(empty, absent).source, { kind: 'none' });
		assert.deepStrictEqual(licenseSource(empty, absent).values, []);
	});

	test('the setting and the env file are not read for the license (the binary reads them for ${NAME} only); their values are masked', () => {
		const info = licenseSource({
			...base,
			setting: [{ name: 'REDPANDA_LICENSE', value: 'lic-setting', level: 'user' }],
			envFile: { path: '/e', read: readEnvFile('REDPANDA_LICENSE_FILEPATH=/f\nREDPANDA_LICENSE=lic-file\n') },
		}, absent);
		assert.deepStrictEqual(info.source, { kind: 'none' });
		assert.deepStrictEqual(info.notRead, [
			{ name: 'REDPANDA_LICENSE', source: 'setting' },
			{ name: 'REDPANDA_LICENSE', source: 'envFile' },
			{ name: 'REDPANDA_LICENSE_FILEPATH', source: 'envFile' },
		]);
		assert.deepStrictEqual(info.values, ['lic-setting', 'lic-file']);
	});

	test('the license variables are not in the model\'s Missing (the config does not use them)', () => {
		assert.deepStrictEqual(environmentModel({ ...base, usage: envUsage('a: 1') }).missing, []);
	});
});
