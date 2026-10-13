// The Bloblang test panel, end to end (ticket 4.2): the CodeLens, Test mapping, one panel per
// mapping, and a run through the AD-21 adapter on a fake `run` (`mappingTestRunBody`). The panel is
// driven through its host-side seam (`bloblangPanels.panelFor`, `receive`); the real webview only
// posts `ready`. Plus the boundaries the entry meets: the graph still loads (3.1's `html.ts`), the
// graph's locked group stays graph-only (3.10), and the env file reaches the test run (2.7's builder).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import {
	BLOBLANG_VIEW_TYPE, NO_LONGER_THERE, NO_MAPPING_AT_CURSOR, TEST_MAPPING_COMMAND, type BloblangPanelHandle,
} from '../../../adapters/bloblangPanel/panels';
import { GRAPH_VIEW_TYPE } from '../../../adapters/graphPanel/panels';
import { NO_BINARY_MESSAGE } from '../../../adapters/redpandaConnect/bloblang';
import { TEST_MAPPING_LENS_TITLE } from '../../../adapters/vscode/bloblangLens';
import { bloblangString } from '../../../core/bloblangRun';
import { type ExtensionApi } from '../../../extension';
import type { BloblangHostMessage, BloblangResult } from '../../../shared/bloblangProtocol';
import { connectScript, fixtureBodies, makeTempDir, mappingTestRunBody, readCounter, writeFakeBinary } from '../../helpers/fakeBinary';
import { EXTENSION_ID, waitFor } from '../helpers';

const CONFIG = [
	'input:',
	'  stdin: {}',
	'pipeline:',
	'  processors:',
	'    - label: first',
	'      mapping: root.b = this.a + 1',
	'    - switch:',
	'        - check: this.a > 0',
	'          processors:',
	'            - mutation: root.b = this.a + 1',
	'    - mapping: root.b = this.nope.or("FAIL_ME")',
	'    - mapping: root = deleted()',
	'    - mapping: root = "${UNSET} BROKEN"',
	'output:',
	'  stdout: {}',
	'',
].join('\n');

const FIRST = 'pipeline.processors[0]';
const NESTED = 'pipeline.processors[1].switch[0].processors[0]';

