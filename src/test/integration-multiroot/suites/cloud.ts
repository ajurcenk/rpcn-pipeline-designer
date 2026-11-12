// Deploy's file names in a real multi-root workspace (bug 47): folders `a` and `b` of
// `test/multiroot/multiroot.code-workspace` each hold `orders-47.yaml`. Each deployed is tagged
// `<folder name>/<path>`, and the row's file, Compare, Deploy again and Deploy's tagged offer resolve
// each to its own folder's file (MULTI_ROOT); an old tag with no folder that names a file in both is
// never resolved alone (OLD_TAG_TWO); an old tag naming one file resolves to it (OLD_TAG_ONE). Against
// the local fake Cloud, as `integration/suites/96-cloud.ts`; the configs and mappings are written into
// the fixture folders for the suite and removed after.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_TAG } from '../../../adapters/cloud/dataPlane';
import {
	type CloudItem, type CloudUi, type CloudView, COMPARE_COMMAND, CONNECT_COMMAND, DEPLOY_AGAIN_COMMAND, DEPLOY_COMMAND, DEPLOYED_SCHEME, IN_SEVERAL_FOLDERS,
} from '../../../adapters/vscode/cloudView';
import type { LintResult } from '../../../adapters/redpandaConnect/lint';
import { type ExtensionApi } from '../../../extension';
import { REPO_ROOT } from '../../helpers/fakeBinary';
import { FakeCloud, type FakePipeline } from '../../helpers/fakeCloud';
import { EXTENSION_ID, waitFor } from '../../integration/helpers';

const FIXTURE = path.join(REPO_ROOT, 'test', 'multiroot');
const NAME = 'orders-47.yaml';
const ONLY_A = 'only-a-47.yaml';
const CLIENT_ID = 'fake-client-id-47';
const CLIENT_SECRET = 'fake-client-secret-47-Mk2';
const VILNIUS = 'cvilnius0000000000aa';
const CONFIG = [
	'input:',
	'  generate:',
	'    interval: 5s',
	'    mapping: |',
	'      root.n = 1',
	'output:',
	'  drop: {}',
	'',
].join('\n');

