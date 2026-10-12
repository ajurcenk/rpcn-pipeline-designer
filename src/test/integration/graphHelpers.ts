// The graph suites' shared setup and helpers (split out of 80-graph.ts in ticket 3.12). The graph
// panel is tested through its host-side seam (`graphPanels.panelFor`, `receive`): the tests
// check what the host posts and does, and don't drive the webview DOM (ticket 3.1). The model is
// built with the schema of the fake 4.112.0 binary (ticket 3.3, AD-20).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GraphPanels, type GraphPanelHandle, type GraphPanelsOptions } from '../../adapters/graphPanel/panels';
import { binaryActions, type BinaryNotifier } from '../../adapters/redpandaConnect/notify';
import { createVsCodeNotifier } from '../../extension';
import type { HostMessage, PipelineModel } from '../../shared/protocol';
import { makeTempDir } from '../helpers/fakeBinary';
import { EXTENSION_ID, waitFor } from './helpers';
import { api, schemaFrom, setBinaryPath, useSchemaBinary, type SchemaBinary } from './schemaHarness';

let dir = '';
let h: SchemaBinary = { dir: '', fakeBinary: '', changedBinary: '' };

/** The current graph suite's temporary folder, set at its suiteSetup. */
export const graphDir = () => dir;

/**
 * Call inside a suite: the graph suites' setup and teardown (formerly 80-graph.ts's own). Returns
 * the suite's fake binaries; their fields fill in at suiteSetup.
 */
export function useGraphSuite(): SchemaBinary {
	suiteSetup(async () => {
		dir = makeTempDir('rpcn-graph-');
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
	});
	// Lint like the spike (3.8): `nope:` is not recognised, `codec:` is deprecated (a warning).
	const binary = useSchemaBinary({ lintFindings: [['nope:', 'field nope not recognised'], ['codec:', 'field codec is deprecated']] });
	suiteSetup(() => {
		h = binary;
	});
	setup(async () => {
		await schemaFrom(binary.fakeBinary, '4.112.0');
	});

	teardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		assert.ok(await waitFor(() => api().graphPanels.size === 0, 10_000), 'closing the editors disposes the panels');
	});

	suiteTeardown(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return binary;
}

export const snapshots = (handle: GraphPanelHandle): PipelineModel[] =>
	handle.posted.flatMap((m) => (m.type === 'snapshot' && m.model ? [m.model] : []));
export const ids = (model: PipelineModel | undefined) => model?.nodes.map((n) => n.id);
/** The live updates posted (`model` and `parseError`), without the snapshots answering `ready`. */
export const live = (handle: GraphPanelHandle): HostMessage[] => handle.posted.filter((m) => m.type === 'model' || m.type === 'parseError');
export const VALID = 'input:\n  stdin: {}\noutput:\n  stdout: {}\n';
/** Gives a stray message the time to arrive. */
export const settle = () => new Promise((r) => setTimeout(r, 300));
/** A switch processor with two cases, two blank top-level lines, and an output (3.7). */
export const SWITCH = [
	'input:',
	'  stdin: {}',
	'',
	'',
	'pipeline:',
	'  processors:',
	'    - switch:',
	'        - check: this.a == 1',
	'          processors:',
	'            - mapping: root = "a"',
	'        - processors:',
	'            - log:',
	'                message: hi',
	'output:',
	'  stdout: {}',
	'',
].join('\n');
export const SWITCH_ID = 'path:pipeline.processors[0]';
export const MAPPING_ID = 'path:pipeline.processors[0].switch[0].processors[0]';

/** Opens `text` with its graph, and gets the webview's snapshot (the host seam). */
export async function withGraph(name: string, text: string): Promise<{ doc: vscode.TextDocument; editor: vscode.TextEditor; handle: GraphPanelHandle }> {
	const doc = await open(name, text);
	const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc)!;
	const handle = await showGraph(doc);
	await handle.receive({ type: 'ready' });
	return { doc, editor, handle };
}

export async function replace(doc: vscode.TextDocument, start: number, end: number, text: string): Promise<void> {
	const edit = new vscode.WorkspaceEdit();
	edit.replace(doc.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(end)), text);
	assert.ok(await vscode.workspace.applyEdit(edit));
}
export const insert = (doc: vscode.TextDocument, at: number, text: string) => replace(doc, at, at, text);

