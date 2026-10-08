import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GraphPanelHandle } from '../../../adapters/graphPanel/panels';
import { type ExtensionApi } from '../../../extension';
import type { PipelineModel } from '../../../shared/protocol';
import { makeTempDir, REPO_ROOT } from '../../helpers/fakeBinary';
import { EXTENSION_ID, waitFor } from '../helpers';

// The graph panel through its host-side seam (`graphPanels.panelFor`, `receive`): the tests
// check what the host posts and does, and don't drive the webview DOM (ticket 3.1).
suite('Pipeline graph (3.1, integration)', function () {
	this.timeout(60_000);
	let dir: string;
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const snapshots = (handle: GraphPanelHandle): PipelineModel[] =>
		handle.posted.flatMap((m) => (m.type === 'snapshot' ? [m.model] : []));
	const ids = (model: PipelineModel | undefined) => model?.nodes.map((n) => n.id);

	async function open(name: string, text: string): Promise<vscode.TextDocument> {
		const file = path.join(dir, name);
		fs.writeFileSync(file, text);
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
		return doc;
	}

	async function showGraph(doc: vscode.TextDocument): Promise<GraphPanelHandle> {
		await vscode.commands.executeCommand('redpandaConnect.showGraph', doc.uri);
		const handle = api().graphPanels.panelFor(doc.uri);
		assert.ok(handle, 'a graph panel for the file');
		return handle;
	}

	suiteSetup(async () => {
		dir = makeTempDir('rpcn-graph-');
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
	});

	teardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		assert.ok(await waitFor(() => api().graphPanels.size === 0, 10_000), 'closing the editors disposes the panels');
	});

	suiteTeardown(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('contributions: sentence-case titles, Show graph in the palette for detected files, Hide graph hidden', () => {
		const contributes = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes;
		const title = (id: string) => contributes.commands.find((c: { command: string }) => c.command === id)?.title;
		assert.strictEqual(title('redpandaConnect.showGraph'), 'Show graph');
		assert.strictEqual(title('redpandaConnect.hideGraph'), 'Hide graph');
		const palette = Object.fromEntries(contributes.menus.commandPalette.map((m: { command: string; when: string }) => [m.command, m.when]));
		assert.strictEqual(palette['redpandaConnect.showGraph'], 'redpandaConnect.activeEditorDetected');
		assert.strictEqual(palette['redpandaConnect.hideGraph'], 'false');
	});

	test('FLAT: one panel beside the editor, "Graph: <file>", whose webview gets input -> 4 processors -> output', async () => {
		const text = fs.readFileSync(path.join(REPO_ROOT, 'test', 'corpus', 'stateful_polling.yaml'), 'utf8');
		const doc = await open('stateful_polling.yaml', text);
		const handle = await showGraph(doc);
		assert.strictEqual(handle.panel.title, 'Graph: stateful_polling.yaml');
		// The panel's column is set once the workbench has placed it.
		assert.ok(await waitFor(() => handle.panel.viewColumn === vscode.ViewColumn.Two, 10_000), `beside: ${handle.panel.viewColumn}`);
		assert.strictEqual(api().graphPanels.size, 1);
		// The real webview boots, posts `ready` and gets the snapshot.
		assert.ok(await waitFor(() => snapshots(handle).length > 0, 30_000), 'the webview posted ready');
		assert.deepStrictEqual(ids(snapshots(handle)[0]), [
			'input:generate',
			'processor:0:cache',
			'processor:1:catch',
			'processor:2:sql_select',
			'processor:3:unarchive',
			'output:broker',
		]);
		assert.strictEqual(snapshots(handle)[0].edges.length, 5);
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

	test('CLICK / STALE_ID: nodeActivated selects and reveals the node\'s YAML; an unknown id does nothing', async () => {
		const text = fs.readFileSync(path.join(REPO_ROOT, 'test', 'corpus', 'stateful_polling.yaml'), 'utf8');
		const doc = await open('click.yaml', text);
		const handle = await showGraph(doc);
		await handle.receive({ type: 'ready' });
		const node = snapshots(handle).at(-1)!.nodes.find((n) => n.id === 'processor:2:sql_select')!;

		await handle.receive({ type: 'nodeActivated', nodeId: node.id, via: 'click' });
		const editor = vscode.window.activeTextEditor;
		assert.ok(editor, 'the text editor is focused');
		assert.strictEqual(editor.document.uri.toString(), doc.uri.toString());
		assert.strictEqual(editor.viewColumn, vscode.ViewColumn.One);
		assert.strictEqual(doc.offsetAt(editor.selection.start), node.range[0]);
		assert.strictEqual(doc.offsetAt(editor.selection.end), node.range[1]);
		assert.ok(doc.getText(editor.selection).startsWith('- sql_select:'));
		assert.ok(!doc.isDirty, 'nothing edits the text');

		const before = editor.selection;
		await handle.receive({ type: 'nodeActivated', nodeId: 'processor:9:nope', via: 'click' });
		await handle.receive({ type: 'nodeActivated', nodeId: 42, via: 'click' });
		await handle.receive({ type: 'somethingElse' });
		assert.ok(vscode.window.activeTextEditor!.selection.isEqual(before));
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
		assert.deepStrictEqual(ids(snapshots(panelA).at(-1)), ['input:stdin']);
		assert.deepStrictEqual(ids(snapshots(panelB).at(-1)), ['output:stdout']);
		assert.strictEqual(panelB.panel.title, 'Graph: b.yaml');
	});

	test('UNPARSEABLE: a YAML parse error gives a snapshot with an empty model', async () => {
		const doc = await open('broken.yaml', 'input:\n  generate: {\n');
		const handle = await showGraph(doc);
		await handle.receive({ type: 'ready' });
		assert.deepStrictEqual(snapshots(handle).at(-1), { nodes: [], edges: [] });
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
