import * as assert from 'assert';
import * as vscode from 'vscode';
import { GraphPanels, HIDDEN_GRAPHS_STATE, type GraphPanelsOptions } from '../../../adapters/graphPanel/panels';
import { FakePanelSource, fakeDocument, fakeEditor, type FakeWebviewPanel } from '../../helpers/fakePanelSource';

// Story 55 (story 50 group B): the graph panel registry driven through a fake `GraphPanelsSource`,
// with no real panel, editor or tab: show, reveal, dispose, Hide, the last tab's close and a rename.

const uri = (name: string) => vscode.Uri.file(`/fake/graph/${name}`);

/** A memento that records its updates. */
function fakeMemento(): vscode.Memento & { readonly updates: { readonly key: string; readonly value: unknown }[] } {
	const values = new Map<string, unknown>();
	const updates: { key: string; value: unknown }[] = [];
	return {
		updates,
		keys: () => [...values.keys()],
		get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback),
		update: (key: string, value: unknown) => {
			values.set(key, value);
			updates.push({ key, value });
			return Promise.resolve();
		},
	} as vscode.Memento & { readonly updates: { readonly key: string; readonly value: unknown }[] };
}

suite('adapters/graphPanel GraphPanels through a fake Source (story 55)', () => {
	let fake: FakePanelSource;
	let panels: GraphPanels;
	let log: string[];
	let memento: ReturnType<typeof fakeMemento>;

	const make = (overrides: Partial<GraphPanelsOptions> = {}) => {
		const none = () => ({ dispose: () => undefined });
		panels = new GraphPanels({
			extensionUri: vscode.Uri.file('/fake/extension'),
			log: (line) => log.push(line),
			binary: { state: { kind: 'missing' }, onDidChange: none },
			schema: { current: undefined, loading: false, onDidChange: none, settled: () => Promise.resolve() },
			diagnostics: { diagnosticsFor: () => [], onDidChangeDiagnostics: none },
			actions: undefined,
			memento,
			setContext: () => undefined,
			ignoreWebviewMessages: true,
			// No real group to become active: the lock sequence ends at once.
			lockWaitMs: 0,
			lockLateWindowMs: 0,
			source: fake.graph,
			...overrides,
		});
		return panels;
	};

	setup(() => {
		fake = new FakePanelSource();
		log = [];
		memento = fakeMemento();
	});

	teardown(() => {
		panels?.dispose();
		fake.dispose();
	});

	test('show creates one panel through the Source; a second show reveals it without focus', async () => {
		make();
		const a = uri('a.yaml');
		const first = await panels.show(a);
		assert.ok(first);
		assert.strictEqual(fake.created.length, 1);
		const panel = fake.created[0];
		assert.strictEqual(first.panel, panel);
		assert.strictEqual(panel.title, 'Graph: a.yaml');
		assert.strictEqual(panels.size, 1);
		const second = await panels.show(a);
		assert.strictEqual(second, first);
		assert.strictEqual(fake.created.length, 1, 'no second panel');
		assert.deepStrictEqual(panel.reveals.at(-1), { column: undefined, preserveFocus: true });
	});

	test('a disposed panel leaves panelFor empty', async () => {
		make();
		const a = uri('a.yaml');
		await panels.show(a);
		fake.created[0].dispose();
		assert.strictEqual(panels.panelFor(a), undefined);
		assert.strictEqual(panels.size, 0);
	});

	test('Hide closes the panel, stores the Hide in the memento and suppresses auto-open', async () => {
		make({ detection: { isDetected: () => true, markDetected: () => undefined }, autoOpen: () => true });
		const a = uri('a.yaml');
		await panels.show(a);
		await panels.hide(a);
		assert.strictEqual(fake.created[0].disposed, true);
		assert.strictEqual(panels.panelFor(a), undefined);
		assert.ok(panels.isHidden(a));
		assert.deepStrictEqual(memento.updates.at(-1), { key: HIDDEN_GRAPHS_STATE, value: [a.toString()] });

		// An editor showing the hidden file opens nothing; one showing another detected file does.
		const b = uri('b.yaml');
		const group = fake.tabGroups.all[0];
		group.addText(a);
		group.addText(b);
		fake.visibleTextEditors = [fakeEditor(fakeDocument(a)), fakeEditor(fakeDocument(b))];
		fake.visibleEditors.fire(fake.visibleTextEditors);
		await panels.idle();
		assert.strictEqual(panels.panelFor(a), undefined, 'the hidden file does not auto-open');
		assert.ok(panels.panelFor(b), 'the other file auto-opens');
		assert.strictEqual(fake.created.length, 2);
	});

	test('closing the file\'s last text tab closes its panel', async () => {
		make();
		const a = uri('a.yaml');
		const tab = fake.tabGroups.all[0].addText(a);
		await panels.show(a);
		const panel = fake.created[0];
		fake.tabGroups.all[0].remove(tab);
		fake.tabsClosed([tab]);
		assert.strictEqual(panel.disposed, true);
		assert.strictEqual(panels.panelFor(a), undefined);
	});

	test('a will/did rename re-keys the panel and its title', async () => {
		make();
		const a = uri('a.yaml');
		const b = uri('b.yaml');
		const handle = await panels.show(a);
		const panel = fake.created[0] as FakeWebviewPanel;
		await fake.rename(a, b);
		assert.strictEqual(panels.panelFor(a), undefined);
		assert.strictEqual(panels.panelFor(b), handle);
		assert.strictEqual(handle?.uri.toString(), b.toString());
		assert.strictEqual(panel.title, 'Graph: b.yaml');
		assert.strictEqual(panel.disposed, false);
	});
});
