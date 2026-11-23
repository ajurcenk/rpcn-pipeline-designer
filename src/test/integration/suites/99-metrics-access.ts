// Metrics access for a cluster (ticket 7.4, AD-25), end to end in the stable run: the Cloud view against
// the Cloud fake (`helpers/fakeCloud.ts`, its clusters now with `prometheus.url` and a fake Prometheus
// endpoint behind basic auth, gzip when asked). Set up metrics access… and Forget metrics access run
// through their commands, their prompts replaced by a script of answers. Every matrix row of the plan has
// a test (ACCEPTED … NO_LEAK); FILTER and GZIP read the fake endpoint through the Cloud source
// (`cloudMetricsSource`) that entry 5 will hand the Pipeline Metrics tab. NO_LEAK checks the password
// against every message, prompt, output line, view item, setting, file and the secret storage's other keys.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	CLIENT_ID_KEY, CLIENT_SECRET_KEY, CONNECT_COMMAND, FORGET_METRICS_ACCESS_COMMAND, logAccessKey, METRICS_ACCESS_PREFIX, metricsAccessForgottenMessage, metricsAccessKey,
	metricsAccessSetMessage, metricsRefusedMessage, NO_CLUSTER_WITH_METRICS_ACCESS, NO_METRICS_ACCESS, noPrometheusEndpointMessage, SET_UP_METRICS_ACCESS_COMMAND, type CloudItem, type CloudUi,
} from '../../../adapters/vscode/cloudView';
import { CLOUD_REFUSED_TEXT, cloudMetricsSource, DEFAULT_PROMETHEUS_USER } from '../../../adapters/metrics/source';
import { setUpRunningMessage } from '../../../adapters/vscode/cloudShared';
import { type ExtensionApi } from '../../../extension';
import { FakeCloud, type FakePipeline } from '../../helpers/fakeCloud';
import { makeTempDir } from '../../helpers/fakeBinary';
import { EXTENSION_ID, waitFor } from '../helpers';

const CLIENT_ID = 'fake-client-id-7-4';
const CLIENT_SECRET = 'fake-client-secret-7-4-Qe8';
const PASSWORD = 'prom-password-7-4-Zr5t';
const WRONG_PASSWORD = 'wrong-prom-password-7-4-Lp2w';
const VILNIUS = 'cvilnius0000000000aa';
const BYOC = 'cbyoc000000000000bbb';
const NOPROM = 'cnoprom00000000000cc';
const ORDERS = 'd3orders000000000001';
const CLICKS = 'd3clicks000000000002';
const SET_UP_LOG_ACCESS = 'redpandaConnect.cloud.setUpLogAccess';
const FORGET_LOG_ACCESS = 'redpandaConnect.cloud.forgetLogAccess';
const REFRESH = 'redpandaConnect.cloud.refresh';

type Input = string | undefined;

function filesUnder(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		return e.isDirectory() ? filesUnder(p) : e.isFile() ? [p] : [];
	});
}

