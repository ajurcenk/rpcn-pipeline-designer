import * as assert from 'assert';
import * as vscode from 'vscode';
import { MetricsFeeds, type MetricsUpdate } from '../../../adapters/vscode/metricsFeed';
import type { RunChange } from '../../../adapters/vscode/run';
import { parsePrometheus } from '../../../core/prometheus';
import { connectText } from '../../helpers/fakeMetrics';

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

	setup(() => {
		reads = [];
		running = true;
		feeds = new MetricsFeeds({
			log: () => undefined,
			run: { portOf: (uri) => (running && uri === URI.toString() ? PORT : undefined), onDidChangeRun: runChanged.event },
			configFor: () => ({ model: { nodes: [], edges: [] }, paths: new Map(), metricsType: undefined }),
			intervalMs: INTERVAL,
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

	async function until(check: () => boolean): Promise<void> {
		for (let i = 0; i < 200 && !check(); i++) {
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
});
