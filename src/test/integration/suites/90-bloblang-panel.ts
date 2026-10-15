// The Bloblang test panel, end to end (tickets 4.2, 4.7): the CodeLens, Test mapping, one panel per
// mapping, and a run through the AD-21 adapter on a fake `run` (`mappingTestRunBody`). The panel is
// driven through its host-side seam (`bloblangPanels.panelFor`, `receive`); the real webview only
// posts `ready`. Plus the boundaries the entry meets: the graph still loads (3.1's `html.ts`), the
// graph's locked group stays graph-only (3.10), and the env file reaches the test run (2.7's builder).
// Ticket 4.7: metadata in and out, the changed fields, and a mapping edit while a run is in flight.
// Ticket 4.8: a parse error (the run's `Config lint error`, then `blobl`'s position on the fake
// `bloblParseBody`) at the same place as 4.5's live diagnostic, a located failure with its
// end-of-line hint (read through `hintRanges`), an invalid input, and Go to line.
// Ticket 4.15: the no-binary state's host side: the snapshot's status, a `binary` message to every
// panel on each change, and the three buttons running the graph's `BinaryActions` (`fakeActions`),
// with a BloblangPanels of the test's own; plus the graph and the test panel recovering together.
// Ticket 4.9: the saved samples matrix on the temp folder (the samples file beside the config, read
// back from disk), with a BloblangPanels of the test's own whose Delete modal is a seam.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import {
	BLOBLANG_VIEW_TYPE, BloblangPanels, couldNotSaveSamples, deleteSampleMessage, NO_LONGER_THERE, NO_MAPPING_AT_CURSOR, TEST_MAPPING_COMMAND, type BloblangPanelHandle,
} from '../../../adapters/bloblangPanel/panels';
import { samplesUri } from '../../../adapters/bloblangPanel/sampleStore';
import { GRAPH_VIEW_TYPE } from '../../../adapters/graphPanel/panels';
import { NO_BINARY_MESSAGE } from '../../../adapters/redpandaConnect/bloblang';
import { INSTALL_GUIDE_URL, type BinaryActions } from '../../../adapters/redpandaConnect/notify';
import { TEST_MAPPING_LENS_TITLE } from '../../../adapters/vscode/bloblangLens';
import { bloblangString } from '../../../core/bloblangRun';
import { type ExtensionApi } from '../../../extension';
import type { BloblangHostMessage, BloblangResult } from '../../../shared/bloblangProtocol';
import { bloblParseBody, connectScript, fixtureBodies, makeTempDir, mappingTestRunBody, readCounter, writeFakeBinary } from '../../helpers/fakeBinary';
import { fakeActions, loseBinary, restoreBinary, settle } from '../graphHelpers';
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
	// Not `UNSET`: the live parse (`bloblParseBody`) would log the line suite 91 counts once.
	'    - mapping: root = "${NOT_SET} BROKEN"',
	'output:',
	'  stdout: {}',
	'',
].join('\n');

/** Ticket 4.7's processors: reads `@k`, sets `@out`, changes `b` and adds `c`, and a slow run. */
const META_CONFIG = [
	'input:',
	'  stdin: {}',
	'pipeline:',
	'  processors:',
	'    - mapping: root.k = @k',
	'    - mapping: meta out = "x"',
	'    - mapping: |',
	'        root.b = 3',
	'        root.c = 4',
	'    - mapping: |',
	'        root.b = this.a + 1 # SLOW_RUN',
	'output:',
	'  stdout: {}',
	'',
].join('\n');

/**
 * Ticket 4.8's processors: a parse error on mapping line 2, char 18 (YAML line 7, char 26), a
 * failure on mapping line 2 (YAML line 10), an input the mapping can't read, and a 3-line mapping
 * failing on its line 2 (YAML line 15) (the markers are
 * in block scalars: a plain scalar's ` #` starts a comment).
 */
