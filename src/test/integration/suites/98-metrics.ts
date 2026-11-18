// Pipeline metrics, the tracer (ticket 7.2, AD-25), end to end in the stable run with a fake binary (as
// 60-run.ts) and the in-memory metrics source (`helpers/fakeMetrics.ts`) handed to the tab's seam
// instead of the local `/metrics` read. Show Pipeline Metrics opens the tab in the bottom panel, bound
// to the active config; the tab is read through its test seam (its state, rows, reads). The matrix rows
// covered here: HAPPY (rows within one interval, names the source and its address), NOT_RUNNING (no
// read), HIDDEN (no read while hidden, one at once when shown), STOP / RERUN (last figures kept and
// marked stopped; the rerun's new port read), NOT_SERVED (a `metrics: none` config is not read),
// UNREACHABLE (quiet until 3 failures, then said, and read on). The real binary's case is in 61-run-real.ts.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { METRICS_INTERVAL_MS, METRICS_VIEW_ID, SHOW_METRICS_COMMAND } from '../../../adapters/vscode/metricsPanel';
import { type ExtensionApi } from '../../../extension';
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

		// RERUN: the new port is read.
		const again = await runAndWait(doc);
		fake.serve(again, text(10));
		// Run shows its terminal, which takes the bottom panel; the tab reads again once it is shown.
		await vscode.commands.executeCommand(`${METRICS_VIEW_ID}.focus`);
		assert.ok(await waitFor(() => metrics().state.kind === 'live' && fake.readsOf(again).length > 0, METRICS_INTERVAL_MS + 3_000), JSON.stringify(metrics().state));
		assert.strictEqual(metrics().posted.at(-1)?.port, again);
		await stop(doc);
	});

	test('NOT_RUNNING / NOT_SERVED / UNREACHABLE', async () => {
		// NOT_RUNNING: the tab names the file; nothing is read.
		const idle = await open('idle.yaml', CONFIG);
		await vscode.commands.executeCommand(SHOW_METRICS_COMMAND);
		assert.ok(await waitFor(() => metrics().visible && metrics().file === idle.uri.toString(), 10_000));
		assert.strictEqual(metrics().state.kind, 'notRunning');
		await new Promise((r) => setTimeout(r, METRICS_INTERVAL_MS));
		assert.strictEqual(fake.reads.length, 0);

		// NOT_SERVED: a config whose own `metrics` section is not prometheus is not read.
		const none = await open('none.yaml', `${CONFIG}metrics:\n  none: {}\n`);
		await runAndWait(none);
		await vscode.commands.executeCommand(SHOW_METRICS_COMMAND);
		assert.ok(await waitFor(() => metrics().file === none.uri.toString() && metrics().state.kind === 'notServed', 10_000), JSON.stringify(metrics().state));
		assert.strictEqual((metrics().state as { reason: string }).reason, "this config's `metrics` section is `none`.");
		await new Promise((r) => setTimeout(r, METRICS_INTERVAL_MS));
		assert.strictEqual(fake.reads.length, 0);
		await stop(none);

		// UNREACHABLE: quiet (waiting) for the first failures, then said; reading goes on and recovers.
		const doc = await open('unreachable.yaml', CONFIG);
		const port = await runAndWait(doc);
		fake.fail(port, 'unreachable', `127.0.0.1:${port}: connection refused`, 3);
		fake.serve(port, text(1));
		await vscode.commands.executeCommand(SHOW_METRICS_COMMAND);
		assert.ok(await waitFor(() => fake.readsOf(port).length >= 1, 5_000));
		assert.strictEqual(metrics().state.kind, 'waiting');
		assert.ok(await waitFor(() => metrics().state.kind === 'unreachable', METRICS_INTERVAL_MS * 4), JSON.stringify(metrics().state));
		assert.ok(await waitFor(() => metrics().state.kind === 'live', METRICS_INTERVAL_MS * 3), JSON.stringify(metrics().state));
		await stop(doc);
	});
});
