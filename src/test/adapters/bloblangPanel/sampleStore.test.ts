// The samples file's rename (ticket 4.17): the case-only predicate, and the caches after a move that
// did not happen.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { caseOnlyRename, SampleStore } from '../../../adapters/bloblangPanel/sampleStore';

suite('adapters/bloblangPanel sampleStore: rename (4.17)', () => {
	test('caseOnlyRename: only a change of case is one', () => {
		const u = (p: string) => vscode.Uri.file(p);
		assert.strictEqual(caseOnlyRename(u('/d/orders.samples.json'), u('/d/Orders.samples.json')), true);
		assert.strictEqual(caseOnlyRename(u('/d/orders.samples.json'), u('/D/ORDERS.SAMPLES.JSON')), true);
		assert.strictEqual(caseOnlyRename(u('/d/orders.samples.json'), u('/d/orders.samples.json')), false, 'the same path');
		assert.strictEqual(caseOnlyRename(u('/d/orders.samples.json'), u('/d/orders2.samples.json')), false);
	});

	test('EXISTS: the target samples file is left, and reading it is no outside edit', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-samples-'));
		const store = new SampleStore(() => undefined);
		try {
			const file = (name: string, label: string) => fs.writeFileSync(path.join(dir, name),
				JSON.stringify({ version: 1, mappings: [{ label, selected: null, samples: [{ name: 's', content: '', meta: {} }] }] }));
			file('a.samples.json', 'mine');
			file('b.samples.json', 'theirs');
			fs.writeFileSync(path.join(dir, 'b.yaml'), 'input: {}\n');
			const a = vscode.Uri.file(path.join(dir, 'a.yaml'));
			const b = vscode.Uri.file(path.join(dir, 'b.yaml'));
			assert.strictEqual((await store.read(a)).kind, 'ok');
			const changed: string[] = [];
			store.onDidChange((config) => changed.push(config.toString()));
			store.rekey(a, b);
			assert.strictEqual(await store.moveFile(a, b), 'exists');
			const state = await store.read(b);
			assert.ok(state.kind === 'ok' && state.file?.mappings[0].label === 'theirs');
			assert.deepStrictEqual(changed, [], 'not an outside edit');
			assert.ok(fs.existsSync(path.join(dir, 'a.samples.json')), 'the old one is left');
		} finally {
			store.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
