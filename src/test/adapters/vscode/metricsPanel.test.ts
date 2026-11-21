import * as assert from 'assert';
import * as vscode from 'vscode';
import { MetricsFeeds } from '../../../adapters/vscode/metricsFeed';
import {
	METRICS_PICK_TITLE, MetricsPanel, NO_CONFIG_MESSAGE, NO_SERIES_READS, QUIET_FAILURES, type LoadedCloudPipeline, type MappedPipelineOf, type MetricsPickItem,
} from '../../../adapters/vscode/metricsPanel';
import { SHOW_CLOUD_METRICS_COMMAND } from '../../../adapters/vscode/cloudMetrics';
import { RUN_COMMAND } from '../../../adapters/vscode/run';
import type { RunChange } from '../../../adapters/vscode/run';
import { parsePrometheus } from '../../../core/prometheus';
import { connectText, FakeMetricsReadError } from '../../helpers/fakeMetrics';

// Ticket 7.2: the Pipeline Metrics tab's host against a fake view, run and source: failures and
// answers with no series counted apart, in a row; hiding the tab drops its readings.
// Ticket 8: the state buttons carried out on the binding, a button the state does not show ignored.
// Ticket 9: the resolver (run → mapping → the file; no active config: a pick), the bind on the tab's own
// opening, and the run the tab reads for the status bar.
const PORT = 41500;
const URI = vscode.Uri.file('/ws/m.yaml');
const OTHER = vscode.Uri.file('/ws/m2.yaml');
const INTERVAL = 15;
const tick = (ms = INTERVAL * 2) => new Promise((r) => setTimeout(r, ms));

const text = (n: number) => connectText([{ family: 'processor', path: 'root.pipeline.processors.0', received: n, sent: n }]);

function fakeView() {
	const visibility = new vscode.EventEmitter<void>();
	const disposed = new vscode.EventEmitter<void>();
	const received = new vscode.EventEmitter<unknown>();
	const view = {
		visible: true,
		description: undefined as string | undefined,
		webview: {
			options: {}, html: '', cspSource: 'test',
			asWebviewUri: (u: vscode.Uri) => u,
			onDidReceiveMessage: received.event,
			postMessage: async () => true,
		},
		onDidChangeVisibility: visibility.event,
		onDidDispose: disposed.event,
	};
	return { view, setVisible: (v: boolean) => { view.visible = v; visibility.fire(); } };
}

