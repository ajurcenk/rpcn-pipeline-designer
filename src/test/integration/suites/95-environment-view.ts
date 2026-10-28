// The Environment view (ticket 31), end to end in the stable run (no folder open: the config is in
// no workspace folder, so plain variables go to the user settings and secrets to the window's).
// The view is read through the test seam (`api().environment.items()`), its prompts replaced by a
// script of answers, and its commands run as the tree's menus run them (with the item).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildLintArgs, buildRunArgs } from '../../../core/args';
import { commandSettings, defaultArgsEnvironment } from '../../../adapters/redpandaConnect/args';
import { buildBloblCommandLine, buildCommandLine } from '../../../adapters/redpandaConnect/commandLine';
import { EnvSettingFiles } from '../../../adapters/redpandaConnect/envSetting';
import { WINDOW_SCOPE } from '../../../adapters/redpandaConnect/secretEnv';
import {
	ADD_VARIABLE_COMMAND, EDIT_VARIABLE_COMMAND, EnvironmentView, type EnvironmentItem, type EnvSettingWriter, type EnvironmentUi, HIDE_VALUE_COMMAND, NO_CONFIG_MESSAGE, OPEN_ENV_FILE_COMMAND,
	REMOVE_VARIABLE_COMMAND, SET_MISSING_COMMAND, SHOW_VALUE_COMMAND, VIEW_MASK,
} from '../../../adapters/vscode/environmentView';
import type { SecretVariables } from '../../../adapters/vscode/secrets';
import { type ExtensionApi } from '../../../extension';
import { makeTempDir } from '../../helpers/fakeBinary';
import { EXTENSION_ID, waitFor } from '../helpers';

const CONFIG = [
	'input:',
	'  generate:',
	'    interval: 1s',
	'    mapping: |',
	'      root.topic = "${TOPIC}"',
	'      root.token = "${API_TOKEN}"',
	'      root.brokers = "${BROKERS}"',
	'      root.home = "${HOME}"',
	'      root.region = "${REGION}"',
	'      root.zone = env("ZONE")',
	'      root.port = "${PORT:8080}"',
	'output:',
	'  stdout: {}',
	'',
].join('\n');
const SECRET_VALUE = 'tok-31-secret';
const FILE_VALUE = 'tok-31-file';