suite('Cloud deploy names in a multi-root workspace (integration, bug 47)', function () {
	this.timeout(60_000);
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const cloud = () => api().cloud!;
	const file = (folder: 'a' | 'b', name = NAME) => path.join(FIXTURE, folder, name);
	const mappingOf = (config: string) => `${config}.cloud.json`;
	const written = [file('a'), file('b'), file('a', ONLY_A)];
	let fake: FakeCloud;
	let originalUi: CloudUi;
	let originalLint: CloudView['lint'];
	let originalLocalVersion: CloudView['localVersion'];
	let originalLocalCatalogue: CloudView['localCatalogue'];
	const infos: string[] = [];
	const errors: string[] = [];
	let inputs: (string | undefined)[] = [];
	let picks: (string | undefined)[] = [];
	let confirms: (string | undefined)[] = [];
	let confirmed: { message: string; actions: string[] }[] = [];
	let choices: (string | undefined)[] = [];
	let questions: { question: string; choices: string[] }[] = [];
	let asked = 0;
	let firstRequest = 0;

	function script(next: { inputs?: (string | undefined)[]; picks?: (string | undefined)[]; confirms?: (string | undefined)[]; choices?: (string | undefined)[] }): void {
		inputs = next.inputs ?? [];
		picks = next.picks ?? [];
		confirms = next.confirms ?? [];
		choices = next.choices ?? [];
		confirmed = [];
		questions = [];
		asked = 0;
	}
	const vilnius = () => fake.cluster(VILNIUS);
	const rows = () => cloud().items().filter((i) => i.node.kind === 'pipeline');
	const row = (name: string) => rows().find((i) => i.label === name);
	const run = (command: string, node?: CloudItem['node']) => vscode.commands.executeCommand<{ kind: string; pipelineId?: string }>(command, node);
	const creates = () => fake.requests.slice(firstRequest).filter((r) => r.method === 'POST' && r.url.endsWith('/v1/redpanda-connect/pipelines'));
	const puts = () => fake.requests.slice(firstRequest).filter((r) => r.method === 'PUT');
	const diffTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs)
		.filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.original.scheme === DEPLOYED_SCHEME);
	/** Bug 48: Compare's right side is the file as it would be sent (read-only), so the file is known by its text. */
	async function comparedText(): Promise<string> {
		const modified = (diffTabs()[0].input as vscode.TabInputTextDiff).modified;
		assert.strictEqual(modified.scheme, DEPLOYED_SCHEME);
		return (await vscode.workspace.openTextDocument(modified)).getText();
	}
	/** Marks each config with a last line of its own, so Compare shows which it read. */
	function markFiles(...configs: string[]): void {
		for (const f of configs) {
			fs.writeFileSync(f, `${CONFIG}# ${f}\n`);
		}
	}

	async function open(config: string): Promise<vscode.TextDocument> {
		const doc = await vscode.workspace.openTextDocument(config);
		await vscode.window.showTextDocument(doc, { preview: false });
		assert.ok(await waitFor(() => api().detection.isDetected(doc.uri), 10_000), `${config} is not detected`);
		return doc;
	}

	/** Deploys `config` as a new pipeline `name` on rpc-vilnius (no tagged offer expected); its id. */
	async function deployNew(config: string, name: string): Promise<string> {
		const doc = await open(config);
		script({ picks: ['rpc-vilnius'], inputs: [name] });
		const result = await vscode.commands.executeCommand<{ kind: string; pipelineId?: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'final', errors.join('\n'));
		assert.strictEqual(confirmed.length, 0, `no tagged offer for ${config}: ${confirmed.map((c) => c.message).join('\n')}`);
		return result!.pipelineId!;
	}

	function seed(id: string, name: string, tag: string): FakePipeline {
		const p: FakePipeline = {
			id, display_name: name, description: '', config_yaml: CONFIG, resources: { cpu_shares: '100m', memory_shares: '400M' },
			tags: { [CONFIG_TAG]: tag }, state: 'STATE_STOPPED', sequence: [],
		};
		vilnius().pipelines.push(p);
		return p;
	}

	suiteSetup(async () => {
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
		assert.deepStrictEqual(vscode.workspace.workspaceFolders?.map((f) => f.name), ['a', 'b'], 'the run opens test/multiroot/multiroot.code-workspace');
		fake = new FakeCloud({
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
			clientName: 'deploy-bot',
			clusters: [{ id: VILNIUS, name: 'rpc-vilnius', type: 'TYPE_DEDICATED', cloudProvider: 'CLOUD_PROVIDER_AWS', region: 'us-east-2', connectVersion: '4.115.0', pipelines: [] }],
		});
		await fake.start();
		// An aborted run may have left them (`.gitignore` lists them): start clean.
		for (const f of written) {
			fs.rmSync(mappingOf(f), { force: true });
			fs.writeFileSync(f, CONFIG);
		}
		originalUi = cloud().ui;
		originalLint = cloud().lint;
		originalLocalVersion = cloud().localVersion;
		originalLocalCatalogue = cloud().localCatalogue;
		cloud().endpoints = { authUrl: fake.url, controlPlaneUrl: fake.url, requireHttps: false };
		cloud().pollMs = 20;
		cloud().timeoutMs = 10_000;
		cloud().lint = async (): Promise<LintResult> => ({ kind: 'findings', findings: [], logLines: [] });
		cloud().localVersion = () => undefined;
		cloud().localCatalogue = () => undefined;
		cloud().ui = {
			input: async () => {
				asked++;
				return inputs.shift();
			},
			pickCluster: async (clusters) => {
				const name = picks.shift();
				return clusters.find((c) => c.name === name);
			},
			pickPipeline: async () => undefined,
			pickUnits: async (_title, current) => current ?? { cpu_shares: '100m', memory_shares: '400M' },
			pickChoice: async (_title, question, offered) => {
				questions.push({ question, choices: [...offered] });
				return choices.shift();
			},
			error: async (m) => {
				errors.push(m);
				return undefined;
			},
			info: async (m) => {
				infos.push(m);
				return undefined;
			},
			confirm: async (m, ...offered) => {
				confirmed.push({ message: m, actions: offered });
				return confirms.shift();
			},
			progress: async (_title, task) => task(() => undefined),
		};
		script({ inputs: [CLIENT_ID, CLIENT_SECRET] });
		assert.strictEqual(await vscode.commands.executeCommand(CONNECT_COMMAND), true, errors.join('\n'));
	});

	setup(() => {
		infos.length = 0;
		errors.length = 0;
		fake.createSequence = [{ state: 'STATE_STARTING' }, { state: 'STATE_RUNNING' }];
		vilnius().pipelines = [];
		for (const f of written) {
			fs.rmSync(mappingOf(f), { force: true });
		}
		firstRequest = fake.requests.length;
		script({});
	});

	teardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	suiteTeardown(async () => {
		await cloud().disconnect();
		cloud().ui = originalUi;
		cloud().lint = originalLint;
		cloud().localVersion = originalLocalVersion;
		cloud().localCatalogue = originalLocalCatalogue;
		await fake?.stop();
		for (const f of written) {
			fs.rmSync(f, { force: true });
			fs.rmSync(mappingOf(f), { force: true });
		}
	});

	test('MULTI_ROOT: a/orders-47.yaml and b/orders-47.yaml each deployed are tagged <folder name>/<path>; the row\'s file, Compare, Deploy again and the tagged offer each resolve to its own folder\'s file', async () => {
		const aId = await deployNew(file('a'), 'orders-a');
		const bId = await deployNew(file('b'), 'orders-b');
		assert.deepStrictEqual(creates().map((r) => (JSON.parse(r.body) as { tags: Record<string, string> }).tags), [{ [CONFIG_TAG]: `a/${NAME}` }, { [CONFIG_TAG]: `b/${NAME}` }]);
		assert.ok(creates().every((r) => !r.body.includes(FIXTURE)), 'no local path sent');
		assert.strictEqual(JSON.parse(fs.readFileSync(mappingOf(file('a')), 'utf8')).pipelineId, aId);
		assert.strictEqual(JSON.parse(fs.readFileSync(mappingOf(file('b')), 'utf8')).pipelineId, bId);

		// The row's file: each its own.
		assert.strictEqual(row('orders-a')!.description, `Running · ${NAME}`);
		assert.ok(row('orders-a')!.tooltip.includes(`Deployed from ${file('a')}.`), row('orders-a')!.tooltip);
		assert.ok(row('orders-b')!.tooltip.includes(`Deployed from ${file('b')}.`), row('orders-b')!.tooltip);

		// Compare: b's row diffs b's file, with no question.
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		markFiles(file('a'), file('b'));
		assert.strictEqual((await run(COMPARE_COMMAND, row('orders-b')!.node))?.kind, 'opened', errors.join('\n'));
		assert.strictEqual(questions.length, 0);
		assert.strictEqual(await comparedText(), fs.readFileSync(file('b'), 'utf8'));
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');

		// Deploy again: a's row updates a's pipeline from a's file.
		fs.writeFileSync(file('a'), CONFIG.replace('root.n = 1', 'root.n = 2'));
		const p = vilnius().pipelines.find((x) => x.id === aId)!;
		p.state = 'STATE_STOPPED';
		p.sequence = [];
		const again = await run(DEPLOY_AGAIN_COMMAND, row('orders-a')!.node);
		assert.strictEqual(again?.kind, 'final', errors.join('\n'));
		assert.strictEqual(again?.pipelineId, aId);
		assert.deepStrictEqual(puts().map((r) => r.url), [`/dp/${VILNIUS}/v1/redpanda-connect/pipelines/${aId}`]);
		assert.strictEqual((JSON.parse(puts()[0].body) as { tags: Record<string, string> }).tags[CONFIG_TAG], `a/${NAME}`);

		// The tagged offer: b's file with no mapping is offered b's pipeline only.
		fs.rmSync(mappingOf(file('b')));
		const doc = await open(file('b'));
		script({ picks: ['rpc-vilnius'], confirms: [undefined] });
		assert.strictEqual((await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri))?.kind, 'notStarted');
		assert.strictEqual(confirmed.length, 1);
		assert.deepStrictEqual(confirmed[0].actions, ['Update orders-b', 'Create new']);
		assert.ok(confirmed[0].message.includes(`deployed from b/${NAME}: orders-b`), confirmed[0].message);
	});

	test('OLD_TAG_TWO: an old tag with no folder naming a file in both folders: the row says so; Compare and Deploy again ask which; the tagged offer is not made for it', async () => {
		seed('p00000000000000old47', 'old-two', NAME);
		await cloud().refresh({ kind: 'cluster', id: VILNIUS });
		const old = row('old-two')!;
		assert.strictEqual(old.description, `Stopped · ${IN_SEVERAL_FOLDERS}`);
		assert.ok(old.tooltip.includes(`Deployed from ${NAME}, which is ${IN_SEVERAL_FOLDERS}: ${file('a')}, ${file('b')}.`), old.tooltip);
		assert.ok(old.contextValue.includes(' hasFile'), 'Deploy again is offered (it asks which)');

		// Compare: asked; Escape opens nothing; b chosen: b's file.
		script({ choices: [undefined] });
		const before = fake.requests.length;
		assert.strictEqual((await run(COMPARE_COMMAND, old.node))?.kind, 'notStarted');
		assert.deepStrictEqual(questions.map((q) => q.choices), [[`a/${NAME}`, `b/${NAME}`]]);
		assert.ok(questions[0].question.includes(IN_SEVERAL_FOLDERS), questions[0].question);
		assert.strictEqual(fake.requests.length, before, 'nothing requested');
		assert.strictEqual(diffTabs().length, 0);
		markFiles(file('a'), file('b'));
		script({ choices: [`b/${NAME}`] });
		assert.strictEqual((await run(COMPARE_COMMAND, old.node))?.kind, 'opened', errors.join('\n'));
		assert.strictEqual(await comparedText(), fs.readFileSync(file('b'), 'utf8'));
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');

		// Deploy again: asked; Escape sends nothing; a chosen with no mapping: explained, nothing sent.
		script({ choices: [undefined] });
		assert.strictEqual((await run(DEPLOY_AGAIN_COMMAND, old.node))?.kind, 'notStarted');
		assert.strictEqual(questions.length, 1);
		script({ choices: [`a/${NAME}`] });
		assert.strictEqual((await run(DEPLOY_AGAIN_COMMAND, old.node))?.kind, 'notMapped');
		assert.deepStrictEqual(infos.slice(-1), [`${NAME} has no ${NAME}.cloud.json, so a Deploy of it would not update old-two. Deploy ${NAME} from its editor to choose where it goes. Nothing was sent.`]);
		assert.strictEqual(puts().length + creates().length, 0, 'nothing sent');

		// Deploy of a's file with no mapping: the old-tagged pipeline is not offered; a new one is named.
		await deployNew(file('a'), 'orders-a');
		assert.strictEqual(asked, 1, 'the name asked');
	});

	test('OLD_TAG_ONE: an old tag naming a file in one folder only resolves to it, as before', async () => {
		seed('p00000000000000one47', 'old-one', ONLY_A);
		await cloud().refresh({ kind: 'cluster', id: VILNIUS });
		assert.strictEqual(row('old-one')!.description, `Stopped · ${ONLY_A}`);
		assert.ok(row('old-one')!.tooltip.includes(`Deployed from ${file('a', ONLY_A)}.`), row('old-one')!.tooltip);
		markFiles(file('a', ONLY_A));
		assert.strictEqual((await run(COMPARE_COMMAND, row('old-one')!.node))?.kind, 'opened', errors.join('\n'));
		assert.strictEqual(questions.length, 0);
		assert.strictEqual(await comparedText(), fs.readFileSync(file('a', ONLY_A), 'utf8'));
		// Deploy's tagged offer: made for a's file.
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		const doc = await open(file('a', ONLY_A));
		script({ picks: ['rpc-vilnius'], confirms: [undefined] });
		assert.strictEqual((await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri))?.kind, 'notStarted');
		assert.deepStrictEqual(confirmed[0]?.actions, ['Update old-one', 'Create new']);
	});
});
