import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GraphPanelHandle, GraphPanels } from '../../../adapters/graphPanel/panels';
import type { HostMessage, NodeStatusById } from '../../../shared/protocol';
import { runOnEditor, waitFor } from '../helpers';
import {
	graphDir, ids, live, settle, SWITCH, MAPPING_ID, VALID, withGraph, insert, open, showGraph, testPanels, fakeMemento, loseBinary,
	restoreBinary, useGraphSuite,
} from '../graphHelpers';
import { api } from '../schemaHarness';

// Graph interaction fixes across tickets (the E3 retro, F1, F2, F6, F7, F8, F11): each test drives
// a sequence that crosses two or more of tickets 3.6–3.11, through the host seam.
suite('Pipeline graph: interactions across tickets (E3 retro, integration)', function () {
	this.timeout(60_000);
	useGraphSuite();
	let dir: string;
	suiteSetup(() => {
		dir = graphDir();
	});

	const statuses = (handle: GraphPanelHandle): NodeStatusById[] =>
		handle.posted.flatMap((m) => (m.type === 'nodeStatus' ? [m.byId] : []));

	/**
	 * Holds the resolution of every post to `handle`'s webview (each is delivered at once, in
	 * order) until the test releases it, so that the order in which posts resolve is the test's.
	 */
	function holdPosts(handle: GraphPanelHandle) {
		const webview = handle.panel.webview;
		const original = webview.postMessage;
		const held: { readonly message: HostMessage; release(): void }[] = [];
		const patched = (message: HostMessage): Thenable<boolean> => {
			const delivered = original.call(webview, message);
			return new Promise<boolean>((resolve, reject) => {
				held.push({ message, release: () => delivered.then(resolve, reject) });
			});
		};
		(webview as { postMessage: unknown }).postMessage = patched;
		return {
			held,
			releaseAll() {
				held.splice(0).forEach((h) => h.release());
			},
			restore() {
				this.releaseAll();
				(webview as { postMessage: unknown }).postMessage = original;
			},
		};
	}

	/** Diagnostics the test sets with or without firing their change. */
	function ownDiagnostics() {
		const emitter = new vscode.EventEmitter<vscode.Uri>();
		const state = { current: [] as vscode.Diagnostic[] };
		// Only the test's `receive()` drives the protocol: the real webview's `ready` (late on 1.100)
		// would post a snapshot inside the exact counts of F1_RACE and F11_LATE (LATE_SNAPSHOT).
		const panels = testPanels({
			diagnostics: { diagnosticsFor: () => state.current, onDidChangeDiagnostics: emitter.event },
			ignoreWebviewMessages: true,
		});
		return {
			panels,
			state,
			fire: (uri: vscode.Uri) => emitter.fire(uri),
			dispose() {
				panels.dispose();
				emitter.dispose();
			},
		};
	}

	const error = (doc: vscode.TextDocument, needle: string, message: string, severity = vscode.DiagnosticSeverity.Error) => {
		const start = doc.positionAt(doc.getText().indexOf(needle));
		const d = new vscode.Diagnostic(new vscode.Range(start, start.translate(0, 1)), message, severity);
		d.source = 'yaml-schema: test';
		return d;
	};

	for (const order of ['the snapshot resolves first', 'the diagnostics change before either resolves'] as const) {
		test(`F1_RACE: a nodeStatus in flight during ready, ${order}: the later status A is posted`, async () => {
			const doc = await open(`race-${order.split(' ')[1]}.yaml`, VALID);
			const fake = ownDiagnostics();
			let hold: ReturnType<typeof holdPosts> | undefined;
			try {
				const handle = (await fake.panels.show(doc.uri))!;
				await handle.receive({ type: 'ready' });
				const A = [error(doc, 'stdin', 'input A')];
				const B = [error(doc, 'stdout', 'output B', vscode.DiagnosticSeverity.Warning)];
				hold = holdPosts(handle);
				// A nodeStatus with A is in flight (3.8) when ready sends a snapshot with B (3.6 / 3.11).
				fake.state.current = A;
				fake.fire(doc.uri);
				assert.ok(await waitFor(() => hold!.held.length === 1, 5_000), 'the status A is posted');
				fake.state.current = B;
				const ready = handle.receive({ type: 'ready' });
				assert.ok(await waitFor(() => hold!.held.length === 2, 5_000), 'the snapshot is posted');
				const snapshot = hold.held[1].message;
				assert.ok(snapshot.type === 'snapshot');
				assert.deepStrictEqual(Object.keys(snapshot.nodeStatus), ['path:output']);
				const count = statuses(handle).length;
				if (order === 'the snapshot resolves first') {
					hold.held[1].release();
					await ready;
					hold.held[0].release();
					hold.held.splice(0);
					await settle();
					fake.state.current = A;
					fake.fire(doc.uri);
				} else {
					fake.state.current = A;
					fake.fire(doc.uri);
					await settle();
					hold.releaseAll();
					await ready;
				}
				assert.ok(await waitFor(() => {
					hold!.releaseAll();
					return statuses(handle).length > count;
				}, 5_000), 'a later status A is posted, not skipped as sent');
				assert.deepStrictEqual(Object.keys(statuses(handle).at(-1)!), ['path:input'], 'the webview ends with A');
			} finally {
				hold?.restore();
				fake.dispose();
			}
		});
	}

	test('F2_HIDE_QUEUED: Show graph queued behind a lock, then Hide graph before it runs: no panel, the file is hidden', async () => {
		const a = await open('queued-a.yaml', VALID);
		const b = await open('queued-b.yaml', VALID);
		const memento = fakeMemento();
		const panels = testPanels({ memento });
		try {
			const first = panels.show(a.uri);
			const queued = panels.show(b.uri);
			await panels.hide(b.uri);
			assert.ok(await first, 'the first graph opens');
			assert.strictEqual(await queued, undefined, 'the queued Show opens nothing');
			await panels.idle();
			assert.strictEqual(panels.panelFor(b.uri), undefined, 'no panel for the hidden file');
			assert.ok(panels.isHidden(b.uri), 'the file stays hidden');
			assert.strictEqual(panels.size, 1);
			// Show graph afterwards still opens it.
			assert.ok(await panels.show(b.uri));
			assert.ok(!panels.isHidden(b.uri));
		} finally {
			panels.dispose();
		}
	});

	suite('F6_DISPOSE', () => {
		/** "Graph …" lines: a panel's own errors (not "Show graph:" / "Hide graph:"). */
		const graphErrors = (lines: readonly string[]) => lines.filter((l) => l.startsWith('Graph '));

		test('Hide graph while ready\'s snapshot is on its way: nothing posted after it, no error line', async () => {
			const doc = await open('dispose-ready.yaml', VALID);
			const lines: string[] = [];
			const panels = testPanels({ log: (l) => lines.push(l) });
			try {
				const handle = (await panels.show(doc.uri))!;
				await panels.idle();
				const count = handle.posted.length;
				// `ready` takes the open document as it is (4.13): its snapshot is handed to the webview at
				// once, and Hide's synchronous part disposes the panel while that post is awaited.
				const ready = handle.receive({ type: 'ready' });
				const hidden = panels.hide(doc.uri);
				await ready;
				await hidden;
				// A tab close (the ×) during an update is the same disposal.
				await settle();
				assert.deepStrictEqual(handle.posted.slice(count).map((m) => m.type), ['snapshot'], 'only the snapshot, posted before the dispose');
				assert.strictEqual(panels.panelFor(doc.uri), undefined, 'the panel is gone');
				assert.deepStrictEqual(graphErrors(lines), []);
			} finally {
				panels.dispose();
			}
		});

		test('the panel closed while an edit\'s update is on its way: nothing posted after the model, no error line', async () => {
			const doc = await open('dispose-edit.yaml', VALID);
			const lines: string[] = [];
			// A finding at the output: after the edit below it maps to another node, so the update
			// would post a new status after the model.
			const finding = [error(doc, 'stdout', 'output error')];
			const panels = testPanels({
				log: (l) => lines.push(l),
				diagnostics: { diagnosticsFor: () => finding, onDidChangeDiagnostics: () => ({ dispose: () => undefined }) },
			});
			try {
				const handle = (await panels.show(doc.uri))!;
				await handle.receive({ type: 'ready' });
				await panels.idle();
				const count = handle.posted.length;
				// The registry posts the edit's model from the change event; the panel closes (as by its
				// ×, or its last tab closing) in the same turn, while that post is awaited.
				const closed = new Promise<void>((resolve) => {
					const sub = vscode.workspace.onDidChangeTextDocument((e) => {
						if (e.document === doc) {
							sub.dispose();
							handle.panel.dispose();
							resolve();
						}
					});
				});
				await insert(doc, doc.getText().indexOf('output:'), 'pipeline:\n  processors:\n    - mapping: root = this\n');
				await closed;
				await settle();
				assert.deepStrictEqual(handle.posted.slice(count).map((m) => m.type), ['model'], 'only the model posted before the close');
				assert.deepStrictEqual(graphErrors(lines), []);
			} finally {
				panels.dispose();
			}
		});

		test('Hide graph while the lock sequence waits for its group: the sequence stops, no error line', async () => {
			const doc = await open('dispose-lock.yaml', VALID);
			const lines: string[] = [];
			let armed = true;
			const panels: GraphPanels = testPanels({
				log: (l) => lines.push(l),
				setContext: (_key, value) => {
					// The panel is registered: hide it once the lock sequence is waiting.
					if (armed && Array.isArray(value) && value.includes(doc.uri.fsPath)) {
						armed = false;
						setTimeout(() => void panels.hide(doc.uri), 0);
					}
				},
			});
			try {
				await panels.show(doc.uri);
				await panels.idle();
				await settle();
				assert.strictEqual(panels.panelFor(doc.uri), undefined, 'the panel was hidden');
				assert.ok(panels.isHidden(doc.uri));
				assert.deepStrictEqual(graphErrors(lines), [], 'no lock or focus-return error for the disposed panel');
			} finally {
				panels.dispose();
			}
		});
	});

	test('READY_CLOSED (4.13): a ready after the YAML\'s document closed posts the last model and leaves it closed; with no last model, nothing', async () => {
		const panels = testPanels({ ignoreWebviewMessages: true });
		const isOpen = (uri: vscode.Uri) => vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString());
		/**
		 * Opens `name` with `text` as a user would (`vscode.diff`): a document an extension opened stays
		 * open for minutes after its editor closes. In a diff editor the file has no text tab, so its graph
		 * outlives the document's close.
		 */
		async function diffed(name: string, text: string) {
			const uri = vscode.Uri.file(path.join(dir, name));
			fs.writeFileSync(uri.fsPath, text);
			const left = vscode.Uri.file(path.join(dir, `${name}.left.txt`));
			fs.writeFileSync(left.fsPath, '');
			const show = () => vscode.commands.executeCommand('vscode.diff', left, uri, 'diff', { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
			await show();
			assert.ok(await waitFor(() => isOpen(uri), 5_000));
			const handle = (await panels.show(uri))!;
			await panels.idle();
			await handle.lockSettled;
			return {
				uri,
				handle,
				async close() {
					const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
					assert.ok(doc, 'the document is open');
					await runOnEditor(doc, 'workbench.action.revertAndCloseActiveEditor', show);
					assert.ok(await waitFor(() => !isOpen(uri), 20_000), 'the document closed');
				},
			};
		}
		try {
			// READY_CLOSED: the last model, no parse error; the document stays closed.
			const valid = await diffed('ready-closed.yaml', VALID);
			await valid.handle.receive({ type: 'ready' });
			const open = valid.handle.posted.filter((m) => m.type === 'snapshot').at(-1);
			assert.ok(open?.type === 'snapshot' && open.model, 'a snapshot with the model while open');
			await valid.close();
			const count = valid.handle.posted.length;
			await valid.handle.receive({ type: 'ready' });
			const after = valid.handle.posted.slice(count);
			assert.deepStrictEqual(after.map((m) => m.type), ['snapshot']);
			const snapshot = after[0];
			assert.ok(snapshot.type === 'snapshot');
			assert.deepStrictEqual(ids(snapshot.model ?? undefined), ids(open.model), 'the last model');
			assert.strictEqual(snapshot.parseError, undefined, 'no parse error');
			await settle();
			assert.ok(!isOpen(valid.uri), 'the document stays closed');

			// No last model (the YAML never parsed): nothing is posted.
			const broken = await diffed('ready-closed-broken.yaml', 'input: [\n');
			await broken.handle.receive({ type: 'ready' });
			const brokenOpen = broken.handle.posted.filter((m) => m.type === 'snapshot').at(-1);
			assert.ok(brokenOpen?.type === 'snapshot' && brokenOpen.model === null && brokenOpen.parseError, 'a parse error and no model while open');
			await broken.close();
			const brokenCount = broken.handle.posted.length;
			await broken.handle.receive({ type: 'ready' });
			await settle();
			assert.deepStrictEqual(broken.handle.posted.slice(brokenCount).map((m) => m.type), [], 'nothing posted');
			assert.ok(!isOpen(broken.uri), 'the document stays closed');
		} finally {
			panels.dispose();
		}
	});

	suite('F7_RENAME', () => {
		const uri = (name: string) => vscode.Uri.file(path.join(dir, name));
		type Files = readonly { readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri }[];
		/**
		 * A registry of the test's own that hears renames as one batch: VS Code 1.100–1.141 reports
		 * each rename of a WorkspaceEdit as an event of its own, but the API allows one event for a
		 * whole batch (several files of one operation), so the test sends the batch itself.
		 */
		function batchedRegistry(options: Parameters<typeof testPanels>[0] = {}) {
			const will = new vscode.EventEmitter<vscode.FileWillRenameEvent>();
			const did = new vscode.EventEmitter<vscode.FileRenameEvent>();
			const workspace = vscode.workspace as { onWillRenameFiles: unknown; onDidRenameFiles: unknown };
			const original = { will: workspace.onWillRenameFiles, did: workspace.onDidRenameFiles };
			workspace.onWillRenameFiles = will.event;
			workspace.onDidRenameFiles = did.event;
			let panels: GraphPanels;
			try {
				panels = testPanels(options);
			} finally {
				workspace.onWillRenameFiles = original.will;
				workspace.onDidRenameFiles = original.did;
			}
			/** Renames `pairs` in one WorkspaceEdit, announced and reported as one batch, in order. */
			async function rename(overwrite: (i: number) => boolean, pairs: [vscode.Uri, vscode.Uri][]): Promise<void> {
				const files: Files = pairs.map(([oldUri, newUri]) => ({ oldUri, newUri }));
				will.fire({ files, waitUntil: () => undefined, token: new vscode.CancellationTokenSource().token } as vscode.FileWillRenameEvent);
				const edit = new vscode.WorkspaceEdit();
				pairs.forEach(([from, to], i) => edit.renameFile(from, to, { overwrite: overwrite(i) }));
				assert.ok(await vscode.workspace.applyEdit(edit), 'the rename applied');
				did.fire({ files });
			}
			return {
				panels,
				/**
				 * Renames `pairs` as one batch. VS Code checks every target before it moves anything, so a
				 * later rename onto a name an earlier one frees needs `overwrite` (nothing is there by then).
				 */
				rename: (...pairs: [vscode.Uri, vscode.Uri][]) => rename((i) => i > 0, pairs),
				/** Renames `pairs` as one batch, each one with `overwrite` ("Replace" in the Explorer). */
				renameOver: (...pairs: [vscode.Uri, vscode.Uri][]) => rename(() => true, pairs),
				dispose() {
					panels.dispose();
					will.dispose();
					did.dispose();
				},
			};
		}

		/** Opens `name` with `text` in `column` (not a preview tab). */
		async function openIn(name: string, text: string, column: vscode.ViewColumn): Promise<vscode.TextDocument> {
			const file = path.join(dir, name);
			fs.writeFileSync(file, text);
			const doc = await vscode.workspace.openTextDocument(file);
			await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
			return doc;
		}
		/** Moves the cursor in `doc`'s editor in `column`, which makes it the driving one. */
		async function drive(doc: vscode.TextDocument, column: vscode.ViewColumn): Promise<void> {
			const editor = await vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus: false });
			const at = doc.positionAt(doc.getText().indexOf('stdin'));
			editor.selection = new vscode.Selection(at, at);
			await settle();
		}
		/** A click on the input of `handle`'s graph selects it in an editor: its file and column. */
		async function clickSelects(handle: GraphPanelHandle): Promise<[string, vscode.ViewColumn | undefined]> {
			const target = handle.uri.toString();
			await handle.receive({ type: 'nodeActivated', nodeId: 'path:input', via: 'click' });
			const selected = () => {
				const active = vscode.window.activeTextEditor;
				return active?.document.uri.toString() === target && active.document.getText(active.selection) === 'input:\n  stdin: {}';
			};
			assert.ok(await waitFor(selected, 5_000), `the click selected the input in ${target}`);
			const active = vscode.window.activeTextEditor!;
			return [path.basename(active.document.uri.path), active.viewColumn];
		}
		const visibleIn = (target: vscode.Uri, column: vscode.ViewColumn) =>
			vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === target.toString() && e.viewColumn === column);

		test('a chain in one batch (b→c, a→b) with panels on a and b: each panel and driving editor follows its file', async () => {
			const registry = batchedRegistry();
			try {
				const { panels } = registry;
				const a = await openIn('chain-a.yaml', VALID, vscode.ViewColumn.One);
				const b = await openIn('chain-b.yaml', 'input:\n  stdin: {}\n', vscode.ViewColumn.Three);
				const handleA = (await panels.show(a.uri))!;
				const handleB = (await panels.show(b.uri))!;
				await drive(a, vscode.ViewColumn.One);
				await drive(b, vscode.ViewColumn.Three);
				const c = uri('chain-c.yaml');
				await registry.rename([b.uri, c], [a.uri, b.uri]);
				assert.strictEqual(panels.panelFor(c), handleB, 'b\'s panel is keyed by c');
				assert.strictEqual(panels.panelFor(b.uri), handleA, 'a\'s panel is keyed by b');
				assert.strictEqual(panels.panelFor(a.uri), undefined);
				assert.strictEqual(handleA.panel.title, 'Graph: chain-b.yaml');
				assert.strictEqual(handleB.panel.title, 'Graph: chain-c.yaml');
				await settle();
				assert.strictEqual(panels.size, 2, 'no panel was closed');
				// The driving editors follow: a's (column One) is now b's, b's (column Three) is now c's.
				assert.ok(await waitFor(() => visibleIn(b.uri, vscode.ViewColumn.One) && visibleIn(c, vscode.ViewColumn.Three), 10_000), 'the editors reopened');
				assert.deepStrictEqual(await clickSelects(handleA), ['chain-b.yaml', vscode.ViewColumn.One]);
				assert.deepStrictEqual(await clickSelects(handleB), ['chain-c.yaml', vscode.ViewColumn.Three]);
				// The model keeps following each file.
				const doc = await vscode.workspace.openTextDocument(b.uri);
				const count = live(handleA).length;
				await insert(doc, doc.getText().indexOf('output:'), 'pipeline:\n  processors:\n    - mapping: root = this\n');
				assert.ok(await waitFor(() => live(handleA).length > count, 10_000), 'a\'s panel follows the file now at b');
			} finally {
				registry.dispose();
			}
		});

		test('a swap in one batch (a→t, b→a, t→b) with a Hide on a and a panel on b: the Hide, the panel and the driving editor follow their files', async () => {
			const memento = fakeMemento();
			const registry = batchedRegistry({ memento });
			try {
				const { panels } = registry;
				const a = await openIn('swap-a.yaml', VALID, vscode.ViewColumn.One);
				await panels.hide(a.uri);
				const b = await openIn('swap-b.yaml', 'input:\n  stdin: {}\n', vscode.ViewColumn.Three);
				const handleB = (await panels.show(b.uri))!;
				await drive(a, vscode.ViewColumn.One);
				await drive(b, vscode.ViewColumn.Three);
				const t = uri('swap-t.yaml');
				await registry.rename([a.uri, t], [b.uri, a.uri], [t, b.uri]);
				assert.strictEqual(panels.panelFor(a.uri), handleB, 'b\'s panel is keyed by a');
				assert.strictEqual(panels.panelFor(b.uri), undefined);
				assert.strictEqual(handleB.panel.title, 'Graph: swap-a.yaml');
				assert.ok(panels.isHidden(b.uri), 'the Hide moved with a\'s file to b');
				assert.ok(!panels.isHidden(a.uri), 'b\'s file, now at a, is not hidden');
				assert.ok(!panels.isHidden(t));
				assert.deepStrictEqual(memento.get('redpandaConnect.hiddenGraphs'), [b.uri.toString()]);
				await settle();
				assert.strictEqual(panels.panelFor(a.uri), handleB, 'the rename did not close the graph');
				// b's driving editor (column Three) is now a's.
				assert.ok(await waitFor(() => visibleIn(a.uri, vscode.ViewColumn.Three), 10_000), 'the editors reopened');
				assert.deepStrictEqual(await clickSelects(handleB), ['swap-a.yaml', vscode.ViewColumn.Three]);
			} finally {
				registry.dispose();
			}
		});

		for (const column of [vscode.ViewColumn.One, vscode.ViewColumn.Three]) {
			test(`the driving editor of a renamed file is the new URI's editor in its column (column ${column})`, async () => {
				// The editors close, then reopen under the new name, and the rename is reported after.
				const registry = batchedRegistry();
				try {
					const { panels } = registry;
					const doc = await open(`drive-old-${column}.yaml`, SWITCH);
					await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Three, preserveFocus: false, preview: false });
					const handle = (await panels.show(doc.uri))!;
					await handle.receive({ type: 'ready' });
					// The cursor moves in the chosen editor, which drives. The editor focus and the lock's
					// focus return settle asynchronously, so the move is repeated until the graph follows it.
					const driving = await vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus: false });
					const lastSelection = () => handle.posted.filter((m) => m.type === 'selection').at(-1);
					const moveTo = (needle: string) => {
						const at = doc.positionAt(SWITCH.indexOf(needle));
						driving.selection = new vscode.Selection(at, at);
					};
					let drives = false;
					for (let attempt = 0; attempt < 5 && !drives; attempt++) {
						moveTo('stdin');
						await waitFor(() => lastSelection()?.type === 'selection' && lastSelection()?.nodeId === 'path:input', 1_000);
						moveTo('stdout');
						drives = await waitFor(() => { const last = lastSelection(); return last?.type === 'selection' && last.nodeId === 'path:output'; }, 2_000);
					}
					assert.ok(drives, `it drives: ${JSON.stringify(handle.posted.map((m) => (m.type === 'selection' ? `selection:${m.nodeId}` : m.type)))}`);
					// Focus in the graph, so no text editor takes over by being focused after the rename.
					handle.panel.reveal(handle.panel.viewColumn, false);
					assert.ok(await waitFor(() => handle.panel.active, 10_000), 'the graph is focused');
					const renamed = uri(`drive-new-${column}.yaml`);
					await registry.rename([doc.uri, renamed]);
					const editors = () => vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === renamed.toString());
					assert.ok(await waitFor(() => editors().length === 2, 10_000), `both editors follow the rename: ${editors().map((e) => e.viewColumn)}`);
					assert.strictEqual(panels.panelFor(renamed), handle);
					await settle();
					await handle.receive({ type: 'nodeActivated', nodeId: 'path:input', via: 'click' });
					const active = vscode.window.activeTextEditor!;
					assert.strictEqual(active.document.uri.toString(), renamed.toString());
					assert.strictEqual(active.viewColumn, column, 'the click selects in the driving editor\'s column');
					assert.strictEqual(active.document.getText(active.selection), 'input:\n  stdin: {}');
				} finally {
					registry.dispose();
				}
			});
		}

		/** Whether `handle`'s panel was disposed, from now on. */
		const disposal = (handle: GraphPanelHandle) => {
			let gone = false;
			handle.panel.onDidDispose(() => (gone = true));
			return () => gone;
		};

		test('GRAPH_OVERWRITE (ticket 17): a renamed onto b with overwrite, graphs on both: a\'s graph takes b\'s key and title, b\'s closes, the driving editor is a\'s column', async () => {
			const registry = batchedRegistry();
			try {
				const { panels } = registry;
				const a = await openIn('over-a.yaml', VALID, vscode.ViewColumn.One);
				const b = await openIn('over-b.yaml', 'input:\n  stdin: {}\n', vscode.ViewColumn.Three);
				const handleA = (await panels.show(a.uri))!;
				const handleB = (await panels.show(b.uri))!;
				const aGone = disposal(handleA);
				const bGone = disposal(handleB);
				await drive(a, vscode.ViewColumn.One);
				await drive(b, vscode.ViewColumn.Three);
				await registry.renameOver([a.uri, b.uri]);
				assert.ok(bGone(), 'the overwritten file\'s graph closed');
				assert.strictEqual(panels.panelFor(b.uri), handleA, 'a\'s graph is keyed by b');
				assert.strictEqual(panels.panelFor(a.uri), undefined);
				assert.strictEqual(handleA.panel.title, 'Graph: over-b.yaml');
				await settle();
				assert.ok(!aGone(), 'the moved graph stays');
				assert.strictEqual(panels.size, 1);
				// The driving editor is b's new editor in a's column (One), not the overwritten file's (Three).
				assert.ok(await waitFor(() => visibleIn(b.uri, vscode.ViewColumn.One), 10_000), 'the editor reopened');
				assert.deepStrictEqual(await clickSelects(handleA), ['over-b.yaml', vscode.ViewColumn.One]);
				// The graph shows the moved file's content.
				const doc = await vscode.workspace.openTextDocument(b.uri);
				assert.strictEqual(doc.getText(), VALID);
			} finally {
				registry.dispose();
			}
		});

		test('GRAPH_OVERWRITE (ticket 17), b\'s graph with no text tab (no TAB_CLOSE first): a\'s graph takes b\'s key, b\'s closes, a\'s driving column is kept', async () => {
			const registry = batchedRegistry();
			try {
				const { panels } = registry;
				const a = await openIn('over-notab-a.yaml', VALID, vscode.ViewColumn.One);
				const b = uri('over-notab-b.yaml');
				fs.writeFileSync(b.fsPath, 'input:\n  stdin: {}\n');
				const handleA = (await panels.show(a.uri))!;
				const handleB = (await panels.show(b))!;
				assert.ok(!vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === b.toString())), 'b has no text tab');
				const aGone = disposal(handleA);
				const bGone = disposal(handleB);
				await drive(a, vscode.ViewColumn.One);
				await registry.renameOver([a.uri, b]);
				assert.ok(bGone(), 'the overwritten file\'s graph closed');
				assert.strictEqual(panels.panelFor(b), handleA, 'a\'s graph is keyed by b');
				assert.strictEqual(handleA.panel.title, 'Graph: over-notab-b.yaml');
				await settle();
				assert.ok(!aGone(), 'the moved graph stays');
				assert.strictEqual(panels.size, 1);
				assert.ok(await waitFor(() => visibleIn(b, vscode.ViewColumn.One), 10_000), 'the editor reopened');
				assert.deepStrictEqual(await clickSelects(handleA), ['over-notab-b.yaml', vscode.ViewColumn.One]);
			} finally {
				registry.dispose();
			}
		});

		test('GRAPH_OVERWRITE_HIDDEN (ticket 17): b hidden, a shown, a renamed onto b with overwrite: a\'s graph is at b and b is no longer hidden', async () => {
			const memento = fakeMemento();
			const registry = batchedRegistry({ memento });
			try {
				const { panels } = registry;
				const a = await openIn('over-hidden-a.yaml', VALID, vscode.ViewColumn.One);
				const b = uri('over-hidden-b.yaml');
				fs.writeFileSync(b.fsPath, 'input:\n  stdin: {}\n');
				await panels.hide(b);
				assert.ok(panels.isHidden(b));
				const handleA = (await panels.show(a.uri))!;
				await registry.renameOver([a.uri, b]);
				assert.strictEqual(panels.panelFor(b), handleA, 'a\'s graph is keyed by b');
				assert.ok(!panels.isHidden(b), 'the name takes the moved file\'s state: not hidden');
				assert.ok(!panels.isHidden(a.uri));
				assert.deepStrictEqual(memento.get('redpandaConnect.hiddenGraphs'), []);
			} finally {
				registry.dispose();
			}
		});

		for (const order of ['a first', 'c first'] as const) {
			test(`TWO_MOVERS (ticket 17, ${order}): a→x, c→x in one batch, graphs on a and c: c's graph is keyed x, a's closes, the driving editor is c's column`, async () => {
				const registry = batchedRegistry();
				try {
					const { panels } = registry;
					const tag = order === 'a first' ? 'af' : 'cf';
					// A second tab in each group keeps it when its renamed editor closes, so the columns stay.
					await openIn(`movers-${tag}-keep1.yaml`, VALID, vscode.ViewColumn.One);
					await openIn(`movers-${tag}-keep3.yaml`, VALID, vscode.ViewColumn.Three);
					const a = await openIn(`movers-${tag}-a.yaml`, VALID, vscode.ViewColumn.One);
					const c = await openIn(`movers-${tag}-c.yaml`, 'input:\n  stdin: {}\n', vscode.ViewColumn.Three);
					const x = uri(`movers-${tag}-x.yaml`);
					// The registry's insertion order is the opening order: the result does not depend on it.
					const opened = new Map<vscode.TextDocument, GraphPanelHandle>();
					for (const doc of order === 'a first' ? [a, c] : [c, a]) {
						opened.set(doc, (await panels.show(doc.uri))!);
					}
					const handleA = opened.get(a)!;
					const handleC = opened.get(c)!;
					const aGone = disposal(handleA);
					const cGone = disposal(handleC);
					// The driving editors in the same order: the kept column is the winner's either way.
					for (const [doc, column] of order === 'a first' ? [[a, vscode.ViewColumn.One], [c, vscode.ViewColumn.Three]] as const : [[c, vscode.ViewColumn.Three], [a, vscode.ViewColumn.One]] as const) {
						await drive(doc, column);
					}
					await registry.rename([a.uri, x], [c.uri, x]);
					assert.ok(aGone(), 'the graph of the file renamed first closed');
					assert.strictEqual(panels.panelFor(x), handleC, 'the graph of the file renamed last is keyed by x');
					assert.strictEqual(handleC.panel.title, `Graph: movers-${tag}-x.yaml`);
					assert.strictEqual(panels.panelFor(a.uri), undefined);
					assert.strictEqual(panels.panelFor(c.uri), undefined);
					await settle();
					assert.ok(!cGone(), 'the winner stays');
					assert.strictEqual(panels.size, 1);
					assert.ok(await waitFor(() => visibleIn(x, vscode.ViewColumn.Three), 10_000), 'the editor reopened');
					assert.deepStrictEqual(await clickSelects(handleC), [`movers-${tag}-x.yaml`, vscode.ViewColumn.Three]);
				} finally {
					registry.dispose();
				}
			});
		}

		test('VS Code\'s own rename events: the driving editor is a visible editor of the new URI; a click opens no editor', async () => {
			const { doc, handle } = await withGraph('drive-real-old.yaml', SWITCH);
			await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Three, preserveFocus: false, preview: false });
			handle.panel.reveal(handle.panel.viewColumn, false);
			assert.ok(await waitFor(() => handle.panel.active, 10_000), 'the graph is focused');
			const renamed = uri('drive-real-new.yaml');
			const edit = new vscode.WorkspaceEdit();
			edit.renameFile(doc.uri, renamed);
			assert.ok(await vscode.workspace.applyEdit(edit));
			const editors = () => vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === renamed.toString());
			assert.ok(await waitFor(() => editors().length === 2, 10_000), 'both editors follow the rename');
			await settle();
			await handle.receive({ type: 'nodeActivated', nodeId: 'path:input', via: 'click' });
			const active = vscode.window.activeTextEditor!;
			assert.ok(editors().includes(active), `the click selects in an editor of the new URI (column ${active.viewColumn})`);
			assert.strictEqual(active.document.getText(active.selection), 'input:\n  stdin: {}');
			assert.strictEqual(editors().length, 2, 'no new editor');
			// The cursor moved in it: the graph follows the renamed file's driving editor.
			const at = active.document.positionAt(active.document.getText().indexOf('stdout'));
			active.selection = new vscode.Selection(at, at);
			// (The click's own selection, the input, may be the last one posted until then.)
			const followed = () => {
				const last = handle.posted.filter((m) => m.type === 'selection').at(-1);
				return last?.type === 'selection' && last.nodeId === 'path:output';
			};
			assert.ok(await waitFor(followed, 10_000), JSON.stringify(handle.posted.map((m) => (m.type === 'selection' ? `selection:${m.nodeId}` : m.type))));
		});
	});

	test('F8_BROKEN: while the YAML does not parse, a click or Enter on a node of the last valid graph does nothing', async () => {
		const { doc, editor, handle } = await withGraph('broken-click.yaml', SWITCH);
		await insert(doc, doc.getText().indexOf('output:'), ' ');
		assert.ok(await waitFor(() => live(handle).some((m) => m.type === 'parseError'), 10_000));
		const at = doc.positionAt(doc.getText().indexOf('stdin'));
		editor.selection = new vscode.Selection(at, at);
		await settle();
		const before = editor.selection;
		const count = handle.posted.length;
		for (const via of ['click', 'keyboard'] as const) {
			await handle.receive({ type: 'nodeActivated', nodeId: MAPPING_ID, via });
		}
		await settle();
		assert.ok(editor.selection.isEqual(before), 'no selection change');
		assert.strictEqual(vscode.window.visibleTextEditors.filter((e) => e.document === doc).length, 1, 'no editor opens');
		// (The real webview's own `ready` may still be answered with a snapshot meanwhile, LATE_SNAPSHOT.)
		assert.deepStrictEqual(handle.posted.slice(count).filter((m) => m.type !== 'snapshot'), [], 'nothing posted');
	});

	test('F11_LATE: a late schema with the cursor in the input and a lint finding: the model, then selection and nodeStatus', async () => {
		const doc = await open('late-combined.yaml', VALID);
		const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc)!;
		const at = doc.positionAt(doc.getText().indexOf('stdin'));
		editor.selection = new vscode.Selection(at, at);
		await loseBinary('late-combined');
		const fake = ownDiagnostics();
		try {
			fake.state.current = [error(doc, 'stdin', 'field nope not recognised')];
			const handle = (await fake.panels.show(doc.uri))!;
			await handle.receive({ type: 'ready' });
			const snapshot = handle.posted.filter((m) => m.type === 'snapshot').at(-1);
			assert.ok(snapshot?.type === 'snapshot' && snapshot.model === null, 'no model without a schema');
			const count = handle.posted.length;
			await restoreBinary();
			assert.ok(await waitFor(() => handle.posted.slice(count).some((m) => m.type === 'nodeStatus'), 30_000),
				JSON.stringify(handle.posted.slice(count).map((m) => m.type)));
			const after = handle.posted.slice(count).filter((m) => m.type !== 'hostStatus');
			assert.deepStrictEqual(after.map((m) => m.type), ['model', 'selection', 'nodeStatus']);
			const [, selection, status] = after;
			assert.ok(selection.type === 'selection' && selection.nodeId === 'path:input', JSON.stringify(selection));
			assert.ok(status.type === 'nodeStatus');
			assert.strictEqual(status.byId['path:input']?.severity, 'error', JSON.stringify(status.byId));
		} finally {
			fake.dispose();
			await restoreBinary();
		}
	});
});
