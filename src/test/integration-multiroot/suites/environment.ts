// The Environment view in a real multi-root workspace (ticket 31): a config in folder B shows B's
// sources (its folder `env`, its relative `envFile`, its secrets), a missing variable set as plain
// goes to B's folder settings, and the same config in folder A shows none of B's. The configs and the
// env file are written into the fixture folders for the suite and removed after; settings are reset.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { type EnvironmentItem, type EnvironmentUi, REMOVE_NAME_COMMAND, SET_MISSING_COMMAND } from '../../../adapters/vscode/environmentView';
import { type ExtensionApi } from '../../../extension';
import { REPO_ROOT } from '../../helpers/fakeBinary';
import { EXTENSION_ID, waitFor } from '../../integration/helpers';

type FolderName = 'a' | 'b';
const FIXTURE = path.join(REPO_ROOT, 'test', 'multiroot');
const WORKSPACE_FILE = path.join(FIXTURE, 'multiroot.code-workspace');
const CONFIG_NAME = 'env-31.yaml';
const ENV_NAME = '.env-31';
const CONFIG = [
	'input:',
	'  generate:',
	'    interval: 1s',
	'    mapping: \'root = [ "${TOPIC}", "${API_TOKEN}", "${BROKERS}", "${HOME}", "${REGION}" ]\'',
	'output:',
	'  stdout: {}',
	'',
].join('\n');

