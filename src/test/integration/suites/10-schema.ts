import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { REPO_ROOT } from '../../helpers/fakeBinary';
import { waitFor, waitForAsync } from '../helpers';
import { api, completionLabels, completionOffers, EXTRA_INPUT, hoverText, openYaml, schemaFrom, setBinaryPath, useSchemaBinary } from '../schemaHarness';

suite('Schema contributor (integration)', function () {
	this.timeout(90_000);
	const h = useSchemaBinary();

	test('DETECTED: in a corpus config, completion under input: offers component names; hover shows the merged description', async () => {
		const corpusFile = path.join(REPO_ROOT, 'test', 'corpus', 'joining_streams.yaml');
		const doc = await vscode.workspace.openTextDocument(corpusFile);
		await vscode.window.showTextDocument(doc);
		assert.strictEqual(doc.languageId, 'yaml');
		assert.ok(doc.lineAt(1).text.startsWith('  broker:') && doc.lineAt(4).text.startsWith('          seed_brokers:'),
			'joining_streams.yaml layout changed');
		assert.strictEqual(api().detection.isDetected(doc.uri), true);
		const schemaUri = api().schemaContributor.requestSchema(doc.uri.toString());
		assert.ok(schemaUri?.startsWith('rpcn-schema://schema/'), String(schemaUri));

		// Completion at the `broker` key under `input:` offers the other input components.
		await completionOffers(doc, new vscode.Position(1, 2), ['generate', 'kafka_franz']);

		// Hover on `input.broker.inputs[0].redpanda.seed_brokers` shows the json-full description.
		let text = '';
		const ok = await waitForAsync(async () => {
			text = await hoverText(doc, new vscode.Position(4, 12));
			return text.includes('A list of broker addresses to connect to');
		}, 30_000);
		assert.ok(ok, `hover on redpanda.seed_brokers: ${text}`);
		assert.ok(!doc.isDirty);
	});

	test('NOT_DETECTED: a YAML file without Redpanda Connect keys gets no schema', async () => {
		const doc = await openYaml('k8s.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: web\n\n');
		assert.strictEqual(api().detection.isDetected(doc.uri), false);
		assert.strictEqual(api().schemaContributor.requestSchema(doc.uri.toString()), undefined);
		const labels = await completionLabels(doc, new vscode.Position(4, 0));
		for (const key of ['input', 'pipeline', 'output', 'cache_resources']) {
			assert.ok(!labels.includes(key), `unexpected Redpanda Connect completion "${key}": ${labels.join(', ')}`);
		}
		assert.strictEqual(await hoverText(doc, new vscode.Position(1, 1)), '');
	});

	test('INCOMPLETE_COMPONENT (2.13): a component missing a required field still offers its fields', async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
		const doc = await openYaml('incomplete.yaml', 'output:\n  file:\n    codec: lines\n    \n');
		await completionOffers(doc, new vscode.Position(3, 4), ['path']);
	});

	test('VALUE_OPTIONS (2.13): typing a value after codec: offers the documented options', async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
		// One character typed (as VS Code's quick suggestions do); an empty value inside a component
		// gets nothing from Red Hat 1.24.0 (open question in the E2 notes).
		const doc = await openYaml('options.yaml', 'output:\n  file:\n    path: x\n    codec: l\n');
		await completionOffers(doc, new vscode.Position(3, 12), ['all-bytes', 'append', 'delim:x', 'lines']);
		// The option descriptions reach the completion items.
		const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(3, 12));
		const allBytes = list.items.find((i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'all-bytes');
		const docText = (d: vscode.CompletionItem['documentation']) => (typeof d === 'string' ? d : d?.value ?? '');
		assert.ok(docText(allBytes?.documentation).startsWith('Only applicable to file based outputs.'), docText(allBytes?.documentation));
	});

	test('VALUE_OPTIONS outside a component: an empty logger.level offers its options', async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
		const doc = await openYaml('level.yaml', 'input:\n  stdin: {}\nlogger:\n  level: \n');
		await completionOffers(doc, new vscode.Position(3, 9), ['ERROR', 'WARN', 'INFO', 'DEBUG']);
	});

	test('FREE_STRING (2.13): a value outside the options gets no schema diagnostic', async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
		const doc = await openYaml('free.yaml', 'output:\n  file:\n    path: x\n    codec: delim:foobar\nlogger:\n  level: [1]\n');
		// Positive control: Red Hat validates this file (the wrong type for logger.level is flagged).
		const schemaDiagnostics = () => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source?.startsWith('yaml-schema'));
		assert.ok(await waitFor(() => schemaDiagnostics().length > 0, 30_000), 'Red Hat did not validate the file');
		assert.deepStrictEqual(schemaDiagnostics().filter((d) => d.range.start.line === 3).map((d) => d.message), []);
	});

	test('HOVER_NETWORK (2.15): hovering a field with options lists them', async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
		const doc = await openYaml('hover-options.yaml', 'input:\n  socket_server:\n    network: tcp\n    address: x\n');
		let text = '';
		assert.ok(await waitForAsync(async () => {
			text = await hoverText(doc, new vscode.Position(2, 6));
			return text.includes('Options: `unix`, `tcp`, `udp`, `tls`, `unixgram`');
		}, 30_000), text);
	});

	test('BECOMES_DETECTED: typing pipeline: into a new YAML file brings completion without reopening', async () => {
		const doc = await openYaml('becomes.yaml', '');
		assert.strictEqual(api().detection.isDetected(doc.uri), false);
		const edit = new vscode.WorkspaceEdit();
		edit.insert(doc.uri, new vscode.Position(0, 0), 'pipeline:\n  processors:\n    - \n');
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.strictEqual(api().detection.isDetected(doc.uri), true);
		await completionOffers(doc, new vscode.Position(2, 6), ['mapping', 'bloblang']);
	});

	test('BECOMES_DETECTED (2.2): typing input: fires one onDidChangeDetection without reopening', async () => {
		const doc = await openYaml('typed.yaml', '');
		const events: { uri: string; detected: boolean }[] = [];
		const sub = api().detection.onDidChangeDetection((e) => events.push(e));
		try {
			for (const text of ['in', 'put:', '\n  stdin: {}\n']) {
				const edit = new vscode.WorkspaceEdit();
				edit.insert(doc.uri, doc.positionAt(doc.getText().length), text);
				assert.ok(await vscode.workspace.applyEdit(edit));
			}
			assert.strictEqual(api().detection.isDetected(doc.uri), true);
			assert.deepStrictEqual(events, [{ uri: doc.uri.toString(), detected: true }]);
		} finally {
			sub.dispose();
		}
	});

	test('PATTERN (2.2): filePatterns detects a template and a key-less file; clearing it recomputes', async () => {
		const template = await openYaml('t.rpcn.yaml', 'name: t\ntype: input\nmapping: |\n  root = {}\ninput:\n  stdin: {}\n');
		const plain = await openYaml('p.rpcn.yaml', 'foo: 1\n');
		const detection = api().detection;
		assert.strictEqual(detection.isDetected(template.uri), false);
		assert.strictEqual(detection.isDetected(plain.uri), false);
		const config = vscode.workspace.getConfiguration('redpandaConnect');
		const events: { uri: string; detected: boolean }[] = [];
		const sub = detection.onDidChangeDetection((e) => events.push(e));
		const flips = (detected: boolean) => events.filter((e) => e.detected === detected).map((e) => e.uri).sort();
		const both = [template.uri.toString(), plain.uri.toString()].sort();
		try {
			await config.update('filePatterns', ['**/*.rpcn.yaml'], vscode.ConfigurationTarget.Global);
			assert.ok(await waitFor(() => detection.isDetected(template.uri) && detection.isDetected(plain.uri), 5_000));
			assert.deepStrictEqual(flips(true), both);
		} finally {
			await config.update('filePatterns', undefined, vscode.ConfigurationTarget.Global);
		}
		assert.ok(await waitFor(() => !detection.isDetected(template.uri) && !detection.isDetected(plain.uri), 5_000));
		sub.dispose();
		assert.deepStrictEqual(flips(true), both, 'one detected: true per file');
		assert.deepStrictEqual(flips(false), both, 'one detected: false per file');
	});

	test('SCHEMA_CHANGES: a snapshot for another binary version is used by the open file without reopening', async () => {
		const doc = await openYaml('changes.yaml', 'input:\n  \n');
		const before = await schemaFrom(h.fakeBinary, '4.112.0');
		const oldUri = api().schemaContributor.requestSchema(doc.uri.toString());
		const labels = await completionOffers(doc, new vscode.Position(1, 2), ['generate']);
		assert.ok(!labels.includes(EXTRA_INPUT));

		await setBinaryPath(h.changedBinary);
		const after = await schemaFrom(h.changedBinary, '4.113.0');
		assert.notStrictEqual(after, before);
		const newUri = api().schemaContributor.requestSchema(doc.uri.toString());
		assert.ok(newUri && newUri !== oldUri, `${oldUri} -> ${newUri}`);
		await completionOffers(doc, new vscode.Position(1, 2), [EXTRA_INPUT, 'generate']);
	});
});
