import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GraphPanelHandle } from '../../../adapters/graphPanel/panels';
import type { SnapshotMessage } from '../../../shared/protocol';
import { REPO_ROOT } from '../../helpers/fakeBinary';
import { waitFor } from '../helpers';
import { snapshots, live, VALID, settle, SWITCH, SWITCH_ID, MAPPING_ID, withGraph, replace, insert, open, showGraph, useGraphSuite } from '../graphHelpers';
import { api } from '../schemaHarness';

// Navigation between the graph and the YAML (3.7, AD-8).
suite('Pipeline graph: navigation (3.7, integration)', function () {
	this.timeout(60_000);
	useGraphSuite();
	/** The `selection` node ids posted, in order. */
	const selections = (handle: GraphPanelHandle): (string | null)[] =>
		handle.posted.flatMap((m) => (m.type === 'selection' ? [m.nodeId] : []));
	/** Moves the cursor of `editor` to `offset`, as the user would (no selection). */
	function moveTo(editor: vscode.TextEditor, offset: number): void {
		const at = editor.document.positionAt(offset);
		editor.selection = new vscode.Selection(at, at);
	}

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
});