suite('Environment view in a multi-root workspace (integration, ticket 31)', function () {
	this.timeout(60_000);
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const view = () => api().environment!;
	const folder = (name: FolderName) => vscode.workspace.workspaceFolders!.find((f) => f.name === name)!;
	const settings = (name: FolderName) => vscode.workspace.getConfiguration('redpandaConnect', folder(name).uri);
	const row = (group: EnvironmentItem['group'], name: string) => view().items().find((i) => i.group === group && i.node.kind === 'variable' && i.label === name);
	const state = (i: EnvironmentItem | undefined) => (i?.node.kind === 'variable' ? i.node.variable : undefined);
	let originalUi: EnvironmentUi;

	async function show(name: FolderName): Promise<vscode.TextDocument> {
		const doc = await vscode.workspace.openTextDocument(path.join(FIXTURE, name, CONFIG_NAME));
		await vscode.window.showTextDocument(doc, { preview: false });
		assert.ok(await waitFor(() => view().configUri?.toString() === doc.uri.toString(), 10_000), `the view does not show ${name}/${CONFIG_NAME}`);
		return doc;
	}

	suiteSetup(async () => {
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
		for (const name of ['a', 'b']) {
			fs.writeFileSync(path.join(FIXTURE, name, CONFIG_NAME), CONFIG);
		}
		fs.writeFileSync(path.join(FIXTURE, 'b', ENV_NAME), 'API_TOKEN=tok-31-file\nBROKERS=k:9092\n');
		originalUi = view().ui;
	});

	suiteTeardown(async () => {
		view().ui = originalUi;
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		for (const name of ['a', 'b'] as const) {
			await settings(name).update('env', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
			await settings(name).update('envFile', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
			await settings(name).update('secretEnv', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
			fs.rmSync(path.join(FIXTURE, name, CONFIG_NAME), { force: true });
			fs.rmSync(path.join(FIXTURE, name, '.vscode'), { recursive: true, force: true });
		}
		fs.rmSync(path.join(FIXTURE, 'b', ENV_NAME), { force: true });
		await api().secrets!.clear(async () => true);
	});

	test('SOURCES: folder B\'s config shows B\'s env, env file and secrets; a plain variable set there goes to B\'s folder settings; A\'s config shows none of them', async () => {
		await settings('b').update('env', { TOPIC: 'b-topic' }, vscode.ConfigurationTarget.WorkspaceFolder);
		await settings('b').update('envFile', ENV_NAME, vscode.ConfigurationTarget.WorkspaceFolder);
		assert.ok(await api().secrets!.set(folder('b'), 'API_TOKEN', 'tok-31-secret-b'));
		await show('b');
		assert.ok(await waitFor(() => state(row('secret', 'API_TOKEN'))?.state === 'overridden', 10_000), JSON.stringify(view().items().map((i) => i.label)));
		assert.deepStrictEqual(state(row('setting', 'TOPIC')), { name: 'TOPIC', value: 'b-topic', level: 'folder', source: 'setting', state: 'used', referenced: true });
		assert.strictEqual(state(row('envFile', 'API_TOKEN'))?.state, 'used');
		assert.strictEqual(state(row('envFile', 'BROKERS'))?.state, 'used');
		assert.strictEqual(state(row('process', 'HOME'))?.state, 'used');
		assert.strictEqual(view().model()?.envFilePath, path.join(folder('b').uri.fsPath, ENV_NAME));
		assert.deepStrictEqual(view().model()?.missing, ['REGION']);
		// Ticket 34: the hover names the folder settings level.
		const doc = vscode.window.activeTextEditor!.document;
		const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri,
			doc.positionAt(doc.getText().indexOf('${TOPIC}') + 2));
		const texts = hovers.flatMap((h) => h.contents).map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : ''));
		assert.ok(texts.some((t) => t.includes('`b-topic` from **Settings (redpandaConnect.env)** (folder settings)')), JSON.stringify(texts));

		view().ui = { pickKind: async () => 'plain', pickRemoval: async () => 'value', input: async () => 'eu-b', error: (m) => assert.fail(m), info: () => undefined };
		assert.strictEqual(await vscode.commands.executeCommand(SET_MISSING_COMMAND, 'REGION'), 'REGION');
		const inspected = settings('b').inspect('env');
		assert.deepStrictEqual(inspected?.workspaceFolderValue, { TOPIC: 'b-topic', REGION: 'eu-b' });
		assert.strictEqual(inspected?.workspaceValue, undefined);
		assert.strictEqual(inspected?.globalValue, undefined);
		assert.ok(await waitFor(() => state(row('setting', 'REGION'))?.level === 'folder', 5_000));

		await show('a');
		assert.ok(await waitFor(() => view().model()?.missing.join() === 'TOPIC,API_TOKEN,BROKERS,REGION', 5_000), JSON.stringify(view().model()));
		assert.strictEqual(view().model()?.envFilePath, undefined);
		assert.ok(!view().items().some((i) => i.node.kind === 'variable' && i.group !== 'process'), 'none of B\'s variables');
	});

	test('ticket 39 STILL_DECLARED: Remove name on B\'s own list says the workspace list now applies to B; on A, without its own list, that the list is shared', async () => {
		const workspaceText = fs.readFileSync(WORKSPACE_FILE, 'utf8');
		const infos: string[] = [];
		view().ui = { pickKind: async () => undefined, pickRemoval: async () => undefined, input: async () => undefined, error: (m) => assert.fail(m), info: (m) => infos.push(m) };
		try {
			await settings('a').update('secretEnv', ['VIEW_39', 'OTHER_39'], vscode.ConfigurationTarget.Workspace);
			await settings('b').update('secretEnv', ['VIEW_39'], vscode.ConfigurationTarget.WorkspaceFolder);
			await show('b');
			assert.ok(await waitFor(() => row('secret', 'VIEW_39') !== undefined && row('secret', 'OTHER_39') === undefined, 5_000), JSON.stringify(view().items().map((i) => i.label)));
			assert.strictEqual(await vscode.commands.executeCommand(REMOVE_NAME_COMMAND, row('secret', 'VIEW_39')!.node), true);
			assert.strictEqual(settings('b').inspect('secretEnv')?.workspaceFolderValue, undefined, 'B\'s emptied list is removed');
			assert.deepStrictEqual(infos, [`VIEW_39 is removed from redpandaConnect.secretEnv in the folder settings (${path.join(folder('b').uri.fsPath, '.vscode', 'settings.json')}). `
				+ `It is still declared in the workspace settings (${WORKSPACE_FILE}), whose list now applies to this folder.`]);
			assert.ok(await waitFor(() => row('secret', 'VIEW_39') !== undefined && row('secret', 'OTHER_39') !== undefined, 5_000), 'the workspace list\'s names show for B');

			infos.length = 0;
			await show('a');
			assert.ok(await waitFor(() => row('secret', 'OTHER_39') !== undefined, 5_000));
			assert.strictEqual(await vscode.commands.executeCommand(REMOVE_NAME_COMMAND, row('secret', 'OTHER_39')!.node), true);
			assert.deepStrictEqual(settings('a').inspect('secretEnv')?.workspaceValue, ['VIEW_39']);
			assert.deepStrictEqual(infos, [`OTHER_39 is removed from redpandaConnect.secretEnv in the workspace settings (${WORKSPACE_FILE}), also used by the other folders' configs.`]);
		} finally {
			view().ui = originalUi;
			await settings('a').update('secretEnv', undefined, vscode.ConfigurationTarget.Workspace);
			await settings('b').update('secretEnv', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
			if (fs.readFileSync(WORKSPACE_FILE, 'utf8') !== workspaceText) {
				fs.writeFileSync(WORKSPACE_FILE, workspaceText);
			}
		}
	});
});
