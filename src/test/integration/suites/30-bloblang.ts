import * as assert from 'assert';
import * as vscode from 'vscode';
import { waitForAsync } from '../helpers';
import { completionOffers, hoverText, openYaml, schemaFrom, useSchemaBinary } from '../schemaHarness';

suite('Bloblang completion and hover (integration)', function () {
	this.timeout(90_000);
	const h = useSchemaBinary();

	test('BLOBLANG (2.19): functions and methods in a mapping block, hover on a call, nothing outside', async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
		const doc = await openYaml('blobl.yaml', 'pipeline:\n  processors:\n    - mapping: |\n        root.id = \n        root.n = this.name.\n        root.at = now()\n    - log:\n        message: x\n');
		await completionOffers(doc, new vscode.Position(3, 18), ['uuid_v4', 'now', 'random_int']);
		await completionOffers(doc, new vscode.Position(4, 27), ['uppercase', 'replace_all', 'parse_json']);
		const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(3, 18));
		const uuid = list.items.find((it) => it.label === 'uuid_v4')!;
		assert.strictEqual(uuid.kind, vscode.CompletionItemKind.Function);
		assert.ok(uuid.documentation instanceof vscode.MarkdownString && uuid.documentation.value.startsWith('**uuid_v4** function'));
		let text = '';
		assert.ok(await waitForAsync(async () => {
			text = await hoverText(doc, new vscode.Position(5, 19));
			return text.includes('**now** function');
		}, 30_000), text);
		const outside = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(7, 18));
		assert.ok(!outside.items.some((it) => it.label === 'uuid_v4'), 'not in a plain message: value');
	});

	test('BLOBLANG_NAMES (2.20): this.test assigned above is offered first, with its line; $ and @ names', async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
		const doc = await openYaml('names.yaml', 'pipeline:\n  processors:\n    - mapping: |\n        this.test = content().string()\n        meta src = "x"\n        let h = this.\n        root.v = $\n        root.m = @\n');
		const at = async (line: number, ch: number, trigger?: string) => (await vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(line, ch), trigger)).items;
		const afterDot = await at(5, 21, '.');
		const test = afterDot.find((it) => it.label === 'test')!;
		assert.ok(test, afterDot.slice(0, 10).map((it) => it.label).join(','));
		assert.strictEqual(test.kind, vscode.CompletionItemKind.Field);
		assert.strictEqual(test.detail, 'assigned on line 4');
		assert.ok(afterDot.indexOf(test) < afterDot.findIndex((it) => it.label === 'uppercase'), 'fields before methods');
		assert.ok((await at(6, 18)).some((it) => it.label === 'h'), '$h');
		assert.ok((await at(7, 18)).some((it) => it.label === 'src'), '@src');
	});

	test('BLOBLANG_TYPES (2.21): after "test". only methods that apply to strings', async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
		const doc = await openYaml('types.yaml', 'pipeline:\n  processors:\n    - mapping: |\n        root.a = "test".\n');
		const items = (await vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(3, 24), '.')).items;
		const labels = items.map((it) => (typeof it.label === 'string' ? it.label : it.label.label));
		assert.ok(labels.includes('uppercase') && labels.includes('parse_json'), labels.slice(0, 10).join(','));
		assert.ok(!labels.includes('abs') && !labels.includes('append'), 'no number or array methods');
		assert.ok(items.find((it) => it.label === 'uppercase')!.detail!.endsWith('· for strings'));
	});

	test('BLOBLANG (2.19): the dot trigger, deprecated tag, word replacement and an existing paren', async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
		const doc = await openYaml('blobl2.yaml', 'pipeline:\n  processors:\n    - mapping: |\n        root.n = this.name.\n        root.m = meta("x")\n        root.u = this.a.upp()\n');
		// The '.' trigger: VS Code passes the trigger character; our provider answers for it.
		const triggered = await vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(3, 27), '.');
		assert.ok(triggered.items.some((it) => it.label === 'uppercase'), 'methods after the dot trigger');
		const functions = await vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(4, 17));
		assert.deepStrictEqual(functions.items.find((it) => it.label === 'meta')?.tags, [vscode.CompletionItemTag.Deprecated]);
		// `this.a.upp|()`: the whole word is replaced and no second ( is added.
		const word = await vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(5, 27));
		const upper = word.items.find((it) => it.label === 'uppercase')!;
		assert.strictEqual((upper.insertText as vscode.SnippetString).value, 'uppercase');
		const range = upper.range as { inserting: vscode.Range; replacing: vscode.Range };
		assert.deepStrictEqual([range.replacing.start.character, range.replacing.end.character], [24, 27]);
	});
});
