// Metrics of a Cloud pipeline in the tab and on the graph (ticket 7.5, AD-25), end to end in the stable
// run: the Cloud view against the Cloud fake (`helpers/fakeCloud.ts`), whose cluster serves two
// pipelines' series (A, mapped to a local file, and B, mapped to none) on its Prometheus endpoint behind
// basic auth. Show metrics runs through its command on a pipeline row; the tab and the graph are read
// through their test seams, and the Cloud feeds' timing is shortened through the feeds' seam (production
// is AD-25's 10 s, 5 s floor, 5–60 s backoff, checked in the unit tests). Every matrix row of the plan has
// a test (LIVE … NO_LEAK), and the two acceptance criteria (GRAPH, and the 98-metrics suite unchanged).
// Ticket 8 (board 5): the states' buttons through the tab's seam (`receive`, as the webview posts them):
// No access's Set up metrics access… opens the prompt (its buttons disabled while it runs) and, stored,
// the tab reads; Refused's Forget metrics access gives the no-access state; Retry now reads at once within
// the floor; no series is read again with Read again; a not-running file's `.cloud.json` pipeline is shown
// with its Show button (bound with `show`, the tab's direct bind).
// Ticket 9 (board 5): MAPPED_NO_RUN, Show Pipeline Metrics on a not-running file with its own `.cloud.json`
// opens the tab on that pipeline (not signed in: Show metrics' message); ROW_INLINE, the row's inline
// icon (package.json) is the menu's command; NO_EDITOR, the pick lists the Cloud view's loaded pipelines.
// Bug 58: a Show metrics that does not start (not signed in, a pipeline gone) leaves the tab on the file,
// Not running; with the cluster list never loaded (a stored account, no row expanded), Show metrics loads it.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_TAG } from '../../../adapters/cloud/dataPlane';
import {
	CLIENT_ID_KEY, CLIENT_SECRET_KEY, CONNECT_COMMAND, FORGET_METRICS_ACCESS_COMMAND, metricsAccessKey, noMetricsAccessMessage, SET_UP_METRICS_ACCESS_ACTION,
	NOT_CONNECTED_FOR_METRICS_MESSAGE,
	SET_UP_METRICS_ACCESS_COMMAND, SHOW_CLOUD_METRICS_COMMAND, type CloudItem, type CloudUi,
} from '../../../adapters/vscode/cloudView';
import { CLOUD_REFUSED_TEXT, DEFAULT_PROMETHEUS_USER } from '../../../adapters/metrics/source';
import { CLOUD_NO_SERIES_HINT, CLOUD_TIMING } from '../../../adapters/vscode/metricsFeed';
import { CLUSTER_GONE } from '../../../adapters/vscode/cloudShared';
import { METRICS_VIEW_ID, SHOW_METRICS_COMMAND } from '../../../adapters/vscode/metricsPanel';
import type { GraphPanelHandle } from '../../../adapters/graphPanel/panels';
import type { NodeFiguresById } from '../../../shared/protocol';
import { type ExtensionApi } from '../../../extension';
import { cloudMetricsBody, FakeCloud, type FakePipeline } from '../../helpers/fakeCloud';
import { connectScript, fixtureBodies, makeTempDir, writeFakeBinary } from '../../helpers/fakeBinary';
import { EXTENSION_ID, waitFor } from '../helpers';

const CLIENT_ID = 'fake-client-id-7-5';
const CLIENT_SECRET = 'fake-client-secret-7-5-Wd3';
const PASSWORD = 'prom-password-7-5-Kx9q';
const WRONG_PASSWORD = 'wrong-prom-password-7-5-Ju4';
const VILNIUS = 'cvilnius0000000000aa';
const A = 'd5orders000000000001';
const B = 'd5clicks000000000002';
const TIMING = { intervalMs: 500, minGapMs: 250, retryDelaysMs: [300, 600, 900] };

const CONFIG = [
	'input:',
	'  generate:',
	'    mapping: root = "tick"',
	'pipeline:',
	'  processors:',
	'    - label: fast',
	'      mapping: root = this',
	'output:',
	'  drop: {}',
	'',
].join('\n');

type Input = string | undefined;

