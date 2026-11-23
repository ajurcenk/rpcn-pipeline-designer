import * as assert from 'assert';
import * as vscode from 'vscode';
import type { MetricsSource } from '../../../adapters/metrics/source';
import { CLOUD_METRICS_INTERVAL_MS, CLOUD_MIN_GAP_MS, CLOUD_NO_SERIES_HINT, CLOUD_TIMING, cloudMetricsKey, MetricsFeeds, type CloudMetricsBinding, type MetricsUpdate } from '../../../adapters/vscode/metricsFeed';
import type { RunChange } from '../../../adapters/vscode/run';
import { parsePrometheus } from '../../../core/prometheus';
import { connectText, FakeMetricsReadError } from '../../helpers/fakeMetrics';
import { metricsConfigReader } from '../../../extension';

// Ticket 7.3: one feed per file, shared by the tab and the graph; it reads while any subscriber is
// visible, drops its readings when none is, and goes with its last subscriber.
const PORT = 41600;
const URI = vscode.Uri.file('/ws/feed.yaml');
const OTHER = vscode.Uri.file('/ws/other.yaml');
const INTERVAL = 15;
const tick = (ms = INTERVAL * 2) => new Promise((r) => setTimeout(r, ms));

suite('adapters/vscode MetricsFeeds (7.3)', () => {
	let feeds: MetricsFeeds;
	let reads: string[];
	let running: boolean;
	const runChanged = new vscode.EventEmitter<RunChange>();
	/** Story 62: the workspace's renames, the files whose config can't be read, and the log. */
	const renames = new vscode.EventEmitter<{ readonly files: readonly { readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri }[] }>();
	let unreadable: Set<string>;
	let logs: string[];
	const willRename = new vscode.EventEmitter<{ readonly files: readonly { readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri }[] }>();
	let forgotten: string[];

	setup(() => {
		reads = [];
		running = true;
		unreadable = new Set();
		logs = [];
		forgotten = [];
		feeds = new MetricsFeeds({
			log: (line) => logs.push(line),
			run: { portOf: (uri) => (running && uri === URI.toString() ? PORT : undefined), onDidChangeRun: runChanged.event },
			configFor: (uri) => {
				if (unreadable.has(uri.toString())) {
					throw new Error('ENOENT: no such file');
				}
				return { model: { nodes: [], edges: [] }, paths: new Map(), metricsType: undefined };
			},
			intervalMs: INTERVAL,
			onDidRenameFiles: renames.event,
			onWillRenameFiles: willRename.event,
			forgetConfig: (uri) => forgotten.push(uri.toString()),
		});
		let n = 0;
		feeds.setSourceFactory((port) => ({
			address: `127.0.0.1:${port}`,
			read: async () => {
				reads.push(`${port}`);
				n += 100;
				return { ...parsePrometheus(connectText([{ family: 'processor', path: 'root.pipeline.processors.0', received: n, sent: n }])), time: Date.now() };
			},
		}));
	});

	teardown(() => feeds.dispose());

	async function until(check: () => boolean, tries = 200): Promise<void> {
		for (let i = 0; i < tries && !check(); i++) {
			await tick(5);
		}
	}

	test('one reader per file: two subscribers share the feed and its readings', async () => {
		const seen: [MetricsUpdate[], MetricsUpdate[]] = [[], []];
		const tab = feeds.subscribe(URI, (u) => seen[0].push(u), true);
		const graph = feeds.subscribe(URI, (u) => seen[1].push(u), true);
		assert.strictEqual(tab.feed, graph.feed);
		await until(() => reads.length >= 2);
		assert.strictEqual(tab.feed.state.kind, 'live');
		assert.ok(seen[0].length > 0);
		assert.deepStrictEqual(seen[0].map((u) => u.figures), seen[1].map((u) => u.figures), 'the same readings');
		tab.dispose();
		graph.dispose();
	});

	test('WINDOW (7.6): the figures are over the session\'s window (5 min by default); a new window recomputes every subscriber\'s at once, with no read brought forward', async () => {
		// Its own feeds with a longer interval, so the test sees each reading before the next.
		const interval = 100;
		const own = new MetricsFeeds({
			log: () => undefined,
			run: { portOf: (uri) => (uri === URI.toString() ? PORT : undefined), onDidChangeRun: runChanged.event },
			configFor: () => ({ model: { nodes: [], edges: [] }, paths: new Map(), metricsType: undefined }),
			intervalMs: interval,
		});
		// Readings a simulated minute apart: 100/s for two minutes, then 300/s; every read answers.
		const base = 1_000_000;
		const started: number[] = [];
		own.setSourceFactory((port) => ({
			address: `127.0.0.1:${port}`,
			read: async () => {
				const i = started.length;
				started.push(Date.now());
				const n = i <= 2 ? i * 6_000 : 12_000 + (i - 2) * 18_000;
				return { ...parsePrometheus(connectText([{ family: 'processor', path: 'root.pipeline.processors.0', received: n, sent: n }])), time: base + i * 60_000 };
			},
		}));
		const tab: MetricsUpdate[] = [];
		const graph: MetricsUpdate[] = [];
		const a = own.subscribe(URI, (u) => tab.push(u), true);
		const b = own.subscribe(URI, (u) => graph.push(u), true);
		try {
			await until(() => tab.at(-1)?.time === base + 180_000);
			// Synchronous from here until the next read (about `interval` away): the fourth reading's figures.
			assert.strictEqual(started.length, 4, 'the fifth read has not started: none in flight');
			const out = (u: MetricsUpdate | undefined) => [...(u?.figures?.values() ?? [])][0]?.outRate;
			assert.strictEqual(own.windowMinutes, 5);
			assert.strictEqual(out(tab.at(-1)), 30_000 / 180);
			own.setWindowMinutes(1);
			assert.strictEqual(out(tab.at(-1)), 300, 'the tab\'s figures over 1 min, at once');
			assert.strictEqual(out(graph.at(-1)), 300, 'the graph\'s too');
			assert.deepStrictEqual([...tab.at(-1)!.figures!.values()][0].trend, [300]);
			own.setWindowMinutes(15);
			assert.strictEqual(out(tab.at(-1)), 30_000 / 180);
			assert.strictEqual(started.length, 4, 'no read for the window');
			// The next read comes at the interval after the last, not sooner.
			await until(() => started.length >= 5);
			assert.ok(started[4] - started[3] >= interval - 5, `the next read at the interval: ${started[4] - started[3]} ms`);
		} finally {
			a.dispose();
			b.dispose();
			own.dispose();
		}
	});

	test('CLOSED (7.6): the tab closed and the graph hidden drop the window; shown again, the first reading has no rates (nothing from before the hide counts)', async () => {
		const updates: MetricsUpdate[] = [];
		const sub = feeds.subscribe(URI, (u) => updates.push(u), true);
		await until(() => (updates.at(-1)?.figures?.size ?? 0) > 0 && [...updates.at(-1)!.figures!.values()][0].trend.length >= 2);
		assert.ok([...updates.at(-1)!.figures!.values()][0].inRate !== null, 'rates before the hide');
		sub.setVisible(false);
		assert.strictEqual(sub.feed.update.figures, undefined, 'dropped once nothing is visible');
		const shownAt = updates.length;
		sub.setVisible(true);
		await until(() => updates.slice(shownAt).some((u) => u.figures !== undefined));
		const first = updates.slice(shownAt).find((u) => u.figures !== undefined)!;
		const f = [...first.figures!.values()][0];
		assert.deepStrictEqual([f.inRate, f.outRate, f.mean, f.trend], [null, null, null, []], 'the window holds only the new reading');
		sub.dispose();
	});

	test('VISIBILITY: reads while any subscriber is visible; none visible, no read and the figures dropped', async () => {
		const tab = feeds.subscribe(URI, () => undefined, false);
		const graph = feeds.subscribe(URI, () => undefined, false);
		await tick(INTERVAL * 3);
		assert.strictEqual(reads.length, 0, 'nothing visible: no read');
		graph.setVisible(true);
		await until(() => reads.length >= 2);
		assert.ok(graph.feed.update.figures, 'the graph alone reads');
		// The tab shown and hidden again while the graph stays visible: reading goes on.
		tab.setVisible(true);
		tab.setVisible(false);
		const before = reads.length;
		await until(() => reads.length > before);
		assert.ok(reads.length > before, 'still read for the graph');
		assert.ok(graph.feed.update.figures);
		graph.setVisible(false);
		assert.strictEqual(graph.feed.update.figures, undefined, 'dropped once nothing is visible');
		assert.strictEqual(graph.feed.state.kind, 'waiting');
		const hiddenAt = reads.length;
		await tick(INTERVAL * 4);
		assert.strictEqual(reads.length, hiddenAt, 'no read while nothing is visible');
		tab.dispose();
		graph.dispose();
	});

	test('STOP: the run stops, the last figures are kept and marked stopped; the last subscriber releases the feed', async () => {
		const updates: MetricsUpdate[] = [];
		const sub = feeds.subscribe(URI, (u) => updates.push(u), true);
		await until(() => reads.length >= 1);
		running = false;
		runChanged.fire({ uri: URI.toString() } as RunChange);
		assert.strictEqual(updates.at(-1)?.state.kind, 'stopped');
		assert.ok(updates.at(-1)?.figures);
		const stoppedAt = reads.length;
		await tick(INTERVAL * 4);
		assert.strictEqual(reads.length, stoppedAt);
		assert.ok(feeds.feedOf(URI));
		sub.dispose();
		assert.strictEqual(feeds.feedOf(URI), undefined, 'gone with its last subscriber');
	});

	test('files apart: a feed of another file is its own, and another file\'s run change does not reach it', async () => {
		const a = feeds.subscribe(URI, () => undefined, true);
		const b = feeds.subscribe(OTHER, () => undefined, true);
		assert.notStrictEqual(a.feed, b.feed);
		assert.strictEqual(b.feed.state.kind, 'notRunning');
		await until(() => reads.length >= 1);
		runChanged.fire({ uri: OTHER.toString() } as RunChange);
		assert.strictEqual(a.feed.state.kind, 'live');
		a.dispose();
		b.dispose();
	});

	test('story 62 C12 rename: a renamed file keeps its feed under the new name, readings and all; the run started under the old name is followed until it ends', async () => {
		const renamed = vscode.Uri.file('/ws/renamed.yaml');
		const updates: MetricsUpdate[] = [];
		const tab = feeds.subscribe(URI, (u) => updates.push(u), true);
		await until(() => (updates.at(-1)?.figures?.size ?? 0) > 0);
		const feed = tab.feed;
		const figures = feed.update.figures;
		unreadable.add(URI.toString());
		renames.fire({ files: [{ oldUri: URI, newUri: renamed }] });
		assert.strictEqual(feeds.feedOf(renamed), feed, 'the same feed under the new name');
		assert.strictEqual(feeds.feedOf(URI), undefined);
		assert.strictEqual(feed.uri.toString(), renamed.toString());
		assert.strictEqual(feed.update.figures, figures, 'its readings kept');
		// The graph resubscribes under the new name and drops its old hold: the feed stays.
		const graph = feeds.subscribe(renamed, () => undefined, true);
		assert.strictEqual(graph.feed, feed);
		const before = reads.length;
		await until(() => reads.length > before);
		assert.ok(reads.length > before, 'read on');
		assert.strictEqual(feed.state.kind, 'live', 'the old name\'s run is still its run');
		running = false;
		runChanged.fire({ uri: URI.toString(), phase: 'exited', port: undefined });
		assert.strictEqual(feed.state.kind, 'stopped', 'its end reaches the renamed feed');
		assert.ok(!logs.some((l) => l.includes('could not read')), JSON.stringify(logs));
		tab.dispose();
		graph.dispose();
		assert.strictEqual(feeds.feedOf(renamed), undefined, 'gone with its last subscriber');
	});

	test('story 62 C12 pending rename: a config read between the rename on disk and its event is skipped quietly; read again under the new name', () => {
		const renamed = vscode.Uri.file('/ws/renamed.yaml');
		const sub = feeds.subscribe(URI, () => undefined, false);
		willRename.fire({ files: [{ oldUri: URI, newUri: renamed }] });
		unreadable.add(URI.toString());
		assert.strictEqual(feeds.configOf(URI), undefined);
		assert.ok(!logs.some((l) => l.includes('could not read')), JSON.stringify(logs));
		renames.fire({ files: [{ oldUri: URI, newUri: renamed }] });
		assert.ok(feeds.configOf(renamed), 'read under the new name');
		assert.strictEqual(feeds.configOf(URI), undefined, 'the old name no longer pending: read (and said) as before');
		assert.ok(logs.some((l) => l.includes('could not read feed.yaml')), JSON.stringify(logs));
		sub.dispose();
	});

	test('story 62 cache: a file\'s kept config is dropped when its feed is released or the file renamed', () => {
		const renamed = vscode.Uri.file('/ws/renamed.yaml');
		const a = feeds.subscribe(URI, () => undefined, false);
		renames.fire({ files: [{ oldUri: URI, newUri: renamed }] });
		assert.deepStrictEqual(forgotten, [URI.toString()], 'renamed away');
		a.dispose();
		assert.deepStrictEqual(forgotten, [URI.toString(), renamed.toString()], 'released');
	});

	test('story 62 C12 rename: a folder renamed moves the feeds of the files in it', () => {
		const sub = feeds.subscribe(vscode.Uri.file('/ws/dir/a.yaml'), () => undefined, false);
		renames.fire({ files: [{ oldUri: vscode.Uri.file('/ws/dir'), newUri: vscode.Uri.file('/ws/moved') }] });
		assert.strictEqual(sub.feed.uri.toString(), vscode.Uri.file('/ws/moved/a.yaml').toString());
		assert.strictEqual(feeds.feedOf(vscode.Uri.file('/ws/moved/a.yaml')), sub.feed);
		sub.dispose();
	});
});

