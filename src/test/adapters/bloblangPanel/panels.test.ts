import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BloblangPanels, NO_MAPPING_AT_CURSOR } from '../../../adapters/bloblangPanel/panels';
import { FakePanelSource, fakeDocument } from '../../helpers/fakePanelSource';

// Story 55 (story 50 group B): the Bloblang test panel registry driven through a fake
// `BloblangPanelsSource`, with no real panel, editor or tab: Test mapping with no mapping at the
// cursor, a second open that reveals, and a panel following its file's tab close and rename.

const CONFIG = [
	'input:',
	'  stdin: {}',
	'pipeline:',
	'  processors:',
	'    - mapping: root = this',
	'output:',
	'  drop: {}',
	'',
].join('\n');
const PROCESSOR = 'pipeline.processors[0]';

suite('adapters/bloblangPanel BloblangPanels through a fake Source (story 55)', () => {
	let fake: FakePanelSource;
	let panels: BloblangPanels;
	let shown: { readonly message: string; readonly kind: string | undefined }[];
	let dir: string;

	setup(() => {
		fake = new FakePanelSource();
		shown = [];
		// Only the samples store touches the disk (its files sit beside the config): a scratch folder.
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-bloblang-panels-'));
		panels = new BloblangPanels({
			extensionUri: vscode.Uri.file('/fake/extension'),
			log: () => undefined,
			binary: { state: { kind: 'missing' }, onDidChange: () => ({ dispose: () => undefined }) },
			actions: undefined,
			storageDir: dir,
			detection: { isDetected: () => true },
			showMessage: (message, kind) => shown.push({ message, kind }),
			source: fake.bloblang,
		});
	});

	teardown(() => {
		panels.dispose();
		fake.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** An open config `name` in the fake's documents, with a text tab in column One. */
	const config = (name: string) => {
		const uri = vscode.Uri.file(path.join(dir, name));
		fake.textDocuments.push(fakeDocument(uri, CONFIG));
		const tab = fake.tabGroups.all[0].addText(uri);
		return { uri, tab };
	};

	test('Test mapping with no editor shows NO_MAPPING_AT_CURSOR and opens nothing', async () => {
		assert.strictEqual(await panels.testMapping(), undefined);
		assert.deepStrictEqual(shown, [{ message: NO_MAPPING_AT_CURSOR, kind: 'info' }]);
		assert.strictEqual(fake.created.length, 0);
	});

	test('a second open of the same processor reveals its panel', async () => {
		const { uri } = config('a.yaml');
		const first = await panels.show(uri, PROCESSOR);
		assert.ok(first);
		assert.strictEqual(fake.created.length, 1);
		assert.strictEqual(first.panel, fake.created[0]);
		assert.strictEqual(panels.panelFor(uri, PROCESSOR), first);
		const second = await panels.testMapping(uri, PROCESSOR);
		assert.strictEqual(second, first);
		assert.strictEqual(fake.created.length, 1, 'no second panel');
		assert.deepStrictEqual(fake.created[0].reveals.at(-1), { column: undefined, preserveFocus: true });
	});

	test('closing the file\'s last text tab closes its panel', async () => {
		const { uri, tab } = config('a.yaml');
		await panels.show(uri, PROCESSOR);
		fake.tabGroups.all[0].remove(tab);
		fake.tabsClosed([tab]);
		assert.strictEqual(fake.created[0].disposed, true);
		assert.strictEqual(panels.panelFor(uri, PROCESSOR), undefined);
		assert.strictEqual(panels.size, 0);
	});

	test('a will/did rename moves the panel to the new file', async () => {
		const { uri, tab } = config('a.yaml');
		const handle = await panels.show(uri, PROCESSOR);
		const to = vscode.Uri.file(path.join(dir, 'b.yaml'));
		fake.files.add(uri.toString());
		// The tab moves with the file, as VS Code's does.
		fake.tabGroups.all[0].remove(tab);
		fake.tabGroups.all[0].addText(to);
		await fake.rename(uri, to);
		assert.strictEqual(handle?.uri.toString(), to.toString());
		assert.strictEqual(panels.panelFor(to, PROCESSOR), handle);
		assert.strictEqual(panels.panelFor(uri, PROCESSOR), undefined);
		assert.strictEqual(fake.created[0].disposed, false);
		assert.strictEqual(fake.created[0].title, 'Bloblang: pipeline.processors[0]');
	});
});