export async function open(name: string, text: string): Promise<vscode.TextDocument> {
	const file = path.join(dir, name);
	fs.writeFileSync(file, text);
	const doc = await vscode.workspace.openTextDocument(file);
	// Not a preview tab: opening the next file must not close this one's tab, and with it its
	// graph (TAB_CLOSE, 3.10).
	await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
	return doc;
}

export async function showGraph(doc: vscode.TextDocument): Promise<GraphPanelHandle> {
	await vscode.commands.executeCommand('redpandaConnect.showGraph', doc.uri);
	const handle = api().graphPanels.panelFor(doc.uri);
	assert.ok(handle, 'a graph panel for the file');
	return handle;
}

/** A GraphPanels of the test's own, on the extension's binary and schema unless overridden. */
export function testPanels(overrides: Partial<GraphPanelsOptions> = {}): GraphPanels {
	return new GraphPanels({
		extensionUri: vscode.extensions.getExtension(EXTENSION_ID)!.extensionUri,
		log: () => undefined,
		binary: api().redpandaConnect,
		schema: api().schemaStore,
		diagnostics: { diagnosticsFor: () => [], onDidChangeDiagnostics: () => ({ dispose: () => undefined }) },
		actions: undefined,
		// Not VS Code's context key, which the extension's own registry owns.
		setContext: () => undefined,
		...overrides,
	});
}

/** A GraphPanels whose diagnostics the test sets (and fires) itself. */
export function fakeDiagnostics() {
	const emitter = new vscode.EventEmitter<vscode.Uri>();
	let current: vscode.Diagnostic[] = [];
	const panels = testPanels({ diagnostics: { diagnosticsFor: () => current, onDidChangeDiagnostics: emitter.event } });
	return {
		panels,
		set(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]) {
			current = diagnostics;
			emitter.fire(uri);
		},
		dispose() {
			panels.dispose();
			emitter.dispose();
		},
	};
}

/** Points `redpandaConnect.binaryPath` at a file that is not there and waits for `missing` with no schema. */
export async function loseBinary(name: string): Promise<string> {
	const missing = path.join(h.dir, name);
	fs.rmSync(missing, { force: true });
	await setBinaryPath(missing);
	assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'missing' && api().schemaStore.current === undefined, 15_000),
		`binaryState: ${JSON.stringify(api().redpandaConnect.state)}`);
	return missing;
}
export async function restoreBinary(): Promise<void> {
	await setBinaryPath(h.fakeBinary);
	await schemaFrom(h.fakeBinary, '4.112.0');
}

/** The binary warning's actions on the extension's binary, with a fake picker and browser (the real ones need a human). */
export function fakeActions() {
	const log: string[] = [];
	const opened: string[] = [];
	const warned: string[] = [];
	const fake = { picked: undefined as string | undefined };
	const notifier: BinaryNotifier = {
		...createVsCodeNotifier((line) => log.push(line)),
		showWarning: async (message) => { warned.push(message); return undefined; },
		openExternal: async (url) => { opened.push(url); },
		pickBinary: async () => fake.picked,
	};
	let shown = 0;
	const actions = binaryActions(api().redpandaConnect, notifier, (line) => log.push(line), {
		get shown() { return shown; },
		show: (message) => { shown++; warned.push(message); },
	});
	return { actions, fake, opened, warned, log };
}

export const setAutoOpen = (on: boolean) =>
	vscode.workspace.getConfiguration('redpandaConnect').update('autoOpenGraph', on, vscode.ConfigurationTarget.Global);
export async function withAutoOpen(run: () => Promise<void>): Promise<void> {
	await setAutoOpen(true);
	try {
		await run();
	} finally {
		await setAutoOpen(false);
	}
}
/** A `workspaceState` of the test's own. */
export function fakeMemento(): vscode.Memento {
	const store = new Map<string, unknown>();
	return {
		keys: () => [...store.keys()],
		get: (key: string, fallback?: unknown) => (store.has(key) ? store.get(key) : fallback),
		update: async (key: string, value: unknown) => {
			store.set(key, value);
		},
	} as vscode.Memento;
}
/** Waits for the file's auto-opened panel and its lock sequence. */
export async function autoOpened(doc: vscode.TextDocument, panels: GraphPanels = api().graphPanels): Promise<GraphPanelHandle> {
	assert.ok(await waitFor(() => panels.panelFor(doc.uri) !== undefined, 10_000), 'the graph auto-opened');
	await panels.idle();
	return panels.panelFor(doc.uri)!;
}
