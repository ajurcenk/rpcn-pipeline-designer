// Pipeline logs, the tracer (ticket 6.2, AD-24), end to end in the stable run: the Cloud view against
// the Cloud fake (`helpers/fakeCloud.ts`, its clusters now with `kafka_api.seed_brokers`) and the logs
// topic against the in-memory reader (`helpers/fakeLogs.ts`), handed to the Cloud view's test seam
// instead of the `@platformatic/kafka` one. Set up log access… and Show logs run through their
// commands, their prompts replaced by a script of answers; the Pipeline Logs tab really opens in the
// bottom panel, and is read through its test seam (the pipeline it shows, its kept rows, its status,
// whether it reads). Every matrix row of the plan has a test; NO_LEAK checks the passwords against
// every message, output line, view item, posted message, setting and the secret storage's other keys.
// BUNDLE loads the real client from dist/extension.js: its CRC-32C comes from the wasm, not the
// native `@node-rs/crc32` (installed in this checkout's node_modules as an optional dependency).
// Ticket 6.3 (history): every matrix row of its plan (RANGE … SWITCH) drives the panel's time-range
// menu, Live toggle and Load older through the test seam, as the webview's messages do; HISTORY_3_DAYS
// is its acceptance check (a pipeline's records over 3 days, Last 24 hours, then Load older twice).
// Ticket 6.4 (filter and search): every matrix row of its plan (LEVELS … SWITCH) sets the filter, asks
// for a record's JSON or the records around it through the test seam, as the webview's messages do;
// SEVEN_DAYS_MATCHES is its acceptance check (20,000 records over 7 days, 40 of them WARN with
// "secret" in a field, Last 7 days with Warn only and the search "secret").
// Ticket 6.5 (entry points): Show pipeline logs from the palette (the active config's mapped pipeline,
// else the pick), the Error notification's Show logs or Set up log access…, and Show logs around the
// error on an Error row; every matrix row of its plan (PALETTE_MAPPED … SWITCH). The notifications'
// actions on a deploy and an update are checked in 96-cloud.ts; here a start's, through to the log.
// Ticket 6.6 (states): every matrix row of its plan (NO_ACCESS … AFTER_SETUP), the retries' waits
// shortened through the panel's `retryDelaysMs` seam (the states still say the real waits).
// Ticket 6.7 (the records-per-time strip): every matrix row of its plan (SLOTS … OVER_CAP) reads the
// strip through `viewState.strip` and clicks a bar through `chooseSlot`, as the webview's `slotChosen`
// does; STRIP_7_DAYS is its acceptance check (20,000 records over 7 days, 30 ERROR in one afternoon).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	CLIENT_ID_KEY, CLIENT_SECRET_KEY, CONNECT_ACTION, CONNECT_COMMAND, DEPLOY_COMMAND, logAccessKey, type CloudItem, type CloudUi, LOG_ACCESS_PREFIX, NO_LOG_ACCESS_SET, noLogAccessMessage, type PipelineChoice,
	SET_UP_LOG_ACCESS_ACTION, SET_UP_LOG_ACCESS_COMMAND, SHOW_LOGS_ACTION, SHOW_LOGS_AROUND_ERROR_COMMAND, SHOW_LOGS_COMMAND, signInRefusedMessage, START_COMMAND,
} from '../../../adapters/vscode/cloudView';
import {
	AROUND_MS, ERROR_SEARCH_MS, focusNotShownText, FOLLOWING_STATUS, noMatchesBackText, LIVE_OFF_STATUS, livePausedStatus, LOGS_VIEW_ID, LOGS_WINDOW_MS, NO_ERROR_NOTE, stoppedReadingStatus,
} from '../../../adapters/vscode/logsPanel';
import { serializeMapping } from '../../../adapters/cloud/sidecar';
import { resourcesOf } from '../../../adapters/cloud/dataPlane';
import { gapsIn, LOG_LEVELS, MAX_LOG_ROWS, NO_FILTER, panelStateTexts, RETRY_DELAYS_MS, slotBounds, slotOf, type LogFilter, type LogsPanelState } from '../../../shared/logsProtocol';
import { RETENTION_UNKNOWN } from '../../../adapters/logs/history';
import { type ExtensionApi } from '../../../extension';
import { FakeCloud, type FakePipeline } from '../../helpers/fakeCloud';
import { FakeLogs } from '../../helpers/fakeLogs';
import { makeTempDir } from '../../helpers/fakeBinary';
import { newerVsCodeMessage, nodeSupported } from '../../../adapters/logs/runtime';
import { EXTENSION_ID, waitFor } from '../helpers';

const CLIENT_ID = 'fake-client-id-6-2';
const CLIENT_SECRET = 'fake-client-secret-6-2-Wd3';
const USERNAME = 'logs-reader';
const PASSWORD = 'logs-password-6-2-Hx7q';
const WRONG_PASSWORD = 'wrong-logs-password-6-2-Mv4z';
const VILNIUS = 'cvilnius0000000000aa';
const BYOC = 'cbyoc000000000000bbb';
const SEEDS = ['seed-0.vilnius.example:9092'];
const ORDERS = 'd3orders000000000001';
const CLICKS = 'd3clicks000000000002';
const LICENSE_ORG = '7f0c1d2e-3a4b-5c6d-7e8f-9a0b1c2d3e4f';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Input = string | undefined;

/** Every file under `dir`, recursively (none when it does not exist). */
function filesUnder(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		return e.isDirectory() ? filesUnder(p) : e.isFile() ? [p] : [];
	});
}

