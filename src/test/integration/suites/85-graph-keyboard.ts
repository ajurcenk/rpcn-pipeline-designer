import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { REPO_ROOT } from '../../helpers/fakeBinary';
import { focusState, waitFor } from '../helpers';
import { snapshots, VALID, settle, SWITCH, withGraph, open, showGraph, useGraphSuite } from '../graphHelpers';

// The keyboard model, host side (3.11): activation by keyboard and Esc back to the editor.
suite('Pipeline graph: keyboard host side (3.11, integration)', function () {
	this.timeout(60_000);
	useGraphSuite();

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

	test('ESC (ticket 11): focusEditorRequested focuses the driving editor with its cursor unchanged; with no editor nothing happens', async () => {
		const { doc, editor, handle } = await withGraph('esc.yaml', SWITCH);
		const at = SWITCH.indexOf('this.a');
		editor.selection = new vscode.Selection(doc.positionAt(at), doc.positionAt(at + 'this.a'.length));
		const before = editor.selection;
		// The graph has focus, as after Esc on its container.
		handle.panel.reveal(handle.panel.viewColumn, false);
		assert.ok(await waitFor(() => handle.panel.active, 10_000), `the graph panel is focused: ${focusState()}`);

		await handle.receive({ type: 'focusEditorRequested' });
		assert.ok(await waitFor(() => vscode.window.activeTextEditor === editor, 10_000), `the driving editor is focused: ${focusState()}`);
		assert.ok(editor.selection.isEqual(before), 'the cursor and selection are unchanged');
		assert.strictEqual(vscode.window.visibleTextEditors.filter((e) => e.document === doc).length, 1, 'no new editor');
		assert.ok(!doc.isDirty, 'nothing edits the text');

		// No editor for the file is visible: nothing happens.
		const other = await open('esc-other.yaml', VALID);
		assert.ok(await waitFor(() => !vscode.window.visibleTextEditors.some((e) => e.document === doc), 10_000), `the file hidden: ${focusState()}`);
		const active = vscode.window.activeTextEditor;
		assert.strictEqual(active?.document, other, focusState());
		const focusBefore = focusState();
		await handle.receive({ type: 'focusEditorRequested' });
		await settle();
		assert.strictEqual(vscode.window.activeTextEditor, active, `focus stays where it was: before ${focusBefore}; now ${focusState()}`);
		assert.ok(!vscode.window.visibleTextEditors.some((e) => e.document === doc), 'no editor opens for the file');
	});
});