suite('Environment view (integration, ticket 31)', function () {
	this.timeout(60_000);
	let dir: string;
	let configFile: string;
	let envFile: string;
	let doc: vscode.TextDocument;
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const view = () => api().environment!;
	const config = () => vscode.workspace.getConfiguration('redpandaConnect');
	const items = () => view().items();
	const row = (group: EnvironmentItem['group'], name: string) => items().find((i) => i.group === group && i.node.kind !== 'group' && i.label === name);
	const groupOf = (group: EnvironmentItem['group']) => items().filter((i) => i.group === group && i.node.kind !== 'group');
	const errors: string[] = [];
	const infos: string[] = [];
	let originalUi: EnvironmentUi;
	let originalWrite: EnvSettingWriter;

	/** Replaces the prompts: `kinds` answers the plain / secret pick, `inputs` each input box in turn (a function gets its options). */
	function script(kinds: ('plain' | 'secret' | undefined)[], inputs: (string | undefined | ((o: vscode.InputBoxOptions) => string | undefined))[]): vscode.InputBoxOptions[] {
		const asked: vscode.InputBoxOptions[] = [];
		view().ui = {
			pickKind: async () => kinds.shift(),
			input: async (options) => {
				asked.push(options);
				const next = inputs.shift();
				return typeof next === 'function' ? next(options) : next;
			},
			error: (m) => errors.push(m),
			info: (m) => infos.push(m),
		};
		return asked;
	}

	async function showConfig(): Promise<void> {
		doc = await vscode.workspace.openTextDocument(configFile);
		await vscode.window.showTextDocument(doc, { preview: false });
		assert.ok(await waitFor(() => view().configUri?.toString() === doc.uri.toString(), 10_000), `the view does not show ${configFile}`);
	}

	suiteSetup(async () => {
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
		dir = makeTempDir('rpcn-env-view-');
		configFile = path.join(dir, 'env.yaml');
		envFile = path.join(dir, '.env');
		fs.writeFileSync(configFile, CONFIG);
		originalUi = view().ui;
		originalWrite = view().writeSetting;
	});

	setup(async () => {
		errors.length = 0;
		infos.length = 0;
		fs.writeFileSync(envFile, `API_TOKEN=${FILE_VALUE}\nBROKERS=k:9092\n`);
		await config().update('env', { TOPIC: 'events' }, vscode.ConfigurationTarget.Global);
		await config().update('envFile', envFile, vscode.ConfigurationTarget.Global);
		assert.ok(await api().secrets!.set(undefined, 'API_TOKEN', SECRET_VALUE));
		await showConfig();
		assert.ok(await waitFor(() => row('secret', 'API_TOKEN') !== undefined && row('envFile', 'BROKERS') !== undefined, 10_000), JSON.stringify(items().map((i) => i.label)));
	});

	teardown(async () => {
		view().ui = originalUi;
		view().writeSetting = originalWrite;
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await config().update('env', undefined, vscode.ConfigurationTarget.Global);
		await config().update('envFile', undefined, vscode.ConfigurationTarget.Global);
		await api().secrets!.clear(async () => true);
		await config().update('secretEnv', undefined, vscode.ConfigurationTarget.Global);
	});

	suiteTeardown(() => {
		if (dir) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('SOURCES: four groups; the env file\'s API_TOKEN is used over the secret (overridden, crossed out); TOPIC, BROKERS, HOME used', () => {
		const groups = items().filter((i) => i.node.kind === 'group').map((i) => i.group);
		assert.deepStrictEqual(groups, ['missing', 'setting', 'envFile', 'secret', 'process']);
		const state = (i: EnvironmentItem | undefined) => (i?.node.kind === 'variable' ? i.node.variable.state : undefined);
		assert.strictEqual(state(row('setting', 'TOPIC')), 'used');
		assert.strictEqual(state(row('envFile', 'API_TOKEN')), 'used');
		assert.strictEqual(state(row('envFile', 'BROKERS')), 'used');
		assert.strictEqual(state(row('secret', 'API_TOKEN')), 'overridden');
		assert.strictEqual(state(row('process', 'HOME')), 'used');
		assert.deepStrictEqual(groupOf('process').map((i) => i.label), ['HOME'], 'VS Code\'s environment: the used names only');
		// Keyboard and screen reader: the label says source, state and that the value is masked.
		assert.strictEqual(row('secret', 'API_TOKEN')!.accessibility, 'API_TOKEN, secret, overridden by the env file, used by the config, value masked');
		assert.strictEqual(row('setting', 'TOPIC')!.accessibility, 'TOPIC, setting redpandaConnect.env, used, used by the config, value events');
		assert.strictEqual(row('secret', 'API_TOKEN')!.crossedOut, true, 'the overridden one is crossed out');
		assert.strictEqual(row('envFile', 'API_TOKEN')!.crossedOut, false);
	});

	test('MASK: secret and env-file values are masked; Show value reveals that row only; Hide and a refresh mask it again', async () => {
		const file = () => row('envFile', 'API_TOKEN')!;
		const secret = () => row('secret', 'API_TOKEN')!;
		assert.ok(file().description.startsWith(VIEW_MASK), file().description);
		assert.ok(secret().description.startsWith(VIEW_MASK), secret().description);
		const shownText = () => JSON.stringify(items().map((i) => [i.label, i.description, i.accessibility]));
		assert.ok(!shownText().includes(SECRET_VALUE) && !shownText().includes(FILE_VALUE), shownText());
		assert.match(file().contextValue, /\bmasked\b/);

		await vscode.commands.executeCommand(SHOW_VALUE_COMMAND, file().node);
		assert.ok(file().description.startsWith(FILE_VALUE), file().description);
		assert.match(file().contextValue, /\brevealed\b/);
		assert.ok(secret().description.startsWith(VIEW_MASK), 'the other rows stay masked');
		assert.ok(row('envFile', 'BROKERS')!.description.startsWith(VIEW_MASK));

		await vscode.commands.executeCommand(HIDE_VALUE_COMMAND, file().node);
		assert.ok(file().description.startsWith(VIEW_MASK));

		await vscode.commands.executeCommand(SHOW_VALUE_COMMAND, secret().node);
		assert.ok(secret().description.startsWith(SECRET_VALUE));
		view().refresh();
		assert.ok(secret().description.startsWith(VIEW_MASK), 'a refresh masks it again');
		assert.ok(!api().outputLines().some((l) => l.includes(SECRET_VALUE) || l.includes(FILE_VALUE)), 'no value is logged');
	});

	test('MISSING: REGION and ZONE are missing with a set action; PORT has a default', () => {
		assert.deepStrictEqual(groupOf('missing').map((i) => i.label), ['REGION', 'ZONE']);
		assert.strictEqual(groupOf('missing')[0].contextValue, 'missing');
		assert.ok(!items().some((i) => i.label === 'PORT'));
	});

	test('SET_MISSING: plain writes the value to redpandaConnect.env; secret goes through ticket 30\'s set flow with the name prefilled; the view updates', async () => {
		script(['plain'], ['eu-west']);
		assert.strictEqual(await vscode.commands.executeCommand(SET_MISSING_COMMAND, groupOf('missing')[0].node), 'REGION', 'the name set');
		assert.deepStrictEqual(config().inspect('env')?.globalValue, { TOPIC: 'events', REGION: 'eu-west' });
		assert.ok(await waitFor(() => row('setting', 'REGION') !== undefined && !groupOf('missing').some((i) => i.label === 'REGION'), 5_000));

		const asked = script(['secret'], [(o) => o.value, 'tok-31-zone']);
		assert.strictEqual(await vscode.commands.executeCommand(SET_MISSING_COMMAND, 'ZONE'), 'ZONE');
		assert.strictEqual(asked[0].value, 'ZONE', 'the name is prefilled');
		assert.strictEqual(asked[1].password, true, 'the value is a password input');
		assert.strictEqual(api().secrets!.values.get(WINDOW_SCOPE, 'ZONE'), 'tok-31-zone');
		assert.deepStrictEqual(config().inspect('secretEnv')?.globalValue, ['API_TOKEN', 'ZONE']);
		assert.ok(await waitFor(() => row('secret', 'ZONE') !== undefined && groupOf('missing').length === 0, 5_000), JSON.stringify(items().map((i) => i.label)));
		assert.ok(!items().some((i) => i.node.kind === 'group' && i.group === 'missing'), 'no Missing group when nothing is missing');
	});

	test('SET_MISSING: a cancelled pick or input changes nothing', async () => {
		script([undefined], []);
		assert.strictEqual(await vscode.commands.executeCommand(SET_MISSING_COMMAND, 'REGION'), undefined);
		script(['plain'], [undefined]);
		assert.strictEqual(await vscode.commands.executeCommand(SET_MISSING_COMMAND, 'REGION'), undefined);
		script(['secret'], [(o) => o.value, undefined]);
		assert.strictEqual(await vscode.commands.executeCommand(SET_MISSING_COMMAND, 'REGION'), undefined);
		assert.deepStrictEqual(config().inspect('env')?.globalValue, { TOPIC: 'events' });
		assert.deepStrictEqual(config().inspect('secretEnv')?.globalValue, ['API_TOKEN']);
		assert.deepStrictEqual(groupOf('missing').map((i) => i.label), ['REGION', 'ZONE']);
	});

	test('ACTIONS: edit and remove a plain variable at its level; edit and remove a secret through ticket 30; open the env file', async () => {
		script([], [(o) => (o.value === 'events' ? 'orders' : 'wrong prefill')]);
		assert.strictEqual(await vscode.commands.executeCommand(EDIT_VARIABLE_COMMAND, row('setting', 'TOPIC')!.node), true);
		assert.deepStrictEqual(config().inspect('env')?.globalValue, { TOPIC: 'orders' });
		assert.ok(await waitFor(() => row('setting', 'TOPIC')?.description.startsWith('orders') === true, 5_000));

		assert.strictEqual(await vscode.commands.executeCommand(REMOVE_VARIABLE_COMMAND, row('setting', 'TOPIC')!.node), true);
		assert.strictEqual(config().inspect('env')?.globalValue, undefined);
		assert.ok(await waitFor(() => row('setting', 'TOPIC') === undefined && groupOf('missing').some((i) => i.label === 'TOPIC'), 5_000));

		const asked = script([], ['tok-31-new']);
		assert.strictEqual(await vscode.commands.executeCommand(EDIT_VARIABLE_COMMAND, row('secret', 'API_TOKEN')!.node), true);
		assert.strictEqual(asked[0].password, true);
		assert.strictEqual(api().secrets!.values.get(WINDOW_SCOPE, 'API_TOKEN'), 'tok-31-new');

		assert.strictEqual(await vscode.commands.executeCommand(REMOVE_VARIABLE_COMMAND, row('secret', 'API_TOKEN')!.node), true);
		assert.strictEqual(api().secrets!.values.get(WINDOW_SCOPE, 'API_TOKEN'), undefined);
		assert.deepStrictEqual(config().inspect('secretEnv')?.globalValue, ['API_TOKEN'], 'the name stays declared');
		assert.ok(await waitFor(() => (row('secret', 'API_TOKEN')?.node as { variable?: { state: string } } | undefined)?.variable?.state === 'noValue', 5_000));
		assert.doesNotMatch(row('secret', 'API_TOKEN')!.contextValue, /hasValue/, 'no remove on a secret without a value');

		assert.strictEqual(await vscode.commands.executeCommand(OPEN_ENV_FILE_COMMAND), true);
		assert.ok(await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath === envFile, 5_000));
		assert.strictEqual(view().configUri?.toString(), doc.uri.toString(), 'another editor active: the view keeps the last config');
		assert.ok(row('setting', 'TOPIC') === undefined && row('envFile', 'BROKERS') !== undefined);
		assert.deepStrictEqual(errors, []);
	});

	test('ACTIONS: a settings write failure is shown, without the value', async () => {
		view().writeSetting = async () => {
			throw new Error('cannot write user settings');
		};
		script([], ['very-secret-31']);
		assert.strictEqual(await vscode.commands.executeCommand(EDIT_VARIABLE_COMMAND, row('setting', 'TOPIC')!.node), false);
		assert.strictEqual(errors.length, 1);
		assert.match(errors[0], /Could not set TOPIC in redpandaConnect.env \(user settings\): cannot write user settings/);
		assert.ok(!errors[0].includes('very-secret-31'));
		assert.deepStrictEqual(config().inspect('env')?.globalValue, { TOPIC: 'events' });
	});

	test('BAD_ENV_FILE: a line the binary rejects: the env file group says it will not use the file, naming the line', async () => {
		fs.writeFileSync(envFile, 'BROKERS=k:9092\nexport API_TOKEN=x\n');
		// The env file is watched on disk.
		assert.ok(await waitFor(() => groupOf('envFile').some((i) => i.node.kind === 'note' && /will not use this file: line 2/.test(i.label)), 15_000),
			JSON.stringify(groupOf('envFile').map((i) => i.label)));
		assert.strictEqual((row('envFile', 'BROKERS')!.node as { variable: { state: string } }).variable.state, 'ignored');
		assert.strictEqual((row('secret', 'API_TOKEN')!.node as { variable: { state: string } }).variable.state, 'used', 'the file no longer wins');
		assert.ok(groupOf('missing').some((i) => i.label === 'BROKERS'));
	});

	test('the config\'s edits refresh the view (debounced)', async () => {
		const edit = new vscode.WorkspaceEdit();
		edit.insert(doc.uri, new vscode.Position(doc.lineCount - 1, 0), '# ${ADDED_31}\n');
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.ok(await waitFor(() => groupOf('missing').some((i) => i.label === 'ADDED_31'), 5_000));
		await vscode.commands.executeCommand('workbench.action.files.revert');
	});

	test('NO_CHANGE: lint, run, the live parse and the test run get the same argv and environment before and after the view is used', async () => {
		const state = { kind: 'ok', path: '/bin/fake', version: '4.112.0', invocation: ['/bin/fake'] } as const;
		const mappingFile = path.join(dir, 'mapping.blobl');
		const testConfig = path.join(dir, 'test-run.yaml');
		const build = () => {
			// The test's own module instances: the extension's env-setting folder and secret values are passed in.
			const env = { ...defaultArgsEnvironment(doc.uri), envSettingFiles: EnvSettingFiles.in(dir), secretValues: api().secrets!.values };
			const settings = commandSettings(() => env);
			return Object.fromEntries(([
				['lint', buildCommandLine(buildLintArgs, state, [configFile], settings)],
				['run', buildCommandLine(buildRunArgs, state, [configFile], settings)],
				['blobl', buildBloblCommandLine(state, mappingFile, settings)],
				['test run', buildCommandLine(buildRunArgs, state, [testConfig], settings)],
			] as const).map(([name, result]) => {
				assert.strictEqual(result.kind, 'ok', name);
				return [name, { command: result.command, args: result.args, env: result.env }];
			}));
		};
		const before = build();
		await vscode.commands.executeCommand(SHOW_VALUE_COMMAND, row('secret', 'API_TOKEN')!.node);
		await vscode.commands.executeCommand(SHOW_VALUE_COMMAND, row('envFile', 'BROKERS')!.node);
		items();
		await vscode.commands.executeCommand(HIDE_VALUE_COMMAND, row('envFile', 'BROKERS')!.node);
		view().refresh();
		items();
		view().model();
		assert.deepStrictEqual(build(), before);
		for (const name of ['lint', 'run', 'blobl', 'test run']) {
			assert.strictEqual(before[name].env.API_TOKEN, SECRET_VALUE, `ticket 30: the secret is in ${name}'s process environment`);
			assert.strictEqual(before[name].env.NO_COLOR, '1');
			assert.strictEqual(before[name].args.filter((a) => a === '--env-file').length, 2, `${name}: envFile's and redpandaConnect.env's`);
		}
	});

	test('ADD: a plain variable: the name is checked, the value lands in the user settings (no folder open)', async () => {
		const asked = script(['plain'], [(o) => (o.validateInput?.('1BAD') ? 'NEW_31' : 'not validated'), 'v-31']);
		assert.strictEqual(await vscode.commands.executeCommand(ADD_VARIABLE_COMMAND), true);
		assert.strictEqual(asked[0].validateInput?.('NEW_31'), undefined);
		assert.deepStrictEqual(config().inspect('env')?.globalValue, { TOPIC: 'events', NEW_31: 'v-31' });
		assert.ok(await waitFor(() => row('setting', 'NEW_31')?.node.kind === 'variable', 5_000));
		assert.strictEqual((row('setting', 'NEW_31')!.node as { variable: { level: string } }).variable.level, 'user');
		script(['plain'], ['1BAD']);
		assert.strictEqual(await vscode.commands.executeCommand(ADD_VARIABLE_COMMAND), false, 'a bad name is refused');
		assert.deepStrictEqual(config().inspect('env')?.globalValue, { TOPIC: 'events', NEW_31: 'v-31' });
	});

	test('ADD: a secret variable through ticket 30\'s set flow: declared in the user settings, its value stored, masked in the view', async () => {
		const asked = script(['secret'], ['SECRET_ADD_31', 'tok-31-added']);
		assert.strictEqual(await vscode.commands.executeCommand(ADD_VARIABLE_COMMAND), true);
		assert.strictEqual(asked[0].value, undefined, 'no name is prefilled');
		assert.strictEqual(asked[1].password, true);
		assert.strictEqual(api().secrets!.values.get(WINDOW_SCOPE, 'SECRET_ADD_31'), 'tok-31-added');
		assert.deepStrictEqual(config().inspect('secretEnv')?.globalValue, ['API_TOKEN', 'SECRET_ADD_31']);
		assert.ok(await waitFor(() => row('secret', 'SECRET_ADD_31')?.description.startsWith(VIEW_MASK) === true, 5_000));
	});

	test('WATCH: a view created with the config already active refreshes when the env file changes on disk, with no settings write before', async () => {
		const fresh = new EnvironmentView({
			detection: api().detection,
			secrets: { values: api().secrets!.values, onDidChange: api().secrets!.onDidChange } as unknown as SecretVariables,
			log: () => undefined,
		});
		try {
			assert.strictEqual(fresh.configUri?.toString(), doc.uri.toString());
			assert.ok(fresh.items().some((i) => i.group === 'envFile' && i.label === 'BROKERS'));
			fs.writeFileSync(envFile, `API_TOKEN=${FILE_VALUE}\nWATCHED_31=1\n`);
			assert.ok(await waitFor(() => fresh.items().some((i) => i.group === 'envFile' && i.label === 'WATCHED_31'), 15_000),
				JSON.stringify(fresh.items().map((i) => i.label)));
		} finally {
			fresh.dispose();
		}
	});

	test('NO_CONFIG: when no detected config is shown, the view says to open one', async () => {
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), 'just: yaml\n');
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.ok(await waitFor(() => view().configUri === undefined, 5_000));
		assert.strictEqual(view().message, NO_CONFIG_MESSAGE);
		assert.deepStrictEqual(items(), []);
		await vscode.commands.executeCommand('workbench.action.files.revert');
		assert.ok(await waitFor(() => !doc.isDirty, 5_000));
	});
});