suite('Pipeline logs (integration, ticket 6.2)', function () {
	this.timeout(60_000);
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const cloud = () => api().cloud!;
	const logs = () => api().logs!;
	let fake: FakeCloud;
	let topic: FakeLogs;
	let originalUi: CloudUi;
	let originalReader: ReturnType<typeof cloud>['logReader'];
	let originalCap: number;
	let originalErrorWindow: number;
	let originalRetryDelays: readonly number[];
	let originalPollMs: number;
	/** The suite's own temporary directory (NO_LEAK reads every file in it). */
	let dir: string;
	let inputs: Input[] = [];
	let asked: vscode.InputBoxOptions[] = [];
	let choices: (string | undefined)[] = [];
	let questions: { title: string; question: string; choices: string[] }[] = [];
	let actions: (string | undefined)[] = [];
	/** Ticket 6.5: the palette's pipeline picks (by name), and what each offered. */
	let pipelinePicks: (string | undefined)[] = [];
	let pipelinesOffered: PipelineChoice[][] = [];
	const errors: string[] = [];
	/** The actions each error offered. */
	const errorActions: string[][] = [];
	const infos: string[] = [];
	/** The actions each info offered. */
	const infoActions: string[][] = [];
	/** Every message, prompt and item of the suite, for NO_LEAK. */
	const allShown: string[] = [];
	const seenItems: CloudItem[] = [];

	function script(next: { inputs?: Input[]; choices?: (string | undefined)[]; actions?: (string | undefined)[]; pipelinePicks?: (string | undefined)[] }): void {
		pipelinePicks = next.pipelinePicks ?? [];
		pipelinesOffered = [];
		inputs = next.inputs ?? [];
		choices = next.choices ?? [];
		actions = next.actions ?? [];
		asked = [];
		questions = [];
	}

	const items = () => {
		const now = cloud().items();
		seenItems.push(...now);
		return now;
	};
	const clusterItem = (name: string) => items().find((i) => i.node.kind === 'cluster' && i.label === name)!;
	const pipelineItem = (name: string) => items().find((i) => i.node.kind === 'pipeline' && i.label === name)!;
	const clusterNode = (id: string): CloudItem['node'] => ({ kind: 'cluster', id });
	const pipelineNode = (clusterId: string, id: string): CloudItem['node'] => ({ kind: 'pipeline', clusterId, id });
	const setUp = (node: CloudItem['node'] = clusterNode(VILNIUS)) =>
		vscode.commands.executeCommand<{ kind: string; refused?: boolean; message?: string }>(SET_UP_LOG_ACCESS_COMMAND, node);
	const showLogs = (id = ORDERS, clusterId = VILNIUS) => vscode.commands.executeCommand<{ kind: string; pipelineId?: string }>(SHOW_LOGS_COMMAND, pipelineNode(clusterId, id));
	const messages = (id: string) => logs().rows().map((r) => r.message).filter((m) => m.startsWith(`${id}:`));

	function pipeline(id: string, name: string): FakePipeline {
		return {
			id, display_name: name, description: '', config_yaml: 'input:\n  generate:\n    mapping: root = 1\noutput:\n  drop: {}\n',
			resources: { cpu_shares: '100m', memory_shares: '400M' }, tags: {}, state: 'STATE_RUNNING', sequence: [],
		};
	}

	/** A record of pipeline `id` with `message` "<id>:<text>", at `ago` ms before now. */
	const rec = (id: string, text: string, ago = 0, extra: Record<string, unknown> = {}) => ({
		key: id, timestamp: Date.now() - ago,
		value: { instance_id: `${id}-inst-1`, level: 'INFO', message: `${id}:${text}`, path: '/config/connect.yaml', pipeline_id: id, time: new Date(Date.now() - ago).toISOString(), ...extra },
	});

	/** A record of pipeline `id` with `message` "<id>:<text>", at time `ts`. */
	const recAt = (id: string, text: string, ts: number) => ({
		key: id, timestamp: ts,
		value: { instance_id: `${id}-inst-1`, level: 'INFO', message: `${id}:${text}`, pipeline_id: id, time: new Date(ts).toISOString() },
	});
	/** The shown rows' texts after "<id>:". */
	const texts = () => logs().rows().map((r) => r.message.slice(r.message.indexOf(':') + 1));
	/** Shows ORDERS' logs (access set up) and waits until the default read follows. */
	async function showOrders(): Promise<void> {
		await setUpAccess();
		assert.deepStrictEqual(await showLogs(), { kind: 'shown', pipelineId: ORDERS });
		assert.ok(await waitFor(() => logs().visible && logs().statusText === FOLLOWING_STATUS, 10_000), logs().statusText);
	}

	async function connectAndRead(): Promise<void> {
		script({ inputs: [CLIENT_ID, CLIENT_SECRET] });
		assert.strictEqual(await vscode.commands.executeCommand(CONNECT_COMMAND), true, errors.join('\n'));
		await cloud().refresh({ kind: 'cluster', id: VILNIUS });
		await cloud().refresh({ kind: 'cluster', id: BYOC });
	}

	async function setUpAccess(): Promise<void> {
		script({ inputs: [USERNAME, PASSWORD], choices: ['SCRAM-SHA-256'] });
		const result = await setUp();
		assert.strictEqual(result?.kind, 'stored', errors.join('\n'));
	}

	suiteSetup(async function () {
		// The client needs Node 22.22 or later: on an older VS Code (the floor run) the suite below checks the message instead.
		if (!nodeSupported()) {
			this.skip();
		}
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
		dir = makeTempDir('rpcn-logs-');
		fake = new FakeCloud({
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
			clientName: 'logs-bot',
			clusters: [
				{ id: VILNIUS, name: 'rpc-vilnius', type: 'TYPE_DEDICATED', cloudProvider: 'CLOUD_PROVIDER_AWS', region: 'us-east-2', connectVersion: '4.115.0', seedBrokers: SEEDS, pipelines: [] },
				{ id: BYOC, name: 'byoc-eu', type: 'TYPE_BYOC', cloudProvider: 'CLOUD_PROVIDER_GCP', region: 'europe-west1', connectVersion: '4.116.0', seedBrokers: ['seed-0.byoc.example:9092'], pipelines: [] },
			],
		});
		await fake.start();
		originalUi = cloud().ui;
		originalReader = cloud().logReader;
		originalCap = logs().cap;
		originalErrorWindow = logs().errorWindowMs;
		originalRetryDelays = logs().retryDelaysMs;
		originalPollMs = cloud().pollMs;
		cloud().endpoints = { authUrl: fake.url, controlPlaneUrl: fake.url, requireHttps: false };
		cloud().ui = {
			...originalUi,
			input: async (options) => {
				asked.push(options);
				allShown.push(options.title ?? '', options.prompt ?? '', options.value ?? '');
				return inputs.shift();
			},
			pickChoice: async (title, question, offered) => {
				questions.push({ title, question, choices: [...offered] });
				allShown.push(title, question, ...offered);
				return choices.shift();
			},
			error: async (m, ...offered) => {
				errors.push(m);
				errorActions.push(offered);
				allShown.push(m);
				return actions.shift();
			},
			// Ticket 6.5's deploys: rpc-vilnius, the pre-set size.
			pickCluster: async (clusters) => clusters.find((c) => c.name === 'rpc-vilnius'),
			pickUnits: async (_title, current) => current ?? resourcesOf(1),
			pickPipeline: async (offered) => {
				pipelinesOffered.push([...offered]);
				allShown.push(...offered.flatMap((c) => [c.label, c.description]));
				const name = pipelinePicks.shift();
				return offered.find((c) => c.pipeline.displayName === name);
			},
			info: async (m, ...offered) => {
				infos.push(m);
				infoActions.push(offered);
				allShown.push(m);
				return actions.shift();
			},
			progress: async (title, task) => {
				allShown.push(title);
				return task(() => undefined);
			},
		};
	});

	setup(async () => {
		// The last test's reading stops with the tab; each test reads a topic of its own.
		await vscode.commands.executeCommand('workbench.action.closePanel');
		assert.ok(await waitFor(() => !logs().reading, 10_000), 'the last test\'s reader stopped');
		topic = new FakeLogs({ username: USERNAME, password: PASSWORD });
		cloud().logReader = topic.factory;
		await cloud().disconnect();
		await new Promise((r) => setTimeout(r, 300));
		await cloud().removeLogAccess(VILNIUS);
		await cloud().removeLogAccess(BYOC);
		logs().cap = originalCap;
		fake.cluster(VILNIUS).pipelines = [pipeline(ORDERS, 'orders'), pipeline(CLICKS, 'clicks')];
		fake.cluster(BYOC).pipelines = [pipeline('d3byoc00000000000003', 'events')];
		logs().errorWindowMs = originalErrorWindow;
		// Ticket 6.6: short waits in every test, so no retry timer outlives one (closing the panel above stops it too).
		logs().retryDelaysMs = [200, 400, 600, 800, 1_000];
		cloud().pollMs = originalPollMs;
		errors.length = 0;
		errorActions.length = 0;
		infos.length = 0;
		infoActions.length = 0;
		script({});
		await connectAndRead();
		errors.length = 0;
		errorActions.length = 0;
		infos.length = 0;
		infoActions.length = 0;
	});

	/** Ticket 6.6: what a test leaves to undo (its listeners). */
	const teardowns: (() => void)[] = [];
	teardown(() => {
		teardowns.splice(0).forEach((t) => t());
		// No retry timer outlives a test: a lost connection waits with the tab hidden, and the next test's show resets it.
		topic.connectionFailures = 0;
	});

	suiteTeardown(async () => {
		if (!fake) {
			return; // skipped (an older VS Code)
		}
		await vscode.commands.executeCommand('workbench.action.closePanel');
		await cloud().removeLogAccess(VILNIUS);
		await cloud().removeLogAccess(BYOC);
		await cloud().disconnect();
		cloud().ui = originalUi;
		cloud().logReader = originalReader;
		logs().cap = originalCap;
		logs().errorWindowMs = originalErrorWindow;
		logs().retryDelaysMs = originalRetryDelays;
		cloud().pollMs = originalPollMs;
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await fake?.stop();
		if (dir) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('package.json: the Pipeline Logs tab in the bottom panel; Set up log access… on a cluster row, Show logs on a pipeline row (inline with access, always in the menu) and in the palette, Show logs around the error on Error rows only', () => {
		const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as {
			contributes: {
				viewsContainers: Record<string, { id: string; title: string }[]>;
				views: Record<string, { id: string; name: string; type?: string }[]>;
				commands: { command: string; title: string }[];
				menus: Record<string, { command: string; when?: string; group?: string }[]>;
			};
		};
		const container = pkg.contributes.viewsContainers.panel?.find((c) => c.title === 'Pipeline Logs');
		assert.ok(container, 'a container in the bottom panel');
		assert.deepStrictEqual(pkg.contributes.views[container.id], [{ type: 'webview', id: LOGS_VIEW_ID, name: 'Pipeline Logs', contextualTitle: 'Pipeline Logs' }]);
		assert.deepStrictEqual([SET_UP_LOG_ACCESS_COMMAND, SHOW_LOGS_COMMAND, SHOW_LOGS_AROUND_ERROR_COMMAND].map((c) => pkg.contributes.commands.find((x) => x.command === c)?.title),
			['Set up log access…', 'Show pipeline logs', 'Show logs around the error']);
		for (const c of [SET_UP_LOG_ACCESS_COMMAND, SHOW_LOGS_AROUND_ERROR_COMMAND]) {
			assert.strictEqual(pkg.contributes.menus.commandPalette.find((m) => m.command === c)?.when, 'false', `${c}: rows only`);
		}
		const paletteEntry = pkg.contributes.menus.commandPalette.find((m) => m.command === SHOW_LOGS_COMMAND);
		assert.ok(paletteEntry && paletteEntry.when === undefined, 'PALETTE: Show pipeline logs, also when not connected (Connect is offered first)');
		const offered = (contextValue: string, inline: boolean) => pkg.contributes.menus['view/item/context']
			.filter((m) => (m.group?.startsWith('inline') ?? false) === inline)
			.filter((m) => { const r = /viewItem =~ \/(.+)\/$/.exec(m.when ?? ''); return r && new RegExp(r[1]).test(contextValue); })
			.map((m) => m.command).filter((c) => c === SET_UP_LOG_ACCESS_COMMAND || c === SHOW_LOGS_COMMAND || c === SHOW_LOGS_AROUND_ERROR_COMMAND || c === 'redpandaConnect.cloud.refresh');
		assert.deepStrictEqual(offered('cloudCluster', false), ['redpandaConnect.cloud.refresh', SET_UP_LOG_ACCESS_COMMAND]);
		assert.deepStrictEqual(offered('cloudCluster logs', false), ['redpandaConnect.cloud.refresh', SET_UP_LOG_ACCESS_COMMAND]);
		assert.deepStrictEqual(offered('cloudCluster logs', true), ['redpandaConnect.cloud.refresh'], 'Refresh stays inline with access');
		assert.deepStrictEqual(offered('cloudCluster noPipelineApi', false), []);
		assert.deepStrictEqual(offered('cloudPipeline state-running', true), [], 'no inline Show logs without access');
		assert.deepStrictEqual(offered('cloudPipeline state-running hasFile logs', true), [SHOW_LOGS_COMMAND]);
		assert.deepStrictEqual(offered('cloudPipeline state-running', false), [SHOW_LOGS_COMMAND], 'the menu always has it (NO_ACCESS)');
		// AROUND_MENU (ticket 6.5): only on Error rows, in the menu.
		assert.deepStrictEqual(offered('cloudPipeline state-error hasFile logs', false), [SHOW_LOGS_COMMAND, SHOW_LOGS_AROUND_ERROR_COMMAND]);
		assert.deepStrictEqual(offered('cloudPipeline state-error', false), [SHOW_LOGS_COMMAND, SHOW_LOGS_AROUND_ERROR_COMMAND]);
		assert.deepStrictEqual(offered('cloudPipeline state-error logs', true), [SHOW_LOGS_COMMAND], 'not inline');
		for (const state of ['running', 'starting', 'stopped', 'stopping', 'completed', 'unknown']) {
			assert.deepStrictEqual(offered(`cloudPipeline state-${state} logs`, false), [SHOW_LOGS_COMMAND], state);
		}
	});

	test('SETUP_CANCEL: Escape at the username, the password or the mechanism stores nothing and sends nothing', async () => {
		for (const answers of [{ inputs: [undefined] }, { inputs: [USERNAME, undefined] }, { inputs: [USERNAME, PASSWORD], choices: [undefined] }]) {
			script(answers);
			assert.strictEqual((await setUp())?.kind, 'notStarted');
		}
		assert.strictEqual(topic.targets.length, 0, 'no reader made');
		assert.strictEqual(await cloud().storedLogAccess(VILNIUS), undefined);
		assert.deepStrictEqual(errors, []);
	});

	test('SETUP refused: a wrong password is "<username> could not sign in to <cluster>", nothing stored; the prompts: a password box, both mechanisms', async () => {
		script({ inputs: [USERNAME, WRONG_PASSWORD], choices: ['SCRAM-SHA-256'] });
		const result = await setUp();
		assert.deepStrictEqual(result, { kind: 'failed', refused: true, message: signInRefusedMessage(USERNAME, 'rpc-vilnius') });
		assert.deepStrictEqual(errors, ['logs-reader could not sign in to rpc-vilnius.']);
		assert.strictEqual(asked[0].password, undefined);
		assert.strictEqual(asked[1].password, true, 'the password is a password box');
		assert.deepStrictEqual(questions[0].choices, ['SCRAM-SHA-256', 'SCRAM-SHA-512']);
		assert.strictEqual(topic.tests.length, 1, 'one test read');
		assert.strictEqual(await cloud().storedLogAccess(VILNIUS), undefined);
		assert.strictEqual(clusterItem('rpc-vilnius').description, 'Dedicated · AWS us-east-2 · Connect 4.115.0');
	});

	test('SETUP other failure: its message, nothing stored', async () => {
		topic.failTest = 'Cannot connect to any broker: connect ETIMEDOUT';
		script({ inputs: [USERNAME, PASSWORD], choices: ['SCRAM-SHA-512'] });
		const result = await setUp();
		assert.strictEqual(result?.kind, 'failed');
		assert.strictEqual(result?.refused, false);
		assert.deepStrictEqual(errors, ['Could not read the pipeline logs of rpc-vilnius: Cannot connect to any broker: connect ETIMEDOUT']);
		assert.strictEqual(await cloud().storedLogAccess(VILNIUS), undefined);
		topic.failTest = undefined;
		topic.refuseRead = true;
		errors.length = 0;
		script({ inputs: [USERNAME, PASSWORD], choices: ['SCRAM-SHA-256'] });
		assert.strictEqual((await setUp())?.kind, 'failed');
		assert.match(errors[0] ?? '', /^Could not read the pipeline logs of rpc-vilnius: not allowed to read __redpanda\.connect\.logs/);
		assert.strictEqual(await cloud().storedLogAccess(VILNIUS), undefined);
	});

	test('SETUP: the test read passes at the cluster\'s seed brokers with the chosen mechanism; stored; the row says "logs: <username>", its pipelines get Show logs inline', async () => {
		script({ inputs: [USERNAME, PASSWORD], choices: ['SCRAM-SHA-512'] });
		const result = await setUp();
		assert.deepStrictEqual(result, { kind: 'stored', username: USERNAME });
		assert.deepStrictEqual(topic.tests.map((t) => ({ brokers: [...t.brokers], ...t.access })), [{ brokers: SEEDS, username: USERNAME, password: PASSWORD, mechanism: 'SCRAM-SHA-512' }]);
		assert.deepStrictEqual(await cloud().storedLogAccess(VILNIUS), { username: USERNAME, mechanism: 'SCRAM-SHA-512' });
		assert.strictEqual(clusterItem('rpc-vilnius').description, 'Dedicated · AWS us-east-2 · Connect 4.115.0 · logs: logs-reader');
		assert.strictEqual(clusterItem('rpc-vilnius').contextValue, 'cloudCluster logs');
		assert.strictEqual(pipelineItem('orders').contextValue, 'cloudPipeline state-running logs');
		assert.strictEqual(clusterItem('byoc-eu').contextValue, 'cloudCluster', 'per cluster');
		assert.strictEqual(pipelineItem('events').contextValue, 'cloudPipeline state-running');
		assert.deepStrictEqual(infos, ['Log access to rpc-vilnius is set up for logs-reader.']);
		assert.strictEqual(topic.tails.length, 0, 'no reading before Show logs');
		// A second set-up offers the stored username.
		script({ inputs: [undefined] });
		await setUp();
		assert.strictEqual(asked[0].value, USERNAME);
	});

	test('NO_ACCESS: Show logs where the cluster has no access says to set it up first, with the action; the tab shows its No log access state; nothing is read', async () => {
		script({ actions: [undefined] });
		assert.deepStrictEqual(await showLogs(), { kind: 'noAccess' });
		assert.deepStrictEqual(infos, [noLogAccessMessage('rpc-vilnius')]);
		assert.deepStrictEqual(infoActions, [[SET_UP_LOG_ACCESS_ACTION]]);
		assert.strictEqual(logs().title, 'orders · rpc-vilnius');
		assert.deepStrictEqual(logs().panelState, { kind: 'noAccess', cluster: 'rpc-vilnius', topic: '__redpanda.connect.logs' });
		assert.strictEqual(panelStateTexts(logs().panelState)?.title, 'rpc-vilnius has no log access set');
		assert.strictEqual(logs().statusText, 'rpc-vilnius has no log access set');
		assert.ok(await waitFor(() => logs().visible, 10_000));
		await new Promise((r) => setTimeout(r, 200));
		assert.strictEqual(topic.targets.length, 0, 'nothing read');
		assert.strictEqual(logs().reading, false);
		// The action runs Set up log access…, then the log is shown.
		topic.write(rec(ORDERS, 'one', MINUTE));
		script({ actions: [SET_UP_LOG_ACCESS_ACTION], inputs: [USERNAME, PASSWORD], choices: ['SCRAM-SHA-256'] });
		assert.deepStrictEqual(await showLogs(), { kind: 'shown', pipelineId: ORDERS });
		assert.ok(await waitFor(() => messages(ORDERS).length === 1, 10_000), logs().statusText);
	});

	test('SHOW and ONLY_THIS: the tab opens on "<pipeline> · <cluster>" with that pipeline\'s records of the last 15 minutes, oldest first, then its new ones as they are written', async () => {
		await setUpAccess();
		topic.write(
			rec(ORDERS, 'too old', 20 * MINUTE),
			rec(CLICKS, 'other old', 12 * MINUTE),
			rec(ORDERS, 'first', 10 * MINUTE),
			rec(CLICKS, 'other', 5 * MINUTE),
			rec(ORDERS, 'second', 2 * MINUTE),
		);
		const before = Date.now();
		assert.deepStrictEqual(await showLogs(), { kind: 'shown', pipelineId: ORDERS });
		assert.strictEqual(logs().title, 'orders · rpc-vilnius');
		assert.ok(await waitFor(() => logs().visible, 10_000), 'the Pipeline Logs tab is shown');
		assert.ok(await waitFor(() => messages(ORDERS).length === 2, 10_000), logs().statusText);
		assert.deepStrictEqual(logs().rows().map((r) => r.message), [`${ORDERS}:first`, `${ORDERS}:second`], 'only orders\', of the last 15 minutes, oldest first');
		const tail = topic.activeTails()[0];
		assert.strictEqual(tail.pipelineId, ORDERS);
		assert.ok(Math.abs(tail.fromTime - (before - LOGS_WINDOW_MS)) < 5_000, `from now − 15 minutes (${before - tail.fromTime} ms back)`);
		assert.deepStrictEqual([...topic.targets.at(-1)!.brokers], SEEDS);
		assert.strictEqual(logs().statusText, FOLLOWING_STATUS);
		topic.write(rec(CLICKS, 'live other'), rec(ORDERS, 'live 1'));
		topic.write(rec(ORDERS, 'live 2'));
		assert.ok(await waitFor(() => messages(ORDERS).length === 4, 10_000));
		assert.deepStrictEqual(logs().rows().map((r) => r.message), [`${ORDERS}:first`, `${ORDERS}:second`, `${ORDERS}:live 1`, `${ORDERS}:live 2`]);
		assert.strictEqual(topic.activeTails().length, 1, 'one reader');
	});

	test('SWITCH: Show logs on another pipeline shows it instead; the first is no longer read', async () => {
		await setUpAccess();
		topic.write(rec(ORDERS, 'o1', MINUTE), rec(CLICKS, 'c1', MINUTE));
		await showLogs(ORDERS);
		assert.ok(await waitFor(() => messages(ORDERS).length === 1, 10_000));
		const first = topic.activeTails()[0];
		await showLogs(CLICKS);
		assert.strictEqual(logs().title, 'clicks · rpc-vilnius');
		assert.ok(await waitFor(() => messages(CLICKS).length === 1, 10_000), logs().statusText);
		assert.strictEqual(first.signal.aborted, true, 'the first reader stopped');
		assert.deepStrictEqual(topic.activeTails().map((t) => t.pipelineId), [CLICKS]);
		topic.write(rec(ORDERS, 'o2'), rec(CLICKS, 'c2'));
		assert.ok(await waitFor(() => messages(CLICKS).length === 2, 10_000));
		assert.deepStrictEqual(messages(ORDERS), [], 'no orders record');
	});

	test('RECORD: extra fields after the message, a non-JSON value as text, license_org never shown', async () => {
		await setUpAccess();
		topic.write(
			rec(ORDERS, 'Successfully loaded Redpanda license', MINUTE, { license_org: LICENSE_ORG, license_type: 'enterprise', expires_at: '2027-01-01T00:00:00Z', level: 'warn', probe_n: 7 }),
			{ key: ORDERS, value: 'plain text, not JSON', timestamp: Date.now() - 30_000 },
		);
		await showLogs();
		assert.ok(await waitFor(() => logs().rows().length === 2, 10_000), logs().statusText);
		const [license, raw] = logs().rows();
		assert.strictEqual(license.level, 'WARN');
		assert.strictEqual(license.instance, `${ORDERS}-inst-1`);
		assert.deepStrictEqual(license.fields, [['path', '/config/connect.yaml'], ['license_type', 'enterprise'], ['expires_at', '2027-01-01T00:00:00Z'], ['probe_n', '7']]);
		assert.strictEqual(raw.raw, true);
		assert.strictEqual(raw.message, 'plain text, not JSON');
		assert.ok(!JSON.stringify(logs().rows()).includes(LICENSE_ORG));
		assert.ok(!JSON.stringify(logs().posted).includes(LICENSE_ORG));
	});

	test('CAP: more records than the cap: the oldest dropped; the footer\'s count (the host\'s `dropped`)', async () => {
		await setUpAccess();
		assert.strictEqual(originalCap, MAX_LOG_ROWS);
		logs().cap = 5;
		topic.write(...Array.from({ length: 4 }, (_, i) => rec(ORDERS, `h${i}`, MINUTE - i)));
		await showLogs();
		assert.ok(await waitFor(() => logs().rows().length === 4, 10_000));
		assert.strictEqual(logs().droppedCount, 0);
		topic.write(...Array.from({ length: 4 }, (_, i) => rec(ORDERS, `n${i}`)));
		assert.ok(await waitFor(() => logs().droppedCount === 3, 10_000), String(logs().droppedCount));
		assert.deepStrictEqual(logs().rows().map((r) => r.message.slice(ORDERS.length + 1)), ['h3', 'n0', 'n1', 'n2', 'n3']);
		const show = logs().posted.filter((m) => m.type === 'append').at(-1);
		assert.deepStrictEqual(show && show.type === 'append' ? show.dropped : undefined, 3, 'the webview is told how many were dropped');
	});

	test('HIDDEN: the tab hidden stops reading; shown again it resumes from the last record read, nothing twice', async () => {
		await setUpAccess();
		topic.write(rec(ORDERS, 'before', MINUTE));
		await showLogs();
		assert.ok(await waitFor(() => messages(ORDERS).length === 1, 10_000));
		const first = topic.activeTails()[0];
		await vscode.commands.executeCommand('workbench.action.closePanel');
		assert.ok(await waitFor(() => first.signal.aborted && !logs().reading, 10_000), 'reading stops when the tab is hidden');
		topic.write(rec(ORDERS, 'while hidden'));
		await new Promise((r) => setTimeout(r, 200));
		assert.strictEqual(topic.activeTails().length, 0, 'nothing reads while hidden');
		assert.deepStrictEqual(messages(ORDERS), [`${ORDERS}:before`]);
		await vscode.commands.executeCommand(`${LOGS_VIEW_ID}.focus`);
		assert.ok(await waitFor(() => messages(ORDERS).length === 2, 10_000), logs().statusText);
		const second = topic.activeTails()[0];
		assert.deepStrictEqual(second.resumeAt && [...second.resumeAt], [[0, 1]], 'from where the first stopped');
		assert.deepStrictEqual(messages(ORDERS), [`${ORDERS}:before`, `${ORDERS}:while hidden`]);
		assert.strictEqual(topic.tails.length, 2);
	});

	// --- ticket 6.3: history ---

	test('HISTORY_3_DAYS: Last 24 hours, then Load older twice: each 24 hours before, oldest first, with a gap note wherever 30 minutes or more pass', async () => {
		const t0 = Date.now();
		// Every 10 minutes over 3 days (5 minutes off the 10, away from the bounds), but for two silences:
		// 10:05–11:35 ago (110 minutes between records) and 30:05–39:55 ago (610 minutes); another pipeline's records in between.
		const agos = Array.from({ length: 432 }, (_, k) => 5 + 10 * k).filter((m) => !(m > 600 && m < 700) && !(m > 1800 && m < 2400)).reverse();
		topic.write(...agos.flatMap((m) => [recAt(ORDERS, `-${m}m`, t0 - m * MINUTE), recAt(CLICKS, `-${m}m`, t0 - m * MINUTE + 1)]));
		await showOrders();
		assert.strictEqual(await logs().chooseRange({ kind: 'day' }), true);
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		const upTo = (minutes: number) => agos.filter((m) => m <= minutes).map((m) => `-${m}m`);
		assert.deepStrictEqual(texts(), upTo(1435), 'the last 24 hours, oldest first, only orders\'');
		assert.strictEqual(logs().viewState.live, false, 'Live off');
		assert.deepStrictEqual(topic.activeTails(), [], 'nothing follows');
		const gapMinutes = () => gapsIn(logs().rows()).map((g) => Math.round((g.to - g.from) / MINUTE));
		assert.deepStrictEqual(gapMinutes(), [110]);
		await logs().loadOlder();
		assert.deepStrictEqual(texts(), upTo(2875), 'the 24 hours before the oldest shown, prepended');
		assert.deepStrictEqual(gapMinutes(), [610, 110]);
		assert.strictEqual(logs().viewState.older, 'more');
		assert.strictEqual(logs().posted.filter((m) => m.type === 'prepend').length, 1);
		await logs().loadOlder();
		assert.deepStrictEqual(texts(), upTo(4315), 'and the day before that');
		assert.strictEqual(logs().viewState.older, 'none', 'the log\'s first record is shown: No older records');
		assert.strictEqual(logs().rows().length, agos.length);
		assert.ok(logs().rows().every((r, i, all) => i === 0 || all[i - 1].time <= r.time), 'oldest first');
	});

	test('RANGE: Last 24 hours reads to its end and stops (Live off); Live on goes on after it; a read failure is the status line', async () => {
		topic.write(rec(ORDERS, 'two days', 2 * DAY), rec(ORDERS, 'yesterday', 20 * HOUR), rec(ORDERS, 'an hour', HOUR));
		await showOrders();
		assert.deepStrictEqual(texts(), []);
		await logs().chooseRange({ kind: 'day' });
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['yesterday', 'an hour']);
		const range = topic.ranges.at(-1)!;
		assert.ok(Math.abs(range.toTime - range.fromTime - DAY) < 1_000, 'from now − 24 hours to now');
		assert.ok(range.end, 'the read ended');
		assert.strictEqual(logs().viewState.range.kind, 'day');
		assert.strictEqual(logs().viewState.live, false);
		assert.strictEqual(logs().statusText, 'Read 2 records of the last 24 hours. Live is off.');
		topic.write(rec(ORDERS, 'new'));
		await new Promise((r) => setTimeout(r, 200));
		assert.deepStrictEqual(texts(), ['yesterday', 'an hour'], 'nothing appended: Live is off');
		assert.deepStrictEqual(topic.activeTails(), []);
		// Live on goes on after the range's end: the record written since appears.
		await logs().setLive(true);
		assert.ok(await waitFor(() => texts().length === 3, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['yesterday', 'an hour', 'new']);
		const resumed = topic.activeTails()[0].resumeAt;
		assert.deepStrictEqual(resumed && [...resumed], [[0, 3]]);
		// A read failure (ticket 6.6: its state).
		topic.refuseRead = true;
		await logs().chooseRange({ kind: 'hour' });
		assert.ok(await waitFor(() => logs().panelState.kind === 'notAllowed', 10_000), logs().statusText);
		assert.strictEqual(logs().statusText, 'logs-reader may not read the logs topic');
		assert.ok(api().outputLines().some((l) => /not allowed to read __redpanda\.connect\.logs/.test(l)), 'the reason in the output channel');
		assert.ok(await waitFor(() => !logs().reading, 10_000));
	});

	test('LIVE_DEFAULTS: Live reads no history, only new records; Live off stops it and on again goes on where it stopped; the default is 6.2\'s', async () => {
		topic.write(rec(ORDERS, 'old', 5 * MINUTE));
		await showOrders();
		assert.deepStrictEqual(texts(), ['old'], 'the default: the last 15 minutes');
		assert.strictEqual(logs().viewState.range.kind, 'recent');
		assert.strictEqual(logs().viewState.live, true);
		const before = Date.now();
		await logs().chooseRange({ kind: 'live' });
		assert.ok(await waitFor(() => topic.activeTails().length === 1 && logs().statusText === FOLLOWING_STATUS, 10_000), logs().statusText);
		assert.ok(topic.activeTails()[0].fromTime >= before - 1_000, 'from now');
		assert.deepStrictEqual(texts(), [], 'no history');
		topic.write(rec(ORDERS, 'live 1'));
		assert.ok(await waitFor(() => texts().length === 1, 10_000));
		await logs().setLive(false);
		assert.strictEqual(logs().statusText, LIVE_OFF_STATUS);
		assert.ok(await waitFor(() => topic.activeTails().length === 0, 10_000));
		topic.write(rec(ORDERS, 'while off'));
		await new Promise((r) => setTimeout(r, 200));
		assert.deepStrictEqual(texts(), ['live 1']);
		await logs().setLive(true);
		assert.ok(await waitFor(() => texts().length === 2, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['live 1', 'while off'], 'from where it stopped, nothing twice');
		// The default again: the last 15 minutes, then live.
		await logs().chooseRange({ kind: 'recent' });
		assert.ok(await waitFor(() => texts().length === 3, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['old', 'live 1', 'while off']);
	});

	test('SINCE_DEPLOY: from the pipeline\'s update_time (read fresh) to now, then live; the pipeline gone: said so, nothing read', async () => {
		const deployed = Date.now() - 2 * HOUR;
		fake.cluster(VILNIUS).pipelines.find((p) => p.id === ORDERS)!.update_time = new Date(deployed).toISOString().replace('Z', '123456Z');
		topic.write(rec(ORDERS, 'before the deploy', 3 * HOUR), rec(ORDERS, 'after the deploy', HOUR));
		await showOrders();
		const requests = fake.requests.length;
		assert.strictEqual(await logs().chooseRange({ kind: 'deploy' }), true);
		assert.ok(fake.requests.slice(requests).some((r) => r.method === 'GET' && r.url.endsWith(`/pipelines/${ORDERS}`)), 'the pipeline read now');
		assert.ok(await waitFor(() => texts().length === 1 && logs().statusText === FOLLOWING_STATUS, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['after the deploy']);
		assert.strictEqual(topic.activeTails()[0].fromTime, deployed, 'from update_time');
		assert.deepStrictEqual(logs().viewState.range, { kind: 'deploy', from: deployed, to: null });
		assert.strictEqual(logs().viewState.deployedAt, deployed);
		topic.write(rec(ORDERS, 'live'));
		assert.ok(await waitFor(() => texts().length === 2, 10_000), 'then live');
		// Gone.
		fake.cluster(VILNIUS).pipelines = fake.cluster(VILNIUS).pipelines.filter((p) => p.id !== ORDERS);
		const tails = topic.tails.length;
		infos.length = 0;
		assert.strictEqual(await logs().chooseRange({ kind: 'deploy' }), false);
		assert.deepStrictEqual(infos, ['Pipeline orders is no longer on rpc-vilnius, so it has no last deploy. Nothing was read.']);
		assert.strictEqual(topic.tails.length, tails, 'nothing read');
		assert.deepStrictEqual(texts(), ['after the deploy', 'live'], 'the shown log is kept');
	});

	test('CUSTOM: From–To reads that range; To before From or From in the future is refused', async () => {
		topic.write(rec(ORDERS, '6h', 6 * HOUR), rec(ORDERS, '4h', 4 * HOUR), rec(ORDERS, '3h', 3 * HOUR), rec(ORDERS, '1h', HOUR));
		await showOrders();
		const now = Date.now();
		assert.strictEqual(await logs().chooseRange({ kind: 'custom', from: now - 5 * HOUR, to: now - 2 * HOUR }), true);
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['4h', '3h']);
		assert.deepStrictEqual(logs().viewState.range, { kind: 'custom', from: now - 5 * HOUR, to: now - 2 * HOUR });
		const ranges = topic.ranges.length;
		assert.strictEqual(await logs().chooseRange({ kind: 'custom', from: now - 2 * HOUR, to: now - 5 * HOUR }), false, 'To before From');
		assert.strictEqual(await logs().chooseRange({ kind: 'custom', from: now + HOUR, to: now + 2 * HOUR }), false, 'From in the future');
		assert.strictEqual(topic.ranges.length, ranges, 'nothing read');
		assert.deepStrictEqual(texts(), ['4h', '3h']);
	});

	test('OVER_CAP: a range with more than the cap keeps its newest; the older ones are left out (the footer\'s count); Load older pages back', async () => {
		topic.write(...Array.from({ length: 8 }, (_, i) => rec(ORDERS, `r${i}`, (8 - i) * MINUTE + 30 * MINUTE)));
		await showOrders();
		logs().cap = 5;
		await logs().chooseRange({ kind: 'hour' });
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['r3', 'r4', 'r5', 'r6', 'r7'], 'the newest 5');
		assert.strictEqual(logs().droppedCount, 3);
		const append = logs().posted.filter((m) => m.type === 'append').at(-1);
		assert.strictEqual(append?.type === 'append' ? append.dropped : undefined, 3, 'the webview\'s footer count');
		await logs().loadOlder();
		assert.deepStrictEqual(texts(), ['r0', 'r1', 'r2', 'r3', 'r4'], 'the left-out ones read back; the newest dropped at the cap');
		assert.strictEqual(logs().droppedCount, 0);
		assert.strictEqual(logs().viewState.newerDropped, 3);
	});

	test('LOAD_OLDER: the window before the oldest shown, prepended; at the cap the newest are dropped and Live pauses; at the log\'s first offset "No older records"', async () => {
		topic.write(
			rec(ORDERS, 'gone 1', 29 * MINUTE), rec(ORDERS, 'gone 2', 28 * MINUTE),
			rec(ORDERS, 'o1', 24 * MINUTE), rec(ORDERS, 'o2', 22 * MINUTE), rec(ORDERS, 'o3', 20 * MINUTE),
			rec(ORDERS, 'n1', 10 * MINUTE), rec(ORDERS, 'n2', 5 * MINUTE), rec(ORDERS, 'n3', 2 * MINUTE),
		);
		// The first two are below the log's start (the topic's retention passed).
		topic.logStart = [2];
		await showOrders();
		assert.deepStrictEqual(texts(), ['n1', 'n2', 'n3']);
		logs().cap = 5;
		const targets = topic.targets.length;
		await logs().loadOlder();
		assert.deepStrictEqual(texts(), ['o1', 'o2', 'o3', 'n1', 'n2'], 'prepended; the newest dropped for the cap');
		assert.strictEqual(logs().viewState.newerDropped, 1);
		assert.strictEqual(logs().viewState.live, false, 'Live paused');
		assert.strictEqual(logs().statusText, livePausedStatus(5));
		assert.ok(await waitFor(() => topic.activeTails().length === 0, 10_000), 'nothing follows');
		assert.strictEqual(topic.targets.length, targets + 1, 'one reader for the Load older');
		assert.strictEqual(topic.logStartReads, 1);
		assert.ok(topic.ranges.every((r) => r.signal.aborted), 'its client closed');
		assert.strictEqual(logs().viewState.older, 'none', 'the window began at the log\'s first offset');
		await logs().loadOlder();
		assert.strictEqual(topic.ranges.length, 1, 'no older read once none are left');
		topic.write(rec(ORDERS, 'n4'));
		await new Promise((r) => setTimeout(r, 200));
		assert.ok(!texts().includes('n4'));
		// Live on after the newest were dropped: the default range again.
		await logs().setLive(true);
		assert.ok(await waitFor(() => texts().includes('n4'), 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['n1', 'n2', 'n3', 'n4']);
		assert.strictEqual(logs().viewState.older, 'more');
	});

	test('EMPTY_WINDOWS: Load older over windows with none of the pipeline\'s records jumps to the record just before each, until one has them', async () => {
		// In time order, as ListOffsets by time assumes; the other pipeline's records make windows that are not empty but hold none of orders'.
		topic.write(rec(ORDERS, 'two hours', 2 * HOUR), rec(CLICKS, 'other', 50 * MINUTE), rec(CLICKS, 'other 2', 20 * MINUTE));
		await showOrders();
		assert.deepStrictEqual(texts(), []);
		await logs().loadOlder();
		assert.deepStrictEqual(texts(), ['two hours']);
		const [orders, other] = topic.partitions[0];
		assert.deepStrictEqual(topic.ranges.map((r) => r.toTime).slice(1), [other.timestamp, orders.timestamp], 'each next window ends at the record just before the last');
		assert.ok(topic.ranges.every((r) => r.toTime - r.fromTime === LOGS_WINDOW_MS));
		assert.strictEqual(topic.timeBeforeReads, 2);
		assert.strictEqual(topic.logStartReads, 1, 'one reader for the whole walk');
		// The record two hours back is the log's first: nothing older.
		assert.strictEqual(logs().viewState.older, 'none');
	});

	test('EMPTY_WEEK: a week of silence before the default range is jumped over: one empty window, then the record before it', async () => {
		topic.write(rec(ORDERS, 'a week ago', 7 * DAY + HOUR));
		await showOrders();
		assert.deepStrictEqual(texts(), []);
		await logs().loadOlder();
		assert.deepStrictEqual(texts(), ['a week ago']);
		assert.strictEqual(topic.ranges.length, 2, 'one empty window, then the one with the record');
		assert.strictEqual(logs().viewState.older, 'none');
	});

	test('LOAD_OLDER while a range is read: refused (nothing read) until the range is read', async () => {
		const t0 = Date.now();
		topic.write(...Array.from({ length: 3000 }, (_, i) => recAt(ORDERS, `w${i}`, t0 - 6 * DAY + i * MINUTE)));
		await showOrders();
		topic.rangeDelayMs = 100;
		await logs().chooseRange({ kind: 'week' });
		assert.ok(await waitFor(() => topic.activeRanges().length === 1, 10_000));
		await logs().loadOlder();
		assert.strictEqual(topic.ranges.length, 1, 'no Load older read');
		assert.strictEqual(topic.logStartReads, 0);
		assert.strictEqual(logs().viewState.older, 'more');
		assert.ok(await waitFor(() => logs().viewState.done, 20_000), logs().statusText);
		assert.strictEqual(texts().length, 3000);
	});

	test('LOAD_OLDER failure: "Could not load older records: …" in its row, kept while the tail goes on; the status line stays the tail\'s', async () => {
		topic.write(rec(ORDERS, 'one', MINUTE));
		await showOrders();
		topic.refuseRead = true;
		await logs().loadOlder();
		assert.match(logs().viewState.olderError ?? '', /^Could not load older records: not allowed to read __redpanda\.connect\.logs/);
		assert.strictEqual(logs().panelState.kind, 'none', 'no state: the tail goes on');
		assert.strictEqual(logs().viewState.older, 'more');
		topic.write(rec(ORDERS, 'two'));
		assert.ok(await waitFor(() => texts().length === 2, 10_000), 'the tail goes on');
		assert.strictEqual(logs().statusText, FOLLOWING_STATUS);
		assert.match(logs().viewState.olderError ?? '', /^Could not load older records: /, 'still shown');
	});

	test('SINCE_DEPLOY slow: another range chosen while the pipeline\'s GET is slow wins; the deploy range is dropped', async () => {
		fake.cluster(VILNIUS).pipelines.find((p) => p.id === ORDERS)!.update_time = new Date(Date.now() - 2 * HOUR).toISOString();
		topic.write(rec(ORDERS, '3h', 3 * HOUR), rec(ORDERS, '30m', 30 * MINUTE));
		await showOrders();
		fake.delay = (req) => (req.method === 'GET' && req.url.endsWith(`/pipelines/${ORDERS}`) ? 800 : 0);
		try {
			const deploy = logs().chooseRange({ kind: 'deploy' });
			assert.strictEqual(await logs().chooseRange({ kind: 'hour' }), true);
			assert.strictEqual(await deploy, false, 'the deploy range gave way');
			assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
			assert.strictEqual(logs().viewState.range.kind, 'hour');
			assert.deepStrictEqual(texts(), ['30m']);
			assert.deepStrictEqual(topic.activeTails(), [], 'no tail from the deploy time');
		} finally {
			fake.delay = undefined;
		}
	});

	test('GAP: two shown records 30 minutes or more apart get a note (computed from the rows); a range with none is read to its end (its note)', async () => {
		topic.write(rec(ORDERS, 'a', 50 * MINUTE), rec(ORDERS, 'b', 45 * MINUTE), rec(ORDERS, 'c', 10 * MINUTE));
		await showOrders();
		await logs().chooseRange({ kind: 'hour' });
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['a', 'b', 'c']);
		assert.deepStrictEqual(gapsIn(logs().rows()).map((g) => g.before), [2], 'one note, before c');
		const now = Date.now();
		await logs().chooseRange({ kind: 'custom', from: now - 40 * MINUTE, to: now - 20 * MINUTE });
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), []);
		const last = logs().posted.filter((m) => m.type === 'state').at(-1);
		assert.ok(last?.type === 'state' && last.state.done && last.state.range.to === now - 20 * MINUTE, 'the webview\'s empty-range note gets its From and To');
	});

	test('RETENTION: the menu\'s line from retention.ms, read once per pipeline; DescribeConfigs refused: within the topic\'s retention', async () => {
		await showOrders();
		assert.strictEqual(logs().viewState.retention, null, 'not read before the menu opens');
		assert.strictEqual(topic.retentionReads, 0);
		logs().requestRetention();
		assert.ok(await waitFor(() => logs().viewState.retention !== null, 10_000));
		assert.strictEqual(logs().viewState.retention, 'Records older than 7 days are gone (the topic\'s retention).');
		logs().requestRetention();
		assert.strictEqual(topic.retentionReads, 1);
		topic.retentionMs = 'refused';
		await showLogs(CLICKS);
		logs().requestRetention();
		assert.ok(await waitFor(() => logs().viewState.retention !== null, 10_000));
		assert.strictEqual(logs().viewState.retention, RETENTION_UNKNOWN);
	});

	test('SWITCH: another range, or another pipeline, while a range is read: the earlier read stops, the new one starts', async () => {
		const t0 = Date.now();
		topic.write(...Array.from({ length: 3000 }, (_, i) => recAt(ORDERS, `w${i}`, t0 - 6 * DAY + i * MINUTE)), rec(ORDERS, 'recent', 30 * MINUTE));
		await showOrders();
		topic.rangeDelayMs = 100;
		await logs().chooseRange({ kind: 'week' });
		assert.ok(await waitFor(() => topic.activeRanges().length === 1, 10_000));
		const week = topic.activeRanges()[0];
		await logs().chooseRange({ kind: 'hour' });
		assert.strictEqual(week.signal.aborted, true, 'the week\'s read stopped');
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['recent']);
		await logs().chooseRange({ kind: 'week' });
		assert.ok(await waitFor(() => topic.activeRanges().length === 1, 10_000));
		const again = topic.activeRanges()[0];
		await showLogs(CLICKS);
		assert.strictEqual(again.signal.aborted, true, 'another pipeline stops it');
		assert.strictEqual(logs().viewState.range.kind, 'recent', 'the new pipeline on the default range');
		assert.ok(await waitFor(() => logs().statusText === FOLLOWING_STATUS, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), []);
	});

	// --- ticket 6.4: filter and search ---

	/** Sets the filter on a live range and waits until the range read again follows. */
	async function filterLive(filter: Partial<LogFilter>): Promise<void> {
		assert.strictEqual(logs().setFilter({ ...NO_FILTER, ...filter }), true);
		assert.ok(await waitFor(() => logs().statusText === FOLLOWING_STATUS, 10_000), logs().statusText);
	}
	const counts = () => logs().viewState.counts;

	test('LEVELS: Info off hides its records, its chip still counts them; "N of M"; all levels off: nothing kept, the counts stay', async () => {
		topic.write(
			rec(ORDERS, 'i1', 9 * MINUTE), rec(ORDERS, 'w1', 8 * MINUTE, { level: 'WARN' }), rec(ORDERS, 'i2', 7 * MINUTE),
			rec(ORDERS, 'e1', 6 * MINUTE, { level: 'ERROR' }), rec(ORDERS, 'd1', 5 * MINUTE, { level: 'DEBUG' }), { key: ORDERS, value: 'raw text', timestamp: Date.now() - 4 * MINUTE },
		);
		await showOrders();
		assert.deepStrictEqual(counts(), { levels: { error: 1, warn: 1, info: 2, debug: 1, other: 1 }, total: 6, matched: 6 });
		const tails = topic.tails.length;
		await filterLive({ levels: ['error', 'warn', 'debug', 'other'] });
		assert.strictEqual(topic.tails.length, tails + 1, 'the range read again');
		assert.deepStrictEqual(logs().rows().map((r) => r.message.slice(r.message.indexOf(':') + 1)), ['w1', 'e1', 'd1', 'raw text']);
		assert.deepStrictEqual(counts(), { levels: { error: 1, warn: 1, info: 2, debug: 1, other: 1 }, total: 6, matched: 4 }, 'Info still counts 2');
		const last = logs().posted.filter((m) => m.type === 'state' || m.type === 'show').at(-1);
		assert.ok(last && (last.type === 'state' || last.type === 'show') && last.state.counts.matched === 4 && last.state.filter.levels.length === 4, 'the webview gets the counts and the filter');
		await filterLive({ levels: [] });
		assert.deepStrictEqual(texts(), []);
		assert.deepStrictEqual(counts(), { levels: { error: 1, warn: 1, info: 2, debug: 1, other: 1 }, total: 6, matched: 0 });
		// Match case without a search keeps the same rows: no read.
		const reads = topic.tails.length;
		assert.strictEqual(logs().setFilter({ ...NO_FILTER, levels: [], matchCase: true }), true);
		assert.strictEqual(topic.tails.length, reads, 'nothing read again');
		assert.strictEqual(logs().viewState.filter.matchCase, true);
	});

	test('SEARCH: "secret" in the message or any field\'s name or value, case-insensitive; license_org never matched', async () => {
		topic.write(
			rec(ORDERS, 'a Secret in the message', 9 * MINUTE),
			rec(ORDERS, 'in a value', 8 * MINUTE, { note: 'top SECRET' }),
			rec(ORDERS, 'in a name', 7 * MINUTE, { secret_name: 'x' }),
			rec(ORDERS, 'only in license_org', 6 * MINUTE, { license_org: 'secret-org' }),
			rec(ORDERS, 'none', 5 * MINUTE),
		);
		await showOrders();
		await filterLive({ text: 'secret' });
		assert.deepStrictEqual(texts(), ['a Secret in the message', 'in a value', 'in a name']);
		assert.deepStrictEqual([counts().matched, counts().total], [3, 5]);
	});

	test('CASE_REGEX: Match case; a regular expression; an invalid one is refused and nothing is read', async () => {
		topic.write(rec(ORDERS, 'job failed', 9 * MINUTE), rec(ORDERS, 'will FAIL', 8 * MINUTE), rec(ORDERS, 'fine', 7 * MINUTE));
		await showOrders();
		await filterLive({ text: 'fail', matchCase: true });
		assert.deepStrictEqual(texts(), ['job failed']);
		await filterLive({ text: 'fail(ed)?$', regex: true });
		assert.deepStrictEqual(texts(), ['job failed', 'will FAIL']);
		const reads = topic.tails.length + topic.ranges.length;
		assert.strictEqual(logs().setFilter({ ...NO_FILTER, text: '(', regex: true }), false);
		assert.strictEqual(topic.tails.length + topic.ranges.length, reads, 'nothing read');
		assert.deepStrictEqual(logs().viewState.filter, { ...NO_FILTER, text: 'fail(ed)?$', regex: true }, 'the filter stays');
		assert.deepStrictEqual(texts(), ['job failed', 'will FAIL']);
	});

	test('FIELD_FILTER and COMBINED: an instance chip keeps that instance\'s records; with a level and a search, the records matching all', async () => {
		topic.write(
			rec(ORDERS, 'one', 9 * MINUTE, { instance_id: 'inst-a' }), rec(ORDERS, 'two', 8 * MINUTE, { instance_id: 'inst-b' }),
			rec(ORDERS, 'secret b warn', 7 * MINUTE, { instance_id: 'inst-b', level: 'WARN' }), rec(ORDERS, 'secret b info', 6 * MINUTE, { instance_id: 'inst-b' }),
			rec(ORDERS, 'secret a warn', 5 * MINUTE, { instance_id: 'inst-a', level: 'WARN' }),
		);
		await showOrders();
		await filterLive({ fields: [['instance_id', 'inst-b']] });
		assert.deepStrictEqual(texts(), ['two', 'secret b warn', 'secret b info']);
		await filterLive({ fields: [['instance_id', 'inst-b']], levels: ['warn'], text: 'secret' });
		assert.deepStrictEqual(texts(), ['secret b warn']);
		await filterLive({ fields: [['path', '/config/connect.yaml'], ['instance_id', 'inst-a']] });
		assert.deepStrictEqual(texts(), ['one', 'secret a warn'], 'a field chip');
		await filterLive({});
		assert.strictEqual(texts().length, 5, '× on every chip: all again');
	});

	test('SEVEN_DAYS_MATCHES (OVER_CAP_MATCHES): 20,000 records over 7 days, 40 WARN with "secret" in a field: Warn only and "secret" on Last 7 days shows all 40, "40 of 20,000", Info still counted', async () => {
		const t0 = Date.now();
		const secret = new Set(Array.from({ length: 40 }, (_, k) => 250 + k * 487));
		const warnOnly = new Set(Array.from({ length: 60 }, (_, k) => 100 + k * 331));
		const infoSecret = new Set(Array.from({ length: 100 }, (_, k) => 50 + k * 197));
		topic.write(...Array.from({ length: 20_000 }, (_, i) => {
			const r = recAt(ORDERS, `r${i}`, t0 - 7 * DAY + MINUTE + i * 29_000);
			const value = secret.has(i) ? { ...r.value, level: 'WARN', detail: `rotated the secret ${i}` }
				: warnOnly.has(i) && !secret.has(i) ? { ...r.value, level: 'WARN' }
					: infoSecret.has(i) ? { ...r.value, detail: 'secret' } : r.value;
			return { ...r, value };
		}));
		const warns = new Set([...secret, ...warnOnly]).size;
		await showOrders();
		assert.strictEqual(logs().cap, MAX_LOG_ROWS);
		await filterLive({ levels: ['warn'], text: 'secret' });
		// The filter stays when the range changes.
		assert.strictEqual(await logs().chooseRange({ kind: 'week' }), true);
		assert.ok(await waitFor(() => logs().viewState.done, 30_000), logs().statusText);
		assert.deepStrictEqual(logs().viewState.filter, { ...NO_FILTER, levels: ['warn'], text: 'secret' });
		assert.deepStrictEqual(texts(), [...secret].sort((a, b) => a - b).map((i) => `r${i}`), 'all 40, oldest first');
		assert.deepStrictEqual(counts(), { levels: { error: 0, warn: warns, info: 20_000 - warns, debug: 0, other: 0 }, total: 20_000, matched: 40 });
		assert.strictEqual(logs().droppedCount, 0, 'the cap counts matches: none left out');
		assert.strictEqual(logs().statusText, 'Read 20,000 records of the last 7 days; 40 match. Live is off.');
		assert.ok(logs().rows().every((r) => r.level === 'WARN' && r.fields.some(([, v]) => v.includes('secret'))));
	});

	test('LIVE: a filter on while Live follows: only matching new records appended; the counts go up', async () => {
		topic.write(rec(ORDERS, 'keep old', 5 * MINUTE), rec(ORDERS, 'drop old', 4 * MINUTE));
		await showOrders();
		await filterLive({ text: 'keep' });
		assert.deepStrictEqual(texts(), ['keep old']);
		topic.write(rec(ORDERS, 'drop new'), rec(ORDERS, 'keep new'), rec(CLICKS, 'keep other pipeline'));
		assert.ok(await waitFor(() => counts().total === 4, 10_000), JSON.stringify(counts()));
		assert.deepStrictEqual(texts(), ['keep old', 'keep new']);
		assert.deepStrictEqual([counts().matched, counts().total], [2, 4]);
		assert.strictEqual(topic.activeTails().length, 1, 'one reader');
		// Live off, then a filter change: the live range read up to now; Live stays off.
		await logs().setLive(false);
		const tails = topic.tails.length;
		assert.strictEqual(logs().setFilter({ ...NO_FILTER, text: 'drop' }), true);
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['drop old', 'drop new']);
		assert.strictEqual(topic.tails.length, tails, 'no tail');
		assert.strictEqual(logs().viewState.live, false);
		assert.strictEqual(logs().statusText, 'Read 4 records of the last 15 minutes; 2 match. Live is off.');
	});

	test('LOAD_OLDER: with a filter on, older matching records only; a record read again is not counted twice', async () => {
		topic.write(rec(ORDERS, 'keep older', 20 * MINUTE), rec(ORDERS, 'drop older', 18 * MINUTE), rec(ORDERS, 'drop new', 6 * MINUTE), rec(ORDERS, 'keep new', 5 * MINUTE));
		await showOrders();
		await filterLive({ text: 'keep' });
		assert.deepStrictEqual(texts(), ['keep new']);
		assert.strictEqual(logs().viewState.olderBefore, topic.partitions[0][2].timestamp, 'from the oldest record read, not the oldest kept');
		await logs().loadOlder();
		assert.deepStrictEqual(texts(), ['keep older', 'keep new']);
		assert.deepStrictEqual([counts().matched, counts().total], [2, 4], 'the records read again in the window counted once');
		assert.strictEqual(logs().viewState.older, 'none');
	});

	test('LEFT_OUT: a live range past the cap, Load older twice: the records left out are read back first, none skipped', async () => {
		// r0 … r6, 2 minutes apart; the cap keeps 3 (r4 … r6), r0 … r3 left out.
		topic.write(...[14, 12, 10, 8, 6, 4, 2].map((m, i) => rec(ORDERS, `r${i}`, m * MINUTE)));
		logs().cap = 3;
		const windowMs = logs().windowMs;
		await showOrders();
		try {
			assert.deepStrictEqual(texts(), ['r4', 'r5', 'r6']);
			// Load older windows of 3 minutes: shorter than what was left out.
			logs().windowMs = 3 * MINUTE;
			await logs().loadOlder();
			assert.deepStrictEqual(texts(), ['r3', 'r4', 'r5'], 'the newest left out read back; the newest dropped');
			assert.strictEqual(logs().droppedCount, 0);
			await logs().loadOlder();
			assert.deepStrictEqual(texts(), ['r2', 'r3', 'r4'], 'from the oldest shown, not the oldest counted: nothing skipped');
			await logs().loadOlder();
			await logs().loadOlder();
			assert.deepStrictEqual(texts(), ['r0', 'r1', 'r2']);
		} finally {
			logs().windowMs = windowMs;
		}
	});

	test('LOAD_OLDER with a filter: reads back past windows with no match, at most 24 hours per click ("No matches back to …"); the next click goes on', async () => {
		topic.write(
			rec(ORDERS, 'keep ancient', 30 * HOUR),
			...Array.from({ length: 28 }, (_, k) => rec(ORDERS, `drop ${28 - k}h`, (28 - k) * HOUR)),
			rec(ORDERS, 'keep new', 5 * MINUTE),
		);
		await showOrders();
		await filterLive({ text: 'keep' });
		assert.deepStrictEqual(texts(), ['keep new']);
		await logs().loadOlder();
		assert.deepStrictEqual(texts(), ['keep new'], 'no match within 24 hours');
		const note = logs().viewState.olderNote ?? '';
		assert.match(note, /^No matches back to .+; Load older to search further$/);
		assert.strictEqual(logs().viewState.older, 'more');
		assert.ok(counts().total > 20 && counts().total < 30, `the records searched counted: ${counts().total}`);
		assert.strictEqual(note, noMatchesBackText(topic.ranges.at(-1)!.fromTime), 'says how far it searched');
		await logs().loadOlder();
		assert.deepStrictEqual(texts(), ['keep ancient', 'keep new']);
		assert.strictEqual(logs().viewState.olderNote, null);
		assert.deepStrictEqual([counts().matched, counts().total], [2, 30]);
		assert.strictEqual(logs().viewState.older, 'none');
	});

	test('JSON: a record\'s whole JSON as shown (masked, license_org left out); Copy JSON copies it, pretty-printed', async () => {
		topic.write(rec(ORDERS, `quoting ${PASSWORD}`, MINUTE, { license_org: LICENSE_ORG, probe_n: 7, nested: { ok: true } }));
		await showOrders();
		const [row] = logs().rows();
		const json = JSON.parse(row.json!) as Record<string, unknown>;
		assert.strictEqual(json.probe_n, 7, 'the value\'s types kept');
		assert.deepStrictEqual(json.nested, { ok: true });
		assert.strictEqual(json.pipeline_id, ORDERS);
		assert.ok(!('license_org' in json));
		assert.ok(!row.json!.includes(LICENSE_ORG) && !row.json!.includes(PASSWORD), 'masked');
		await vscode.env.clipboard.writeText('');
		assert.strictEqual(await logs().copyJson(row.id), true);
		assert.strictEqual(await vscode.env.clipboard.readText(), row.json);
		assert.ok(row.json!.includes('\n  "probe_n": 7'), 'pretty-printed');
		assert.strictEqual(await logs().copyJson('0:999'), false);
	});

	test('AROUND: Show records around this one: the 5 minutes before and after it, the filter cleared, Live off', async () => {
		topic.write(
			rec(ORDERS, '40m', 40 * MINUTE), rec(ORDERS, '34m', 34 * MINUTE), rec(ORDERS, '30m target', 30 * MINUTE),
			rec(ORDERS, '27m', 27 * MINUTE), rec(ORDERS, '20m', 20 * MINUTE), rec(ORDERS, '5m', 5 * MINUTE),
		);
		await showOrders();
		await logs().chooseRange({ kind: 'hour' });
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		assert.strictEqual(logs().setFilter({ ...NO_FILTER, text: 'target' }), true);
		assert.ok(await waitFor(() => logs().viewState.done && texts().length === 1, 10_000), logs().statusText);
		const target = logs().rows()[0];
		await logs().setLive(true);
		assert.strictEqual(logs().around(target.id), true);
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['34m', '30m target', '27m']);
		assert.deepStrictEqual(logs().viewState.range, { kind: 'custom', from: target.time - AROUND_MS, to: target.time + AROUND_MS });
		assert.deepStrictEqual(logs().viewState.filter, NO_FILTER, 'the filter cleared');
		assert.strictEqual(logs().viewState.live, false, 'Live off');
		assert.deepStrictEqual(topic.activeTails(), []);
		assert.strictEqual(logs().around('0:999'), false);
	});

	test('SWITCH (6.4): another pipeline clears the filter', async () => {
		topic.write(rec(ORDERS, 'o', MINUTE), rec(CLICKS, 'c', MINUTE));
		await showOrders();
		await filterLive({ text: 'nothing like it', levels: ['error'] });
		assert.deepStrictEqual(texts(), []);
		await showLogs(CLICKS);
		assert.deepStrictEqual(logs().viewState.filter, NO_FILTER);
		assert.ok(await waitFor(() => texts().length === 1, 10_000), logs().statusText);
		assert.deepStrictEqual(counts(), { levels: { error: 0, warn: 0, info: 1, debug: 0, other: 0 }, total: 1, matched: 1 });
	});

	// --- ticket 6.5: entry points ---

	const palette = () => vscode.commands.executeCommand<{ kind: string; pipelineId?: string }>(SHOW_LOGS_COMMAND);
	const aroundError = (id = ORDERS, clusterId = VILNIUS) =>
		vscode.commands.executeCommand<{ kind: string; pipelineId?: string }>(SHOW_LOGS_AROUND_ERROR_COMMAND, pipelineNode(clusterId, id));
	/** An ERROR record of pipeline `id` at time `ts`. */
	const errAt = (id: string, text: string, ts: number) => {
		const r = recAt(id, text, ts);
		return { ...r, value: { ...r.value, level: 'ERROR' } };
	};
	/** A record of pipeline `id` at `ts` with `level`. */
	const levelAt = (id: string, text: string, ts: number, level: string) => {
		const r = recAt(id, text, ts);
		return { ...r, value: { ...r.value, level } };
	};

	/** A detected config `<name>.yaml` in the suite's directory, active in the editor; with `mapTo`, its `.cloud.json` maps it there. */
	async function openConfig(name: string, mapTo?: { readonly clusterId: string; readonly pipelineId: string; readonly pipelineName: string }): Promise<vscode.TextDocument> {
		const file = path.join(dir, `${name}.yaml`);
		fs.writeFileSync(file, 'input:\n  generate:\n    mapping: root = 1\noutput:\n  drop: {}\n');
		const sidecar = path.join(dir, `${name}.cloud.json`);
		if (mapTo) {
			fs.writeFileSync(sidecar, serializeMapping({ clusterName: 'rpc-vilnius', ...mapTo }));
		} else {
			fs.rmSync(sidecar, { force: true });
		}
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc, { preview: false });
		assert.ok(await waitFor(() => api().detection.isDetected(doc.uri), 10_000), `${file} is not detected`);
		return doc;
	}

	test('PALETTE_MAPPED: Show pipeline logs with a config whose .cloud.json maps it to a pipeline: that pipeline\'s log at once, as from its row; the pipeline gone: said so, then the pick', async () => {
		await setUpAccess();
		topic.write(rec(ORDERS, 'o1', MINUTE), rec(CLICKS, 'c1', MINUTE));
		try {
			await openConfig('orders', { clusterId: VILNIUS, pipelineId: ORDERS, pipelineName: 'orders' });
			assert.deepStrictEqual(await palette(), { kind: 'shown', pipelineId: ORDERS });
			assert.deepStrictEqual(pipelinesOffered, [], 'no pick');
			assert.strictEqual(logs().title, 'orders · rpc-vilnius');
			assert.ok(await waitFor(() => messages(ORDERS).length === 1, 10_000), logs().statusText);
			assert.strictEqual(logs().viewState.range.kind, 'recent', 'the default range, as Show logs on its row');
			assert.strictEqual(logs().viewState.highlightErrors, false);
			// The mapped pipeline gone: said so, then the pick.
			await openConfig('gone', { clusterId: VILNIUS, pipelineId: 'd3gone00000000000009', pipelineName: 'gone' });
			script({ pipelinePicks: ['clicks'] });
			assert.deepStrictEqual(await palette(), { kind: 'shown', pipelineId: CLICKS });
			assert.ok(infos.includes('Pipeline gone, which gone.cloud.json maps gone.yaml to, is no longer on rpc-vilnius. Choose the pipeline whose logs to show.'), infos.join('\n'));
			assert.strictEqual(pipelinesOffered.length, 1, 'the pick');
			assert.strictEqual(logs().title, 'clicks · rpc-vilnius', 'SWITCH: the tab switches to it');
			assert.ok(await waitFor(() => messages(CLICKS).length === 1, 10_000), logs().statusText);
			// A .cloud.json that is not a mapping: said so, then the pick.
			await openConfig('bad');
			fs.writeFileSync(path.join(dir, 'bad.cloud.json'), '{ not json');
			infos.length = 0;
			script({ pipelinePicks: ['orders'] });
			assert.deepStrictEqual(await palette(), { kind: 'shown', pipelineId: ORDERS });
			assert.strictEqual(infos.length, 1, infos.join('\n'));
			assert.match(infos[0], /^bad\.cloud\.json could not be read: it is not JSON \(.+\)\. Choose the pipeline whose logs to show\.$/);
			assert.strictEqual(pipelinesOffered.length, 1, 'the pick');
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		}
	});

	test('ERROR_NOTIFICATION (AC1): a deploy (create) and an update that end in Error on a cluster with log access: Show logs opens the last 15 minutes, its ERROR records highlighted', async () => {
		await setUpAccess();
		cloud().pollMs = 20;
		const lint = cloud().lint;
		const localVersion = cloud().localVersion;
		const localCatalogue = cloud().localCatalogue;
		cloud().lint = async () => ({ kind: 'findings', findings: [], logLines: [] });
		cloud().localVersion = () => undefined;
		cloud().localCatalogue = () => undefined;
		try {
			const doc = await openConfig('deployed');
			fake.createSequence = [{ state: 'STATE_STARTING' }, { state: 'STATE_ERROR', error: 'bad input' }];
			script({ inputs: ['deployed'], actions: [SHOW_LOGS_ACTION] });
			const created = await vscode.commands.executeCommand<{ kind: string; state?: string; pipelineId?: string }>(DEPLOY_COMMAND, doc.uri);
			assert.strictEqual(created?.state, 'STATE_ERROR', errors.join('\n'));
			const id = created!.pipelineId!;
			assert.deepStrictEqual(errors, ['Pipeline deployed on rpc-vilnius is in Error: bad input.']);
			assert.deepStrictEqual(errorActions, [[SHOW_LOGS_ACTION]], 'log access set: Show logs');
			const before = Date.now();
			assert.deepStrictEqual(await cloud().errorFollowUp, { kind: 'shown', pipelineId: id });
			assert.strictEqual(logs().title, 'deployed · rpc-vilnius');
			const tail = topic.activeTails()[0];
			assert.ok(tail && Math.abs(tail.fromTime - (before - LOGS_WINDOW_MS)) < 5_000, 'the last 15 minutes');
			topic.write(rec(id, 'starting', 2 * MINUTE), rec(id, 'failed', MINUTE, { level: 'ERROR' }));
			assert.ok(await waitFor(() => messages(id).length === 2, 10_000), logs().statusText);
			assert.strictEqual(logs().viewState.range.kind, 'recent');
			assert.strictEqual(logs().viewState.highlightErrors, true, 'its ERROR records highlighted');
			assert.strictEqual(logs().rows()[1].level, 'ERROR');
			// The update of that pipeline (in Error, so not restarted) ends in Error too.
			await showLogs(CLICKS);
			assert.strictEqual(logs().viewState.highlightErrors, false);
			const edit = new vscode.WorkspaceEdit();
			edit.insert(doc.uri, doc.positionAt(doc.getText().length), '# changed\n');
			assert.ok(await vscode.workspace.applyEdit(edit));
			errors.length = 0;
			errorActions.length = 0;
			script({ actions: [SHOW_LOGS_ACTION] });
			const updated = await vscode.commands.executeCommand<{ kind: string; state?: string; pipelineId?: string }>(DEPLOY_COMMAND, doc.uri);
			assert.strictEqual(updated?.state, 'STATE_ERROR', errors.join('\n'));
			assert.strictEqual(updated?.pipelineId, id, 'an update of the same pipeline');
			assert.deepStrictEqual(errorActions, [[SHOW_LOGS_ACTION]]);
			assert.deepStrictEqual(await cloud().errorFollowUp, { kind: 'shown', pipelineId: id });
			assert.strictEqual(logs().title, 'deployed · rpc-vilnius');
			assert.ok(await waitFor(() => messages(id).length === 2, 10_000), logs().statusText);
			assert.deepStrictEqual(texts(), ['starting', 'failed'], 'the last 15 minutes');
			assert.strictEqual(logs().viewState.highlightErrors, true);
		} finally {
			cloud().lint = lint;
			cloud().localVersion = localVersion;
			cloud().localCatalogue = localCatalogue;
			fake.createSequence = [{ state: 'STATE_STARTING' }, { state: 'STATE_RUNNING' }];
			await vscode.workspace.saveAll();
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		}
	});

	test('PALETTE_PICK: no mapped config: every pipeline on every cluster, by cluster then name (name; cluster, state); choosing one opens its log; Escape opens nothing; not connected: Connect first', async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await setUpAccess();
		fake.cluster(VILNIUS).pipelines.push(pipeline('d3alpha0000000000004', 'alpha'));
		topic.write(rec(ORDERS, 'o1', MINUTE));
		const readers = topic.targets.length;
		script({ pipelinePicks: [undefined] });
		assert.deepStrictEqual(await palette(), { kind: 'notStarted' });
		assert.deepStrictEqual(pipelinesOffered[0].map((c) => [c.label, c.description]), [
			['events', `byoc-eu · Running · ${NO_LOG_ACCESS_SET}`],
			['alpha', 'rpc-vilnius · Running'],
			['clicks', 'rpc-vilnius · Running'],
			['orders', 'rpc-vilnius · Running'],
		]);
		assert.strictEqual(topic.targets.length, readers, 'Escape: nothing read');
		script({ pipelinePicks: ['orders'] });
		assert.deepStrictEqual(await palette(), { kind: 'shown', pipelineId: ORDERS });
		assert.strictEqual(logs().title, 'orders · rpc-vilnius');
		assert.ok(await waitFor(() => messages(ORDERS).length === 1, 10_000), logs().statusText);
		// Not connected: Connect is offered first; declined, nothing.
		await cloud().disconnect();
		await new Promise((r) => setTimeout(r, 300));
		infoActions.length = 0;
		script({ actions: [undefined] });
		assert.deepStrictEqual(await palette(), { kind: 'notStarted' });
		assert.deepStrictEqual(infoActions, [[CONNECT_ACTION]]);
		assert.deepStrictEqual(pipelinesOffered, []);
		// Connected from there: the pick.
		script({ actions: [CONNECT_ACTION], inputs: [CLIENT_ID, CLIENT_SECRET], pipelinePicks: ['clicks'] });
		assert.deepStrictEqual(await palette(), { kind: 'shown', pipelineId: CLICKS });
		assert.strictEqual(logs().title, 'clicks · rpc-vilnius');
	});

	test('PALETTE_NO_ACCESS: a pipeline on a cluster without log access says "no log access set"; choosing it offers Set up log access (declined: nothing), then the log', async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		const EVENTS = 'd3byoc00000000000003';
		topic.write(rec(EVENTS, 'e1', MINUTE));
		script({ pipelinePicks: ['events'], actions: [undefined] });
		assert.deepStrictEqual(await palette(), { kind: 'noAccess' });
		assert.ok(pipelinesOffered[0].every((c) => c.description.endsWith(` · ${NO_LOG_ACCESS_SET}`)), 'neither cluster has access');
		assert.deepStrictEqual(infos, [noLogAccessMessage('byoc-eu')]);
		assert.deepStrictEqual(infoActions, [[SET_UP_LOG_ACCESS_ACTION]]);
		assert.strictEqual(topic.targets.length, 0, 'declined: nothing read');
		script({ pipelinePicks: ['events'], actions: [SET_UP_LOG_ACCESS_ACTION], inputs: [USERNAME, PASSWORD], choices: ['SCRAM-SHA-256'] });
		assert.deepStrictEqual(await palette(), { kind: 'shown', pipelineId: EVENTS });
		assert.deepStrictEqual(await cloud().storedLogAccess(BYOC), { username: USERNAME, mechanism: 'SCRAM-SHA-256' });
		assert.strictEqual(logs().title, 'events · byoc-eu');
		assert.ok(await waitFor(() => messages(EVENTS).length === 1, 10_000), logs().statusText);
	});

	test('ERROR_NOTIFICATION: a start that ends in Error offers Set up log access… (no access), then the log; with access Show logs: the last 15 minutes, ERROR records highlighted; declined: nothing', async () => {
		cloud().pollMs = 20;
		fake.cluster(VILNIUS).pipelines = [{ ...pipeline(ORDERS, 'orders'), state: 'STATE_STOPPED' }, pipeline(CLICKS, 'clicks')];
		await cloud().refresh({ kind: 'cluster', id: VILNIUS });
		topic.write(rec(ORDERS, 'starting', 20 * MINUTE), rec(ORDERS, 'loading', 2 * MINUTE), rec(ORDERS, 'failed', MINUTE, { level: 'ERROR' }));
		const startToError = async () => {
			fake.cluster(VILNIUS).pipelines.find((p) => p.id === ORDERS)!.state = 'STATE_STOPPED';
			fake.startSequence = [{ state: 'STATE_STARTING' }, { state: 'STATE_ERROR', error: 'bad input' }];
			const started = await vscode.commands.executeCommand<{ kind: string; state?: string }>(START_COMMAND, pipelineNode(VILNIUS, ORDERS));
			assert.strictEqual(started?.state, 'STATE_ERROR', errors.join('\n'));
			return cloud().errorFollowUp;
		};
		script({ actions: [SET_UP_LOG_ACCESS_ACTION], inputs: [USERNAME, PASSWORD], choices: ['SCRAM-SHA-256'] });
		assert.deepStrictEqual(await startToError(), { kind: 'shown', pipelineId: ORDERS });
		assert.deepStrictEqual(errors, ['Pipeline orders on rpc-vilnius is in Error: bad input.']);
		assert.deepStrictEqual(errorActions, [[SET_UP_LOG_ACCESS_ACTION]]);
		assert.deepStrictEqual(await cloud().storedLogAccess(VILNIUS), { username: USERNAME, mechanism: 'SCRAM-SHA-256' });
		assert.strictEqual(logs().title, 'orders · rpc-vilnius');
		assert.ok(await waitFor(() => messages(ORDERS).length === 2, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['loading', 'failed'], 'the default range: the last 15 minutes');
		assert.strictEqual(logs().viewState.range.kind, 'recent');
		assert.strictEqual(logs().viewState.highlightErrors, true, 'its ERROR records highlighted');
		// SWITCH: another pipeline shown from its row (no highlight), then the notification's Show logs.
		await showLogs(CLICKS);
		assert.strictEqual(logs().viewState.highlightErrors, false);
		errors.length = 0;
		errorActions.length = 0;
		script({ actions: [SHOW_LOGS_ACTION] });
		assert.deepStrictEqual(await startToError(), { kind: 'shown', pipelineId: ORDERS });
		assert.deepStrictEqual(errorActions, [[SHOW_LOGS_ACTION]], 'log access set: Show logs');
		assert.strictEqual(logs().title, 'orders · rpc-vilnius');
		assert.ok(await waitFor(() => messages(ORDERS).length === 2, 10_000), logs().statusText);
		assert.strictEqual(logs().viewState.highlightErrors, true);
		const shown = logs().posted.filter((m) => m.type === 'show').at(-1);
		assert.strictEqual(shown?.type === 'show' && shown.state.highlightErrors, true, 'the webview is told');
		// Declined: nothing opens.
		await showLogs(CLICKS);
		script({ actions: [undefined] });
		assert.strictEqual(await startToError(), undefined);
		assert.strictEqual(logs().title, 'clicks · rpc-vilnius');
	});

	test('AROUND (acceptance): Show logs around the error on an Error row: the newest ERROR record (3 hours old), the 5 minutes around it, every level, that record marked; SWITCH from another pipeline', async () => {
		await setUpAccess();
		const t0 = Date.now();
		const at = (minutes: number) => t0 - minutes * MINUTE;
		topic.write(
			errAt(ORDERS, 'older error', at(300)),
			recAt(ORDERS, '-188m', at(188)),
			levelAt(ORDERS, '-184m warn', at(184), 'WARN'),
			errAt(ORDERS, 'the error', at(180)),
			levelAt(ORDERS, '-177m debug', at(177), 'DEBUG'),
			recAt(ORDERS, '-172m', at(172)),
			errAt(CLICKS, 'another pipeline\'s error', at(50)),
			recAt(ORDERS, '-10m', at(10)),
		);
		await showLogs(CLICKS);
		assert.ok(await waitFor(() => logs().statusText === FOLLOWING_STATUS, 10_000), logs().statusText);
		assert.deepStrictEqual(await aroundError(), { kind: 'shown', pipelineId: ORDERS });
		assert.strictEqual(logs().title, 'orders · rpc-vilnius', 'SWITCH: the tab switches to it');
		assert.ok(await waitFor(() => logs().viewState.range.kind === 'custom' && logs().viewState.done, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['-184m warn', 'the error', '-177m debug'], 'the 5 minutes around it, every level');
		const target = logs().rows()[1];
		assert.strictEqual(target.level, 'ERROR');
		const errorTime = at(180);
		assert.deepStrictEqual(logs().viewState.range, { kind: 'custom', from: errorTime - AROUND_MS, to: errorTime + AROUND_MS });
		assert.strictEqual(logs().viewState.focusId, target.id, 'the found record is marked');
		assert.strictEqual(logs().viewState.highlightErrors, true);
		assert.strictEqual(logs().viewState.note, null);
		assert.strictEqual(logs().viewState.live, false);
		assert.deepStrictEqual(logs().viewState.filter, NO_FILTER);
		assert.deepStrictEqual(topic.activeTails(), [], 'the other pipeline is no longer read');
		// The search read back an hour at a time, newest first, and stopped at the window with the error.
		const search = topic.ranges.slice(0, -1);
		assert.strictEqual(search.length, 4, search.map((r) => Math.round((t0 - r.fromTime) / MINUTE)).join(', '));
		assert.ok(search.every((r, i) => i === 0 || r.toTime === search[i - 1].fromTime), 'contiguous windows, newest first');
		const shown = logs().posted.filter((m) => m.type === 'show').at(-1);
		assert.strictEqual(shown?.type === 'show' ? shown.state.focusId : undefined, target.id, 'the webview is told which row to scroll to');
		// Another range: the mark goes.
		assert.strictEqual(await logs().chooseRange({ kind: 'hour' }), true);
		assert.strictEqual(logs().viewState.focusId, null);
	});

	test('AROUND over the cap: more than the cap after the error: the found record is kept and marked, the newest dropped instead', async () => {
		await setUpAccess();
		logs().cap = 5;
		const t0 = Date.now();
		const errorTime = t0 - 30 * MINUTE;
		topic.write(
			recAt(ORDERS, 'b2', errorTime - 2 * MINUTE),
			recAt(ORDERS, 'b1', errorTime - MINUTE),
			errAt(ORDERS, 'the error', errorTime),
			...Array.from({ length: 10 }, (_, i) => recAt(ORDERS, `a${i}`, errorTime + (i + 1) * 10_000)),
		);
		assert.deepStrictEqual(await aroundError(), { kind: 'shown', pipelineId: ORDERS });
		assert.ok(await waitFor(() => logs().viewState.range.kind === 'custom' && logs().viewState.done, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['the error', 'a0', 'a1', 'a2', 'a3'], 'the older ones left out only up to it, then the newest dropped');
		assert.strictEqual(logs().viewState.focusId, logs().rows()[0].id);
		assert.strictEqual(logs().droppedCount, 2);
		assert.strictEqual(logs().viewState.newerDropped, 6);
		assert.ok(!logs().statusText.includes(focusNotShownText(errorTime)), logs().statusText);
		// The webview keeps the last `cap` of what it is sent: the same rows.
		const appended = logs().posted.filter((m) => m.type === 'append').flatMap((m) => (m.type === 'append' ? m.rows : []));
		assert.deepStrictEqual(appended.slice(-5).map((r) => r.message.slice(ORDERS.length + 1)), texts(), 'the webview shows the same rows');
	});

	test('AROUND none: no ERROR record within 24 hours: "No ERROR record in the last 24 hours" and the last hour; the search stops at the log\'s first offset', async () => {
		await setUpAccess();
		logs().errorWindowMs = 6 * HOUR;
		const t0 = Date.now();
		topic.write(
			errAt(ORDERS, 'too old', t0 - 25 * HOUR),
			recAt(ORDERS, '-2h', t0 - 2 * HOUR),
			recAt(ORDERS, '-30m', t0 - 30 * MINUTE),
			errAt(CLICKS, 'not this pipeline\'s', t0 - 20 * MINUTE),
		);
		assert.deepStrictEqual(await aroundError(), { kind: 'shown', pipelineId: ORDERS });
		assert.ok(await waitFor(() => logs().viewState.range.kind === 'hour' && logs().viewState.done, 10_000), logs().statusText);
		assert.strictEqual(logs().viewState.note, NO_ERROR_NOTE);
		assert.deepStrictEqual(texts(), ['-30m'], 'the last hour');
		assert.strictEqual(logs().viewState.focusId, null);
		assert.strictEqual(logs().viewState.highlightErrors, true);
		const search = topic.ranges.slice(0, -1);
		assert.strictEqual(search.length, 4, 'every window back to 24 hours');
		assert.strictEqual(search[0].toTime - search.at(-1)!.fromTime, ERROR_SEARCH_MS);
		// Only records of the last 2 hours: the first window starts at the log's first offset, the search stops there.
		topic.clear();
		topic.write(recAt(ORDERS, '-2h', t0 - 2 * HOUR), recAt(ORDERS, '-30m', t0 - 30 * MINUTE));
		assert.deepStrictEqual(await aroundError(), { kind: 'shown', pipelineId: ORDERS });
		assert.ok(await waitFor(() => logs().viewState.range.kind === 'hour' && logs().viewState.done, 10_000), logs().statusText);
		assert.strictEqual(topic.ranges.length, 2, 'one search window, then the last hour');
		assert.strictEqual(logs().viewState.note, NO_ERROR_NOTE);
	});

	test('AROUND hidden: the search stops with the tab hidden and is made again once it is shown', async () => {
		await setUpAccess();
		topic.rangeDelayMs = 300;
		topic.write(errAt(ORDERS, 'the error', Date.now() - 30 * MINUTE));
		assert.deepStrictEqual(await aroundError(), { kind: 'shown', pipelineId: ORDERS });
		assert.ok(await waitFor(() => topic.activeRanges().length === 1 && logs().reading, 10_000), 'searching');
		await vscode.commands.executeCommand('workbench.action.closePanel');
		assert.ok(await waitFor(() => !logs().reading && topic.activeRanges().length === 0, 10_000), 'the search stopped');
		assert.strictEqual(logs().viewState.range.kind, 'day', 'not found yet');
		topic.rangeDelayMs = 0;
		await vscode.commands.executeCommand(`${LOGS_VIEW_ID}.focus`);
		assert.ok(await waitFor(() => logs().viewState.range.kind === 'custom' && logs().viewState.done, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['the error']);
		assert.strictEqual(logs().viewState.focusId, logs().rows()[0].id);
	});

	// --- Ticket 6.6: the panel's empty and error states (board 6) ---

	/**
	 * Records the connection-lost countdowns from now on (each once, as its wait in seconds), read from
	 * the panel's state on each change (`posted` keeps only its last 200 messages). Disposed by the caller.
	 */
	const watchCountdowns = () => {
		const seen = new Map<number, number>();
		const sub = logs().onDidChange(() => {
			const p = logs().panelState;
			if (p.kind === 'connectionLost' && p.retryAt !== null) {
				seen.set(p.retryAt, p.retryInS);
			}
		});
		return { values: () => [...seen.values()], dispose: () => sub.dispose() };
	};
	const stateKind = () => logs().panelState.kind;
	const retryBody = (state: LogsPanelState) => panelStateTexts(state)?.body ?? '';

	test('NO_ACCESS (6.6): the state\'s Set up log access… runs 6.2\'s flow for the cluster and then reads the range; cancelled: the state stays', async () => {
		script({ actions: [undefined] });
		assert.deepStrictEqual(await showLogs(), { kind: 'noAccess' });
		assert.ok(await waitFor(() => logs().visible && stateKind() === 'noAccess', 10_000), stateKind());
		topic.write(rec(ORDERS, 'one', MINUTE));
		script({ inputs: [undefined] });
		assert.strictEqual(await logs().setUpAccess(), false, 'cancelled');
		assert.strictEqual(stateKind(), 'noAccess', 'the state stays');
		assert.strictEqual(topic.tails.length, 0);
		script({ inputs: [USERNAME, PASSWORD], choices: ['SCRAM-SHA-256'] });
		assert.strictEqual(await logs().setUpAccess(), true);
		assert.deepStrictEqual(await cloud().storedLogAccess(VILNIUS), { username: USERNAME, mechanism: 'SCRAM-SHA-256' });
		assert.ok(await waitFor(() => texts().length === 1 && logs().statusText === FOLLOWING_STATUS, 10_000), logs().statusText);
		assert.deepStrictEqual(texts(), ['one']);
		assert.strictEqual(stateKind(), 'none');
		assert.strictEqual(logs().viewState.range.kind, 'recent', 'the same range');
	});

	test('SIGN_IN (acceptance): a stored password the cluster refuses is Sign-in refused with its two actions; never tried again by itself; Retry tries once; Set up log access again… reads the same range', async () => {
		await setUpAccess();
		topic.write(rec(ORDERS, 'one', 2 * MINUTE));
		topic.password = 'rotated-logs-password-6-6-Qa9';
		assert.deepStrictEqual(await showLogs(), { kind: 'shown', pipelineId: ORDERS });
		assert.ok(await waitFor(() => stateKind() === 'signIn', 10_000), logs().statusText);
		assert.deepStrictEqual(logs().panelState, { kind: 'signIn', user: USERNAME, cluster: 'rpc-vilnius' });
		const texts6 = panelStateTexts(logs().panelState)!;
		assert.strictEqual(texts6.title, 'logs-reader could not sign in to rpc-vilnius');
		assert.ok(!texts6.body.includes('seed-0') && !texts6.body.includes(PASSWORD), 'no broker host or credential');
		assert.strictEqual(logs().statusText, texts6.title);
		const shown = logs().posted.filter((m) => m.type === 'state' || m.type === 'show').at(-1)!;
		assert.strictEqual((shown.type === 'state' || shown.type === 'show') && shown.state.panelState.kind, 'signIn', 'the webview is told');
		const tries = topic.tails.length;
		await new Promise((r) => setTimeout(r, 800));
		assert.strictEqual(topic.tails.length, tries, 'not tried again by itself');
		// Retry: one more try, refused again.
		assert.strictEqual(logs().retry(), true);
		assert.ok(await waitFor(() => topic.tails.length === tries + 1 && stateKind() === 'signIn', 10_000), stateKind());
		// AFTER_SETUP: cancelled, the state stays; then the new password is stored and the same range is read.
		script({ inputs: [USERNAME, undefined] });
		assert.strictEqual(await logs().setUpAccess(), false);
		assert.strictEqual(stateKind(), 'signIn');
		script({ inputs: [USERNAME, topic.password], choices: ['SCRAM-SHA-256'] });
		assert.strictEqual(await logs().setUpAccess(), true);
		assert.ok(await waitFor(() => texts().length === 1 && stateKind() === 'none', 10_000), logs().statusText);
		assert.strictEqual(logs().viewState.range.kind, 'recent');
		assert.strictEqual(topic.activeTails()[0]?.pipelineId, ORDERS);
	});

	test('NOT_ALLOWED: a user that may not read the topic is Not allowed, naming the topic; not tried again by itself; Use another user… failing keeps it; Retry reads once allowed', async () => {
		await setUpAccess();
		topic.write(rec(ORDERS, 'one', MINUTE));
		topic.refuseRead = true;
		await showLogs();
		assert.ok(await waitFor(() => stateKind() === 'notAllowed', 10_000), logs().statusText);
		assert.deepStrictEqual(logs().panelState, { kind: 'notAllowed', user: USERNAME, topic: '__redpanda.connect.logs' });
		assert.match(panelStateTexts(logs().panelState)!.body, /__redpanda\.connect\.logs/);
		const tries = topic.tails.length;
		await new Promise((r) => setTimeout(r, 800));
		assert.strictEqual(topic.tails.length, tries, 'not tried again by itself');
		// Use another user…: its test read is refused too, so nothing is stored and the state stays.
		script({ inputs: ['other-reader', PASSWORD], choices: ['SCRAM-SHA-256'] });
		assert.strictEqual(await logs().setUpAccess(), false);
		assert.strictEqual(stateKind(), 'notAllowed');
		// Retry while still refused: refused again.
		const before = topic.tails.length;
		assert.strictEqual(logs().retry(), true);
		assert.ok(await waitFor(() => topic.tails.length === before + 1 && stateKind() === 'notAllowed', 10_000), stateKind());
		// On the last hour, Use another user… with a user that may read: stored, and the same range read again.
		assert.strictEqual(await logs().chooseRange({ kind: 'hour' }), true);
		assert.ok(await waitFor(() => stateKind() === 'notAllowed', 10_000), stateKind());
		topic.refuseRead = false;
		topic.username = 'other-reader';
		topic.password = 'other-password-6-6-Kp2w';
		script({ inputs: ['other-reader', topic.password], choices: ['SCRAM-SHA-512'] });
		assert.strictEqual(await logs().setUpAccess(), true);
		assert.deepStrictEqual(await cloud().storedLogAccess(VILNIUS), { username: 'other-reader', mechanism: 'SCRAM-SHA-512' });
		assert.ok(await waitFor(() => logs().viewState.done && texts().length === 1, 10_000), logs().statusText);
		assert.strictEqual(logs().viewState.range.kind, 'hour', 'the same range');
		assert.strictEqual(stateKind(), 'none');
		assert.strictEqual(topic.targets.at(-1)?.access.username, 'other-reader');
	});

	test('ROW_SETUP (6.6): after Sign-in refused, Set up log access again from the cluster\'s row; the tab\'s Retry signs in with the new password', async () => {
		await setUpAccess();
		topic.write(rec(ORDERS, 'one', MINUTE));
		topic.password = 'rotated-on-the-row-6-6-Zt5';
		await showLogs();
		assert.ok(await waitFor(() => stateKind() === 'signIn', 10_000), logs().statusText);
		script({ inputs: [USERNAME, topic.password], choices: ['SCRAM-SHA-256'] });
		assert.strictEqual((await setUp())?.kind, 'stored', errors.join('\n'));
		assert.strictEqual(stateKind(), 'signIn', 'not tried again by itself');
		assert.strictEqual(logs().retry(), true);
		assert.ok(await waitFor(() => texts().length === 1 && stateKind() === 'none', 10_000), logs().statusText);
		assert.strictEqual(topic.targets.at(-1)?.access.password, topic.password);
	});

	test('SETUP_ONCE (6.6): a second Set up log access for a cluster while one runs is ignored', async () => {
		script({ inputs: [USERNAME, PASSWORD], choices: ['SCRAM-SHA-256'] });
		const [first, second] = await Promise.all([setUp(), setUp()]);
		assert.deepStrictEqual([first?.kind, second?.kind], ['stored', 'notStarted']);
		assert.strictEqual(topic.tests.length, 1, 'one test read');
	});

	test('RANGE_RESUME (6.6): a bounded read that loses its connection mid-way keeps its rows through the retry and reads on from where it reached, no row twice', async () => {
		logs().retryDelaysMs = [200];
		const t0 = Date.now();
		topic.write(...Array.from({ length: 1500 }, (_, i) => recAt(ORDERS, `r${i}`, t0 - 50 * MINUTE + i * 1_000)));
		await showOrders();
		topic.rangeDelayMs = 50;
		topic.dropRangeAfter = 1;
		let fewest = Number.POSITIVE_INFINITY;
		let lostSeen = false;
		const sub = logs().onDidChange(() => {
			if (logs().panelState.kind === 'connectionLost') {
				lostSeen = true;
			}
			if (lostSeen) {
				fewest = Math.min(fewest, logs().rows().length);
			}
		});
		teardowns.push(() => sub.dispose());
		assert.strictEqual(await logs().chooseRange({ kind: 'hour' }), true);
		assert.ok(await waitFor(() => lostSeen, 10_000), logs().statusText);
		assert.ok(await waitFor(() => logs().viewState.done, 20_000), logs().statusText);
		assert.strictEqual(fewest, 500, 'the 500 rows read before the loss stayed through the retry');
		assert.strictEqual(texts().length, 1500);
		assert.strictEqual(new Set(logs().rows().map((r) => r.id)).size, 1500, 'no row twice');
		assert.deepStrictEqual(texts().slice(0, 2), ['r0', 'r1'], 'in order');
		assert.strictEqual(logs().viewState.counts.total, 1500, 'none counted twice');
		const resumed = topic.ranges.at(-1)!;
		assert.strictEqual(resumed.fromTime, t0 - 50 * MINUTE + 499 * 1_000, 'from the newest record it had reached');
		assert.strictEqual(stateKind(), 'none');
	});

	test('NO_RECORDS: a range read to its end with none of the pipeline\'s records; with only hidden levels, Show every level; a search with no match stays "No records match"', async () => {
		topic.write(rec(CLICKS, 'other', 10 * MINUTE));
		await showOrders();
		assert.strictEqual(stateKind(), 'none', 'a live range is not read to an end');
		assert.strictEqual(await logs().chooseRange({ kind: 'hour' }), true);
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		assert.deepStrictEqual(logs().panelState, { kind: 'noRecords', pipeline: 'orders', range: 'the last hour', hiddenLevels: [] });
		assert.strictEqual(panelStateTexts(logs().panelState)!.title, 'No records for orders in the last hour');
		// Only DEBUG records, Debug hidden: Show every level is offered, and clears the level filter.
		topic.write(rec(ORDERS, 'debug one', 5 * MINUTE, { level: 'DEBUG' }));
		assert.strictEqual(logs().setFilter({ ...NO_FILTER, levels: LOG_LEVELS.filter((l) => l !== 'debug') }), true);
		assert.ok(await waitFor(() => logs().viewState.done && logs().viewState.counts.total === 1, 10_000), logs().statusText);
		assert.deepStrictEqual(logs().panelState, { kind: 'noRecords', pipeline: 'orders', range: 'the last hour', hiddenLevels: ['debug'] });
		assert.strictEqual(panelStateTexts(logs().panelState)!.body, 'It wrote only levels that are hidden (Debug).');
		assert.strictEqual(logs().setFilter({ ...logs().viewState.filter, levels: LOG_LEVELS }), true);
		assert.ok(await waitFor(() => logs().viewState.done && texts().length === 1, 10_000), logs().statusText);
		assert.strictEqual(stateKind(), 'none');
		// A search with no match is 6.4's "No records match", not this state.
		assert.strictEqual(logs().setFilter({ ...NO_FILTER, text: 'nothing like it' }), true);
		assert.ok(await waitFor(() => logs().viewState.done && logs().viewState.counts.total === 1, 10_000), logs().statusText);
		assert.strictEqual(stateKind(), 'none');
		// Last 24 hours.
		assert.strictEqual(await logs().chooseRange({ kind: 'day' }), true);
		assert.strictEqual(logs().viewState.range.kind, 'day');
	});

	test('READING: a bounded range shows the records so far, "<n> records so far" and Stop reading, which keeps what was read and ends the read', async () => {
		const t0 = Date.now();
		topic.write(...Array.from({ length: 3000 }, (_, i) => recAt(ORDERS, `w${i}`, t0 - 6 * DAY + i * MINUTE)));
		await showOrders();
		topic.rangeDelayMs = 150;
		await logs().chooseRange({ kind: 'week' });
		assert.ok(await waitFor(() => logs().panelState.kind === 'reading' && texts().length > 0, 10_000), stateKind());
		const reading = logs().panelState;
		assert.strictEqual(reading.kind === 'reading' && reading.what, 'Reading the last 7 days…');
		assert.ok(reading.kind === 'reading' && reading.count > 0 && reading.count < 3000, 'the count so far');
		assert.strictEqual(logs().stopReading(), true);
		const kept = texts().length;
		assert.ok(kept > 0 && kept < 3000, `${kept} records kept`);
		assert.strictEqual(stateKind(), 'none', 'the state goes; not "No records"');
		assert.strictEqual(logs().viewState.live, false);
		assert.strictEqual(logs().statusText, stoppedReadingStatus('the last 7 days', logs().viewState.counts.total));
		assert.ok(await waitFor(() => topic.activeRanges().length === 0, 10_000), 'the read ended');
		await new Promise((r) => setTimeout(r, 400));
		assert.strictEqual(texts().length, kept, 'nothing more read');
		assert.strictEqual(logs().stopReading(), false, 'nothing reads now');
	});

	test('CONNECTION_LOST (acceptance): a live read whose connection drops twice: "Trying again in 5 s", then 10 s, then Live goes on from where it stopped with no duplicate rows', async () => {
		logs().retryDelaysMs = [300, 600, 900, 1200, 1500];
		topic.write(rec(ORDERS, 'one', MINUTE));
		await showOrders();
		const watch = watchCountdowns();
		const countdowns = () => watch.values();
		teardowns.push(watch.dispose);
		topic.dropConnections(1);
		assert.ok(await waitFor(() => stateKind() === 'connectionLost', 10_000), logs().statusText);
		const lost = logs().panelState;
		assert.strictEqual(lost.kind === 'connectionLost' && lost.cluster, 'rpc-vilnius');
		assert.strictEqual(panelStateTexts(lost)!.title, 'Lost the connection to rpc-vilnius');
		assert.strictEqual(retryBody(lost), 'Live is paused; the records already shown stay. Trying again in 5 s.');
		assert.deepStrictEqual(texts(), ['one'], 'the records already shown stay');
		assert.ok(await waitFor(() => topic.connectionsRefused === 1 && countdowns().length >= 2, 10_000), `${countdowns()}`);
		assert.ok(await waitFor(() => stateKind() === 'none' && logs().statusText === FOLLOWING_STATUS, 10_000), logs().statusText);
		assert.deepStrictEqual(countdowns(), [5, 10]);
		const resumed = topic.activeTails()[0].resumeAt;
		assert.deepStrictEqual(resumed && [...resumed], [[0, 1]], 'from where it stopped');
		topic.write(rec(ORDERS, 'two'));
		assert.ok(await waitFor(() => texts().length === 2, 10_000));
		assert.deepStrictEqual(texts(), ['one', 'two'], 'no duplicate rows');
		assert.strictEqual(new Set(logs().rows().map((r) => r.id)).size, 2);
	});

	test('CONNECTION_LOST backoff: 5, 10, 20, 30, 60, then every 60 s; none while the tab is hidden; Retry now tries at once', async () => {
		logs().retryDelaysMs = [150, 150, 150, 150, 150];
		await showOrders();
		const watch = watchCountdowns();
		const countdowns = () => watch.values();
		teardowns.push(watch.dispose);
		topic.dropConnections(100);
		assert.ok(await waitFor(() => topic.connectionsRefused >= 6, 20_000), `${topic.connectionsRefused}`);
		const seen = countdowns();
		assert.ok(seen.length >= 6, `${seen}`);
		assert.deepStrictEqual(seen.slice(0, 7), [5, 10, 20, 30, 60, 60, 60].slice(0, Math.min(7, seen.length)));
		assert.deepStrictEqual(RETRY_DELAYS_MS, [5_000, 10_000, 20_000, 30_000, 60_000]);
		// Hidden: no tries until it is shown again.
		await vscode.commands.executeCommand('workbench.action.closePanel');
		assert.ok(await waitFor(() => !logs().visible && !logs().reading, 10_000));
		const hiddenAt = topic.connectionsRefused;
		await new Promise((r) => setTimeout(r, 800));
		assert.strictEqual(topic.connectionsRefused, hiddenAt, 'no tries while hidden');
		assert.strictEqual(stateKind(), 'connectionLost');
		// Shown again: the waits go on; Retry now with a long wait tries at once.
		logs().retryDelaysMs = [60_000];
		await vscode.commands.executeCommand(`${LOGS_VIEW_ID}.focus`);
		assert.ok(await waitFor(() => logs().visible && logs().panelState.kind === 'connectionLost' && (logs().panelState as { retryAt: number | null }).retryAt !== null, 10_000), 'counting down again');
		const again = logs().panelState;
		assert.ok(again.kind === 'connectionLost' && again.retryAt !== null);
		assert.strictEqual(again.retryInS, 60, 'the current step');
		const left = Math.ceil((again.retryAt - Date.now()) / 1_000);
		assert.ok(left >= 59 && left <= 60, `the wait starts again at the current step: ${left} s left`);
		assert.strictEqual(retryBody(again), 'Live is paused; the records already shown stay. Trying again in 60 s.');
		assert.strictEqual(topic.connectionsRefused, hiddenAt);
		topic.connectionFailures = 0;
		assert.strictEqual(logs().retry(), true);
		assert.ok(await waitFor(() => stateKind() === 'none' && logs().statusText === FOLLOWING_STATUS, 10_000), logs().statusText);
	});

	// --- ticket 6.7: the records-per-time strip ---

	const strip = () => {
		const s = logs().viewState.strip;
		assert.ok(s, 'a strip');
		return s;
	};
	const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);
	/** The strip's slot of each of `timestamps`, as its bars count them (clamped to the strip). */
	const slotted = (s: { start: number; size: number; total: readonly number[] }, timestamps: readonly number[]) => {
		const out = s.total.map(() => 0);
		for (const t of timestamps) {
			out[Math.min(out.length - 1, Math.max(0, slotOf(t, s.start, s.size)))]++;
		}
		return out;
	};
	/** The timestamps of ORDERS' records in the topic. */
	const ordersTimes = () => topic.partitions[0].filter((r) => r.key === ORDERS).map((r) => r.timestamp);

	test('STRIP_7_DAYS (acceptance, MARKS, OVER_CAP): 20,000 records over 7 days, 30 ERROR in one afternoon: Last 7 days has 42 bars per 4 hours summing to 20,000, the afternoon\'s bars marked; a bar\'s click shows its slot\'s records', async () => {
		const t0 = Date.now();
		const errors = new Set(Array.from({ length: 30 }, (_, k) => 12_000 + k * 10));
		topic.write(...Array.from({ length: 20_000 }, (_, i) => {
			const r = recAt(ORDERS, `r${i}`, t0 - 7 * DAY + MINUTE + i * 29_000);
			return errors.has(i) ? { ...r, value: { ...r.value, level: 'ERROR' } } : r;
		}), recAt(CLICKS, 'another pipeline', t0 - DAY));
		await showOrders();
		assert.strictEqual(logs().viewState.strip, null, 'LIVE_HIDDEN: none on the default range');
		assert.strictEqual(await logs().chooseRange({ kind: 'week' }), true);
		assert.ok(await waitFor(() => logs().viewState.done, 30_000), logs().statusText);
		const s = strip();
		assert.strictEqual(s.size, 4 * HOUR, 'per 4 hours');
		assert.strictEqual(s.total.length, 42);
		assert.strictEqual(sum(s.total), 20_000, 'every record of the pipeline, not only the 5,000 kept');
		assert.strictEqual(logs().rows().length, MAX_LOG_ROWS);
		assert.deepStrictEqual(s.total, slotted(s, ordersTimes()), 'each bar the pipeline\'s records of its slot');
		assert.strictEqual(sum(s.errors), 30);
		const errorTimes = topic.partitions[0].filter((r) => r.key === ORDERS && errors.has(Number(/r(\d+)$/.exec(JSON.parse(r.value as string).message as string)![1]))).map((r) => r.timestamp);
		assert.deepStrictEqual(s.errors, slotted(s, errorTimes), 'the afternoon\'s bars carry the error marks');
		const marked = s.errors.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0);
		assert.ok(marked.length >= 1 && marked.length <= 2, `the error marks in one afternoon: bars ${marked.join(', ')}`);
		assert.strictEqual(sum(s.warns), 0);
		assert.deepStrictEqual(s.matched, s.total, 'no filter: every record matches');
		// The click: that slot read as a custom range, re-slotted (4 hours: 48 per 5 minutes).
		const i = marked[0];
		const bounds = slotBounds(s, s.total.length, i);
		assert.strictEqual(await logs().chooseSlot(bounds.from, bounds.to), true);
		assert.ok(await waitFor(() => logs().viewState.done, 30_000), logs().statusText);
		assert.deepStrictEqual(logs().viewState.range, { kind: 'custom', from: bounds.from, to: bounds.to });
		const inSlot = topic.partitions[0].filter((r) => r.key === ORDERS && r.timestamp >= bounds.from && r.timestamp <= bounds.to);
		assert.strictEqual(logs().rows().length, s.total[i], 'that slot\'s records');
		assert.deepStrictEqual(logs().rows().map((r) => r.id), inSlot.map((r) => `0:${r.offset}`));
		assert.ok(logs().rows().some((r) => r.level === 'ERROR'));
		const again = strip();
		assert.deepStrictEqual([again.size, again.total.length, sum(again.total), sum(again.errors)], [5 * MINUTE, 48, s.total[i], s.errors[i]]);
		assert.strictEqual(await logs().chooseSlot(again.from - 1, again.from + MINUTE), false, 'before the strip');
		assert.strictEqual(await logs().chooseSlot(again.end - MINUTE, again.end + 1), false, 'past the strip');
		assert.strictEqual(await logs().chooseSlot(again.from + MINUTE, again.from + MINUTE), false, 'from not before to');
	});

	test('SLOTS, SHORT_LONG and EMPTY_SLOTS: Last 24 hours 48 bars per 30 minutes, Last hour 60 per minute, Last 7 days 42 per 4 hours; heights the pipeline\'s records per slot; quiet hours still slots', async () => {
		// Two records in one minute (the strip's slots start on a minute): one bar of the last hour.
		const minute = Math.floor((Date.now() - 50 * MINUTE) / MINUTE) * MINUTE;
		const agos = [5 * DAY, 30 * HOUR, 20 * HOUR, 19 * HOUR + 50 * MINUTE, 3 * HOUR, 10 * MINUTE, 2 * MINUTE];
		topic.write(...agos.map((ago) => rec(ORDERS, `${ago}`, ago)), recAt(ORDERS, 'pair 1', minute + 10_000), recAt(ORDERS, 'pair 2', minute + 20_000),
			rec(CLICKS, 'another pipeline', 2 * MINUTE));
		await showOrders();
		const read = async (kind: 'hour' | 'day' | 'week', size: number, count: number, records: number) => {
			assert.strictEqual(await logs().chooseRange({ kind }), true);
			assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
			const s = strip();
			assert.deepStrictEqual([s.size, s.total.length, sum(s.total)], [size, count, records], kind);
			const range = logs().viewState.range;
			assert.deepStrictEqual(s.total, slotted(s, ordersTimes().filter((t) => t >= range.from && t <= range.to!)), `${kind}: the records per slot`);
			assert.ok(s.start <= range.from && s.start > range.from - MINUTE, 'from the range\'s start (on its minute)');
			assert.strictEqual(s.end, range.to);
			return s;
		};
		const day = await read('day', 30 * MINUTE, 48, 7);
		assert.strictEqual(sum(day.total), 7, 'the records of the last 24 hours, not the older ones nor another pipeline\'s');
		assert.ok(day.total.filter((n) => n === 0).length >= 40, 'EMPTY_SLOTS: the quiet hours are slots with no records');
		const hour = await read('hour', MINUTE, 60, 4);
		assert.strictEqual(hour.total.filter((n) => n > 0).length, 3, 'two records in one minute share a bar');
		await read('week', 4 * HOUR, 42, 9);
		const posted = logs().posted.filter((m) => m.type === 'state' || m.type === 'show').at(-1);
		assert.ok(posted && (posted.type === 'state' || posted.type === 'show') && posted.state.strip?.total.length === 42, 'the webview gets the strip');
	});

	test('FILTERED: with a search on, every bar keeps its full height; the matching part per bar; CLICK: a bar\'s click keeps the search', async () => {
		// A custom range from a whole half hour, 6 hours long: 36 slots of 10 minutes from its start.
		const a = Math.floor(Date.now() / (30 * MINUTE)) * 30 * MINUTE - 6 * HOUR;
		topic.write(
			recAt(ORDERS, 'secret one', a + 11 * MINUTE), recAt(ORDERS, 'plain', a + 12 * MINUTE), recAt(ORDERS, 'plain', a + 3 * HOUR + MINUTE),
			recAt(ORDERS, 'secret two', a + 3 * HOUR + 2 * MINUTE), recAt(ORDERS, 'secret three', a + 3 * HOUR + 3 * MINUTE), recAt(ORDERS, 'plain', a + 5 * HOUR),
		);
		await showOrders();
		assert.strictEqual(await logs().chooseRange({ kind: 'custom', from: a, to: a + 6 * HOUR }), true);
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		const unfiltered = strip();
		assert.deepStrictEqual([unfiltered.start, unfiltered.size, unfiltered.total.length, sum(unfiltered.total)], [a, 10 * MINUTE, 36, 6]);
		assert.strictEqual(logs().setFilter({ ...NO_FILTER, text: 'secret' }), true);
		assert.ok(await waitFor(() => logs().viewState.done && texts().length === 3, 10_000), logs().statusText);
		const filtered = strip();
		assert.deepStrictEqual(filtered.total, unfiltered.total, 'every bar\'s full height unchanged');
		assert.strictEqual(sum(filtered.matched), 3);
		assert.ok(filtered.matched.every((m, i) => m <= filtered.total[i]));
		const secretTimes = topic.partitions[0].filter((r) => (JSON.parse(r.value as string) as { message: string }).message.includes('secret')).map((r) => r.timestamp);
		assert.deepStrictEqual(filtered.matched, slotted(filtered, secretTimes));
		// CLICK with the search on: the slot read, the search kept, only its matches shown.
		const i = filtered.matched.findIndex((m) => m === 2);
		assert.deepStrictEqual([i, filtered.total[i]], [18, 3], 'the slot with two matches of its three records');
		const bounds = slotBounds(filtered, filtered.total.length, i);
		assert.strictEqual(await logs().chooseSlot(bounds.from, bounds.to), true);
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		assert.strictEqual(logs().viewState.range.kind, 'custom');
		assert.deepStrictEqual(logs().viewState.filter, { ...NO_FILTER, text: 'secret' }, 'filters kept');
		assert.deepStrictEqual(texts(), ['secret two', 'secret three']);
		assert.deepStrictEqual([sum(strip().total), sum(strip().matched)], [filtered.total[i], 2], 'the slot\'s strip');
		assert.deepStrictEqual([strip().size, strip().total.length], [MINUTE, 10], '10 minutes: per minute');
	});

	test('LOAD_OLDER: Load older on a bounded range extends the strip to the older window, re-slotted when the span grows', async () => {
		topic.write(rec(ORDERS, 'older 1', 100 * MINUTE), rec(ORDERS, 'older 2', 70 * MINUTE), rec(ORDERS, 'recent', 20 * MINUTE));
		await showOrders();
		assert.strictEqual(await logs().chooseRange({ kind: 'hour' }), true);
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		assert.deepStrictEqual([strip().size, strip().total.length, sum(strip().total)], [MINUTE, 60, 1]);
		const end = strip().end;
		await logs().loadOlder();
		assert.deepStrictEqual(texts(), ['older 2', 'recent'], 'the hour before the oldest shown');
		const s = strip();
		const windowFrom = topic.ranges.at(-1)!.fromTime;
		assert.ok(s.start <= windowFrom && s.start > windowFrom - MINUTE, 'from the older window\'s start');
		assert.strictEqual(s.end, end, 'to the range\'s end');
		assert.strictEqual(s.size, 5 * MINUTE, 'over an hour: re-slotted per 5 minutes');
		assert.strictEqual(sum(s.total), 2);
		assert.deepStrictEqual(s.total, slotted(s, ordersTimes().filter((t) => t >= windowFrom)));
		await logs().loadOlder();
		assert.deepStrictEqual(texts(), ['older 1', 'older 2', 'recent']);
		assert.strictEqual(sum(strip().total), 3, 'and further back');
		assert.ok(strip().start < s.start);
	});

	test('LIVE_HIDDEN: no strip for Live or the last 15 minutes then live; Since the last deploy and a custom range have one', async () => {
		const deployed = Date.now() - 2 * HOUR;
		fake.cluster(VILNIUS).pipelines.find((p) => p.id === ORDERS)!.update_time = new Date(deployed).toISOString().replace('Z', '123456Z');
		topic.write(rec(ORDERS, 'after the deploy', HOUR), rec(ORDERS, 'recent', MINUTE));
		await showOrders();
		assert.strictEqual(logs().viewState.strip, null, 'the default');
		assert.strictEqual(await logs().chooseRange({ kind: 'live' }), true);
		assert.ok(await waitFor(() => logs().statusText === FOLLOWING_STATUS, 10_000), logs().statusText);
		assert.strictEqual(logs().viewState.strip, null, 'Live');
		const last = logs().posted.filter((m) => m.type === 'state' || m.type === 'show').at(-1);
		assert.ok(last && (last.type === 'state' || last.type === 'show') && last.state.strip === null, 'the webview gets none');
		assert.strictEqual(await logs().chooseRange({ kind: 'deploy' }), true);
		assert.ok(await waitFor(() => texts().length === 2 && logs().statusText === FOLLOWING_STATUS, 10_000), logs().statusText);
		assert.deepStrictEqual([strip().size, sum(strip().total)], [5 * MINUTE, 2], 'Since the last deploy: from its time to now');
		topic.write(rec(ORDERS, 'live'));
		assert.ok(await waitFor(() => (logs().viewState.strip ? sum(logs().viewState.strip!.total) : 0) === 3, 10_000), 'a live record counted in the strip');
		const now = Date.now();
		assert.strictEqual(await logs().chooseRange({ kind: 'custom', from: now - 3 * HOUR, to: now }), true);
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		assert.deepStrictEqual([strip().size, strip().total.length, sum(strip().total)], [5 * MINUTE, 36, 3]);
		assert.strictEqual(await logs().chooseRange({ kind: 'recent' }), true);
		assert.strictEqual(logs().viewState.strip, null);
		assert.strictEqual(await logs().chooseSlot(now - HOUR, now), false, 'no strip, no slot');
	});

	test('STRIP_STATES: no strip under Sign-in refused, Not allowed, or a connection lost before any record was read; kept under a connection lost once records were read', async () => {
		logs().retryDelaysMs = [200];
		const t0 = Date.now();
		topic.write(...Array.from({ length: 1500 }, (_, i) => recAt(ORDERS, `r${i}`, t0 - 50 * MINUTE + i * 1_000)));
		await showOrders();
		topic.password = 'rotated-logs-password-6-7-Zt2';
		assert.strictEqual(await logs().chooseRange({ kind: 'day' }), true);
		assert.ok(await waitFor(() => stateKind() === 'signIn', 10_000), logs().statusText);
		assert.strictEqual(logs().viewState.strip, null, 'Sign-in refused');
		topic.password = PASSWORD;
		topic.refuseRead = true;
		assert.strictEqual(await logs().chooseRange({ kind: 'hour' }), true);
		assert.ok(await waitFor(() => stateKind() === 'notAllowed', 10_000), logs().statusText);
		assert.strictEqual(logs().viewState.strip, null, 'Not allowed');
		topic.refuseRead = false;
		topic.connectionFailures = 1_000;
		assert.strictEqual(await logs().chooseRange({ kind: 'hour' }), true);
		assert.ok(await waitFor(() => stateKind() === 'connectionLost', 10_000), logs().statusText);
		assert.strictEqual(logs().viewState.strip, null, 'Connection lost before anything was read');
		topic.connectionFailures = 0;
		assert.ok(await waitFor(() => logs().viewState.done && stateKind() === 'none', 10_000), logs().statusText);
		assert.strictEqual(sum(strip().total), 1500);
		// Lost mid-way: the strip of what was read stays.
		topic.rangeDelayMs = 50;
		topic.dropRangeAfter = 1;
		let lostStrip: number | null | undefined;
		const sub = logs().onDidChange(() => {
			if (stateKind() === 'connectionLost' && lostStrip === undefined) {
				const s = logs().viewState.strip;
				lostStrip = s ? sum(s.total) : null;
			}
		});
		teardowns.push(() => sub.dispose());
		assert.strictEqual(await logs().chooseRange({ kind: 'hour' }), true);
		assert.ok(await waitFor(() => lostStrip !== undefined, 10_000), logs().statusText);
		assert.strictEqual(lostStrip, 500, 'the 500 records read before the loss');
		assert.ok(await waitFor(() => logs().viewState.done, 20_000), logs().statusText);
		assert.strictEqual(sum(strip().total), 1500);
	});

	test('LOAD_OLDER stopped or failed: the strip extends only over what was read', async () => {
		const t0 = Date.now();
		topic.write(...Array.from({ length: 1200 }, (_, i) => recAt(ORDERS, `old${i}`, t0 - 75 * MINUTE + i * 100)), rec(ORDERS, 'recent', 20 * MINUTE));
		await showOrders();
		assert.strictEqual(await logs().chooseRange({ kind: 'hour' }), true);
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		const before = strip();
		// Failed: nothing read, the strip as it was.
		topic.dropRangeAfter = 0;
		await logs().loadOlder();
		assert.ok(logs().viewState.olderError, 'the failure is shown');
		assert.deepStrictEqual(strip(), before, 'not extended over the window that failed');
		// Stopped after the first batch: extended back only to the oldest record read.
		topic.rangeDelayMs = 300;
		const loading = logs().loadOlder();
		assert.ok(await waitFor(() => { const p = logs().panelState; return p.kind === 'reading' && p.count > 0; }, 10_000), stateKind());
		assert.strictEqual(logs().stopReading(), true);
		await loading;
		const window = topic.ranges.at(-1)!;
		const read = window.delivered.filter((r) => r.key === ORDERS).map((r) => r.timestamp);
		assert.ok(read.length > 0 && read.length < 1200, `${read.length} read`);
		const s = strip();
		assert.strictEqual(s.from, Math.min(...read), 'from the oldest record read');
		assert.ok(s.from > window.fromTime, 'not from the window\'s start');
		assert.strictEqual(sum(s.total), logs().viewState.counts.total);
		assert.strictEqual(sum(s.total), 1 + read.length);
	});

	test('OVER_CAP (6.7): a range past the cap: the strip counts every record, not only those kept', async () => {
		topic.write(...Array.from({ length: 8 }, (_, i) => rec(ORDERS, `r${i}`, (8 - i) * MINUTE + 30 * MINUTE)));
		await showOrders();
		logs().cap = 5;
		assert.strictEqual(await logs().chooseRange({ kind: 'hour' }), true);
		assert.ok(await waitFor(() => logs().viewState.done, 10_000), logs().statusText);
		assert.strictEqual(texts().length, 5);
		assert.strictEqual(sum(strip().total), 8);
	});

	test('BUNDLE: the reader\'s client loads from dist/extension.js with its CRC-32C from the wasm, not the native @node-rs/crc32', async function () {
		const [major, minor] = process.versions.node.split('.').map(Number);
		if (major < 22 || (major === 22 && minor < 22)) {
			// @platformatic/kafka needs Node 22.22 or later (its `engines`); older VS Code runs an older Node.
			this.skip();
		}
		const check = await logs().checkClient();
		assert.deepStrictEqual(check, { native: false, crc32c: 0xe3069283 });
		assert.ok(!Object.keys(require.cache).some((k) => k.includes('@node-rs')), 'no native module loaded');
	});

	test('NO_LEAK: no password in a message, a prompt, the output channel, a view item, a setting, the panel, a file or another secret storage key', async () => {
		await setUpAccess();
		// Every key the extension writes to the secret storage: only the log access record holds the password.
		const keys = [CLIENT_ID_KEY, CLIENT_SECRET_KEY, logAccessKey(VILNIUS), logAccessKey(BYOC), ...(api().secrets?.recordedKeys() ?? [])];
		for (const key of keys) {
			const value = await cloud().storedValue(key) ?? '';
			assert.strictEqual(value.includes(PASSWORD), key === logAccessKey(VILNIUS), `${key}: holds the password only in the log access record`);
			assert.ok(!value.includes(WRONG_PASSWORD), key);
		}
		assert.deepStrictEqual(JSON.parse((await cloud().storedValue(logAccessKey(VILNIUS)))!), { username: USERNAME, password: PASSWORD, mechanism: 'SCRAM-SHA-256' });
		// Every file under the suite's directory and the workspace's .vscode.
		const files = [dir, ...(vscode.workspace.workspaceFolders ?? []).map((f) => path.join(f.uri.fsPath, '.vscode'))].flatMap(filesUnder);
		for (const file of files) {
			const text = fs.readFileSync(file, 'utf8');
			assert.ok(!text.includes(PASSWORD) && !text.includes(WRONG_PASSWORD), `${file} holds a password`);
		}
		// Ticket 6.4: a license_org with `"` and `\` in it, and the password in a nested value: not in the JSON either, escaped or not.
		const quotedOrg = 'org "quoted" \\ back';
		topic.write(rec(ORDERS, `a message quoting ${PASSWORD}`, MINUTE, { license_org: quotedOrg, nested: { said: [PASSWORD, `for ${quotedOrg}`] } }));
		await showLogs();
		assert.ok(await waitFor(() => messages(ORDERS).length === 1, 10_000));
		assert.ok(!logs().rows()[0].message.includes(PASSWORD), 'masked in the panel too');
		const json = logs().rows()[0].json!;
		for (const value of [PASSWORD, quotedOrg]) {
			assert.ok(!json.includes(value) && !json.includes(JSON.stringify(value).slice(1, -1)), `${value} in the record's JSON`);
			assert.ok(!JSON.stringify(logs().posted).includes(JSON.stringify(JSON.stringify(value).slice(1, -1)).slice(1, -1)), `${value} posted`);
		}
		items();
		const shown = JSON.stringify({
			shown: allShown, output: api().outputLines(), items: seenItems, settings: vscode.workspace.getConfiguration('redpandaConnect'),
			posted: logs().posted, rows: logs().rows(), status: logs().statusText,
		});
		for (const value of [PASSWORD, WRONG_PASSWORD, CLIENT_SECRET]) {
			assert.ok(!shown.includes(value), 'a password in a message, the output, the view, a setting or the panel');
		}
		// The output channel says what happened, so the check above reads real lines.
		assert.ok(api().outputLines().some((l) => l.includes('log access to rpc-vilnius set up for logs-reader')));
		assert.ok(LOG_ACCESS_PREFIX.startsWith('redpandaConnect.cloud.'));
	});
});

