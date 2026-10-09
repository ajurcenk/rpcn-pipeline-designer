// Spike 3.14 probe: group lock, focus return. Throwaway; kept beside the plan as probe code.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { type ExtensionApi } from '../../../extension';
import { EXTENSION_ID } from '../helpers';
import { useSchemaBinary } from '../schemaHarness';

const log: string[] = [];
const note = (s: string) => { log.push(s); console.log('[PROBE] ' + s); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function state(step: string) {
	const groups = vscode.window.tabGroups.all.map((g) =>
		`col${g.viewColumn}${g.isActive ? '*' : ''}[${g.tabs.map((t) => {
			const i = t.input;
			const kind = i instanceof vscode.TabInputText ? 'text:' + path.basename(i.uri.fsPath)
				: i instanceof vscode.TabInputWebview ? 'webview:' + t.label : 'other:' + t.label;
			return kind + (t.isActive ? '(active)' : '');
		}).join(', ')}]`).join(' ');
	const ed = vscode.window.activeTextEditor;
	note(`${step}: groups=${groups}; activeGroup=col${vscode.window.tabGroups.activeTabGroup.viewColumn}; activeTextEditor=${ed ? path.basename(ed.document.uri.fsPath) + '@col' + ed.viewColumn : 'none'}`);
}

suite('Spike 3.14 probe', function () {
	this.timeout(120_000);
	suiteSetup(async () => { await vscode.extensions.getExtension(EXTENSION_ID)!.activate(); });
	useSchemaBinary();
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-probe-'));
	const write = (n: string) => { const f = path.join(dir, n); fs.writeFileSync(f, 'input:\n  generate:\n    mapping: root = {}\noutput:\n  stdout: {}\n'); return vscode.Uri.file(f); };

	suiteTeardown(() => {
		note(`VS Code ${vscode.version}`);
		fs.writeFileSync(path.join(os.tmpdir(), `rpcn-probe-${vscode.version}.txt`), log.join('\n'));
	});

	test('lock and focus', async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		const cmds = await vscode.commands.getCommands(true);
		note(`commands: lockEditorGroup=${cmds.includes('workbench.action.lockEditorGroup')} unlockEditorGroup=${cmds.includes('workbench.action.unlockEditorGroup')} toggleEditorGroupLock=${cmds.includes('workbench.action.toggleEditorGroupLock')}`);
		const a = write('a.yaml'); const b = write('b.yaml'); const c = write('c.yaml');
		const docA = await vscode.workspace.openTextDocument(a);
		await vscode.window.showTextDocument(docA, vscode.ViewColumn.One);
		state('1 opened a.yaml');
		await vscode.commands.executeCommand('redpandaConnect.showGraph', a);
		await sleep(500);
		state('2 after Show graph (preserveFocus)');
		const handle = api().graphPanels.panelFor(a)!;
		handle.panel.reveal(handle.panel.viewColumn, false);
		await sleep(500);
		state('3 after reveal(graph, focus)');
		await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
		await sleep(300);
		state('4 after lockEditorGroup');
		await vscode.window.showTextDocument(docA, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
		await sleep(300);
		state('5 after showTextDocument(a, col1) = focus return');
		// With the graph group active again, does a file opened without a column land in it?
		handle.panel.reveal(handle.panel.viewColumn, false); await sleep(300);
		await vscode.commands.executeCommand('vscode.open', b); await sleep(500);
		state('6 graph group active, vscode.open(b) (no column)');
		// Explicit column into the locked group:
		const docC = await vscode.workspace.openTextDocument(c);
		await vscode.window.showTextDocument(docC, { viewColumn: handle.panel.viewColumn ?? vscode.ViewColumn.Two, preserveFocus: false });
		await sleep(500);
		state('7 showTextDocument(c, graph column explicitly)');
		// A second Show graph for another file: where does its panel go?
		await vscode.window.showTextDocument(docA, vscode.ViewColumn.One); await sleep(200);
		await vscode.commands.executeCommand('redpandaConnect.showGraph', b); await sleep(500);
		state('8 Show graph for b.yaml from col1');
		// Unlocked control: new window state, no lock.
		await vscode.commands.executeCommand('workbench.action.closeAllEditors'); await sleep(300);
		await vscode.window.showTextDocument(docA, vscode.ViewColumn.One);
		await vscode.commands.executeCommand('redpandaConnect.showGraph', a); await sleep(500);
		const h2 = api().graphPanels.panelFor(a)!;
		h2.panel.reveal(h2.panel.viewColumn, false); await sleep(300);
		await vscode.commands.executeCommand('vscode.open', b); await sleep(500);
		state('9 control (no lock): graph group active, vscode.open(b)');
		// Lock while the YAML group is active (wrong group): what gets locked?
		await vscode.commands.executeCommand('workbench.action.closeAllEditors'); await sleep(300);
		await vscode.window.showTextDocument(docA, vscode.ViewColumn.One);
		await vscode.commands.executeCommand('redpandaConnect.showGraph', a); await sleep(500);
		await vscode.commands.executeCommand('workbench.action.lockEditorGroup'); await sleep(300);
		state('10 lock with YAML group active');
		await vscode.commands.executeCommand('vscode.open', c); await sleep(500);
		state('11 then vscode.open(c) from the YAML group');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});
});
