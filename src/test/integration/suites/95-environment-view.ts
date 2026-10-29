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
	REMOVE_VARIABLE_COMMAND, REVEAL_VARIABLE_COMMAND, SET_MISSING_COMMAND, SHOW_VALUE_COMMAND, VIEW_MASK,
	CHECK_LICENSE_COMMAND, OPEN_LICENSE_DOCS_COMMAND,
} from '../../../adapters/vscode/environmentView';
import { ENV_HOVER_TITLE, EnvHoverProvider, envHoverMarkdown } from '../../../adapters/vscode/envHover';
import type { SecretVariables } from '../../../adapters/vscode/secrets';
import { type ExtensionApi } from '../../../extension';
import { connectScript, makeTempDir, writeFakeBinary } from '../../helpers/fakeBinary';
import { EXTENSION_ID, waitFor, waitForAsync } from '../helpers';
import { hoverText, schemaFrom, useSchemaBinary } from '../schemaHarness';

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
	// --- Ticket 34: the variable hover, read from the view's model for the hovered config ---

	/** The variable hovers at `marker` (+ `delta`) in `d`, as markdown; every hover there is checked for values. */
	async function envHovers(marker: string, delta = 2, d: vscode.TextDocument = doc): Promise<string[]> {
		const at = d.getText().indexOf(marker);
		assert.ok(at >= 0, marker);
		const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', d.uri, d.positionAt(at + delta));
		const texts = (hovers ?? []).flatMap((h) => h.contents).map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : ''));
		const ours = texts.filter((t) => t.startsWith(`**${ENV_HOVER_TITLE}**`));
		for (const t of ours) {
			for (const value of [SECRET_VALUE, FILE_VALUE, process.env.HOME!]) {
				assert.ok(!t.includes(value), `a masked value in the hover: ${t}`);
			}
		}
		return ours;
	}
	async function envHover(marker: string, delta = 2, d: vscode.TextDocument = doc): Promise<string> {
		const ours = await envHovers(marker, delta, d);
		assert.strictEqual(ours.length, 1, `one variable hover at ${marker}: ${JSON.stringify(ours)}`);
		return ours[0];
	}
	/** The command links in a hover: `[label, command, args]`. */
	function links(markdown: string): [string, string, unknown[]][] {
		return [...markdown.matchAll(/\[([^\]]+)\]\(command:([^?)]+)\?([^)]+)\)/g)].map((m) => [m[1], m[2], JSON.parse(decodeURIComponent(m[3])) as unknown[]]);
	}
	const SETTING_LABEL = '**Settings (redpandaConnect.env)** (user settings)';

	test('HOVER PLAIN: ${TOPIC} shows the setting\'s value in clear and its level; no link', async function () {
		this.timeout(180_000);
		const text = await envHover('${TOPIC}');
		assert.match(text, /`TOPIC`/);
		assert.ok(text.includes(`\`events\` from ${SETTING_LABEL}`), text);
		assert.deepStrictEqual(links(text), []);
		assert.ok(!/Overrides/.test(text));
	});

	test('HOVER OVERRIDES: ${API_TOKEN} is from the env file (its line), masked, and overrides the secret; ${HOME} is masked', async function () {
		this.timeout(180_000);
		const text = await envHover('${API_TOKEN}');
		assert.ok(text.includes(`\`${VIEW_MASK}\` from **Env file** (.env, line 1)`), text);
		assert.ok(text.includes('Overrides: **Secrets**'), text);
		const [[label, command, args]] = links(text);
		assert.deepStrictEqual([label, command, args], ['Show value', REVEAL_VARIABLE_COMMAND, [doc.uri.toString(), 'envFile', 'API_TOKEN']]);
		const home = await envHover('${HOME}');
		assert.ok(home.includes(`\`${VIEW_MASK}\` from **VS Code environment**`), home);
	});

	test('HOVER MASKED_SHOW: Show value shows this config in the view with its env-file API_TOKEN row revealed, the others masked', async function () {
		this.timeout(180_000);
		const text = await envHover('${API_TOKEN}');
		// Another config shown first: the link's config replaces it.
		const other = path.join(dir, 'other.yaml');
		fs.writeFileSync(other, 'input:\n  stdin: {}\noutput:\n  stdout: {}\n');
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(other), { preview: false });
		assert.ok(await waitFor(() => view().configUri?.fsPath === other, 10_000));
		const [[, command, args]] = links(text);
		assert.strictEqual(await vscode.commands.executeCommand(command, ...args), true);
		assert.strictEqual(view().configUri?.toString(), doc.uri.toString());
		assert.ok(row('envFile', 'API_TOKEN')!.description.startsWith(FILE_VALUE), row('envFile', 'API_TOKEN')!.description);
		assert.ok(row('secret', 'API_TOKEN')!.description.startsWith(VIEW_MASK));
		assert.ok(row('envFile', 'BROKERS')!.description.startsWith(VIEW_MASK));
		assert.ok(!(await envHover('${API_TOKEN}')).includes(FILE_VALUE), 'the hover stays masked');
		assert.strictEqual(await vscode.commands.executeCommand(REVEAL_VARIABLE_COMMAND, doc.uri.toString(), 'setting', 'NOPE'), false, 'no such row');
		assert.ok(!api().outputLines().some((l) => l.includes(SECRET_VALUE) || l.includes(FILE_VALUE)), 'no value is logged');
		assert.ok(!api().outputLines().some((l) => l.includes('could not reveal')), api().outputLines().slice(-5).join('\n'));
		assert.ok(await waitFor(() => view().visible, 5_000), 'the view is shown');
	});

	test('HOVER MISSING: ${REGION} is missing; Set variable… runs the set action for REGION and this config; cancelled changes nothing', async function () {
		this.timeout(180_000);
		const text = await envHover('${REGION}');
		assert.match(text, /Missing: the config uses it without a default and no source sets it/);
		const [[label, command, args]] = links(text);
		assert.deepStrictEqual([label, command, args], ['Set variable…', SET_MISSING_COMMAND, ['REGION', doc.uri.toString()]]);
		script([undefined], []);
		assert.strictEqual(await vscode.commands.executeCommand(command, ...args), undefined);
		assert.deepStrictEqual(config().inspect('env')?.globalValue, { TOPIC: 'events' });
		script(['plain'], ['eu-west']);
		assert.strictEqual(await vscode.commands.executeCommand(command, ...args), 'REGION');
		assert.deepStrictEqual(config().inspect('env')?.globalValue, { TOPIC: 'events', REGION: 'eu-west' });
		assert.ok((await envHover('${REGION}')).includes(`\`eu-west\` from ${SETTING_LABEL}`));
		assert.deepStrictEqual(errors, []);
	});

	test('HOVER DEFAULT / DEFAULT_SET: ${PORT:8080} shows the default in use; once PORT is set, its value', async function () {
		this.timeout(180_000);
		assert.ok((await envHover('${PORT')).includes('Not set: the default `8080` is used.'));
		await config().update('env', { TOPIC: 'events', PORT: '9090' }, vscode.ConfigurationTarget.Global);
		const text = await envHover('${PORT');
		assert.ok(text.includes(`\`9090\` from ${SETTING_LABEL}`), text);
		assert.ok(!text.includes('default'), text);
	});

	test('HOVER CURRENT: a value changed after a hover shows on the next hover', async function () {
		this.timeout(180_000);
		assert.ok((await envHover('${TOPIC}')).includes('`events`'));
		await config().update('env', { TOPIC: 'orders' }, vscode.ConfigurationTarget.Global);
		assert.ok((await envHover('${TOPIC}')).includes('`orders`'));
		fs.writeFileSync(envFile, 'BROKERS=k:9092\n');
		const token = await envHover('${API_TOKEN}');
		assert.ok(token.includes(`\`${VIEW_MASK}\` from **Secrets**`), `the env file on disk is read on the hover: ${token}`);
		fs.writeFileSync(envFile, 'BROKERS=k:9092\nexport X=1\n');
		const region = await envHover('${REGION}');
		assert.ok(region.includes('Env file: The binary will not use this file: line 2'), `the env file's note on any hover: ${region}`);
	});

	test('HOVER NOT_A_USE: plain text, ${!…}, env(this.name) and an undetected file get no variable hover', async function () {
		this.timeout(180_000);
		assert.deepStrictEqual(await envHovers('interval', 1), []);
		const other = path.join(dir, 'not-a-use.yaml');
		fs.writeFileSync(other, 'input:\n  generate:\n    mapping: |\n      root.a = "${! this.x }"\n      root.b = env(this.name)\noutput:\n  stdout: {}\n');
		const d = await vscode.workspace.openTextDocument(other);
		await vscode.window.showTextDocument(d, { preview: false });
		assert.ok(await waitFor(() => api().detection.isDetected(d.uri), 10_000));
		assert.deepStrictEqual(await envHovers('${!', 4, d), []);
		assert.deepStrictEqual(await envHovers('env(this', 2, d), []);
		const plain = path.join(dir, 'plain.yaml');
		fs.writeFileSync(plain, 'just: "${TOPIC}"\n');
		const p = await vscode.workspace.openTextDocument(plain);
		await vscode.window.showTextDocument(p, { preview: false });
		assert.strictEqual(api().detection.isDetected(p.uri), false);
		assert.deepStrictEqual(await envHovers('${TOPIC}', 2, p), []);
	});

	test('HOVER TRUST: the markdown enables only the two commands', () => {
		const provider = new EnvHoverProvider({ isDetected: (u) => api().detection.isDetected(u), modelFor: (u) => view().modelFor(u) });
		const hover = provider.provideHover(doc, doc.positionAt(doc.getText().indexOf('${API_TOKEN}') + 2));
		const md = hover!.contents[0] as vscode.MarkdownString;
		assert.deepStrictEqual(md.isTrusted, { enabledCommands: [REVEAL_VARIABLE_COMMAND, SET_MISSING_COMMAND] });
		assert.deepStrictEqual(hover!.range, new vscode.Range(doc.positionAt(doc.getText().indexOf('${API_TOKEN}')), doc.positionAt(doc.getText().indexOf('${API_TOKEN}') + '${API_TOKEN}'.length)));
	});
	// The Bloblang hover needs a schema: the fake binary's, for this test only.
	suite('with a schema', function () {
		const h = useSchemaBinary();

		test('HOVER ENV_CALL: env("ZONE") has the variable hover (missing) beside the Bloblang hover', async function () {
			this.timeout(180_000);
			await schemaFrom(h.fakeBinary, '4.112.0');
			const at = doc.positionAt(doc.getText().indexOf('env("ZONE")') + 1);
			let all = '';
			assert.ok(await waitForAsync(async () => {
				all = await hoverText(doc, at);
				return all.includes('**env** function');
			}, 60_000), `no Bloblang hover on env("ZONE"): ${all}`);
			const text = await envHover('env("ZONE")', 6);
			assert.match(text, /`ZONE`/);
			assert.match(text, /Missing/);
			assert.deepStrictEqual(links(text)[0][2], ['ZONE', doc.uri.toString()]);
		});
	});
	// --- Ticket 38: the License group and Check license, with a fake binary whose `run` prints the
	// license line the real one would for REDPANDA_LICENSE / REDPANDA_LICENSE_FILEPATH / a default file.
	suite('License group (ticket 38)', function () {
		const originalPath = process.env.PATH;
		const originalLicense = { string: process.env.REDPANDA_LICENSE, file: process.env.REDPANDA_LICENSE_FILEPATH };
		let licenseDir: string;
		let argvFile: string;
		let defaultFile: string;
		let fakeBin: string;
		let originalDefault: string;
		let opened: string[];
		const GOOD = 'good-lic-38-value';
		const BAD = 'bad-lic-38-value';
		const licenseRows = () => items().filter((i) => i.group === 'license');
		const licenseRow = (id: string) => licenseRows().find((i) => i.node.kind === 'license' && i.node.id === id);
		const sourceRow = () => licenseRow('license:source')!;
		const stateRow = () => licenseRow('license:state')!;
		const argvLines = () => (fs.existsSync(argvFile) ? fs.readFileSync(argvFile, 'utf8').split('\n').filter(Boolean) : []);
		/** Nothing shown, logged, told or passed on a command line holds a license string. */
		const assertNoValue = (...values: string[]) => {
			const shown = JSON.stringify([items().map((i) => [i.label, i.description, i.accessibility, i.tooltip]), api().outputLines(), errors, infos, argvLines()]);
			for (const value of values) {
				assert.ok(!shown.includes(value), `a license string is shown, logged or passed: ${value}`);
			}
			assert.ok(!argvLines().some((l) => l.includes('--redpanda-license')), 'NO_FLAG');
		};
		const check = () => vscode.commands.executeCommand<{ kind: string }>(CHECK_LICENSE_COMMAND);
		const setEnv = (name: 'REDPANDA_LICENSE' | 'REDPANDA_LICENSE_FILEPATH', value: string | undefined) => {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
			view().refresh();
		};

		suiteSetup(async () => {
			licenseDir = makeTempDir('rpcn-license-');
			argvFile = path.join(licenseDir, 'argv');
			defaultFile = path.join(licenseDir, 'default.license');
			const loaded = `echo 'level=info msg="Successfully loaded Redpanda license" @service=redpanda-connect expires_at="2027-03-09T15:18:26-05:00" license_org=org-38 license_type=enterprise' >&2`;
			const run = [
				`printf '%s\\n' "run $*" >> '${argvFile}'`,
				'if [ -n "$REDPANDA_LICENSE" ]; then',
				'  case "$REDPANDA_LICENSE" in',
				`    good-*) ${loaded} ;;`,
				`    exit-*) echo 'level=error msg="Config lint error" lint="fake lint failure"' >&2; exit 1 ;;`,
				'    *) echo "level=error msg=\\"Failed to read Redpanda License\\" @service=redpanda-connect error=\\"validating license: $REDPANDA_LICENSE is not a license\\"" >&2 ;;',
				'  esac',
				'elif [ -n "$REDPANDA_LICENSE_FILEPATH" ]; then',
				`  if [ -f "$REDPANDA_LICENSE_FILEPATH" ]; then ${loaded}; else echo "level=error msg=\\"Failed to read Redpanda License\\" error=\\"reading license file: open $REDPANDA_LICENSE_FILEPATH: no such file or directory\\"" >&2; fi`,
				`elif [ -f '${defaultFile}' ]; then ${loaded}`,
				'fi',
				'exit 0',
			].join('\n');
			const capture = (what: string) => `printf '%s\\n' "${what} $*" >> '${argvFile}'\nexit 0`;
			delete process.env.REDPANDA_LICENSE;
			delete process.env.REDPANDA_LICENSE_FILEPATH;
			process.env.PATH = (originalPath ?? '').split(path.delimiter)
				.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
				.join(path.delimiter);
			fakeBin = writeFakeBinary(licenseDir, 'redpanda-connect', connectScript({ version: '4.112.0', run, lint: capture('lint'), blobl: capture('blobl') }));
			await config().update('binaryPath', fakeBin, vscode.ConfigurationTarget.Global);
			assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'ok' && (api().redpandaConnect.state as { path: string }).path === fakeBin, 30_000),
				JSON.stringify(api().redpandaConnect.state));
			originalDefault = view().licenseDefaultPath;
		});

		setup(() => {
			opened = [];
			view().licenseDefaultPath = defaultFile;
			view().openExternal = async (uri) => {
				opened.push(uri.toString(true));
				return true;
			};
			fs.rmSync(defaultFile, { force: true });
			view().refresh();
		});

		teardown(() => {
			delete process.env.REDPANDA_LICENSE;
			delete process.env.REDPANDA_LICENSE_FILEPATH;
			view().licenseDefaultPath = originalDefault;
		});

		suiteTeardown(async () => {
			process.env.PATH = originalPath;
			for (const [name, value] of [['REDPANDA_LICENSE', originalLicense.string], ['REDPANDA_LICENSE_FILEPATH', originalLicense.file]] as const) {
				if (value !== undefined) {
					process.env[name] = value;
				}
			}
			await config().update('binaryPath', undefined, vscode.ConfigurationTarget.Global);
			fs.rmSync(licenseDir, { recursive: true, force: true });
		});

		test('NOT_CHECKED / SOURCE_NONE: a License group after the sources: "No license set" opening the README section, and "Not checked" with Check license', async () => {
			const groups = items().filter((i) => i.node.kind === 'group' || i.node.kind === 'licenseGroup').map((i) => i.group);
			assert.deepStrictEqual(groups, ['missing', 'setting', 'envFile', 'secret', 'process', 'license']);
			const group = items().find((i) => i.node.kind === 'licenseGroup')!;
			assert.strictEqual(group.label, 'License');
			assert.strictEqual(group.contextValue, 'group group-license', 'the inline Check license action');
			assert.strictEqual(sourceRow().label, 'No license set');
			assert.match(sourceRow().description, /enterprise connectors need one/);
			assert.match(sourceRow().contextValue, /\blicenseNone\b/);
			assert.strictEqual(sourceRow().command, OPEN_LICENSE_DOCS_COMMAND);
			assert.strictEqual(await vscode.commands.executeCommand(OPEN_LICENSE_DOCS_COMMAND), true);
			assert.deepStrictEqual(opened, ['https://github.com/ajurcenk/rpcn-pipeline-designer#enterprise-license']);
			assert.strictEqual(stateRow().label, 'Not checked');
			assert.strictEqual(stateRow().contextValue, 'licenseState notChecked');
			assert.strictEqual(stateRow().command, CHECK_LICENSE_COMMAND, 'Enter on the row checks');
			// Keyboard and screen reader: the group and rows say what they are.
			assert.strictEqual(group.accessibility, 'License: No license set, Not checked');
			assert.strictEqual(stateRow().accessibility, 'License state: Not checked, press Enter to check the license');
			assert.ok(!groupOf('missing').some((i) => /^REDPANDA_LICENSE/.test(i.label)), 'the license variables are not Missing');
		});

		test('NO_LINE: with no source, the check says no license loaded; NO_FLAG: no --redpanda-license, the temporary config removed', async () => {
			const before = argvLines().length;
			assert.deepStrictEqual(await check(), { kind: 'none' });
			assert.strictEqual(stateRow().label, 'No license loaded');
			const runs = argvLines().slice(before).filter((l) => l.startsWith('run '));
			assert.strictEqual(runs.length, 1, JSON.stringify(argvLines()));
			const target = runs[0].split(' ').pop()!;
			assert.match(path.basename(target), /^license-check-[0-9a-f]+\.yaml$/);
			assert.ok(!fs.existsSync(target), 'the temporary config is removed');
			assert.ok(runs[0].includes(`--env-file ${envFile}`), `the config's env file is passed: ${runs[0]}`);
			assertNoValue();
		});

		test('SOURCE_STRING / LOADED: REDPANDA_LICENSE as a secret: the source row masks it; the check shows type and expiry, no org', async () => {
			assert.ok(await api().secrets!.set(undefined, 'REDPANDA_LICENSE', GOOD));
			assert.ok(await waitFor(() => sourceRow()?.label === 'Source: REDPANDA_LICENSE', 5_000), JSON.stringify(licenseRows().map((i) => i.label)));
			assert.strictEqual(sourceRow().description, 'from a secret · value masked');
			assert.strictEqual(sourceRow().command, undefined);
			assert.deepStrictEqual(await check(), { kind: 'loaded', licenseType: 'enterprise', expiresAt: '2027-03-09T15:18:26-05:00' });
			assert.strictEqual(stateRow().label, 'Loaded: enterprise, expires 2027-03-09');
			assert.strictEqual(items().find((i) => i.node.kind === 'licenseGroup')!.description, 'loaded');
			assert.ok(!JSON.stringify(items()).includes('org-38'), 'the organisation is not shown');
			assertNoValue(GOOD);
		});

		test('FAILED: a bad REDPANDA_LICENSE (VS Code\'s environment, or a secret) shows the binary\'s reason with the string masked', async () => {
			setEnv('REDPANDA_LICENSE', BAD);
			assert.strictEqual(sourceRow().label, 'Source: REDPANDA_LICENSE');
			assert.strictEqual(sourceRow().description, "from VS Code's environment · value masked");
			const result = await check() as { kind: string; reason: string };
			assert.strictEqual(result.kind, 'failed');
			assert.ok(!result.reason.includes(BAD), result.reason);
			assert.match(stateRow().label, /^Not loaded: validating license: •+ is not a license$/);
			assertNoValue(BAD);
			setEnv('REDPANDA_LICENSE', undefined);
			assert.ok(await api().secrets!.set(undefined, 'REDPANDA_LICENSE', BAD));
			assert.ok(await waitFor(() => sourceRow()?.description === 'from a secret · value masked', 5_000));
			assert.strictEqual((await check()).kind, 'failed');
			assert.match(stateRow().label, /^Not loaded: validating license: •+ is not a license$/);
			assertNoValue(BAD);
		});

		test('SOURCE_FILE: REDPANDA_LICENSE_FILEPATH (VS Code\'s environment, or a secret) names its source, the path masked as the view masks it; a missing file fails with the binary\'s reason, an existing one loads', async () => {
			const file = path.join(licenseDir, 'missing.license');
			setEnv('REDPANDA_LICENSE_FILEPATH', file);
			assert.strictEqual(sourceRow().label, 'Source: the file in REDPANDA_LICENSE_FILEPATH');
			assert.strictEqual(sourceRow().description, "from VS Code's environment · path masked");
			assert.strictEqual((await check()).kind, 'failed');
			assert.match(stateRow().label, /^Not loaded: reading license file: open •+: no such file or directory$/);
			assertNoValue(file);
			fs.writeFileSync(file, 'license');
			assert.strictEqual((await check()).kind, 'loaded');
			assert.strictEqual(stateRow().label, 'Loaded: enterprise, expires 2027-03-09');
			fs.rmSync(file);
			setEnv('REDPANDA_LICENSE_FILEPATH', undefined);
			assert.ok(await api().secrets!.set(undefined, 'REDPANDA_LICENSE_FILEPATH', file));
			assert.ok(await waitFor(() => sourceRow()?.description === 'from a secret · path masked', 5_000), JSON.stringify(licenseRows().map((i) => i.description)));
			assert.strictEqual(sourceRow().label, 'Source: the file in REDPANDA_LICENSE_FILEPATH');
			assert.strictEqual((await check()).kind, 'failed');
			assert.match(stateRow().label, /^Not loaded: reading license file: open •+: no such file or directory$/);
			assertNoValue(file);
		});

		test('SOURCE_DEFAULT: neither variable; the default file exists: the source row names it and the check loads it', async () => {
			fs.writeFileSync(defaultFile, 'license');
			view().refresh();
			assert.strictEqual(sourceRow().label, `Source: the default file ${defaultFile}`);
			assert.strictEqual(sourceRow().description, 'no REDPANDA_LICENSE or REDPANDA_LICENSE_FILEPATH is set');
			assert.strictEqual((await check()).kind, 'loaded');
		});

		test('NOT_READ: REDPANDA_LICENSE in redpandaConnect.env or the env file is flagged as not read for the license, its value masked', async () => {
			fs.writeFileSync(envFile, `API_TOKEN=${FILE_VALUE}\nBROKERS=k:9092\nREDPANDA_LICENSE=${GOOD}-file\n`);
			await config().update('env', { TOPIC: 'events', REDPANDA_LICENSE: `${GOOD}-setting` }, vscode.ConfigurationTarget.Global);
			assert.ok(await waitFor(() => licenseRows().filter((i) => i.contextValue === 'licenseNote').length === 2, 15_000), JSON.stringify(licenseRows().map((i) => i.label)));
			assert.deepStrictEqual(licenseRows().filter((i) => i.contextValue === 'licenseNote').map((i) => i.label), [
				'REDPANDA_LICENSE in redpandaConnect.env is not used for the license',
				'REDPANDA_LICENSE in the env file is not used for the license',
			]);
			assert.strictEqual(sourceRow().label, 'No license set', 'the binary does not read them for the license');
			assert.deepStrictEqual(await check(), { kind: 'none' });
			// REDPANDA_LICENSE is masked in every group, the plain setting's row too, and in the hover.
			assert.ok(row('setting', 'REDPANDA_LICENSE')!.description.startsWith(VIEW_MASK), row('setting', 'REDPANDA_LICENSE')!.description);
			assert.match(row('setting', 'REDPANDA_LICENSE')!.accessibility, /value masked$/);
			assert.ok(row('setting', 'TOPIC')!.description.startsWith('events'), 'other plain values stay in clear');
			assertNoValue(`${GOOD}-file`, `${GOOD}-setting`);
			const hover = envHoverMarkdown(view().modelFor(doc.uri), doc.uri, 'REDPANDA_LICENSE', undefined).value;
			assert.ok(hover.includes(`\`${VIEW_MASK}\` from ${SETTING_LABEL}`), hover);
			assert.ok(!hover.includes(GOOD), hover);
			assert.strictEqual(links(hover)[0][0], 'Show value');
			// Show value still reveals it on request.
			await vscode.commands.executeCommand(SHOW_VALUE_COMMAND, row('setting', 'REDPANDA_LICENSE')!.node);
			assert.ok(row('setting', 'REDPANDA_LICENSE')!.description.startsWith(`${GOOD}-setting`));
		});

		test('KEPT: a config\'s last result stays through refreshes and another config shown, until its next check', async () => {
			assert.ok(await api().secrets!.set(undefined, 'REDPANDA_LICENSE', GOOD));
			assert.strictEqual((await check()).kind, 'loaded');
			view().refresh();
			assert.strictEqual(stateRow().label, 'Loaded: enterprise, expires 2027-03-09');
			const other = path.join(dir, 'license-other.yaml');
			fs.writeFileSync(other, 'input:\n  stdin: {}\noutput:\n  stdout: {}\n');
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(other), { preview: false });
			assert.ok(await waitFor(() => view().configUri?.fsPath === other, 10_000));
			assert.strictEqual(stateRow().label, 'Not checked', 'the other config has its own state');
			await vscode.window.showTextDocument(doc, { preview: false });
			assert.ok(await waitFor(() => view().configUri?.toString() === doc.uri.toString(), 10_000));
			assert.strictEqual(stateRow().label, 'Loaded: enterprise, expires 2027-03-09');
			assert.strictEqual(view().licenseState(doc.uri).kind, 'loaded');
		});

		test('CHECK_FAILS: a run that fails without a license line, and no binary, show the reason in the group', async () => {
			setEnv('REDPANDA_LICENSE', 'exit-38-value');
			assert.strictEqual((await check()).kind, 'error');
			assert.strictEqual(stateRow().label, 'Check failed: The check run failed (exit 1): Config lint error: fake lint failure');
			assertNoValue('exit-38-value');
			await config().update('binaryPath', path.join(licenseDir, 'nope'), vscode.ConfigurationTarget.Global);
			assert.ok(await waitFor(() => api().redpandaConnect.state.kind !== 'ok', 30_000));
			const before = argvLines().length;
			assert.strictEqual((await check()).kind, 'error');
			assert.strictEqual(stateRow().label, 'Check failed: No Redpanda Connect binary was found.');
			assert.strictEqual(argvLines().length, before, 'nothing ran');
			await config().update('binaryPath', fakeBin, vscode.ConfigurationTarget.Global);
			assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'ok', 30_000));
		});
	});
});
