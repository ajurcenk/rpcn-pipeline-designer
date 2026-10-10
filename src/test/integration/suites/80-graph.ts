import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GRAPH_OPEN_PATHS_KEY, GraphPanels, HIDDEN_GRAPHS_STATE, type GraphPanelHandle, type GraphPanelsOptions } from '../../../adapters/graphPanel/panels';
import { binaryActions, INSTALL_GUIDE_URL, type BinaryNotifier } from '../../../adapters/redpandaConnect/notify';
import { createVsCodeNotifier, type ExtensionApi } from '../../../extension';
import type { HostMessage, HostStatus, NodeStatusById, PipelineModel, SnapshotMessage } from '../../../shared/protocol';
import { makeTempDir, REPO_ROOT } from '../../helpers/fakeBinary';
import { EXTENSION_ID, waitFor } from '../helpers';
import { EXTRA_INPUT, schemaFrom, setBinaryPath, useSchemaBinary } from '../schemaHarness';

// The graph panel through its host-side seam (`graphPanels.panelFor`, `receive`): the tests
// check what the host posts and does, and don't drive the webview DOM (ticket 3.1). The model is
// built with the schema of the fake 4.112.0 binary (ticket 3.3, AD-20).
suite('Pipeline graph (3.1, 3.3, 3.6, 3.7, 3.8, 3.9, 3.10, integration)', function () {
	this.timeout(60_000);
	let dir: string;
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const snapshots = (handle: GraphPanelHandle): PipelineModel[] =>
		handle.posted.flatMap((m) => (m.type === 'snapshot' && m.model ? [m.model] : []));
	const ids = (model: PipelineModel | undefined) => model?.nodes.map((n) => n.id);
	/** The live updates posted (`model` and `parseError`), without the snapshots answering `ready`. */
	const live = (handle: GraphPanelHandle): HostMessage[] => handle.posted.filter((m) => m.type === 'model' || m.type === 'parseError');
	const VALID = 'input:\n  stdin: {}\noutput:\n  stdout: {}\n';
	/** The `selection` node ids posted, in order. */
	const selections = (handle: GraphPanelHandle): (string | null)[] =>
		handle.posted.flatMap((m) => (m.type === 'selection' ? [m.nodeId] : []));
	/** Gives a stray message the time to arrive. */
	const settle = () => new Promise((r) => setTimeout(r, 300));
	/** Moves the cursor of `editor` to `offset`, as the user would (no selection). */
	function moveTo(editor: vscode.TextEditor, offset: number): void {
		const at = editor.document.positionAt(offset);
		editor.selection = new vscode.Selection(at, at);
	}
	/** A switch processor with two cases, two blank top-level lines, and an output (3.7). */
	const SWITCH = [
		'input:',
		'  stdin: {}',
		'',
		'',
		'pipeline:',
		'  processors:',
		'    - switch:',
		'        - check: this.a == 1',
		'          processors:',
		'            - mapping: root = "a"',
		'        - processors:',
		'            - log:',
		'                message: hi',
		'output:',
		'  stdout: {}',
		'',
	].join('\n');
	const SWITCH_ID = 'path:pipeline.processors[0]';
	const MAPPING_ID = 'path:pipeline.processors[0].switch[0].processors[0]';

	/** Opens `text` with its graph, and gets the webview's snapshot (the host seam). */
	async function withGraph(name: string, text: string): Promise<{ doc: vscode.TextDocument; editor: vscode.TextEditor; handle: GraphPanelHandle }> {
		const doc = await open(name, text);
		const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc)!;
		const handle = await showGraph(doc);
		await handle.receive({ type: 'ready' });
		return { doc, editor, handle };
	}

	async function replace(doc: vscode.TextDocument, start: number, end: number, text: string): Promise<void> {
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(end)), text);
		assert.ok(await vscode.workspace.applyEdit(edit));
	}
	const insert = (doc: vscode.TextDocument, at: number, text: string) => replace(doc, at, at, text);

	async function open(name: string, text: string): Promise<vscode.TextDocument> {
		const file = path.join(dir, name);
		fs.writeFileSync(file, text);
		const doc = await vscode.workspace.openTextDocument(file);
		// Not a preview tab: opening the next file must not close this one's tab, and with it its
		// graph (TAB_CLOSE, 3.10).
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
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
	// Lint like the spike (3.8): `nope:` is not recognised, `codec:` is deprecated (a warning).
	const h = useSchemaBinary({ lintFindings: [['nope:', 'field nope not recognised'], ['codec:', 'field codec is deprecated']] });
	setup(async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
	});

	teardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		assert.ok(await waitFor(() => api().graphPanels.size === 0, 10_000), 'closing the editors disposes the panels');
	});

	suiteTeardown(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('contributions / TOGGLE: sentence-case titles and icons; Show graph without a panel, Hide graph with one, in the title and the palette', () => {
		const contributes = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes;
		const command = (id: string) => contributes.commands.find((c: { command: string }) => c.command === id);
		assert.strictEqual(command('redpandaConnect.showGraph')?.title, 'Show graph');
		assert.strictEqual(command('redpandaConnect.hideGraph')?.title, 'Hide graph');
		assert.strictEqual(command('redpandaConnect.showGraph')?.icon, '$(type-hierarchy)');
		assert.strictEqual(command('redpandaConnect.hideGraph')?.icon, '$(eye-closed)');
		type Item = { command: string; when: string; group?: string };
		const palette = Object.fromEntries(contributes.menus.commandPalette.map((m: Item) => [m.command, m.when]));
		assert.strictEqual(palette['redpandaConnect.showGraph'], 'redpandaConnect.activeEditorDetected && resourcePath not in redpandaConnect.graphOpenPaths');
		assert.strictEqual(palette['redpandaConnect.hideGraph'],
			'redpandaConnect.activeEditorDetected && resourcePath in redpandaConnect.graphOpenPaths || activeWebviewPanelId == \'redpandaConnect.graph\'');
		const title = (id: string) => contributes.menus['editor/title'].filter((m: Item) => m.command === id);
		assert.deepStrictEqual(title('redpandaConnect.showGraph'), [{
			command: 'redpandaConnect.showGraph',
			when: 'resourcePath in redpandaConnect.detectedPaths && resourcePath not in redpandaConnect.graphOpenPaths',
			group: 'navigation',
		}]);
		assert.deepStrictEqual(title('redpandaConnect.hideGraph'), [{
			command: 'redpandaConnect.hideGraph',
			when: 'resourcePath in redpandaConnect.detectedPaths && resourcePath in redpandaConnect.graphOpenPaths',
			group: 'navigation',
		}]);
		// No default keybinding.
		assert.ok(!(contributes.keybindings ?? []).some((k: { command: string }) => /Graph$/.test(k.command)));
	});

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

	test('CLICK / STALE_ID: nodeActivated selects and reveals the node\'s YAML; an unknown id does nothing', async () => {
		const text = fs.readFileSync(path.join(REPO_ROOT, 'test', 'corpus', 'stateful_polling.yaml'), 'utf8');
		const doc = await open('click.yaml', text);
		const handle = await showGraph(doc);
		await handle.receive({ type: 'ready' });
		const node = snapshots(handle).at(-1)!.nodes.find((n) => n.id === 'path:pipeline.processors[2]')!;

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
		await handle.receive({ type: 'nodeActivated', nodeId: 'path:pipeline.processors[9]', via: 'click' });
		await handle.receive({ type: 'nodeActivated', nodeId: 42, via: 'click' });
		await handle.receive({ type: 'nodeActivated', nodeId: node.id, via: 'mouse' });
		await handle.receive({ type: 'somethingElse' });
		assert.ok(vscode.window.activeTextEditor!.selection.isEqual(before));
		assert.strictEqual(api().graphPanels.size, 1);
	});

	test('CLICK_CENTRED: a click reveals the node centred, even one already on screen at the top', async () => {
		const filler = Array.from({ length: 300 }, (_, i) => `# filler ${i}`).join('\n');
		const { doc, editor, handle } = await withGraph('centred.yaml', `input:\n  stdin: {}\n${filler}\noutput:\n  stdout: {}\n${filler}\n`);
		const node = snapshots(handle).at(-1)!.nodes.find((n) => n.id === 'path:output')!;
		const line = doc.positionAt(node.range[0]).line;
		// The node on screen near the top: "if outside the viewport" would not scroll.
		editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
		const shown = () => editor.visibleRanges[0];
		const nearTop = () => {
			const v = shown();
			return v !== undefined && v.start.line <= line && line < (v.start.line + v.end.line) / 2 - 2;
		};
		assert.ok(await waitFor(nearTop, 10_000), `the node near the top: ${JSON.stringify(shown())} for line ${line}`);
		const before = shown()!;
		await handle.receive({ type: 'nodeActivated', nodeId: node.id, via: 'click' });
		const active = vscode.window.activeTextEditor!;
		assert.strictEqual(active, editor, 'the driving editor');
		assert.strictEqual(doc.getText(active.selection), 'output:\n  stdout: {}');
		const centred = () => {
			const v = shown();
			return v !== undefined && v.start.line < before.start.line && Math.abs((v.start.line + v.end.line) / 2 - (line + 0.5)) <= 2;
		};
		assert.ok(await waitFor(centred, 10_000), `centred: ${JSON.stringify(shown())} for line ${line}`);
	});

	test('DRIVING / DRIVING_CLOSED: a click selects in the editor the cursor last moved in, else a visible one, else column One', async () => {
		const { doc, editor: one, handle } = await withGraph('driving.yaml', SWITCH);
		// One's cursor in the output, while One has focus.
		moveTo(one, SWITCH.indexOf('stdout'));
		assert.ok(await waitFor(() => selections(handle).at(-1) === 'path:output', 10_000));
		const three = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Three, preserveFocus: false });
		assert.strictEqual(three.viewColumn, vscode.ViewColumn.Three);
		moveTo(three, SWITCH.indexOf('stdin'));
		assert.ok(await waitFor(() => selections(handle).at(-1) === 'path:input', 10_000), 'the cursor in Three drives');
		const editors = () => vscode.window.visibleTextEditors.filter((e) => e.document === doc).length;
		assert.strictEqual(editors(), 2);
		const oneBefore = one.selection;

		// DRIVING: the click selects in Three, and no editor opens.
		await handle.receive({ type: 'nodeActivated', nodeId: SWITCH_ID, via: 'click' });
		let active = vscode.window.activeTextEditor!;
		assert.strictEqual(active.viewColumn, vscode.ViewColumn.Three);
		assert.ok(doc.getText(active.selection).startsWith('- switch:'));
		assert.ok(one.selection.isEqual(oneBefore), 'column One\'s editor is left alone');
		assert.strictEqual(editors(), 2, 'no new editor');

		// A selection change VS Code makes in the other, unfocused editor (no kind: the text moved
		// under its cursor) does not make that editor the driving one. (A programmatic
		// `editor.selection = …` reports kind Command on stable, so an edit makes the shift.)
		// The edit goes below Three's selection (the switch block) and above One's cursor, so only
		// One's cursor shifts.
		assert.strictEqual(vscode.window.activeTextEditor, three);
		const threeBefore = three.selection;
		const kinds: (vscode.TextEditorSelectionChangeKind | undefined)[] = [];
		const watch = vscode.window.onDidChangeTextEditorSelection((e) => {
			if (e.textEditor === one) {
				kinds.push(e.kind);
			}
		});
		try {
			const oneAt = doc.offsetAt(one.selection.start);
			await insert(doc, doc.getText().indexOf('output:'), '# shifted\n');
			assert.ok(await waitFor(() => doc.offsetAt(one.selection.start) === oneAt + '# shifted\n'.length, 10_000), 'One\'s cursor shifted');
			await settle();
			assert.ok(kinds.length > 0 && kinds.every((k) => k === undefined), `kinds: ${kinds}`);
			assert.ok(three.selection.isEqual(threeBefore), 'Three\'s selection did not move');
		} finally {
			watch.dispose();
		}
		await handle.receive({ type: 'nodeActivated', nodeId: 'path:output', via: 'click' });
		active = vscode.window.activeTextEditor!;
		assert.strictEqual(active.viewColumn, vscode.ViewColumn.Three, 'still the driving editor');
		assert.strictEqual(doc.getText(active.selection), 'output:\n  stdout: {}');

		// DRIVING_CLOSED: Three's tab closed, a visible editor for the file is used (column One).
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		assert.ok(await waitFor(() => editors() === 1, 10_000), 'Three closed');
		await handle.receive({ type: 'nodeActivated', nodeId: 'path:output', via: 'click' });
		active = vscode.window.activeTextEditor!;
		assert.strictEqual(active.document, doc);
		assert.strictEqual(active.viewColumn, vscode.ViewColumn.One);
		assert.strictEqual(doc.getText(active.selection), 'output:\n  stdout: {}');

		// No editor for the file is visible: column One.
		const other = await open('driving-other.yaml', VALID);
		assert.ok(await waitFor(() => editors() === 0, 10_000), 'the file hidden');
		await handle.receive({ type: 'nodeActivated', nodeId: 'path:input', via: 'click' });
		active = vscode.window.activeTextEditor!;
		assert.strictEqual(active.document, doc);
		assert.strictEqual(active.viewColumn, vscode.ViewColumn.One);
		assert.strictEqual(doc.getText(active.selection), 'input:\n  stdin: {}');
		assert.ok(!other.isDirty, 'navigation edits no text');
	});

	test('HEADER: activating a switch group selects its whole block', async () => {
		const { doc, handle } = await withGraph('header.yaml', SWITCH);
		await handle.receive({ type: 'nodeActivated', nodeId: SWITCH_ID, via: 'click' });
		const selected = doc.getText(vscode.window.activeTextEditor!.selection);
		assert.ok(selected.startsWith('- switch:'), selected);
		assert.ok(selected.trimEnd().endsWith('message: hi'), selected);
		// The confirmation: the cursor lands in the range, and the selection names the group.
		assert.ok(await waitFor(() => selections(handle).at(-1) === SWITCH_ID, 10_000), `${selections(handle)}`);
	});

	test('CURSOR / CURSOR_SAME / CURSOR_OUTSIDE / FOCUS: the node under the cursor, once per change, and focus stays', async () => {
		const { doc, editor, handle } = await withGraph('cursor.yaml', SWITCH);
		const snapshot = handle.posted.filter((m) => m.type === 'snapshot').at(-1);
		assert.ok(snapshot?.type === 'snapshot');
		assert.strictEqual(snapshot.selection, 'path:input');
		assert.ok(snapshot.model?.nodes.some((n) => n.id === MAPPING_ID), 'the mapping inside the case');
		const count = selections(handle).length;
		// FOCUS: the editor has focus and the panel is not active, before and after every move.
		const focusStays = (when: string) => {
			assert.strictEqual(vscode.window.activeTextEditor, editor, `the YAML editor is active ${when}`);
			assert.strictEqual(handle.panel.active, false, `the panel is not active ${when}`);
		};
		focusStays('before the moves');

		// CURSOR: inside a processor in a switch case, the innermost node.
		moveTo(editor, SWITCH.indexOf('root = "a"'));
		assert.ok(await waitFor(() => selections(handle).length === count + 1, 10_000), 'one selection');
		assert.strictEqual(selections(handle).at(-1), MAPPING_ID);
		focusStays('after a move into a node');

		// CURSOR_SAME: moving within the same node sends nothing.
		moveTo(editor, SWITCH.indexOf('mapping:'));
		moveTo(editor, SWITCH.indexOf('"a"'));
		await settle();
		assert.strictEqual(selections(handle).length, count + 1);
		focusStays('after moves within the node');

		// CURSOR_OUTSIDE: blank top-level lines, null once.
		moveTo(editor, SWITCH.indexOf('\n\n') + 1);
		assert.ok(await waitFor(() => selections(handle).length === count + 2, 10_000), 'a null selection');
		assert.strictEqual(selections(handle).at(-1), null);
		focusStays('after a move outside every node');
		moveTo(editor, SWITCH.indexOf('\n\n') + 2);
		await settle();
		assert.strictEqual(selections(handle).length, count + 2, 'null only once');
		focusStays('after a second move outside');

		// The switch case (a route), then its group.
		moveTo(editor, SWITCH.indexOf('check:'));
		assert.ok(await waitFor(() => selections(handle).at(-1) === 'path:pipeline.processors[0].switch[0]', 10_000), `${selections(handle)}`);

		focusStays('after a move onto a route');
		assert.ok(!doc.isDirty, 'nothing is edited');
		assert.deepStrictEqual(live(handle), [], 'no model without an edit');
	});

	test('AFTER_EDIT: an edit that moves the cursor\'s node sends, after the model, the node now under the cursor', async () => {
		const { doc, editor, handle } = await withGraph('after-edit.yaml', SWITCH);
		moveTo(editor, SWITCH.indexOf('root = "a"'));
		assert.ok(await waitFor(() => selections(handle).at(-1) === MAPPING_ID, 10_000));
		const before = handle.posted.length;
		// A processor inserted above the switch: the mapping is now under processors[1].
		await insert(doc, SWITCH.indexOf('    - switch:'), '    - log:\n        message: first\n');
		const moved = 'path:pipeline.processors[1].switch[0].processors[0]';
		assert.ok(await waitFor(() => selections(handle).at(-1) === moved, 10_000), `${selections(handle)}`);
		const after = handle.posted.slice(before).map((m) => m.type);
		assert.ok(after.indexOf('model') >= 0 && after.indexOf('model') < after.lastIndexOf('selection'), `${after}`);
		assert.ok(doc.getText().slice(doc.offsetAt(editor.selection.start)).startsWith('root = "a"'), 'the cursor moved with its text');
	});

	test('BROKEN / SNAPSHOT: no selection while the YAML does not parse; a snapshot carries the current one', async () => {
		const { doc, editor, handle } = await withGraph('broken-cursor.yaml', SWITCH);
		moveTo(editor, SWITCH.indexOf('root = "a"'));
		assert.ok(await waitFor(() => selections(handle).at(-1) === MAPPING_ID, 10_000));
		// SNAPSHOT: a recreated webview gets the current selection.
		await handle.receive({ type: 'ready' });
		const snapshot = (): SnapshotMessage => {
			const last = handle.posted.filter((m) => m.type === 'snapshot').at(-1);
			assert.ok(last?.type === 'snapshot');
			return last;
		};
		assert.strictEqual(snapshot().selection, MAPPING_ID);

		await insert(doc, doc.getText().indexOf('output:'), ' ');
		assert.ok(await waitFor(() => live(handle).some((m) => m.type === 'parseError'), 10_000));
		const count = selections(handle).length;
		moveTo(editor, doc.getText().indexOf('stdin'));
		await settle();
		moveTo(editor, doc.getText().indexOf('\n\n') + 1);
		await settle();
		assert.strictEqual(selections(handle).length, count, 'no selection while broken');
		// A snapshot while broken keeps the highlight as it was.
		await handle.receive({ type: 'ready' });
		assert.strictEqual(snapshot().selection, MAPPING_ID);

		// The next valid model recomputes it: the cursor is now on a blank line.
		await replace(doc, doc.getText().indexOf(' output:'), doc.getText().indexOf(' output:') + 1, '');
		assert.ok(await waitFor(() => selections(handle).at(-1) === null, 10_000), `${selections(handle)}`);
	});

	test('OTHER_FILE: cursor moves in a file without a panel post nothing', async () => {
		const { handle } = await withGraph('other-with-panel.yaml', SWITCH);
		await settle();
		const count = handle.posted.length;
		const b = await open('other-without-panel.yaml', SWITCH);
		const editor = vscode.window.visibleTextEditors.find((e) => e.document === b)!;
		moveTo(editor, SWITCH.indexOf('root = "a"'));
		await settle();
		moveTo(editor, SWITCH.indexOf('output:'));
		await settle();
		assert.strictEqual(api().graphPanels.panelFor(b.uri), undefined);
		assert.deepStrictEqual(handle.posted.slice(count), [], 'nothing posted for the other file');
	});

	test('KEYBOARD: nodeActivated via keyboard selects the node, as a click does', async () => {
		const text = fs.readFileSync(path.join(REPO_ROOT, 'test', 'corpus', 'stateful_polling.yaml'), 'utf8');
		const doc = await open('keyboard.yaml', text);
		const handle = await showGraph(doc);
		await handle.receive({ type: 'ready' });
		const node = snapshots(handle).at(-1)!.nodes.find((n) => n.id === 'path:pipeline.processors[3]')!;
		await handle.receive({ type: 'nodeActivated', nodeId: node.id, via: 'keyboard' });
		const editor = vscode.window.activeTextEditor!;
		assert.strictEqual(editor.document.uri.toString(), doc.uri.toString());
		assert.strictEqual(doc.getText(editor.selection), '- unarchive:\n        format: json_array');
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

	test('BANNER_CLICK: bannerClicked selects the parse error in the file\'s editor; ignored when the YAML parses', async () => {
		const text = 'input:\n  stdin: {}\n bad: 1\noutput:\n  stdout: {}\n';
		const doc = await open('banner.yaml', text);
		const handle = await showGraph(doc);
		await handle.receive({ type: 'ready' });
		const error = handle.posted.find((m) => m.type === 'snapshot' && m.parseError);
		assert.ok(error?.type === 'snapshot' && error.parseError);
		await handle.receive({ type: 'bannerClicked' });
		const editor = vscode.window.activeTextEditor;
		assert.ok(editor, 'the text editor is focused');
		assert.strictEqual(editor.document.uri.toString(), doc.uri.toString());
		assert.strictEqual(editor.viewColumn, vscode.ViewColumn.One);
		assert.strictEqual(doc.offsetAt(editor.selection.start), error.parseError.range[0]);
		// The parser marks one character; the selection runs to the end of that line.
		assert.deepStrictEqual(error.parseError.range, [text.indexOf(' bad'), text.indexOf(' bad') + 1]);
		assert.strictEqual(doc.getText(editor.selection), ' bad: 1');
		assert.ok(!doc.isDirty, 'nothing edits the text');

		// Once the YAML parses, a (late) click does nothing.
		await replace(doc, text.indexOf(' bad'), text.indexOf('output:'), '');
		const before = editor.selection;
		await handle.receive({ type: 'bannerClicked' });
		assert.ok(vscode.window.activeTextEditor!.selection.isEqual(before));
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

	/** A GraphPanels of the test's own, on the extension's binary and schema unless overridden. */
	function testPanels(overrides: Partial<GraphPanelsOptions> = {}): GraphPanels {
		return new GraphPanels({
			extensionUri: vscode.extensions.getExtension(EXTENSION_ID)!.extensionUri,
			log: () => undefined,
			binary: api().redpandaConnect,
			schema: api().schemaStore,
			diagnostics: { diagnosticsFor: () => [], onDidChangeDiagnostics: () => ({ dispose: () => undefined }) },
			actions: undefined,
			// Not VS Code's context key, which the extension's own registry owns.
			setContext: () => undefined,
			...overrides,
		});
	}

	test('NO_SCHEMA: with an ok binary and no schema the panel answers ready with no model', async () => {
		const doc = await open('no-schema.yaml', 'input:\n  stdin: {}\noutput:\n  stdout: {}\n');
		const panels = testPanels({
			schema: { current: undefined, loading: false, onDidChange: () => ({ dispose: () => undefined }), settled: async () => undefined },
		});
		try {
			const handle = await panels.show(doc.uri);
			assert.ok(handle, 'a graph panel for the file');
			await handle.receive({ type: 'ready' });
			const snapshot = handle.posted.filter((m): m is SnapshotMessage => m.type === 'snapshot').at(-1);
			assert.strictEqual(snapshot?.model, null);
			assert.deepStrictEqual(snapshot.hostStatus, { binary: 'ok', schema: 'none' });
			// An edit sends no model either.
			await insert(doc, 0, '# x\n');
			await settle();
			assert.deepStrictEqual(live(handle), []);
		} finally {
			panels.dispose();
		}
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
	// Node status (3.8, AD-17).
	/** The `nodeStatus` messages posted, in order. */
	const statuses = (handle: GraphPanelHandle): NodeStatusById[] =>
		handle.posted.flatMap((m) => (m.type === 'nodeStatus' ? [m.byId] : []));
	/** A switch whose first case holds a log with an unknown field, and an output with a deprecated one. */
	const STATUS = [
		'input:',
		'  stdin: {}',
		'pipeline:',
		'  processors:',
		'    - switch:',
		'        - check: this.a == 1',
		'          processors:',
		'            - log:',
		'                message: hi',
		'                nope: 1',
		'        - processors:',
		'            - mapping: root = "b"',
		'output:',
		'  file:',
		'    path: out.txt',
		'    codec: lines',
		'',
	].join('\n');
	const CASE0_ID = `${SWITCH_ID}.switch[0]`;
	const LOG_ID = `${CASE0_ID}.processors[0]`;
	const NOPE = 'field nope not recognised';
	const CODEC = 'field codec is deprecated';

	test('SEND / CLEAR: a save whose lint reports an error and a deprecation marks those nodes and their groups; the first edit clears them', async () => {
		const { doc, handle } = await withGraph('status.yaml', STATUS);
		const edit = new vscode.WorkspaceEdit();
		edit.insert(doc.uri, doc.positionAt(doc.getText().length), '\n');
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.ok(await doc.save());
		assert.ok(await waitFor(() => statuses(handle).at(-1)?.[LOG_ID] !== undefined, 15_000),
			`${JSON.stringify(statuses(handle))}\n${api().outputLines().slice(-5).join('\n')}`);
		assert.deepStrictEqual(statuses(handle).at(-1), {
			[SWITCH_ID]: { severity: 'error', messages: [NOPE] },
			[CASE0_ID]: { severity: 'error', messages: [NOPE] },
			[LOG_ID]: { severity: 'error', own: 'error', messages: [NOPE], ownMessages: [NOPE] },
			'path:output': { severity: 'warning', own: 'warning', messages: [CODEC], ownMessages: [CODEC] },
		});
		// SNAPSHOT: a recreated webview gets the current status.
		await handle.receive({ type: 'ready' });
		const snapshot = handle.posted.filter((m) => m.type === 'snapshot').at(-1);
		assert.ok(snapshot?.type === 'snapshot');
		assert.deepStrictEqual(snapshot.nodeStatus, statuses(handle).at(-1));

		// CLEAR: the first edit after the save clears lint's findings, and so their markers.
		const count = statuses(handle).length;
		await insert(doc, 0, '# x\n');
		assert.ok(await waitFor(() => statuses(handle).length > count, 10_000), 'a new status');
		assert.deepStrictEqual(statuses(handle).at(-1), {});
	});

	/** A GraphPanels whose diagnostics the test sets (and fires) itself. */
	function fakeDiagnostics() {
		const emitter = new vscode.EventEmitter<vscode.Uri>();
		let current: vscode.Diagnostic[] = [];
		const panels = testPanels({ diagnostics: { diagnosticsFor: () => current, onDidChangeDiagnostics: emitter.event } });
		return {
			panels,
			set(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]) {
				current = diagnostics;
				emitter.fire(uri);
			},
			dispose() {
				panels.dispose();
				emitter.dispose();
			},
		};
	}

	test('SAME / FROZEN / SNAPSHOT: an unchanged status is not sent again; while broken nothing is sent and the snapshot keeps the last one', async () => {
		const doc = await open('status-fake.yaml', STATUS);
		const fake = fakeDiagnostics();
		try {
			const handle = (await fake.panels.show(doc.uri))!;
			assert.ok(handle, 'a graph panel for the file');
			await handle.receive({ type: 'ready' });
			const at = (needle: string, delta = 0) => {
				const start = doc.positionAt(doc.getText().indexOf(needle) + delta);
				return new vscode.Range(start, start.translate(0, 1));
			};
			const warn = new vscode.Diagnostic(at('message: hi'), 'Property message is odd', vscode.DiagnosticSeverity.Warning);
			warn.source = 'yaml-schema: test';
			fake.set(doc.uri, [warn]);
			assert.ok(await waitFor(() => statuses(handle).length === 1, 10_000), 'one status');
			const sent = statuses(handle)[0];
			assert.deepStrictEqual(sent[LOG_ID], { severity: 'warning', own: 'warning', messages: ['Property message is odd'], ownMessages: ['Property message is odd'] });
			assert.deepStrictEqual(sent[SWITCH_ID], { severity: 'warning', messages: ['Property message is odd'] });

			// SAME: the diagnostics change (another column of the same node), the mapped status does not.
			const moved = new vscode.Diagnostic(at('message: hi', 'message: '.length), 'Property message is odd', vscode.DiagnosticSeverity.Warning);
			moved.source = 'yaml-schema: test';
			fake.set(doc.uri, [moved]);
			fake.set(doc.uri, [moved]);
			await settle();
			assert.strictEqual(statuses(handle).length, 1, 'no new nodeStatus');
			// Information and Hint mark nothing either.
			fake.set(doc.uri, [moved, new vscode.Diagnostic(at('stdin'), 'info', vscode.DiagnosticSeverity.Information)]);
			await settle();
			assert.strictEqual(statuses(handle).length, 1, 'no new nodeStatus for Information');

			// FROZEN: while the YAML does not parse, diagnostics changes send nothing.
			await insert(doc, doc.getText().indexOf('output:'), ' ');
			assert.ok(await waitFor(() => live(handle).some((m) => m.type === 'parseError'), 10_000));
			fake.set(doc.uri, []);
			await settle();
			assert.strictEqual(statuses(handle).length, 1, 'frozen while broken');
			// SNAPSHOT: a recreated webview gets the frozen status.
			await handle.receive({ type: 'ready' });
			const snapshot = handle.posted.filter((m) => m.type === 'snapshot').at(-1);
			assert.ok(snapshot?.type === 'snapshot' && snapshot.parseError);
			assert.deepStrictEqual(snapshot.nodeStatus, sent);

			// The next valid model sends the recomputed status, after the model.
			const before = handle.posted.length;
			await replace(doc, doc.getText().indexOf(' output:'), doc.getText().indexOf(' output:') + 1, '');
			assert.ok(await waitFor(() => statuses(handle).length === 2, 10_000), 'the recomputed status');
			assert.deepStrictEqual(statuses(handle)[1], {});
			const after = handle.posted.slice(before).map((m) => m.type);
			assert.ok(after.indexOf('model') >= 0 && after.indexOf('model') < after.indexOf('nodeStatus'), `${after}`);
		} finally {
			fake.dispose();
		}
	});

	test('NO_PANEL: diagnostics of a file without a panel post nothing', async () => {
		const doc = await open('status-a.yaml', STATUS);
		const other = await open('status-b.yaml', STATUS);
		const fake = fakeDiagnostics();
		try {
			const handle = (await fake.panels.show(doc.uri))!;
			await handle.receive({ type: 'ready' });
			const count = handle.posted.length;
			const d = new vscode.Diagnostic(new vscode.Range(1, 2, 1, 7), 'x', vscode.DiagnosticSeverity.Error);
			fake.set(other.uri, [d]);
			await settle();
			// (The real webview's own `ready` may still be answered with a snapshot meanwhile.)
			assert.deepStrictEqual(handle.posted.slice(count).filter((m) => m.type !== 'snapshot'), []);
			assert.strictEqual(fake.panels.panelFor(other.uri), undefined);
		} finally {
			fake.dispose();
		}
	});
	// Host status and empty states (3.9, AD-9, AD-20).
	/** The `hostStatus` messages posted, in order. */
	const hostStatuses = (handle: GraphPanelHandle): HostStatus[] =>
		handle.posted.flatMap((m) => (m.type === 'hostStatus' ? [{ binary: m.binary, schema: m.schema }] : []));
	const lastSnapshot = (handle: GraphPanelHandle) => handle.posted.filter((m): m is SnapshotMessage => m.type === 'snapshot').at(-1);
	const models = (handle: GraphPanelHandle): PipelineModel[] => handle.posted.flatMap((m) => (m.type === 'model' ? [m.model] : []));

	/** Points `redpandaConnect.binaryPath` at a file that is not there and waits for `missing` with no schema. */
	async function loseBinary(name: string): Promise<string> {
		const missing = path.join(h.dir, name);
		fs.rmSync(missing, { force: true });
		await setBinaryPath(missing);
		assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'missing' && api().schemaStore.current === undefined, 15_000),
			`binaryState: ${JSON.stringify(api().redpandaConnect.state)}`);
		return missing;
	}
	async function restoreBinary(): Promise<void> {
		await setBinaryPath(h.fakeBinary);
		await schemaFrom(h.fakeBinary, '4.112.0');
	}

	/** The binary warning's actions on the extension's binary, with a fake picker and browser (the real ones need a human). */
	function fakeActions() {
		const log: string[] = [];
		const opened: string[] = [];
		const warned: string[] = [];
		const fake = { picked: undefined as string | undefined };
		const notifier: BinaryNotifier = {
			...createVsCodeNotifier((line) => log.push(line)),
			showWarning: async (message) => { warned.push(message); return undefined; },
			openExternal: async (url) => { opened.push(url); },
			pickBinary: async () => fake.picked,
		};
		let shown = 0;
		const actions = binaryActions(api().redpandaConnect, notifier, (line) => log.push(line), {
			get shown() { return shown; },
			show: (message) => { shown++; warned.push(message); },
		});
		return { actions, fake, opened, warned, log };
	}

	test('MISSING / SET_PATH: no binary gives no model and the no-binary status; Set path draws the graph in the same panel', async () => {
		const doc = await open('missing.yaml', VALID);
		await loseBinary('not-there');
		const { actions, fake } = fakeActions();
		const panels = testPanels({ actions });
		try {
			const handle = (await panels.show(doc.uri))!;
			await handle.receive({ type: 'ready' });
			const snapshot = lastSnapshot(handle);
			assert.strictEqual(snapshot?.model, null);
			assert.deepStrictEqual(snapshot.hostStatus, { binary: 'missing', schema: 'none' });
			assert.deepStrictEqual(live(handle), [], 'no model while the binary is missing');

			// The pick is cancelled: nothing changes.
			const count = handle.posted.length;
			await handle.receive({ type: 'setPathRequested' });
			await settle();
			assert.strictEqual(api().redpandaConnect.state.kind, 'missing');
			assert.deepStrictEqual(handle.posted.slice(count).filter((m) => m.type !== 'snapshot'), []);

			fake.picked = h.fakeBinary;
			await handle.receive({ type: 'setPathRequested' });
			assert.ok(await waitFor(() => models(handle).length > 0, 30_000),
				`no model after Set path: ${JSON.stringify(handle.posted.map((m) => m.type))}\n${api().outputLines().slice(-5).join('\n')}`);
			assert.deepStrictEqual(ids(models(handle)[0]), ['path:input', 'path:output']);
			// hostStatus, then the model.
			const types = handle.posted.map((m) => m.type);
			assert.ok(types.lastIndexOf('hostStatus') < types.indexOf('model'), `${types}`);
			assert.deepStrictEqual(hostStatuses(handle).at(-1), { binary: 'ok', schema: 'ok' });
			assert.strictEqual(vscode.workspace.getConfiguration('redpandaConnect').inspect<string>('binaryPath')?.globalValue, h.fakeBinary);
		} finally {
			panels.dispose();
			await restoreBinary();
		}
	});

	test('RETRY: Retry with nothing fixed changes nothing; after the binary is fixed outside, the graph draws in the same panel', async () => {
		const doc = await open('retry.yaml', VALID);
		const missing = await loseBinary('installed-later');
		const { actions } = fakeActions();
		const panels = testPanels({ actions });
		try {
			const handle = (await panels.show(doc.uri))!;
			await handle.receive({ type: 'ready' });
			assert.deepStrictEqual(lastSnapshot(handle)?.hostStatus, { binary: 'missing', schema: 'none' });
			await handle.receive({ type: 'retryRequested' });
			await settle();
			assert.deepStrictEqual(hostStatuses(handle), [], 'still missing: the state stays');
			assert.deepStrictEqual(live(handle), []);

			// Installed outside VS Code: the setting does not change, so only Retry notices.
			fs.copyFileSync(h.fakeBinary, missing);
			fs.chmodSync(missing, 0o755);
			await handle.receive({ type: 'retryRequested' });
			assert.ok(await waitFor(() => models(handle).length > 0, 30_000), `no model after Retry: ${JSON.stringify(api().redpandaConnect.state)}`);
			assert.deepStrictEqual(ids(models(handle)[0]), ['path:input', 'path:output']);
			assert.deepStrictEqual(hostStatuses(handle).at(-1), { binary: 'ok', schema: 'ok' });
		} finally {
			panels.dispose();
			await restoreBinary();
			fs.rmSync(missing, { force: true });
		}
	});

	test('GUIDE: installGuideRequested opens the install guide', async () => {
		const doc = await open('guide.yaml', VALID);
		const { actions, opened } = fakeActions();
		const panels = testPanels({ actions });
		try {
			const handle = (await panels.show(doc.uri))!;
			await handle.receive({ type: 'installGuideRequested' });
			assert.deepStrictEqual(opened, [INSTALL_GUIDE_URL]);
		} finally {
			panels.dispose();
		}
	});

	test('LATE_SCHEMA: a panel open while the schema loads gets the model when it arrives, with no ready', async () => {
		const doc = await open('late-schema.yaml', `input:\n  ${EXTRA_INPUT}: {}\n`);
		await loseBinary('late');
		const panels = testPanels();
		try {
			const handle = (await panels.show(doc.uri))!;
			await handle.receive({ type: 'ready' });
			assert.strictEqual(lastSnapshot(handle)?.model, null);
			await setBinaryPath(h.changedBinary);
			assert.ok(await waitFor(() => models(handle).length > 0, 30_000), `no model: ${JSON.stringify(handle.posted.map((m) => m.type))}`);
			assert.strictEqual(models(handle)[0].nodes[0]?.component, EXTRA_INPUT, 'built with the new schema');
			assert.deepStrictEqual(hostStatuses(handle).at(-1), { binary: 'ok', schema: 'ok' });
			// Any status before the last one is the loading one (timing decides whether it is seen).
			for (const status of hostStatuses(handle).slice(0, -1)) {
				assert.deepStrictEqual(status, { binary: 'ok', schema: 'loading' });
			}
		} finally {
			panels.dispose();
			await restoreBinary();
		}
	});

	test('LOST: the binary going missing while a graph is shown sends hostStatus and no model', async () => {
		const { doc, handle } = await withGraph('lost.yaml', VALID);
		let back = 0;
		try {
			assert.ok(lastSnapshot(handle)?.model);
			const count = handle.posted.length;
			await loseBinary('lost');
			assert.ok(await waitFor(() => hostStatuses(handle).some((s) => s.binary === 'missing'), 10_000), JSON.stringify(hostStatuses(handle)));
			assert.deepStrictEqual(hostStatuses(handle).at(-1), { binary: 'missing', schema: 'none' });
			// Edits send nothing while there is no schema, a broken one included.
			await insert(doc, doc.getText().indexOf('output:'), ' ');
			await settle();
			assert.deepStrictEqual(handle.posted.slice(count).filter((m) => m.type === 'model' || m.type === 'parseError'), []);
			back = handle.posted.length;
		} finally {
			await restoreBinary();
		}
		// The schema is back while the YAML does not parse: the last valid graph, then the banner (as a snapshot shows it).
		assert.ok(await waitFor(() => handle.posted.slice(back).some((m) => m.type === 'parseError'), 10_000),
			JSON.stringify(handle.posted.slice(back).map((m) => m.type)));
		const after = handle.posted.slice(back).filter((m) => m.type === 'model' || m.type === 'parseError');
		assert.deepStrictEqual(after.map((m) => m.type), ['model', 'parseError']);
		assert.deepStrictEqual(ids(after[0].type === 'model' ? after[0].model : undefined), ['path:input', 'path:output']);
		// Undo the inserted space: the file is valid again.
		const broken = doc.getText().indexOf(' output:');
		await replace(doc, broken, broken + 1, '');
		assert.strictEqual(doc.getText(), VALID);
	});

	test('NOTHING: a valid config with no pipeline sections gives a model with no nodes; typing an input draws it', async () => {
		const { handle } = await withGraph('nothing.yaml', 'http: {}\n');
		assert.deepStrictEqual(lastSnapshot(handle)?.model, { nodes: [], edges: [] });
		assert.deepStrictEqual(lastSnapshot(handle)?.hostStatus, { binary: 'ok', schema: 'ok' });

		const empty = await withGraph('empty.yaml', '');
		assert.deepStrictEqual(lastSnapshot(empty.handle)?.model, { nodes: [], edges: [] });
		await insert(empty.doc, 0, 'input:\n  stdin: {}\n');
		assert.ok(await waitFor(() => models(empty.handle).some((m) => m.nodes.length > 0), 10_000));
		assert.deepStrictEqual(ids(models(empty.handle).at(-1)), ['path:input']);
	});

	test('RESOURCES_ONLY: only *_resources draws the resources', async () => {
		const { handle } = await withGraph('resources-only.yaml', 'cache_resources:\n  - label: inmem\n    memory: {}\n');
		assert.deepStrictEqual(ids(lastSnapshot(handle)?.model ?? undefined), ['res:cache:inmem']);
	});

	// Auto-open, the Hide graph toggle and per-file memory (3.10, spike 3.14). The root hook turns
	// auto-open off for every suite; these tests turn it on.
	const setAutoOpen = (on: boolean) =>
		vscode.workspace.getConfiguration('redpandaConnect').update('autoOpenGraph', on, vscode.ConfigurationTarget.Global);
	async function withAutoOpen(run: () => Promise<void>): Promise<void> {
		await setAutoOpen(true);
		try {
			await run();
		} finally {
			await setAutoOpen(false);
		}
	}
	/** The column of the tab group holding a text tab of `uri`. */
	const tabColumn = (uri: vscode.Uri): vscode.ViewColumn | undefined => vscode.window.tabGroups.all.find((g) =>
		g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString()))?.viewColumn;
	/** A `workspaceState` of the test's own. */
	function fakeMemento(): vscode.Memento {
		const store = new Map<string, unknown>();
		return {
			keys: () => [...store.keys()],
			get: (key: string, fallback?: unknown) => (store.has(key) ? store.get(key) : fallback),
			update: async (key: string, value: unknown) => {
				store.set(key, value);
			},
		} as vscode.Memento;
	}
	/** Waits for the file's auto-opened panel and its lock sequence. */
	async function autoOpened(doc: vscode.TextDocument, panels: GraphPanels = api().graphPanels): Promise<GraphPanelHandle> {
		assert.ok(await waitFor(() => panels.panelFor(doc.uri) !== undefined, 10_000), 'the graph auto-opened');
		await panels.idle();
		return panels.panelFor(doc.uri)!;
	}

	test('AUTO: a detected file shown for the first time gets one graph beside it, in a locked group, with focus in the YAML', async () => {
		await withAutoOpen(async () => {
			const doc = await open('auto.yaml', VALID);
			const handle = await autoOpened(doc);
			assert.strictEqual(api().graphPanels.size, 1);
			assert.strictEqual(handle.panel.title, 'Graph: auto.yaml');
			assert.ok(await waitFor(() => handle.panel.viewColumn === vscode.ViewColumn.Two, 10_000), `beside: ${handle.panel.viewColumn}`);
			// Focus is back in the YAML (spike step 5).
			assert.ok(await waitFor(() => vscode.window.activeTextEditor?.document === doc, 10_000), 'the YAML editor is active');
			assert.strictEqual(vscode.window.activeTextEditor?.viewColumn, vscode.ViewColumn.One);
			assert.strictEqual(vscode.window.tabGroups.activeTabGroup.viewColumn, vscode.ViewColumn.One);
			// A file opened with no column lands in the YAML group.
			const notes = vscode.Uri.file(path.join(dir, 'auto-notes.txt'));
			fs.writeFileSync(notes.fsPath, 'notes\n');
			await vscode.commands.executeCommand('vscode.open', notes);
			assert.ok(await waitFor(() => tabColumn(notes) !== undefined, 10_000));
			assert.strictEqual(tabColumn(notes), vscode.ViewColumn.One);
			// The graph's group is locked: with it active, a file opened with no column still goes
			// to the YAML group (spike step 6; without the lock it would go into the graph group).
			handle.panel.reveal(undefined, false);
			assert.ok(await waitFor(() => handle.panel.active, 10_000), 'the graph is active');
			const more = vscode.Uri.file(path.join(dir, 'auto-more.txt'));
			fs.writeFileSync(more.fsPath, 'more\n');
			await vscode.commands.executeCommand('vscode.open', more);
			assert.ok(await waitFor(() => tabColumn(more) !== undefined, 10_000));
			assert.notStrictEqual(tabColumn(more), handle.panel.viewColumn, 'not in the graph group');
			assert.strictEqual(vscode.window.tabGroups.all.length, 2, 'no new group');
			assert.ok(!api().outputLines().some((l) => /not locked|could not (lock|return focus)/.test(l)), 'the lock sequence logged no failure');
		});
	});

	test('AUTO_ONCE: the same file closed and shown again in the session gets no second auto-open', async () => {
		await withAutoOpen(async () => {
			const doc = await open('auto-once.yaml', VALID);
			await autoOpened(doc);
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			assert.ok(await waitFor(() => api().graphPanels.size === 0, 10_000));
			await open('auto-once.yaml', VALID);
			await settle();
			await api().graphPanels.idle();
			assert.strictEqual(api().graphPanels.size, 0);
		});
	});

	test('AUTO_OFF: with autoOpenGraph false no panel opens; Show graph still works', async () => {
		assert.strictEqual(vscode.workspace.getConfiguration('redpandaConnect').get('autoOpenGraph'), false);
		const doc = await open('auto-off.yaml', VALID);
		await settle();
		await api().graphPanels.idle();
		assert.strictEqual(api().graphPanels.size, 0);
		await showGraph(doc);
		assert.strictEqual(api().graphPanels.size, 1);
	});

	test('TYPED: a file that becomes detected while typing does not auto-open', async () => {
		await withAutoOpen(async () => {
			const doc = await open('typed.yaml', '# draft\n');
			assert.ok(!api().detection.isDetected(doc.uri), 'not detected yet');
			await insert(doc, doc.getText().length, VALID);
			assert.ok(await waitFor(() => api().detection.isDetected(doc.uri), 10_000), 'detected after the edit');
			await settle();
			await api().graphPanels.idle();
			assert.strictEqual(api().graphPanels.size, 0);
		});
	});

	test('UNTITLED: an untitled detected document never auto-opens', async () => {
		await withAutoOpen(async () => {
			const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: VALID });
			await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
			assert.ok(await waitFor(() => api().detection.isDetected(doc.uri), 10_000), 'detected');
			await settle();
			await api().graphPanels.idle();
			assert.strictEqual(api().graphPanels.size, 0);
			await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
		});
	});

	test('HIDE / HIDDEN / SHOW: Hide graph closes the panel and stores the Hide; after a reload no auto-open until Show graph', async () => {
		const memento = fakeMemento();
		const options = { memento, autoOpen: () => true, detection: api().detection };
		const before = testPanels(options);
		let after: GraphPanels | undefined;
		try {
			const doc = await open('hidden.yaml', VALID);
			await autoOpened(doc, before);
			await before.hide(doc.uri);
			assert.strictEqual(before.panelFor(doc.uri), undefined, 'HIDE: the panel closed');
			assert.deepStrictEqual(memento.get(HIDDEN_GRAPHS_STATE), [doc.uri.toString()]);
			// "Reload": a new registry on the same memento, with the file shown at its activation.
			before.dispose();
			after = testPanels(options);
			assert.ok(after.isHidden(doc.uri), 'the Hide is read at activation');
			await settle();
			await after.idle();
			assert.strictEqual(after.size, 0, 'HIDDEN: no auto-open');
			// SHOW: clears the Hide and opens the panel.
			const handle = await after.show(doc.uri);
			assert.ok(handle);
			assert.strictEqual(after.panelFor(doc.uri), handle);
			assert.ok(!after.isHidden(doc.uri));
			assert.deepStrictEqual(memento.get(HIDDEN_GRAPHS_STATE), []);
		} finally {
			before.dispose();
			after?.dispose();
		}
	});

	test('HIDE (command): Hide graph with no argument hides the active file; closing by the panel is not a Hide', async () => {
		const doc = await open('hide-command.yaml', VALID);
		const handle = await showGraph(doc);
		handle.panel.dispose();
		assert.ok(!api().graphPanels.isHidden(doc.uri), 'the × is not a Hide');
		await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
		await showGraph(doc);
		await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
		await vscode.commands.executeCommand('redpandaConnect.hideGraph');
		assert.strictEqual(api().graphPanels.panelFor(doc.uri), undefined);
		assert.ok(api().graphPanels.isHidden(doc.uri));
		await showGraph(doc);
		assert.ok(!api().graphPanels.isHidden(doc.uri), 'Show graph clears the Hide');
	});

	test('SHOW: Show graph on a never-detected file marks it detected and opens its panel', async () => {
		const doc = await open('never.yaml', 'a: 1\n');
		assert.ok(!api().detection.isDetected(doc.uri));
		await showGraph(doc);
		assert.ok(api().detection.isDetected(doc.uri), 'marked detected');
	});

	test('SECOND: a second file\'s graph lands in the existing graph group; no new group', async () => {
		const a = await open('second-a.yaml', VALID);
		const panelA = await showGraph(a);
		assert.ok(await waitFor(() => panelA.panel.viewColumn === vscode.ViewColumn.Two, 10_000));
		const b = await open('second-b.yaml', VALID);
		const panelB = await showGraph(b);
		// The explicit column is not refused by the locked group (spike rec. 2).
		assert.ok(await waitFor(() => panelB.panel.viewColumn === panelA.panel.viewColumn, 10_000), `B in ${panelB.panel.viewColumn}`);
		assert.strictEqual(vscode.window.tabGroups.all.length, 2, 'no new group');
		assert.strictEqual(vscode.window.activeTextEditor?.document, b, 'focus back in B');
		assert.strictEqual(vscode.window.activeTextEditor?.viewColumn, vscode.ViewColumn.One);
		// Locking the already-locked graph group again leaves it locked: with it active, a file
		// opened with no column lands in the YAML group.
		panelB.panel.reveal(undefined, false);
		assert.ok(await waitFor(() => panelB.panel.active, 10_000), 'the graph is active');
		const third = vscode.Uri.file(path.join(dir, 'second-third.txt'));
		fs.writeFileSync(third.fsPath, 'third\n');
		await vscode.commands.executeCommand('vscode.open', third);
		assert.ok(await waitFor(() => tabColumn(third) !== undefined, 10_000));
		assert.strictEqual(tabColumn(third), vscode.ViewColumn.One, 'in the YAML group');
		assert.strictEqual(vscode.window.tabGroups.all.length, 2, 'still no new group');
	});

	test('TAB_CLOSE: closing the file\'s last YAML tab closes its graph; another tab of it keeps it', async () => {
		const doc = await open('tab-close.yaml', VALID);
		const handle = await showGraph(doc);
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Three, preview: false });
		const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs)
			.filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === doc.uri.toString());
		assert.ok(await waitFor(() => tabs().length === 2, 10_000));
		await vscode.window.tabGroups.close(tabs()[1]);
		await settle();
		assert.strictEqual(api().graphPanels.panelFor(doc.uri), handle, 'one YAML tab left: the graph stays');
		await vscode.window.tabGroups.close(tabs()[0]);
		assert.ok(await waitFor(() => api().graphPanels.panelFor(doc.uri) === undefined, 10_000), 'the graph closed');
	});

	test('TOGGLE (context): graphOpenPaths lists the files with an open panel', async () => {
		const keys: unknown[] = [];
		const panels = testPanels({ setContext: (key, value) => key === GRAPH_OPEN_PATHS_KEY && keys.push(value) });
		try {
			const doc = await open('toggle.yaml', VALID);
			const handle = (await panels.show(doc.uri))!;
			assert.deepStrictEqual(keys.at(-1), [doc.uri.fsPath]);
			handle.panel.dispose();
			assert.deepStrictEqual(keys.at(-1), []);
		} finally {
			panels.dispose();
		}
	});

	test('RENAME: a file with a panel and a hidden file are renamed: panel, title and Hide move, and the model keeps following', async () => {
		const oldA = await open('rename-a.yaml', VALID);
		const handle = await showGraph(oldA);
		const oldB = await open('rename-b.yaml', VALID);
		await vscode.commands.executeCommand('redpandaConnect.hideGraph', oldB.uri);
		const newA = vscode.Uri.file(path.join(dir, 'renamed-a.yaml'));
		const newB = vscode.Uri.file(path.join(dir, 'renamed-b.yaml'));
		const edit = new vscode.WorkspaceEdit();
		edit.renameFile(oldA.uri, newA);
		edit.renameFile(oldB.uri, newB);
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.ok(await waitFor(() => api().graphPanels.panelFor(newA) === handle, 10_000), 'the panel is keyed by the new URI');
		assert.strictEqual(api().graphPanels.panelFor(oldA.uri), undefined);
		assert.strictEqual(handle.uri.toString(), newA.toString());
		assert.strictEqual(handle.panel.title, 'Graph: renamed-a.yaml');
		assert.ok(api().graphPanels.isHidden(newB), 'the Hide moved');
		assert.ok(!api().graphPanels.isHidden(oldB.uri));
		await settle();
		assert.strictEqual(api().graphPanels.panelFor(newA), handle, 'the rename did not close the graph');
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === newA.toString());
		assert.ok(doc, 'the renamed document is open');
		const posted = live(handle).length;
		await insert(doc, doc.getText().indexOf('output:'), 'pipeline:\n  processors:\n    - mapping: root = this\n');
		assert.ok(await waitFor(() => live(handle).length > posted, 10_000), 'the model follows the renamed file');
		const last = live(handle).at(-1);
		assert.ok(last?.type === 'model');
		assert.deepStrictEqual(ids(last.model), ['path:input', 'path:pipeline.processors[0]', 'path:output']);
		await api().graphPanels.show(newB);
	});
});
