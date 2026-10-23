import * as assert from 'assert';
import * as vscode from 'vscode';
import type { GraphPanelHandle } from '../../../adapters/graphPanel/panels';
import { LintDiagnostics } from '../../../adapters/vscode/diagnostics';
import type { NodeStatusById } from '../../../shared/protocol';
import { waitFor } from '../helpers';
import { live, settle, SWITCH_ID, withGraph, replace, insert, open, fakeDiagnostics, testPanels, useGraphSuite } from '../graphHelpers';
import { api } from '../schemaHarness';

suite('Pipeline graph: markers (3.8, integration)', function () {
	this.timeout(60_000);
	useGraphSuite();
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

	test('HELD (story 13): a Red Hat marker stays on its node when a node is inserted above it before Red Hat republishes; the republish sends nothing new', async () => {
		const doc = await open('status-redhat.yaml', STATUS);
		// The real view (LintDiagnostics) over a Red Hat that republishes only when the test says.
		const redHat = new Map<string, vscode.Diagnostic[]>();
		const published = new vscode.EventEmitter<vscode.DiagnosticChangeEvent>();
		const view = new LintDiagnostics({
			detection: api().detection, log: () => undefined, lint: async () => ({ kind: 'findings', findings: [], logLines: [] }),
			source: {
				get textDocuments() { return vscode.workspace.textDocuments; },
				onDidSaveTextDocument: vscode.workspace.onDidSaveTextDocument,
				onDidChangeTextDocument: vscode.workspace.onDidChangeTextDocument,
				onDidCloseTextDocument: vscode.workspace.onDidCloseTextDocument,
				onDidChangeDiagnostics: published.event,
				getDiagnostics: (uri) => redHat.get(uri.toString()) ?? [],
				createDiagnosticCollection: (name) => vscode.languages.createDiagnosticCollection(`${name}-held`),
			},
		});
		// Created after the view, as at activation: the view hears each edit first.
		const panels = testPanels({ diagnostics: view });
		const MESSAGE = 'Property message is odd';
		const republish = () => {
			const at = doc.positionAt(doc.getText().indexOf('message: hi'));
			const d = new vscode.Diagnostic(new vscode.Range(at, at.translate(0, 1)), MESSAGE, vscode.DiagnosticSeverity.Warning);
			d.source = 'yaml-schema: test';
			redHat.set(doc.uri.toString(), [d]);
			published.fire({ uris: [doc.uri] });
		};
		try {
			const handle = (await panels.show(doc.uri))!;
			await handle.receive({ type: 'ready' });
			republish();
			assert.ok(await waitFor(() => statuses(handle).at(-1)?.[LOG_ID]?.own === 'warning', 10_000), 'marked');
			const before = statuses(handle).length;
			const postedBefore = handle.posted.length;
			// Two lines above the switch: Red Hat's stale range now lies on the case's `processors:` line.
			await insert(doc, doc.getText().indexOf('    - switch:'), '    - log:\n        message: top\n');
			assert.ok(await waitFor(() => live(handle).at(-1)?.type === 'model' && statuses(handle).length > before, 10_000), 'the edit\'s model and status');
			// The status follows the model it describes, never before it (the old model would show it).
			const posts = handle.posted.slice(postedBefore).map((m) => m.type);
			assert.ok(posts.indexOf('model') >= 0 && posts.indexOf('model') < posts.indexOf('nodeStatus'), `${posts}`);
			await settle();
			const movedSwitch = 'path:pipeline.processors[1]';
			const movedLog = `${movedSwitch}.switch[0].processors[0]`;
			for (const status of statuses(handle).slice(before)) {
				// Its own marker only on the log (messages roll up to the groups above, own ones do not).
				const own = Object.entries(status).filter(([, s]) => s.ownMessages?.includes(MESSAGE)).map(([id]) => id);
				assert.deepStrictEqual(own, [movedLog], `AC 1, never on another node: ${JSON.stringify(status)}`);
				assert.strictEqual(status[movedLog]?.own, 'warning', `held on the log: ${JSON.stringify(status)}`);
			}
			// AC 2: Red Hat republishes at the shifted position: the mapped status is the same, nothing is sent.
			const count = statuses(handle).length;
			republish();
			await settle();
			assert.strictEqual(statuses(handle).length, count, 'no new nodeStatus');
		} finally {
			panels.dispose();
			view.dispose();
			published.dispose();
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
});