suite('Bloblang test panel (integration, 4.2)', function () {
	this.timeout(90_000);
	let dir: string;
	let capture: string;
	let counter: string;
	let bin: string;
	const originalPath = process.env.PATH;
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const config = () => vscode.workspace.getConfiguration('redpandaConnect');
	const runs = () => readCounter(counter).filter((l) => l === 'run').length;
	/** The argv of each test `run`, in order (only `run …` lines: 4.5's live `blobl` parses may also spawn). */
	const argvLines = () => (fs.existsSync(path.join(capture, 'argv')) ? fs.readFileSync(path.join(capture, 'argv'), 'utf8').split('\n').filter((l) => l.startsWith('run ')) : []);
	const lastRunArgv = () => {
		const lines = argvLines();
		assert.ok(lines.length > 0, 'no `run` argv was recorded');
		return lines[lines.length - 1];
	};
	const results = (handle: BloblangPanelHandle) =>
		handle.posted.filter((m): m is Extract<BloblangHostMessage, { type: 'result' }> => m.type === 'result');

	async function open(name: string, text: string, column = vscode.ViewColumn.One): Promise<vscode.TextEditor> {
		const file = path.join(dir, name);
		fs.writeFileSync(file, text);
		const doc = await vscode.workspace.openTextDocument(file);
		const editor = await vscode.window.showTextDocument(doc, column);
		assert.ok(await waitFor(() => api().detection.has(doc.uri), 5_000));
		return editor;
	}

	async function show(uri: vscode.Uri, processorPath: string): Promise<BloblangPanelHandle> {
		const handle = await vscode.commands.executeCommand<BloblangPanelHandle | undefined>(TEST_MAPPING_COMMAND, uri, processorPath);
		assert.ok(handle, `no panel for ${processorPath}`);
		return handle;
	}

	/** Posts `run {content, meta: {}}` as the webview would and returns the result posted for it. */
	async function run(handle: BloblangPanelHandle, input: string): Promise<{ result: BloblangResult; binary: string | null }> {
		const before = results(handle).length;
		await handle.receive({ type: 'run', content: input, meta: {} });
		const all = results(handle);
		assert.strictEqual(all.length, before + 1, 'one result per run');
		return all[all.length - 1];
	}

	/** The test config the fake last ran, and whether the file is gone. */
	function lastRun(): { config: string; target: string } {
		const target = lastRunArgv().split(' ').pop()!;
		return { config: fs.readFileSync(path.join(capture, 'config.yaml'), 'utf8'), target };
	}

	suiteSetup(async () => {
		const fixtures = fixtureBodies('4.112.0');
		dir = makeTempDir('rpcn-bloblang-');
		capture = path.join(dir, 'capture');
		fs.mkdirSync(capture);
		counter = path.join(dir, 'counter');
		const runBody = mappingTestRunBody(capture);
		process.env.PATH = (originalPath ?? '').split(path.delimiter)
			.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
			.join(path.delimiter);
		bin = writeFakeBinary(dir, 'redpanda-connect', connectScript({ version: '4.112.0', ...fixtures, run: runBody, counterFile: counter }));
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
		await config().update('binaryPath', bin, vscode.ConfigurationTarget.Global);
		assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'ok'
			&& (api().redpandaConnect.state as { path: string }).path === bin, 30_000));
	});

	teardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		assert.ok(await waitFor(() => api().bloblangPanels.size === 0 && api().graphPanels.size === 0, 10_000), 'closing the editors disposes the panels');
	});

	suiteTeardown(async () => {
		process.env.PATH = originalPath;
		await config().update('binaryPath', undefined, vscode.ConfigurationTarget.Global);
		await config().update('envFile', undefined, vscode.ConfigurationTarget.Global);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('LENS: one lens per mapping / mutation processor on its key line; none in YAML that is not a config', async () => {
		const editor = await open('lens.yaml', CONFIG);
		const doc = editor.document;
		assert.ok(api().detection.isDetected(doc.uri));
		const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri))
			.filter((l) => l.command?.command === TEST_MAPPING_COMMAND);
		const keyLine = (needle: string) => CONFIG.split('\n').findIndex((l) => l.includes(needle));
		assert.deepStrictEqual(lenses.map((l) => [l.range.start.line, l.command?.title, l.command?.arguments?.[1]]), [
			[keyLine('mapping: root.b = this.a + 1'), TEST_MAPPING_LENS_TITLE, FIRST],
			[keyLine('mutation: root.b'), TEST_MAPPING_LENS_TITLE, NESTED],
			[keyLine('FAIL_ME'), TEST_MAPPING_LENS_TITLE, 'pipeline.processors[2]'],
			[keyLine('deleted()'), TEST_MAPPING_LENS_TITLE, 'pipeline.processors[3]'],
			[keyLine('BROKEN'), TEST_MAPPING_LENS_TITLE, 'pipeline.processors[4]'],
		]);
		assert.strictEqual((lenses[0].command?.arguments?.[0] as vscode.Uri).toString(), doc.uri.toString());

		const plain = await open('plain.yaml', 'name: x\nsteps:\n  processors:\n    - mapping: root = 1\n');
		assert.ok(!api().detection.isDetected(plain.document.uri));
		const none = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', plain.document.uri);
		assert.deepStrictEqual(none.filter((l) => l.command?.command === TEST_MAPPING_COMMAND), []);
	});

	test('OPEN: the lens command opens "Bloblang: <label>" beside, focus stays in the YAML; a second call reveals it', async () => {
		const editor = await open('open.yaml', CONFIG);
		const doc = editor.document;
		const handle = await show(doc.uri, FIRST);
		assert.strictEqual(handle.panel.title, 'Bloblang: first');
		assert.strictEqual(handle.panel.viewType, BLOBLANG_VIEW_TYPE);
		assert.strictEqual(api().bloblangPanels.panelFor(doc.uri, FIRST), handle);
		// The real webview loads dist/bloblang.js and asks for its snapshot.
		assert.ok(await waitFor(() => handle.posted.some((m) => m.type === 'snapshot'), 15_000), 'the webview never posted ready');
		assert.deepStrictEqual(handle.posted.find((m) => m.type === 'snapshot'),
			{ type: 'snapshot', title: 'Bloblang: first', kind: 'mapping', source: 'root.b = this.a + 1', binary: 'ok', samples: [], selected: null });
		assert.notStrictEqual(handle.panel.viewColumn, vscode.ViewColumn.One);
		assert.strictEqual(vscode.window.tabGroups.activeTabGroup.viewColumn, vscode.ViewColumn.One, 'focus stays in the YAML group');
		assert.strictEqual(vscode.window.activeTextEditor?.document, doc);

		const again = await show(doc.uri, FIRST);
		assert.strictEqual(again, handle);
		assert.strictEqual(api().bloblangPanels.size, 1);

		// No label: the path is the title; from the Command Palette, the processor at the cursor.
		const at = doc.positionAt(CONFIG.indexOf('this.a + 1', CONFIG.indexOf('mutation')));
		editor.selection = new vscode.Selection(at, at);
		const nested = await vscode.commands.executeCommand<BloblangPanelHandle | undefined>(TEST_MAPPING_COMMAND);
		assert.ok(nested);
		assert.strictEqual(nested.path, NESTED);
		assert.strictEqual(nested.panel.title, `Bloblang: ${NESTED}`);
		assert.strictEqual(api().bloblangPanels.size, 2);
	});

	test('NO_MAPPING_AT_CURSOR: the command outside such a processor shows the message and opens nothing', async () => {
		const editor = await open('nomap.yaml', CONFIG);
		const at = editor.document.positionAt(CONFIG.indexOf('stdout'));
		editor.selection = new vscode.Selection(at, at);
		const handle = await vscode.commands.executeCommand<BloblangPanelHandle | undefined>(TEST_MAPPING_COMMAND);
		assert.strictEqual(handle, undefined);
		assert.strictEqual(api().bloblangPanels.size, 0);
		assert.strictEqual(api().outputLines()[api().outputLines().length - 1], `Test mapping: ${NO_MAPPING_AT_CURSOR}`);
	});

	test('RUN_OK / CONTENT_ESCAPE: the mapping\'s output for a mapping and a mutation; the input reaches the config unchanged; the temp file is removed', async () => {
		const doc = (await open('ok.yaml', CONFIG)).document;
		const mapping = await show(doc.uri, FIRST);
		const out = await run(mapping, '{"a":1}');
		assert.deepStrictEqual(out.result, {
			kind: 'ok', content: '{"b":2}', meta: {},
			changes: { fields: { added: ['b'], changed: [], removed: ['a'] }, meta: { added: [], changed: [], removed: [] } },
		});
		assert.strictEqual(out.binary, 'redpanda-connect 4.112.0');
		const { config: text, target } = lastRun();
		assert.ok(!fs.existsSync(target), 'the temp config is removed');
		assert.ok(target.endsWith('.yaml') && path.basename(target).startsWith('bloblang-test-'));
		const parsed = parse(text);
		assert.strictEqual(parsed.input.generate.count, 1);
		assert.strictEqual(parsed.pipeline.processors[0].mapping, 'root.b = this.a + 1');

		const mutation = await show(doc.uri, NESTED);
		assert.deepStrictEqual((await run(mutation, '{"a":1}')).result, {
			kind: 'ok', content: '{"a":1,"b":2}', meta: {},
			changes: { fields: { added: ['b'], changed: [], removed: [] }, meta: { added: [], changed: [], removed: [] } },
		});
		assert.strictEqual(parse(lastRun().config).pipeline.processors[0].mutation, 'root.b = this.a + 1');

		const tricky = '{"q":"say \\"hi\\"\\\\"}\nline 2 ü 日本 😀 ${HOME}';
		await run(mapping, tricky);
		assert.strictEqual(parse(lastRun().config).input.generate.mapping, `root = ${bloblangString(tricky)}`);
	});

	test('RUN_FAILED / DELETED / RUN_ERROR: the binary\'s message, a deleted message, the stderr text', async () => {
		const doc = (await open('outcomes.yaml', CONFIG)).document;
		assert.deepStrictEqual((await run(await show(doc.uri, 'pipeline.processors[2]'), '{"a":1}')).result,
			{ kind: 'failed', message: 'failed assignment (line 1): fake failure' });
		assert.deepStrictEqual((await run(await show(doc.uri, 'pipeline.processors[3]'), '{"a":1}')).result, { kind: 'deleted' });
		const broken = await run(await show(doc.uri, 'pipeline.processors[4]'), '{"a":1}');
		assert.deepStrictEqual(broken.result, {
			kind: 'error', message: 'level=error msg="Config lint error" lint="(1,1) required environment variables were not set: [BROKEN]"',
		});
		assert.ok(!fs.existsSync(lastRun().target), 'the temp config is removed after a failed run');
	});

	test('the run uses the processor\'s current text', async () => {
		const editor = await open('edited.yaml', CONFIG);
		const handle = await show(editor.document.uri, FIRST);
		const start = CONFIG.indexOf('root.b = this.a + 1');
		const edit = new vscode.WorkspaceEdit();
		edit.replace(editor.document.uri, new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(start + 'root.b = this.a + 1'.length)), 'root = deleted()');
		assert.ok(await vscode.workspace.applyEdit(edit));
		// The shown Bloblang follows the edit.
		assert.ok(await waitFor(() => {
			const snaps = handle.posted.filter((m) => m.type === 'snapshot');
			const last = snaps[snaps.length - 1];
			return last?.type === 'snapshot' && last.source === 'root = deleted()';
		}, 5_000), 'no snapshot with the edited source');
		// Unsaved: the run reads the open document, not the file.
		assert.deepStrictEqual((await run(handle, '{"a":1}')).result, { kind: 'deleted' });
		assert.ok(await editor.document.save());
	});

	test('SINGLE_FLIGHT: inputs during a run wait, only the latest runs next, and only its result is posted', async () => {
		const doc = (await open('flight.yaml', CONFIG)).document;
		const handle = await show(doc.uri, FIRST);
		const before = { runs: runs(), results: results(handle).length };
		await Promise.all(['{"a":1}', '{"a":2}', '{"a":3}'].map((input) => handle.receive({ type: 'run', content: input, meta: {} })));
		assert.strictEqual(runs() - before.runs, 2, 'the first input, then only the latest');
		assert.strictEqual(results(handle).length - before.results, 1);
		assert.strictEqual(parse(lastRun().config).input.generate.mapping, `root = ${bloblangString('{"a":3}')}`);
	});

	test('NO_LONGER_THERE: a lens path that is gone says so, not the cursor message', async () => {
		const doc = (await open('gone.yaml', CONFIG)).document;
		assert.strictEqual(await vscode.commands.executeCommand(TEST_MAPPING_COMMAND, doc.uri, 'pipeline.processors[9]'), undefined);
		assert.strictEqual(api().outputLines()[api().outputLines().length - 1], `Test mapping: ${NO_LONGER_THERE}`);
		assert.strictEqual(api().bloblangPanels.size, 0);
	});

	test('NO_BINARY: an error result and no spawn', async () => {
		const doc = (await open('nobin.yaml', CONFIG)).document;
		const handle = await show(doc.uri, FIRST);
		await config().update('binaryPath', path.join(dir, 'gone'), vscode.ConfigurationTarget.Global);
		try {
			assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'missing', 15_000));
			const before = runs();
			const out = await run(handle, '{"a":1}');
			assert.deepStrictEqual(out, { ...out, result: { kind: 'error', message: NO_BINARY_MESSAGE }, binary: null });
			assert.strictEqual(runs(), before);
		} finally {
			await config().update('binaryPath', bin, vscode.ConfigurationTarget.Global);
			assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'ok', 15_000));
		}
	});

	test('UNTITLED: an untitled config gets no lens and never runs', async () => {
		const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: CONFIG });
		const editor = await vscode.window.showTextDocument(doc);
		assert.ok(await waitFor(() => api().detection.isDetected(doc.uri), 5_000));
		const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri);
		assert.deepStrictEqual(lenses.filter((l) => l.command?.command === TEST_MAPPING_COMMAND), []);
		const at = doc.positionAt(CONFIG.indexOf('this.a + 1'));
		editor.selection = new vscode.Selection(at, at);
		assert.strictEqual(await vscode.commands.executeCommand(TEST_MAPPING_COMMAND), undefined);
		assert.strictEqual(await vscode.commands.executeCommand(TEST_MAPPING_COMMAND, doc.uri, FIRST), undefined);
		assert.strictEqual(api().bloblangPanels.size, 0);
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
	});

	test('BOUNDARY 3.1 + 3.10: the graph still loads, and with a graph open the panel opens outside its locked group', async () => {
		const editor = await open('graph.yaml', CONFIG);
		const doc = editor.document;
		const graph = await api().graphPanels.show(doc.uri);
		assert.ok(graph);
		await graph.lockSettled;
		// 3.1's html.ts, parameterised: the graph's page still loads the graph's own bundle. (Not the
		// real webview's ready: on CI's VS Code 1.100 it often never comes, bug 15.)
		assert.match(graph.panel.webview.html, /dist\/webview\.js/, 'the graph page loads dist/webview.js');
		assert.doesNotMatch(graph.panel.webview.html, /bloblang\.js/, 'the graph page does not load the test panel bundle');
		assert.ok(await waitFor(() => vscode.window.tabGroups.activeTabGroup.viewColumn === vscode.ViewColumn.One, 10_000));
		const handle = await show(doc.uri, FIRST);
		assert.ok(await waitFor(() => handle.panel.viewColumn !== undefined, 5_000));
		assert.notStrictEqual(handle.panel.viewColumn, graph.panel.viewColumn, 'the panel is not in the graph group');
		const graphGroup = vscode.window.tabGroups.all.find((g) => g.viewColumn === graph.panel.viewColumn)!;
		assert.ok(graphGroup.tabs.every((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith(GRAPH_VIEW_TYPE)),
			'the graph group holds only graphs');
		assert.strictEqual(vscode.window.activeTextEditor?.document, doc, 'focus stays in the YAML');
	});

	test('BOUNDARY 2.7: the env file setting reaches the test run', async () => {
		const envFile = path.join(dir, 'test.env');
		fs.writeFileSync(envFile, 'FOO=bar\n');
		await config().update('envFile', envFile, vscode.ConfigurationTarget.Global);
		try {
			const doc = (await open('env.yaml', CONFIG)).document;
			await run(await show(doc.uri, FIRST), '{"a":1}');
			const argv = lastRunArgv();
			assert.ok(argv.startsWith('run --set http.enabled=false --env-file '), argv);
			assert.ok(argv.includes(`--env-file ${envFile} `), argv);
		} finally {
			await config().update('envFile', undefined, vscode.ConfigurationTarget.Global);
		}
	});
});
