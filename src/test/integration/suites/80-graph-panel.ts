import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { REPO_ROOT } from '../../helpers/fakeBinary';
import { waitFor } from '../helpers';
import { snapshots, ids, live, VALID, replace, insert, open, showGraph, useGraphSuite } from '../graphHelpers';
import { api, EXTRA_INPUT, schemaFrom, setBinaryPath } from '../schemaHarness';

// The graph panel, its model and live updates (3.1, 3.3, 3.6). See ../graphHelpers.ts for the seam.
suite('Pipeline graph: panel, model and live updates (3.1, 3.3, 3.6, integration)', function () {
	this.timeout(60_000);
	const h = useGraphSuite();

	test('PANEL: one panel beside the editor, "Graph: <file>", whose webview gets the nested model', async () => {
		const text = fs.readFileSync(path.join(REPO_ROOT, 'test', 'corpus', 'stateful_polling.yaml'), 'utf8');
		const doc = await open('stateful_polling.yaml', text);
		const handle = await showGraph(doc);
		assert.strictEqual(handle.panel.title, 'Graph: stateful_polling.yaml');
		// The panel's column is set once the workbench has placed it.
		assert.ok(await waitFor(() => handle.panel.viewColumn === vscode.ViewColumn.Two, 10_000), `beside: ${handle.panel.viewColumn}`);
		assert.strictEqual(api().graphPanels.size, 1);
		// The real webview boots, posts `ready` and gets the snapshot.
		assert.ok(await waitFor(() => snapshots(handle).length > 0, 30_000), 'the webview posted ready');
		const model = snapshots(handle)[0];
		assert.deepStrictEqual(ids(model), [
			'path:input',
			'path:pipeline.processors[0]',
			'path:pipeline.processors[1]',
			'path:pipeline.processors[1].catch',
			'path:pipeline.processors[1].catch[0]',
			'path:pipeline.processors[2]',
			'path:pipeline.processors[3]',
			'path:output',
			'path:output.broker.outputs',
			'path:output.broker.outputs[0]',
			'path:output.broker.outputs[1]',
			'path:output.broker.outputs[1].processors[0]',
			'res:cache:cached_pgstate',
			'res:cache:inmem',
			'res:cache:pgstate',
		]);
		// `catch` is a group holding its body route and, in it, its mapping.
		const node = (id: string) => model.nodes.find((n) => n.id === id)!;
		assert.strictEqual(node('path:pipeline.processors[1]').group, true);
		assert.strictEqual(node('path:pipeline.processors[1].catch').parent, 'path:pipeline.processors[1]');
		assert.deepStrictEqual(
			[node('path:pipeline.processors[1].catch[0]').component, node('path:pipeline.processors[1].catch[0]').parent],
			['mapping', 'path:pipeline.processors[1].catch'],
		);
		assert.strictEqual(model.edges.length, 5);
		// The full snapshot (AD-5): no diagnostics, so no node status (3.8); the real host status
		// (3.9); the selection is the node under the cursor (3.7), none on the comment the file
		// starts with.
		const snapshot = handle.posted.find((m) => m.type === 'snapshot')!;
		assert.deepStrictEqual({ ...snapshot, model: undefined }, {
			type: 'snapshot',
			model: undefined,
			nodeStatus: {},
			selection: null,
			hostStatus: { binary: 'ok', schema: 'ok' },
		});
	});

	test('PALETTE: Show graph with no argument opens the active editor\'s graph', async () => {
		const text = fs.readFileSync(path.join(REPO_ROOT, 'test', 'corpus', 'stateful_polling.yaml'), 'utf8');
		const doc = await open('palette.yaml', text);
		assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), doc.uri.toString());
		await vscode.commands.executeCommand('redpandaConnect.showGraph');
		const handle = api().graphPanels.panelFor(doc.uri);
		assert.ok(handle, 'a graph panel for the active file');
		assert.strictEqual(handle.panel.title, 'Graph: palette.yaml');
		assert.strictEqual(api().graphPanels.size, 1);
	});

	test('AGAIN: Show graph twice on one file keeps one panel', async () => {
		const doc = await open('again.yaml', 'input:\n  stdin: {}\noutput:\n  stdout: {}\n');
		const first = await showGraph(doc);
		await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
		const second = await showGraph(doc);
		assert.strictEqual(second, first);
		assert.strictEqual(api().graphPanels.size, 1);
	});

	test('TWO_FILES: each file gets its own panel and model', async () => {
		const a = await open('a.yaml', 'input:\n  stdin: {}\n');
		const panelA = await showGraph(a);
		const b = await open('b.yaml', 'output:\n  stdout: {}\n');
		const panelB = await showGraph(b);
		assert.notStrictEqual(panelA, panelB);
		assert.strictEqual(api().graphPanels.size, 2);
		await panelA.receive({ type: 'ready' });
		await panelB.receive({ type: 'ready' });
		assert.deepStrictEqual(ids(snapshots(panelA).at(-1)), ['path:input']);
		assert.deepStrictEqual(ids(snapshots(panelB).at(-1)), ['path:output']);
		assert.strictEqual(panelB.panel.title, 'Graph: b.yaml');
	});

	test('FIRST_BROKEN: Show graph on a file that does not parse gives a snapshot with no model and the parse error', async () => {
		const text = 'input:\n  stdin: {}\n bad: 1\n';
		const doc = await open('broken.yaml', text);
		const handle = await showGraph(doc);
		await handle.receive({ type: 'ready' });
		const snapshot = handle.posted.filter((m) => m.type === 'snapshot').at(-1);
		assert.ok(snapshot?.type === 'snapshot');
		assert.strictEqual(snapshot.model, null);
		assert.strictEqual(snapshot.parseError?.message, 'All mapping items must start at the same column at line 3, column 1');
		assert.strictEqual(snapshot.parseError?.range[0], text.indexOf(' bad'));
		assert.deepStrictEqual(live(handle), [], 'nothing but snapshots without an edit');
	});

	test('EDIT / BREAK / HEAL: each change posts one complete model, or only the parse error', async () => {
		const doc = await open('live.yaml', VALID);
		const handle = await showGraph(doc);
		await handle.receive({ type: 'ready' });
		assert.deepStrictEqual(ids(snapshots(handle).at(-1)), ['path:input', 'path:output']);

		// EDIT: adding a processor sends one model with the new node.
		await insert(doc, doc.getText().indexOf('output:'), 'pipeline:\n  processors:\n    - mapping: root = this\n');
		assert.ok(await waitFor(() => live(handle).length === 1, 10_000), 'one update');
		const edited = live(handle)[0];
		assert.ok(edited.type === 'model', `a model, not ${edited.type}`);
		assert.deepStrictEqual(ids(edited.model), ['path:input', 'path:pipeline.processors[0]', 'path:output']);

		// BREAK: an edit that makes the YAML unparseable sends only the parse error.
		const at = doc.getText().indexOf('output:');
		await insert(doc, at, ' ');
		assert.ok(await waitFor(() => live(handle).length === 2, 10_000), 'a second update');
		const broken = live(handle)[1];
		assert.ok(broken.type === 'parseError', `a parseError, not ${broken.type}`);
		assert.ok(broken.message.length > 0);
		assert.ok(broken.range[0] <= broken.range[1] && broken.range[1] <= doc.getText().length);

		// Typing on while broken: still only parse errors.
		await insert(doc, at + 1, 'x');
		assert.ok(await waitFor(() => live(handle).length === 3, 10_000), 'a third update');
		assert.strictEqual(live(handle)[2].type, 'parseError');

		// HEAL: the next valid edit sends a model again.
		await replace(doc, at, at + 2, '');
		assert.ok(await waitFor(() => live(handle).length === 4, 10_000), 'a fourth update');
		const healed = live(handle)[3];
		assert.ok(healed.type === 'model', `a model, not ${healed.type}`);
		assert.deepStrictEqual(healed.model, edited.model);
		assert.strictEqual(live(handle).length, 4, 'one message per change');
	});

	test('RECREATED: a webview recreated while the YAML is broken gets the last valid model and the parse error', async () => {
		const doc = await open('recreated.yaml', VALID);
		const handle = await showGraph(doc);
		await handle.receive({ type: 'ready' });
		const valid = snapshots(handle).at(-1);
		await insert(doc, doc.getText().indexOf('output:'), ' ');
		assert.ok(await waitFor(() => live(handle).some((m) => m.type === 'parseError'), 10_000));
		// The panel hidden and shown: the new webview posts ready again.
		await handle.receive({ type: 'ready' });
		const snapshot = handle.posted.filter((m) => m.type === 'snapshot').at(-1);
		assert.ok(snapshot?.type === 'snapshot');
		assert.deepStrictEqual(snapshot.model, valid);
		assert.ok(snapshot.parseError, 'the snapshot carries the parse error');
	});

	test('OTHER_DOC / CLOSED: edits to a file without a panel, or after its panel closed, post nothing', async () => {
		const a = await open('with-panel.yaml', VALID);
		const handle = await showGraph(a);
		const b = await open('without-panel.yaml', VALID);
		assert.strictEqual(api().graphPanels.panelFor(b.uri), undefined);
		await insert(b, 0, '# a comment\n');
		await insert(b, b.getText().indexOf('output:'), ' ');
		// Give a stray update the time to arrive.
		await new Promise((r) => setTimeout(r, 300));
		assert.deepStrictEqual(live(handle), [], 'nothing posted for the other file');

		const logged = api().outputLines().length;
		handle.panel.dispose();
		assert.strictEqual(api().graphPanels.panelFor(a.uri), undefined);
		await insert(a, 0, '# a comment\n');
		await insert(a, a.getText().indexOf('output:'), ' ');
		await new Promise((r) => setTimeout(r, 300));
		assert.deepStrictEqual(live(handle), [], 'nothing posted after the panel closed');
		assert.ok(!api().outputLines().slice(logged).some((l) => l.startsWith('Graph')), 'no error logged');
	});

	test('CURRENT_SCHEMA: after the binary changes, ready gets a model built with the new schema', async () => {
		// Two keys that are not 4.112.0 input names: the first is the component until the schema lists the second.
		const doc = await open('current-schema.yaml', `input:\n  rpcn_typo: {}\n  ${EXTRA_INPUT}: {}\n`);
		const handle = await showGraph(doc);
		await handle.receive({ type: 'ready' });
		assert.strictEqual(snapshots(handle).at(-1)?.nodes[0]?.component, 'rpcn_typo');
		try {
			await setBinaryPath(h.changedBinary);
			await schemaFrom(h.changedBinary, '4.113.0');
			await handle.receive({ type: 'ready' });
			assert.strictEqual(snapshots(handle).at(-1)?.nodes[0]?.component, EXTRA_INPUT);
		} finally {
			await setBinaryPath(h.fakeBinary);
			await schemaFrom(h.fakeBinary, '4.112.0');
		}
	});

	test('CLOSED: closing the panel disposes it; Show graph again opens a new one', async () => {
		const doc = await open('closed.yaml', 'input:\n  stdin: {}\n');
		const first = await showGraph(doc);
		first.panel.dispose();
		assert.strictEqual(api().graphPanels.panelFor(doc.uri), undefined);
		assert.strictEqual(api().graphPanels.size, 0);
		await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
		const second = await showGraph(doc);
		assert.notStrictEqual(second, first);
		assert.strictEqual(api().graphPanels.size, 1);
	});
});
