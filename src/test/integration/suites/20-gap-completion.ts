import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { GapCompletionProvider } from '../../../adapters/vscode/completion';
import { waitForAsync } from '../helpers';
import { api, completionOffers, hoverText, openYaml, schemaFrom, useSchemaBinary } from '../schemaHarness';

suite('Completion where Red Hat returns none (integration)', function () {
	this.timeout(90_000);
	const h = useSchemaBinary();

	/** Our provider alone, with the live schema and detection (to tell our items from Red Hat's). */
	function ours(doc: vscode.TextDocument, position: vscode.Position, options: { schema?: boolean; detected?: boolean } = {}): string[] | undefined {
		const provider = new GapCompletionProvider({
			schema: () => (options.schema === false ? undefined : api().schemaStore.current?.json),
			isDetected: (uri) => (options.detected === false ? false : api().detection.isDetected(uri)),
		});
		return provider.provideCompletionItems(doc, position)?.map((it) => (typeof it.label === 'string' ? it.label : it.label.label));
	}

	/** Schema labels of the merged list (word suggestions and our 2.10 snippet items dropped). */
	async function merged(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
		const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, position);
		return (list?.items ?? []).filter((it) => it.kind !== vscode.CompletionItemKind.Text
			&& !(typeof it.label !== 'string' && it.label.description === 'snippet'));
	}

	const labelOf = (it: vscode.CompletionItem) => (typeof it.label === 'string' ? it.label : it.label.label);

	/** Waits until Red Hat has the schema for `doc` and answers: hover on its first (root) key. */
	async function redHatReady(doc: vscode.TextDocument): Promise<void> {
		let text = '';
		assert.ok(await waitForAsync(async () => {
			text = await hoverText(doc, new vscode.Position(0, 1));
			return text.length > 0;
		}, 30_000), `Red Hat did not answer for ${doc.uri.path}`);
	}

	test('GAP_COMPLETION (2.16): an empty socket block offers its 8 fields with docs; an empty option value its options', async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
		const block = await openYaml('gap-block.yaml', 'input:\n  socket:\n    \noutput:\n  stdout: {}\n\n');
		await completionOffers(block, new vscode.Position(2, 4), ['address', 'network', 'tls', 'codec']);
		const items = (await merged(block, new vscode.Position(2, 4))).filter((it) => it.kind === vscode.CompletionItemKind.Property);
		assert.deepStrictEqual(items.map(labelOf).sort(),
			['address', 'auto_replay_nacks', 'codec', 'max_buffer', 'network', 'open_message_mapping', 'scanner', 'tls']);
		const network = items.find((it) => labelOf(it) === 'network')!;
		assert.ok(network.documentation instanceof vscode.MarkdownString && network.documentation.value.includes('Options: `unix`, `tcp`'));
		const value = await openYaml('gap-value.yaml', 'input:\n  socket_server:\n    network: \n');
		await completionOffers(value, new vscode.Position(2, 13), ['unix', 'tcp', 'udp', 'tls', 'unixgram']);
		assert.deepStrictEqual(ours(value, new vscode.Position(2, 13)), ['unix', 'tcp', 'udp', 'tls', 'unixgram']);
	});

	test('NO_DUPLICATES / SILENT (2.16): at gaps only we answer; at Red Hat positions only Red Hat answers', async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
		// [text, line, ch, gap]; Red Hat readiness is checked by a hover on the first root key.
		const cases: [string, number, number, boolean][] = [
			['input:\n  socket:\n    \n', 2, 4, true],
			['input:\n  socket:\n    ad\n', 2, 6, true],
			['input:\n  socket:\n    network: tcp\n    tls:\n      \n', 4, 6, true],
			['pipeline:\n  processors:\n    - branch:\n        \n', 3, 8, true],
			['cache_resources:\n  - label: c\n    memory:\n      \n', 3, 6, true],
			['output:\n  broker:\n    outputs:\n      - stdout:\n          \n', 4, 10, true],
			['input:\n  socket_server:\n    network: \n', 2, 13, true],
			['input:\n  socket:\n    auto_replay_nacks: \n', 2, 23, true],
			['input:\n  socket_server:\n    network: tcp\n    tls:\n      client_auth: \n', 4, 19, true],
			['pipeline:\n  processors:\n    - switch:\n        - check: A\n          processors:\n            - \n', 5, 14, true],
			['output:\n  broker:\n    outputs:\n      - \n', 3, 8, true],
			['input:\n  socket:\n    network: tcp\n    tls:\n      client_certs:\n        - \n', 5, 10, true],
			['input:\n  socket:\n    network: tcp\n    \n', 3, 4, false],
			['input:\n  stdin: {}\nlogger:\n  \n', 3, 2, false],
			['input:\n  stdin: {}\nlogger:\n  level: \n', 3, 9, false],
			['input:\n  \n', 1, 2, false],
			['pipeline:\n  processors:\n    - \n', 2, 6, false],
			['input:\n  stdin: {}\nlogger:\n  file:\n    \n', 4, 4, false],
			['input:\n  stdin: {}\nhttp:\n  cors:\n    \n', 4, 4, false],
		];
		for (const [i, [body, line, ch, gap]] of cases.entries()) {
			const doc = await openYaml(`dup${i}.yaml`, body);
			await redHatReady(doc);
			const position = new vscode.Position(line, ch);
			const mine = ours(doc, position) ?? [];
			const all = (await merged(doc, position)).map(labelOf);
			const dupes = all.filter((l, j) => all.indexOf(l) !== j);
			assert.deepStrictEqual(dupes, [], `case ${i}: duplicates ${JSON.stringify(body)}`);
			if (gap) {
				assert.ok(mine.length > 0, `case ${i}: we should answer ${JSON.stringify(body)}`);
				assert.deepStrictEqual([...all].sort(), [...mine].sort(), `case ${i}: Red Hat answered at a gap ${JSON.stringify(body)}`);
			} else {
				assert.deepStrictEqual(mine, [], `case ${i}: we must stay silent ${JSON.stringify(body)}`);
				assert.ok(all.length > 0, `case ${i}: Red Hat should answer ${JSON.stringify(body)}`);
			}
		}
	});

	test('NOT_DETECTED / NO_SCHEMA (2.16): no items', async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
		const doc = await openYaml('gap-guard.yaml', 'input:\n  socket:\n    \n');
		const position = new vscode.Position(2, 4);
		assert.ok((ours(doc, position) ?? []).length > 0, 'control: items with schema and detection');
		assert.strictEqual(ours(doc, position, { detected: false }), undefined);
		assert.strictEqual(ours(doc, position, { schema: false }), undefined);
		const k8s = await openYaml('gap-k8s.yaml', 'kind: Pod\nspec:\n  socket:\n    \n');
		assert.ok(!api().detection.isDetected(k8s.uri));
		assert.strictEqual(ours(k8s, new vscode.Position(3, 4)), undefined);
	});

	test('SNIPPETS (2.16): object, scalar-with-default and partial-key items insert valid, indented YAML', async () => {
		await schemaFrom(h.fakeBinary, '4.112.0');
		const insert = async (body: string, line: number, ch: number, label: string): Promise<string> => {
			const doc = await openYaml(`snip-${label}.yaml`, body);
			const editor = await vscode.window.showTextDocument(doc);
			const provider = new GapCompletionProvider({ schema: () => api().schemaStore.current?.json, isDetected: () => true });
			const position = new vscode.Position(line, ch);
			const item = provider.provideCompletionItems(doc, position)!.find((it) => it.label === label)!;
			const range = doc.getWordRangeAtPosition(position) ?? new vscode.Range(position, position);
			assert.ok(await editor.insertSnippet(item.insertText as vscode.SnippetString, range));
			return doc.getText();
		};
		assert.strictEqual(await insert('input:\n  socket:\n    \n', 2, 4, 'tls'), 'input:\n  socket:\n    tls:\n      \n');
		assert.strictEqual(await insert('input:\n  socket:\n    \n', 2, 4, 'socket: required fields'),
			'input:\n  socket:\n    network: unix\n    address: \n', 'the first choice is inserted; lines keep the block indent');
		assert.strictEqual(await insert('input:\n  socket:\n    \n', 2, 4, 'max_buffer'), 'input:\n  socket:\n    max_buffer: 1000000\n');
		assert.strictEqual(await insert('input:\n  socket:\n    ad\n', 2, 6, 'address'), 'input:\n  socket:\n    address: \n');
		assert.strictEqual(await insert('pipeline:\n  processors:\n    - switch:\n        - check: A\n          processors:\n            - \n', 5, 14, 'log'),
			'pipeline:\n  processors:\n    - switch:\n        - check: A\n          processors:\n            - log:\n                \n',
			'a component in a nested list item: its fields go under the name');
		assert.strictEqual(await insert('input:\n  socket:\n    network: tcp\n    tls:\n      \n', 4, 6, 'client_certs'),
			'input:\n  socket:\n    network: tcp\n    tls:\n      client_certs:\n        - \n');
	});
});