suite('Metrics of a Cloud pipeline in the tab and on the graph (integration, ticket 7.5)', function () {
	this.timeout(90_000);
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const cloud = () => api().cloud!;
	const metrics = () => api().metrics!;
	const config = () => vscode.workspace.getConfiguration('redpandaConnect');
	const originalPath = process.env.PATH;
	let fake: FakeCloud;
	let originalUi: CloudUi;
	let originalFolders: () => readonly { name: string; path: string }[];
	let dir: string;
	let fileA: string;
	let inputs: Input[] = [];
	/** Ticket 8: while set, every prompt waits for it (a set-up flow held open). */
	let inputGate: Promise<void> | undefined;
	let infoAnswers: (string | undefined)[] = [];
	const errors: string[] = [];
	const infos: string[] = [];
	const allShown: string[] = [];
	const seenItems: CloudItem[] = [];
	/** When each Prometheus read arrived. */
	let promTimes: number[] = [];

	const pipelineNode = (id: string): CloudItem['node'] => ({ kind: 'pipeline', clusterId: VILNIUS, id });
	const showMetrics = (id: string) => vscode.commands.executeCommand<{ kind: string; pipelineId?: string; file?: string }>(SHOW_CLOUD_METRICS_COMMAND, pipelineNode(id));
	const promReads = () => fake.requestsTo('/prom/').length;
	const lastPosted = () => metrics().posted.at(-1)!;
	const figuresOf = (handle: GraphPanelHandle): NodeFiguresById[] => handle.posted.flatMap((m) => (m.type === 'nodeFigures' ? [m.byId] : []));
	const lastFigures = (handle: GraphPanelHandle) => figuresOf(handle).at(-1) ?? {};
	/**
	 * Bug 58: Disconnect, settled: the setup's Connect stored the account a moment ago, and its late change
	 * event can read it back before the delete has settled (see the teardown); disconnected again then.
	 */
	const disconnectSettled = async (): Promise<void> => {
		for (let i = 0; i < 3; i++) {
			await cloud().disconnect();
			await new Promise((r) => setTimeout(r, 1_000));
			if (!cloud().connected) {
				return;
			}
		}
		assert.fail('the service account stays connected after Disconnect');
	};
	/** Bug 58: a second config, so a tab left as it was would show another file. */
	const otherFile = (): vscode.Uri => {
		const file = path.join(dir, 'other.yaml');
		fs.writeFileSync(file, CONFIG);
		return vscode.Uri.file(file);
	};

	function pipeline(id: string, name: string, tags: Record<string, string>): FakePipeline {
		return {
			id, display_name: name, description: '', config_yaml: CONFIG,
			resources: { cpu_shares: '100m', memory_shares: '400M' }, tags, state: 'STATE_RUNNING', sequence: [],
		};
	}

	async function setUpAccess(): Promise<void> {
		inputs = [DEFAULT_PROMETHEUS_USER, PASSWORD];
		const result = await vscode.commands.executeCommand<{ kind: string }>(SET_UP_METRICS_ACCESS_COMMAND, { kind: 'cluster', id: VILNIUS });
		assert.strictEqual(result?.kind, 'stored', errors.join('\n'));
		// The test read is not one of the tab's.
		fake.requests.length = 0;
		promTimes = [];
	}

	async function closeTab(): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.closePanel');
		assert.ok(await waitFor(() => !metrics().visible, 10_000));
	}

	/** Ticket 8: the password is in no message the tab posted and no output line. */
	function assertNoPassword(): void {
		const text = JSON.stringify({ posted: metrics().posted, output: api().outputLines() });
		for (const value of [PASSWORD, WRONG_PASSWORD, Buffer.from(`prometheus:${PASSWORD}`).toString('base64')]) {
			assert.ok(!text.includes(value), 'a password in a posted message or an output line');
		}
	}

	/** Reads of the endpoint during `ms`. */
	async function readsDuring(ms: number): Promise<number> {
		const before = promReads();
		await new Promise((r) => setTimeout(r, ms));
		return promReads() - before;
	}

	suiteSetup(async () => {
		await vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.activate();
		// A fake binary for the schema the graph's model is built with (as 98-metrics).
		const fixtures = fixtureBodies('4.112.0');
		process.env.PATH = (originalPath ?? '').split(path.delimiter)
			.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
			.join(path.delimiter);
		dir = makeTempDir('rpcn-cloud-metrics-');
		const bin = writeFakeBinary(dir, 'redpanda-connect', connectScript({ version: '4.112.0', ...fixtures, run: 'while :; do sleep 0.05; done' }));
		await config().update('binaryPath', bin, vscode.ConfigurationTarget.Global);
		assert.ok(await waitFor(() => api().schemaStore.current?.path === bin, 30_000), 'the schema (for the model) is there');
		fileA = path.join(dir, 'orders.yaml');
		fs.writeFileSync(fileA, CONFIG);
		fake = new FakeCloud({
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
			clientName: 'metrics-bot',
			clusters: [
				{ id: VILNIUS, name: 'rpc-vilnius', type: 'TYPE_DEDICATED', cloudProvider: 'CLOUD_PROVIDER_AWS', region: 'us-east-2', connectVersion: '4.118.0', prometheus: true, prometheusPassword: PASSWORD, pipelines: [] },
			],
		});
		await fake.start();
		originalUi = cloud().ui;
		originalFolders = cloud().workspaceFolders;
		cloud().endpoints = { authUrl: fake.url, controlPlaneUrl: fake.url, requireHttps: false };
		cloud().workspaceFolders = () => [{ name: path.basename(dir), path: dir }];
		metrics().feeds.cloudTiming = TIMING;
		cloud().ui = {
			...originalUi,
			input: async (options) => {
				allShown.push(options.title ?? '', options.prompt ?? '', options.value ?? '');
				if (inputGate) {
					await inputGate;
				}
				return inputs.shift();
			},
			error: async (m) => {
				errors.push(m);
				allShown.push(m);
				return undefined;
			},
			info: async (m) => {
				infos.push(m);
				allShown.push(m);
				return infoAnswers.shift();
			},
			progress: async (title, task) => {
				allShown.push(title);
				return task(() => undefined);
			},
		};
	});

	setup(async () => {
		await cloud().disconnect();
		await cloud().removeMetricsAccess(VILNIUS);
		const c = fake.cluster(VILNIUS);
		c.pipelines = [pipeline(A, 'orders', { [CONFIG_TAG]: 'orders.yaml' }), pipeline(B, 'clicks', {})];
		c.prometheusPassword = PASSWORD;
		c.prometheusFailure = undefined;
		c.metricsBody = undefined;
		fake.clustersError = undefined;
		fake.delay = (req) => {
			if (req.url.startsWith('/prom/')) {
				promTimes.push(Date.now());
			}
			return 0;
		};
		promTimes = [];
		errors.length = 0;
		infos.length = 0;
		infoAnswers = [];
		inputGate = undefined;
		inputs = [CLIENT_ID, CLIENT_SECRET];
		assert.strictEqual(await vscode.commands.executeCommand(CONNECT_COMMAND), true, errors.join('\n'));
		await cloud().refresh({ kind: 'cluster', id: VILNIUS });
		errors.length = 0;
		infos.length = 0;
		fake.requests.length = 0;
	});

	teardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await vscode.commands.executeCommand('workbench.action.closePanel');
		seenItems.push(...cloud().items());
		// A test that disconnected (the NOT SIGNED IN ones) deleted the service account. A secret-storage
		// delete resolves before VS Code has settled it (see `removeStored`), and the next setup's
		// Connect, a few milliseconds later, could then be undone by it: the account, and with it the
		// metrics access just set up, vanish under the next test. Let the delete settle first.
		if (!cloud().connected) {
			await new Promise((r) => setTimeout(r, 1_000));
		}
	});

	suiteTeardown(async () => {
		metrics().feeds.cloudTiming = CLOUD_TIMING;
		if (fake) {
			await cloud().removeMetricsAccess(VILNIUS);
			await cloud().disconnect();
			cloud().ui = originalUi;
			cloud().workspaceFolders = originalFolders;
			await fake.stop();
		}
		process.env.PATH = originalPath;
		await config().update('binaryPath', undefined, vscode.ConfigurationTarget.Global);
		if (dir) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('package.json: Show metrics ($(pulse)) in the pipeline row\'s menu at 0_open@5 (around the error after it) and, ticket 9, inline at inline@4; no palette entry', () => {
		const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as {
			contributes: { commands: { command: string; title: string; icon?: string }[]; menus: Record<string, { command: string; when?: string; group?: string }[]> };
		};
		const command = pkg.contributes.commands.find((c) => c.command === SHOW_CLOUD_METRICS_COMMAND);
		assert.deepStrictEqual([command?.title, command?.icon], ['Show metrics', '$(pulse)']);
		assert.strictEqual(pkg.contributes.menus.commandPalette.find((m) => m.command === SHOW_CLOUD_METRICS_COMMAND)?.when, 'false');
		const entries = Object.entries(pkg.contributes.menus).flatMap(([menu, items]) => items.filter((m) => m.command === SHOW_CLOUD_METRICS_COMMAND).map((m) => ({ menu, ...m })));
		// ROW_INLINE (ticket 9): the inline icon is the same command, on every pipeline row, as the menu item.
		assert.deepStrictEqual(entries.filter((e) => e.menu !== 'commandPalette'), [
			{ menu: 'view/item/context', command: SHOW_CLOUD_METRICS_COMMAND, when: 'view == redpandaConnect.cloud && viewItem =~ /^cloudPipeline\\b/', group: 'inline@4' },
			{ menu: 'view/item/context', command: SHOW_CLOUD_METRICS_COMMAND, when: 'view == redpandaConnect.cloud && viewItem =~ /^cloudPipeline\\b/', group: '0_open@5' },
		]);
		const inline = pkg.contributes.menus['view/item/context'].filter((m) => m.group?.startsWith('inline@')).map((m) => m.group);
		assert.strictEqual(new Set(inline).size, inline.length, `one inline slot each: ${inline.join(', ')}`);
		const around = pkg.contributes.menus['view/item/context'].find((m) => m.command === 'redpandaConnect.cloud.showLogsAroundError');
		assert.strictEqual(around?.group, '0_open@6');
	});

	test('LIVE / GRAPH: Show metrics on A: the tab names "Cloud · <cluster> · A", its host, file and interval, only A\'s components in its file\'s config order; A\'s file\'s graph shows the same figures', async () => {
		await setUpAccess();
		const doc = await vscode.workspace.openTextDocument(fileA);
		await vscode.window.showTextDocument(doc);
		assert.ok(await waitFor(() => api().detection.isDetected(doc.uri), 5_000));
		await vscode.commands.executeCommand('redpandaConnect.showGraph', doc.uri);
		const handle = api().graphPanels.panelFor(doc.uri)!;
		assert.ok(handle, 'a graph panel');
		const result = await showMetrics(A);
		assert.deepStrictEqual(result, { kind: 'shown', pipelineId: A, file: fileA }, `${errors.join('\n')}\n${infos.join('\n')}\n${api().outputLines().slice(-25).join('\n')}`);
		assert.ok(await waitFor(() => metrics().visible && metrics().state.kind === 'live', 10_000), JSON.stringify(metrics().state));
		assert.strictEqual(metrics().title, 'Cloud · rpc-vilnius · orders');
		assert.strictEqual(metrics().file, doc.uri.toString());
		const host = new URL(fake.url).host;
		const shown = lastPosted();
		assert.deepStrictEqual([shown.source, shown.file, shown.port, shown.cloud, shown.intervalMs], ['Cloud · rpc-vilnius · orders', 'orders.yaml', null, { host }, TIMING.intervalMs]);
		assert.deepStrictEqual(metrics().rows().map((r) => r.id), ['path:input', 'label:fast', 'path:output'], 'config order');
		assert.strictEqual(metrics().rows()[1].p50, 4700, 'A\'s series (B\'s is 9400)');
		// The counters rise: rates.
		fake.cluster(VILNIUS).metricsBody = cloudMetricsBody([A, B], 200);
		assert.ok(await waitFor(() => (metrics().rows()[0]?.outRate ?? 0) > 0, 10_000), JSON.stringify(metrics().rows()));
		assert.ok(await waitFor(() => (lastFigures(handle)['label:fast'] as { p50?: number } | undefined)?.p50 === 4700, 10_000), JSON.stringify(lastFigures(handle)));
		assert.ok(await waitFor(() => (lastFigures(handle)['path:input']?.outRate ?? 0) > 0, 10_000), JSON.stringify(lastFigures(handle)));
		assert.deepStrictEqual(Object.keys(lastFigures(handle)).sort(), ['label:fast', 'path:input', 'path:output']);
		// Ticket 7.7: the same marks from the Cloud readings: `fast`, the only one spending time, is the slowest in both.
		assert.ok(await waitFor(() => metrics().rows()[1]?.slowest === true, 10_000), JSON.stringify(metrics().rows()));
		assert.deepStrictEqual(metrics().rows().map((r) => [r.id, r.share, r.slowest]), [['path:input', null, false], ['label:fast', 1, true], ['path:output', null, false]]);
		assert.ok(await waitFor(() => {
			const fast = lastFigures(handle)['label:fast'];
			return fast?.kind === 'component' && fast.slowest === true && fast.share === 1;
		}, 10_000), JSON.stringify(lastFigures(handle)));
		assert.strictEqual(lastPosted().summary?.slowest?.name, 'fast');
		// Each read carries the access as basic auth.
		const read = fake.requestsTo('/prom/').at(-1)!;
		assert.strictEqual(read.headers.authorization, `Basic ${Buffer.from(`prometheus:${PASSWORD}`).toString('base64')}`);
	});

	test('ACCEPTANCE (GRAPH): with A\'s graph open and the tab closed, the graph alone reads A\'s figures; the graph gone too, the reads stop', async () => {
		await setUpAccess();
		const doc = await vscode.workspace.openTextDocument(fileA);
		await vscode.window.showTextDocument(doc);
		await vscode.commands.executeCommand('redpandaConnect.showGraph', doc.uri);
		const handle = api().graphPanels.panelFor(doc.uri)!;
		assert.strictEqual((await showMetrics(A))?.kind, 'shown');
		await closeTab();
		fake.cluster(VILNIUS).metricsBody = cloudMetricsBody([A, B], 300);
		const before = figuresOf(handle).length;
		assert.ok(await waitFor(() => figuresOf(handle).length > before && (lastFigures(handle)['label:fast'] as { p50?: number } | undefined)?.p50 === 4700, 10_000),
			JSON.stringify(lastFigures(handle)));
		assert.ok(await readsDuring(TIMING.intervalMs * 2 + 200) >= 1, 'the graph alone reads');
		handle.panel.dispose();
		await new Promise((r) => setTimeout(r, 200));
		assert.strictEqual(await readsDuring(TIMING.intervalMs * 3), 0, 'nothing shows the figures: no read');
	});

	test('INTERVAL: while the tab is visible, read at the interval, one at a time (a slow read is waited for)', async () => {
		await setUpAccess();
		fake.delay = (req) => {
			if (req.url.startsWith('/prom/')) {
				promTimes.push(Date.now());
				return 400;
			}
			return 0;
		};
		assert.strictEqual((await showMetrics(B))?.kind, 'shown');
		assert.ok(await waitFor(() => promTimes.length >= 4, 15_000));
		const gaps = promTimes.slice(1).map((t, i) => t - promTimes[i]);
		// Each next read starts an interval after the last answer: never two at once.
		assert.ok(gaps.every((g) => g >= TIMING.intervalMs + 400 - 50), JSON.stringify(gaps));
	});

	test('HIDDEN: the tab hidden and no graph: no read; the readings dropped', async () => {
		await setUpAccess();
		assert.strictEqual((await showMetrics(B))?.kind, 'shown');
		assert.ok(await waitFor(() => metrics().state.kind === 'live', 10_000));
		await closeTab();
		assert.strictEqual(metrics().state.kind, 'waiting', 'dropped');
		await new Promise((r) => setTimeout(r, 200));
		assert.strictEqual(await readsDuring(TIMING.intervalMs * 3), 0);
	});

	test('NO_ACCESS / SET LATER: the tab opens in the no-access state naming the cluster, nothing read; the info offers Set up metrics access…, and once set the tab reads', async () => {
		infoAnswers = [undefined];
		assert.deepStrictEqual(await showMetrics(A), { kind: 'noAccess', pipelineId: A, file: fileA });
		assert.deepStrictEqual(metrics().state, { kind: 'noAccess', cluster: 'rpc-vilnius' });
		assert.strictEqual(metrics().title, 'Cloud · rpc-vilnius · orders');
		assert.deepStrictEqual(infos, [noMetricsAccessMessage('rpc-vilnius')]);
		assert.strictEqual(await readsDuring(TIMING.intervalMs * 2), 0, 'no read');
		// Set up from the offer: the tab starts reading.
		infos.length = 0;
		infoAnswers = [SET_UP_METRICS_ACCESS_ACTION];
		inputs = [DEFAULT_PROMETHEUS_USER, PASSWORD];
		assert.deepStrictEqual(await showMetrics(A), { kind: 'shown', pipelineId: A, file: fileA }, errors.join('\n'));
		assert.ok(await waitFor(() => metrics().state.kind === 'live' && metrics().rows().length === 3, 10_000), JSON.stringify(metrics().state));
		// Set from the row later works too.
		await vscode.commands.executeCommand(FORGET_METRICS_ACCESS_COMMAND, { kind: 'cluster', id: VILNIUS });
		assert.ok(await waitFor(() => metrics().state.kind === 'noAccess', 5_000));
		await setUpAccess();
		assert.ok(await waitFor(() => metrics().state.kind === 'live', 10_000), JSON.stringify(metrics().state));
	});

	test('REFUSED: a 401 is the refused state ("the user or password is wrong…") and is not read again until the access is set again or Show metrics runs again', async () => {
		await setUpAccess();
		fake.cluster(VILNIUS).prometheusPassword = WRONG_PASSWORD;
		assert.strictEqual((await showMetrics(A))?.kind, 'shown');
		assert.ok(await waitFor(() => metrics().state.kind === 'refused', 10_000), JSON.stringify(metrics().state));
		const state = metrics().state;
		assert.ok(state.kind === 'refused' && state.cluster === 'rpc-vilnius' && state.message.includes(CLOUD_REFUSED_TEXT), JSON.stringify(state));
		assert.strictEqual(await readsDuring(TIMING.intervalMs * 3), 0, 'not retried');
		// Show metrics again: read once more (refused again).
		const before = promReads();
		assert.strictEqual((await showMetrics(A))?.kind, 'shown');
		assert.ok(await waitFor(() => promReads() > before, 5_000));
		assert.ok(await waitFor(() => metrics().state.kind === 'refused', 5_000));
		// The access set again (the endpoint's password now): it reads.
		fake.cluster(VILNIUS).prometheusPassword = PASSWORD;
		await vscode.commands.executeCommand(FORGET_METRICS_ACCESS_COMMAND, { kind: 'cluster', id: VILNIUS });
		await setUpAccess();
		assert.ok(await waitFor(() => metrics().state.kind === 'live', 10_000), JSON.stringify(metrics().state));
	});

	test('REFUSED, SET UP AGAIN WITH THE SAME VALUES: a successful Set up metrics access reads again, without a Forget', async () => {
		await setUpAccess();
		// The endpoint refuses a moment (a rotated password), then takes the stored one again.
		fake.cluster(VILNIUS).prometheusPassword = WRONG_PASSWORD;
		assert.strictEqual((await showMetrics(A))?.kind, 'shown');
		assert.ok(await waitFor(() => metrics().state.kind === 'refused', 10_000), JSON.stringify(metrics().state));
		fake.cluster(VILNIUS).prometheusPassword = PASSWORD;
		await setUpAccess();
		assert.ok(await waitFor(() => metrics().state.kind === 'live', 10_000), JSON.stringify(metrics().state));
	});

	test('UNREACHABLE: a 5xx is quiet for the first failures, then the unreachable state with its reason; retried with the backoff; back once it answers', async () => {
		await setUpAccess();
		fake.cluster(VILNIUS).prometheusFailure = 503;
		assert.strictEqual((await showMetrics(A))?.kind, 'shown');
		assert.ok(await waitFor(() => promTimes.length >= 2, 10_000));
		assert.strictEqual(metrics().state.kind, 'waiting', 'quiet');
		assert.ok(await waitFor(() => metrics().state.kind === 'unreachable', 10_000), JSON.stringify(metrics().state));
		const state = metrics().state;
		assert.ok(state.kind === 'unreachable' && /answered HTTP 503$/.test(state.message), JSON.stringify(state));
		assert.ok(await waitFor(() => promTimes.length >= 4, 10_000));
		const gaps = promTimes.slice(1).map((t, i) => t - promTimes[i]);
		assert.ok(gaps[0] >= TIMING.retryDelaysMs[0] - 50 && gaps[1] >= TIMING.retryDelaysMs[1] - 50 && gaps[2] >= TIMING.retryDelaysMs[2] - 50, JSON.stringify(gaps));
		fake.cluster(VILNIUS).prometheusFailure = undefined;
		assert.ok(await waitFor(() => metrics().state.kind === 'live', 10_000), JSON.stringify(metrics().state));
	});

	test('NO_SERIES: a body with no series of A is the "no series" state of the local run (after 5 answers), and is not read on', async () => {
		await setUpAccess();
		fake.cluster(VILNIUS).metricsBody = cloudMetricsBody([B]);
		assert.strictEqual((await showMetrics(A))?.kind, 'shown');
		assert.ok(await waitFor(() => metrics().state.kind === 'notServed', 15_000), JSON.stringify(metrics().state));
		const state = metrics().state;
		assert.ok(state.kind === 'notServed' && state.reason.includes('has no Redpanda Connect component series') && state.reason.endsWith(CLOUD_NO_SERIES_HINT), JSON.stringify(state));
		assert.strictEqual(promReads(), 5);
		assert.strictEqual(metrics().rows().length, 0);
	});

	test('FORGOTTEN: live, then Forget metrics access: the no-access state, reading stops', async () => {
		await setUpAccess();
		assert.strictEqual((await showMetrics(A))?.kind, 'shown');
		assert.ok(await waitFor(() => metrics().state.kind === 'live', 10_000));
		await vscode.commands.executeCommand(FORGET_METRICS_ACCESS_COMMAND, { kind: 'cluster', id: VILNIUS });
		assert.deepStrictEqual(metrics().state, { kind: 'noAccess', cluster: 'rpc-vilnius' });
		await new Promise((r) => setTimeout(r, 100));
		assert.strictEqual(await readsDuring(TIMING.intervalMs * 3), 0);
	});

	test('NOT MAPPED: B has no local file: the tab only, rows by path, the header says it is not mapped; no graph gets its figures', async () => {
		await setUpAccess();
		const doc = await vscode.workspace.openTextDocument(fileA);
		await vscode.window.showTextDocument(doc);
		await vscode.commands.executeCommand('redpandaConnect.showGraph', doc.uri);
		const handle = api().graphPanels.panelFor(doc.uri)!;
		assert.deepStrictEqual(await showMetrics(B), { kind: 'shown', pipelineId: B, file: undefined });
		assert.ok(await waitFor(() => metrics().state.kind === 'live' && metrics().rows().length === 3, 10_000), JSON.stringify(metrics().state));
		assert.strictEqual(metrics().title, 'Cloud · rpc-vilnius · clicks');
		assert.strictEqual(lastPosted().file, null);
		assert.ok(metrics().file?.startsWith('redpanda-cloud-metrics:'), metrics().file);
		assert.deepStrictEqual(metrics().rows().map((r) => [r.nodeId, r.path]), [[null, 'input'], [null, 'output'], [null, 'pipeline.processors[0]']], 'by path');
		assert.strictEqual(metrics().rows()[2].p50, 9400, 'B\'s series');
		// A's file's graph keeps whatever its own feed reads (A's, when an earlier Show metrics bound it), never B's.
		await new Promise((r) => setTimeout(r, TIMING.intervalMs * 2));
		assert.ok(!JSON.stringify(handle.posted.filter((m) => m.type === 'nodeFigures')).includes('9400'), 'no graph gets B\'s figures');
	});

	test('LAST CHOSEN WINS: Show Pipeline Metrics on A\'s file after Show metrics binds it back to the local run', async () => {
		await setUpAccess();
		const doc = await vscode.workspace.openTextDocument(fileA);
		await vscode.window.showTextDocument(doc);
		assert.strictEqual((await showMetrics(A))?.kind, 'shown');
		assert.ok(await waitFor(() => metrics().state.kind === 'live', 10_000));
		await vscode.commands.executeCommand(SHOW_METRICS_COMMAND, doc.uri);
		assert.strictEqual(metrics().title, 'Local run · orders.yaml');
		assert.strictEqual(metrics().state.kind, 'notRunning');
		assert.strictEqual(lastPosted().cloud, undefined);
		await new Promise((r) => setTimeout(r, 100));
		assert.strictEqual(await readsDuring(TIMING.intervalMs * 3), 0, 'the Cloud is no longer read');
	});

	test('NO_LEAK: after live, refused and unreachable, the password is in no posted message (the tab\'s or the graph\'s), output line or view item', async () => {
		await setUpAccess();
		const doc = await vscode.workspace.openTextDocument(fileA);
		await vscode.window.showTextDocument(doc);
		await vscode.commands.executeCommand('redpandaConnect.showGraph', doc.uri);
		const graph = api().graphPanels.panelFor(doc.uri)!;
		assert.ok(graph, 'a graph panel');
		assert.strictEqual((await showMetrics(A))?.kind, 'shown');
		assert.ok(await waitFor(() => metrics().state.kind === 'live', 10_000));
		fake.cluster(VILNIUS).prometheusFailure = 503;
		assert.ok(await waitFor(() => metrics().state.kind === 'unreachable', 15_000), JSON.stringify(metrics().state));
		fake.cluster(VILNIUS).prometheusFailure = undefined;
		fake.cluster(VILNIUS).prometheusPassword = WRONG_PASSWORD;
		assert.ok(await waitFor(() => metrics().state.kind === 'refused', 15_000), JSON.stringify(metrics().state));
		seenItems.push(...cloud().items());
		assert.ok(figuresOf(graph).some((f) => Object.keys(f).length > 0), 'the graph showed the figures');
		const shown = JSON.stringify({ posted: metrics().posted, graph: graph.posted, shown: allShown, output: api().outputLines(), items: seenItems });
		const basic = Buffer.from(`prometheus:${PASSWORD}`).toString('base64');
		for (const value of [PASSWORD, basic, CLIENT_SECRET]) {
			assert.ok(!shown.includes(value), 'a secret in a posted message, a message, the output or the view');
		}
		assert.ok(api().outputLines().some((l) => l.includes('Pipeline metrics: orders on rpc-vilnius') && l.includes(CLOUD_REFUSED_TEXT)), 'the output says so');
		// The stored record is the only place it is.
		assert.ok((await cloud().storedValue(metricsAccessKey(VILNIUS)))?.includes(PASSWORD));
		assert.ok(!((await cloud().storedValue(CLIENT_ID_KEY)) ?? '').includes(PASSWORD));
		assert.ok(!((await cloud().storedValue(CLIENT_SECRET_KEY)) ?? '').includes(PASSWORD));
	});

	test('ticket 8, NO_ACCESS → Set up metrics access… from the tab: the prompt opens, the buttons disabled while it runs (a second request ignored); stored, the tab reads', async () => {
		infoAnswers = [undefined];
		assert.strictEqual((await showMetrics(A))?.kind, 'noAccess');
		assert.deepStrictEqual(metrics().state, { kind: 'noAccess', cluster: 'rpc-vilnius' });
		assert.strictEqual(lastPosted().settingUp, false);
		let release: () => void = () => undefined;
		inputGate = new Promise<void>((r) => {
			release = r;
		});
		inputs = [DEFAULT_PROMETHEUS_USER, PASSWORD];
		const shownBefore = allShown.length;
		const running = metrics().receive({ type: 'setUpAccessRequested' });
		assert.ok(await waitFor(() => lastPosted().settingUp === true, 5_000), 'disabled while it runs');
		assert.ok(allShown.slice(shownBefore).some((t) => t.startsWith('Set up metrics access for rpc-vilnius')), 'the prompt is open');
		// A second request while it runs is ignored (one prompt only).
		await metrics().receive({ type: 'setUpAccessRequested' });
		inputGate = undefined;
		release();
		await running;
		assert.strictEqual(lastPosted().settingUp, false);
		assert.strictEqual(allShown.slice(shownBefore).filter((t) => t.startsWith('Set up metrics access for rpc-vilnius (1/2)')).length, 1, 'one prompt');
		assert.ok(await waitFor(() => metrics().state.kind === 'live' && metrics().rows().length === 3, 10_000), JSON.stringify(metrics().state));
		assertNoPassword();
	});

	test('ticket 8, SET UP FROM THE INFO MESSAGE: a set-up of the bound cluster started from Show metrics\' offer disables the tab\'s set-up buttons too', async () => {
		let release: () => void = () => undefined;
		inputGate = new Promise<void>((r) => {
			release = r;
		});
		infoAnswers = [SET_UP_METRICS_ACCESS_ACTION];
		inputs = [DEFAULT_PROMETHEUS_USER, PASSWORD];
		const shown = showMetrics(A);
		assert.ok(await waitFor(() => metrics().state.kind === 'noAccess' && lastPosted().settingUp === true, 5_000), JSON.stringify(lastPosted()));
		inputGate = undefined;
		release();
		assert.strictEqual((await shown)?.kind, 'shown', errors.join('\n'));
		assert.ok(await waitFor(() => lastPosted().settingUp === false, 5_000), 'enabled again once it ends');
		assert.ok(await waitFor(() => metrics().state.kind === 'live', 10_000), JSON.stringify(metrics().state));
	});

	test('ticket 8, REFUSED → both buttons: Forget metrics access gives the no-access state; Set up metrics access… with the right password reads', async () => {
		await setUpAccess();
		fake.cluster(VILNIUS).prometheusPassword = WRONG_PASSWORD;
		assert.strictEqual((await showMetrics(A))?.kind, 'shown');
		assert.ok(await waitFor(() => metrics().state.kind === 'refused', 10_000), JSON.stringify(metrics().state));
		await metrics().receive({ type: 'forgetAccessRequested' });
		assert.ok(await waitFor(() => metrics().state.kind === 'noAccess', 5_000), JSON.stringify(metrics().state));
		assert.strictEqual(await cloud().storedValue(metricsAccessKey(VILNIUS)), undefined, 'forgotten');
		// Not offered while there is no access: ignored.
		const before = metrics().actions.length;
		await metrics().receive({ type: 'forgetAccessRequested' });
		assert.strictEqual(metrics().actions.length, before);
		fake.cluster(VILNIUS).prometheusPassword = PASSWORD;
		inputs = [DEFAULT_PROMETHEUS_USER, PASSWORD];
		await metrics().receive({ type: 'setUpAccessRequested' });
		assert.ok(await waitFor(() => metrics().state.kind === 'live', 10_000), JSON.stringify(metrics().state));
		assertNoPassword();
	});

	test('ticket 8, UNREACHABLE → Retry now reads at once, never sooner than the floor; the show says when the next retry is', async () => {
		await setUpAccess();
		metrics().feeds.cloudTiming = { ...TIMING, retryDelaysMs: [300, 300, 20_000] };
		try {
			fake.cluster(VILNIUS).prometheusFailure = 503;
			assert.strictEqual((await showMetrics(A))?.kind, 'shown');
			assert.ok(await waitFor(() => metrics().state.kind === 'unreachable', 10_000), JSON.stringify(metrics().state));
			const retryAt = lastPosted().retryAt;
			assert.ok(typeof retryAt === 'number' && retryAt - Date.now() > 15_000, `the next retry in about 20 s: ${String(retryAt)}`);
			const reads = promTimes.length;
			fake.cluster(VILNIUS).prometheusFailure = undefined;
			await metrics().receive({ type: 'retryRequested' });
			assert.ok(await waitFor(() => promTimes.length > reads, 3_000), 'read at once');
			assert.ok(promTimes[reads] - promTimes[reads - 1] >= TIMING.minGapMs - 50, `within the floor: ${promTimes[reads] - promTimes[reads - 1]} ms`);
			assert.ok(await waitFor(() => metrics().state.kind === 'live', 10_000), JSON.stringify(metrics().state));
		} finally {
			metrics().feeds.cloudTiming = TIMING;
		}
	});

	test('ticket 8, NO_SERIES → Read again: a fresh read cycle; once the pipeline\'s series are there, live', async () => {
		await setUpAccess();
		fake.cluster(VILNIUS).metricsBody = cloudMetricsBody([B]);
		assert.strictEqual((await showMetrics(A))?.kind, 'shown');
		assert.ok(await waitFor(() => metrics().state.kind === 'notServed', 15_000), JSON.stringify(metrics().state));
		assert.strictEqual((metrics().state as { cause: string }).cause, 'noSeries');
		assert.strictEqual(promReads(), 5);
		fake.cluster(VILNIUS).metricsBody = undefined;
		await metrics().receive({ type: 'readAgainRequested' });
		assert.ok(await waitFor(() => metrics().state.kind === 'live', 10_000), JSON.stringify(metrics().state));
		assert.ok(promReads() > 5);
	});

	test('ticket 8, NOT RUNNING, MAPPED: the file\'s .cloud.json pipeline is offered ("Show orders on rpc-vilnius") and its button shows it', async () => {
		await setUpAccess();
		const mapping = `${fileA}.cloud.json`;
		fs.writeFileSync(mapping, JSON.stringify({ clusterId: VILNIUS, pipelineId: A, clusterName: 'rpc-vilnius', pipelineName: 'orders' }));
		try {
			const doc = await vscode.workspace.openTextDocument(fileA);
			await vscode.window.showTextDocument(doc);
			// The tab's direct bind (Show Pipeline Metrics would go to the mapped pipeline, ticket 9).
			await metrics().show(doc.uri);
			assert.strictEqual(metrics().state.kind, 'notRunning');
			assert.ok(await waitFor(() => lastPosted().mapped !== null && lastPosted().mapped !== undefined, 5_000), JSON.stringify(lastPosted().mapped));
			assert.deepStrictEqual(lastPosted().mapped, { pipeline: 'orders', cluster: 'rpc-vilnius' });
			await metrics().receive({ type: 'showMappedRequested' });
			assert.strictEqual(metrics().title, 'Cloud · rpc-vilnius · orders');
			assert.ok(await waitFor(() => metrics().state.kind === 'live', 10_000), JSON.stringify(metrics().state));
			assert.strictEqual(lastPosted().mapped, null, 'no longer offered once shown');
		} finally {
			fs.rmSync(mapping, { force: true });
		}
	});

	test('ticket 8, NOT RUNNING, MAPPED, NOT SIGNED IN: its button says to connect a service account first', async () => {
		const mapping = `${fileA}.cloud.json`;
		fs.writeFileSync(mapping, JSON.stringify({ clusterId: VILNIUS, pipelineId: A, clusterName: 'rpc-vilnius', pipelineName: 'orders' }));
		try {
			await cloud().disconnect();
			infos.length = 0;
			infoAnswers = [undefined];
			const doc = await vscode.workspace.openTextDocument(fileA);
			await vscode.window.showTextDocument(doc);
			await metrics().show(doc.uri);
			assert.ok(await waitFor(() => lastPosted().mapped !== null && lastPosted().mapped !== undefined, 5_000), JSON.stringify(lastPosted().mapped));
			await metrics().receive({ type: 'showMappedRequested' });
			assert.deepStrictEqual(infos, [NOT_CONNECTED_FOR_METRICS_MESSAGE]);
			assert.strictEqual(metrics().title, 'Local run · orders.yaml', 'the tab stays on the file');
		} finally {
			fs.rmSync(mapping, { force: true });
		}
	});
	test('ticket 9, MAPPED_NO_RUN: Show Pipeline Metrics on a not-running file with its own .cloud.json opens the tab on that pipeline', async () => {
		await setUpAccess();
		const mapping = `${fileA}.cloud.json`;
		fs.writeFileSync(mapping, JSON.stringify({ clusterId: VILNIUS, pipelineId: A, clusterName: 'rpc-vilnius', pipelineName: 'orders' }));
		try {
			const doc = await vscode.workspace.openTextDocument(fileA);
			await vscode.window.showTextDocument(doc);
			// From the palette: the active config.
			await vscode.commands.executeCommand(SHOW_METRICS_COMMAND);
			assert.ok(await waitFor(() => metrics().title === 'Cloud · rpc-vilnius · orders', 10_000), String(metrics().title));
			assert.ok(metrics().visible, 'the tab is focused');
			assert.ok(await waitFor(() => metrics().state.kind === 'live', 10_000), `${JSON.stringify(metrics().state)}\n${api().outputLines().slice(-25).join('\n')}`);
			assert.strictEqual(lastPosted().file, 'orders.yaml');
		} finally {
			fs.rmSync(mapping, { force: true });
		}
	});

	test('ticket 9, MAPPED_NO_RUN, NOT SIGNED IN: Show metrics\' message, then (bug 58) the tab shows the file, Not running', async () => {
		const mapping = `${fileA}.cloud.json`;
		fs.writeFileSync(mapping, JSON.stringify({ clusterId: VILNIUS, pipelineId: A, clusterName: 'rpc-vilnius', pipelineName: 'orders' }));
		try {
			await disconnectSettled();
			infos.length = 0;
			infoAnswers = [undefined];
			const doc = await vscode.workspace.openTextDocument(fileA);
			await vscode.window.showTextDocument(doc);
			// Another source first, so a tab left as it was would show it.
			await metrics().show(otherFile());
			await vscode.commands.executeCommand(SHOW_METRICS_COMMAND, doc.uri);
			assert.deepStrictEqual(infos, [NOT_CONNECTED_FOR_METRICS_MESSAGE]);
			assert.strictEqual(metrics().title, 'Local run · orders.yaml');
			assert.strictEqual(metrics().state.kind, 'notRunning');
			assert.ok(await waitFor(() => lastPosted().mapped !== null, 5_000), 'its Show button is offered');
			assert.deepStrictEqual(lastPosted().mapped, { pipeline: 'orders', cluster: 'rpc-vilnius' });
		} finally {
			fs.rmSync(mapping, { force: true });
		}
	});

	test('bug 58, CLUSTERS_NOT_LOADED: a stored account whose cluster list was never loaded: Show Pipeline Metrics loads it and shows the mapped pipeline', async () => {
		await setUpAccess();
		const mapping = `${fileA}.cloud.json`;
		fs.writeFileSync(mapping, JSON.stringify({ clusterId: VILNIUS, pipelineId: A, clusterName: 'rpc-vilnius', pipelineName: 'orders' }));
		try {
			// As a new window: the account stored by another one, nothing read yet (96-cloud's startup case).
			await disconnectSettled();
			await cloud().storeAsAnotherWindow(CLIENT_SECRET_KEY, CLIENT_SECRET);
			await cloud().storeAsAnotherWindow(CLIENT_ID_KEY, CLIENT_ID);
			assert.ok(await waitFor(() => cloud().connected, 10_000), 'the stored account is read');
			fake.requests.length = 0;
			errors.length = 0;
			infos.length = 0;
			const doc = await vscode.workspace.openTextDocument(fileA);
			await vscode.window.showTextDocument(doc);
			await vscode.commands.executeCommand(SHOW_METRICS_COMMAND, doc.uri);
			assert.deepStrictEqual([errors, infos], [[], []]);
			assert.ok(fake.requests.some((r) => r.method === 'GET' && r.url.startsWith('/v1/clusters')), 'the cluster list was read by Show metrics');
			assert.strictEqual(metrics().title, 'Cloud · rpc-vilnius · orders');
			assert.ok(await waitFor(() => metrics().state.kind === 'live', 10_000), JSON.stringify(metrics().state));
		} finally {
			fs.rmSync(mapping, { force: true });
		}
	});

	test('bug 58, CLUSTERS_NOT_LOADED, LOAD FAILS: the cluster list read by Show metrics fails: the Cloud view\'s error once, no "no longer" message, the file Not running', async () => {
		const mapping = `${fileA}.cloud.json`;
		fs.writeFileSync(mapping, JSON.stringify({ clusterId: VILNIUS, pipelineId: A, clusterName: 'rpc-vilnius', pipelineName: 'orders' }));
		try {
			// As CLUSTERS_NOT_LOADED: an account stored by another window, nothing read yet.
			await disconnectSettled();
			await cloud().storeAsAnotherWindow(CLIENT_SECRET_KEY, CLIENT_SECRET);
			await cloud().storeAsAnotherWindow(CLIENT_ID_KEY, CLIENT_ID);
			assert.ok(await waitFor(() => cloud().connected, 10_000), 'the stored account is read');
			fake.clustersError = { status: 503, body: { code: 'UNAVAILABLE', message: 'control plane is down' } };
			errors.length = 0;
			infos.length = 0;
			const doc = await vscode.workspace.openTextDocument(fileA);
			await vscode.window.showTextDocument(doc);
			await metrics().show(otherFile());
			await vscode.commands.executeCommand(SHOW_METRICS_COMMAND, doc.uri);
			assert.deepStrictEqual(errors, ['Could not list the Redpanda Cloud clusters: control plane is down'], 'the Cloud view\'s error, once');
			assert.ok(!infos.some((m) => m.includes('no longer in the Cloud view')), infos.join('\n'));
			assert.strictEqual(metrics().title, 'Local run · orders.yaml');
			assert.strictEqual(metrics().state.kind, 'notRunning');
		} finally {
			fake.clustersError = undefined;
			fs.rmSync(mapping, { force: true });
		}
	});

	test('bug 58, RACE: Show metrics with a stale request token (the tab\'s request a later choice superseded): its binding is dropped, the tab stays on the file', async () => {
		await setUpAccess();
		const other = otherFile();
		await metrics().show(other);
		const result = await vscode.commands.executeCommand<{ kind: string }>(SHOW_CLOUD_METRICS_COMMAND, { ...pipelineNode(A), request: 1 });
		assert.strictEqual(result?.kind, 'shown', 'Show metrics itself ran');
		assert.strictEqual(metrics().file, other.toString());
		assert.strictEqual(metrics().title, 'Local run · other.yaml');
		assert.ok(api().outputLines().some((l) => l.includes('Pipeline metrics: dropped the binding of pipeline orders on rpc-vilnius')), 'the binding was dropped');
	});

	test('bug 58, RETRY: the bind on opening failed signed out; after Connect (the Cloud view changed), opening the tab again binds the mapped pipeline', async () => {
		const mapping = `${fileA}.cloud.json`;
		fs.writeFileSync(mapping, JSON.stringify({ clusterId: VILNIUS, pipelineId: A, clusterName: 'rpc-vilnius', pipelineName: 'orders' }));
		try {
			await disconnectSettled();
			const doc = await vscode.workspace.openTextDocument(fileA);
			await vscode.window.showTextDocument(doc);
			assert.ok(await waitFor(() => api().detection.isDetected(doc.uri), 5_000));
			await closeTab();
			metrics().unbind();
			infos.length = 0;
			infoAnswers = [undefined];
			// Opened with nothing bound: the active config's mapping is tried, and Show metrics does not start.
			await vscode.commands.executeCommand(`${METRICS_VIEW_ID}.focus`);
			assert.ok(await waitFor(() => infos.length > 0, 10_000), 'Show metrics\' message');
			assert.deepStrictEqual(infos, [NOT_CONNECTED_FOR_METRICS_MESSAGE]);
			assert.strictEqual(metrics().file, undefined);
			// Connect: the Cloud view's data change lets the bind on opening try again on the next reveal.
			inputs = [CLIENT_ID, CLIENT_SECRET];
			assert.strictEqual(await vscode.commands.executeCommand(CONNECT_COMMAND), true, errors.join('\n'));
			await closeTab();
			await vscode.commands.executeCommand(`${METRICS_VIEW_ID}.focus`);
			assert.ok(await waitFor(() => metrics().title === 'Cloud · rpc-vilnius · orders', 10_000), String(metrics().title));
		} finally {
			fs.rmSync(mapping, { force: true });
		}
	});

	test('bug 58, GENUINELY_GONE: the cluster list loaded, the mapped pipeline not in it: Show metrics\' message, then the file, Not running', async () => {
		const gone = 'd5gone00000000000003';
		const mapping = `${fileA}.cloud.json`;
		fs.writeFileSync(mapping, JSON.stringify({ clusterId: VILNIUS, pipelineId: gone, clusterName: 'rpc-vilnius', pipelineName: 'archived' }));
		try {
			const doc = await vscode.workspace.openTextDocument(fileA);
			await vscode.window.showTextDocument(doc);
			await metrics().show(otherFile());
			await vscode.commands.executeCommand(SHOW_METRICS_COMMAND, doc.uri);
			assert.deepStrictEqual(infos, ['That pipeline is no longer in the Cloud view. Refresh the view to read the pipelines again.']);
			assert.strictEqual(metrics().title, 'Local run · orders.yaml');
			assert.strictEqual(metrics().state.kind, 'notRunning');
		} finally {
			fs.rmSync(mapping, { force: true });
		}
	});

	test('ticket 9, NO_EDITOR: the pick lists the Cloud view\'s loaded pipelines (no listing call); one chosen opens the tab on it', async () => {
		await setUpAccess();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		const original = metrics().ui;
		const shown: string[][] = [];
		metrics().ui = {
			pick: async (_title, items) => {
				// Only the Cloud entries: no run is started in this suite.
				shown.push(items.filter((i) => i.kind === 'cloud').map((i) => `${i.kind}:${i.label}:${i.description}`));
				return items.find((i) => i.kind === 'cloud' && i.label === 'clicks');
			},
		};
		try {
			fake.requests.length = 0;
			await vscode.commands.executeCommand(SHOW_METRICS_COMMAND);
			assert.deepStrictEqual(shown, [['cloud:orders:Cloud · rpc-vilnius', 'cloud:clicks:Cloud · rpc-vilnius']]);
			assert.ok(await waitFor(() => metrics().title === 'Cloud · rpc-vilnius · clicks', 10_000), String(metrics().title));
			assert.ok(!fake.requests.some((r) => r.method === 'GET' && /\/v1\/redpanda-connect\/pipelines(\?|$)/.test(r.url)), 'no listing call for the pick');
		} finally {
			metrics().ui = original;
		}
	});
	// Story 62: the risks epic 7 left unverified (the plan's matrix rows C12 disconnect and C9).
	test('story 62 C12 disconnect: the tab Cloud-bound in no access after a sign-out; its Set up metrics access… offers Connect, not "cluster gone"', async () => {
		await setUpAccess();
		assert.strictEqual((await showMetrics(A))?.kind, 'shown');
		assert.ok(await waitFor(() => metrics().state.kind === 'live', 10_000), JSON.stringify(metrics().state));
		await disconnectSettled();
		assert.ok(await waitFor(() => metrics().state.kind === 'noAccess', 5_000), JSON.stringify(metrics().state));
		assert.strictEqual(metrics().title, 'Cloud · rpc-vilnius · orders', 'still the Cloud pipeline');
		infos.length = 0;
		infoAnswers = [undefined];
		const shownBefore = allShown.length;
		await metrics().receive({ type: 'setUpAccessRequested' });
		assert.deepStrictEqual(infos, [NOT_CONNECTED_FOR_METRICS_MESSAGE]);
		assert.ok(!infos.includes(CLUSTER_GONE));
		assert.ok(!allShown.slice(shownBefore).some((t) => t.startsWith('Set up metrics access for')), 'no prompt while signed out');
	});

	async function cloudBoundGraph(): Promise<{ readonly uri: vscode.Uri; readonly handle: GraphPanelHandle }> {
		await setUpAccess();
		const doc = await vscode.workspace.openTextDocument(fileA);
		await vscode.window.showTextDocument(doc);
		await vscode.commands.executeCommand('redpandaConnect.showGraph', doc.uri);
		const handle = api().graphPanels.panelFor(doc.uri)!;
		assert.strictEqual((await showMetrics(A))?.kind, 'shown');
		await closeTab();
		// The graph alone keeps the feed on the Cloud pipeline.
		assert.ok(await waitFor(() => metrics().feeds.feedOf(doc.uri)?.update.source.kind === 'cloud', 5_000));
		assert.ok(await readsDuring(TIMING.intervalMs * 2 + 200) >= 1, 'the graph alone reads');
		return { uri: doc.uri, handle };
	}

	test('story 62 C9 gone: the graph reads A with the tab closed; A leaves the Cloud view on a refresh: its feed goes back to the local run, A no longer read', async () => {
		const { uri } = await cloudBoundGraph();
		fake.cluster(VILNIUS).pipelines = [pipeline(B, 'clicks', {})];
		await cloud().refresh({ kind: 'cluster', id: VILNIUS });
		assert.ok(await waitFor(() => metrics().feeds.feedOf(uri)?.update.source.kind === 'local', 5_000),
			JSON.stringify(metrics().feeds.feedOf(uri)?.update.source));
		await new Promise((r) => setTimeout(r, 200));
		assert.strictEqual(await readsDuring(TIMING.intervalMs * 3), 0, 'the old pipeline is not read on');
	});

	test('story 62 C9 remapped: the graph reads A with the tab closed; A\'s .cloud.json now maps B: after a Cloud change its feed goes back to the local run', async () => {
		const { uri } = await cloudBoundGraph();
		const mapping = `${fileA}.cloud.json`;
		fs.writeFileSync(mapping, JSON.stringify({ clusterId: VILNIUS, pipelineId: B, clusterName: 'rpc-vilnius', pipelineName: 'clicks' }));
		try {
			await cloud().refresh({ kind: 'cluster', id: VILNIUS });
			assert.ok(await waitFor(() => metrics().feeds.feedOf(uri)?.update.source.kind === 'local', 5_000),
				JSON.stringify(metrics().feeds.feedOf(uri)?.update.source));
			await new Promise((r) => setTimeout(r, 200));
			assert.strictEqual(await readsDuring(TIMING.intervalMs * 3), 0, 'the old pipeline is not read on');
		} finally {
			fs.rmSync(mapping, { force: true });
		}
	});
});
