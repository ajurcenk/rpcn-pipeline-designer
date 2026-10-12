import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GraphPanelHandle } from '../../../adapters/graphPanel/panels';
import { INSTALL_GUIDE_URL } from '../../../adapters/redpandaConnect/notify';
import type { HostStatus, PipelineModel, SnapshotMessage } from '../../../shared/protocol';
import { waitFor } from '../helpers';
import { ids, live, VALID, settle, withGraph, replace, insert, open, testPanels, loseBinary, restoreBinary, fakeActions, useGraphSuite } from '../graphHelpers';
import { api, EXTRA_INPUT, setBinaryPath } from '../schemaHarness';

suite('Pipeline graph: empty states (3.9, integration)', function () {
	this.timeout(60_000);
	const h = useGraphSuite();
	// Host status and empty states (3.9, AD-9, AD-20).
	/** The `hostStatus` messages posted, in order. */
	const hostStatuses = (handle: GraphPanelHandle): HostStatus[] =>
		handle.posted.flatMap((m) => (m.type === 'hostStatus' ? [{ binary: m.binary, schema: m.schema }] : []));
	const lastSnapshot = (handle: GraphPanelHandle) => handle.posted.filter((m): m is SnapshotMessage => m.type === 'snapshot').at(-1);
	const models = (handle: GraphPanelHandle): PipelineModel[] => handle.posted.flatMap((m) => (m.type === 'model' ? [m.model] : []));

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
});
