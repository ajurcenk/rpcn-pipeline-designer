import * as assert from 'assert';
import * as vscode from 'vscode';
import type { GraphPanelHandle } from '../../../adapters/graphPanel/panels';
import type { NodeStatusById } from '../../../shared/protocol';
import { waitFor } from '../helpers';
import { live, settle, SWITCH_ID, withGraph, replace, insert, open, fakeDiagnostics, useGraphSuite } from '../graphHelpers';
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
