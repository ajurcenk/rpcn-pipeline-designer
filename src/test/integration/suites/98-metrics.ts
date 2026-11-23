// Pipeline metrics, the tracer (ticket 7.2, AD-25), end to end in the stable run with a fake binary (as
// 60-run.ts) and the in-memory metrics source (`helpers/fakeMetrics.ts`) handed to the tab's seam
// instead of the local `/metrics` read. Show Pipeline Metrics opens the tab in the bottom panel, bound
// to the active config; the tab is read through its test seam (its state, rows, reads). The matrix rows
// covered here: HAPPY (rows within one interval, names the source and its address), NOT_RUNNING (no
// read), HIDDEN (no read while hidden, one at once when shown), STOP / RERUN (last figures kept and
// marked stopped; the rerun's new port read), NOT_SERVED (a `metrics: none` config is not read),
// UNREACHABLE (quiet until 3 failures, then said, and read on). The real binary's case is in 61-run-real.ts.
// Ticket 7.3, the graph's figures through the same feed: LIVE (the graph alone reads; with the tab open
// too, each node's line has its row's numbers), LABELLED / RESOURCE / NESTED (each on its own node, no
// line on the group), HIDDEN (graph hidden and tab closed: no read), REOPENED (the snapshot carries
// the figures), STOP (the lines cleared).
// Ticket 7.6, the live window: WINDOW (the 1 / 5 / 15 min choice recomputes the rows, the trends and the
// footer at once, with no read brought forward; the new columns are filled).
// Ticket 7.7, the bottleneck: in GRAPH FIGURES the sleep (`slow_one`) is marked slowest in the tab and
// on its graph node with the same share, the summary names it, and the nested processor with errors is
// marked with errors in both; the marks clear with the figures on stop.
// Ticket 8 (board 5), the states' buttons through the tab's seam (`receive`, as the webview posts them):
// STOP / RERUN's rerun is the stopped state's Run <file>; NOT_RUNNING's Run starts the run (waiting →
// live); NOT_SERVED's Open the metrics section reveals the `metrics:` key; a 404 and no series are read
// again with Read again; UNREACHABLE says when the next retry is, Retry now reads at once and Show output
// is carried out; a button the state does not show is ignored.
// Ticket 9 (board 5), the entry points: RUNNING_FILE (HAPPY's command on the active running config),
// STATUS_BAR (the running item's menu, Stop / Show pipeline metrics, and its " · N/s" while the tab reads
// the run), GRAPH_BUTTON (the graph's `metricsRequested` opens the tab on its file's run), NEITHER (a file
// neither running nor mapped opens Not running), NO_EDITOR (the pick of the running files; none: the message).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { METRICS_INTERVAL_MS, METRICS_VIEW_ID, SHOW_METRICS_COMMAND } from '../../../adapters/vscode/metricsPanel';
import { RUN_MENU_COMMAND, SHOW_METRICS_ACTION, stopAction } from '../../../adapters/vscode/run';
import { type ExtensionApi } from '../../../extension';
import type { GraphPanelHandle } from '../../../adapters/graphPanel/panels';
import type { NodeFiguresById } from '../../../shared/protocol';
import { connectScript, fixtureBodies, makeTempDir, writeFakeBinary } from '../../helpers/fakeBinary';
import { connectText, FakeMetrics } from '../../helpers/fakeMetrics';
import { EXTENSION_ID, waitFor } from '../helpers';

const CONFIG = [
	'input:',
	'  generate:',
	'    mapping: root = "tick"',
	'pipeline:',
	'  processors:',
	'    - label: fast',
	'      mapping: root = this',
	'    - sleep:',
	'        duration: 5ms',
	'output:',
	'  drop: {}',
	'',
].join('\n');

const text = (n: number) => connectText([
	{ family: 'input', path: 'root.input', received: n },
	{ family: 'processor', path: 'root.pipeline.processors.0', label: 'fast', received: n, sent: n, errors: 0, p50: 7700, p99: 21_000 },
	{ family: 'processor', path: 'root.pipeline.processors.1', received: n, sent: n, errors: 0, p50: 5_170_000, p99: 5_620_000 },
	{ family: 'output', path: 'root.output', sent: n, errors: 0, p50: 87, p99: 4061 },
]);