// Ticket 7.5: a feed bound to a Cloud pipeline: read at its own interval with a 5 s floor (shortened
// here), backoff after failures, refused and no access never read, the access followed; last chosen wins
// between the Cloud and the local run.
suite('adapters/vscode MetricsFeeds, a Cloud pipeline (7.5)', () => {
	const SECRET = 'cloud-feed-secret-Hq2';
	const TIMING = { intervalMs: 40, minGapMs: 20, retryDelaysMs: [30, 60, 90] };
	let feeds: MetricsFeeds;
	let localReads: number;
	let cloudReads: number[];
	let answers: ('ok' | 'refused' | 'unreachable' | 'noSeries' | 'notServed')[];
	let hasAccess: boolean;
	let running: boolean;
	let accessChanged: vscode.EventEmitter<void>;
	const runChanged = new vscode.EventEmitter<RunChange>();
	/** Story 62 (C9): the Cloud view's change, whether it knows the pipeline is gone, and the file's mapping. */
	let cloudChanged: vscode.EventEmitter<void>;
	let gone: boolean;
	let mapped: { readonly clusterId: string; readonly pipelineId: string } | undefined;
	/** Story 62 (C10): when each pipeline was read. */
	let readsBy: Map<string, number[]>;

	/** Ticket 7.5 review: a read held until released (an in-flight read across an access change). */
	let hold: Promise<void> | undefined;

	function binding(file: vscode.Uri | undefined = URI, pipelineId = 'p1'): CloudMetricsBinding {
		let n = 0;
		const source: MetricsSource = {
			address: 'prom.example',
			read: async () => {
				cloudReads.push(Date.now());
				readsBy.set(pipelineId, [...(readsBy.get(pipelineId) ?? []), Date.now()]);
				// Story 62 (the flake): the answer is the one due when the read starts, not when a held read
				// is released (a read started meanwhile would otherwise take it).
				const next = answers.shift() ?? 'ok';
				const held = hold;
				if (held) {
					hold = undefined;
					await held;
				}
				if (next === 'refused') {
					throw new FakeMetricsReadError('refused', `prom.example refused: the user or password is wrong (HTTP 401) ${SECRET}`);
				}
				if (next === 'unreachable') {
					throw new FakeMetricsReadError('unreachable', `prom.example answered HTTP 503 ${SECRET}`);
				}
				if (next === 'noSeries') {
					throw new FakeMetricsReadError('notServed', 'prom.example has no Redpanda Connect component series', true);
				}
				if (next === 'notServed') {
					throw new FakeMetricsReadError('notServed', 'prom.example does not serve Prometheus metrics');
				}
				n += 100;
				return { ...parsePrometheus(connectText([{ family: 'processor', path: 'root.pipeline.processors.0', received: n, sent: n }])), time: Date.now() };
			},
		};
		return {
			clusterId: 'c1', clusterName: 'rpc-vilnius', pipelineId, pipelineName: 'orders', host: 'prom.example', file,
			source: () => (hasAccess ? source : undefined),
			onDidChangeAccess: accessChanged.event,
			mask: (text) => text.split(SECRET).join('•••'),
		};
	}

	setup(() => {
		localReads = 0;
		hold = undefined;
		cloudReads = [];
		answers = [];
		hasAccess = true;
		running = false;
		accessChanged = new vscode.EventEmitter<void>();
		cloudChanged = new vscode.EventEmitter<void>();
		gone = false;
		mapped = undefined;
		readsBy = new Map();
		feeds = new MetricsFeeds({
			log: () => undefined,
			run: { portOf: (uri) => (running && uri === URI.toString() ? PORT : undefined), onDidChangeRun: runChanged.event },
			configFor: () => ({ model: { nodes: [], edges: [] }, paths: new Map(), metricsType: 'none' }),
			intervalMs: INTERVAL,
			onCloudChanged: cloudChanged.event,
			cloudPipelineGone: () => gone,
			mappedPipelineOf: async () => mapped,
		});
		feeds.cloudTiming = TIMING;
		feeds.setSourceFactory(() => ({
			address: 'local',
			read: async () => {
				localReads++;
				return { ...parsePrometheus(connectText([{ family: 'processor', path: 'root.pipeline.processors.0', received: 1, sent: 1 }])), time: Date.now() };
			},
		}));
	});

	teardown(() => {
		feeds.dispose();
		accessChanged.dispose();
		cloudChanged.dispose();
	});

	async function until(check: () => boolean, tries = 200): Promise<void> {
		for (let i = 0; i < tries && !check(); i++) {
			await tick(5);
		}
	}

	test('AD-25 timing: 10 s in production, never sooner than 5 s, unreachable backoff 5, 10, 20, 30, 60 s', () => {
		assert.deepStrictEqual([CLOUD_METRICS_INTERVAL_MS, CLOUD_MIN_GAP_MS], [10_000, 5_000]);
		assert.deepStrictEqual(CLOUD_TIMING.retryDelaysMs, [5_000, 10_000, 20_000, 30_000, 60_000]);
		assert.strictEqual(new MetricsFeeds({ log: () => undefined, run: { portOf: () => undefined, onDidChangeRun: runChanged.event }, configFor: () => { throw new Error('x'); } }).cloudTiming, CLOUD_TIMING);
	});

	test('LIVE / INTERVAL: bound to the Cloud, it reads the pipeline at its interval, one at a time; the update names the source; its config\'s `metrics` section is not checked', async () => {
		const updates: MetricsUpdate[] = [];
		const sub = feeds.subscribe(URI, (u) => updates.push(u), true);
		sub.feed.bindCloud(binding());
		await until(() => cloudReads.length >= 3);
		assert.strictEqual(sub.feed.state.kind, 'live');
		assert.strictEqual(localReads, 0, 'the local run is not read');
		const last = updates.at(-1)!;
		assert.deepStrictEqual([last.source.kind, last.intervalMs, last.port], ['cloud', TIMING.intervalMs, undefined]);
		assert.strictEqual(last.source.kind === 'cloud' && last.source.pipelineName, 'orders');
		const gaps = cloudReads.slice(1).map((t, i) => t - cloudReads[i]);
		assert.ok(gaps.every((g) => g >= TIMING.intervalMs - 5), JSON.stringify(gaps));
		sub.dispose();
	});

	test('HIDDEN / FLOOR: nothing visible, no read and the readings dropped; shown again within the floor, the read waits for it', async () => {
		const sub = feeds.subscribe(URI, () => undefined, true);
		sub.feed.bindCloud(binding());
		await until(() => cloudReads.length >= 1);
		sub.setVisible(false);
		assert.strictEqual(sub.feed.update.figures, undefined);
		assert.strictEqual(sub.feed.state.kind, 'waiting');
		const at = cloudReads.length;
		await tick(TIMING.intervalMs * 2);
		assert.strictEqual(cloudReads.length, at, 'no read while hidden');
		const before = cloudReads.at(-1)!;
		sub.setVisible(true);
		sub.setVisible(false);
		sub.setVisible(true);
		await until(() => cloudReads.length > at);
		assert.ok(cloudReads[at] - before >= TIMING.minGapMs - 2, `${cloudReads[at] - before}`);
		sub.dispose();
	});

	test('REFUSED: a 401 is its own state, masked, and is not read again; access set again, or Show metrics again, reads', async () => {
		answers = ['refused'];
		const sub = feeds.subscribe(URI, () => undefined, true);
		const b = binding();
		sub.feed.bindCloud(b);
		await until(() => sub.feed.state.kind === 'refused');
		const state = sub.feed.state;
		assert.deepStrictEqual(state.kind === 'refused' && [state.cluster, state.message.includes(SECRET), state.message.includes('the user or password is wrong')], ['rpc-vilnius', false, true]);
		await tick(TIMING.intervalMs * 3);
		assert.strictEqual(cloudReads.length, 1, 'not retried');
		accessChanged.fire();
		await until(() => sub.feed.state.kind === 'live');
		assert.strictEqual(sub.feed.state.kind, 'live');
		// Refused again; Show metrics again (a new binding) reads.
		answers = ['refused'];
		await until(() => sub.feed.state.kind === 'refused');
		const n = cloudReads.length;
		sub.feed.bindCloud(binding());
		await until(() => cloudReads.length > n);
		assert.ok(cloudReads.length > n);
		sub.dispose();
	});

	test('NO_ACCESS / SET LATER / FORGOTTEN: no access, nothing read; set, it reads; forgotten, it stops and says so', async () => {
		hasAccess = false;
		const sub = feeds.subscribe(URI, () => undefined, true);
		sub.feed.bindCloud(binding());
		assert.deepStrictEqual(sub.feed.state, { kind: 'noAccess', cluster: 'rpc-vilnius' });
		await tick(TIMING.intervalMs * 2);
		assert.strictEqual(cloudReads.length, 0);
		hasAccess = true;
		accessChanged.fire();
		await until(() => sub.feed.state.kind === 'live');
		assert.ok(cloudReads.length >= 1);
		hasAccess = false;
		accessChanged.fire();
		assert.deepStrictEqual(sub.feed.state, { kind: 'noAccess', cluster: 'rpc-vilnius' });
		assert.strictEqual(sub.feed.update.figures, undefined);
		const at = cloudReads.length;
		await tick(TIMING.intervalMs * 2);
		assert.strictEqual(cloudReads.length, at, 'reading stopped');
		sub.dispose();
	});

	test('UNREACHABLE: quiet until 3 failures, then said (masked); retried after the backoff, the last delay repeated', async () => {
		answers = ['unreachable', 'unreachable', 'unreachable', 'unreachable', 'unreachable'];
		const sub = feeds.subscribe(URI, () => undefined, true);
		sub.feed.bindCloud(binding());
		await until(() => cloudReads.length >= 2);
		assert.strictEqual(sub.feed.state.kind as string, 'waiting', 'quiet');
		await until(() => cloudReads.length >= 5, 400);
		const state = sub.feed.state;
		assert.ok(state.kind === 'unreachable' && !state.message.includes(SECRET), JSON.stringify(state));
		const gaps = cloudReads.slice(1).map((t, i) => t - cloudReads[i]);
		const expected = [30, 60, 90, 90];
		gaps.forEach((g, i) => assert.ok(g >= expected[i] - 5, `gap ${i}: ${g} < ${expected[i]} (${JSON.stringify(gaps)})`));
		await until(() => sub.feed.state.kind === 'live', 400);
		assert.strictEqual(sub.feed.state.kind, 'live');
		sub.dispose();
	});

	test('LAST CHOSEN WINS: bindLocal reads the local run again; a local run of the file starting takes it back from the Cloud', async () => {
		running = true;
		const sub = feeds.subscribe(URI, () => undefined, true);
		sub.feed.bindCloud(binding());
		await until(() => cloudReads.length >= 1);
		sub.feed.bindLocal();
		assert.strictEqual(sub.feed.update.source.kind as string, 'local');
		// The local config says `metrics: none` here: the local branch's own rules apply again.
		assert.strictEqual(sub.feed.state.kind as string, 'notServed');
		sub.feed.bindCloud(binding());
		await until(() => sub.feed.state.kind === 'live');
		runChanged.fire({ uri: URI.toString(), phase: 'stopping', port: PORT });
		assert.strictEqual(sub.feed.update.source.kind as string, 'cloud', 'a run stopping does not');
		runChanged.fire({ uri: URI.toString(), phase: 'running', port: PORT });
		assert.strictEqual(sub.feed.update.source.kind as string, 'local');
		const at = cloudReads.length;
		await tick(TIMING.intervalMs * 2);
		assert.strictEqual(cloudReads.length, at, 'the Cloud is no longer read');
		sub.dispose();
	});

	test('LAST CHOSEN WINS (no port): a local run of the file starting without a metrics port takes it back too', async () => {
		running = false;
		const sub = feeds.subscribe(URI, () => undefined, true);
		sub.feed.bindCloud(binding());
		await until(() => sub.feed.state.kind === 'live');
		runChanged.fire({ uri: URI.toString(), phase: 'running', port: undefined });
		assert.strictEqual(sub.feed.update.source.kind as string, 'local');
		sub.dispose();
	});

	test('FLOOR per cluster: two feeds of one cluster, and a re-Show, never read sooner than the floor apart', async () => {
		const slow = { intervalMs: 20, minGapMs: 60, retryDelaysMs: [20] };
		feeds.cloudTiming = slow;
		const a = feeds.subscribe(URI, () => undefined, true);
		const b = feeds.subscribe(cloudMetricsKey('c1', 'p2'), () => undefined, true);
		a.feed.bindCloud(binding(URI, 'p1'));
		b.feed.bindCloud(binding(undefined, 'p2'));
		// Re-Show on A at once: still waits for the cluster's floor.
		a.feed.bindCloud(binding(URI, 'p1'));
		await until(() => cloudReads.length >= 5, 400);
		const sorted = [...cloudReads].sort((x, y) => x - y);
		const gaps = sorted.slice(1).map((t, i) => t - sorted[i]);
		assert.ok(gaps.every((g) => g >= slow.minGapMs - 3), JSON.stringify(gaps));
		a.dispose();
		b.dispose();
	});

	test('ACCESS REPLACED: a read in flight with the old access is dropped (its late 401 ignored) and the feed reads again', async () => {
		const sub = feeds.subscribe(URI, () => undefined, true);
		sub.feed.bindCloud(binding());
		await until(() => sub.feed.state.kind === 'live');
		let release: () => void = () => undefined;
		hold = new Promise<void>((r) => { release = r; });
		answers = ['refused', 'ok'];
		await until(() => hold === undefined, 400);
		const inFlightAt = cloudReads.length;
		accessChanged.fire();
		release();
		await until(() => cloudReads.length > inFlightAt, 400);
		await until(() => sub.feed.state.kind === 'live');
		await tick(10);
		assert.strictEqual(sub.feed.state.kind, 'live', 'not stuck in refused');
		sub.dispose();
	});

	test('bug 59, ACCESS REPLACED after no series: the state starts over and the next read with the new access goes live', async () => {
		answers = ['noSeries', 'noSeries', 'noSeries', 'noSeries', 'noSeries'];
		const sub = feeds.subscribe(URI, () => undefined, true);
		sub.feed.bindCloud(binding());
		await until(() => sub.feed.state.kind === 'notServed', 400);
		const reads = cloudReads.length;
		accessChanged.fire();
		assert.strictEqual(sub.feed.state.kind, 'waiting', 'not the old access\'s not-served state');
		await until(() => sub.feed.state.kind === 'live', 400);
		assert.strictEqual(cloudReads.length, reads + 1, 'read once with the new access');
		sub.dispose();
	});

	test('bug 59, ACCESS REPLACED after a not-served answer: the feed reads again and goes live', async () => {
		answers = ['notServed'];
		const sub = feeds.subscribe(URI, () => undefined, true);
		sub.feed.bindCloud(binding());
		await until(() => sub.feed.state.kind === 'notServed', 400);
		const state = sub.feed.state;
		assert.ok(state.kind === 'notServed' && state.cause === 'answer', JSON.stringify(state));
		accessChanged.fire();
		assert.strictEqual(sub.feed.state.kind, 'waiting');
		await until(() => sub.feed.state.kind === 'live', 400);
		sub.dispose();
	});

	test('bug 59, ACCESS REPLACED mid-count: the no-series count starts over with the new access', async () => {
		answers = ['noSeries', 'noSeries', 'noSeries', 'noSeries'];
		const sub = feeds.subscribe(URI, () => undefined, true);
		sub.feed.bindCloud(binding());
		await until(() => cloudReads.length === 4, 400);
		// One more no-series answer: the fifth in a row with the old count, the first with the new access.
		// Set before the change: the feed may read with the new access at once.
		answers = ['noSeries', 'ok'];
		accessChanged.fire();
		await until(() => cloudReads.length === 5, 400);
		await tick(5);
		assert.notStrictEqual(sub.feed.state.kind, 'notServed', 'the count was not carried over');
		await until(() => sub.feed.state.kind === 'live', 400);
		sub.dispose();
	});

	test('bug 59, ACCESS REPLACED after live then no series: the old access\'s readings are dropped, waiting until a read with the new one', async () => {
		answers = ['ok', 'noSeries', 'noSeries', 'noSeries', 'noSeries', 'noSeries'];
		const sub = feeds.subscribe(URI, () => undefined, true);
		sub.feed.bindCloud(binding());
		await until(() => sub.feed.state.kind === 'notServed', 1_000);
		let release: () => void = () => undefined;
		hold = new Promise<void>((r) => { release = r; });
		answers = ['ok'];
		accessChanged.fire();
		assert.strictEqual(sub.feed.state.kind, 'waiting', 'not live on the old access\'s figures');
		assert.strictEqual(sub.feed.update.figures?.size ?? 0, 0, 'no figures before a read with the new access');
		await until(() => hold === undefined, 400);
		assert.strictEqual(sub.feed.state.kind, 'waiting', 'still waiting while the first read is in flight');
		release();
		await until(() => sub.feed.state.kind === 'live', 400);
		sub.dispose();
	});

	test('bug 59, ACCESS REMOVED then set after not served: no access, then a fresh read', async () => {
		answers = ['noSeries', 'noSeries', 'noSeries', 'noSeries', 'noSeries'];
		const sub = feeds.subscribe(URI, () => undefined, true);
		sub.feed.bindCloud(binding());
		await until(() => sub.feed.state.kind === 'notServed', 400);
		hasAccess = false;
		accessChanged.fire();
		assert.strictEqual(sub.feed.state.kind, 'noAccess');
		hasAccess = true;
		accessChanged.fire();
		assert.strictEqual(sub.feed.state.kind, 'waiting');
		await until(() => sub.feed.state.kind === 'live', 400);
		sub.dispose();
	});

	test('NOT MAPPED: a pipeline with no file has a feed of its own (synthetic key, no config read)', async () => {
		const key = cloudMetricsKey('c1', 'p1');
		const sub = feeds.subscribe(key, () => undefined, true);
		sub.feed.bindCloud(binding(undefined));
		await until(() => sub.feed.state.kind === 'live');
		assert.strictEqual(feeds.configOf(key), undefined);
		assert.notStrictEqual(feeds.feedOf(key), feeds.feedOf(URI));
		sub.dispose();
	});

	test('ticket 8, RETRY NOW: unreachable, the update says when the next retry is; Retry now reads at once, within the floor', async () => {
		feeds.cloudTiming = { intervalMs: 40, minGapMs: 20, retryDelaysMs: [25, 25, 5_000] };
		answers = ['unreachable', 'unreachable', 'unreachable', 'unreachable'];
		const updates: MetricsUpdate[] = [];
		const sub = feeds.subscribe(URI, (u) => updates.push(u), true);
		sub.feed.bindCloud(binding());
		await until(() => sub.feed.state.kind === 'unreachable', 400);
		assert.strictEqual(cloudReads.length, 3);
		const next = updates.at(-1)!.nextReadAt;
		assert.ok(next !== undefined && next - Date.now() > 4_000, `the next retry in about 5 s: ${next === undefined ? 'none' : next - Date.now()}`);
		sub.feed.retryNow();
		await until(() => cloudReads.length >= 4);
		assert.strictEqual(cloudReads.length, 4, 'read at once');
		assert.ok(cloudReads[3] - cloudReads[2] >= 20 - 2, `within the floor: ${cloudReads[3] - cloudReads[2]} ms`);
		sub.dispose();
	});

	test('ticket 8, READ AGAIN: no series (its cause), not read on; Read again starts a fresh cycle and reads', async () => {
		answers = ['noSeries', 'noSeries', 'noSeries', 'noSeries', 'noSeries'];
		const sub = feeds.subscribe(URI, () => undefined, true);
		sub.feed.bindCloud(binding());
		await until(() => sub.feed.state.kind === 'notServed', 400);
		const state = sub.feed.state;
		assert.ok(state.kind === 'notServed' && state.cause === 'noSeries' && state.reason.endsWith(CLOUD_NO_SERIES_HINT), JSON.stringify(state));
		await tick(TIMING.intervalMs * 2);
		assert.strictEqual(cloudReads.length, 5, 'not read on');
		sub.feed.readAgain();
		assert.strictEqual(sub.feed.state.kind, 'waiting');
		await until(() => sub.feed.state.kind === 'live', 400);
		assert.strictEqual(cloudReads.length, 6);
		sub.dispose();
	});
	test('story 62 C12 rebind: the run\'s own restart on a new port keeps the Cloud binding; a run the user starts takes it back', async () => {
		const sub = feeds.subscribe(URI, () => undefined, true);
		sub.feed.bindCloud(binding());
		await until(() => sub.feed.state.kind === 'live');
		runChanged.fire({ uri: URI.toString(), phase: 'running', port: PORT + 1, rebind: true });
		assert.strictEqual(sub.feed.update.source.kind, 'cloud', 'a rebind is no run the user chose');
		assert.strictEqual(sub.feed.state.kind, 'live');
		const at = cloudReads.length;
		await until(() => cloudReads.length > at);
		assert.ok(cloudReads.length > at, 'the Cloud is still read');
		runChanged.fire({ uri: URI.toString(), phase: 'running', port: PORT });
		assert.strictEqual(sub.feed.update.source.kind as string, 'local');
		sub.dispose();
	});

	test('story 62 C9 remapped: after a Cloud change, a Cloud-bound file whose mapping names another pipeline, or whose pipeline is gone, goes back to local', async () => {
		// The graph alone shows it (the tab closed): nothing else would ever unbind it.
		const graph = feeds.subscribe(URI, () => undefined, true);
		graph.feed.bindCloud(binding());
		await until(() => graph.feed.state.kind === 'live');
		// The same pipeline mapped, or no mapping (the file found by its tag): it stays.
		mapped = { clusterId: 'c1', pipelineId: 'p1' };
		cloudChanged.fire();
		await tick(10);
		mapped = undefined;
		cloudChanged.fire();
		await tick(10);
		assert.strictEqual(graph.feed.update.source.kind, 'cloud');
		mapped = { clusterId: 'c1', pipelineId: 'p9' };
		cloudChanged.fire();
		await until(() => graph.feed.update.source.kind === 'local');
		assert.strictEqual(graph.feed.update.source.kind as string, 'local', 'remapped: back to local');
		const at = cloudReads.length;
		await tick(TIMING.intervalMs * 2);
		assert.strictEqual(cloudReads.length, at, 'the old pipeline is no longer read');
		// Bound again, then the pipeline leaves the Cloud view.
		mapped = undefined;
		graph.feed.bindCloud(binding());
		await until(() => graph.feed.state.kind === 'live');
		gone = true;
		cloudChanged.fire();
		assert.strictEqual(graph.feed.update.source.kind as string, 'local', 'gone: back to local');
		const goneAt = cloudReads.length;
		await tick(TIMING.intervalMs * 2);
		assert.strictEqual(cloudReads.length, goneAt);
		graph.dispose();
	});

	test('story 62 C9 mapped at bind: a file whose mapping already named another pipeline when Show metrics bound this one keeps it on a Cloud change; a later change of the mapping takes it back to local', async () => {
		mapped = { clusterId: 'c1', pipelineId: 'p2' };
		const graph = feeds.subscribe(URI, () => undefined, true);
		graph.feed.bindCloud(binding(URI, 'p1'));
		await until(() => graph.feed.state.kind === 'live');
		cloudChanged.fire();
		await tick(20);
		assert.strictEqual(graph.feed.update.source.kind, 'cloud', 'the user\'s choice stays');
		mapped = { clusterId: 'c1', pipelineId: 'p3' };
		cloudChanged.fire();
		await until(() => graph.feed.update.source.kind === 'local');
		assert.strictEqual(graph.feed.update.source.kind as string, 'local', 'the mapping changed since: back to local');
		graph.dispose();
	});

	test('story 62 C9 sign-out: Cloud-bound, then signed out (no access, the view can\'t tell the pipeline is gone): no access, no reads, still the Cloud', async () => {
		const sub = feeds.subscribe(URI, () => undefined, true);
		sub.feed.bindCloud(binding());
		await until(() => sub.feed.state.kind === 'live');
		hasAccess = false;
		accessChanged.fire();
		cloudChanged.fire();
		await tick(10);
		assert.deepStrictEqual(sub.feed.state, { kind: 'noAccess', cluster: 'rpc-vilnius' });
		assert.strictEqual(sub.feed.update.source.kind, 'cloud');
		const at = cloudReads.length;
		await tick(TIMING.intervalMs * 2);
		assert.strictEqual(cloudReads.length, at, 'no reads');
		sub.dispose();
	});

	test('story 62 flake: a held read takes its answer when it starts, so the read the access change starts never takes the held read\'s refusal', async () => {
		// No floor: the access change's read starts at once, while the held one is still in flight.
		feeds.cloudTiming = { intervalMs: 40, minGapMs: 0, retryDelaysMs: [30] };
		const sub = feeds.subscribe(URI, () => undefined, true);
		sub.feed.bindCloud(binding());
		await until(() => sub.feed.state.kind === 'live');
		let release: () => void = () => undefined;
		hold = new Promise<void>((r) => { release = r; });
		answers = ['refused', 'ok'];
		await until(() => hold === undefined, 400);
		const inFlightAt = cloudReads.length;
		accessChanged.fire();
		assert.strictEqual(cloudReads.length, inFlightAt + 1, 'the access change\'s read started before the held one ended');
		await until(() => sub.feed.state.kind === 'live', 400);
		release();
		await tick(10);
		assert.strictEqual(sub.feed.state.kind, 'live', 'not refused');
		sub.dispose();
	});

	test('story 62 C10: three feeds of one cluster share its floor, so each reads less often than its interval (the gap a shared per-cluster read would close)', async () => {
		feeds.cloudTiming = { intervalMs: 40, minGapMs: 30, retryDelaysMs: [30] };
		const subs = [URI, cloudMetricsKey('c1', 'p2'), cloudMetricsKey('c1', 'p3')].map((key) => feeds.subscribe(key, () => undefined, true));
		subs.forEach((sub, i) => sub.feed.bindCloud(binding(i === 0 ? URI : undefined, `p${i + 1}`)));
		await until(() => ['p1', 'p2', 'p3'].every((p) => (readsBy.get(p)?.length ?? 0) >= 4), 1_000);
		const meanGap = (p: string) => {
			const t = readsBy.get(p) ?? [];
			return (t.at(-1)! - t[0]) / (t.length - 1);
		};
		// One read per cluster per floor: three feeds take turns, about 3 × 30 ms apart each on average (the
		// turns are not strictly in order), so each reads less often than its 40 ms interval.
		const gaps = ['p1', 'p2', 'p3'].map(meanGap);
		assert.ok(gaps.every((g) => g >= 40 + 10), JSON.stringify(gaps));
		assert.ok(gaps.reduce((a, g) => a + g, 0) / 3 >= 3 * 30 - 15, JSON.stringify(gaps));
		const all = [...cloudReads].sort((x, y) => x - y);
		assert.ok(all.slice(1).every((t, i) => t - all[i] >= 30 - 3), 'the floor held across the feeds');
		subs.forEach((sub) => sub.dispose());
	});
});

