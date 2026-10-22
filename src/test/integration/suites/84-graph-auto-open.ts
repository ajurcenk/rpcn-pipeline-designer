import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GRAPH_OPEN_PATHS_KEY, GraphPanels, HIDDEN_GRAPHS_STATE } from '../../../adapters/graphPanel/panels';
import { EXTENSION_ID, runOnEditor, waitFor } from '../helpers';
import { graphDir, ids, live, VALID, settle, insert, open, showGraph, testPanels, withAutoOpen, fakeMemento, autoOpened, useGraphSuite } from '../graphHelpers';
import { api } from '../schemaHarness';

suite('Pipeline graph: auto-open, Hide and rename (3.10, integration)', function () {
	this.timeout(60_000);
	useGraphSuite();
	// Auto-open, the Hide graph toggle and per-file memory (3.10, spike 3.14). The root hook turns
	// auto-open off for every suite; these tests turn it on.
	/** The column of the tab group holding a text tab of `uri`. */
	const tabColumn = (uri: vscode.Uri): vscode.ViewColumn | undefined => vscode.window.tabGroups.all.find((g) =>
		g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString()))?.viewColumn;
	let dir: string;
	suiteSetup(() => {
		dir = graphDir();
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

	test('AUTO: a detected file shown for the first time gets one graph beside it, in a locked group, with focus in the YAML', async () => {
		await withAutoOpen(async () => {
			const doc = await open('auto.yaml', VALID);
			const handle = await autoOpened(doc);
			// `autoOpened` waited for the lock sequence; again here, before the focus checks (bug 19).
			await handle.lockSettled;
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
			assert.ok(!api().outputLines().some((l) => /not locked|could not (lock|return focus)|did not stay/.test(l)), 'the lock sequence logged no failure');
		});
	});

	// The lock sequence past its wait (bug 15): `lockWaitMs: 0` forces the late path on any machine.
	/** A registry whose lock wait always times out, and its log lines. */
	const latePanels = () => {
		const lines: string[] = [];
		return { lines, panels: testPanels({ lockWaitMs: 0, log: (l) => lines.push(l) }) };
	};
	const lockFailure = /not locked|could not (lock|return focus)|did not become active|did not stay/;

	test('LATE_ACTIVE: the panel active past the wait: its group is locked and focus returns to the YAML', async () => {
		const { lines, panels } = latePanels();
		let listener: vscode.Disposable | undefined;
		try {
			const doc = await open('late-active.yaml', VALID);
			const handle = (await panels.show(doc.uri))!;
			assert.ok(handle);
			// `show` resolved at the timed-out wait, before the delayed reveal is reported.
			let wasActive = handle.panel.active;
			listener = handle.panel.onDidChangeViewState((e) => {
				wasActive ||= e.webviewPanel.active;
			});
			assert.ok(await waitFor(() => handle.panel.viewColumn === vscode.ViewColumn.Two, 10_000), `beside: ${handle.panel.viewColumn}`);
			// The delayed reveal made the graph active, and the late sequence gave focus back.
			const back = () => wasActive && !handle.panel.active && vscode.window.tabGroups.activeTabGroup.viewColumn === vscode.ViewColumn.One;
			assert.ok(await waitFor(back, 10_000), `the graph became active, then focus came back: ${lines.join(' | ')}`);
			// The late sequence's confirmation ends before the strict checks (bug 19).
			await handle.lockSettled;
			await settle();
			assert.strictEqual(vscode.window.activeTextEditor?.document, doc, 'the YAML editor stays active');
			assert.strictEqual(vscode.window.activeTextEditor?.viewColumn, vscode.ViewColumn.One);
			assert.strictEqual(vscode.window.tabGroups.activeTabGroup.viewColumn, vscode.ViewColumn.One);
			// The graph's group is locked: with it active, a file opened with no column goes elsewhere.
			handle.panel.reveal(undefined, false);
			assert.ok(await waitFor(() => handle.panel.active, 10_000), 'the graph is active');
			const more = vscode.Uri.file(path.join(dir, 'late-active-more.txt'));
			fs.writeFileSync(more.fsPath, 'more\n');
			await vscode.commands.executeCommand('vscode.open', more);
			assert.ok(await waitFor(() => tabColumn(more) !== undefined, 10_000));
			assert.notStrictEqual(tabColumn(more), handle.panel.viewColumn, 'not in the graph group');
			assert.strictEqual(vscode.window.tabGroups.all.length, 2, 'no new group');
			assert.ok(!lines.some((l) => lockFailure.test(l)), `the lock sequence logged no failure: ${lines.join(' | ')}`);
		} finally {
			listener?.dispose();
			panels.dispose();
		}
	});

	test('LATE_USER_EDITOR: another text editor made active past the wait: the late sequence moves no focus to the YAML', async () => {
		const { lines, panels } = latePanels();
		try {
			const doc = await open('late-user.yaml', VALID);
			const file = path.join(dir, 'late-user-notes.txt');
			fs.writeFileSync(file, 'notes\n');
			const notes = await vscode.workspace.openTextDocument(file);
			const handle = (await panels.show(doc.uri))!;
			assert.ok(handle);
			// The user shows another file right as the wait ends, before the delayed reveal is
			// reported, so the late lock races it; then the panel becomes active (the test reveals it
			// again). Focus is never taken from the user, and the lock never stays on their group.
			await vscode.window.showTextDocument(notes, { viewColumn: vscode.ViewColumn.One, preview: false });
			assert.ok(await waitFor(() => vscode.window.activeTextEditor?.document === notes, 10_000), 'the other editor is active');
			await settle();
			handle.panel.reveal(undefined, false);
			assert.ok(await waitFor(() => handle.panel.active, 10_000), 'the graph is active');
			await settle();
			await settle();
			// Focus stays on the graph: nothing moved it to the YAML. (Not `activeTextEditor`, which
			// 1.100 leaves wrong while a webview has focus.)
			assert.ok(handle.panel.active, `the graph keeps focus: ${lines.join(' | ')}`);
			assert.strictEqual(vscode.window.tabGroups.activeTabGroup.viewColumn, handle.panel.viewColumn);
			assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputWebview, 'the graph tab is the active one');
			// The lock never landed on the user's group: with it active, a file opened with no column stays in it.
			await vscode.window.showTextDocument(notes, { viewColumn: vscode.ViewColumn.One, preview: false });
			assert.ok(await waitFor(() => vscode.window.tabGroups.activeTabGroup.viewColumn === vscode.ViewColumn.One, 10_000));
			const more = vscode.Uri.file(path.join(dir, 'late-user-more.txt'));
			fs.writeFileSync(more.fsPath, 'more\n');
			await vscode.commands.executeCommand('vscode.open', more);
			assert.ok(await waitFor(() => tabColumn(more) !== undefined, 10_000));
			assert.strictEqual(tabColumn(more), vscode.ViewColumn.One, `the YAML group is not locked: ${lines.join(' | ')}`);
		} finally {
			panels.dispose();
		}
	});

	test('LATE_NEVER: the panel not active within the late window: one log line, no lock, no focus move, nothing watched after', async () => {
		const lines: string[] = [];
		const panels = testPanels({ lockWaitMs: 0, lockLateWindowMs: 0, log: (l) => lines.push(l) });
		try {
			const doc = await open('late-never.yaml', VALID);
			const handle = (await panels.show(doc.uri))!;
			assert.ok(handle);
			const never = 'Graph late-never.yaml: its group did not become active, so it was not locked.';
			assert.deepStrictEqual(lines, [never], 'logged once, as the window ended');
			// The delayed reveal lands after the window: the late sequence is gone, so nothing locks
			// the group or gives focus back.
			assert.ok(await waitFor(() => handle.panel.active, 10_000), 'the graph became active');
			await settle();
			await settle();
			assert.ok(handle.panel.active, 'no focus moved back to the YAML');
			// A later activation is not watched either.
			await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
			handle.panel.reveal(undefined, false);
			assert.ok(await waitFor(() => handle.panel.active, 10_000), 'the graph is active again');
			await settle();
			assert.ok(handle.panel.active, 'still no focus move');
			assert.deepStrictEqual(lines, [never], 'nothing more logged');
			// Not locked: with the graph active, a file opened with no column lands in its group.
			const more = vscode.Uri.file(path.join(dir, 'late-never-more.txt'));
			fs.writeFileSync(more.fsPath, 'more\n');
			await vscode.commands.executeCommand('vscode.open', more);
			assert.ok(await waitFor(() => tabColumn(more) !== undefined, 10_000));
			assert.strictEqual(tabColumn(more), handle.panel.viewColumn, 'the graph group is not locked');
		} finally {
			panels.dispose();
		}
	});

	test('LATE_DISPOSED: the panel disposed past the wait ends the sequence: no lock, no focus move, no log line', async () => {
		const { lines, panels } = latePanels();
		try {
			const doc = await open('late-disposed.yaml', VALID);
			const handle = (await panels.show(doc.uri))!;
			assert.ok(handle);
			handle.panel.dispose();
			assert.strictEqual(panels.panelFor(doc.uri), undefined);
			// Past the whole late window: its timer was cleared with the panel.
			await new Promise((r) => setTimeout(r, 5_500));
			assert.deepStrictEqual(lines, []);
			assert.strictEqual(vscode.window.activeTextEditor?.document, doc, 'focus stays in the YAML');
			// No lock: the YAML group, active, still takes a file opened with no column.
			const more = vscode.Uri.file(path.join(dir, 'late-disposed-more.txt'));
			fs.writeFileSync(more.fsPath, 'more\n');
			await vscode.commands.executeCommand('vscode.open', more);
			assert.ok(await waitFor(() => tabColumn(more) !== undefined, 10_000));
			assert.strictEqual(tabColumn(more), vscode.ViewColumn.One, 'the YAML group is not locked');
			assert.strictEqual(vscode.window.tabGroups.all.length, 1, 'no group locked or left behind');
		} finally {
			panels.dispose();
		}
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
			await runOnEditor(doc, 'workbench.action.revertAndCloseActiveEditor');
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

	test('RENAME_NEVER (4.13): a rename announced and never reported blocks tab close and auto-open until it expires; then both work', async () => {
		const limit = 3_000;
		// The registry hears the test's own announcement; VS Code reports nothing for it.
		const will = new vscode.EventEmitter<vscode.FileWillRenameEvent>();
		const workspace = vscode.workspace as { onWillRenameFiles: unknown };
		const original = workspace.onWillRenameFiles;
		workspace.onWillRenameFiles = will.event;
		let panels: GraphPanels;
		try {
			panels = testPanels({ autoOpen: () => true, detection: api().detection, pendingRenameMs: limit });
		} finally {
			workspace.onWillRenameFiles = original;
		}
		const tabOf = (uri: vscode.Uri) => vscode.window.tabGroups.all.flatMap((g) => g.tabs)
			.find((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
		try {
			const doc = await open('never-a.yaml', VALID);
			const handle = await autoOpened(doc, panels);
			let gone = false;
			handle.panel.onDidDispose(() => (gone = true));
			// Two renames of the file are announced: one new name is the control, the other is shown after the expiry.
			const control = vscode.Uri.file(path.join(dir, 'never-b.yaml'));
			const later = vscode.Uri.file(path.join(dir, 'never-c.yaml'));
			will.fire({
				files: [{ oldUri: doc.uri, newUri: control }, { oldUri: doc.uri, newUri: later }],
				waitUntil: () => undefined,
				token: new vscode.CancellationTokenSource().token,
			} as vscode.FileWillRenameEvent);
			const announced = Date.now();
			// Before the time limit: a new name does not auto-open, and the last tab's close is no close.
			const shownEarly = await open('never-b.yaml', VALID);
			await settle();
			await panels.idle();
			assert.strictEqual(panels.panelFor(shownEarly.uri), undefined, 'a pending rename\'s new name does not auto-open');
			assert.ok(tabOf(doc.uri), 'the old name\'s tab');
			await vscode.window.tabGroups.close(tabOf(doc.uri)!);
			await settle();
			assert.ok(!gone, 'the pending rename keeps the graph');
			assert.ok(Date.now() - announced < limit, 'the control ran before the time limit');
			await vscode.window.showTextDocument(doc.uri, { viewColumn: vscode.ViewColumn.One, preview: false });
			assert.ok(await waitFor(() => tabOf(doc.uri) !== undefined, 10_000));
			// Past the time limit, the rename no longer counts.
			assert.ok(await waitFor(() => Date.now() - announced >= limit + 100, limit + 1_000));
			// AUTO: the other new name, shown for the first time, is no renamed file: its graph auto-opens.
			const shownLate = await open('never-c.yaml', VALID);
			await autoOpened(shownLate, panels);
			assert.strictEqual(later.toString(), shownLate.uri.toString());
			// TAB_CLOSE: the old name's last tab closes its graph.
			await vscode.window.tabGroups.close(tabOf(doc.uri)!);
			assert.ok(await waitFor(() => gone, 10_000), 'the graph closed with its last tab');
			assert.strictEqual(panels.panelFor(doc.uri), undefined);
			assert.strictEqual(control.toString(), shownEarly.uri.toString());
		} finally {
			panels.dispose();
			will.dispose();
		}
	});
});
