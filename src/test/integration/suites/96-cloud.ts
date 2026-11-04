// The Cloud view and Deploy (ticket 5.2, AD-23), end to end in the stable run against a local fake
// of the auth, Control Plane and Data Plane APIs (`helpers/fakeCloud.ts`). The view is read through
// the test seam (`api().cloud.items()`), its prompts replaced by a script of answers, the three
// hosts' base URLs pointed at the fake, and the deploy's poll interval shortened. Every request the
// fake received, every message, output line and view item is checked for the client secret and the
// tokens at the end (NO_LEAK). Ticket 5.3's update flow (the mapping beside the config, `PUT`, the
// diff and confirmation, the compute-unit setting) is the second half; ticket 5.4's Start, Stop and
// Delete pipeline… (rows, palette, the mapping deleted with its pipeline) the third; ticket 5.6's translation
// of variables into secrets (what the fake receives, the refusals, UNCHANGED and the diff) the fourth;
// ticket 5.5's row file, Open deployed config (the row's click), Compare, Deploy again and Copy pipeline
// ID the fifth (the stable run opens no folder, so those tests point the view's workspace folders at
// the temporary directory).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	CloudView, CLIENT_ID_KEY, CLIENT_SECRET_KEY, NOT_READ_TEXT, CONNECT_ACTION, CONNECT_COMMAND, DEPLOY_COMMAND, DEPLOY_UNTITLED_MESSAGE, DISCONNECT_COMMAND, type CloudItem, type CloudUi,
	CLOUD_REFRESH_COMMAND, DETAILS_UNREAD, NO_PIPELINE_API, NO_REASON, NOT_CONNECTED_MESSAGE,
	CREATE_NEW_ACTION, CREATE_NEW_PIPELINE_ACTION, DEPLOY_AS_NEW_ACTION, DEPLOYED_SCHEME, REPLACE_ACTION,
	DELETE_ACTION, DELETE_COMMAND, START_COMMAND, STOP_COMMAND, type PipelineChoice,
	COMPARE_COMMAND, COPY_ID_COMMAND, DEPLOY_AGAIN_COMMAND, NOT_IN_WORKSPACE, OPEN_DEPLOYED_COMMAND,
} from '../../../adapters/vscode/cloudView';
import type { CloudCluster } from '../../../adapters/cloud/controlPlane';
import { CONFIG_TAG, type PipelineResources, resourcesOf } from '../../../adapters/cloud/dataPlane';
import { type ExtensionApi } from '../../../extension';
import { FAKE_LINT_MARKER, FakeCloud, type FakePipeline } from '../../helpers/fakeCloud';
import { makeTempDir } from '../../helpers/fakeBinary';
import { EXTENSION_ID, waitFor } from '../helpers';

const CLIENT_ID = 'fake-client-id-5-2';
const CLIENT_SECRET = 'fake-client-secret-5-2-Qx7';
const WRONG_SECRET = 'wrong-secret-5-2-Zr9';
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

type Input = string | undefined | ((o: vscode.InputBoxOptions) => string | undefined);