suite('adapters/vscode MetricsPanel', () => {
	let reads: number;
	let panel: MetricsPanel;
	let feeds: MetricsFeeds;
	let script: ('ok' | 'unreachable' | 'noSeries')[];
	let view: ReturnType<typeof fakeView>;
	const runChanged = new vscode.EventEmitter<RunChange>();
	let running: boolean;
	let commands: [string, ...unknown[]][];
	let outputs: number;
	let mapping: MappedPipelineOf | undefined;
	let runs: vscode.Uri[];
	let activeFile: vscode.Uri | undefined;
	let configs: Set<string> | undefined;
	let loaded: LoadedCloudPipeline[];
	let infos: string[];

	setup(async () => {
		reads = 0;
		script = [];
		running = true;
		commands = [];
		outputs = 0;
		mapping = undefined;
		runs = [];
		activeFile = undefined;
		configs = undefined;
		loaded = [];
		infos = [];
		feeds = new MetricsFeeds({
			log: () => undefined,
			run: { portOf: () => (running ? PORT : undefined), onDidChangeRun: runChanged.event },
			configFor: () => ({ model: { nodes: [], edges: [] }, paths: new Map(), metricsType: undefined }),
			intervalMs: INTERVAL,
		});
		panel = new MetricsPanel({
			extensionUri: vscode.Uri.file('/ext'),
			log: () => undefined,
			feeds,
			focus: async () => undefined,
			executeCommand: async (command, ...args) => {
				commands.push([command, ...args]);
				return undefined;
			},
			showOutput: () => {
				outputs++;
			},
			mappingOf: async () => mapping,
			runningUris: () => runs,
			activeUri: () => activeFile,
			isConfig: (uri) => !configs || configs.has(uri.toString()),
			cloudPipelines: () => loaded,
			showInformationMessage: (m) => {
				infos.push(m);
			},
		});
		// Each read takes the next scripted answer; once the script is done, the counters' text.
		let n = 0;
		panel.setSourceFactory((port) => ({
			address: `127.0.0.1:${port}`,
			read: async () => {
				reads++;
				const next = script.shift() ?? 'ok';
				if (next === 'unreachable') {
					throw new FakeMetricsReadError('unreachable', `127.0.0.1:${port}: connection refused`);
				}
				if (next === 'noSeries') {
					throw new FakeMetricsReadError('notServed', `127.0.0.1:${port}/metrics has no component series`, true);
				}
				return { ...parsePrometheus(text(n += 100)), time: Date.now() };
			},
		}));
		view = fakeView();
		panel.resolveWebviewView(view.view as unknown as vscode.WebviewView);
	});

	teardown(() => {
		panel.dispose();
		feeds.dispose();
	});

	async function showAndRead(count: number): Promise<void> {
		await panel.show(URI);
		for (let i = 0; i < 100 && reads < count; i++) {
			await tick(5);
		}
		await tick(5);
	}

	test('2 failures then 3 answers with no series: still starting, not "not served"', async () => {
		script = ['unreachable', 'unreachable', 'noSeries', 'noSeries', 'noSeries', 'noSeries', 'noSeries', 'noSeries'];
		await showAndRead(5);
		assert.strictEqual(panel.state.kind, 'waiting', JSON.stringify(panel.state));
		// Five in a row of their own are "not served", and reading stops. Another file's feed starts
		// its readings anew (showing the same file again keeps a feed that is reading, 7.3).
		script = Array<'noSeries'>(NO_SERIES_READS).fill('noSeries');
		const before = reads;
		await panel.show(OTHER);
		for (let i = 0; i < 200 && (panel.state.kind as string) !== 'notServed'; i++) {
			await tick(5);
		}
		assert.strictEqual(panel.state.kind, 'notServed');
		await tick(INTERVAL * 3);
		assert.strictEqual(reads - before, NO_SERIES_READS, 'no read after it');
	});

	test('4 answers with no series then 1 failure: still starting, not unreachable; 3 failures in a row are', async () => {
		// Failures go on after the third, so the state is read before any good answer.
		script = ['noSeries', 'noSeries', 'noSeries', 'noSeries', 'unreachable', ...Array<'unreachable'>(50).fill('unreachable')];
		await showAndRead(5);
		assert.strictEqual(panel.state.kind, 'waiting', JSON.stringify(panel.state));
		for (let i = 0; i < 200 && reads < 4 + QUIET_FAILURES; i++) {
			await tick(5);
		}
		await tick(5);
		assert.strictEqual(panel.state.kind, 'unreachable', JSON.stringify(panel.state));
	});

	test('SHOW_AGAIN (7.3): showing the file again while its feed reads keeps the readings, no restart', async () => {
		await showAndRead(2);
		const rows = panel.rows();
		assert.ok(rows[0]?.inRate !== null, JSON.stringify(rows));
		await panel.show(URI);
		assert.strictEqual(panel.state.kind, 'live');
		assert.deepStrictEqual(panel.rows(), rows, 'the feed\'s current rows, not a restart');
	});

	test('HIDDEN: hiding drops the readings; the first reading after showing again gives no rates', async () => {
		await showAndRead(2);
		assert.ok(panel.rows()[0]?.inRate !== null, JSON.stringify(panel.rows()));
		view.setVisible(false);
		assert.deepStrictEqual(panel.rows(), []);
		assert.strictEqual(panel.state.kind, 'waiting');
		const hiddenAt = reads;
		await tick(INTERVAL * 4);
		assert.strictEqual(reads, hiddenAt, 'no read while hidden');
		const postedAt = panel.posted.length;
		view.setVisible(true);
		for (let i = 0; i < 100 && !panel.posted.slice(postedAt).some((m) => m.rows.length > 0); i++) {
			await tick(2);
		}
		const first = panel.posted.slice(postedAt).find((m) => m.rows.length > 0)!;
		assert.deepStrictEqual(first.rows.map((r) => [r.inRate, r.outRate]), [[null, null]], 'no rate spans the hidden time');
	});

	async function until(check: () => boolean, tries = 200): Promise<void> {
		for (let i = 0; i < tries && !check(); i++) {
			await tick(5);
		}
	}

	test('ticket 8, NOT RUNNING: Run <file> runs the bound file; the mapped pipeline\'s Show runs Show metrics on its ids; a forged button is ignored', async () => {
		running = false;
		mapping = { clusterId: 'c1', pipelineId: 'p1', cluster: 'rpc-vilnius', pipeline: 'orders' };
		await panel.show(URI);
		assert.strictEqual(panel.state.kind, 'notRunning');
		await until(() => panel.posted.at(-1)?.mapped !== null);
		assert.deepStrictEqual(panel.posted.at(-1)?.mapped, { pipeline: 'orders', cluster: 'rpc-vilnius' });
		await panel.receive({ type: 'runRequested', file: '/etc/other.yaml' });
		await panel.receive({ type: 'showMappedRequested', clusterId: 'evil' });
		assert.deepStrictEqual(commands, [[RUN_COMMAND, URI], [SHOW_CLOUD_METRICS_COMMAND, { kind: 'pipeline', clusterId: 'c1', id: 'p1' }]]);
		// Not offered by this state: ignored.
		await panel.receive({ type: 'retryRequested' });
		await panel.receive({ type: 'setUpAccessRequested' });
		await panel.receive({ type: 'readAgainRequested' });
		assert.strictEqual(commands.length, 2);
		assert.deepStrictEqual(panel.actions, ['runRequested', 'showMappedRequested']);
		assert.strictEqual(reads, 0, 'nothing read');
	});

	test('ticket 8, LIVE: no button is offered, every one ignored', async () => {
		await showAndRead(2);
		assert.strictEqual(panel.state.kind, 'live');
		for (const type of ['runRequested', 'showMappedRequested', 'metricsSectionRequested', 'readAgainRequested', 'setUpAccessRequested', 'forgetAccessRequested', 'retryRequested', 'outputRequested']) {
			await panel.receive({ type });
		}
		assert.deepStrictEqual([commands, outputs, panel.actions], [[], 0, []]);
	});

	test('ticket 8, NO SERIES: "No figures yet" (its cause), Read again reads again and the 5-answer count starts over', async () => {
		script = Array<'noSeries'>(NO_SERIES_READS).fill('noSeries');
		await panel.show(URI);
		await until(() => panel.state.kind === 'notServed');
		const state = panel.state;
		assert.ok(state.kind === 'notServed' && state.cause === 'noSeries', JSON.stringify(state));
		await tick(INTERVAL * 3);
		assert.strictEqual(reads, NO_SERIES_READS, 'no read after it');
		script = Array<'noSeries'>(NO_SERIES_READS - 1).fill('noSeries');
		await panel.receive({ type: 'readAgainRequested' });
		assert.strictEqual(panel.state.kind, 'waiting', 'a fresh read cycle');
		// 4 answers with no series and then figures: live (the count started over, or the first would have stopped it).
		await until(() => panel.state.kind === 'live');
		assert.strictEqual(panel.state.kind, 'live');
	});

	test('ticket 8, UNREACHABLE: the show says when the next retry is and when the figures shown were read; Show output shows the channel; Retry now reads at once', async () => {
		await showAndRead(1);
		assert.strictEqual(panel.state.kind, 'live');
		script = Array<'unreachable'>(QUIET_FAILURES).fill('unreachable');
		await until(() => panel.state.kind === 'unreachable');
		const shown = panel.posted.at(-1)!;
		assert.strictEqual(shown.state.kind, 'unreachable');
		assert.ok(typeof shown.retryAt === 'number' && shown.retryAt > Date.now() - INTERVAL && shown.retryAt <= Date.now() + INTERVAL, String(shown.retryAt));
		assert.ok(typeof shown.lastReadingAt === 'number' && shown.rows.length > 0, 'the figures shown, and their time');
		await panel.receive({ type: 'outputRequested' });
		assert.strictEqual(outputs, 1);
		// Retry now: the next read at once (still failing: unreachable again). Taken while the next read is
		// set and none is in flight (only a timer starts one, and none fires before the click below).
		await until(() => panel.state.kind === 'unreachable' && feeds.feedOf(URI)?.update.nextReadAt !== undefined);
		assert.ok(feeds.feedOf(URI)?.update.nextReadAt !== undefined, 'a read is due, none in flight');
		script = ['unreachable'];
		const before = reads;
		const clicked = panel.receive({ type: 'retryRequested' });
		assert.strictEqual(reads, before + 1, 'Retry now read at once');
		await clicked;
		await until(() => panel.state.kind === 'live');
		assert.deepStrictEqual(panel.actions, ['outputRequested', 'retryRequested']);
	});
	suite('ticket 9: the resolver', () => {
		const CLOUD_A: LoadedCloudPipeline = { clusterId: 'c1', clusterName: 'rpc-vilnius', pipelineId: 'p1', pipelineName: 'orders' };

		test('RUNNING_FILE: a running file opens on its local run, its mapping not used', async () => {
			runs = [URI];
			mapping = { clusterId: 'c1', pipelineId: 'p1', cluster: 'rpc-vilnius', pipeline: 'orders' };
			await panel.showFor(URI);
			assert.strictEqual(panel.file, URI.toString());
			assert.deepStrictEqual(commands, []);
		});

		test('MAPPED_NO_RUN: a file not running with its own mapping goes to Show metrics on the mapped pipeline', async () => {
			running = false;
			mapping = { clusterId: 'c1', pipelineId: 'p1', cluster: 'rpc-vilnius', pipeline: 'orders' };
			await panel.showFor(URI);
			assert.deepStrictEqual(commands, [[SHOW_CLOUD_METRICS_COMMAND, { kind: 'pipeline', clusterId: 'c1', id: 'p1' }]]);
			assert.strictEqual(panel.file, undefined, 'the tab is bound by Show metrics, not here');
		});

		test('NEITHER: a file neither running nor mapped opens on itself, Not running', async () => {
			running = false;
			await panel.showFor(URI);
			assert.strictEqual(panel.file, URI.toString());
			assert.strictEqual(panel.state.kind, 'notRunning');
			assert.deepStrictEqual(commands, []);
		});

		test('ACTIVE: with no argument, the active config; an active file that is no config is no active config', async () => {
			runs = [URI];
			activeFile = URI;
			await panel.showFor();
			assert.strictEqual(panel.file, URI.toString());
			activeFile = OTHER;
			configs = new Set([URI.toString()]);
			let picks = 0;
			panel.ui = { pick: async () => { picks++; return undefined; } };
			await panel.showFor();
			assert.strictEqual(picks, 1);
			assert.strictEqual(panel.file, URI.toString(), 'a dismissed pick binds nothing');
		});

		test('NO_EDITOR: a pick of the running files then the loaded Cloud pipelines; each choice opens its source; none: the message', async () => {
			let shown: [string, readonly MetricsPickItem[]][] = [];
			let choose: (items: readonly MetricsPickItem[]) => MetricsPickItem | undefined = (items) => items[1];
			panel.ui = { pick: async (title, items) => { shown.push([title, items]); return choose(items); } };
			runs = [URI, OTHER];
			loaded = [CLOUD_A];
			await panel.showFor();
			assert.deepStrictEqual(shown.map(([title, items]) => [title, items.map((i) => [i.kind, i.label, i.description])]), [[METRICS_PICK_TITLE, [
				['local', 'm.yaml', 'Local run · /ws'], ['local', 'm2.yaml', 'Local run · /ws'], ['cloud', 'orders', 'Cloud · rpc-vilnius'],
			]]]);
			assert.strictEqual(panel.file, OTHER.toString());
			choose = (items) => items[2];
			await panel.showFor();
			assert.deepStrictEqual(commands, [[SHOW_CLOUD_METRICS_COMMAND, { kind: 'pipeline', clusterId: 'c1', id: 'p1' }]]);
			shown = [];
			runs = [];
			loaded = [];
			await panel.showFor();
			assert.deepStrictEqual([shown, infos], [[], [NO_CONFIG_MESSAGE]]);
		});

		const reveal = async () => {
			view.setVisible(false);
			view.setVisible(true);
			await tick();
		};

		test('DIRECT_OPEN: opened with nothing bound: nothing to bind stays unbound (two runs: no pick); the active config\'s run is taken', async () => {
			await reveal();
			assert.strictEqual(panel.file, undefined);
			runs = [URI, OTHER];
			await reveal();
			assert.strictEqual(panel.file, undefined);
			activeFile = URI;
			await reveal();
			assert.strictEqual(panel.file, URI.toString());
			assert.deepStrictEqual(commands, []);
			// Bound: opening again binds nothing else.
			activeFile = OTHER;
			await reveal();
			assert.strictEqual(panel.file, URI.toString());
		});

		test('DIRECT_OPEN: the active config\'s mapping is tried once per config; when it binds nothing, the only running file is taken', async () => {
			activeFile = URI;
			mapping = { clusterId: 'c1', pipelineId: 'p1', cluster: 'rpc-vilnius', pipeline: 'orders' };
			// Show metrics binds nothing (signed out, gone pipeline): no message again on the next reveals.
			await reveal();
			await reveal();
			assert.deepStrictEqual(commands, [[SHOW_CLOUD_METRICS_COMMAND, { kind: 'pipeline', clusterId: 'c1', id: 'p1' }]]);
			assert.strictEqual(panel.file, undefined);
			// Another active config: its own mapping is tried.
			activeFile = OTHER;
			await reveal();
			assert.strictEqual(commands.length, 2);
			// Tried already, and one file running: that run.
			runs = [vscode.Uri.file('/ws/run.yaml')];
			await reveal();
			assert.strictEqual(commands.length, 2);
			assert.strictEqual(panel.file, vscode.Uri.file('/ws/run.yaml').toString());
		});

		test('DIRECT_OPEN: after the mapping step binds nothing, the only running file in the same open', async () => {
			activeFile = URI;
			runs = [OTHER];
			mapping = { clusterId: 'c1', pipelineId: 'p1', cluster: 'rpc-vilnius', pipeline: 'orders' };
			await reveal();
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(panel.file, OTHER.toString());
		});

		test('NOT A FILE: an untitled active document, or a non-file argument, is no config: the pick (none: the message), nothing bound', async () => {
			const untitled = vscode.Uri.parse('untitled:Untitled-1');
			const cloudDoc = vscode.Uri.parse('redpanda-cloud:/c1/p1/orders.yaml');
			let picks = 0;
			panel.ui = { pick: async () => { picks++; return undefined; } };
			activeFile = untitled;
			await panel.showFor();
			await panel.showFor(cloudDoc);
			assert.deepStrictEqual([picks, infos, panel.file], [0, [NO_CONFIG_MESSAGE, NO_CONFIG_MESSAGE], undefined]);
			runs = [URI];
			await panel.showFor(untitled);
			assert.deepStrictEqual([picks, panel.file], [1, undefined]);
		});

		test('DIRECT_OPEN: no active config and one running file: that run', async () => {
			runs = [OTHER];
			view.setVisible(false);
			view.setVisible(true);
			await tick();
			assert.strictEqual(panel.file, OTHER.toString());
			assert.deepStrictEqual(commands, []);
		});

		test('readingRun: the local run the visible, live tab reads, with its output rate; hidden: none', async () => {
			assert.strictEqual(panel.readingRun, undefined);
			await showAndRead(2);
			assert.strictEqual(panel.state.kind, 'live');
			// The fake serves no output series: no output rate (the summary's), so none on the status bar.
			assert.deepStrictEqual(panel.readingRun, { uri: URI.toString(), rate: panel.summary?.outputRate ?? null });
			let changes = 0;
			const sub = panel.onDidChange(() => changes++);
			view.setVisible(false);
			sub.dispose();
			assert.strictEqual(panel.readingRun, undefined);
			assert.ok(changes > 0, 'a change is fired, so the status bar follows');
		});
	});
});