// Story 62 (C12): the config the metrics map their readings onto is read and parsed once per change, not per reading.
suite('extension metricsConfigReader (story 62)', () => {
	const YAML = ['input:', '  generate:', '    mapping: root = "tick"', 'pipeline:', '  processors:', '    - label: fast', '      mapping: root = this', 'output:', '  drop: {}', 'metrics:', '  prometheus: {}', ''].join('\n');

	function reader(docs: vscode.TextDocument[] = []) {
		const reads: string[] = [];
		const disk = { text: YAML, mtimeMs: 1_000, size: YAML.length };
		const read = metricsConfigReader({
			documents: () => docs,
			readFile: (fsPath) => {
				reads.push(fsPath);
				return disk.text;
			},
			stat: () => ({ mtimeMs: disk.mtimeMs, size: disk.size }),
			schema: () => undefined,
		});
		return { read, reads, disk };
	}

	test('story 62 C12 re-parse: N readings of an unchanged closed file read and parse it once; a change on disk reads it again', () => {
		const { read, reads, disk } = reader();
		const first = read(URI);
		for (let i = 0; i < 20; i++) {
			assert.strictEqual(read(URI), first, 'the same config, not parsed again');
		}
		assert.deepStrictEqual(reads, [URI.fsPath], 'read once');
		assert.strictEqual(first.metricsType, 'prometheus');
		disk.text = YAML.replace('prometheus: {}', 'none: {}');
		disk.mtimeMs = 2_000;
		const second = read(URI);
		assert.notStrictEqual(second, first);
		assert.strictEqual(second.metricsType, 'none');
		assert.strictEqual(reads.length, 2, 'read again after the change');
		assert.strictEqual(read(URI), second);
		assert.strictEqual(reads.length, 2);
	});

	test('story 62 C12 re-parse: an open document is parsed again only when its version changes', () => {
		let version = 1;
		let text = YAML;
		const doc = { uri: URI, get version() { return version; }, getText: () => text } as unknown as vscode.TextDocument;
		const { read, reads } = reader([doc]);
		const first = read(URI);
		assert.strictEqual(read(URI), first);
		assert.strictEqual(read(URI), first);
		assert.strictEqual(reads.length, 1, 'the saved file read once (its `metrics` type)');
		version = 2;
		text = YAML.replace('label: fast', 'label: faster');
		const second = read(URI);
		assert.notStrictEqual(second, first, 'parsed again');
		assert.strictEqual(reads.length, 2);
		assert.strictEqual(read(URI), second);
	});

	test('story 62 cache: `forget` drops a file\'s entry; the next reading reads it again', () => {
		const { read, reads } = reader();
		read(URI);
		read.forget(URI);
		read(URI);
		assert.strictEqual(reads.length, 2);
	});

	test('story 62 C12 re-parse: a file that can\'t be read still throws (the feed logs it)', () => {
		const read = metricsConfigReader({
			documents: () => [],
			readFile: () => { throw new Error('ENOENT'); },
			stat: () => { throw new Error('ENOENT'); },
			schema: () => undefined,
		});
		assert.throws(() => read(URI), /ENOENT/);
	});
});