suite('Cloud view and Deploy (integration, ticket 5.2)', function () {
	this.timeout(60_000);
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const cloud = () => api().cloud!;
	let fake: FakeCloud;
	let dir: string;
	let configFile: string;
	let originalUi: CloudUi;
	let originalFolders: () => readonly string[];
	const errors: string[] = [];
	/** The actions each error offered. */
	const errorActions: string[][] = [];
	const infos: string[] = [];
	const progressTitles: string[] = [];
	const progressReports: string[] = [];
	/** Every item shown, every input box's options, for NO_LEAK. */
	const seenItems: CloudItem[] = [];
	/** Every message of the suite (`errors` and `infos` are per test). */
	const allMessages: string[] = [];
	let inputs: Input[] = [];
	let asked: vscode.InputBoxOptions[] = [];
	let picks: (string | undefined)[] = [];
	let pickedFrom: CloudCluster[][] = [];
	let actions: (string | undefined)[] = [];
	let confirms: (string | undefined)[] = [];
	/** Each modal question with its actions. */
	let confirmed: { message: string; actions: string[] }[] = [];
	/** The size picks, in order: a number of units, or `undefined` (Escape); none left: the pre-set size is accepted. */
	let units: (number | undefined)[] = [];
	let unitsAsked = 0;
	/** Run while the size pick is open (ticket 5.6: an edit made during the prompts). */
	let duringUnits: (() => Promise<void>) | undefined;
	/** The size each pick was pre-set to (`undefined`: a new pipeline, pre-set to 1 unit). */
	let unitsPresets: (PipelineResources | undefined)[] = [];
	/** The palette's pipeline picks (by name), and what each offered. */
	let pipelinePicks: (string | undefined)[] = [];
	let pipelinesOffered: PipelineChoice[][] = [];

	/**
	 * VS Code's secret storage resolves a delete before its application storage has settled it, and
	 * a store of the same key within some tens of milliseconds can be undone by it (the account then
	 * reads as gone mid-test). A user cannot disconnect and connect again that fast; the tests wait.
	 */
	const settleSecrets = () => new Promise<void>((r) => setTimeout(r, 300));

	const items = () => {
		const now = cloud().items();
		seenItems.push(...now);
		return now;
	};
	const labels = () => items().map((i) => i.label);
	const clusterItem = (name: string) => items().find((i) => i.node.kind === 'cluster' && i.label === name);
	const tokenRequests = () => fake.requestsTo('/oauth/token').length;

	function script(next: {
		inputs?: Input[]; picks?: (string | undefined)[]; actions?: (string | undefined)[]; confirms?: (string | undefined)[]; units?: (number | undefined)[];
		pipelinePicks?: (string | undefined)[];
	}): void {
		pipelinePicks = next.pipelinePicks ?? [];
		pipelinesOffered = [];
		inputs = next.inputs ?? [];
		picks = next.picks ?? [];
		actions = next.actions ?? [];
		confirms = next.confirms ?? [];
		confirmed = [];
		units = next.units ?? [];
		unitsAsked = 0;
		duringUnits = undefined;
		unitsPresets = [];
		asked = [];
		pickedFrom = [];
	}

	async function connect(): Promise<void> {
		script({ inputs: [CLIENT_ID, CLIENT_SECRET] });
		assert.strictEqual(await vscode.commands.executeCommand(CONNECT_COMMAND), true, errors.join('\n'));
	}

	async function openConfig(file: string, text = CONFIG): Promise<vscode.TextDocument> {
		fs.writeFileSync(file, text);
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc, { preview: false });
		assert.ok(await waitFor(() => api().detection.isDetected(doc.uri), 10_000), `${file} is not detected`);
		return doc;
	}

	const sidecarFile = () => path.join(dir, 'orders.cloud.json');
	/** The fake's requests since this test began. */
	let firstRequest = 0;
	const puts = () => fake.requests.slice(firstRequest).filter((r) => r.method === 'PUT');
	const posts = () => fake.requests.slice(firstRequest).filter((r) => r.method === 'POST' && r.url.endsWith('/v1/redpanda-connect/pipelines'));
	const diffTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs)
		.filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.original.scheme === DEPLOYED_SCHEME);

	/** Replaces the document's text in the editor (unsaved: the deploy saves it). */
	async function editConfig(doc: vscode.TextDocument, text: string): Promise<void> {
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
		assert.ok(await vscode.workspace.applyEdit(edit));
	}

	/** Connects and deploys `orders.yaml` once as `orders` on rpc-vilnius (running); its pipeline id. */
	async function deployOnce(text = CONFIG): Promise<{ doc: vscode.TextDocument; id: string }> {
		await connect();
		const doc = await openConfig(configFile, text);
		script({ picks: ['rpc-vilnius'], inputs: ['orders'] });
		const result = await vscode.commands.executeCommand<{ kind: string; pipelineId?: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'final', errors.join('\n'));
		assert.ok(fs.existsSync(sidecarFile()));
		return { doc, id: result!.pipelineId! };
	}

	const lastCreate = () => {
		const posts = fake.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/v1/redpanda-connect/pipelines'));
		return posts.length > 0 ? JSON.parse(posts[posts.length - 1].body) as Record<string, unknown> : undefined;
	};

	suiteSetup(async () => {
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
		fake = new FakeCloud({
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
			clientName: 'deploy-bot',
			clusters: [
				{ id: 'cvilnius0000000000aa', name: 'rpc-vilnius', type: 'TYPE_DEDICATED', cloudProvider: 'CLOUD_PROVIDER_AWS', region: 'us-east-2', connectVersion: '4.115.0', pipelines: [] },
				{ id: 'cbyoc000000000000bbb', name: 'byoc-eu', type: 'TYPE_BYOC', cloudProvider: 'CLOUD_PROVIDER_GCP', region: 'europe-west1', connectVersion: '4.116.0', pipelines: [] },
				{ id: 'cnodp000000000000ccc', name: 'no-dp', type: 'TYPE_DEDICATED', cloudProvider: 'CLOUD_PROVIDER_AWS', region: 'us-west-2', dataplane: false, pipelines: [] },
				{ id: 'cserverless000000ddd', name: 'serverless-one', type: 'TYPE_SERVERLESS', cloudProvider: 'CLOUD_PROVIDER_AWS', region: 'us-east-1', pipelines: [] },
			],
		});
		await fake.start();
		dir = makeTempDir('rpcn-cloud-');
		configFile = path.join(dir, 'orders.yaml');
		originalUi = cloud().ui;
		originalFolders = cloud().workspaceFolders;
		cloud().endpoints = { authUrl: fake.url, controlPlaneUrl: fake.url, requireHttps: false };
		cloud().pollMs = 20;
		cloud().timeoutMs = 10_000;
		cloud().ui = {
			input: async (options) => {
				asked.push(options);
				const next = inputs.shift();
				return typeof next === 'function' ? next(options) : next;
			},
			pickCluster: async (clusters) => {
				pickedFrom.push([...clusters]);
				const name = picks.shift();
				return clusters.find((c) => c.name === name);
			},
			error: async (m, ...offered) => {
				errors.push(m);
				errorActions.push(offered);
				allMessages.push(m);
				return actions.shift();
			},
			info: async (m) => {
				infos.push(m);
				allMessages.push(m);
				return actions.shift();
			},
			progress: async (title, task) => {
				progressTitles.push(title);
				return task((m) => progressReports.push(m));
			},
			confirm: async (m, ...offered) => {
				confirmed.push({ message: m, actions: offered });
				allMessages.push(m);
				return confirms.shift();
			},
			pickUnits: async (_title, current) => {
				unitsAsked++;
				unitsPresets.push(current);
				await duringUnits?.();
				if (units.length === 0) {
					return current ?? resourcesOf(1);
				}
				const next = units.shift();
				return next === undefined ? undefined : resourcesOf(next);
			},
			pickPipeline: async (choices) => {
				pipelinesOffered.push([...choices]);
				allMessages.push(...choices.flatMap((c) => [c.label, c.description]));
				const name = pipelinePicks.shift();
				return choices.find((c) => c.pipeline.displayName === name);
			},
		};
	});

	setup(async () => {
		const wasConnected = cloud().connected;
		await cloud().disconnect();
		if (wasConnected) {
			await settleSecrets();
		}
		errors.length = 0;
		infos.length = 0;
		progressTitles.length = 0;
		progressReports.length = 0;
		fake.clustersError = undefined;
		fake.refuseTokens = false;
		errorActions.length = 0;
		fake.pageSize = 100;
		fake.createSequence = [{ state: 'STATE_STARTING' }, { state: 'STATE_RUNNING' }];
		fake.startSequence = [{ state: 'STATE_STARTING' }, { state: 'STATE_RUNNING' }];
		fake.stopSequence = [{ state: 'STATE_STOPPING' }, { state: 'STATE_STOPPED' }];
		fake.failures = [];
		for (const c of fake.options.clusters) {
			c.pipelines = [];
			c.pipelinesError = undefined;
			c.getError = undefined;
		}
		cloud().timeoutMs = 10_000;
		cloud().restartGraceMs = 2_000;
		cloud().workspaceFolders = originalFolders;
		fake.restartSequence = [{ state: 'STATE_RUNNING' }, { state: 'STATE_RUNNING' }, { state: 'STATE_STARTING' }, { state: 'STATE_RUNNING' }];
		for (const f of fs.readdirSync(dir)) {
			if (f.endsWith('.cloud.json')) {
				fs.rmSync(path.join(dir, f));
			}
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
		cloud().workspaceFolders = originalFolders;
		await fake?.stop();
		if (dir) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('package.json: the Cloud view, its empty state and the commands\' menus', () => {
		const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as {
			contributes: {
				views: Record<string, { id: string; name: string }[]>;
				viewsWelcome: { view: string; contents: string; when?: string }[];
				menus: Record<string, { command: string; when?: string; group?: string }[]>;
			};
		};
		assert.ok(pkg.contributes.views.redpandaConnect.some((v) => v.id === 'redpandaConnect.cloud' && v.name === 'Cloud'));
		const welcome = pkg.contributes.viewsWelcome.find((w) => w.view === 'redpandaConnect.cloud');
		assert.ok(welcome?.contents.includes(`(command:${CONNECT_COMMAND})`));
		const title = pkg.contributes.menus['editor/title'].find((m) => m.command === DEPLOY_COMMAND);
		assert.strictEqual(title?.when, 'resourceScheme != untitled && resourceScheme != redpanda-cloud && resourcePath in redpandaConnect.detectedPaths', 'as Run: detected, saved configs');
		assert.ok(pkg.contributes.menus['view/title'].some((m) => m.command === CLOUD_REFRESH_COMMAND && m.when?.includes('view == redpandaConnect.cloud')));
	});

	test('NOT_CONNECTED: the view is empty (its welcome offers Connect); Deploy offers Connect first and does nothing without it', async () => {
		assert.strictEqual(cloud().connected, false);
		assert.deepStrictEqual(items(), []);
		const before = fake.requests.length;
		const doc = await openConfig(configFile);
		script({ actions: [undefined] });
		const result = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'notStarted');
		assert.deepStrictEqual(infos, [NOT_CONNECTED_MESSAGE]);
		assert.strictEqual(fake.requests.length, before, 'no request');
	});

	test('CONNECT_CANCEL: Escape at either prompt stores nothing and requests nothing', async () => {
		const before = fake.requests.length;
		script({ inputs: [undefined] });
		assert.strictEqual(await vscode.commands.executeCommand(CONNECT_COMMAND), false);
		script({ inputs: [CLIENT_ID, undefined] });
		assert.strictEqual(await vscode.commands.executeCommand(CONNECT_COMMAND), false);
		assert.strictEqual(asked[1].password, true, 'the secret is a password box');
		assert.deepStrictEqual(await cloud().stored(), { clientId: false, clientSecret: false });
		assert.strictEqual(fake.requests.length, before);
		assert.strictEqual(cloud().connected, false);
	});

	test('CONNECT 401: "the client ID or secret is wrong", nothing stored', async () => {
		const before = tokenRequests();
		script({ inputs: [CLIENT_ID, WRONG_SECRET] });
		assert.strictEqual(await vscode.commands.executeCommand(CONNECT_COMMAND), false);
		assert.deepStrictEqual(errors, ['Could not connect the service account: the client ID or secret is wrong.']);
		assert.deepStrictEqual(await cloud().stored(), { clientId: false, clientSecret: false });
		assert.strictEqual(cloud().connected, false);
		assert.strictEqual(tokenRequests(), before + 1);
	});

	test('CONNECT and CLUSTERS: stored in the secret storage, one token; the account by its client_name and its BYOC and Dedicated clusters', async () => {
		const before = tokenRequests();
		await connect();
		assert.strictEqual(asked[0].password, undefined, 'the client ID is not a password box');
		assert.strictEqual(asked[1].password, true);
		assert.deepStrictEqual(await cloud().stored(), { clientId: true, clientSecret: true });
		assert.strictEqual(cloud().connected, true);
		assert.strictEqual(tokenRequests(), before + 1, 'one token request');
		assert.deepStrictEqual(labels(), ['deploy-bot', 'rpc-vilnius', 'byoc-eu', 'no-dp'], 'Serverless is left out');
		assert.strictEqual(clusterItem('rpc-vilnius')!.description, 'Dedicated · AWS us-east-2 · Connect 4.115.0');
		assert.strictEqual(clusterItem('byoc-eu')!.description, 'BYOC · GCP europe-west1 · Connect 4.116.0');
		assert.strictEqual(clusterItem('no-dp')!.description, `Dedicated · AWS us-west-2 · ${NO_PIPELINE_API}`);
		assert.strictEqual(clusterItem('no-dp')!.expandable, false);
		assert.strictEqual(clusterItem('no-dp')!.contextValue, 'cloudCluster noPipelineApi');
		assert.strictEqual(clusterItem('rpc-vilnius')!.expandable, true);
		assert.strictEqual(items()[0].contextValue, 'cloudAccount');
		assert.ok(infos.some((m) => m.includes('deploy-bot')), infos.join('\n'));
		// The settings and the workspace hold nothing of it.
		assert.ok(!JSON.stringify(vscode.workspace.getConfiguration('redpandaConnect')).includes(CLIENT_SECRET));
	});

	test('CLUSTERS: the list is followed across pages; a Control Plane error is shown in the view and as a message', async () => {
		fake.pageSize = 1;
		await connect();
		assert.deepStrictEqual(labels(), ['deploy-bot', 'rpc-vilnius', 'byoc-eu', 'no-dp']);
		fake.clustersError = { status: 503, body: { code: 'UNAVAILABLE', message: 'control plane is down', details: [{ secret: 'x' }] } };
		await cloud().refresh();
		const error = items().find((i) => i.node.kind === 'note');
		assert.strictEqual(error?.label, 'Could not list the clusters: control plane is down');
		assert.strictEqual(error?.contextValue, 'cloudError');
		assert.deepStrictEqual(errors, ['Could not list the Redpanda Cloud clusters: control plane is down']);
	});

	test('TOKEN_CACHE: refreshes, expands and a deploy within the token\'s lifetime use one token', async () => {
		const before = tokenRequests();
		await connect();
		await cloud().refresh();
		await cloud().refresh();
		await cloud().expanded({ kind: 'cluster', id: 'cvilnius0000000000aa' });
		await openConfig(configFile);
		script({ picks: ['rpc-vilnius'], inputs: ['cached'] });
		const result = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND);
		assert.strictEqual(result?.kind, 'final');
		assert.strictEqual(tokenRequests(), before + 1);
	});

	test('DEPLOY: the file\'s text unchanged, the tracer\'s resources, a tag naming the file; progress until Running; the pipeline in the view', async () => {
		await connect();
		const doc = await openConfig(configFile);
		const mtime = fs.statSync(configFile).mtimeMs;
		script({ picks: ['rpc-vilnius'], inputs: [(o) => o.value] });
		const result = await vscode.commands.executeCommand<{ kind: string; state?: string; pipelineId?: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'final', errors.join('\n'));
		assert.strictEqual(result?.state, 'STATE_RUNNING');
		assert.deepStrictEqual(pickedFrom[0].map((c) => c.name), ['rpc-vilnius', 'byoc-eu'], 'a cluster without a pipeline API is not offered');
		assert.strictEqual(asked[0].value, 'orders', 'the name defaults to the file\'s name');
		assert.strictEqual(asked[0].validateInput?.('  ') !== undefined, true, 'an empty name is refused');
		const body = lastCreate()!;
		assert.strictEqual(body.config_yaml, CONFIG, 'the file\'s text, unchanged');
		assert.strictEqual(body.display_name, 'orders');
		assert.deepStrictEqual(body.resources, resourcesOf(1));
		assert.deepStrictEqual(body.tags, { [CONFIG_TAG]: vscode.workspace.asRelativePath(doc.uri, false) });
		assert.deepStrictEqual(progressTitles.filter((t) => t.startsWith('Deploying')), ['Deploying orders to rpc-vilnius']);
		assert.ok(progressReports.includes('Starting…'), progressReports.join(', '));
		assert.ok(infos.includes('Pipeline orders is running on rpc-vilnius.'), infos.join('\n'));
		const pipeline = items().find((i) => i.node.kind === 'pipeline');
		assert.strictEqual(pipeline?.label, 'orders');
		// Ticket 5.5: the tag names a file outside every workspace folder (the stable run opens none).
		assert.strictEqual(pipeline?.description, `Running · ${NOT_IN_WORKSPACE}`);
		assert.strictEqual(fs.readFileSync(configFile, 'utf8'), CONFIG, 'the file is not changed');
		assert.strictEqual(fs.statSync(configFile).mtimeMs, mtime);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(sidecarFile(), 'utf8')), {
			clusterId: 'cvilnius0000000000aa', pipelineId: result?.pipelineId, clusterName: 'rpc-vilnius', pipelineName: 'orders',
		}, 'the mapping beside the file');
	});

	test('DEPLOY from NOT_CONNECTED: Connect first, then the deploy goes on', async () => {
		const doc = await openConfig(configFile);
		script({ actions: [CONNECT_ACTION], inputs: [CLIENT_ID, CLIENT_SECRET, 'after-connect'], picks: ['byoc-eu'] });
		const result = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'final', errors.join('\n'));
		assert.strictEqual(fake.cluster('cbyoc000000000000bbb').pipelines[0]?.display_name, 'after-connect');
	});

	test('DEPLOY_REJECTED: each LintHint\'s line and text; nothing created', async () => {
		await connect();
		const text = CONFIG.replace('  generate:', `  ${FAKE_LINT_MARKER}: {}\n  generate:`);
		const doc = await openConfig(configFile, text);
		script({ picks: ['rpc-vilnius'], inputs: ['bad'] });
		const result = await vscode.commands.executeCommand<{ kind: string; hints?: string[] }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'rejected');
		assert.strictEqual(errors.length, 1, errors.join('\n'));
		assert.ok(errors[0].includes(`line 2, column 3: unable to infer component type: ${FAKE_LINT_MARKER}`), errors[0]);
		assert.ok(errors[0].includes('second fake hint') && errors[0].includes('invalid pipeline configuration'), errors[0]);
		assert.ok(!errors[0].includes('REASON_CONNECT'), 'nothing else from the body');
		assert.strictEqual(fake.cluster('cvilnius0000000000aa').pipelines.length, 0);
		assert.ok(api().outputLines().some((l) => l.includes(`unable to infer component type: ${FAKE_LINT_MARKER}`)));
	});

	test('DEPLOY_ERROR_STATE: the cluster\'s message, or "the cluster gave no reason"; the view shows Error', async () => {
		await connect();
		const doc = await openConfig(configFile);
		fake.createSequence = [{ state: 'STATE_STARTING' }, { state: 'STATE_ERROR', error: 'out of memory' }];
		script({ picks: ['rpc-vilnius'], inputs: ['with-reason'] });
		const first = await vscode.commands.executeCommand<{ kind: string; state?: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(first?.state, 'STATE_ERROR');
		assert.deepStrictEqual(errors, ['Pipeline with-reason on rpc-vilnius is in Error: out of memory.']);
		fake.createSequence = [{ state: 'STATE_STARTING' }, { state: 'STATE_ERROR' }];
		fs.rmSync(sidecarFile());
		script({ picks: ['rpc-vilnius'], confirms: [CREATE_NEW_ACTION], inputs: ['no-reason'] });
		await vscode.commands.executeCommand(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(errors[1], `Pipeline no-reason on rpc-vilnius is in Error: ${NO_REASON}.`);
		const shown = items().filter((i) => i.node.kind === 'pipeline').map((i) => [i.label, i.description]);
		assert.deepStrictEqual(shown, [['with-reason', `Error (out of memory) · ${NOT_IN_WORKSPACE}`], ['no-reason', `Error (${NO_REASON}) · ${NOT_IN_WORKSPACE}`]]);
	});

	test('DEPLOY: still starting after the timeout: it says so and leaves the view to show it', async () => {
		await connect();
		const doc = await openConfig(configFile);
		fake.createSequence = [{ state: 'STATE_STARTING' }];
		cloud().timeoutMs = 200;
		script({ picks: ['rpc-vilnius'], inputs: ['slow'] });
		const result = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'timedOut');
		assert.deepStrictEqual(infos.slice(-1), ['Pipeline slow is still starting on rpc-vilnius; the Cloud view shows its state.']);
		assert.strictEqual(items().find((i) => i.node.kind === 'pipeline')?.description, `Starting · ${NOT_IN_WORKSPACE}`);
	});

	test('DEPLOY_UNSAVED: a dirty config is saved first and its saved text sent; an untitled one is refused', async () => {
		await connect();
		const doc = await openConfig(configFile);
		const editor = await vscode.window.showTextDocument(doc);
		await editor.edit((e) => e.insert(new vscode.Position(0, 0), '# edited\n'));
		assert.ok(doc.isDirty);
		script({ picks: ['rpc-vilnius'], inputs: ['dirty'] });
		const result = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'final', errors.join('\n'));
		assert.strictEqual(doc.isDirty, false, 'saved first');
		assert.strictEqual(lastCreate()!.config_yaml, `# edited\n${CONFIG}`);
		assert.strictEqual(fs.readFileSync(configFile, 'utf8'), `# edited\n${CONFIG}`);

		const before = fake.requests.length;
		const untitled = await vscode.workspace.openTextDocument({ language: 'yaml', content: CONFIG });
		await vscode.window.showTextDocument(untitled);
		script({});
		const refused = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND);
		assert.strictEqual(refused?.kind, 'notStarted');
		assert.deepStrictEqual(infos.slice(-1), [DEPLOY_UNTITLED_MESSAGE]);
		assert.strictEqual(fake.requests.length, before);
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
	});

	test('VIEW_REFRESH: expanding a cluster and Refresh read the pipelines and clusters again; a failing list is an error row in the cluster', async () => {
		await connect();
		const vilnius = { kind: 'cluster' as const, id: 'cvilnius0000000000aa' };
		assert.deepStrictEqual(await cloud().getChildren(vilnius), [{ kind: 'note', id: 'pipelines:cvilnius0000000000aa:none', text: 'No pipelines.', error: false }]);
		fake.cluster(vilnius.id).pipelines.push({
			id: 'elsewhere00000000001', display_name: 'from-the-ui', description: '', config_yaml: CONFIG,
			resources: { cpu_shares: '100m', memory_shares: '400M' }, tags: {}, state: 'STATE_STOPPED', sequence: [],
		});
		await new Promise((r) => setTimeout(r, 1_100));
		await cloud().expanded(vilnius);
		assert.deepStrictEqual(items().filter((i) => i.node.kind === 'pipeline').map((i) => [i.label, i.description]), [['from-the-ui', 'Stopped']]);

		const listsBefore = fake.requests.filter((r) => r.url.startsWith('/v1/clusters?')).length;
		fake.cluster(vilnius.id).pipelinesError = { status: 403, body: { code: 'PERMISSION_DENIED', message: 'you are not authorized to call this endpoint', details: [] } };
		await vscode.commands.executeCommand(CLOUD_REFRESH_COMMAND);
		assert.strictEqual(fake.requests.filter((r) => r.url.startsWith('/v1/clusters?')).length, listsBefore + 1, 'the clusters are read again');
		const row = items().find((i) => i.node.kind === 'note' && i.node.id.startsWith('pipelines:'));
		assert.strictEqual(row?.label, 'Could not list the pipelines: you are not authorized to call this endpoint');
		fake.cluster(vilnius.id).pipelinesError = undefined;
		await vscode.commands.executeCommand(CLOUD_REFRESH_COMMAND, vilnius);
		assert.ok(items().some((i) => i.label === 'from-the-ui'));
	});

	test('DISCONNECT: the stored ID and secret and the cached token are removed; the view is empty', async () => {
		await connect();
		assert.ok(cloud().tokens.values().length > 0);
		assert.strictEqual(await vscode.commands.executeCommand(DISCONNECT_COMMAND), true);
		assert.deepStrictEqual(await cloud().stored(), { clientId: false, clientSecret: false });
		assert.deepStrictEqual(cloud().tokens.values(), []);
		assert.strictEqual(cloud().connected, false);
		assert.deepStrictEqual(items(), []);
		await settleSecrets();
		const before = tokenRequests();
		await connect();
		assert.strictEqual(tokenRequests(), before + 1, 'a new token after a disconnect');
	});

	test('TOKEN_REVOKED: a 401 with the cached token drops it and retries once with one new token; a second 401 suggests Connect again', async () => {
		await connect();
		await cloud().expanded({ kind: 'cluster', id: 'cvilnius0000000000aa' });
		const before = tokenRequests();
		fake.revokeAll();
		await cloud().refresh();
		assert.deepStrictEqual(errors, [], 'recovered');
		assert.deepStrictEqual(labels().filter((l) => l !== 'No pipelines.'), ['deploy-bot', 'rpc-vilnius', 'byoc-eu', 'no-dp']);
		assert.ok(items().some((i) => i.label === 'No pipelines.'), 'the pipelines were read again too');
		assert.strictEqual(tokenRequests(), before + 1, 'exactly one new token');

		fake.refuseTokens = true;
		await cloud().refresh();
		assert.strictEqual(tokenRequests(), before + 2, 'one retry, not a loop');
		assert.strictEqual(errors.length, 1, errors.join('\n'));
		assert.match(errors[0], /Connect the service account again/);
		assert.deepStrictEqual(errorActions[0], [CONNECT_ACTION]);
		assert.ok(items().some((i) => i.contextValue === 'cloudError'));
	});

	test('DEPLOY to a cluster whose pipelines were never read: the view shows them all, not only the new one', async () => {
		fake.cluster('cbyoc000000000000bbb').pipelines.push({
			id: 'existing000000000001', display_name: 'existing', description: '', config_yaml: CONFIG,
			resources: { cpu_shares: '100m', memory_shares: '400M' }, tags: {}, state: 'STATE_RUNNING', sequence: [],
		});
		await connect();
		const doc = await openConfig(configFile);
		script({ picks: ['byoc-eu'], inputs: ['orders'] });
		const result = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'final', errors.join('\n'));
		assert.deepStrictEqual(items().filter((i) => i.node.kind === 'pipeline').map((i) => [i.label, i.description]),
			[['existing', 'Running'], ['orders', `Running · ${NOT_IN_WORKSPACE}`]]);
	});

	test('DETAILS_UNREAD: a cluster whose details fail is not "no pipeline API"; Deploy says the details could not be read', async () => {
		fake.cluster('cvilnius0000000000aa').getError = { status: 500, body: { code: 'UNKNOWN', message: 'details exploded', details: [] } };
		await connect();
		assert.strictEqual(clusterItem('rpc-vilnius')!.description, `Dedicated · AWS us-east-2 · ${DETAILS_UNREAD}: details exploded`);
		assert.strictEqual(clusterItem('rpc-vilnius')!.contextValue, 'cloudCluster detailsUnread');
		assert.strictEqual(clusterItem('no-dp')!.description, `Dedicated · AWS us-west-2 · ${NO_PIPELINE_API}`);
		fake.cluster('cbyoc000000000000bbb').getError = { status: 503, body: { code: 'UNAVAILABLE', message: 'try later', details: [] } };
		await cloud().refresh();
		const doc = await openConfig(configFile);
		errors.length = 0;
		script({});
		const result = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'notStarted');
		assert.strictEqual(errors.length, 1, errors.join('\n'));
		assert.match(errors[0], /^Could not read the details of rpc-vilnius \(details exploded\), byoc-eu \(try later\)/);
		assert.ok(!errors[0].includes('offers the pipeline API'));
	});

	test('CONNECT superseded: a Disconnect while the token is requested leaves nothing stored or connected', async () => {
		const ui = cloud().ui;
		cloud().ui = {
			...ui,
			progress: async (_title, task) => {
				const running = task(() => undefined);
				await cloud().disconnect();
				return running;
			},
		};
		try {
			script({ inputs: [CLIENT_ID, CLIENT_SECRET] });
			assert.strictEqual(await vscode.commands.executeCommand(CONNECT_COMMAND), false);
		} finally {
			cloud().ui = ui;
		}
		assert.strictEqual(cloud().connected, false);
		assert.deepStrictEqual(await cloud().stored(), { clientId: false, clientSecret: false });
		assert.deepStrictEqual(items(), []);
	});

	test('Disconnect while not connected, then Connect: the account stays stored (no late delete of an absent key wipes it)', async () => {
		await cloud().disconnect();
		await cloud().disconnect();
		await connect();
		await new Promise((r) => setTimeout(r, 300));
		await cloud().ready;
		assert.strictEqual(cloud().connected, true);
		assert.deepStrictEqual(await cloud().stored(), { clientId: true, clientSecret: true });
	});

	test('CONNECT again with the same client ID and a wrong secret keeps the valid token', async () => {
		await connect();
		const kept = cloud().tokens.values();
		assert.strictEqual(kept.length, 1);
		script({ inputs: [CLIENT_ID, WRONG_SECRET] });
		assert.strictEqual(await vscode.commands.executeCommand(CONNECT_COMMAND), false);
		assert.deepStrictEqual(cloud().tokens.values(), kept);
		assert.strictEqual(cloud().connected, true);
		const before = tokenRequests();
		await cloud().refresh();
		assert.strictEqual(tokenRequests(), before, 'the kept token is used');
		assert.deepStrictEqual(await cloud().stored(), { clientId: true, clientSecret: true });
	});

	test('a stored account (a new window) requests nothing until the user expands or refreshes', async () => {
		const stored = new Map([[CLIENT_ID_KEY, CLIENT_ID], [CLIENT_SECRET_KEY, CLIENT_SECRET]]);
		const changed = new vscode.EventEmitter<{ key: string }>();
		const view = new CloudView({
			store: { get: async (k) => stored.get(k), store: async (k, v) => void stored.set(k, v), delete: async (k) => void stored.delete(k), onDidChange: changed.event },
			log: () => undefined,
			endpoints: cloud().endpoints,
			isDetected: () => true,
		});
		try {
			view.ui = cloud().ui;
			const before = fake.requests.length;
			const root = await view.getChildren();
			assert.deepStrictEqual(root, [{ kind: 'account' }]);
			assert.deepStrictEqual((await view.getChildren(root[0])).map((n) => n.kind === 'note' && n.text), [NOT_READ_TEXT]);
			assert.strictEqual(fake.requests.length, before, 'opening the view requests nothing');
			await view.expanded(root[0]);
			assert.deepStrictEqual(view.items().map((i) => i.label), ['deploy-bot', 'rpc-vilnius', 'byoc-eu', 'no-dp']);
			seenItems.push(...view.items());

			// Another window connects another account: back to the startup row, nothing requested by itself.
			const afterExpand = fake.requests.length;
			stored.set(CLIENT_SECRET_KEY, 'other-window-secret-5-2');
			stored.set(CLIENT_ID_KEY, 'other-window-client');
			changed.fire({ key: CLIENT_ID_KEY });
			await view.ready;
			const account = (await view.getChildren())[0];
			assert.deepStrictEqual((await view.getChildren(account)).map((n) => n.kind === 'note' && n.text), [NOT_READ_TEXT]);
			assert.deepStrictEqual(view.items().map((i) => i.label), ['other-window-client', NOT_READ_TEXT]);
			// A half-written pair (the client ID without its secret) is no account, silently.
			stored.delete(CLIENT_SECRET_KEY);
			changed.fire({ key: CLIENT_SECRET_KEY });
			await view.ready;
			assert.strictEqual(view.connected, false);
			assert.deepStrictEqual(await view.getChildren(), []);
			assert.strictEqual(fake.requests.length, afterExpand, 'another window\'s change sends nothing');
		} finally {
			view.dispose();
			changed.dispose();
		}
	});

	// --- ticket 5.3: deploy again updates the mapped pipeline ---

	test('FIRST_DEPLOY: the size pick, pre-set to 1 unit (Escape creates nothing); created with the picked size; the mapping written; nothing saved', async () => {
		await connect();
		const doc = await openConfig(configFile);
		const before = fake.requests.length;
		script({ units: [undefined], picks: ['rpc-vilnius'], inputs: ['orders'] });
		const cancelled = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(cancelled?.kind, 'notStarted');
		assert.strictEqual(unitsAsked, 1);
		assert.deepStrictEqual(unitsPresets, [undefined], 'a new pipeline: pre-set to 1 unit');
		assert.ok(fake.requests.slice(before).every((r) => r.method === 'GET'), 'nothing created');
		assert.ok(!fs.existsSync(sidecarFile()));

		script({ units: [2], picks: ['rpc-vilnius'], inputs: ['orders'] });
		const result = await vscode.commands.executeCommand<{ kind: string; pipelineId?: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'final', errors.join('\n'));
		assert.deepStrictEqual(lastCreate()!.resources, { cpu_shares: '200m', memory_shares: '800M' });
		assert.ok(!('redpandaConnect.cloud.computeUnits' in vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes.configuration.properties), 'no size setting');
		const mapping = fs.readFileSync(sidecarFile(), 'utf8');
		assert.ok(mapping.endsWith('}\n'));
		assert.deepStrictEqual(JSON.parse(mapping), { clusterId: 'cvilnius0000000000aa', pipelineId: result?.pipelineId, clusterName: 'rpc-vilnius', pipelineName: 'orders' });
		assert.ok(!mapping.includes('input:'), 'no config text in the mapping');

		// Deploying the same pipeline again: the pick is shown again, pre-set to its deployed size.
		script({});
		assert.strictEqual((await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri))?.kind, 'unchanged');
		assert.strictEqual(unitsAsked, 1, 'asked on every deploy');
		assert.deepStrictEqual(unitsPresets, [{ cpu_shares: '200m', memory_shares: '800M' }]);
	});

	test('UPDATE_RUNNING: a diff of the deployed and local config and "Replace and restart"; one create and one PUT to the same id with the kept name, description and tags; followed through the restart', async () => {
		const { doc, id } = await deployOnce();
		const deployed = fake.cluster('cvilnius0000000000aa').pipelines[0];
		deployed.description = 'set in the Cloud UI';
		deployed.tags = { ...deployed.tags, team: 'payments' };
		const changed = CONFIG.replace('interval: 5s', 'interval: 7s');
		await editConfig(doc, changed);

		// Cancel: nothing sent.
		const before = fake.requests.length;
		script({ confirms: [undefined] });
		const cancelled = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(cancelled?.kind, 'notStarted');
		assert.strictEqual(puts().length, 0);
		assert.deepStrictEqual(fake.requests.slice(before).map((r) => r.method), ['GET'], 'only the mapped pipeline is read');
		assert.strictEqual(confirmed.length, 1);
		assert.deepStrictEqual(confirmed[0].actions, [REPLACE_ACTION]);
		assert.match(confirmed[0].message, /^Pipeline orders on rpc-vilnius is running\. Replacing its config with orders\.yaml/);
		const tabs = diffTabs();
		assert.strictEqual(tabs.length, 1, 'the diff opened');
		const input = tabs[0].input as vscode.TabInputTextDiff;
		assert.strictEqual(input.modified.scheme, DEPLOYED_SCHEME, 'deployed ↔ as sent (ticket 5.6), both read-only');
		assert.ok(input.modified.path.endsWith('/orders.local.yaml'), input.modified.path);
		assert.strictEqual(tabs[0].label, 'orders (deployed) ↔ orders.yaml (as sent)');
		const left = await vscode.workspace.openTextDocument(input.original);
		assert.strictEqual(left.getText(), CONFIG, 'the deployed config, read-only');
		assert.strictEqual((await vscode.workspace.openTextDocument(input.modified)).getText(), changed, 'no variable: the text as saved');
		assert.strictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).length, 1, 'the deployed config is not written to disk');

		script({ confirms: [REPLACE_ACTION] });
		const mapping = fs.readFileSync(sidecarFile(), 'utf8');
		const result = await vscode.commands.executeCommand<{ kind: string; state?: string; pipelineId?: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'final', errors.join('\n'));
		assert.strictEqual(result?.state, 'STATE_RUNNING');
		assert.strictEqual(result?.pipelineId, id);
		assert.strictEqual(posts().length, 1, 'one create');
		assert.deepStrictEqual(puts().map((r) => r.url), [`/dp/cvilnius0000000000aa/v1/redpanda-connect/pipelines/${id}`], 'one PUT to the same id');
		assert.strictEqual(fake.cluster('cvilnius0000000000aa').pipelines.length, 1, 'one pipeline on the cluster');
		assert.deepStrictEqual(JSON.parse(puts()[0].body), {
			display_name: 'orders', description: 'set in the Cloud UI', config_yaml: changed, resources: resourcesOf(1),
			tags: { [CONFIG_TAG]: vscode.workspace.asRelativePath(doc.uri, false), team: 'payments' },
		});
		assert.ok(progressReports.includes('waiting for the restart…'), progressReports.join(', '));
		assert.ok(progressReports.includes('Starting…'), 'followed through the restart');
		assert.deepStrictEqual(progressTitles.slice(-1), ['Updating orders on rpc-vilnius']);
		assert.ok(infos.includes('Updated pipeline orders on rpc-vilnius; it is running.'), infos.join('\n'));
		assert.strictEqual(fs.readFileSync(sidecarFile(), 'utf8'), mapping, 'the mapping is unchanged');
		assert.strictEqual(fs.readFileSync(configFile, 'utf8'), changed, 'the config as saved, not changed');
	});

	test('UPDATE_RUNNING: still running 20 s (the grace) after the PUT with no change: reported running', async () => {
		const { doc } = await deployOnce();
		fake.restartSequence = [{ state: 'STATE_RUNNING' }];
		cloud().restartGraceMs = 300;
		await editConfig(doc, `${CONFIG}# more\n`);
		script({ confirms: [REPLACE_ACTION] });
		const result = await vscode.commands.executeCommand<{ kind: string; state?: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'final');
		assert.strictEqual(result?.state, 'STATE_RUNNING');
	});

	test('UNCHANGED: config and resources as deployed: "already deployed, nothing changed", no PUT', async () => {
		const { doc } = await deployOnce();
		script({});
		const result = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'unchanged');
		assert.strictEqual(puts().length, 0);
		assert.strictEqual(confirmed.length, 0);
		assert.strictEqual(diffTabs().length, 0);
		assert.deepStrictEqual(infos.slice(-1), ['Pipeline orders on rpc-vilnius is already deployed from orders.yaml, nothing changed.']);
	});

	test('RESOURCES_ONLY: another size picked, the config unchanged: a confirmation naming the old and new size, no diff; PUT with the new resources', async () => {
		const { doc } = await deployOnce();
		script({ units: [3], confirms: [REPLACE_ACTION] });
		const result = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'final', errors.join('\n'));
		assert.strictEqual(diffTabs().length, 0, 'no diff');
		assert.strictEqual(confirmed.length, 1);
		assert.ok(confirmed[0].message.includes('from 1 compute unit (0.1 CPU, 400 MB) to 3 compute units (0.3 CPU, 1200 MB)'), confirmed[0].message);
		assert.deepStrictEqual(JSON.parse(puts()[0].body).resources, { cpu_shares: '300m', memory_shares: '1200M' });
		assert.strictEqual(JSON.parse(puts()[0].body).config_yaml, CONFIG);
	});

	test('UPDATE_STOPPED: no confirmation; PUT, the state followed, the mapping unchanged; a rejected update: "not updated"', async () => {
		const { doc, id } = await deployOnce();
		const p = fake.cluster('cvilnius0000000000aa').pipelines[0];
		p.state = 'STATE_STOPPED';
		p.sequence = [];
		const mapping = fs.readFileSync(sidecarFile(), 'utf8');
		const mtime = fs.statSync(sidecarFile()).mtimeMs;
		await editConfig(doc, CONFIG.replace('interval: 5s', 'interval: 9s'));
		script({});
		const result = await vscode.commands.executeCommand<{ kind: string; state?: string; pipelineId?: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'final', errors.join('\n'));
		assert.strictEqual(result?.state, 'STATE_STOPPED');
		assert.strictEqual(result?.pipelineId, id);
		assert.strictEqual(confirmed.length, 0, 'a stopped pipeline is updated without asking');
		assert.strictEqual(diffTabs().length, 0);
		assert.strictEqual(puts().length, 1);
		assert.strictEqual(fs.readFileSync(sidecarFile(), 'utf8'), mapping);
		assert.strictEqual(fs.statSync(sidecarFile()).mtimeMs, mtime, 'not rewritten');

		await editConfig(doc, CONFIG.replace('  generate:', `  ${FAKE_LINT_MARKER}: {}\n  generate:`));
		const rejected = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(rejected?.kind, 'rejected');
		assert.ok(errors.some((e) => e.includes(`line 2, column 3: unable to infer component type: ${FAKE_LINT_MARKER}`) && e.endsWith('Pipeline orders was not updated.')), errors.join('\n'));
		assert.strictEqual(p.config_yaml, CONFIG.replace('interval: 5s', 'interval: 9s'), 'the pipeline keeps its config');
	});

	test('MAPPED_GONE: the pipeline deleted in the Cloud: offer "Create a new pipeline", then create and rewrite the mapping; a cluster gone: the same with a cluster pick', async () => {
		const { doc, id } = await deployOnce();
		fake.cluster('cvilnius0000000000aa').pipelines = [];
		script({ actions: [undefined] });
		assert.strictEqual((await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri))?.kind, 'notStarted');
		assert.strictEqual(posts().length, 1, 'declined: nothing created');
		assert.match(infos[infos.length - 1], /^Pipeline orders, which orders\.cloud\.json maps orders\.yaml to, is no longer on rpc-vilnius\. Create a new pipeline\?$/);

		script({ actions: [CREATE_NEW_PIPELINE_ACTION], inputs: [(o) => o.value] });
		const result = await vscode.commands.executeCommand<{ kind: string; pipelineId?: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'final', errors.join('\n'));
		assert.strictEqual(asked[0].value, 'orders', 'the old name offered');
		assert.notStrictEqual(result?.pipelineId, id);
		assert.strictEqual(JSON.parse(fs.readFileSync(sidecarFile(), 'utf8')).pipelineId, result?.pipelineId, 'the mapping rewritten');

		fs.writeFileSync(sidecarFile(), JSON.stringify({ clusterId: 'cgone0000000000000zz', pipelineId: 'p-gone', clusterName: 'old-cluster' }));
		script({ actions: [CREATE_NEW_PIPELINE_ACTION], picks: ['byoc-eu'], inputs: ['moved'] });
		const moved = await vscode.commands.executeCommand<{ kind: string; pipelineId?: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(moved?.kind, 'final', errors.join('\n'));
		assert.ok(infos.some((m) => m.startsWith('The cluster old-cluster that orders.cloud.json maps orders.yaml to is gone or no longer offers the pipeline API.')), infos.join('\n'));
		assert.strictEqual(pickedFrom.length, 1, 'a cluster pick');
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(sidecarFile(), 'utf8')), { clusterId: 'cbyoc000000000000bbb', pipelineId: moved?.pipelineId, clusterName: 'byoc-eu', pipelineName: 'moved' });
		assert.strictEqual(confirmed.length, 0, 'no tagged offer when re-creating');
	});

	test('BAD_SIDECAR: a mapping that is not JSON or lacks an id is named; deploying as new replaces it', async () => {
		await connect();
		const doc = await openConfig(configFile);
		fs.writeFileSync(sidecarFile(), '{"clusterId": "c1"}');
		const before = fake.requests.length;
		script({ actions: [undefined] });
		assert.strictEqual((await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri))?.kind, 'notStarted');
		assert.strictEqual(errors.length, 1);
		assert.match(errors[0], /^orders\.cloud\.json is not a deploy mapping: it has no pipelineId\. Deploy orders\.yaml as a new pipeline\?/);
		assert.deepStrictEqual(errorActions[0], [DEPLOY_AS_NEW_ACTION]);
		assert.ok(fake.requests.slice(before).every((r) => r.method === 'GET'), 'nothing created');

		fs.writeFileSync(sidecarFile(), 'not json {');
		script({ actions: [DEPLOY_AS_NEW_ACTION], picks: ['rpc-vilnius'], inputs: ['orders'] });
		const result = await vscode.commands.executeCommand<{ kind: string; pipelineId?: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'final', errors.join('\n'));
		assert.match(errors[1], /^orders\.cloud\.json is not a deploy mapping: it is not JSON/);
		assert.strictEqual(JSON.parse(fs.readFileSync(sidecarFile(), 'utf8')).pipelineId, result?.pipelineId, 'replaced');
	});

	test('TAGGED: no mapping, the cluster has a pipeline tagged with this file: "Update <name>" or "Create new"; Escape sends nothing; the mapping written either way', async () => {
		await connect();
		const doc = await openConfig(configFile);
		const rel = vscode.workspace.asRelativePath(doc.uri, false);
		fake.cluster('cvilnius0000000000aa').pipelines.push({
			id: 'tagged00000000000001', display_name: 'from-a-colleague', description: 'theirs', config_yaml: CONFIG,
			resources: { cpu_shares: '100m', memory_shares: '400M' }, tags: { [CONFIG_TAG]: rel }, state: 'STATE_STOPPED', sequence: [],
		});
		const before = fake.requests.length;
		script({ picks: ['rpc-vilnius'], confirms: [undefined] });
		assert.strictEqual((await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri))?.kind, 'notStarted');
		assert.deepStrictEqual(confirmed[0].actions, ['Update from-a-colleague', CREATE_NEW_ACTION]);
		assert.ok(confirmed[0].message.includes(`deployed from ${rel}: from-a-colleague`), confirmed[0].message);
		assert.ok(fake.requests.slice(before).every((r) => r.method === 'GET'), 'Escape: nothing sent');
		assert.ok(!fs.existsSync(sidecarFile()));

		// Update: config and size as deployed, so nothing is sent, and the mapping is written.
		script({ picks: ['rpc-vilnius'], confirms: ['Update from-a-colleague'] });
		const unchanged = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(unchanged?.kind, 'unchanged');
		assert.strictEqual(JSON.parse(fs.readFileSync(sidecarFile(), 'utf8')).pipelineId, 'tagged00000000000001');
		assert.strictEqual(asked.length, 0, 'no name prompt');

		// Create new.
		fs.rmSync(sidecarFile());
		script({ picks: ['rpc-vilnius'], confirms: [CREATE_NEW_ACTION], inputs: ['mine'] });
		const created = await vscode.commands.executeCommand<{ kind: string; pipelineId?: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(created?.kind, 'final', errors.join('\n'));
		assert.strictEqual(JSON.parse(fs.readFileSync(sidecarFile(), 'utf8')).pipelineId, created?.pipelineId);
		assert.strictEqual(posts().length, 1);
		assert.strictEqual(puts().length, 0);
	});

	test('a valid hand-written mapping naming the same ids is left byte for byte after an unchanged and an updating deploy', async () => {
		const { doc, id } = await deployOnce();
		const handWritten = `{ "pipelineId": "${id}",\n\t"clusterId": "cvilnius0000000000aa" }`;
		fs.writeFileSync(sidecarFile(), handWritten);
		fake.cluster('cvilnius0000000000aa').pipelines[0].display_name = 'renamed-in-the-cloud';
		script({});
		assert.strictEqual((await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri))?.kind, 'unchanged');
		assert.strictEqual(fs.readFileSync(sidecarFile(), 'utf8'), handWritten);
		await editConfig(doc, `${CONFIG}# changed\n`);
		script({ confirms: [REPLACE_ACTION] });
		assert.strictEqual((await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri))?.kind, 'final', errors.join('\n'));
		assert.strictEqual(puts().length, 1);
		assert.strictEqual(fs.readFileSync(sidecarFile(), 'utf8'), handWritten);
	});

	test('a mapped pipeline of another size: the pick is pre-set to its deployed size, so deploying again keeps it', async () => {
		const { doc } = await deployOnce();
		const p = fake.cluster('cvilnius0000000000aa').pipelines[0];
		p.resources = { cpu_shares: '300m', memory_shares: '1200M' };
		script({});
		assert.strictEqual((await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri))?.kind, 'unchanged');
		await editConfig(doc, `${CONFIG}# changed\n`);
		script({ confirms: [REPLACE_ACTION] });
		assert.strictEqual((await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri))?.kind, 'final', errors.join('\n'));
		assert.strictEqual(unitsAsked, 1);
		assert.deepStrictEqual(unitsPresets, [{ cpu_shares: '300m', memory_shares: '1200M' }], 'pre-set to the deployed size');
		assert.deepStrictEqual(JSON.parse(puts()[0].body).resources, { cpu_shares: '300m', memory_shares: '1200M' });
	});

	test('no mapping, the cluster\'s pipeline list fails: the tagged check cannot run, so nothing is created', async () => {
		await connect();
		const doc = await openConfig(configFile);
		fake.cluster('cvilnius0000000000aa').pipelinesError = { status: 503, body: { code: 'UNAVAILABLE', message: 'list is down', details: [] } };
		script({ picks: ['rpc-vilnius'], inputs: ['orders'] });
		assert.strictEqual((await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri))?.kind, 'notStarted');
		assert.deepStrictEqual(errors, ['Could not check whether rpc-vilnius already has a pipeline deployed from orders.yaml: list is down. Nothing was deployed.']);
		assert.strictEqual(posts().length, 0);
		assert.strictEqual(asked.length, 0, 'no name prompt');
	});

	test('NOT_CONNECTED with a mapping: Connect is offered first; declined, nothing is sent', async () => {
		const doc = await openConfig(configFile);
		fs.writeFileSync(sidecarFile(), JSON.stringify({ clusterId: 'cvilnius0000000000aa', pipelineId: 'p1' }));
		const before = fake.requests.length;
		script({ actions: [undefined] });
		assert.strictEqual((await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri))?.kind, 'notStarted');
		assert.deepStrictEqual(infos, [NOT_CONNECTED_MESSAGE]);
		assert.strictEqual(fake.requests.length, before);
	});

	// --- ticket 5.6: variables become secrets ---

	/** A config with variables (PLAIN, DEFAULT, MANY, UNTOUCHED) and the text the Cloud is sent. */
	const VARS = [
		'# brokers: ${BROKER}',
		'input:',
		'  generate:',
		'    interval: ${INTERVAL:5s}',
		'    mapping: |',
		'      root.broker = "${BROKER}"',
		'      root.topic = "${TOPIC:orders}"',
		'      root.opt = "${OPT:}"',
		'      root.kept = "${secrets.X}"',
		'      root.meta = "${!meta("k")}"',
		'output:',
		'  drop: {}',
		'',
	].join('\n');
	const VARS_SENT = [
		'# brokers: ${secrets.BROKER}',
		'input:',
		'  generate:',
		'    interval: ${secrets.INTERVAL:5s}',
		'    mapping: |',
		'      root.broker = "${secrets.BROKER}"',
		'      root.topic = "${secrets.TOPIC:orders}"',
		'      root.opt = "${secrets.OPT:}"',
		'      root.kept = "${secrets.X}"',
		'      root.meta = "${!meta("k")}"',
		'output:',
		'  drop: {}',
		'',
	].join('\n');

	test('ACCEPTANCE 5.6: ${BROKER} and ${TOPIC:orders} reach the fake as ${secrets.BROKER} and ${secrets.TOPIC:orders}; ${!…} and ${secrets.X} as written; the local file byte for byte unchanged', async () => {
		await connect();
		const doc = await openConfig(configFile, VARS);
		const mtime = fs.statSync(configFile).mtimeMs;
		script({ picks: ['rpc-vilnius'], inputs: ['orders'] });
		const result = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'final', errors.join('\n'));
		assert.strictEqual(lastCreate()!.config_yaml, VARS_SENT);
		assert.strictEqual(fake.cluster('cvilnius0000000000aa').pipelines[0].config_yaml, VARS_SENT);
		assert.strictEqual(fs.readFileSync(configFile, 'utf8'), VARS, 'the local file is not changed');
		assert.strictEqual(fs.statSync(configFile).mtimeMs, mtime);
		assert.strictEqual(doc.getText(), VARS);
	});

	test('BAD_NAME and ENV_CALL: refused before any prompt or request, one error naming each with its line, one output line each; a dirty config is still saved', async () => {
		await connect();
		const text = [
			'input:',
			'  generate:',
			'    interval: 5s',
			'    mapping: |',
			'      root.t = "${my_token}"',
			'      root.u = "${_X} ${1X}"',
			'      root.k = env("KEY")',
			'output:',
			'  drop: {}',
			'',
		].join('\n');
		const doc = await openConfig(configFile, text);
		// The document may still hold the previous test's text until VS Code reads the file again.
		assert.ok(await waitFor(() => doc.getText() === text, 10_000));
		const dirty = `${text}# unsaved\n`;
		await editConfig(doc, dirty);
		const before = fake.requests.length;
		const outputBefore = api().outputLines().length;
		script({ picks: ['rpc-vilnius'], inputs: ['orders'] });
		const result = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'notStarted');
		assert.strictEqual(fake.requests.length, before, 'nothing sent');
		assert.strictEqual(pickedFrom.length + asked.length + unitsAsked, 0, 'nothing asked');
		const problems = [
			'my_token (line 5): a Redpanda Cloud secret name must match ^[A-Z][A-Z0-9_]*$',
			'_X (line 6): a Redpanda Cloud secret name must match ^[A-Z][A-Z0-9_]*$',
			'1X (line 6): a Redpanda Cloud secret name must match ^[A-Z][A-Z0-9_]*$',
			'line 7: env("KEY") reads an environment variable, which Redpanda Cloud pipelines do not have; use "${KEY}"',
		];
		assert.deepStrictEqual(errors, [`orders.yaml can't be deployed to Redpanda Cloud: ${problems.join('; ')}. Nothing was sent.`]);
		const lines = api().outputLines().slice(outputBefore);
		for (const p of problems) {
			assert.strictEqual(lines.filter((l) => l === `  orders.yaml: ${p}`).length, 1, `one output line for ${p}`);
		}
		assert.strictEqual(doc.isDirty, false, 'saved, as Run');
		assert.strictEqual(fs.readFileSync(configFile, 'utf8'), dirty, 'the file as saved, not translated');
	});

	test('EDIT_DURING_PROMPTS 5.6: an edit made while the size pick is open is saved, translated and sent; one refused then sends nothing', async () => {
		await connect();
		const doc = await openConfig(configFile, VARS);
		assert.ok(await waitFor(() => doc.getText() === VARS, 10_000));
		const edited = VARS.replace('drop: {}', 'drop: {} # ${LATE}');
		script({ picks: ['rpc-vilnius'], inputs: ['orders'] });
		duringUnits = () => editConfig(doc, edited);
		const result = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'final', errors.join('\n'));
		assert.strictEqual(lastCreate()!.config_yaml, VARS_SENT.replace('drop: {}', 'drop: {} # ${secrets.LATE}'));
		assert.strictEqual(fs.readFileSync(configFile, 'utf8'), edited, 'saved, not translated');

		const refusedText = edited.replace('${LATE}', '${late}');
		script({});
		duringUnits = () => editConfig(doc, refusedText);
		const before = fake.requests.length;
		assert.strictEqual((await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri))?.kind, 'notStarted');
		assert.ok(fake.requests.slice(before).every((r) => r.method === 'GET'), 'nothing sent');
		assert.ok(errors.some((e) => e.includes('late (line 12): a Redpanda Cloud secret name must match')), errors.join('\n'));
	});

	test('UNCHANGED 5.6: the deployed config is the translation of the saved file: "nothing changed", no PUT', async () => {
		const { doc } = await deployOnce(VARS);
		assert.strictEqual(fake.cluster('cvilnius0000000000aa').pipelines[0].config_yaml, VARS_SENT);
		script({});
		const result = await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri);
		assert.strictEqual(result?.kind, 'unchanged', errors.join('\n'));
		assert.strictEqual(puts().length, 0);
		assert.strictEqual(diffTabs().length, 0);
	});

	test('DIFF 5.6: an update of a running pipeline: the diff\'s right side is the translated text (read-only), and that text is sent', async () => {
		const { doc } = await deployOnce(VARS);
		const changed = VARS.replace('${TOPIC:orders}', '${TOPIC:payments}');
		await editConfig(doc, changed);
		script({ confirms: [undefined] });
		assert.strictEqual((await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri))?.kind, 'notStarted');
		const tabs = diffTabs();
		assert.strictEqual(tabs.length, 1);
		const input = tabs[0].input as vscode.TabInputTextDiff;
		assert.strictEqual(input.modified.scheme, DEPLOYED_SCHEME, 'not the file');
		assert.strictEqual((await vscode.workspace.openTextDocument(input.original)).getText(), VARS_SENT);
		assert.strictEqual((await vscode.workspace.openTextDocument(input.modified)).getText(), VARS_SENT.replace('${secrets.TOPIC:orders}', '${secrets.TOPIC:payments}'));
		script({ confirms: [REPLACE_ACTION] });
		assert.strictEqual((await vscode.commands.executeCommand<{ kind: string }>(DEPLOY_COMMAND, doc.uri))?.kind, 'final', errors.join('\n'));
		assert.strictEqual(JSON.parse(puts()[0].body).config_yaml, VARS_SENT.replace('${secrets.TOPIC:orders}', '${secrets.TOPIC:payments}'));
		assert.strictEqual(fs.readFileSync(configFile, 'utf8'), changed, 'the file as saved');
	});

	// --- ticket 5.4: start, stop and delete a pipeline ---

	const VILNIUS = 'cvilnius0000000000aa';
	const pipelineRow = (name: string) => items().find((i) => i.node.kind === 'pipeline' && i.label === name);
	/** The starts, stops and deletes since this test began. */
	const lifecycle = () => fake.requests.slice(firstRequest)
		.filter((r) => r.method === 'DELETE' || (r.method === 'PUT' && /\/(start|stop)$/.test(r.url)))
		.map((r) => `${r.method} ${r.url}`);
	const pipelineUrl = (id: string) => `/dp/${VILNIUS}/v1/redpanda-connect/pipelines/${id}`;
	type ActionResult = { kind: string; state?: string; error?: string; alreadyGone?: boolean; mappings?: string[]; pipelineId?: string };
	const run = (command: string, node?: CloudItem['node']) => vscode.commands.executeCommand<ActionResult>(command, node);

	function seed(id: string, name: string, state: string, extra: Partial<FakePipeline> = {}): FakePipeline {
		const p: FakePipeline = {
			id, display_name: name, description: '', config_yaml: CONFIG, resources: { cpu_shares: '100m', memory_shares: '400M' }, tags: {}, state, sequence: [], ...extra,
		};
		fake.cluster(VILNIUS).pipelines.push(p);
		return p;
	}

	async function showPipelines(): Promise<void> {
		await connect();
		await cloud().refresh({ kind: 'cluster', id: VILNIUS });
	}

	/** The commands a pipeline row with `contextValue` offers, per package.json's `view/item/context` regexes. */
	function offers(contextValue: string): string[] {
		const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as { contributes: { menus: Record<string, { command: string; when?: string }[]> } };
		const out = new Set<string>();
		for (const m of pkg.contributes.menus['view/item/context']) {
			const regex = /viewItem =~ \/(.+)\/$/.exec(m.when ?? '');
			if ([START_COMMAND, STOP_COMMAND, DELETE_COMMAND].includes(m.command) && regex && new RegExp(regex[1]).test(contextValue)) {
				out.add(m.command);
			}
		}
		return [START_COMMAND, STOP_COMMAND, DELETE_COMMAND].filter((c) => out.has(c));
	}

	test('package.json: Start, Stop and Delete pipeline… in the palette when connected, inline and in the row\'s menu by state (Delete last)', () => {
		const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as {
			contributes: { commands: { command: string; title: string }[]; menus: Record<string, { command: string; when?: string; group?: string }[]> };
		};
		assert.deepStrictEqual([START_COMMAND, STOP_COMMAND, DELETE_COMMAND].map((c) => pkg.contributes.commands.find((x) => x.command === c)?.title),
			['Start pipeline', 'Stop pipeline', 'Delete pipeline…']);
		for (const c of [START_COMMAND, STOP_COMMAND, DELETE_COMMAND]) {
			assert.strictEqual(pkg.contributes.menus.commandPalette.find((m) => m.command === c)?.when, 'redpandaConnect.cloud.connected');
			const groups = pkg.contributes.menus['view/item/context'].filter((m) => m.command === c).map((m) => m.group?.split('@')[0]);
			assert.deepStrictEqual(groups, ['inline', c === DELETE_COMMAND ? '9_delete' : '1_actions']);
		}
		assert.deepStrictEqual(offers('cloudPipeline state-stopping'), [DELETE_COMMAND], 'not "stopped"');
		assert.deepStrictEqual(offers('cloudCluster'), []);
	});

	test('STATES and ERROR_ROW: each state its own label, icon and actions; an unknown state by its raw name, Delete only; Error with its reason or none', async () => {
		seed('p00000000000000start', 'starting', 'STATE_STARTING');
		seed('p0000000000000000run', 'running', 'STATE_RUNNING');
		seed('p0000000000000stopng', 'stopping', 'STATE_STOPPING');
		seed('p000000000000stopped', 'stopped', 'STATE_STOPPED');
		seed('p00000000000complete', 'completed', 'STATE_COMPLETED');
		seed('p000000000000errwhy', 'error-why', 'STATE_ERROR', { status: { error: 'out of memory' } });
		seed('p00000000000errnowhy', 'error-none', 'STATE_ERROR');
		seed('p000000000000paused', 'paused', 'STATE_PAUSED');
		await showPipelines();
		const rows = items().filter((i) => i.node.kind === 'pipeline').map((i) => [i.label, i.description, i.icon, i.contextValue, offers(i.contextValue)]);
		assert.deepStrictEqual(rows, [
			['starting', 'Starting', 'sync~spin', 'cloudPipeline state-starting', [STOP_COMMAND, DELETE_COMMAND]],
			['running', 'Running', 'pass', 'cloudPipeline state-running', [STOP_COMMAND, DELETE_COMMAND]],
			['stopping', 'Stopping', 'loading~spin', 'cloudPipeline state-stopping', [DELETE_COMMAND]],
			['stopped', 'Stopped', 'circle-slash', 'cloudPipeline state-stopped', [START_COMMAND, DELETE_COMMAND]],
			['completed', 'Completed', 'check', 'cloudPipeline state-completed', [START_COMMAND, DELETE_COMMAND]],
			['error-why', 'Error (out of memory)', 'error', 'cloudPipeline state-error', [START_COMMAND, DELETE_COMMAND]],
			['error-none', `Error (${NO_REASON})`, 'error', 'cloudPipeline state-error', [START_COMMAND, DELETE_COMMAND]],
			['paused', 'STATE_PAUSED', 'circle-large-outline', 'cloudPipeline state-unknown', [DELETE_COMMAND]],
		]);
		const icons = ['starting', 'stopping', 'completed', 'paused'].map((n) => pipelineRow(n)!.icon);
		assert.strictEqual(new Set(icons).size, icons.length, `each its own icon: ${icons.join(', ')}`);
		assert.ok(pipelineRow('error-why')!.tooltip.includes('Error (out of memory)'), pipelineRow('error-why')!.tooltip);
		assert.ok(pipelineRow('error-none')!.tooltip.includes(`Error (${NO_REASON})`));
	});

	test('ACCEPTANCE: a running pipeline stopped, started and deleted from its row: PUT …/stop, PUT …/start and one DELETE for that id, in that order; the row ends gone', async () => {
		const id = 'p0000000000000orders';
		seed(id, 'orders', 'STATE_RUNNING');
		await showPipelines();
		const stopped = await run(STOP_COMMAND, pipelineRow('orders')!.node);
		assert.strictEqual(stopped?.kind, 'final', errors.join('\n'));
		assert.strictEqual(stopped?.state, 'STATE_STOPPED');
		assert.deepStrictEqual(progressTitles.slice(-1), ['Stopping orders on rpc-vilnius']);
		assert.ok(progressReports.includes('Stopping…'), progressReports.join(', '));
		assert.deepStrictEqual(infos.slice(-1), ['Pipeline orders on rpc-vilnius is stopped.']);
		assert.strictEqual(pipelineRow('orders')!.description, 'Stopped');
		assert.deepStrictEqual(offers(pipelineRow('orders')!.contextValue), [START_COMMAND, DELETE_COMMAND], 'the row offers Start');

		const started = await run(START_COMMAND, pipelineRow('orders')!.node);
		assert.strictEqual(started?.kind, 'final', errors.join('\n'));
		assert.strictEqual(started?.state, 'STATE_RUNNING');
		assert.ok(progressReports.includes('Starting…'));
		assert.deepStrictEqual(infos.slice(-1), ['Pipeline orders on rpc-vilnius is running.']);
		assert.strictEqual(pipelineRow('orders')!.description, 'Running');

		script({ confirms: [DELETE_ACTION] });
		const deleted = await run(DELETE_COMMAND, pipelineRow('orders')!.node);
		assert.strictEqual(deleted?.kind, 'deleted', errors.join('\n'));
		assert.strictEqual(deleted?.alreadyGone, false);
		assert.deepStrictEqual(confirmed, [{ message: 'Delete orders on rpc-vilnius? This cannot be undone.', actions: [DELETE_ACTION] }]);
		assert.deepStrictEqual(lifecycle(), [`PUT ${pipelineUrl(id)}/stop`, `PUT ${pipelineUrl(id)}/start`, `DELETE ${pipelineUrl(id)}`]);
		const afterDelete = fake.requests.slice(fake.requests.findIndex((r) => r.method === 'DELETE' && r.url === pipelineUrl(id)));
		assert.ok(afterDelete.some((r) => r.method === 'GET' && r.url === pipelineUrl(id)), 'followed until a GET answers 404');
		assert.strictEqual(pipelineRow('orders'), undefined, 'the row is gone');
		assert.deepStrictEqual(infos.slice(-1), ['Deleted pipeline orders on rpc-vilnius.']);
		assert.strictEqual(fake.cluster(VILNIUS).pipelines.length, 0);
		assert.strictEqual(errors.length, 0, errors.join('\n'));
	});

	test('STOP failing: the API\'s message; the cluster\'s pipelines read again', async () => {
		seed('p0000000000000orders', 'orders', 'STATE_RUNNING');
		await showPipelines();
		fake.failures = [{ when: (r) => r.method === 'PUT' && r.url.endsWith('/stop'), status: 503, body: { code: 'UNAVAILABLE', message: 'stop is down', details: [] } }];
		const at = fake.requests.length;
		const result = await run(STOP_COMMAND, pipelineRow('orders')!.node);
		assert.strictEqual(result?.kind, 'failed');
		assert.deepStrictEqual(errors, ['Could not stop pipeline orders on rpc-vilnius: stop is down']);
		assert.deepStrictEqual(fake.requests.slice(at).map((r) => `${r.method} ${r.url.replace(/\?.*$/, '')}`),
			[`GET ${pipelineUrl('p0000000000000orders')}`, `PUT ${pipelineUrl('p0000000000000orders')}/stop`, `GET /dp/${VILNIUS}/v1/redpanda-connect/pipelines`],
			'read first, then the row re-read');
		assert.strictEqual(pipelineRow('orders')!.description, 'Running');
	});

	test('STOP accepted, its state unreadable: "Stopped …, but its state could not be read"; a 401 while following offers Connect', async () => {
		const id = 'p0000000000000orders';
		seed(id, 'orders', 'STATE_RUNNING');
		await showPipelines();
		const stopSent = () => fake.requests.slice(firstRequest).some((r) => r.method === 'PUT' && r.url === `${pipelineUrl(id)}/stop`);
		fake.failures = [{
			when: (r) => r.method === 'GET' && r.url === pipelineUrl(id) && stopSent(),
			status: 401, body: { code: 'UNAUTHENTICATED', message: 'token is expired or revoked', details: [] }, times: 100,
		}];
		script({ actions: [undefined] });
		const result = await run(STOP_COMMAND, pipelineRow('orders')!.node);
		assert.strictEqual(result?.kind, 'failed');
		assert.strictEqual(errors.length, 1, errors.join('\n'));
		assert.match(errors[0], /^Stopped pipeline orders on rpc-vilnius, but its state could not be read: /);
		assert.ok(!errors[0].includes('Could not stop'), errors[0]);
		assert.deepStrictEqual(errorActions[0], [CONNECT_ACTION]);
	});

	test('STALE state: a row cached as Stopped while the cluster has it in Error: the state is read first and followed from Error', async () => {
		const p = seed('p0000000000000orders', 'orders', 'STATE_STOPPED');
		await showPipelines();
		p.state = 'STATE_ERROR';
		// The start's answer still in Error: from the fresh state it is not final until it changes.
		fake.startSequence = [{ state: 'STATE_ERROR' }, { state: 'STATE_STARTING' }, { state: 'STATE_RUNNING' }];
		assert.strictEqual(pipelineRow('orders')!.description, 'Stopped');
		const result = await run(START_COMMAND, pipelineRow('orders')!.node);
		assert.strictEqual(result?.kind, 'final', errors.join('\n'));
		assert.strictEqual(result?.state, 'STATE_RUNNING');
		assert.deepStrictEqual(errors, []);
	});

	test('START: progress until Running or Error; Error with the cluster\'s reason or "the cluster gave no reason"', async () => {
		seed('p0000000000000orders', 'orders', 'STATE_STOPPED');
		await showPipelines();
		fake.startSequence = [{ state: 'STATE_STARTING' }, { state: 'STATE_STARTING' }, { state: 'STATE_ERROR', error: 'bad input' }];
		const first = await run(START_COMMAND, pipelineRow('orders')!.node);
		assert.strictEqual(first?.state, 'STATE_ERROR');
		assert.strictEqual(first?.error, 'bad input');
		assert.deepStrictEqual(errors, ['Pipeline orders on rpc-vilnius is in Error: bad input.']);
		assert.strictEqual(pipelineRow('orders')!.description, 'Error (bad input)');
		fake.startSequence = [{ state: 'STATE_STARTING' }, { state: 'STATE_ERROR' }];
		const second = await run(START_COMMAND, pipelineRow('orders')!.node);
		assert.strictEqual(second?.state, 'STATE_ERROR');
		assert.strictEqual(errors[1], `Pipeline orders on rpc-vilnius is in Error: ${NO_REASON}.`);
		assert.strictEqual(pipelineRow('orders')!.description, `Error (${NO_REASON})`);
		assert.strictEqual(lifecycle().length, 2);
	});

	test('DELETE: Cancel sends nothing; already gone (404): the row removed, said so', async () => {
		const id = 'p0000000000000orders';
		seed(id, 'orders', 'STATE_STOPPED');
		await showPipelines();
		script({ confirms: [undefined] });
		assert.strictEqual((await run(DELETE_COMMAND, pipelineRow('orders')!.node))?.kind, 'notStarted');
		assert.deepStrictEqual(lifecycle(), [], 'nothing sent');
		assert.ok(pipelineRow('orders'));
		fake.cluster(VILNIUS).pipelines = [];
		script({ confirms: [DELETE_ACTION] });
		const gone = await run(DELETE_COMMAND, pipelineRow('orders')!.node);
		assert.strictEqual(gone?.kind, 'deleted');
		assert.strictEqual(gone?.alreadyGone, true);
		assert.deepStrictEqual(infos.slice(-1), ['Pipeline orders was already gone from rpc-vilnius; it is removed from the view.']);
		assert.strictEqual(pipelineRow('orders'), undefined);
		assert.deepStrictEqual(errors, []);
	});

	test('STALE: a pipeline deleted in the Cloud meanwhile: Stop shows the API\'s error and the cluster\'s pipelines are read again', async () => {
		const id = 'p0000000000000orders';
		seed(id, 'orders', 'STATE_RUNNING');
		await showPipelines();
		fake.cluster(VILNIUS).pipelines = [];
		const result = await run(STOP_COMMAND, pipelineRow('orders')!.node);
		assert.strictEqual(result?.kind, 'failed');
		assert.deepStrictEqual(errors, ['Could not stop pipeline orders on rpc-vilnius: pipeline not found']);
		assert.deepStrictEqual(lifecycle(), [], 'the read found it gone: nothing sent');
		assert.strictEqual(pipelineRow('orders'), undefined, 're-read: the row is gone');
		assert.ok(items().some((i) => i.label === 'No pipelines.'));
	});

	test('DELETE_MAPPED: the confirmation names the .cloud.json mapping a config to the pipeline; it is deleted after the DELETE, the config untouched; another pipeline\'s mapping is left', async () => {
		const { doc, id } = await deployOnce();
		const rel = vscode.workspace.asRelativePath(doc.uri, false);
		// A second pipeline tagged with the same file, which the mapping does not name.
		seed('p00000000000000copy', 'copy', 'STATE_STOPPED', { tags: { [CONFIG_TAG]: rel } });
		await cloud().refresh({ kind: 'cluster', id: VILNIUS });
		const mapping = fs.readFileSync(sidecarFile(), 'utf8');
		script({ confirms: [DELETE_ACTION] });
		assert.strictEqual((await run(DELETE_COMMAND, pipelineRow('copy')!.node))?.kind, 'deleted', errors.join('\n'));
		assert.strictEqual(confirmed[0].message, 'Delete copy on rpc-vilnius? This cannot be undone.', 'the mapping names another pipeline');
		assert.strictEqual(fs.readFileSync(sidecarFile(), 'utf8'), mapping, 'left');

		// No active config: the tag names a file outside every workspace folder (none is open), so it is not looked at.
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		script({ confirms: [undefined] });
		assert.strictEqual((await run(DELETE_COMMAND, pipelineRow('orders')!.node))?.kind, 'notStarted');
		assert.strictEqual(confirmed[0].message, 'Delete orders on rpc-vilnius? This cannot be undone.', 'a tag outside the workspace is ignored');

		await vscode.window.showTextDocument(doc.uri);
		script({ confirms: [DELETE_ACTION] });
		const deleted = await run(DELETE_COMMAND, pipelineRow('orders')!.node);
		assert.strictEqual(deleted?.kind, 'deleted', errors.join('\n'));
		const shown = vscode.workspace.asRelativePath(sidecarFile());
		assert.strictEqual(confirmed[0].message,
			`Delete orders on rpc-vilnius? This cannot be undone. ${shown}, which maps a config to it, is deleted too; the config is not changed.`);
		assert.deepStrictEqual(deleted?.mappings, [sidecarFile()]);
		assert.ok(!fs.existsSync(sidecarFile()), 'the mapping is deleted');
		assert.strictEqual(fs.readFileSync(configFile, 'utf8'), CONFIG, 'the config is untouched');
		assert.deepStrictEqual(infos.slice(-1), [`Deleted pipeline orders on rpc-vilnius. Deleted ${shown}.`]);
		assert.ok(lifecycle().includes(`DELETE ${pipelineUrl(id)}`));
	});

	test('PALETTE: the active config\'s mapped pipeline (its state checked), else a pick of every pipeline; none chosen: nothing sent; the mapped pipeline gone: said so', async () => {
		const { doc, id } = await deployOnce();
		// Start on the mapped running pipeline: not offered, nothing sent.
		const notOffered = await run(START_COMMAND);
		assert.strictEqual(notOffered?.kind, 'notOffered');
		assert.deepStrictEqual(infos.slice(-1), ['Pipeline orders on rpc-vilnius is running: only a stopped, failed or completed pipeline can be started.']);
		const stopped = await run(STOP_COMMAND);
		assert.strictEqual(stopped?.kind, 'final', errors.join('\n'));
		assert.strictEqual(stopped?.pipelineId, id);
		assert.strictEqual(pipelinesOffered.length, 0, 'no pick: the mapping names it');
		assert.deepStrictEqual(lifecycle(), [`PUT ${pipelineUrl(id)}/stop`]);

		// No active config: a pick of every pipeline on the clusters.
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		fake.cluster('cbyoc000000000000bbb').pipelines.push({
			id: 'pbyoc00000000000other', display_name: 'other', description: '', config_yaml: CONFIG,
			resources: { cpu_shares: '100m', memory_shares: '400M' }, tags: {}, state: 'STATE_STOPPED', sequence: [],
		});
		script({ pipelinePicks: [undefined] });
		assert.strictEqual((await run(START_COMMAND))?.kind, 'notStarted');
		assert.deepStrictEqual(pipelinesOffered[0].map((c) => `${c.pipeline.displayName}@${c.cluster.name}`), ['orders@rpc-vilnius', 'other@byoc-eu']);
		assert.strictEqual(lifecycle().length, 1, 'none chosen: nothing sent');
		script({ pipelinePicks: ['other'] });
		const started = await run(START_COMMAND);
		assert.strictEqual(started?.kind, 'final', errors.join('\n'));
		assert.strictEqual(started?.state, 'STATE_RUNNING');
		assert.deepStrictEqual(lifecycle().slice(-1), ['PUT /dp/cbyoc000000000000bbb/v1/redpanda-connect/pipelines/pbyoc00000000000other/start']);

		// The mapped pipeline deleted in the Cloud: said so, nothing sent, no pick.
		await vscode.window.showTextDocument(doc.uri);
		fake.cluster(VILNIUS).pipelines = [];
		script({ confirms: [DELETE_ACTION] });
		assert.strictEqual((await run(DELETE_COMMAND))?.kind, 'notStarted');
		assert.deepStrictEqual(infos.slice(-1), ['Pipeline orders, which orders.cloud.json maps orders.yaml to, is no longer on rpc-vilnius.']);
		assert.strictEqual(confirmed.length, 0);
		assert.strictEqual(pipelinesOffered.length, 0);
		assert.ok(!lifecycle().some((l) => l.startsWith('DELETE')));
		assert.ok(fs.existsSync(sidecarFile()), 'the mapping stays');
	});

	test('PALETTE delete of the mapped pipeline: the active config\'s .cloud.json named and deleted', async () => {
		const { id } = await deployOnce();
		script({ confirms: [DELETE_ACTION] });
		const deleted = await run(DELETE_COMMAND);
		assert.strictEqual(deleted?.kind, 'deleted', errors.join('\n'));
		assert.strictEqual(deleted?.pipelineId, id);
		assert.ok(confirmed[0].message.includes('orders.cloud.json'), confirmed[0].message);
		assert.ok(!fs.existsSync(sidecarFile()));
		assert.strictEqual(fs.readFileSync(configFile, 'utf8'), CONFIG);
	});

	// --- ticket 5.5: the row's file, the deployed config, Compare, Deploy again and Copy pipeline ID ---

	const ROW_COMMANDS = [OPEN_DEPLOYED_COMMAND, COMPARE_COMMAND, DEPLOY_AGAIN_COMMAND, START_COMMAND, STOP_COMMAND, COPY_ID_COMMAND, DELETE_COMMAND];
	/** Every row command a `contextValue` offers in the row's menu, per package.json. */
	function rowOffers(contextValue: string): string[] {
		const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as { contributes: { menus: Record<string, { command: string; when?: string; group?: string }[]> } };
		const out = new Set<string>();
		for (const m of pkg.contributes.menus['view/item/context']) {
			const regex = /viewItem =~ \/(.+)\/$/.exec(m.when ?? '');
			if (m.group?.startsWith('inline') !== true && regex && new RegExp(regex[1]).test(contextValue)) {
				out.add(m.command);
			}
		}
		return ROW_COMMANDS.filter((c) => out.has(c));
	}
	const inWorkspace = () => {
		cloud().workspaceFolders = () => [dir];
	};
	const activeTabLabel = () => vscode.window.tabGroups.activeTabGroup.activeTab?.label;
	const gets = (id: string) => fake.requests.slice(firstRequest).filter((r) => r.method === 'GET' && r.url === pipelineUrl(id)).length;

	test('package.json 5.5: the four row commands hidden from the palette; Open inline; menus by state and file, Delete last', () => {
		const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as {
			contributes: { commands: { command: string; title: string }[]; menus: Record<string, { command: string; when?: string; group?: string }[]> };
		};
		const added = [OPEN_DEPLOYED_COMMAND, COMPARE_COMMAND, DEPLOY_AGAIN_COMMAND, COPY_ID_COMMAND];
		assert.deepStrictEqual(added.map((c) => pkg.contributes.commands.find((x) => x.command === c)?.title),
			['Open deployed config', 'Compare with local file', 'Deploy local file again', 'Copy pipeline ID']);
		for (const c of added) {
			assert.strictEqual(pkg.contributes.menus.commandPalette.find((m) => m.command === c)?.when, 'false', `${c}: needs a row`);
		}
		const groups = pkg.contributes.menus['view/item/context'].filter((m) => ROW_COMMANDS.includes(m.command) && !m.group?.startsWith('inline'))
			.map((m) => `${m.group}:${m.command}`).sort();
		assert.deepStrictEqual(groups, [
			`0_open@1:${OPEN_DEPLOYED_COMMAND}`, `0_open@2:${COMPARE_COMMAND}`, `0_open@3:${DEPLOY_AGAIN_COMMAND}`,
			`1_actions@1:${START_COMMAND}`, `1_actions@2:${STOP_COMMAND}`, `8_copy@1:${COPY_ID_COMMAND}`, `9_delete@1:${DELETE_COMMAND}`,
		]);
		assert.ok(pkg.contributes.menus['view/item/context'].some((m) => m.command === OPEN_DEPLOYED_COMMAND && m.group === 'inline@0'), 'an inline icon for Open');
		const always = [OPEN_DEPLOYED_COMMAND, COMPARE_COMMAND, COPY_ID_COMMAND, DELETE_COMMAND];
		const lifecycle = { running: [STOP_COMMAND], starting: [STOP_COMMAND], stopping: [], stopped: [START_COMMAND], error: [START_COMMAND], completed: [START_COMMAND], unknown: [] };
		for (const [state, actions] of Object.entries(lifecycle)) {
			for (const hasFile of [false, true]) {
				const value = `cloudPipeline state-${state}${hasFile ? ' hasFile' : ''}`;
				const expected = ROW_COMMANDS.filter((c) => always.includes(c) || (actions as string[]).includes(c) || (hasFile && c === DEPLOY_AGAIN_COMMAND));
				assert.deepStrictEqual(rowOffers(value), expected, value);
			}
		}
		assert.deepStrictEqual(rowOffers('cloudCluster'), []);
	});

	test('ROW_FILE: "Running · orders.yaml" for a workspace file (the tooltip its path); "· not in this workspace" outside or missing; no tag: the state only', async () => {
		inWorkspace();
		fs.writeFileSync(configFile, CONFIG);
		seed('p0000000000000orders', 'orders', 'STATE_RUNNING', { tags: { [CONFIG_TAG]: 'orders.yaml' } });
		seed('p00000000000absolute', 'absolute', 'STATE_STOPPED', { tags: { [CONFIG_TAG]: configFile } });
		seed('p00000000000000error', 'failing', 'STATE_ERROR', { tags: { [CONFIG_TAG]: 'orders.yaml' }, status: { error: 'boom' } });
		seed('p0000000000outside', 'outside', 'STATE_RUNNING', { tags: { [CONFIG_TAG]: path.resolve('/elsewhere/orders.yaml') } });
		seed('p00000000000climbs', 'climbs', 'STATE_RUNNING', { tags: { [CONFIG_TAG]: '../orders.yaml' } });
		seed('p0000000000missing', 'missing', 'STATE_RUNNING', { tags: { [CONFIG_TAG]: 'gone.yaml' } });
		seed('p000000000000untagged', 'untagged', 'STATE_RUNNING');
		await showPipelines();
		const rows = items().filter((i) => i.node.kind === 'pipeline').map((i) => [i.label, i.description, i.contextValue]);
		assert.deepStrictEqual(rows, [
			['orders', 'Running · orders.yaml', 'cloudPipeline state-running hasFile'],
			['absolute', 'Stopped · orders.yaml', 'cloudPipeline state-stopped hasFile'],
			['failing', 'Error (boom) · orders.yaml', 'cloudPipeline state-error hasFile'],
			['outside', `Running · ${NOT_IN_WORKSPACE}`, 'cloudPipeline state-running'],
			['climbs', `Running · ${NOT_IN_WORKSPACE}`, 'cloudPipeline state-running'],
			['missing', `Running · ${NOT_IN_WORKSPACE}`, 'cloudPipeline state-running'],
			['untagged', 'Running', 'cloudPipeline state-running'],
		]);
		assert.ok(pipelineRow('orders')!.tooltip.includes(`Deployed from ${configFile}.`), pipelineRow('orders')!.tooltip);
		assert.ok(pipelineRow('missing')!.tooltip.includes(`Deployed from gone.yaml, which is ${NOT_IN_WORKSPACE}.`), pipelineRow('missing')!.tooltip);
		assert.ok(pipelineRow('orders')!.accessibility.includes('orders.yaml'));
		// Outside every workspace folder (the stable run's default: none), the same tag is not looked at.
		cloud().workspaceFolders = () => [];
		assert.strictEqual(pipelineRow('orders')!.description, `Running · ${NOT_IN_WORKSPACE}`);
		assert.deepStrictEqual(rowOffers(pipelineRow('orders')!.contextValue), [OPEN_DEPLOYED_COMMAND, COMPARE_COMMAND, STOP_COMMAND, COPY_ID_COMMAND, DELETE_COMMAND]);
	});

	test('ACCEPTANCE 5.5 and OPEN: a click on the row reads the pipeline now and shows its config read-only, titled "<name> (deployed)"', async () => {
		inWorkspace();
		fs.writeFileSync(configFile, CONFIG);
		const id = 'p0000000000000orders';
		const p = seed(id, 'orders', 'STATE_RUNNING', { tags: { [CONFIG_TAG]: 'orders.yaml' } });
		await showPipelines();
		const click = async () => {
			const item = cloud().getTreeItem(pipelineRow('orders')!.node);
			assert.strictEqual(item.command?.command, OPEN_DEPLOYED_COMMAND);
			return vscode.commands.executeCommand<{ kind: string; uri?: string }>(item.command!.command, ...(item.command!.arguments ?? []));
		};
		const first = await click();
		assert.strictEqual(first?.kind, 'opened', errors.join('\n'));
		assert.strictEqual(gets(id), 1, 'read now');
		let editor = vscode.window.activeTextEditor!;
		assert.strictEqual(editor.document.uri.scheme, DEPLOYED_SCHEME);
		assert.strictEqual(editor.document.uri.toString(), first!.uri);
		assert.strictEqual(editor.document.getText(), CONFIG);
		assert.strictEqual(editor.document.languageId, 'yaml');
		assert.strictEqual(activeTabLabel(), 'orders (deployed)');

		// Changed in the Cloud: the next click shows the config the fake holds now.
		p.config_yaml = CONFIG.replace('root.n = 1', 'root.n = 2');
		const second = await click();
		assert.strictEqual(second?.kind, 'opened');
		assert.strictEqual(gets(id), 2);
		editor = vscode.window.activeTextEditor!;
		assert.strictEqual(editor.document.getText(), p.config_yaml);
		assert.ok(!fs.readdirSync(dir).some((f) => f.includes('deployed')), 'nothing written to disk');
		assert.strictEqual(fs.readFileSync(configFile, 'utf8'), CONFIG);
		assert.deepStrictEqual(errors, []);
	});

	test('OPEN: 404 "the pipeline is gone" and the cluster\'s pipelines read again; another error: the API\'s message', async () => {
		const id = 'p0000000000000orders';
		seed(id, 'orders', 'STATE_RUNNING');
		await showPipelines();
		fake.failures = [{ when: (r) => r.method === 'GET' && r.url === pipelineUrl(id), status: 503, body: { code: 'UNAVAILABLE', message: 'the data plane is down', details: [] } }];
		assert.strictEqual((await run(OPEN_DEPLOYED_COMMAND, pipelineRow('orders')!.node))?.kind, 'failed');
		assert.deepStrictEqual(errors, ['Could not read pipeline orders on rpc-vilnius: the data plane is down']);
		assert.ok(pipelineRow('orders'));
		fake.cluster(VILNIUS).pipelines = [];
		const at = fake.requests.length;
		assert.strictEqual((await run(OPEN_DEPLOYED_COMMAND, pipelineRow('orders')!.node))?.kind, 'gone');
		assert.deepStrictEqual(infos.slice(-1), ['Pipeline orders is gone from rpc-vilnius; the Cloud view reads its pipelines again.']);
		assert.ok(fake.requests.slice(at).some((r) => r.method === 'GET' && r.url.replace(/\?.*$/, '') === `/dp/${VILNIUS}/v1/redpanda-connect/pipelines`), 're-read');
		assert.strictEqual(pipelineRow('orders'), undefined);
		assert.ok(items().some((i) => i.label === 'No pipelines.'));
		assert.strictEqual(errors.length, 1);
	});

	test('COMPARE: deployed (read now, read-only) ↔ the local file (editable), "<name> (deployed) ↔ orders.yaml"; ${VAR} against ${secrets.VAR} differs; not in the workspace: said so, nothing opened', async () => {
		inWorkspace();
		const { doc, id } = await deployOnce(VARS);
		const at = gets(id);
		const result = await run(COMPARE_COMMAND, pipelineRow('orders')!.node);
		assert.strictEqual(result?.kind, 'opened', errors.join('\n'));
		assert.strictEqual(gets(id), at + 1, 'read now');
		const tabs = diffTabs();
		assert.strictEqual(tabs.length, 1);
		assert.strictEqual(tabs[0].label, 'orders (deployed) ↔ orders.yaml');
		const input = tabs[0].input as vscode.TabInputTextDiff;
		assert.strictEqual(input.modified.scheme, 'file', 'the local file itself');
		assert.strictEqual(input.modified.fsPath, doc.uri.fsPath);
		assert.strictEqual((await vscode.workspace.openTextDocument(input.original)).getText(), VARS_SENT, 'the deployed config');
		assert.notStrictEqual((await vscode.workspace.openTextDocument(input.modified)).getText(), VARS_SENT, '${VAR} against ${secrets.VAR}');
		const edit = new vscode.WorkspaceEdit();
		edit.insert(input.modified, new vscode.Position(0, 0), '# edited\n');
		assert.ok(await vscode.workspace.applyEdit(edit), 'editable');
		assert.ok(await doc.save());
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		fs.writeFileSync(configFile, VARS);

		cloud().workspaceFolders = () => [];
		const before = fake.requests.length;
		assert.strictEqual((await run(COMPARE_COMMAND, pipelineRow('orders')!.node))?.kind, 'notInWorkspace');
		assert.deepStrictEqual(infos.slice(-1), [`Pipeline orders was deployed from ${configFile}, which is ${NOT_IN_WORKSPACE}, so there is no local file to compare with.`]);
		assert.strictEqual(diffTabs().length, 0);
		assert.strictEqual(fake.requests.length, before, 'nothing requested');
	});

	test('DEPLOY_AGAIN: the file\'s .cloud.json maps to this pipeline: the normal Deploy (diff, confirmation, PUT); another pipeline or none: explained, nothing sent; not in the workspace: said so', async () => {
		inWorkspace();
		const { doc, id } = await deployOnce();
		await editConfig(doc, CONFIG.replace('root.n = 1', 'root.n = 3'));
		await doc.save();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		assert.ok(rowOffers(pipelineRow('orders')!.contextValue).includes(DEPLOY_AGAIN_COMMAND));
		script({ confirms: [REPLACE_ACTION] });
		const again = await run(DEPLOY_AGAIN_COMMAND, pipelineRow('orders')!.node);
		assert.strictEqual(again?.kind, 'final', errors.join('\n'));
		assert.strictEqual(again?.pipelineId, id);
		assert.strictEqual(confirmed.length, 1, 'running: the update flow\'s confirmation');
		assert.strictEqual(unitsAsked, 1, 'the size pick');
		assert.deepStrictEqual(puts().map((r) => r.url), [pipelineUrl(id)]);
		assert.strictEqual(JSON.parse(puts()[0].body).config_yaml, CONFIG.replace('root.n = 1', 'root.n = 3'));
		assert.strictEqual(posts().length, 1, 'only deployOnce\'s create');

		// Gone by the time the deploy reads it (after the row's mapping check): explained, no create offered, nothing sent.
		fake.failures = [{ when: (r) => r.method === 'GET' && r.url === pipelineUrl(id), status: 404, body: { code: 'NOT_FOUND', message: 'pipeline not found', details: [] } }];
		// Were Create a new pipeline offered, this script would take it.
		script({ actions: [CREATE_NEW_PIPELINE_ACTION], inputs: ['new-one'], picks: ['rpc-vilnius'] });
		const putsBefore = puts().length;
		const gone = await run(DEPLOY_AGAIN_COMMAND, pipelineRow('orders')!.node);
		assert.strictEqual(gone?.kind, 'notStarted');
		assert.deepStrictEqual(infos.slice(-1), ['Pipeline orders, which orders.cloud.json maps orders.yaml to, is no longer on rpc-vilnius. Nothing was sent.']);
		assert.ok(!infos.some((m) => m.includes('Create a new pipeline')), 'no create offer');
		assert.strictEqual(asked.length, 0, 'no name asked');
		assert.strictEqual(posts().length, 1, 'no POST');
		assert.strictEqual(puts().length, putsBefore, 'no PUT');
		assert.strictEqual(unitsAsked, 0);
		fake.failures = [];

		// A second pipeline tagged with the same file: the mapping names the first.
		seed('p00000000000000copy', 'copy', 'STATE_STOPPED', { tags: { [CONFIG_TAG]: vscode.workspace.asRelativePath(doc.uri, false) } });
		await cloud().refresh({ kind: 'cluster', id: VILNIUS });
		const sent = fake.requests.length;
		script({});
		const other = await run(DEPLOY_AGAIN_COMMAND, pipelineRow('copy')!.node);
		assert.strictEqual(other?.kind, 'notMapped');
		assert.deepStrictEqual(infos.slice(-1), ['orders.cloud.json maps orders.yaml to pipeline orders, not to copy on rpc-vilnius. Deploy orders.yaml from its editor to choose where it goes. Nothing was sent.']);
		fs.rmSync(sidecarFile());
		const none = await run(DEPLOY_AGAIN_COMMAND, pipelineRow('orders')!.node);
		assert.strictEqual(none?.kind, 'notMapped');
		assert.deepStrictEqual(infos.slice(-1), ['orders.yaml has no orders.cloud.json, so a Deploy of it would not update orders. Deploy orders.yaml from its editor to choose where it goes. Nothing was sent.']);
		fs.writeFileSync(sidecarFile(), 'not json');
		assert.strictEqual((await run(DEPLOY_AGAIN_COMMAND, pipelineRow('orders')!.node))?.kind, 'notMapped');
		assert.match(infos[infos.length - 1], /^orders\.cloud\.json is not a deploy mapping \(it is not JSON/);
		cloud().workspaceFolders = () => [];
		assert.strictEqual((await run(DEPLOY_AGAIN_COMMAND, pipelineRow('orders')!.node))?.kind, 'notInWorkspace');
		assert.deepStrictEqual(infos.slice(-1), [`Pipeline orders was deployed from ${configFile}, which is ${NOT_IN_WORKSPACE}, so there is no local file to deploy.`]);
		assert.strictEqual(fake.requests.length, sent, 'nothing sent');
		assert.strictEqual(unitsAsked, 0);
		assert.deepStrictEqual(errors, []);
	});

	test('NOT_CONNECTED row action: Connect is offered as Deploy does; declined, nothing is sent', async () => {
		seed('p0000000000000orders', 'orders', 'STATE_RUNNING');
		await showPipelines();
		const node = pipelineRow('orders')!.node;
		await cloud().disconnect();
		await settleSecrets();
		const before = fake.requests.length;
		script({ actions: [undefined] });
		for (const command of [OPEN_DEPLOYED_COMMAND, COMPARE_COMMAND, DEPLOY_AGAIN_COMMAND, COPY_ID_COMMAND]) {
			assert.strictEqual((await run(command, node))?.kind, 'notStarted', command);
		}
		assert.deepStrictEqual(infos.slice(-4), Array(4).fill(NOT_CONNECTED_MESSAGE));
		assert.strictEqual(fake.requests.length, before, 'nothing sent');
	});

	test('COPY_ID: the id on the clipboard, "Copied the ID of <name>", in any state, nothing requested', async () => {
		seed('p000000000000paused', 'paused', 'STATE_PAUSED');
		await showPipelines();
		await vscode.env.clipboard.writeText('');
		const before = fake.requests.length;
		const result = await run(COPY_ID_COMMAND, pipelineRow('paused')!.node);
		assert.strictEqual(result?.kind, 'copied');
		assert.strictEqual(await vscode.env.clipboard.readText(), 'p000000000000paused');
		assert.deepStrictEqual(infos.slice(-1), ['Copied the ID of paused.']);
		assert.strictEqual(fake.requests.length, before);
		assert.deepStrictEqual(rowOffers(pipelineRow('paused')!.contextValue), [OPEN_DEPLOYED_COMMAND, COMPARE_COMMAND, COPY_ID_COMMAND, DELETE_COMMAND]);
	});

	test('NO_LEAK: no secret or token in a request outside its place, a message, the output channel, a setting, a file or the view', () => {
		const secrets = [CLIENT_SECRET, WRONG_SECRET];
		assert.ok(fake.tokens.length > 0);
		for (const r of fake.requests) {
			const { authorization, ...headers } = r.headers;
			const outside = JSON.stringify({ url: r.url, headers, body: r.url === '/oauth/token' ? '' : r.body });
			for (const value of [...secrets, ...fake.tokens]) {
				assert.ok(!outside.includes(value), `${r.method} ${r.url} holds a credential outside its place`);
			}
			if (r.url === '/oauth/token') {
				assert.strictEqual(authorization, undefined);
				assert.ok(!fake.tokens.some((t) => r.body.includes(t)));
			} else {
				assert.ok(authorization && fake.tokens.includes(authorization.replace(/^Bearer /, '')), `${r.url}: a Bearer token it issued`);
				assert.ok(!secrets.some((s) => (authorization ?? '').includes(s)));
			}
		}
		const shown = JSON.stringify({
			messages: allMessages, output: api().outputLines(), items: seenItems, settings: vscode.workspace.getConfiguration('redpandaConnect'),
			files: fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')),
		});
		for (const value of [...secrets, ...fake.tokens]) {
			assert.ok(!shown.includes(value), 'a credential in a message, the output, the view, a setting or a file');
		}
		// The output channel names the requests, so the check above reads real lines.
		assert.ok(api().outputLines().some((l) => l.startsWith('Redpanda Cloud: POST ') && l.includes('/oauth/token')));
	});
});