const ERRORS_CONFIG = [
	'input:',
	'  stdin: {}',
	'pipeline:',
	'  processors:',
	'    - mapping: |',
	'        root.a = 1',
	'        root.c = = 3 # ERR@2:18',
	'    - mapping: |',
	'        root.a = 1',
	'        root.x = this.nope + 1 # FAIL_ON_2',
	'    - mapping: |',
	'        root = this # NOT_STRUCTURED',
	'    - mapping: |',
	'        root.a = 1',
	'        root.x = this.nope + 1 # FAIL_ON_2',
	'        root.z = 3',
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

	/** Posts `run {content, meta}` as the webview would and returns the result posted for it. */
	async function run(handle: BloblangPanelHandle, input: string, meta: Record<string, string> = {}): Promise<{ result: BloblangResult; binary: string | null }> {
		const before = results(handle).length;
		await handle.receive({ type: 'run', content: input, meta });
		const all = results(handle);
		assert.strictEqual(all.length, before + 1, 'one result per run');
		return all[all.length - 1];
	}

	/** Replaces the whole text of `doc`. */
	async function setText(doc: vscode.TextDocument, text: string): Promise<void> {
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.strictEqual(doc.getText(), text);
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
		const bloblBody = bloblParseBody(capture);
		process.env.PATH = (originalPath ?? '').split(path.delimiter)
			.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
			.join(path.delimiter);
		bin = writeFakeBinary(dir, 'redpanda-connect', connectScript({ version: '4.112.0', ...fixtures, run: runBody, blobl: bloblBody, counterFile: counter }));
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
			{ kind: 'failed', message: 'failed assignment (line 1): fake failure', mappingLine: 1, fileLine: 11 });
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

	test('META_IN: the input metadata is set by the generate input, the mapping reads it, and changes.meta starts from it', async () => {
		const doc = (await open('meta-in.yaml', META_CONFIG)).document;
		const out = await run(await show(doc.uri, 'pipeline.processors[0]'), '{"a":1}', { k: 'v' });
		assert.deepStrictEqual(out.result, {
			kind: 'ok', content: '{"a":1,"k":"v"}', meta: { k: 'v' },
			changes: { fields: { added: ['k'], changed: [], removed: [] }, meta: { added: [], changed: [], removed: [] } },
		});
		assert.strictEqual(parse(lastRun().config).input.generate.mapping, `root = ${bloblangString('{"a":1}')}\nmeta "k" = "v"`);
	});

	test('META_OUT: a key the mapping sets is in ok.meta and changes.meta.added', async () => {
		const doc = (await open('meta-out.yaml', META_CONFIG)).document;
		const out = await run(await show(doc.uri, 'pipeline.processors[1]'), '{"a":1}');
		assert.strictEqual(out.result.kind, 'ok');
		assert.deepStrictEqual(out.result.kind === 'ok' && [out.result.meta, out.result.changes.meta],
			[{ out: 'x' }, { added: ['out'], changed: [], removed: [] }]);
	});

	test('FIELDS: a changed and an added top-level field', async () => {
		const doc = (await open('fields.yaml', META_CONFIG)).document;
		const out = await run(await show(doc.uri, 'pipeline.processors[2]'), '{"a":1,"b":2}');
		assert.deepStrictEqual(out.result.kind === 'ok' && out.result.changes.fields, { added: ['c'], changed: ['b'], removed: [] });
	});

	test('AI-7: a mapping edit while a run is in flight; only the run of the edited source posts its result', async () => {
		const editor = await open('inflight.yaml', META_CONFIG);
		const doc = editor.document;
		const handle = await show(doc.uri, 'pipeline.processors[3]');
		const before = { runs: runs(), results: results(handle).length };
		const first = handle.receive({ type: 'run', content: '{"a":1}', meta: {} });
		assert.ok(await waitFor(() => runs() > before.runs, 5_000), 'the first run never started');
		const source = 'root.b = this.a + 1 # SLOW_RUN';
		const start = META_CONFIG.indexOf(source);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(start + source.length)), 'root = deleted()');
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.ok(await waitFor(() => {
			const snaps = handle.posted.filter((m) => m.type === 'snapshot');
			const last = snaps[snaps.length - 1];
			return last?.type === 'snapshot' && last.source.trim() === 'root = deleted()';
		}, 5_000), 'no snapshot with the edited source');
		// The webview's Run on change posts the input again for the new source.
		await Promise.all([first, handle.receive({ type: 'run', content: '{"a":1}', meta: {} })]);
		assert.strictEqual(runs() - before.runs, 2);
		const posted = results(handle).slice(before.results);
		assert.deepStrictEqual(posted.map((r) => r.result), [{ kind: 'deleted' }]);
		assert.ok(await doc.save());
	});

	test('PARSE + PARSE_MATCH (4.8): a lint stop is the blobl parse error, at the live diagnostic\'s position; a fix gives the output', async () => {
		const editor = await open('parse.yaml', ERRORS_CONFIG);
		const doc = editor.document;
		const handle = await show(doc.uri, FIRST);
		const out = await run(handle, '{"a":1}');
		assert.deepStrictEqual(out.result, {
			kind: 'parseError',
			message: 'expected fake thing',
			excerpt: '  |\n1 | fake excerpt\n  |  ^---',
			mappingLine: 2,
			mappingChar: 18,
			fileLine: 7,
			fileChar: 26,
		});
		// 4.5's live diagnostic for the same mapping: the same line and column.
		assert.ok(await waitFor(() => api().bloblangDiagnostics.diagnostics(doc.uri).length > 0, 15_000), 'no live Bloblang diagnostic');
		const start = api().bloblangDiagnostics.diagnostics(doc.uri)[0].range.start;
		assert.deepStrictEqual([start.line + 1, start.character + 1], [7, 26]);
		// AI-7: an edit that fixes it, then the run Run on change posts, gives the output.
		const broken = 'root.c = = 3 # ERR@2:18';
		const at = doc.getText().indexOf(broken);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + broken.length)), 'root.c = 3');
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.strictEqual((await run(handle, '{"a":1}')).result.kind, 'ok');
		assert.ok(await doc.save());
	});

	test('FAILED + hint + GO_TO_LINE (4.8): the located failure, the hint at its line\'s end, Go to line; the hint clears', async () => {
		const editor = await open('failed.yaml', ERRORS_CONFIG);
		const doc = editor.document;
		const second = 'pipeline.processors[1]';
		const handle = await show(doc.uri, second);
		const panels = api().bloblangPanels;
		const failing = 'root.x = this.nope + 1 # FAIL_ON_2';
		const failed = await run(handle, '{"a":1}');
		assert.deepStrictEqual(failed.result, {
			kind: 'failed', message: 'failed assignment (line 2): expected number value, got null from field `this.nope`', mappingLine: 2, fileLine: 10,
		});
		const lineEnd = doc.lineAt(9).range.end;
		assert.deepStrictEqual(panels.hintRanges(doc.uri).map((r) => [r.start.line, r.start.character, r.end.line, r.end.character]),
			[[9, lineEnd.character, 9, lineEnd.character]]);
		assert.strictEqual(doc.lineAt(9).text.trim(), failing);

		// Go to line: the YAML editor takes focus with the cursor at the line's start; a line past the end clamps.
		await handle.receive({ type: 'goToLine', line: 10 });
		assert.strictEqual(vscode.window.activeTextEditor?.document, doc);
		assert.strictEqual(vscode.window.activeTextEditor?.viewColumn, vscode.ViewColumn.One);
		assert.deepStrictEqual([vscode.window.activeTextEditor?.selection.active.line, vscode.window.activeTextEditor?.selection.active.character], [9, 0]);
		assert.notStrictEqual(handle.panel.viewColumn, vscode.ViewColumn.One, 'the panel stays in its own group');
		await handle.receive({ type: 'goToLine', line: 999 });
		assert.deepStrictEqual([vscode.window.activeTextEditor?.selection.active.line, vscode.window.activeTextEditor?.selection.active.character], [doc.lineCount - 1, 0]);

		// The failing line leaves the processor: the hint clears.
		const at = doc.getText().indexOf(`\n        ${failing}`);
		const remove = new vscode.WorkspaceEdit();
		remove.delete(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + failing.length + 9)));
		assert.ok(await vscode.workspace.applyEdit(remove));
		assert.ok(await waitFor(() => panels.hintRanges(doc.uri).length === 0, 5_000), 'the hint stays after its line left the processor');

		// Back: failed again, then any other result clears it; failed again, then closing the panel clears it.
		await setText(doc, ERRORS_CONFIG);
		assert.strictEqual((await run(handle, '{"a":1}')).result.kind, 'failed');
		assert.strictEqual(panels.hintRanges(doc.uri).length, 1);
		const fix = new vscode.WorkspaceEdit();
		const f = doc.getText().indexOf(failing);
		fix.replace(doc.uri, new vscode.Range(doc.positionAt(f), doc.positionAt(f + failing.length)), 'root.x = 2');
		assert.ok(await vscode.workspace.applyEdit(fix));
		assert.strictEqual((await run(handle, '{"a":1}')).result.kind, 'ok');
		assert.deepStrictEqual(panels.hintRanges(doc.uri), []);
		await setText(doc, ERRORS_CONFIG);
		assert.strictEqual((await run(handle, '{"a":1}')).result.kind, 'failed');
		assert.strictEqual(panels.hintRanges(doc.uri).length, 1);
		handle.panel.dispose();
		assert.deepStrictEqual(panels.hintRanges(doc.uri), []);
		assert.ok(await doc.save());
	});

	test('HINT_TEXT (4.8): a line inserted above the failing line, or the failing line deleted, clears the hint', async () => {
		const editor = await open('hint-text.yaml', ERRORS_CONFIG);
		const doc = editor.document;
		const handle = await show(doc.uri, 'pipeline.processors[3]');
		const panels = api().bloblangPanels;
		const failing = 'root.x = this.nope + 1 # FAIL_ON_2';
		const lastFailing = () => doc.getText().lastIndexOf(failing);
		const failAndHint = async () => {
			const out = await run(handle, '{"a":1}');
			assert.deepStrictEqual(out.result.kind === 'failed' && [out.result.mappingLine, out.result.fileLine], [2, 15]);
			assert.deepStrictEqual(panels.hintRanges(doc.uri).map((r) => r.start.line), [14]);
		};

		await failAndHint();
		// A line inserted above: mapping line 2 is now another statement.
		const insert = new vscode.WorkspaceEdit();
		insert.insert(doc.uri, doc.positionAt(lastFailing()), 'root.y = 0\n        ');
		assert.ok(await vscode.workspace.applyEdit(insert));
		assert.ok(await waitFor(() => panels.hintRanges(doc.uri).length === 0, 5_000), 'the hint moved to the inserted line');
		await setText(doc, ERRORS_CONFIG);
		assert.deepStrictEqual(panels.hintRanges(doc.uri), [], 'restoring the text does not bring the hint back');

		await failAndHint();
		// The failing line deleted: mapping line 2 is now `root.z = 3`.
		const at = lastFailing();
		const remove = new vscode.WorkspaceEdit();
		remove.delete(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + failing.length + 9)));
		assert.ok(await vscode.workspace.applyEdit(remove));
		assert.ok(doc.getText().includes('root.a = 1\n        root.z = 3'), doc.getText());
		assert.ok(await waitFor(() => panels.hintRanges(doc.uri).length === 0, 5_000), 'the hint moved to the next statement');
		await setText(doc, ERRORS_CONFIG);
		assert.ok(await doc.save());
	});

	test('INVALID (4.8): an input the mapping can\'t read is invalidInput with the binary\'s message', async () => {
		const doc = (await open('invalid.yaml', ERRORS_CONFIG)).document;
		const out = await run(await show(doc.uri, 'pipeline.processors[2]'), 'not json');
		assert.deepStrictEqual(out.result, {
			kind: 'invalidInput',
			message: 'failed assignment (line 1): unable to reference message as structured (with \'this\'): parse as json: invalid character \'o\' in literal null (expecting \'u\')',
		});
		assert.deepStrictEqual(api().bloblangPanels.hintRanges(doc.uri), []);
	});

	test('NO_LONGER_THERE: a lens path that is gone says so, not the cursor message', async () => {
		const doc = (await open('gone.yaml', CONFIG)).document;
		assert.strictEqual(await vscode.commands.executeCommand(TEST_MAPPING_COMMAND, doc.uri, 'pipeline.processors[9]'), undefined);
		assert.strictEqual(api().outputLines()[api().outputLines().length - 1], `Test mapping: ${NO_LONGER_THERE}`);
		assert.strictEqual(api().bloblangPanels.size, 0);
	});

	// The no-binary state (4.15).
	/** The `binary` statuses posted to a panel, in order. */
	const binaries = (handle: BloblangPanelHandle) => handle.posted.flatMap((m) => (m.type === 'binary' ? [m.status] : []));
	const lastSnapshot = (handle: BloblangPanelHandle) =>
		handle.posted.filter((m): m is Extract<BloblangHostMessage, { type: 'snapshot' }> => m.type === 'snapshot').at(-1);

	/**
	 * A BloblangPanels of the test's own on the extension's binary, with `actions`, a log of its own
	 * and (4.9) `confirmDelete` as the Delete modal.
	 */
	function testBloblangPanels(
		actions: BinaryActions | undefined, confirmDelete?: (name: string) => Promise<boolean>, showMessage?: (message: string, kind?: 'info' | 'error') => void,
	) {
		const log: string[] = [];
		const panels = new BloblangPanels({
			extensionUri: vscode.extensions.getExtension(EXTENSION_ID)!.extensionUri,
			log: (line) => log.push(line),
			binary: api().redpandaConnect,
			actions,
			storageDir: path.join(dir, 'storage'),
			detection: api().detection,
			...(confirmDelete ? { confirmDelete } : {}),
			...(showMessage ? { showMessage } : {}),
		});
		return { panels, log };
	}

	/** `actions`, counting the calls of each method. */
	function counting(actions: BinaryActions) {
		const calls: string[] = [];
		const counted: BinaryActions = {
			installGuide: () => { calls.push('installGuide'); return actions.installGuide(); },
			setPath: () => { calls.push('setPath'); return actions.setPath(); },
			retry: () => { calls.push('retry'); return actions.retry(); },
		};
		return { counted, calls };
	}

	test('OPEN_MISSING + GUIDE / SET_PATH / RETRY + UNCHANGED (4.15): the snapshot says missing; each button calls its action once; Retry with nothing fixed posts nothing', async () => {
		const doc = (await open('nobin-open.yaml', CONFIG)).document;
		await loseBinary('gone-open', dir);
		const fake = fakeActions();
		const { counted, calls } = counting(fake.actions);
		const { panels } = testBloblangPanels(counted);
		try {
			const before = runs();
			const handle = (await panels.show(doc.uri, FIRST))!;
			await handle.receive({ type: 'ready' });
			assert.strictEqual(lastSnapshot(handle)?.binary, 'missing');

			const count = handle.posted.length;
			await handle.receive({ type: 'installGuideRequested' });
			assert.deepStrictEqual(fake.opened, [INSTALL_GUIDE_URL]);
			// The pick is cancelled: nothing changes.
			await handle.receive({ type: 'setPathRequested' });
			await handle.receive({ type: 'retryRequested' });
			await settle();
			assert.deepStrictEqual(calls, ['installGuide', 'setPath', 'retry']);
			assert.strictEqual(api().redpandaConnect.state.kind, 'missing');
			// The real webview's own `ready` may add a snapshot; it says missing too.
			assert.deepStrictEqual(handle.posted.slice(count).filter((m) => m.type !== 'snapshot'), [], 'UNCHANGED: nothing posted');
			assert.ok(handle.posted.slice(count).every((m) => m.type !== 'snapshot' || m.binary === 'missing'));
			assert.strictEqual(runs(), before, 'no spawn');
		} finally {
			panels.dispose();
			await restoreBinary(bin);
		}
	});

	test('ACTION_FAILS (4.15): a failing action is logged, not thrown', async () => {
		const doc = (await open('nobin-fails.yaml', CONFIG)).document;
		const failing: BinaryActions = {
			installGuide: async () => { throw new Error('no browser'); },
			setPath: async () => { throw new Error('no picker'); },
			retry: async () => { throw new Error('no retry'); },
		};
		const { panels, log } = testBloblangPanels(failing);
		try {
			const handle = (await panels.show(doc.uri, FIRST))!;
			await handle.receive({ type: 'installGuideRequested' });
			await handle.receive({ type: 'setPathRequested' });
			await handle.receive({ type: 'retryRequested' });
			assert.deepStrictEqual(log, ['no browser', 'no picker', 'no retry'].map((m) => `${handle.panel.title}: ${m}`));
		} finally {
			panels.dispose();
		}
	});

	test('RECOVER + EDIT_WHILE_MISSING (4.15): edits while missing spawn nothing; Set path to a working binary posts binary ok, and the same panel runs', async () => {
		const doc = (await open('nobin-recover.yaml', CONFIG)).document;
		await loseBinary('gone-recover', dir);
		const fake = fakeActions();
		const { panels } = testBloblangPanels(fake.actions);
		try {
			const before = runs();
			const handle = (await panels.show(doc.uri, FIRST))!;
			await handle.receive({ type: 'ready' });
			// EDIT_WHILE_MISSING: the snapshot follows the edit, still missing; nothing runs.
			const at = doc.getText().indexOf('this.a + 1');
			await setText(doc, doc.getText().slice(0, at) + 'this.a + 2' + doc.getText().slice(at + 'this.a + 1'.length));
			assert.ok(await waitFor(() => lastSnapshot(handle)?.source === 'root.b = this.a + 2', 5_000), JSON.stringify(lastSnapshot(handle)));
			assert.strictEqual(lastSnapshot(handle)?.binary, 'missing');
			assert.deepStrictEqual(results(handle), []);
			assert.strictEqual(runs(), before);

			fake.fake.picked = bin;
			await handle.receive({ type: 'setPathRequested' });
			assert.ok(await waitFor(() => binaries(handle).includes('ok'), 30_000), JSON.stringify(handle.posted.map((m) => m.type)));
			assert.deepStrictEqual(binaries(handle), ['ok'], 'missing to ok: one binary message');
			assert.strictEqual(config().inspect<string>('binaryPath')?.globalValue, bin);
			// The webview's recovery run, in the same panel.
			const out = await run(handle, '{"a":1}');
			assert.deepStrictEqual(out.result, { ...out.result, kind: 'ok', content: '{"b":2}' });
			assert.strictEqual(parse(lastRun().config).pipeline.processors[0].mapping, 'root.b = this.a + 2', 'the current text');
			assert.strictEqual(panels.panelFor(doc.uri, FIRST), handle, 'not reopened');
			assert.strictEqual(runs(), before + 1);
		} finally {
			panels.dispose();
			await restoreBinary(bin);
			await setText(doc, CONFIG);
			assert.ok(await doc.save());
		}
	});

	test('LOST (4.15): a lost binary posts binary missing and clears the hint; a racing run is the no-binary error, with no spawn; restored, it posts ok and runs', async () => {
		const doc = (await open('nobin.yaml', CONFIG)).document;
		const handle = await show(doc.uri, FIRST);
		await handle.receive({ type: 'ready' });
		assert.strictEqual(lastSnapshot(handle)?.binary, 'ok');
		assert.strictEqual((await run(handle, '{"a":1}')).result.kind, 'ok');
		// A located failure (`FAIL_ON_2`) with its end-of-line hint.
		const errors = (await open('nobin-hint.yaml', ERRORS_CONFIG, vscode.ViewColumn.One)).document;
		const failing = await show(errors.uri, 'pipeline.processors[1]');
		assert.strictEqual((await run(failing, '{"a":1}')).result.kind, 'failed');
		assert.strictEqual(api().bloblangPanels.hintRanges(errors.uri).length, 1, 'the hint is shown');
		try {
			await loseBinary('gone', dir);
			assert.ok(await waitFor(() => binaries(handle).includes('missing'), 10_000), JSON.stringify(binaries(handle)));
			assert.ok(await waitFor(() => binaries(failing).includes('missing'), 10_000), JSON.stringify(binaries(failing)));
			assert.deepStrictEqual(api().bloblangPanels.hintRanges(errors.uri), [], 'the lost binary clears the hint');
			const before = runs();
			const out = await run(handle, '{"a":1}');
			assert.deepStrictEqual(out, { ...out, result: { kind: 'error', message: NO_BINARY_MESSAGE }, binary: null });
			assert.strictEqual(runs(), before);
		} finally {
			await restoreBinary(bin);
		}
		assert.ok(await waitFor(() => binaries(handle).at(-1) === 'ok', 10_000), JSON.stringify(binaries(handle)));
		assert.deepStrictEqual(binaries(handle), ['missing', 'ok']);
		assert.strictEqual((await run(handle, '{"a":1}')).result.kind, 'ok');
	});

	test('WITH_GRAPH (4.15): the graph and the test panel on one file; on recovery the graph renders and the test panel hears it once', async () => {
		const doc = (await open('nobin-graph.yaml', CONFIG)).document;
		await loseBinary('gone-graph', dir);
		try {
			const graph = (await api().graphPanels.show(doc.uri))!;
			await graph.lockSettled;
			await graph.receive({ type: 'ready' });
			const handle = await show(doc.uri, FIRST);
			await handle.receive({ type: 'ready' });
			assert.strictEqual(lastSnapshot(handle)?.binary, 'missing');
			const graphFrom = graph.posted.length;
			await restoreBinary(bin);
			assert.ok(await waitFor(() => graph.posted.slice(graphFrom).some((m) => m.type === 'model'), 30_000),
				JSON.stringify(graph.posted.slice(graphFrom).map((m) => m.type)));
			const statuses = graph.posted.slice(graphFrom).flatMap((m) => (m.type === 'hostStatus' ? [m.binary] : []));
			assert.ok(statuses.length > 0 && statuses.every((b) => b === 'ok'), JSON.stringify(statuses));
			// The graph may post hostStatus twice by design (the binary change, then the schema settled).
			// The test panel heard the change once.
			assert.strictEqual(handle.posted.filter((m) => m.type === 'binary' && m.status === 'ok').length, 1, JSON.stringify(binaries(handle)));
			assert.deepStrictEqual(binaries(handle), ['ok']);
			assert.strictEqual((await run(handle, '{"a":1}')).result.kind, 'ok');
		} finally {
			await restoreBinary(bin);
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
		// 4.9: an untitled config has no samples file.
		assert.strictEqual(samplesUri(doc.uri), undefined);
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

	// Saved samples (4.9).
	type SamplesMessage = Extract<BloblangHostMessage, { type: 'samples' }>;
	const samplesMessages = (handle: BloblangPanelHandle) => handle.posted.filter((m): m is SamplesMessage => m.type === 'samples');
	/** The samples file beside `name` in the temp folder. */
	const samplesFile = (name: string) => path.join(dir, name.replace(/\.yaml$/, '.samples.json'));
	const readSamples = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
	const sample = (name: string, content = '', meta: Record<string, string> = {}) => ({ name, content, meta });

	/** A test BloblangPanels whose Delete modal answers `answer.value` and records what it was asked. */
	function samplePanels() {
		const asked: string[] = [];
		const answer = { value: true };
		const { panels, log } = testBloblangPanels(undefined, async (name) => {
			asked.push(name);
			return answer.value;
		});
		return { panels, log, asked, answer };
	}

	test('FIRST_SAMPLE + SWITCH + RENAME / DUP + EDIT_SAVED + RELOAD (4.9): the file beside the config, written by the host', async () => {
		const doc = (await open('orders.yaml', CONFIG)).document;
		const file = samplesFile('orders.yaml');
		const { panels } = samplePanels();
		try {
			let handle = (await panels.show(doc.uri, FIRST))!;
			assert.match(handle.panel.webview.html, /data-samples="orders\.samples\.json"/);
			await handle.receive({ type: 'ready' });
			assert.deepStrictEqual(lastSnapshot(handle), { ...lastSnapshot(handle), samples: [], selected: null });
			assert.strictEqual(lastSnapshot(handle)?.samplesError, undefined);
			assert.ok(!fs.existsSync(file), 'no file before the first sample');

			// FIRST_SAMPLE: the webview's New sample with no samples: sampleAdded, then the input.
			await handle.receive({ type: 'sampleAdded', name: 'sample 1' });
			await handle.receive({ type: 'inputEdited', content: '{"a":1}', meta: { k: 'v' } });
			const text = fs.readFileSync(file, 'utf8');
			assert.deepStrictEqual(JSON.parse(text), {
				version: 1, mappings: [{ label: 'first', selected: 'sample 1', samples: [sample('sample 1', '{"a":1}', { k: 'v' })] }],
			});
			assert.ok(text.startsWith('{\n  "version": 1,\n  "mappings": [') && text.endsWith('}\n'), text);
			assert.deepStrictEqual(samplesMessages(handle), [], 'nothing is posted back for the webview\'s own changes');

			// SWITCH
			await handle.receive({ type: 'sampleAdded', name: 'sample 2' });
			assert.strictEqual(readSamples(file).mappings[0].selected, 'sample 2');
			await handle.receive({ type: 'sampleSwitched', name: 'sample 1' });
			assert.strictEqual(readSamples(file).mappings[0].selected, 'sample 1');

			// RENAME / DUP
			await handle.receive({ type: 'sampleRenamed', from: 'sample 2', to: 'two' });
			assert.deepStrictEqual(readSamples(file).mappings[0].samples.map((s: { name: string }) => s.name), ['sample 1', 'two']);
			const bytes = fs.readFileSync(file, 'utf8');
			await handle.receive({ type: 'sampleRenamed', from: 'two', to: 'sample 1' });
			assert.strictEqual(fs.readFileSync(file, 'utf8'), bytes, 'DUP: nothing written');
			assert.deepStrictEqual(samplesMessages(handle).at(-1), {
				type: 'samples', samples: [sample('sample 1', '{"a":1}', { k: 'v' }), sample('two')], selected: 'sample 1',
			}, 'DUP: the file\'s state goes back');

			// EDIT_SAVED: content and metadata into the selected sample.
			await handle.receive({ type: 'inputEdited', content: '{"a":5}', meta: { k: 'w', n: '1' } });
			assert.deepStrictEqual(readSamples(file).mappings[0].samples[0], sample('sample 1', '{"a":5}', { k: 'w', n: '1' }));

			// RELOAD: a new panel finds them.
			handle.panel.dispose();
			assert.strictEqual(panels.panelFor(doc.uri, FIRST), undefined);
			handle = (await panels.show(doc.uri, FIRST))!;
			await handle.receive({ type: 'ready' });
			const snap = lastSnapshot(handle)!;
			assert.deepStrictEqual([snap.samples, snap.selected], [[sample('sample 1', '{"a":5}', { k: 'w', n: '1' }), sample('two')], 'sample 1']);
		} finally {
			panels.dispose();
		}
	});

	test('DELETE (4.9): the modal; cancel changes nothing; Delete selects the neighbour; the last one deletes the file', async () => {
		assert.strictEqual(deleteSampleMessage('a'), 'Delete sample "a"?');
		const doc = (await open('delete.yaml', CONFIG)).document;
		const file = samplesFile('delete.yaml');
		fs.writeFileSync(file, JSON.stringify({ version: 1, mappings: [{ label: 'first', selected: 'a', samples: [sample('a', '1'), sample('b', '2')] }] }));
		const { panels, asked, answer } = samplePanels();
		try {
			const handle = (await panels.show(doc.uri, FIRST))!;
			await handle.receive({ type: 'ready' });
			const bytes = fs.readFileSync(file, 'utf8');
			answer.value = false;
			await handle.receive({ type: 'sampleDeleted', name: 'a' });
			assert.deepStrictEqual(asked, ['a']);
			assert.strictEqual(fs.readFileSync(file, 'utf8'), bytes, 'cancelled: unchanged');
			assert.deepStrictEqual(samplesMessages(handle), []);
			answer.value = true;
			await handle.receive({ type: 'sampleDeleted', name: 'a' });
			assert.deepStrictEqual(readSamples(file).mappings, [{ label: 'first', selected: 'b', samples: [sample('b', '2')] }]);
			assert.deepStrictEqual(samplesMessages(handle).at(-1), { type: 'samples', samples: [sample('b', '2')], selected: 'b' });
			await handle.receive({ type: 'sampleDeleted', name: 'b' });
			assert.ok(!fs.existsSync(file), 'no entry left: the file is deleted');
			assert.deepStrictEqual(samplesMessages(handle).at(-1), { type: 'samples', samples: [], selected: null });
		} finally {
			panels.dispose();
		}
	});

	test('REORDER + PATH_FALLBACK (4.9): a moved labelled processor finds its samples by label; an unlabelled one is written with its path', async () => {
		const editor = await open('reorder.yaml', CONFIG);
		const doc = editor.document;
		const file = samplesFile('reorder.yaml');
		const { panels } = samplePanels();
		try {
			const first = (await panels.show(doc.uri, FIRST))!;
			await first.receive({ type: 'sampleAdded', name: 'labelled' });
			// PATH_FALLBACK: `pipeline.processors[2]` has no label.
			const unlabelled = (await panels.show(doc.uri, 'pipeline.processors[2]'))!;
			await unlabelled.receive({ type: 'sampleAdded', name: 'by path' });
			assert.deepStrictEqual(readSamples(file).mappings, [
				{ label: 'first', selected: 'labelled', samples: [sample('labelled')] },
				{ path: 'pipeline.processors[2]', selected: 'by path', samples: [sample('by path')] },
			]);
			first.panel.dispose();
			unlabelled.panel.dispose();

			// REORDER: the labelled processor moves below the switch.
			const lines = CONFIG.split('\n');
			const at = lines.indexOf('    - label: first');
			const moved = [...lines.slice(0, at), ...lines.slice(at + 2, at + 6), ...lines.slice(at, at + 2), ...lines.slice(at + 6)].join('\n');
			await setText(doc, moved);
			const handle = (await panels.show(doc.uri, 'pipeline.processors[1]'))!;
			assert.strictEqual(handle.panel.title, 'Bloblang: first');
			await handle.receive({ type: 'ready' });
			assert.deepStrictEqual([lastSnapshot(handle)?.samples, lastSnapshot(handle)?.selected], [[sample('labelled')], 'labelled']);
		} finally {
			panels.dispose();
			await setText(doc, CONFIG);
			assert.ok(await doc.save());
		}
	});

	test('OUTSIDE_EDIT (4.9): a change on disk and a save in VS Code post samples; the host\'s own writes do not', async () => {
		const doc = (await open('outside.yaml', CONFIG)).document;
		const file = samplesFile('outside.yaml');
		const write = (content: string) => fs.writeFileSync(file, `${JSON.stringify({ version: 1, mappings: [{ label: 'first', selected: 'a', samples: [sample('a', content)] }] }, null, 2)}\n`);
		write('{"a":1}');
		const { panels } = samplePanels();
		try {
			const handle = (await panels.show(doc.uri, FIRST))!;
			await handle.receive({ type: 'ready' });
			assert.deepStrictEqual(lastSnapshot(handle)?.samples, [sample('a', '{"a":1}')]);
			// The host's own write.
			await handle.receive({ type: 'inputEdited', content: '{"a":2}', meta: {} });
			await settle();
			await settle();
			assert.deepStrictEqual(samplesMessages(handle), [], 'own writes are not outside edits');
			// On disk.
			write('{"a":3}');
			assert.ok(await waitFor(() => samplesMessages(handle).some((m) => m.samples[0]?.content === '{"a":3}'), 10_000),
				JSON.stringify(samplesMessages(handle)));
			// A save in VS Code.
			const json = await vscode.workspace.openTextDocument(file);
			await vscode.window.showTextDocument(json, vscode.ViewColumn.One);
			await setText(json, json.getText().replace('{\\"a\\":3}', '{\\"a\\":4}'));
			assert.ok(await json.save());
			assert.ok(await waitFor(() => samplesMessages(handle).some((m) => m.samples[0]?.content === '{"a":4}'), 10_000),
				JSON.stringify(samplesMessages(handle)));
		} finally {
			panels.dispose();
		}
	});

	test('WRITE_FAILS (4.9): a write that fails shows the error and posts the file\'s samples back', async function () {
		if (process.getuid?.() === 0) {
			this.skip();
		}
		const doc = (await open('readonly.yaml', CONFIG)).document;
		const file = samplesFile('readonly.yaml');
		const text = JSON.stringify({ version: 1, mappings: [{ label: 'first', selected: 'a', samples: [sample('a', '{"a":1}')] }] });
		fs.writeFileSync(file, text);
		fs.chmodSync(file, 0o444);
		const shown: [string, string | undefined][] = [];
		const { panels } = testBloblangPanels(undefined, async () => true, (message, kind) => shown.push([message, kind]));
		try {
			const handle = (await panels.show(doc.uri, FIRST))!;
			await handle.receive({ type: 'ready' });
			await handle.receive({ type: 'inputEdited', content: '{"a":2}', meta: {} });
			assert.strictEqual(fs.readFileSync(file, 'utf8'), text, 'the file is unchanged');
			assert.strictEqual(shown.length, 1, JSON.stringify(shown));
			assert.match(shown[0][0], /^Couldn't save the samples: .+/);
			assert.strictEqual(shown[0][0], couldNotSaveSamples(shown[0][0].slice('Couldn\'t save the samples: '.length)));
			assert.strictEqual(shown[0][1], 'error');
			assert.deepStrictEqual(samplesMessages(handle).at(-1), { type: 'samples', samples: [sample('a', '{"a":1}')], selected: 'a' });
		} finally {
			panels.dispose();
			fs.chmodSync(file, 0o644);
		}
	});

	test('UNREADABLE (4.9): the reason in the snapshot; no change writes; a fixed file posts samples again', async () => {
		const doc = (await open('unreadable.yaml', CONFIG)).document;
		const file = samplesFile('unreadable.yaml');
		const broken = '{"version": 1, "mappings": [';
		fs.writeFileSync(file, broken);
		const { panels } = samplePanels();
		try {
			const handle = (await panels.show(doc.uri, FIRST))!;
			await handle.receive({ type: 'ready' });
			const snap = lastSnapshot(handle)!;
			assert.deepStrictEqual([snap.samples, snap.selected], [[], null]);
			assert.ok(snap.samplesError && snap.samplesError.length > 0, JSON.stringify(snap));
			for (const message of [
				{ type: 'sampleAdded', name: 'x' }, { type: 'inputEdited', content: '{}', meta: {} }, { type: 'sampleSwitched', name: 'x' },
				{ type: 'sampleRenamed', from: 'x', to: 'y' }, { type: 'sampleDeleted', name: 'x' },
			]) {
				await handle.receive(message);
			}
			assert.strictEqual(fs.readFileSync(file, 'utf8'), broken, 'the file bytes are unchanged');
			assert.ok(samplesMessages(handle).length >= 5 && samplesMessages(handle).every((m) => m.samplesError === snap.samplesError && m.samples.length === 0));
			// Wrong shape: also unreadable.
			fs.writeFileSync(file, '{"version": 2, "mappings": []}');
			assert.ok(await waitFor(() => samplesMessages(handle).at(-1)?.samplesError === 'version must be 1', 10_000), JSON.stringify(samplesMessages(handle).at(-1)));
			fs.writeFileSync(file, JSON.stringify({ version: 1, mappings: [{ label: 'first', selected: null, samples: [sample('ok')] }] }));
			assert.ok(await waitFor(() => {
				const last = samplesMessages(handle).at(-1);
				return last?.samplesError === undefined && last?.samples.length === 1;
			}, 10_000), JSON.stringify(samplesMessages(handle).at(-1)));
		} finally {
			panels.dispose();
		}
	});
});
