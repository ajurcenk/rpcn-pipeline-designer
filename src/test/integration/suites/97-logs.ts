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
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	CLIENT_ID_KEY, CLIENT_SECRET_KEY, CONNECT_COMMAND, logAccessKey, type CloudItem, type CloudUi, LOG_ACCESS_PREFIX, noLogAccessMessage, SET_UP_LOG_ACCESS_ACTION, SET_UP_LOG_ACCESS_COMMAND,
	SHOW_LOGS_COMMAND, signInRefusedMessage,
} from '../../../adapters/vscode/cloudView';
import { AROUND_MS, FOLLOWING_STATUS, noMatchesBackText, LIVE_OFF_STATUS, livePausedStatus, LOGS_VIEW_ID, LOGS_WINDOW_MS, STOPPED_PREFIX } from '../../../adapters/vscode/logsPanel';
import { gapsIn, MAX_LOG_ROWS, NO_FILTER, type LogFilter } from '../../../shared/logsProtocol';
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
	/** The suite's own temporary directory (NO_LEAK reads every file in it). */
	let dir: string;
	let inputs: Input[] = [];
	let asked: vscode.InputBoxOptions[] = [];
	let choices: (string | undefined)[] = [];
	let questions: { title: string; question: string; choices: string[] }[] = [];
	let actions: (string | undefined)[] = [];
	const errors: string[] = [];
	const infos: string[] = [];
	/** The actions each info offered. */
	const infoActions: string[][] = [];
	/** Every message, prompt and item of the suite, for NO_LEAK. */
	const allShown: string[] = [];
	const seenItems: CloudItem[] = [];

	function script(next: { inputs?: Input[]; choices?: (string | undefined)[]; actions?: (string | undefined)[] }): void {
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
			error: async (m) => {
				errors.push(m);
				allShown.push(m);
				return actions.shift();
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
		errors.length = 0;
		infos.length = 0;
		infoActions.length = 0;
		script({});
		await connectAndRead();
		errors.length = 0;
		infos.length = 0;
		infoActions.length = 0;
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
		await fake?.stop();
		if (dir) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('package.json: the Pipeline Logs tab in the bottom panel; Set up log access… on a cluster row, Show logs on a pipeline row (inline with access, always in the menu), rows only', () => {
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
		assert.deepStrictEqual([SET_UP_LOG_ACCESS_COMMAND, SHOW_LOGS_COMMAND].map((c) => pkg.contributes.commands.find((x) => x.command === c)?.title), ['Set up log access…', 'Show logs']);
		for (const c of [SET_UP_LOG_ACCESS_COMMAND, SHOW_LOGS_COMMAND]) {
			assert.strictEqual(pkg.contributes.menus.commandPalette.find((m) => m.command === c)?.when, 'false', `${c}: rows only`);
		}
		const offered = (contextValue: string, inline: boolean) => pkg.contributes.menus['view/item/context']
			.filter((m) => (m.group?.startsWith('inline') ?? false) === inline)
			.filter((m) => { const r = /viewItem =~ \/(.+)\/$/.exec(m.when ?? ''); return r && new RegExp(r[1]).test(contextValue); })
			.map((m) => m.command).filter((c) => c === SET_UP_LOG_ACCESS_COMMAND || c === SHOW_LOGS_COMMAND || c === 'redpandaConnect.cloud.refresh');
		assert.deepStrictEqual(offered('cloudCluster', false), ['redpandaConnect.cloud.refresh', SET_UP_LOG_ACCESS_COMMAND]);
		assert.deepStrictEqual(offered('cloudCluster logs', false), ['redpandaConnect.cloud.refresh', SET_UP_LOG_ACCESS_COMMAND]);
		assert.deepStrictEqual(offered('cloudCluster logs', true), ['redpandaConnect.cloud.refresh'], 'Refresh stays inline with access');
		assert.deepStrictEqual(offered('cloudCluster noPipelineApi', false), []);
		assert.deepStrictEqual(offered('cloudPipeline state-running', true), [], 'no inline Show logs without access');
		assert.deepStrictEqual(offered('cloudPipeline state-running hasFile logs', true), [SHOW_LOGS_COMMAND]);
		assert.deepStrictEqual(offered('cloudPipeline state-running', false), [SHOW_LOGS_COMMAND], 'the menu always has it (NO_ACCESS)');
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

	test('NO_ACCESS: Show logs where the cluster has no access says to set it up first, with the action; nothing is read', async () => {
		script({ actions: [undefined] });
		assert.deepStrictEqual(await showLogs(), { kind: 'noAccess' });
		assert.deepStrictEqual(infos, [noLogAccessMessage('rpc-vilnius')]);
		assert.deepStrictEqual(infoActions, [[SET_UP_LOG_ACCESS_ACTION]]);
		assert.strictEqual(topic.targets.length, 0);
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
		// A read failure.
		topic.refuseRead = true;
		await logs().chooseRange({ kind: 'hour' });
		assert.ok(await waitFor(() => logs().statusText.startsWith(STOPPED_PREFIX), 10_000), logs().statusText);
		assert.match(logs().statusText, /not allowed to read __redpanda\.connect\.logs/);
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
		assert.ok(!logs().statusText.startsWith(STOPPED_PREFIX), logs().statusText);
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