// Ticket 6.2 (the user's decision of 2026-11-05): on a VS Code whose Node is older than 22.22 (the
// floor run, VS Code 1.100.0), Set up log access and Show logs say that Pipeline logs need a newer
// VS Code and send nothing. Skipped where the Node is new enough (the stable run has the suite above).
suite('Pipeline logs on an older VS Code (integration, ticket 6.2)', function () {
	this.timeout(60_000);
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const cloud = () => api().cloud!;
	let fake: FakeCloud;
	let topic: FakeLogs;
	let originalUi: CloudUi;
	let originalReader: ReturnType<typeof cloud>['logReader'];
	const errors: string[] = [];
	let inputs: Input[] = [];
	let asked = 0;

	suiteSetup(async function () {
		if (nodeSupported()) {
			this.skip();
		}
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
		fake = new FakeCloud({
			clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, clientName: 'logs-bot',
			clusters: [{
				id: VILNIUS, name: 'rpc-vilnius', type: 'TYPE_DEDICATED', cloudProvider: 'CLOUD_PROVIDER_AWS', region: 'us-east-2', connectVersion: '4.115.0', seedBrokers: SEEDS,
				pipelines: [{ id: ORDERS, display_name: 'orders', description: '', config_yaml: 'input:\n  generate:\n    mapping: root = 1\noutput:\n  drop: {}\n', resources: { cpu_shares: '100m', memory_shares: '400M' }, tags: {}, state: 'STATE_RUNNING', sequence: [] }],
			}],
		});
		await fake.start();
		topic = new FakeLogs({ username: USERNAME, password: PASSWORD });
		originalUi = cloud().ui;
		originalReader = cloud().logReader;
		cloud().endpoints = { authUrl: fake.url, controlPlaneUrl: fake.url, requireHttps: false };
		cloud().logReader = topic.factory;
		cloud().ui = {
			...originalUi,
			input: async () => {
				asked++;
				return inputs.shift();
			},
			pickChoice: async () => {
				asked++;
				return 'SCRAM-SHA-256';
			},
			error: async (m) => {
				errors.push(m);
				return undefined;
			},
			info: async () => undefined,
			progress: async (_title, task) => task(() => undefined),
		};
		inputs = [CLIENT_ID, CLIENT_SECRET];
		assert.strictEqual(await vscode.commands.executeCommand(CONNECT_COMMAND), true);
		await cloud().refresh({ kind: 'cluster', id: VILNIUS });
		asked = 0;
		errors.length = 0;
	});

	suiteTeardown(async () => {
		if (!fake) {
			return;
		}
		await cloud().disconnect();
		cloud().ui = originalUi;
		cloud().logReader = originalReader;
		await fake.stop();
	});

	test('NEEDS_NEWER: Set up log access and Show logs say Pipeline logs need a newer VS Code, ask nothing and send nothing', async () => {
		const message = `${newerVsCodeMessage(process.versions.node)}.`;
		assert.match(message, /^Pipeline logs need a newer VS Code \(Node 22\.22 or later; this one has \d+\.\d+\.\d+\)\.$/);
		inputs = [USERNAME, PASSWORD];
		assert.deepStrictEqual(await vscode.commands.executeCommand(SET_UP_LOG_ACCESS_COMMAND, { kind: 'cluster', id: VILNIUS }), { kind: 'notSupported', message });
		assert.deepStrictEqual(await vscode.commands.executeCommand(SHOW_LOGS_COMMAND, { kind: 'pipeline', clusterId: VILNIUS, id: ORDERS }), { kind: 'notSupported', message });
		assert.deepStrictEqual(errors, [message, message]);
		assert.strictEqual(asked, 0, 'nothing asked');
		assert.strictEqual(topic.targets.length, 0, 'no reader made, nothing sent');
		assert.strictEqual(await cloud().storedLogAccess(VILNIUS), undefined);
		assert.strictEqual(api().logs?.title, undefined, 'the tab shows no pipeline');
	});
});
