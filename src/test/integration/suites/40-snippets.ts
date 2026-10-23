import * as assert from 'assert';
import * as vscode from 'vscode';
import { openYaml, schemaFrom, useSchemaBinary } from '../schemaHarness';

suite('Pipeline snippets (integration)', function () {
	this.timeout(90_000);
	const h = useSchemaBinary();

	test('SNIPPETS (2.10): a blank file offers the starter; slots offer components; other YAML gets none', async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
		const labels = async (doc: vscode.TextDocument, line: number, ch: number) => (await vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(line, ch))).items
			.filter((it) => it.kind === vscode.CompletionItemKind.Snippet && typeof it.label !== 'string' && it.label.description === 'snippet')
			.map((it) => (it.label as vscode.CompletionItemLabel).label);
		const blank = await openYaml('blank.yaml', '');
		assert.ok((await labels(blank, 0, 0)).includes('Redpanda Connect pipeline'), 'blank file');
		const input = await openYaml('snip-input.yaml', 'input:\n  \noutput:\n  stdout: {}\n');
		assert.deepStrictEqual((await labels(input, 1, 2)).sort(), ['generate input', 'redpanda input']);
		const nested = await openYaml('snip-nested.yaml', 'input:\n  stdin: {}\npipeline:\n  processors:\n    - switch:\n        - check: a\n          processors:\n            - \n');
		assert.ok((await labels(nested, 7, 14)).includes('mapping processor'));
		const k8s = await openYaml('snip-k8s.yaml', 'kind: Pod\n\n');
		assert.deepStrictEqual(await labels(k8s, 1, 0), [], 'not a Redpanda Connect file');
	});

	test('BLANK_TYPED (ticket 11): typing rpcn in a blank file offers the starter and the sections, replacing the typed word; other words get none', async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
		const complete = async (doc: vscode.TextDocument, ch: number) => (await vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(0, ch))).items
			.filter((it) => it.kind === vscode.CompletionItemKind.Snippet && typeof it.label !== 'string' && it.label.description === 'snippet');
		const labelsOf = (items: vscode.CompletionItem[]) => items.map((it) => (it.label as vscode.CompletionItemLabel).label).sort();
		const sections = ['Redpanda Connect pipeline', 'input section', 'output section', 'pipeline section'];
		const typed = await openYaml('blank-typed.yaml', 'rpcn');
		const lower = await complete(typed, 4);
		assert.deepStrictEqual(labelsOf(lower), sections);
		assert.ok(lower.every((it) => (it.range as vscode.Range).isEqual(new vscode.Range(0, 0, 0, 4))), 'each item replaces the typed word');
		const dashed = await openYaml('blank-typed-dash.yaml', 'RPCN-pi\n');
		const items = await complete(dashed, 7);
		assert.deepStrictEqual(labelsOf(items), sections);
		const range = items[0].range as vscode.Range;
		assert.ok(range.isEqual(new vscode.Range(0, 0, 0, 7)), 'the whole typed word is replaced');
		const other = await openYaml('blank-typed-other.yaml', 'kind');
		assert.deepStrictEqual(await complete(other, 4), [], 'a word that starts no snippet prefix');
		const two = await openYaml('blank-typed-two.yaml', 'a rpcn');
		assert.deepStrictEqual(await complete(two, 6), [], 'more than the typed word');
		const indented = await openYaml('blank-typed-indented.yaml', '  rpcn');
		assert.deepStrictEqual(await complete(indented, 6), [], 'not at the top level');
		// A detected file keeps its own rules: the sections it has are left out.
		const detected = await openYaml('typed-detected.yaml', 'input:\n  stdin: {}\n\n');
		const inDetected = (await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', detected.uri, new vscode.Position(2, 0))).items
			.filter((it) => it.kind === vscode.CompletionItemKind.Snippet && typeof it.label !== 'string' && it.label.description === 'snippet');
		assert.ok(labelsOf(inDetected).includes('output section') && !labelsOf(inDetected).includes('input section'), 'the file has an input');
	});

	test('SNIPPETS (2.10): inserting the switch snippet on a nested list item gives valid, indented YAML', async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
		const doc = await openYaml('snip-insert.yaml', 'input:\n  stdin: {}\npipeline:\n  processors:\n    - \n');
		const editor = await vscode.window.showTextDocument(doc);
		const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(4, 6));
		const item = list.items.find((it) => typeof it.label !== 'string' && it.label.label === 'switch processor')!;
		assert.ok(await editor.insertSnippet(item.insertText as vscode.SnippetString, new vscode.Position(4, 6)));
		assert.strictEqual(doc.getText(), [
			'input:', '  stdin: {}', 'pipeline:', '  processors:',
			'    - switch:',
			'        - check: this.type == "a"',
			'          processors:',
			'            - mapping: |',
			'                root = this',
			'        - processors:',
			'            - log:',
			'                message: other',
			'',
		].join('\n'));
	});
});