suite('Metrics access for a cluster (integration, ticket 7.4)', function () {
	this.timeout(60_000);
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const cloud = () => api().cloud!;
	let fake: FakeCloud;
	let originalUi: CloudUi;
	let originalTimeout: number;
	let dir: string;
	let inputs: (Input | (() => Promise<Input>))[] = [];
	let asked: vscode.InputBoxOptions[] = [];
	let clusterPicks: (string | undefined)[] = [];
	const errors: string[] = [];
	const infos: string[] = [];
	const allShown: string[] = [];
	const seenItems: CloudItem[] = [];

	function script(next: { inputs?: (Input | (() => Promise<Input>))[]; clusterPicks?: (string | undefined)[] }): void {
		inputs = [...(next.inputs ?? [])];
		clusterPicks = [...(next.clusterPicks ?? [])];
		asked = [];
	}
	const clearMessages = () => {
		errors.length = 0;
		infos.length = 0;
	};

	const items = () => {
		const now = cloud().items();
		seenItems.push(...now);
		return now;
	};
	const clusterItem = (name: string) => items().find((i) => i.node.kind === 'cluster' && i.label === name)!;
	const clusterNode = (id: string): CloudItem['node'] => ({ kind: 'cluster', id });
	const setUp = (node: CloudItem['node'] = clusterNode(VILNIUS)) =>
		vscode.commands.executeCommand<{ kind: string; refused?: boolean; message?: string; username?: string }>(SET_UP_METRICS_ACCESS_COMMAND, node);
	const forget = (node?: CloudItem['node']) => vscode.commands.executeCommand<{ kind: string; clusterId?: string }>(FORGET_METRICS_ACCESS_COMMAND, node);
	const promReads = () => fake.requestsTo('/prom/');
	const stored = (id = VILNIUS) => cloud().storedValue(metricsAccessKey(id));

	function pipeline(id: string, name: string): FakePipeline {
		return {
			id, display_name: name, description: '', config_yaml: 'input:\n  generate:\n    mapping: root = 1\noutput:\n  drop: {}\n',
			resources: { cpu_shares: '100m', memory_shares: '400M' }, tags: {}, state: 'STATE_RUNNING', sequence: [],
		};
	}

	async function connectAndRead(): Promise<void> {
		script({ inputs: [CLIENT_ID, CLIENT_SECRET] });
		assert.strictEqual(await vscode.commands.executeCommand(CONNECT_COMMAND), true, errors.join('\n'));
		await cloud().refresh({ kind: 'cluster', id: VILNIUS });
	}

	async function setUpAccess(): Promise<void> {
		script({ inputs: [DEFAULT_PROMETHEUS_USER, PASSWORD] });
		const result = await setUp();
		assert.strictEqual(result?.kind, 'stored', errors.join('\n'));
	}

	suiteSetup(async () => {
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
		dir = makeTempDir('rpcn-metrics-access-');
		fake = new FakeCloud({
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
			clientName: 'metrics-bot',
			clusters: [
				{ id: VILNIUS, name: 'rpc-vilnius', type: 'TYPE_DEDICATED', cloudProvider: 'CLOUD_PROVIDER_AWS', region: 'us-east-2', connectVersion: '4.118.0', prometheus: true, prometheusPassword: PASSWORD, pipelines: [] },
				{ id: BYOC, name: 'byoc-eu', type: 'TYPE_BYOC', cloudProvider: 'CLOUD_PROVIDER_GCP', region: 'europe-west1', connectVersion: '4.118.0', prometheus: true, prometheusPassword: PASSWORD, pipelines: [] },
				{ id: NOPROM, name: 'no-prom', type: 'TYPE_DEDICATED', cloudProvider: 'CLOUD_PROVIDER_AWS', region: 'eu-west-1', connectVersion: '4.118.0', pipelines: [] },
			],
		});
		await fake.start();
		originalUi = cloud().ui;
		originalTimeout = cloud().metricsTimeoutMs;
		cloud().endpoints = { authUrl: fake.url, controlPlaneUrl: fake.url, requireHttps: false };
		cloud().ui = {
			...originalUi,
			input: async (options) => {
				asked.push(options);
				allShown.push(options.title ?? '', options.prompt ?? '', options.value ?? '');
				const next = inputs.shift();
				return typeof next === 'function' ? next() : next;
			},
			pickCluster: async (clusters) => {
				allShown.push(...clusters.map((c) => c.name));
				const name = clusterPicks.shift();
				return clusters.find((c) => c.name === name);
			},
			error: async (m) => {
				errors.push(m);
				allShown.push(m);
				return undefined;
			},
			info: async (m) => {
				infos.push(m);
				allShown.push(m);
				return undefined;
			},
			progress: async (title, task) => {
				allShown.push(title);
				return task(() => undefined);
			},
		};
	});

	setup(async () => {
		await cloud().disconnect();
		await new Promise((r) => setTimeout(r, 300));
		for (const id of [VILNIUS, BYOC, NOPROM]) {
			await cloud().removeMetricsAccess(id);
			await cloud().removeLogAccess(id);
		}
		fake.cluster(VILNIUS).pipelines = [pipeline(ORDERS, 'orders'), pipeline(CLICKS, 'clicks')];
		fake.cluster(VILNIUS).prometheusFailure = undefined;
		fake.cluster(VILNIUS).prometheusPassword = PASSWORD;
		fake.delay = undefined;
		fake.prometheusGzip = true;
		cloud().metricsTimeoutMs = originalTimeout;
		clearMessages();
		script({});
		await connectAndRead();
		clearMessages();
		fake.requests.length = 0;
	});

	suiteTeardown(async () => {
		if (!fake) {
			return;
		}
		for (const id of [VILNIUS, BYOC, NOPROM]) {
			await cloud().removeMetricsAccess(id);
			await cloud().removeLogAccess(id);
		}
		await cloud().disconnect();
		cloud().ui = originalUi;
		cloud().metricsTimeoutMs = originalTimeout;
		await fake.stop();
		if (dir) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('package.json: Set up metrics access… and Forget metrics access, titled as the log access\'s; on cluster rows only (Forget also in the palette); every cluster-row action matches logs and metrics in any combination', () => {
		const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as {
			contributes: { commands: { command: string; title: string; icon?: string }[]; menus: Record<string, { command: string; when?: string; group?: string }[]> };
		};
		const command = (c: string) => pkg.contributes.commands.find((x) => x.command === c);
		assert.deepStrictEqual([SET_UP_METRICS_ACCESS_COMMAND, FORGET_METRICS_ACCESS_COMMAND].map((c) => [command(c)?.title, command(c)?.icon]),
			[['Set up metrics access…', '$(key)'], ['Forget metrics access', '$(trash)']]);
		const palette = (c: string) => pkg.contributes.menus.commandPalette.find((m) => m.command === c);
		assert.strictEqual(palette(SET_UP_METRICS_ACCESS_COMMAND)?.when, 'false', 'Set up: rows only');
		assert.ok(palette(FORGET_METRICS_ACCESS_COMMAND) && palette(FORGET_METRICS_ACCESS_COMMAND)!.when === undefined, 'Forget: in the palette (a cluster pick)');
		const offered = (contextValue: string, inline: boolean) => pkg.contributes.menus['view/item/context']
			.filter((m) => m.when?.includes('view == redpandaConnect.cloud'))
			.filter((m) => (m.group?.startsWith('inline') ?? false) === inline)
			.filter((m) => { const r = /viewItem =~ \/(.+)\/$/.exec(m.when ?? ''); return r ? new RegExp(r[1]).test(contextValue) : m.when?.includes(`viewItem == ${contextValue}`); })
			.map((m) => m.command).sort();
		const base = [REFRESH, SET_UP_LOG_ACCESS, SET_UP_METRICS_ACCESS_COMMAND];
		assert.deepStrictEqual(offered('cloudCluster', false), [...base].sort());
		assert.deepStrictEqual(offered('cloudCluster logs', false), [...base, FORGET_LOG_ACCESS].sort());
		assert.deepStrictEqual(offered('cloudCluster metrics', false), [...base, FORGET_METRICS_ACCESS_COMMAND].sort());
		assert.deepStrictEqual(offered('cloudCluster logs metrics', false), [...base, FORGET_LOG_ACCESS, FORGET_METRICS_ACCESS_COMMAND].sort());
		for (const v of ['cloudCluster', 'cloudCluster logs', 'cloudCluster metrics', 'cloudCluster logs metrics']) {
			assert.deepStrictEqual(offered(v, true), [REFRESH], `${v}: Refresh inline`);
		}
		assert.deepStrictEqual(offered('cloudCluster noPipelineApi', false), []);
		assert.deepStrictEqual(offered('cloudCluster detailsUnread', false), []);
		assert.ok(!offered('cloudPipeline state-running logs', false).includes(SET_UP_METRICS_ACCESS_COMMAND), 'not on a pipeline row');
	});

	test('ACCEPTED: two steps (the user prefilled with prometheus, then a password box); one test read with basic auth; stored; the row shows "· metrics"; the message names the cluster', async () => {
		script({ inputs: [DEFAULT_PROMETHEUS_USER, PASSWORD] });
		assert.deepStrictEqual(await setUp(), { kind: 'stored', username: 'prometheus' }, errors.join('\n'));
		assert.deepStrictEqual(asked.map((a) => [a.title, a.value, a.password ?? false]), [
			['Set up metrics access for rpc-vilnius (1/2)', 'prometheus', false],
			['Set up metrics access for rpc-vilnius (2/2)', undefined, true],
		]);
		assert.ok(asked[1].prompt?.includes('Prometheus password for rpc-vilnius (user prometheus)'), asked[1].prompt);
		assert.strictEqual(promReads().length, 1, 'one test read');
		assert.strictEqual(promReads()[0].headers.authorization, `Basic ${Buffer.from(`prometheus:${PASSWORD}`).toString('base64')}`);
		assert.match(String(promReads()[0].headers['accept-encoding']), /\bgzip\b/);
		assert.deepStrictEqual(JSON.parse((await stored())!), { username: 'prometheus', password: PASSWORD });
		assert.deepStrictEqual(await cloud().storedMetricsAccess(VILNIUS), { username: 'prometheus' });
		assert.deepStrictEqual(infos, [metricsAccessSetMessage('rpc-vilnius')]);
		assert.deepStrictEqual(errors, []);
		const row = clusterItem('rpc-vilnius');
		assert.ok(row.description.endsWith(' · metrics'), row.description);
		assert.strictEqual(row.contextValue, 'cloudCluster metrics');
		assert.ok(row.tooltip.includes('Its pipeline metrics are read from its Prometheus endpoint as prometheus.'), row.tooltip);
		assert.strictEqual(clusterItem('byoc-eu').contextValue, 'cloudCluster', 'per cluster');
		assert.ok(clusterItem('byoc-eu').description.endsWith(` · ${NO_METRICS_ACCESS}`), clusterItem('byoc-eu').description);
		assert.ok(clusterItem('byoc-eu').tooltip.includes('It has no metrics access set'), clusterItem('byoc-eu').tooltip);
		// A cluster with no Prometheus endpoint says nothing of metrics.
		assert.ok(!clusterItem('no-prom').description.includes('metrics'), clusterItem('no-prom').description);
		// Set up again: the stored user is prefilled.
		script({ inputs: [undefined] });
		assert.deepStrictEqual(await setUp(), { kind: 'notStarted' });
		assert.strictEqual(asked[0].value, 'prometheus');
	});

	test('ACCEPTED (another user): the user typed is the one read as and stored', async () => {
		fake.cluster(BYOC).prometheusUser = 'metrics-reader';
		try {
			script({ inputs: ['  metrics-reader ', PASSWORD] });
			assert.deepStrictEqual(await setUp(clusterNode(BYOC)), { kind: 'stored', username: 'metrics-reader' }, errors.join('\n'));
			assert.deepStrictEqual(await cloud().storedMetricsAccess(BYOC), { username: 'metrics-reader' });
			assert.ok(clusterItem('byoc-eu').tooltip.includes('as metrics-reader.'));
		} finally {
			fake.cluster(BYOC).prometheusUser = undefined;
		}
	});

	test('REFUSED: a wrong password (401, empty body): nothing stored; "refused: the user or password is wrong"; read once, not retried', async () => {
		script({ inputs: [DEFAULT_PROMETHEUS_USER, WRONG_PASSWORD] });
		const result = await setUp();
		assert.deepStrictEqual(result, { kind: 'failed', refused: true, message: metricsRefusedMessage('rpc-vilnius') });
		assert.ok(metricsRefusedMessage('rpc-vilnius').includes(CLOUD_REFUSED_TEXT));
		assert.deepStrictEqual(errors, [metricsRefusedMessage('rpc-vilnius')]);
		assert.strictEqual(promReads().length, 1);
		assert.strictEqual(await stored(), undefined);
		assert.strictEqual(clusterItem('rpc-vilnius').contextValue, 'cloudCluster');
		assert.ok(clusterItem('rpc-vilnius').description.endsWith(` · ${NO_METRICS_ACCESS}`), clusterItem('rpc-vilnius').description);
		assert.deepStrictEqual(infos, []);
	});

	test('UNREACHABLE: a 5xx or a timeout stores nothing; "Could not read the Prometheus endpoint of <cluster>: <reason>"', async () => {
		fake.cluster(VILNIUS).prometheusFailure = 503;
		script({ inputs: [DEFAULT_PROMETHEUS_USER, PASSWORD] });
		let result = await setUp();
		assert.strictEqual(result?.kind, 'failed');
		assert.strictEqual(result?.refused, false);
		assert.strictEqual(errors.length, 1);
		assert.match(errors[0], /^Could not read the Prometheus endpoint of rpc-vilnius: 127\.0\.0\.1:\d+ answered HTTP 503$/);
		assert.strictEqual(await stored(), undefined);
		fake.cluster(VILNIUS).prometheusFailure = undefined;
		// A timeout (shortened through the seam).
		clearMessages();
		cloud().metricsTimeoutMs = 300;
		fake.delay = (req) => (req.url.startsWith('/prom/') ? 2_000 : 0);
		script({ inputs: [DEFAULT_PROMETHEUS_USER, PASSWORD] });
		result = await setUp();
		assert.strictEqual(result?.kind, 'failed');
		assert.match(errors[0], /^Could not read the Prometheus endpoint of rpc-vilnius: no answer from 127\.0\.0\.1:\d+ within 0\.3 s$/);
		assert.strictEqual(await stored(), undefined);
		assert.strictEqual(clusterItem('rpc-vilnius').contextValue, 'cloudCluster');
		assert.ok(api().outputLines().some((l) => l.includes('the metrics access test of prometheus on rpc-vilnius failed') && l.includes('nothing was stored')));
	});

	test('NO_ADDRESS: a cluster whose details have no prometheus.url: said so, nothing asked or read', async () => {
		const before = promReads().length;
		script({ inputs: [DEFAULT_PROMETHEUS_USER, PASSWORD] });
		assert.deepStrictEqual(await setUp(clusterNode(NOPROM)), { kind: 'notStarted' });
		assert.deepStrictEqual(errors, [noPrometheusEndpointMessage('no-prom')]);
		assert.deepStrictEqual(asked, []);
		assert.strictEqual(promReads().length, before);
	});

	test('ESCAPE: at the user or the password step nothing is stored or read, and nothing is said', async () => {
		for (const answers of [[undefined], [DEFAULT_PROMETHEUS_USER, undefined]]) {
			script({ inputs: answers });
			assert.deepStrictEqual(await setUp(), { kind: 'notStarted' });
			assert.strictEqual(asked.length, answers.length);
		}
		assert.strictEqual(promReads().length, 0);
		assert.strictEqual(await stored(), undefined);
		assert.deepStrictEqual([errors, infos], [[], []]);
	});

	test('CLEAR: Forget metrics access on the row deletes the secret; the row loses "· metrics"; the message says so; from the palette, a pick of the clusters with access', async () => {
		await setUpAccess();
		clearMessages();
		assert.deepStrictEqual(await forget(clusterNode(VILNIUS)), { kind: 'forgotten', clusterId: VILNIUS });
		assert.strictEqual(await stored(), undefined);
		assert.deepStrictEqual(infos, [metricsAccessForgottenMessage('rpc-vilnius')]);
		assert.strictEqual(clusterItem('rpc-vilnius').contextValue, 'cloudCluster');
		assert.ok(clusterItem('rpc-vilnius').description.endsWith(` · ${NO_METRICS_ACCESS}`), clusterItem('rpc-vilnius').description);
		// The palette: none left.
		clearMessages();
		assert.deepStrictEqual(await forget(), { kind: 'notStarted' });
		assert.deepStrictEqual(infos, [NO_CLUSTER_WITH_METRICS_ACCESS]);
		// The palette with one: picked.
		await setUpAccess();
		clearMessages();
		script({ clusterPicks: ['rpc-vilnius'] });
		assert.deepStrictEqual(await forget(), { kind: 'forgotten', clusterId: VILNIUS });
		assert.strictEqual(await stored(), undefined);
		assert.deepStrictEqual(infos, [metricsAccessForgottenMessage('rpc-vilnius')]);
		// The log access is untouched by either.
		assert.strictEqual(await cloud().storedValue(logAccessKey(VILNIUS)), undefined);
	});

	test('OTHER_WINDOW: another window stores or clears a cluster\'s metrics access: the row follows', async () => {
		await cloud().storeAsAnotherWindow(metricsAccessKey(BYOC), JSON.stringify({ username: 'prometheus', password: PASSWORD }));
		assert.ok(await waitFor(() => clusterItem('byoc-eu').contextValue === 'cloudCluster metrics', 5_000), clusterItem('byoc-eu').contextValue);
		assert.ok(clusterItem('byoc-eu').description.endsWith(' · metrics'));
		await cloud().storeAsAnotherWindow(metricsAccessKey(BYOC), undefined);
		assert.ok(await waitFor(() => clusterItem('byoc-eu').contextValue === 'cloudCluster', 5_000), clusterItem('byoc-eu').contextValue);
		// Not a valid record: no access.
		await cloud().storeAsAnotherWindow(metricsAccessKey(BYOC), JSON.stringify({ username: 'prometheus' }));
		await new Promise((r) => setTimeout(r, 300));
		assert.strictEqual(clusterItem('byoc-eu').contextValue, 'cloudCluster');
		assert.deepStrictEqual(await cloud().storedMetricsAccess(BYOC), undefined);
	});

	test('DISCONNECT: signed out, the metrics users held clear; the stored record stays and counts at the next connect, with no prompt (the restart\'s acceptance check)', async () => {
		await setUpAccess();
		await cloud().disconnect();
		assert.ok(!items().some((i) => i.node.kind === 'cluster' && i.contextValue.includes('metrics')), 'no row with metrics while signed out');
		// Another window's change while signed out is not followed (it counts at the next connect).
		await cloud().storeAsAnotherWindow(metricsAccessKey(BYOC), JSON.stringify({ username: 'prometheus', password: PASSWORD }));
		await new Promise((r) => setTimeout(r, 300));
		assert.ok(await stored(), 'the stored record stays');
		const before = promReads().length;
		clearMessages();
		await connectAndRead();
		assert.strictEqual(asked.filter((a) => a.title?.includes('metrics')).length, 0, 'no prompt');
		assert.strictEqual(clusterItem('rpc-vilnius').contextValue, 'cloudCluster metrics');
		assert.ok(clusterItem('rpc-vilnius').description.endsWith(' · metrics'));
		assert.strictEqual(clusterItem('byoc-eu').contextValue, 'cloudCluster metrics');
		assert.strictEqual(promReads().length, before, 'nothing read');
	});

	test('BOTH: log and metrics access both set: the row shows both and keeps every cluster-row action', async () => {
		await setUpAccess();
		await cloud().storeAsAnotherWindow(logAccessKey(VILNIUS), JSON.stringify({ username: 'logs-reader', password: 'logs-password-7-4', mechanism: 'SCRAM-SHA-256' }));
		assert.ok(await waitFor(() => clusterItem('rpc-vilnius').contextValue === 'cloudCluster logs metrics', 5_000), clusterItem('rpc-vilnius').contextValue);
		const row = clusterItem('rpc-vilnius');
		assert.ok(row.description.endsWith(' · logs: logs-reader · metrics'), row.description);
		assert.ok(row.tooltip.includes('Its pipeline logs are read as logs-reader') && row.tooltip.includes('Its pipeline metrics are read'), row.tooltip);
		// Forget one, the other stays.
		assert.strictEqual((await forget(clusterNode(VILNIUS)))?.kind, 'forgotten');
		assert.strictEqual(clusterItem('rpc-vilnius').contextValue, 'cloudCluster logs');
		assert.ok(await cloud().storedValue(logAccessKey(VILNIUS)));
	});

	test('SECOND: Set up metrics access while one runs for the cluster is ignored', async () => {
		let release: (v: Input) => void = () => undefined;
		const held = new Promise<Input>((resolve) => { release = resolve; });
		script({ inputs: [() => held, PASSWORD] });
		const first = setUp();
		assert.ok(await waitFor(() => asked.length === 1, 5_000));
		assert.deepStrictEqual(await setUp(), { kind: 'notStarted' }, 'the second, ignored');
		assert.strictEqual(asked.length, 1, 'nothing asked for the second');
		assert.ok(api().outputLines().some((l) => l.includes('Set up metrics access is already running for that cluster')));
		release(DEFAULT_PROMETHEUS_USER);
		assert.strictEqual((await first)?.kind, 'stored', errors.join('\n'));
		assert.strictEqual(promReads().length, 1);
		// Another cluster's runs meanwhile.
		script({ inputs: [undefined] });
		assert.deepStrictEqual(await setUp(clusterNode(BYOC)), { kind: 'notStarted' });
		assert.strictEqual(asked.length, 1, 'asked: not locked by the other cluster');
	});

	test('bug 60: Forget metrics access while a Set up of it runs for the cluster refuses (row and palette); nothing is removed; another cluster\'s Set up does not block it', async () => {
		await setUpAccess();
		let release: (v: Input) => void = () => undefined;
		const held = new Promise<Input>((resolve) => { release = resolve; });
		script({ inputs: [() => held, PASSWORD], clusterPicks: ['rpc-vilnius'] });
		const first = setUp();
		try {
			assert.ok(await waitFor(() => asked.length === 1, 5_000));
			clearMessages();
			assert.deepStrictEqual(await forget(clusterNode(VILNIUS)), { kind: 'notStarted' }, 'the row, refused');
			assert.deepStrictEqual(await forget(), { kind: 'notStarted' }, 'the palette, refused');
			assert.deepStrictEqual(infos, [setUpRunningMessage('metrics access', 'rpc-vilnius'), setUpRunningMessage('metrics access', 'rpc-vilnius')]);
			assert.ok(!infos.includes(metricsAccessForgottenMessage('rpc-vilnius')), 'no removal reported');
			assert.ok(await stored(), 'nothing removed');
		} finally {
			// Always released, so a failure here leaves no Set up running for later tests.
			release(DEFAULT_PROMETHEUS_USER);
		}
		assert.strictEqual((await first)?.kind, 'stored', errors.join('\n'));
		assert.ok(await stored());
		// Once it ends, Forget works again; a Set up of another cluster does not block it.
		let escape: (v: Input) => void = () => undefined;
		const gate = new Promise<Input>((resolve) => { escape = resolve; });
		script({ inputs: [() => gate] });
		const other = setUp(clusterNode(BYOC));
		try {
			assert.ok(await waitFor(() => asked.length === 1, 5_000));
			clearMessages();
			assert.deepStrictEqual(await forget(clusterNode(VILNIUS)), { kind: 'forgotten', clusterId: VILNIUS });
			assert.deepStrictEqual(infos, [metricsAccessForgottenMessage('rpc-vilnius')]);
		} finally {
			escape(undefined);
			assert.deepStrictEqual(await other, { kind: 'notStarted' });
		}
	});

	test('FILTER and GZIP: the Cloud source on the fake\'s endpoint reads the gzip answer and holds only the asked pipeline_id\'s series; # lines kept', async () => {
		await setUpAccess();
		const url = fake.prometheusUrl(VILNIUS);
		const orders = await cloudMetricsSource(url, 'prometheus', PASSWORD, ORDERS).read();
		const last = promReads()[promReads().length - 1];
		assert.match(String(last.headers['accept-encoding']), /\bgzip\b/);
		assert.ok(orders.samples.length > 0);
		assert.ok(orders.samples.every((x) => x.labels.pipeline_id === ORDERS), JSON.stringify(orders.samples));
		assert.ok(!orders.samples.some((x) => x.name === 'redpanda_kafka_partitions'), 'no cluster series');
		assert.strictEqual(orders.samples.find((x) => x.name === 'input_received')?.value, 100);
		assert.strictEqual(orders.types.get('processor_latency_ns'), 'summary');
		assert.strictEqual(orders.types.get('redpanda_kafka_partitions'), 'gauge', '# lines kept');
		const clicks = await cloudMetricsSource(url, 'prometheus', PASSWORD, CLICKS).read();
		assert.strictEqual(clicks.samples.find((x) => x.name === 'input_received')?.value, 200);
		// Not gzip: the same.
		fake.prometheusGzip = false;
		const plain = await cloudMetricsSource(url, 'prometheus', PASSWORD, ORDERS).read();
		assert.deepStrictEqual(plain.samples, orders.samples);
		// Refused through the source too.
		await assert.rejects(cloudMetricsSource(url, 'prometheus', WRONG_PASSWORD, ORDERS).read(), (err: { kind?: string }) => err.kind === 'refused');
	});

	test('NO_LEAK: after an accepted and a refused attempt the password is only in its secret key: no message, prompt, output line, view item, setting, file or other key', async () => {
		script({ inputs: [DEFAULT_PROMETHEUS_USER, WRONG_PASSWORD] });
		assert.strictEqual((await setUp())?.kind, 'failed');
		fake.cluster(VILNIUS).prometheusFailure = 503;
		script({ inputs: [DEFAULT_PROMETHEUS_USER, PASSWORD] });
		assert.strictEqual((await setUp())?.kind, 'failed');
		fake.cluster(VILNIUS).prometheusFailure = undefined;
		await setUpAccess();
		const keys = [CLIENT_ID_KEY, CLIENT_SECRET_KEY, ...[VILNIUS, BYOC, NOPROM].flatMap((id) => [metricsAccessKey(id), logAccessKey(id)]), ...(api().secrets?.recordedKeys() ?? [])];
		for (const key of keys) {
			const value = await cloud().storedValue(key) ?? '';
			assert.strictEqual(value.includes(PASSWORD), key === metricsAccessKey(VILNIUS), `${key}: holds the password only in the metrics access record`);
			assert.ok(!value.includes(WRONG_PASSWORD), key);
		}
		const files = [dir, ...(vscode.workspace.workspaceFolders ?? []).map((f) => path.join(f.uri.fsPath, '.vscode'))].flatMap(filesUnder);
		for (const file of files) {
			const text = fs.readFileSync(file, 'utf8');
			assert.ok(!text.includes(PASSWORD) && !text.includes(WRONG_PASSWORD), `${file} holds a password`);
		}
		items();
		const shown = JSON.stringify({ shown: allShown, output: api().outputLines(), items: seenItems, settings: vscode.workspace.getConfiguration('redpandaConnect') });
		const basic = (p: string) => Buffer.from(`prometheus:${p}`).toString('base64');
		for (const value of [PASSWORD, WRONG_PASSWORD, CLIENT_SECRET, basic(PASSWORD), basic(WRONG_PASSWORD)]) {
			assert.ok(!shown.includes(value), 'a password in a message, the output, the view or a setting');
		}
		// The masks: a password in a text the view shows is masked.
		assert.ok(!cloud().mask(`said ${PASSWORD}`).includes(PASSWORD));
		// The output channel says what happened, so the check above reads real lines.
		assert.ok(api().outputLines().some((l) => l.includes('metrics access to rpc-vilnius set up for prometheus')));
		assert.ok(METRICS_ACCESS_PREFIX.startsWith('redpandaConnect.cloud.'));
	});
});