suite('Pipeline metrics (integration, ticket 7.2)', function () {
	this.timeout(90_000);
	let dir: string;
	let fake: FakeMetrics;
	const originalPath = process.env.PATH;
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const metrics = () => api().metrics!;
	const config = () => vscode.workspace.getConfiguration('redpandaConnect');

	async function open(name: string, body: string): Promise<vscode.TextDocument> {
		const file = path.join(dir, name);
		fs.writeFileSync(file, body);
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);
		assert.ok(await waitFor(() => api().detection.isDetected(doc.uri), 5_000));
		return doc;
	}

	async function runAndWait(doc: vscode.TextDocument): Promise<number> {
		await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
		assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'running' && api().run.portOf(doc.uri) !== undefined, 15_000));
		return api().run.portOf(doc.uri)!;
	}

	async function stop(doc: vscode.TextDocument): Promise<void> {
		await vscode.commands.executeCommand('redpandaConnect.stop', doc.uri);
		assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'exited', 15_000));
	}

	suiteSetup(async () => {
		await vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.activate();
		const fixtures = fixtureBodies('4.112.0'); // the tools' paths, before PATH is narrowed
		process.env.PATH = (originalPath ?? '').split(path.delimiter)
			.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
			.join(path.delimiter);
		dir = makeTempDir('rpcn-metrics-');
		const run = [`trap 'exit 0' INT`, 'echo tick', 'while :; do sleep 0.05; done'].join('\n');
		const bin = writeFakeBinary(dir, 'redpanda-connect', connectScript({ version: '4.112.0', ...fixtures, run }));
		await config().update('binaryPath', bin, vscode.ConfigurationTarget.Global);
		assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'ok'
			&& (api().redpandaConnect.state as { path: string }).path === bin, 30_000));
		assert.ok(await waitFor(() => api().schemaStore.current?.path === bin, 30_000),
			`the schema (for the model) is there: ${api().outputLines().slice(-8).join(' | ')}`);
		assert.ok(api().metrics, 'the test seam is there in test mode');
	});

	setup(() => {
		fake = new FakeMetrics();
		metrics().setSourceFactory(fake.factory);
	});

	// Ticket 7.6: the window is the session's: a failing WINDOW test must not leave 1 or 15 min to later tests.
	teardown(() => metrics().receive({ type: 'window', minutes: 5 }));

	suiteTeardown(async () => {
		metrics().setSourceFactory(undefined);
		await vscode.commands.executeCommand('workbench.action.closePanel');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		vscode.window.terminals.filter((t) => t.name.startsWith('Redpanda Connect: ')).forEach((t) => t.dispose());
		process.env.PATH = originalPath;
		await config().update('binaryPath', undefined, vscode.ConfigurationTarget.Global);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('HAPPY / HIDDEN / STOP / RERUN: the command opens the tab on the running config; rows live; hidden stops reads; a stop keeps the figures; a rerun reads its new port', async () => {
		const doc = await open('metrics.yaml', CONFIG);
		const port = await runAndWait(doc);
		let n = 100;
		fake.serve(port, text(n));
		const started = Date.now();
		await vscode.commands.executeCommand(SHOW_METRICS_COMMAND);
		assert.ok(await waitFor(() => metrics().visible && metrics().rows().length === 4, METRICS_INTERVAL_MS + 3_000),
			`rows within one interval: ${JSON.stringify(metrics().state)} ${metrics().rows().length}`);
		assert.ok(Date.now() - started < METRICS_INTERVAL_MS + 3_000);
		assert.strictEqual(metrics().file, doc.uri.toString());
		assert.strictEqual(metrics().title, 'Local run · metrics.yaml');
		const last = metrics().posted.at(-1)!;
		assert.deepStrictEqual([last.source, last.port, last.intervalMs], ['Local run · metrics.yaml', port, METRICS_INTERVAL_MS]);
		assert.deepStrictEqual(metrics().rows().map((r) => [r.kind, r.name, r.path]), [
			['input', 'generate', 'input'],
			['processor', 'fast', 'pipeline.processors[0]'],
			['processor', 'sleep', 'pipeline.processors[1]'],
			['output', 'drop', 'output'],
		]);
		assert.deepStrictEqual(metrics().rows().map((r) => r.p50), [null, 7700, 5_170_000, 87]);
		// Rates once a second reading came, from the counters' rise.
		n = 300;
		fake.serve(port, text(n));
		assert.ok(await waitFor(() => (metrics().rows()[1]?.inRate ?? 0) > 0, METRICS_INTERVAL_MS * 3), JSON.stringify(metrics().rows()[1]));
		assert.strictEqual(metrics().state.kind, 'live');
		assert.ok(fake.reads.every((r) => r.port === port));
		// Ticket 8, FORGED: live offers no button: a Run is ignored (no second run, nothing changes).
		const actionsBefore = metrics().actions.length;
		await metrics().receive({ type: 'runRequested' });
		await metrics().receive({ type: 'readAgainRequested' });
		assert.strictEqual(metrics().actions.length, actionsBefore, 'ignored');
		assert.strictEqual(api().run.portOf(doc.uri), port, 'the same run');

		// HIDDEN: no read while the tab is hidden; one at once when shown again.
		await vscode.commands.executeCommand('workbench.action.closePanel');
		assert.ok(await waitFor(() => !metrics().visible, 10_000));
		await new Promise((r) => setTimeout(r, 200));
		const hiddenAt = fake.reads.length;
		await new Promise((r) => setTimeout(r, METRICS_INTERVAL_MS * 1.5));
		assert.strictEqual(fake.reads.length, hiddenAt, 'no read while hidden');
		await vscode.commands.executeCommand(`${METRICS_VIEW_ID}.focus`);
		assert.ok(await waitFor(() => metrics().visible && fake.reads.length > hiddenAt, 5_000), 'a read at once on show');

		// STOP: the last figures stay, marked stopped; reading stops.
		await stop(doc);
		assert.ok(await waitFor(() => metrics().state.kind === 'stopped', 5_000), JSON.stringify(metrics().state));
		assert.strictEqual(metrics().rows().length, 4, 'the figures are kept');
		const stoppedAt = fake.reads.length;
		await new Promise((r) => setTimeout(r, METRICS_INTERVAL_MS * 1.5));
		assert.strictEqual(fake.reads.length, stoppedAt, 'no read after the stop');

		// RERUN (ticket 8: the stopped state's Run <file>): the new port is read.
		assert.ok(metrics().posted.at(-1)!.rows.length > 0, 'the figures stay under the panel');
		await metrics().receive({ type: 'runRequested' });
		assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'running' && api().run.portOf(doc.uri) !== undefined, 15_000));
		const again = api().run.portOf(doc.uri)!;
		fake.serve(again, text(10));
		// Run shows its terminal, which takes the bottom panel; the tab reads again once it is shown.
		await vscode.commands.executeCommand(`${METRICS_VIEW_ID}.focus`);
		assert.ok(await waitFor(() => metrics().state.kind === 'live' && fake.readsOf(again).length > 0, METRICS_INTERVAL_MS + 3_000), JSON.stringify(metrics().state));
		assert.strictEqual(metrics().posted.at(-1)?.port, again);
		await stop(doc);
	});

	test('WINDOW (7.6): 1 / 5 / 15 min recompute the rows and trends at once, one show each, with no read brought forward; batches, error %, p90 and mean shown', async () => {
		const doc = await open('window.yaml', CONFIG);
		const port = await runAndWait(doc);
		// Readings a simulated minute apart: 100/s for two minutes, then 300/s; every read answers.
		const base = Date.now();
		fake.clock = () => base + fake.readsOf(port).length * 60_000;
		fake.serve(port, (i) => {
			const n = i <= 2 ? i * 6_000 : 12_000 + (i - 2) * 18_000;
			return connectText([
				{ family: 'input', path: 'root.input', received: n },
				{
					family: 'processor', path: 'root.pipeline.processors.0', label: 'fast', received: n, sent: n, errors: n / 100, batchesIn: n / 10, batchesOut: n / 10,
					p50: 7700, p90: 15_000, p99: 21_000, sum: n * 8000, count: n,
				},
				{ family: 'processor', path: 'root.pipeline.processors.1', received: n, sent: n, errors: 0, p50: 5_170_000, p99: 5_620_000 },
				{ family: 'output', path: 'root.output', sent: n, batchesOut: n / 10, errors: 0, p50: 87, p90: 2000, p99: 4061, sum: n * 100, count: n },
			]);
		});
		await vscode.commands.executeCommand(SHOW_METRICS_COMMAND);
		// The fourth reading shown and the fifth read not started (none in flight); synchronous from here.
		assert.ok(await waitFor(() => fake.readsOf(port).length === 4 && metrics().rows()[0]?.trend.length === 3, METRICS_INTERVAL_MS * 8),
			`four readings: ${fake.readsOf(port).length} ${JSON.stringify(metrics().rows()[0])}`);
		assert.strictEqual(metrics().windowMinutes, 5, 'five minutes until one is chosen');
		assert.strictEqual(metrics().posted.at(-1)?.windowMinutes, 5);
		const fast = () => metrics().rows()[1];
		assert.strictEqual(metrics().rows()[0].outRate, 30_000 / 180, 'the input over the 3 minutes kept');
		assert.deepStrictEqual(metrics().rows()[0].trend, [100, 100, 300]);
		assert.deepStrictEqual([fast().batchInRate, fast().batchOutRate, fast().errorShare, fast().p90, fast().mean], [3_000 / 180, 3_000 / 180, 0.01, 15_000, 8000]);
		assert.strictEqual(metrics().rows()[3].batchOutRate, 3_000 / 180);
		assert.strictEqual(metrics().rows()[3].p90, 2000);

		let postedAt = metrics().posted.length;
		metrics().receive({ type: 'window', minutes: 1 });
		assert.strictEqual(metrics().posted.length, postedAt + 1, 'one change posts one show');
		assert.strictEqual(metrics().windowMinutes, 1);
		let shown = metrics().posted.at(-1)!;
		assert.strictEqual(shown.windowMinutes, 1);
		assert.strictEqual(shown.rows[0].outRate, 300, 'the last minute, posted at once');
		assert.deepStrictEqual(shown.rows[0].trend, [300]);
		assert.strictEqual(shown.rows[1].inRate, 300);
		postedAt = metrics().posted.length;
		metrics().receive({ type: 'window', minutes: 15 });
		assert.strictEqual(metrics().posted.length, postedAt + 1, 'one change posts one show');
		shown = metrics().posted.at(-1)!;
		assert.strictEqual(shown.windowMinutes, 15);
		assert.strictEqual(shown.rows[0].outRate, 30_000 / 180);
		assert.deepStrictEqual(shown.rows[0].trend, [100, 100, 300]);
		assert.strictEqual(fake.readsOf(port).length, 4, 'no read for the window');
		// The next read comes at the interval after the last, not sooner.
		assert.ok(await waitFor(() => fake.readsOf(port).length >= 5, METRICS_INTERVAL_MS * 3));
		const [fourth, fifth] = fake.readsOf(port).slice(3, 5);
		assert.ok(fifth.startedAt - fourth.startedAt >= METRICS_INTERVAL_MS - 5, `the next read at the interval: ${fifth.startedAt - fourth.startedAt} ms`);
		await stop(doc);
	});

	test('bug 60: WINDOW past the posted cap: a window change on a live feed still posts one show and fires one change', async () => {
		const doc = await open('window-cap.yaml', CONFIG);
		const port = await runAndWait(doc);
		fake.serve(port, text(100));
		await vscode.commands.executeCommand(SHOW_METRICS_COMMAND);
		assert.ok(await waitFor(() => metrics().state.kind === 'live' && metrics().rows().length > 0, METRICS_INTERVAL_MS * 4), JSON.stringify(metrics().state));
		// Fill the posted log past its cap (200): each sort posts one show.
		for (let i = 0; i < 210; i++) {
			await metrics().receive({ type: 'sort', sort: i % 2 === 0 ? { column: 'share', dir: 'desc' } : null });
		}
		let changes = 0;
		const sub = metrics().onDidChange(() => { changes++; });
		try {
			// Synchronous from the capture to the checks: no read can land in between.
			const last = metrics().posted.at(-1);
			void metrics().receive({ type: 'window', minutes: 1 });
			assert.strictEqual(metrics().posted.at(-2), last, 'one show posted, not two');
			assert.strictEqual(metrics().posted.at(-1)?.windowMinutes, 1);
			assert.strictEqual(changes, 1, 'one change event');
		} finally {
			sub.dispose();
			await metrics().receive({ type: 'sort', sort: null });
		}
		await stop(doc);
	});

	test('NOT_RUNNING / NOT_SERVED / UNREACHABLE, and their buttons (ticket 8)', async () => {
		// NOT_RUNNING: the tab names the file; nothing is read. Run <file> starts it: waiting, then live.
		const idle = await open('idle.yaml', CONFIG);
		await vscode.commands.executeCommand(SHOW_METRICS_COMMAND);
		assert.ok(await waitFor(() => metrics().visible && metrics().file === idle.uri.toString(), 10_000));
		assert.strictEqual(metrics().state.kind, 'notRunning');
		await new Promise((r) => setTimeout(r, METRICS_INTERVAL_MS));
		assert.strictEqual(fake.reads.length, 0);
		assert.strictEqual(metrics().posted.at(-1)!.mapped, null, 'no .cloud.json: no second button');
		const actionsBefore = metrics().actions.length;
		await metrics().receive({ type: 'retryRequested' });
		await metrics().receive({ type: 'metricsSectionRequested' });
		assert.strictEqual(metrics().actions.length, actionsBefore, 'not offered while not running: ignored');
		await metrics().receive({ type: 'runRequested' });
		assert.strictEqual(metrics().actions.at(-1), 'runRequested');
		assert.ok(await waitFor(() => api().run.phaseOf(idle.uri) === 'running' && api().run.portOf(idle.uri) !== undefined, 15_000), 'Run started it');
		const idlePort = api().run.portOf(idle.uri)!;
		fake.serve(idlePort, text(1));
		// Run shows its terminal, which takes the bottom panel; the tab reads again once it is shown.
		await vscode.commands.executeCommand(`${METRICS_VIEW_ID}.focus`);
		assert.ok(await waitFor(() => metrics().state.kind === 'live' && fake.readsOf(idlePort).length > 0, METRICS_INTERVAL_MS * 4), JSON.stringify(metrics().state));
		await stop(idle);

		// NOT_SERVED: a config whose own `metrics` section is not prometheus is not read; Open the metrics
		// section selects its `metrics:` key.
		const none = await open('none.yaml', `${CONFIG}metrics:\n  none: {}\n`);
		await runAndWait(none);
		await vscode.commands.executeCommand(SHOW_METRICS_COMMAND);
		assert.ok(await waitFor(() => metrics().file === none.uri.toString() && metrics().state.kind === 'notServed', 10_000), JSON.stringify(metrics().state));
		assert.deepStrictEqual(metrics().state, { kind: 'notServed', reason: "this config's `metrics` section is `none`.", cause: 'type' });
		await new Promise((r) => setTimeout(r, METRICS_INTERVAL_MS));
		assert.strictEqual(fake.reads.filter((r) => r.port === api().run.portOf(none.uri)).length, 0);
		await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
		await vscode.window.showTextDocument(idle);
		const typeActions = metrics().actions.length;
		await metrics().receive({ type: 'readAgainRequested' });
		assert.strictEqual(metrics().actions.length, typeActions, 'Read again is not offered for the config\'s own type');
		await metrics().receive({ type: 'metricsSectionRequested' });
		const metricsLine = none.getText().split('\n').indexOf('metrics:');
		assert.ok(await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === none.uri.toString(), 5_000), 'the config\'s editor');
		const selection = vscode.window.activeTextEditor!.selection;
		assert.deepStrictEqual([selection.start.line, selection.start.character, selection.end.line, selection.end.character], [metricsLine, 0, metricsLine, 'metrics'.length]);
		await stop(none);

		// NOT_SERVED by the answer (a 404), then read again: the run's metrics are read.
		const answer = await open('answer.yaml', CONFIG);
		const answerPort = await runAndWait(answer);
		fake.fail(answerPort, 'notServed', `127.0.0.1:${answerPort}/metrics answered HTTP 404`, 1);
		fake.serve(answerPort, text(1));
		await vscode.commands.executeCommand(SHOW_METRICS_COMMAND, answer.uri);
		assert.ok(await waitFor(() => metrics().state.kind === 'notServed', METRICS_INTERVAL_MS * 3), JSON.stringify(metrics().state));
		assert.strictEqual((metrics().state as { cause: string }).cause, 'answer');
		const readsBefore = fake.readsOf(answerPort).length;
		await new Promise((r) => setTimeout(r, METRICS_INTERVAL_MS * 1.5));
		assert.strictEqual(fake.readsOf(answerPort).length, readsBefore, 'not read on');
		await metrics().receive({ type: 'readAgainRequested' });
		assert.ok(await waitFor(() => metrics().state.kind === 'live', METRICS_INTERVAL_MS * 3), JSON.stringify(metrics().state));

		// NO SERIES: 5 answers with none: "No figures yet"; Read again starts the count over and reads.
		fake.fail(answerPort, 'notServed', `127.0.0.1:${answerPort}/metrics has no Redpanda Connect component series`, 5, true);
		const liveActions = metrics().actions.length;
		await metrics().receive({ type: 'readAgainRequested' });
		assert.strictEqual(metrics().actions.length, liveActions, 'not offered while live');
		assert.ok(await waitFor(() => metrics().state.kind === 'notServed', METRICS_INTERVAL_MS * 8), JSON.stringify(metrics().state));
		assert.strictEqual((metrics().state as { cause: string }).cause, 'noSeries');
		await metrics().receive({ type: 'readAgainRequested' });
		assert.strictEqual(metrics().actions.at(-1), 'readAgainRequested');
		assert.ok(await waitFor(() => metrics().state.kind === 'live', METRICS_INTERVAL_MS * 3), JSON.stringify(metrics().state));
		await stop(answer);

		// UNREACHABLE: quiet (waiting) for the first failures, then said, with the next retry's time and the
		// last reading's; Retry now reads at once; Show output is carried out; reading goes on and recovers.
		const doc = await open('unreachable.yaml', CONFIG);
		const port = await runAndWait(doc);
		fake.fail(port, 'unreachable', `127.0.0.1:${port}: connection refused`, 4);
		fake.serve(port, text(1));
		await vscode.commands.executeCommand(SHOW_METRICS_COMMAND);
		assert.ok(await waitFor(() => fake.readsOf(port).length >= 1, 5_000));
		assert.strictEqual(metrics().state.kind, 'waiting');
		assert.ok(await waitFor(() => metrics().state.kind === 'unreachable', METRICS_INTERVAL_MS * 4), JSON.stringify(metrics().state));
		const shown = metrics().posted.at(-1)!;
		assert.ok(typeof shown.retryAt === 'number' && shown.retryAt > Date.now() - 500 && shown.retryAt <= Date.now() + METRICS_INTERVAL_MS, String(shown.retryAt));
		assert.strictEqual(shown.lastReadingAt, null, 'no figures shown');
		const before = fake.readsOf(port).length;
		const at = Date.now();
		await metrics().receive({ type: 'retryRequested' });
		assert.ok(await waitFor(() => fake.readsOf(port).length > before, 1_000), 'Retry now reads at once');
		assert.ok(fake.readsOf(port)[before].startedAt - at < METRICS_INTERVAL_MS / 2, 'before the interval');
		await metrics().receive({ type: 'outputRequested' });
		assert.strictEqual(metrics().actions.at(-1), 'outputRequested');
		// The output channel takes the bottom panel (the tab is hidden, so it stops reading); shown again, it reads on.
		assert.ok(await waitFor(() => !metrics().visible, 5_000), 'the output channel is shown in the panel');
		await vscode.commands.executeCommand(`${METRICS_VIEW_ID}.focus`);
		assert.ok(await waitFor(() => metrics().state.kind === 'live', METRICS_INTERVAL_MS * 3), JSON.stringify(metrics().state));
		await stop(doc);
	});

	test('GRAPH FIGURES (7.3): the graph alone reads; lines match the tab\'s rows; labelled, resource and nested nodes; hidden stops reads; stop clears', async () => {
		const FIGURES_CONFIG = [
			'input:',
			'  generate:',
			'    mapping: root = "tick"',
			'pipeline:',
			'  processors:',
			'    - label: slow_one',
			'      sleep:',
			'        duration: 5ms',
			'    - resource: res_one',
			'    - branch:',
			'        processors:',
			'          - mapping: root = this',
			'output:',
			'  drop: {}',
			'processor_resources:',
			'  - label: res_one',
			'    mapping: root = this',
			'',
		].join('\n');
		const series = (n: number) => connectText([
			{ family: 'input', path: 'root.input', received: n },
			{ family: 'processor', path: 'root.pipeline.processors.0', label: 'slow_one', received: n, sent: n, errors: 0, p50: 5_170_000, p99: 5_620_000, sum: n * 5_170_000, count: n },
			{ family: 'processor', path: 'root.processor_resources', label: 'res_one', received: n, sent: n, errors: 0, p50: 7700, p99: 21_000, sum: n * 7700, count: n },
			{ family: 'processor', path: 'root.pipeline.processors.2', received: n, sent: n, errors: 0, p50: 9000, p99: 9900, sum: n * 9000, count: n },
			{ family: 'processor', path: 'root.pipeline.processors.2.branch.processors.0', received: n, sent: n, errors: n / 100, p50: 900, p99: 1200, sum: n * 900, count: n },
			{ family: 'output', path: 'root.output', sent: n, errors: 0, p50: 87, p99: 4061, sum: n * 87, count: n },
			{ family: 'processor', path: 'root.nowhere', label: 'ghost', received: n },
		]);
		const NESTED = 'path:pipeline.processors[2].branch.processors[0]';
		const figuresOf = (handle: GraphPanelHandle): NodeFiguresById[] =>
			handle.posted.flatMap((m) => (m.type === 'nodeFigures' ? [m.byId] : []));
		const lastFigures = (handle: GraphPanelHandle) => figuresOf(handle).at(-1) ?? {};
		const outRate = (f: NodeFiguresById[string] | undefined) => f?.outRate ?? null;

		// The tab closed: only the graph shows the readings.
		await vscode.commands.executeCommand('workbench.action.closePanel');
		assert.ok(await waitFor(() => !metrics().visible, 10_000));
		const doc = await open('figures.yaml', FIGURES_CONFIG);
		const port = await runAndWait(doc);
		await vscode.commands.executeCommand('workbench.action.closePanel');
		let n = 1000;
		fake.serve(port, series(n));
		await vscode.commands.executeCommand('redpandaConnect.showGraph', doc.uri);
		const handle = api().graphPanels.panelFor(doc.uri)!;
		assert.ok(handle, 'a graph panel');
		assert.ok(await waitFor(() => Object.keys(lastFigures(handle)).length > 0, METRICS_INTERVAL_MS + 5_000),
			`the graph alone reads: ${JSON.stringify(fake.readsOf(port).length)} ${JSON.stringify(handle.posted.map((m) => m.type))}`);
		assert.ok(!metrics().visible, 'the tab is closed');
		assert.deepStrictEqual(Object.keys(lastFigures(handle)).sort(), ['label:slow_one', 'path:input', 'path:output', NESTED, 'res:processor:res_one'].sort());
		assert.deepStrictEqual(lastFigures(handle)['path:input'], { kind: 'input', outRate: null }, 'the first reading: no rate');
		assert.deepStrictEqual(lastFigures(handle)['label:slow_one'],
			{ kind: 'component', inRate: null, outRate: null, errorRate: null, p50: 5_170_000, p99: 5_620_000, share: null }, 'the first reading: no share, no mark');
		n = 1400;
		fake.serve(port, series(n));
		assert.ok(await waitFor(() => (outRate(lastFigures(handle)['path:input']) ?? 0) > 0, METRICS_INTERVAL_MS * 3), JSON.stringify(lastFigures(handle)));

		// The tab open too, on the same file: the same reading, the same numbers.
		await vscode.commands.executeCommand(SHOW_METRICS_COMMAND, doc.uri);
		// Show restarts the readings: the counters rise again after its first one.
		assert.ok(await waitFor(() => metrics().state.kind === 'live', METRICS_INTERVAL_MS * 2), JSON.stringify(metrics().state));
		n = 1700;
		fake.serve(port, series(n));
		assert.ok(await waitFor(() => metrics().visible && metrics().file === doc.uri.toString() && (metrics().rows()[1]?.outRate ?? 0) > 0, METRICS_INTERVAL_MS * 3),
			JSON.stringify(metrics().rows()));
		n = 2000;
		fake.serve(port, series(n));
		const readsBefore = fake.readsOf(port).length;
		assert.ok(await waitFor(() => fake.readsOf(port).length > readsBefore + 1, METRICS_INTERVAL_MS * 4));
		const byId = lastFigures(handle);
		const rows = metrics().rows();
		for (const row of rows) {
			const f = row.nodeId === null ? undefined : byId[row.nodeId];
			if (row.nodeId === null || row.id === 'path:pipeline.processors[2]' || row.id === 'path:pipeline.processors[1]') {
				assert.strictEqual(f, undefined, `no line for ${row.id}`);
			} else if (f?.kind === 'input') {
				assert.strictEqual(f.outRate, row.outRate, row.id);
			} else {
				assert.ok(f, `a line for ${row.id}`);
				assert.deepStrictEqual([f.inRate, f.outRate, f.errorRate, f.p50, f.p99], [row.inRate, row.outRate, row.errorRate, row.p50, row.p99], row.id);
				// Ticket 7.7: the same share and marks.
				assert.deepStrictEqual([f.share, f.slowest === true, f.hasErrors === true], [row.share, row.slowest, row.hasErrors], row.id);
			}
		}
		assert.ok(rows.some((r) => r.nodeId === null && r.name === 'ghost'), 'the unmatched series is in the tab');
		// Ticket 7.7: the sleep is the slowest in the tab and on its node, with the same share; the nested
		// processor with errors is marked in both; the summary names them.
		// The resource's time counts in the total (its `resource:` processor reports no series).
		const TOTAL = 5_170_000 + 7700 + 9000 + 87;
		assert.deepStrictEqual(rows.filter((r) => r.slowest).map((r) => r.id), ['label:slow_one']);
		const slow = rows.find((r) => r.id === 'label:slow_one')!;
		assert.ok(Math.abs(slow.share! - 5_170_000 / TOTAL) < 1e-9, String(slow.share));
		const slowFigures = byId['label:slow_one'];
		assert.ok(slowFigures?.kind === 'component' && slowFigures.slowest === true && slowFigures.share === slow.share, JSON.stringify(slowFigures));
		assert.deepStrictEqual(Object.entries(byId).filter(([, f]) => f.kind === 'component' && f.slowest).map(([id]) => id), ['label:slow_one']);
		assert.deepStrictEqual(rows.filter((r) => r.hasErrors).map((r) => r.id), [NESTED]);
		const nested = byId[NESTED];
		assert.ok(nested?.kind === 'component' && nested.hasErrors === true && nested.slowest === undefined, JSON.stringify(nested));
		const summary = metrics().posted.at(-1)!.summary!;
		assert.deepStrictEqual([summary.slowest?.name, summary.slowest?.path, summary.slowest?.share], ['slow_one', 'pipeline.processors[0]', slow.share]);
		assert.deepStrictEqual(summary.errors.map((e) => e.name), ['mapping']);
		assert.deepStrictEqual([summary.inputRate, summary.outputRate, summary.gap], [rows[0].outRate, rows.find((r) => r.id === 'path:output')!.outRate, null]);
		// Sorted by Share: the input last.
		await metrics().receive({ type: 'sort', sort: { column: 'share', dir: 'desc' } });
		assert.strictEqual(metrics().rows()[0].id, 'label:slow_one');
		assert.ok(metrics().rows().at(-1)!.share === null);
		assert.ok(metrics().rows().findIndex((r) => r.kind === 'input') > metrics().rows().findIndex((r) => r.id === 'path:output'), 'the input after every share');
		await metrics().receive({ type: 'sort', sort: null });

		// REOPENED: a recreated webview's snapshot carries the current figures.
		await handle.receive({ type: 'ready' });
		const snapshot = handle.posted.filter((m) => m.type === 'snapshot').at(-1);
		assert.ok(snapshot?.type === 'snapshot');
		assert.deepStrictEqual(snapshot.nodeFigures, lastFigures(handle));

		// HIDDEN: the tab closed and the graph hidden behind another editor: no read.
		await vscode.commands.executeCommand('workbench.action.closePanel');
		assert.ok(await waitFor(() => !metrics().visible, 10_000));
		const other = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'hide the graph' });
		await vscode.window.showTextDocument(other, { viewColumn: handle.panel.viewColumn, preview: false });
		assert.ok(await waitFor(() => !handle.panel.visible, 10_000), 'the graph is hidden');
		await new Promise((r) => setTimeout(r, 300));
		const hiddenAt = fake.readsOf(port).length;
		await new Promise((r) => setTimeout(r, METRICS_INTERVAL_MS * 1.5));
		assert.strictEqual(fake.readsOf(port).length, hiddenAt, 'no read while the graph is hidden and the tab closed');
		assert.deepStrictEqual(lastFigures(handle), {}, 'nothing shown while unseen');

		// Shown again: the graph reads; STOP clears the lines.
		// The untitled editor has text (dirty): reverted, so closing it asks nothing.
		await vscode.window.showTextDocument(other, { viewColumn: handle.panel.viewColumn, preview: false });
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
		handle.panel.reveal(undefined, true);
		assert.ok(await waitFor(() => handle.panel.visible && Object.keys(lastFigures(handle)).length > 0, METRICS_INTERVAL_MS + 5_000),
			JSON.stringify(handle.posted.map((m) => m.type).slice(-5)));
		await stop(doc);
		assert.ok(await waitFor(() => Object.keys(lastFigures(handle)).length === 0, 5_000), 'the lines cleared on stop');
		handle.panel.dispose();
	});

	test('GRAPH FIGURES (7.3) BROKEN / EDIT: figures frozen while the YAML does not parse, let through once it does; an edit re-maps them on the next reading', async () => {
		const CONFIG_EDIT = [
			'input:',
			'  generate:',
			'    mapping: root = "tick"',
			'pipeline:',
			'  processors:',
			'    - mapping: root = this',
			'    - sleep:',
			'        duration: 5ms',
			'output:',
			'  drop: {}',
			'',
		].join('\n');
		const series = (n: number) => connectText([
			{ family: 'input', path: 'root.input', received: n },
			{ family: 'processor', path: 'root.pipeline.processors.0', received: n, sent: n, errors: 0, p50: 7700, p99: 21_000 },
			{ family: 'processor', path: 'root.pipeline.processors.1', received: n, sent: n, errors: 0, p50: 5_170_000, p99: 5_620_000 },
			{ family: 'output', path: 'root.output', sent: n, errors: 0, p50: 87, p99: 4061 },
		]);
		const figuresPosted = (handle: GraphPanelHandle): NodeFiguresById[] =>
			handle.posted.flatMap((m) => (m.type === 'nodeFigures' ? [m.byId] : []));
		const last = (handle: GraphPanelHandle) => figuresPosted(handle).at(-1) ?? {};
		const edit = async (doc: vscode.TextDocument, from: string, to: string) => {
			const at = doc.getText().indexOf(from);
			assert.ok(at >= 0, from);
			const e = new vscode.WorkspaceEdit();
			e.replace(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + from.length)), to);
			assert.ok(await vscode.workspace.applyEdit(e));
		};

		await vscode.commands.executeCommand('workbench.action.closePanel');
		const doc = await open('figures-edit.yaml', CONFIG_EDIT);
		const port = await runAndWait(doc);
		await vscode.commands.executeCommand('workbench.action.closePanel');
		let n = 100;
		fake.serve(port, series(n));
		await vscode.commands.executeCommand('redpandaConnect.showGraph', doc.uri);
		const handle = api().graphPanels.panelFor(doc.uri)!;
		assert.ok(handle, 'a graph panel');
		assert.ok(await waitFor(() => last(handle)['path:pipeline.processors[1]'] !== undefined, METRICS_INTERVAL_MS + 5_000),
			JSON.stringify(handle.posted.map((m) => m.type)));
		const readsNow = () => fake.readsOf(port).length;
		const nextReading = async (count: number) => {
			const from = readsNow();
			n += 100;
			fake.serve(port, series(n));
			assert.ok(await waitFor(() => readsNow() >= from + count, METRICS_INTERVAL_MS * (count + 2)), `${count} more reading(s)`);
			await new Promise((r) => setTimeout(r, 200));
		};

		// BROKEN: the YAML does not parse: no nodeFigures is posted over the next readings (frozen).
		await edit(doc, '  drop: {}', '  drop: {\n  bad: [');
		assert.ok(await waitFor(() => handle.posted.some((m) => m.type === 'parseError'), 5_000), 'the parse error');
		const frozenAt = figuresPosted(handle).length;
		const frozen = last(handle);
		await nextReading(2);
		assert.strictEqual(figuresPosted(handle).length, frozenAt, 'no nodeFigures while the YAML does not parse');
		assert.deepStrictEqual(last(handle), frozen);
		// Fixed: the next reading's figures come through.
		await edit(doc, '  drop: {\n  bad: [', '  drop: {}');
		await nextReading(1);
		assert.ok(await waitFor(() => figuresPosted(handle).length > frozenAt, METRICS_INTERVAL_MS * 2), 'figures again once it parses');
		assert.ok(last(handle)['path:pipeline.processors[1]'] !== undefined);

		// EDIT: a label on the first processor re-ids it, and the second is deleted: on the next reading
		// the first's series is on its new node and the deleted node has no entry.
		// Right after a reading, so the next one is about an interval away: the re-map comes with the model.
		await nextReading(1);
		const kept = last(handle)['path:pipeline.processors[0]'];
		const readsAtEdit = readsNow();
		await edit(doc, '    - mapping: root = this\n    - sleep:\n        duration: 5ms\n', '    - label: renamed\n      mapping: root = this\n');
		assert.ok(await waitFor(() => last(handle)['label:renamed'] !== undefined, 1_000), `re-mapped with the model: ${JSON.stringify(last(handle))}`);
		assert.strictEqual(readsNow(), readsAtEdit, 'no new reading was needed');
		assert.deepStrictEqual(last(handle)['label:renamed'], kept, 'the last reading\'s figures, on the new id');
		assert.ok(handle.posted.some((m) => m.type === 'model' && m.model.nodes.some((x) => x.id === 'label:renamed')), 'the new model');
		await nextReading(1);
		const byId = last(handle);
		assert.deepStrictEqual(Object.keys(byId).sort(), ['label:renamed', 'path:input', 'path:output']);
		assert.strictEqual(byId['path:pipeline.processors[0]'], undefined, 'the old id is gone');
		assert.strictEqual(byId['path:pipeline.processors[1]'], undefined, 'the deleted node has no entry');
		const renamed = byId['label:renamed'];
		assert.ok(renamed?.kind === 'component' && renamed.p50 === 7700 && renamed.p99 === 21_000, JSON.stringify(renamed));

		await stop(doc);
		// The edits are not saved: reverted, so closing the editor later asks nothing.
		await vscode.window.showTextDocument(doc);
		await vscode.commands.executeCommand('workbench.action.files.revert');
		handle.panel.dispose();
	});
	test('ticket 9, package.json: Show Pipeline Metrics is in the palette with no editor (no detected-file `when`); the status bar menu is not', () => {
		const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as { contributes: { menus: { commandPalette: { command: string; when?: string }[] } } };
		const palette = pkg.contributes.menus.commandPalette;
		const show = palette.filter((m) => m.command === SHOW_METRICS_COMMAND);
		assert.ok(show.every((m) => m.when === undefined), `no when restricting it: ${JSON.stringify(show)}`);
		assert.deepStrictEqual(palette.filter((m) => m.command === RUN_MENU_COMMAND), [{ command: RUN_MENU_COMMAND, when: 'false' }]);
	});

	test('ticket 9, STATUS_BAR: the running item opens Stop / Show pipeline metrics; Show opens the tab on that run, and the item then shows the output rate', async () => {
		const doc = await open('status.yaml', CONFIG);
		const port = await runAndWait(doc);
		fake.serve(port, text(100));
		await vscode.commands.executeCommand('workbench.action.closePanel');
		assert.ok(await waitFor(() => !metrics().visible, 10_000));
		assert.strictEqual(api().run.statusBarText, '$(debug-stop) Stop pipeline', 'no rate while the tab does not read the run');
		const original = api().run.ui;
		const menus: (readonly string[])[] = [];
		api().run.ui = { menu: async (_title, entries) => { menus.push(entries); return SHOW_METRICS_ACTION; } };
		try {
			// The item's own command, with its arguments.
			await vscode.commands.executeCommand(RUN_MENU_COMMAND, doc.uri);
			assert.deepStrictEqual(menus, [[stopAction('status.yaml'), SHOW_METRICS_ACTION]]);
			assert.ok(await waitFor(() => metrics().visible && metrics().file === doc.uri.toString(), 10_000), String(metrics().file));
			assert.strictEqual(metrics().title, 'Local run · status.yaml');
			let n = 100;
			assert.ok(await waitFor(() => {
				fake.serve(port, text(n += 50));
				return /^\$\(debug-stop\) Stop pipeline · \d+\.\d\/s$/.test(api().run.statusBarText ?? '');
			}, METRICS_INTERVAL_MS * 5), `the output rate: ${api().run.statusBarText}`);
			// The tab closed: the rate goes (no read of the item's own).
			await vscode.commands.executeCommand('workbench.action.closePanel');
			assert.ok(await waitFor(() => api().run.statusBarText === '$(debug-stop) Stop pipeline', 10_000), String(api().run.statusBarText));
			// Stop from the menu.
			api().run.ui = { menu: async (_title, entries) => entries[0] };
			await vscode.commands.executeCommand(RUN_MENU_COMMAND, doc.uri);
			assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'exited', 15_000));
		} finally {
			api().run.ui = original;
		}
	});

	test('ticket 9, GRAPH_BUTTON: Open Pipeline Metrics in the graph opens the tab on the graph file\'s run, as the command for that file', async () => {
		const doc = await open('graphbutton.yaml', CONFIG);
		const port = await runAndWait(doc);
		fake.serve(port, text(100));
		await vscode.commands.executeCommand('workbench.action.closePanel');
		await vscode.commands.executeCommand('redpandaConnect.showGraph', doc.uri);
		const handle = api().graphPanels.panelFor(doc.uri)!;
		assert.ok(handle, 'a graph panel');
		// Another config active: the button goes by the graph's file, not the active editor.
		await open('other-active.yaml', CONFIG);
		const before = handle.posted.length;
		await handle.receive({ type: 'metricsRequested' });
		assert.ok(await waitFor(() => metrics().visible && metrics().file === doc.uri.toString(), 10_000), String(metrics().file));
		assert.strictEqual(metrics().title, 'Local run · graphbutton.yaml');
		assert.ok(handle.posted.slice(before).every((m) => m.type === 'nodeFigures'), `nothing else in the graph: ${handle.posted.slice(before).map((m) => m.type).join(', ')}`);
		await stop(doc);
		handle.panel.dispose();
	});

	test('ticket 9, NEITHER: a config neither running nor mapped opens the tab on it, Not running', async () => {
		const doc = await open('neither.yaml', CONFIG);
		await vscode.commands.executeCommand(SHOW_METRICS_COMMAND);
		assert.ok(await waitFor(() => metrics().visible && metrics().file === doc.uri.toString(), 10_000));
		assert.strictEqual(metrics().state.kind, 'notRunning');
	});

	test('ticket 9, NO_EDITOR: no active config: a pick of the running files; the one chosen opens; none running: the message', async () => {
		const a = await open('pick-a.yaml', CONFIG);
		const b = await open('pick-b.yaml', CONFIG);
		await runAndWait(a);
		await runAndWait(b);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		const original = metrics().ui;
		const shown: string[][] = [];
		metrics().ui = {
			pick: async (_title, items) => {
				shown.push(items.map((i) => `${i.kind}:${i.label}`));
				return items.find((i) => i.label === 'pick-b.yaml');
			},
		};
		try {
			await vscode.commands.executeCommand(SHOW_METRICS_COMMAND);
			assert.deepStrictEqual(shown.map((l) => l.filter((x) => x.startsWith('local:')).sort()), [['local:pick-a.yaml', 'local:pick-b.yaml']]);
			assert.ok(await waitFor(() => metrics().visible && metrics().file === b.uri.toString(), 10_000), String(metrics().file));
			await stop(a);
			await stop(b);
			// None running: no local entry (with no Cloud pipeline loaded either, no pick: NO_CONFIG_MESSAGE, in the unit tests).
			shown.length = 0;
			await vscode.commands.executeCommand(SHOW_METRICS_COMMAND);
			assert.ok(shown.every((l) => l.every((x) => !x.startsWith('local:'))), JSON.stringify(shown));
			assert.strictEqual(metrics().file, b.uri.toString(), 'nothing new bound');
		} finally {
			metrics().ui = original;
		}
	});
});
