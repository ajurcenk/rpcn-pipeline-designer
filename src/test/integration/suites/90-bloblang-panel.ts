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
// Ticket 4.16: Add label (its input box a seam: `askLabel`) writing the label and relinking the
// samples, and the CodeLens's sample count and its refreshes (heard through `bloblangLens`).
// Ticket 4.10: each panel follows its processor through edits (an insert above, a reorder, a typed
// label), its samples follow on save, and a deleted processor's removed state clears on undo; each
// scenario with and without the graph open.
// Ticket 4.17: the panel closes with its file's last text tab, follows a rename (a file's, with its
// samples file, or a folder's), and opens in one test group below the graph (a graph opened later
// goes above it).
// Ticket 4.11: Esc in the panel (`focusEditorRequested`) focuses the YAML editor with its cursor unchanged.
// Ticket 4.18: From previous step (`sampleFromPreviousRequested`) on the fake `run`, and the
// snapshot's `previousStep`; a run seam for non-string output metadata.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import {
	ADD_LABEL_TITLE, addLabelPrompt, BLOBLANG_VIEW_TYPE, BloblangPanels, couldNotAddLabel, couldNotMoveSamples, couldNotSaveSamples, deleteSampleMessage,
	LABEL_PROCESSOR_CHANGED, labelInSamples, labelSamplesNotSaved, labelSamplesUnreadable, SAMPLES_USE_IT, SAMPLES_WAIT_FOR_SAVE,
	NO_LONGER_THERE, NO_MAPPING_AT_CURSOR, PREVIOUS_FILE_CHANGED, PREVIOUS_NAME_TAKEN, previousDeleted, previousFailed, previousHasNoSample, saveFirst,
	samplesNotMoved, samplesUnreadable, TEST_MAPPING_COMMAND,
	type BloblangPanelHandle, type LabelRequest, type MappingTestRunner,
} from '../../../adapters/bloblangPanel/panels';
import { samplesUri } from '../../../adapters/bloblangPanel/sampleStore';
import { GRAPH_VIEW_TYPE } from '../../../adapters/graphPanel/panels';
import { NO_BINARY_MESSAGE, runMappingTest } from '../../../adapters/redpandaConnect/bloblang';
import { INSTALL_GUIDE_URL, type BinaryActions } from '../../../adapters/redpandaConnect/notify';
import { TEST_MAPPING_LENS_TITLE, testMappingLensTitle } from '../../../adapters/vscode/bloblangLens';
import { LABEL_IN_SAMPLES_ERROR, LABEL_RULE_ERROR, LABEL_TAKEN_ERROR } from '../../../core/labelEdit';
import { bloblangString } from '../../../core/bloblangRun';
import { type ExtensionApi } from '../../../extension';
import type { BloblangHostMessage, BloblangResult } from '../../../shared/bloblangProtocol';
import { bloblParseBody, connectScript, fixtureBodies, makeTempDir, mappingTestRunBody, readCounter, writeFakeBinary } from '../../helpers/fakeBinary';
import { fakeActions, insert, loseBinary, replace, restoreBinary, settle } from '../graphHelpers';
import { EXTENSION_ID, waitFor, waitForAsync } from '../helpers';

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
		// Pinned, not a preview (4.17): another file opened in the group would replace a preview tab,
		// and the file's panels close with its last tab.
		const editor = await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
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

	/**
	 * Makes `text` the whole text of `doc`, as an editor would: one edit of the part between their
	 * common start and end (4.10: a replacement of everything would remove every processor).
	 */
	async function setText(doc: vscode.TextDocument, text: string): Promise<void> {
		const old = doc.getText();
		let start = 0;
		while (start < old.length && start < text.length && old[start] === text[start]) {
			start++;
		}
		let end = 0;
		while (end < old.length - start && end < text.length - start && old[old.length - 1 - end] === text[text.length - 1 - end]) {
			end++;
		}
		if (old !== text) {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(doc.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(old.length - end)), text.slice(start, text.length - end));
			assert.ok(await vscode.workspace.applyEdit(edit));
		}
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

	test('LENS: one lens per mapping / mutation processor on its key line, with its sample count (4.16); none in YAML that is not a config', async () => {
		// 4.16: three samples by label, one by path; the others have none.
		const s = (name: string) => ({ name, content: '', meta: {} });
		fs.writeFileSync(path.join(dir, 'lens.samples.json'), JSON.stringify({ version: 1, mappings: [
			{ label: 'first', selected: null, samples: [s('a'), s('b'), s('c')] },
			{ path: 'pipeline.processors[2]', selected: null, samples: [s('x')] },
			{ path: FIRST, selected: null, samples: [s('ignored: the processor has a label')] },
		] }));
		const editor = await open('lens.yaml', CONFIG);
		const doc = editor.document;
		assert.ok(api().detection.isDetected(doc.uri));
		const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri))
			.filter((l) => l.command?.command === TEST_MAPPING_COMMAND);
		const keyLine = (needle: string) => CONFIG.split('\n').findIndex((l) => l.includes(needle));
		assert.deepStrictEqual(lenses.map((l) => [l.range.start.line, l.command?.title, l.command?.arguments?.[1]]), [
			[keyLine('mapping: root.b = this.a + 1'), '▷ Test mapping · 3 samples', FIRST],
			[keyLine('mutation: root.b'), TEST_MAPPING_LENS_TITLE, NESTED],
			[keyLine('FAIL_ME'), '▷ Test mapping · 1 sample', 'pipeline.processors[2]'],
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
			{
				type: 'snapshot', title: 'Bloblang: first', kind: 'mapping', source: 'root.b = this.a + 1', binary: 'ok', samples: [], selected: null,
				fileName: 'open.yaml', samplesFile: 'open.samples.json',
			});
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

	test('TRY_CATCH_FIX (4.12): a mapping directly in try: and a mutation directly in catch: get a lens and run', async () => {
		const text = [
			'input:',
			'  stdin: {}',
			'pipeline:',
			'  processors:',
			'    - try:',
			'        - mapping: root.b = this.a + 1',
			'    - catch:',
			'        - mutation: root.b = this.a + 1',
			'output:',
			'  stdout: {}',
			'',
		].join('\n');
		const doc = (await open('try-catch.yaml', text)).document;
		const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri))
			.filter((l) => l.command?.command === TEST_MAPPING_COMMAND);
		const keyLine = (needle: string) => text.split('\n').findIndex((l) => l.includes(needle));
		assert.deepStrictEqual(lenses.map((l) => [l.range.start.line, l.command?.title, l.command?.arguments?.[1]]), [
			[keyLine('- mapping:'), TEST_MAPPING_LENS_TITLE, 'pipeline.processors[0].try[0]'],
			[keyLine('- mutation:'), TEST_MAPPING_LENS_TITLE, 'pipeline.processors[1].catch[0]'],
		]);
		const inTry = await show(doc.uri, 'pipeline.processors[0].try[0]');
		assert.strictEqual(inTry.panel.title, 'Bloblang: pipeline.processors[0].try[0]');
		assert.deepStrictEqual((await run(inTry, '{"a":1}')).result, {
			kind: 'ok', content: '{"b":2}', meta: {},
			changes: { fields: { added: ['b'], changed: [], removed: ['a'] }, meta: { added: [], changed: [], removed: [] } },
		});
		assert.strictEqual(parse(lastRun().config).pipeline.processors[0].mapping, 'root.b = this.a + 1');
		const inCatch = await show(doc.uri, 'pipeline.processors[1].catch[0]');
		assert.deepStrictEqual((await run(inCatch, '{"a":1}')).result, {
			kind: 'ok', content: '{"a":1,"b":2}', meta: {},
			changes: { fields: { added: ['b'], changed: [], removed: [] }, meta: { added: [], changed: [], removed: [] } },
		});
		assert.strictEqual(parse(lastRun().config).pipeline.processors[0].mutation, 'root.b = this.a + 1');
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

	test('ESC (4.11): focusEditorRequested focuses the YAML editor in its group, its cursor and selection unchanged', async () => {
		const editor = await open('esc.yaml', ERRORS_CONFIG);
		const doc = editor.document;
		const handle = await show(doc.uri, 'pipeline.processors[1]');
		const at = doc.getText().indexOf('this.nope');
		editor.selection = new vscode.Selection(doc.positionAt(at), doc.positionAt(at + 'this.nope'.length));
		const before = editor.selection;
		// The panel has focus, as when Esc is pressed in it.
		handle.panel.reveal(handle.panel.viewColumn, false);
		assert.ok(await waitFor(() => handle.panel.active, 10_000), 'the test panel is focused');

		await handle.receive({ type: 'focusEditorRequested' });
		assert.ok(await waitFor(() => vscode.window.activeTextEditor === editor, 10_000), 'the YAML editor is focused');
		assert.strictEqual(editor.viewColumn, vscode.ViewColumn.One, 'in its own group');
		assert.ok(editor.selection.isEqual(before), 'the cursor and selection are unchanged');
		assert.strictEqual(vscode.window.visibleTextEditors.filter((e) => e.document === doc).length, 1, 'no new editor');
		assert.notStrictEqual(handle.panel.viewColumn, vscode.ViewColumn.One, 'the panel stays in its own group');
		assert.ok(!doc.isDirty, 'nothing edits the text');
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
		askLabel?: (request: LabelRequest) => Promise<string | undefined>, run?: MappingTestRunner,
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
			...(askLabel ? { askLabel } : {}),
			...(run ? { run } : {}),
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

	// Add label and the lens's count (4.16).
	const UNLABELLED = 'pipeline.processors[2]';
	/** The lens titles of `doc`'s processors, by path. */
	async function lensTitles(doc: vscode.TextDocument): Promise<Record<string, string>> {
		const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri);
		return Object.fromEntries(lenses.filter((l) => l.command?.command === TEST_MAPPING_COMMAND)
			.map((l) => [l.command!.arguments![1] as string, l.command!.title]));
	}
	/** Waits until `doc`'s lens at `processorPath` reads `title`. */
	async function lensReads(doc: vscode.TextDocument, processorPath: string, title: string): Promise<void> {
		let last: Record<string, string> = {};
		assert.ok(await waitForAsync(async () => (last = await lensTitles(doc))[processorPath] === title, 10_000),
			`${processorPath}: ${JSON.stringify(last)}`);
	}
	/** Counts the lens's refreshes from now on. */
	function lensRefreshes(): { readonly count: () => number; readonly dispose: () => void } {
		let n = 0;
		const subscription = api().bloblangLens.onDidChangeCodeLenses(() => n++);
		return { count: () => n, dispose: () => subscription.dispose() };
	}
	/** A test BloblangPanels whose input box answers `answer.value` (or runs `answer.during` first) and records each request. */
	function labelPanels() {
		const asked: LabelRequest[] = [];
		const shown: [string, string | undefined][] = [];
		const answer: { value: string | undefined; during?: () => Promise<void> } = { value: undefined };
		const { panels } = testBloblangPanels(undefined, async () => true, (message, kind) => shown.push([message, kind]), async (request) => {
			asked.push(request);
			await answer.during?.();
			return answer.value;
		});
		return { panels, asked, shown, answer };
	}

	test('OFFER + ACCEPT + REORDER_AFTER + AI-7 (4.16): Add label writes the label, relinks the samples, and they follow a move', async () => {
		const doc = (await open('label.yaml', CONFIG)).document;
		const file = samplesFile('label.yaml');
		const pathEntry = { path: UNLABELLED, selected: 'b', samples: [sample('a', '{"a":1}'), sample('b', '{"a":2}', { k: 'v' })] };
		const used = { label: 'used', selected: null, samples: [sample('u')] };
		fs.writeFileSync(file, JSON.stringify({ version: 1, mappings: [pathEntry, used] }));
		const { panels, asked, shown, answer } = labelPanels();
		try {
			await lensReads(doc, UNLABELLED, '▷ Test mapping · 2 samples');
			// OFFER: the unlabelled processor's snapshot has its path; a labelled one's has none.
			const labelled = (await panels.show(doc.uri, FIRST))!;
			await labelled.receive({ type: 'ready' });
			assert.strictEqual(lastSnapshot(labelled)?.unlabelledPath, undefined);
			await labelled.receive({ type: 'addLabelRequested' });
			assert.strictEqual(asked.length, 0, 'a labelled processor is not offered a label');
			const handle = (await panels.show(doc.uri, UNLABELLED))!;
			await handle.receive({ type: 'ready' });
			assert.deepStrictEqual(lastSnapshot(handle), {
				type: 'snapshot', title: `Bloblang: ${UNLABELLED}`, kind: 'mapping', source: 'root.b = this.nope.or("FAIL_ME")', binary: 'ok',
				samples: pathEntry.samples, selected: 'b', unlabelledPath: UNLABELLED, fileName: 'label.yaml', samplesFile: 'label.samples.json',
			});

			// INVALID / DUP / USED, then ACCEPT.
			answer.value = 'mapping_1';
			// While the box is open: what it checks (the document's labels are read as it is then).
			const checked: (string | undefined)[] = [];
			answer.during = async () => {
				checked.push(...['Bad', '_x', 'first', 'used', 'mapping_1'].map((v) => asked[0].validate(v)));
			};
			const from = handle.posted.length;
			await handle.receive({ type: 'addLabelRequested' });
			// Nothing posted while the label is written and the samples relinked shows them gone.
			await settle();
			const during = handle.posted.slice(from).filter((m): m is SamplesMessage | Extract<BloblangHostMessage, { type: 'snapshot' }> =>
				m.type === 'snapshot' || m.type === 'samples');
			assert.ok(during.length > 0 && during.every((m) => m.samples.length === 2 && m.selected === 'b'), JSON.stringify(during));
			answer.during = undefined;
			assert.strictEqual(asked.length, 1);
			const request = asked[0];
			assert.deepStrictEqual([request.title, request.prompt, request.value], [ADD_LABEL_TITLE, addLabelPrompt(UNLABELLED), 'mapping_1']);
			assert.deepStrictEqual(checked, [LABEL_RULE_ERROR, LABEL_RULE_ERROR, LABEL_TAKEN_ERROR, LABEL_IN_SAMPLES_ERROR, undefined]);
			assert.strictEqual(request.validate('mapping_1'), LABEL_TAKEN_ERROR, 'once written, it is the document\'s');
			assert.deepStrictEqual(shown, []);

			// The YAML: the label is the first key, at the key column; not saved.
			assert.ok(doc.getText().includes('    - label: mapping_1\n      mapping: root.b = this.nope.or("FAIL_ME")\n'), doc.getText());
			assert.ok(doc.isDirty, 'the document is not saved');
			// The samples: relinked, samples and selected kept.
			assert.deepStrictEqual(readSamples(file).mappings, [{ label: 'mapping_1', selected: 'b', samples: pathEntry.samples }, used]);
			// The panel: title, snapshot, no offer.
			assert.strictEqual(handle.panel.title, 'Bloblang: mapping_1');
			assert.deepStrictEqual(lastSnapshot(handle), {
				type: 'snapshot', title: 'Bloblang: mapping_1', kind: 'mapping', source: 'root.b = this.nope.or("FAIL_ME")', binary: 'ok',
				samples: pathEntry.samples, selected: 'b', fileName: 'label.yaml', samplesFile: 'label.samples.json',
			});
			await lensReads(doc, UNLABELLED, '▷ Test mapping · 2 samples');

			// AI-7 with 4.9's OUTSIDE_EDIT: the relinked entry reloads from disk.
			fs.writeFileSync(file, JSON.stringify({ version: 1, mappings: [{ label: 'mapping_1', selected: 'b', samples: [sample('a', '{"a":1}'), sample('b', '{"a":9}')] }, used] }));
			assert.ok(await waitFor(() => samplesMessages(handle).some((m) => m.samples[1]?.content === '{"a":9}'), 10_000), JSON.stringify(samplesMessages(handle)));
			// And a change from the panel goes to the label entry.
			await handle.receive({ type: 'inputEdited', content: '{"a":10}', meta: {} });
			assert.deepStrictEqual(readSamples(file).mappings[0].samples[1], sample('b', '{"a":10}'));
			labelled.panel.dispose();
			handle.panel.dispose();

			// REORDER_AFTER: the processor moves to the top; a new panel finds the samples by label.
			const text = doc.getText();
			const block = '    - label: mapping_1\n      mapping: root.b = this.nope.or("FAIL_ME")\n';
			await setText(doc, text.replace(block, '').replace('  processors:\n', `  processors:\n${block}`));
			await lensReads(doc, FIRST, '▷ Test mapping · 2 samples');
			const moved = (await panels.show(doc.uri, FIRST))!;
			assert.strictEqual(moved.panel.title, 'Bloblang: mapping_1');
			await moved.receive({ type: 'ready' });
			assert.deepStrictEqual([lastSnapshot(moved)?.samples.length, lastSnapshot(moved)?.selected, lastSnapshot(moved)?.unlabelledPath], [2, 'b', undefined]);
		} finally {
			panels.dispose();
			await setText(doc, CONFIG);
			assert.ok(await doc.save());
		}
	});

	test('CANCEL + ACCEPT_NO_SAMPLES + CHANGED (4.16): Esc changes nothing; no entry: the file is not created; a processor changed meanwhile relinks nothing', async () => {
		const doc = (await open('label-none.yaml', CONFIG)).document;
		const file = samplesFile('label-none.yaml');
		const { panels, asked, shown, answer } = labelPanels();
		try {
			const handle = (await panels.show(doc.uri, NESTED))!;
			await handle.receive({ type: 'ready' });
			assert.strictEqual(lastSnapshot(handle)?.unlabelledPath, NESTED);

			// CANCEL
			const before = handle.posted.length;
			answer.value = undefined;
			await handle.receive({ type: 'addLabelRequested' });
			assert.strictEqual(asked.at(-1)?.value, 'mutation_1');
			assert.strictEqual(doc.getText(), CONFIG);
			assert.ok(!doc.isDirty);
			assert.strictEqual(handle.panel.title, `Bloblang: ${NESTED}`);
			assert.strictEqual(handle.posted.length, before, 'nothing is posted');
			assert.deepStrictEqual(shown, []);

			// CHANGED: an edit of the processor while the box is open.
			answer.value = 'mutation_1';
			answer.during = () => setText(doc, CONFIG.replace('mutation: root.b = this.a + 1', 'mutation: root.b = this.a + 2'));
			await handle.receive({ type: 'addLabelRequested' });
			assert.ok(!doc.getText().includes('label: mutation_1'), doc.getText());
			assert.deepStrictEqual(shown.at(-1), [couldNotAddLabel(LABEL_PROCESSOR_CHANGED), 'error']);
			assert.strictEqual(handle.panel.title, `Bloblang: ${NESTED}`);
			answer.during = undefined;

			// ACCEPT_NO_SAMPLES
			shown.length = 0;
			await handle.receive({ type: 'addLabelRequested' });
			assert.ok(doc.getText().includes('            - label: mutation_1\n              mutation: root.b = this.a + 2\n'), doc.getText());
			assert.ok(!fs.existsSync(file), 'no entry: no samples file');
			assert.deepStrictEqual(shown, []);
			assert.strictEqual(handle.panel.title, 'Bloblang: mutation_1');
			assert.strictEqual(lastSnapshot(handle)?.title, 'Bloblang: mutation_1');
			assert.strictEqual(lastSnapshot(handle)?.unlabelledPath, undefined);
			// The new samples go to the label.
			await handle.receive({ type: 'sampleAdded', name: 'one' });
			assert.deepStrictEqual(readSamples(file).mappings, [{ label: 'mutation_1', selected: 'one', samples: [sample('one')] }]);
		} finally {
			panels.dispose();
			await setText(doc, CONFIG);
			assert.ok(await doc.save());
		}
	});

	test('RELINK_FAILS (4.16): taken, unreadable or a failed write undoes the label, keeps the path link and the note, and says why', async () => {
		const doc = (await open('label-fails.yaml', CONFIG)).document;
		const file = samplesFile('label-fails.yaml');
		const pathEntry = { path: UNLABELLED, selected: 'a', samples: [sample('a', '{"a":1}')] };
		const good = JSON.stringify({ version: 1, mappings: [pathEntry] });
		fs.writeFileSync(file, good);
		const { panels, shown, answer } = labelPanels();
		/** Add label with `during` run while the box is open; then the YAML, the panel and the error are as before. */
		const failsWith = async (handle: BloblangPanelHandle, during: () => Promise<void>, error: (shown: string) => string) => {
			shown.length = 0;
			answer.value = 'mapping_1';
			answer.during = during;
			await handle.receive({ type: 'addLabelRequested' });
			answer.during = undefined;
			assert.strictEqual(doc.getText(), CONFIG, 'the inserted label is removed');
			assert.strictEqual(handle.panel.title, `Bloblang: ${UNLABELLED}`);
			assert.strictEqual(shown.length, 1, JSON.stringify(shown));
			assert.deepStrictEqual(shown[0], [couldNotAddLabel(error(shown[0][0])), 'error']);
			fs.chmodSync(file, 0o644);
			fs.writeFileSync(file, good);
			// The path link and the note are back: a new snapshot shows the samples by path.
			await handle.receive({ type: 'ready' });
			assert.deepStrictEqual([lastSnapshot(handle)?.samples, lastSnapshot(handle)?.unlabelledPath], [pathEntry.samples, UNLABELLED]);
		};
		try {
			const handle = (await panels.show(doc.uri, UNLABELLED))!;
			await handle.receive({ type: 'ready' });
			// TAKEN: a label entry appears while the box is open.
			await failsWith(handle, async () => {
				fs.writeFileSync(file, JSON.stringify({ version: 1, mappings: [pathEntry, { label: 'mapping_1', selected: null, samples: [sample('z')] }] }));
			}, () => labelInSamples('mapping_1'));
			// UNREADABLE: the file breaks while the box is open; the reason is in the error.
			await failsWith(handle, async () => {
				fs.writeFileSync(file, '{"version": 1, "mappings": [');
			}, (text) => {
				const prefix = couldNotAddLabel(labelSamplesUnreadable(''));
				assert.ok(text.startsWith(prefix) && text.length > prefix.length, text);
				return labelSamplesUnreadable(text.slice(prefix.length));
			});
			// WRITE_FAILS: the file can't be written.
			if (process.getuid?.() !== 0) {
				await failsWith(handle, async () => {
					fs.chmodSync(file, 0o444);
				}, (text) => {
					const prefix = couldNotAddLabel(labelSamplesNotSaved(''));
					assert.ok(text.startsWith(prefix) && text.length > prefix.length, text);
					return labelSamplesNotSaved(text.slice(prefix.length));
				});
			}
			// Retry works.
			shown.length = 0;
			await handle.receive({ type: 'addLabelRequested' });
			assert.deepStrictEqual(shown, []);
			assert.strictEqual(handle.panel.title, 'Bloblang: mapping_1');
			assert.deepStrictEqual(readSamples(file).mappings, [{ label: 'mapping_1', selected: 'a', samples: pathEntry.samples }]);
		} finally {
			fs.chmodSync(file, 0o644);
			panels.dispose();
			await setText(doc, CONFIG);
			assert.ok(await doc.save());
		}
	});

	test('LENS_COUNT + LENS_REFRESH_PANEL / OUTSIDE + LENS_UNREADABLE (4.16): the count follows the panel\'s writes and the disk', async () => {
		assert.deepStrictEqual([0, 1, 3].map(testMappingLensTitle), ['▷ Test mapping', '▷ Test mapping · 1 sample', '▷ Test mapping · 3 samples']);
		const doc = (await open('count.yaml', CONFIG)).document;
		const file = samplesFile('count.yaml');
		assert.strictEqual((await lensTitles(doc))[FIRST], TEST_MAPPING_LENS_TITLE);
		const refreshes = lensRefreshes();
		try {
			// LENS_REFRESH_PANEL: the extension's own panel writes; the lens hears it.
			const handle = await show(doc.uri, FIRST);
			await handle.receive({ type: 'sampleAdded', name: 'one' });
			assert.ok(await waitFor(() => refreshes.count() > 0, 5_000), 'the lens refreshes after the host\'s write');
			await lensReads(doc, FIRST, '▷ Test mapping · 1 sample');
			await handle.receive({ type: 'sampleAdded', name: 'two' });
			await handle.receive({ type: 'sampleAdded', name: 'three' });
			await lensReads(doc, FIRST, '▷ Test mapping · 3 samples');
			handle.panel.dispose();
			assert.ok(await waitFor(() => api().bloblangPanels.size === 0, 5_000));

			// LENS_REFRESH_OUTSIDE: no panel open; the file changes on disk.
			const from = refreshes.count();
			fs.writeFileSync(file, JSON.stringify({ version: 1, mappings: [{ label: 'first', selected: null, samples: [sample('a'), sample('b')] }] }));
			assert.ok(await waitFor(() => refreshes.count() > from, 10_000), 'the lens refreshes on an outside edit');
			await lensReads(doc, FIRST, '▷ Test mapping · 2 samples');

			// LENS_UNREADABLE: invalid JSON shows no count; deleted, none either.
			fs.writeFileSync(file, '{"version": 1, "mappings": [');
			await lensReads(doc, FIRST, TEST_MAPPING_LENS_TITLE);
			fs.writeFileSync(file, JSON.stringify({ version: 1, mappings: [{ label: 'first', selected: null, samples: [sample('a')] }] }));
			await lensReads(doc, FIRST, '▷ Test mapping · 1 sample');
			fs.rmSync(file);
			await lensReads(doc, FIRST, TEST_MAPPING_LENS_TITLE);
		} finally {
			refreshes.dispose();
		}
	});

	// The panel follows its processor (4.10).
	const FOLLOW_CONFIG = [
		'input:',
		'  stdin: {}',
		'pipeline:',
		'  processors:',
		'    - label: first',
		'      mapping: root.b = this.a + 1',
		'    - mapping: |',
		'        root.c = 2',
		'        root.x = this.nope + 1 # FAIL_ON_2',
		'    - mutation: root.d = 3',
		'output:',
		'  stdout: {}',
		'',
	].join('\n');
	const P = (i: number) => `pipeline.processors[${i}]`;
	/** The offset of the start of the line of `doc` that holds `text`. */
	const lineOf = (doc: vscode.TextDocument, text: string) => {
		const at = doc.getText().indexOf(text);
		assert.ok(at >= 0, `no ${JSON.stringify(text)} in ${doc.getText()}`);
		return doc.getText().lastIndexOf('\n', at) + 1;
	};
	/** Opens the graph on `doc` when `graph`: the graph checks that it still renders after the edits. */
	async function maybeGraph(doc: vscode.TextDocument, graph: boolean): Promise<{ readonly works: () => Promise<void> }> {
		if (!graph) {
			return { works: async () => undefined };
		}
		const handle = (await api().graphPanels.show(doc.uri))!;
		await handle.lockSettled;
		await handle.receive({ type: 'ready' });
		const from = handle.posted.length;
		return {
			works: async () => {
				assert.ok(await waitFor(() => handle.posted.slice(from).some((m) => m.type === 'model'), 10_000), 'the graph renders the edits');
				assert.strictEqual(api().graphPanels.panelFor(doc.uri), handle, 'the graph is still open');
			},
		};
	}
	/** Waits until `doc`'s samples file reads `mappings`. */
	async function samplesRead(file: string, mappings: unknown): Promise<void> {
		let last: unknown;
		assert.ok(await waitFor(() => {
			last = fs.existsSync(file) ? readSamples(file).mappings : undefined;
			return JSON.stringify(last) === JSON.stringify(mappings);
		}, 10_000), JSON.stringify(last));
	}

	for (const graph of [false, true]) {
		const g = graph ? ' + WITH_GRAPH' : '';
		const name = (base: string) => `${base}${graph ? '-graph' : ''}.yaml`;

		test(`EDIT_ABOVE + INSERT_BEFORE + UNLABELLED_SHIFT_SAVE (4.10)${g}: the panel stays on its processor, its key and title follow, runs use it; the save moves its samples`, async () => {
			const editor = await open(name('follow-insert'), FOLLOW_CONFIG);
			const doc = editor.document;
			const file = samplesFile(name('follow-insert'));
			const { panels, shown } = labelPanels();
			const graphed = await maybeGraph(doc, graph);
			try {
				const handle = (await panels.show(doc.uri, P(1)))!;
				await handle.receive({ type: 'ready' });
				await handle.receive({ type: 'sampleAdded', name: 'one' });
				await handle.receive({ type: 'inputEdited', content: '{"a":1}', meta: {} });
				await samplesRead(file, [{ path: P(1), selected: 'one', samples: [sample('one', '{"a":1}')] }]);
				await settle();
				const shownBefore = lastSnapshot(handle);
				const from = handle.posted.length;

				// EDIT_ABOVE: the same processor; nothing shown changed, so no other snapshot (the real
				// webview's own `ready` may still bring the same one).
				await insert(doc, 0, '# a note\n');
				await settle();
				assert.strictEqual(handle.path, P(1));
				assert.strictEqual(panels.panelFor(doc.uri, P(1)), handle);
				const after = handle.posted.slice(from).filter((m) => m.type === 'snapshot');
				assert.ok(after.every((m) => JSON.stringify(m) === JSON.stringify(shownBefore)), JSON.stringify(after));

				// INSERT_BEFORE: path [1] → [2]; the key, the title and the runs follow.
				await insert(doc, lineOf(doc, '    - mapping: |'), '    - mapping: root.new = 0\n');
				assert.ok(await waitFor(() => handle.path === P(2), 5_000), handle.path);
				assert.strictEqual(handle.panel.title, `Bloblang: ${P(2)}`);
				assert.strictEqual(panels.panelFor(doc.uri, P(2)), handle);
				assert.strictEqual(panels.panelFor(doc.uri, P(1)), undefined, 'the inserted processor has no panel');
				assert.strictEqual(await panels.show(doc.uri, P(2)), handle, 'Test mapping finds it under its new key');
				assert.ok(await waitFor(() => lastSnapshot(handle)?.title === `Bloblang: ${P(2)}`, 5_000));
				// Before the save, the samples are still shown under the old link, and the note names its path.
				assert.deepStrictEqual([lastSnapshot(handle)?.samples, lastSnapshot(handle)?.unlabelledPath], [[sample('one', '{"a":1}')], P(1)]);
				const out = await run(handle, '{"a":1}');
				assert.strictEqual(out.result.kind, 'failed', 'the run used the followed processor (FAIL_ON_2)');
				assert.ok(lastRun().config.includes('root.c = 2') && !lastRun().config.includes('root.new'), lastRun().config);
				// Its hint is at the followed processor's line.
				const failing = doc.lineAt(doc.positionAt(doc.getText().indexOf('FAIL_ON_2')).line);
				assert.deepStrictEqual(panels.hintRanges(doc.uri).map((r) => r.start.line), [failing.lineNumber]);
				assert.deepStrictEqual(readSamples(file).mappings[0].path, P(1), 'not moved while typing');

				// UNLABELLED_SHIFT_SAVE: the entry moves from the old path to the new one.
				assert.ok(await doc.save());
				await samplesRead(file, [{ path: P(2), selected: 'one', samples: [sample('one', '{"a":1}')] }]);
				assert.ok(await waitFor(() => lastSnapshot(handle)?.unlabelledPath === P(2), 5_000), 'the note names the new path');
				assert.deepStrictEqual(shown, []);
				await handle.receive({ type: 'inputEdited', content: '{"a":2}', meta: {} });
				await samplesRead(file, [{ path: P(2), selected: 'one', samples: [sample('one', '{"a":2}')] }]);
				await graphed.works();
			} finally {
				panels.dispose();
				await setText(doc, FOLLOW_CONFIG);
				assert.ok(await doc.save());
			}
		});

		test(`REORDER_LABELLED + LABEL_TYPED + RELINK_TAKEN + LABEL_REMOVED (4.10)${g}: found by its label; the title follows the label; the save moves the samples, or says why not`, async () => {
			const doc = (await open(name('follow-label'), FOLLOW_CONFIG)).document;
			const file = samplesFile(name('follow-label'));
			const entry = (link: Record<string, string>) => ({ ...link, selected: 'a', samples: [sample('a', '{"a":1}')] });
			const taken = { label: 'taken', selected: null, samples: [sample('t')] };
			fs.writeFileSync(file, JSON.stringify({ version: 1, mappings: [entry({ label: 'first' }), taken] }));
			const { panels, shown } = labelPanels();
			const graphed = await maybeGraph(doc, graph);
			try {
				const handle = (await panels.show(doc.uri, P(0)))!;
				await handle.receive({ type: 'ready' });
				assert.deepStrictEqual(lastSnapshot(handle)?.samples, [sample('a', '{"a":1}')]);

				// REORDER_LABELLED: cut, then pasted below the mutation.
				const block = '    - label: first\n      mapping: root.b = this.a + 1\n';
				const at = lineOf(doc, '    - label: first');
				await replace(doc, at, at + block.length, '');
				assert.ok(await waitFor(() => handle.removed, 5_000), 'cut: removed');
				await insert(doc, lineOf(doc, 'output:'), block);
				assert.ok(await waitFor(() => !handle.removed && handle.path === P(2), 5_000), `${handle.removed} ${handle.path}`);
				assert.strictEqual(handle.panel.title, 'Bloblang: first');
				assert.ok(await waitFor(() => lastSnapshot(handle)?.removed === undefined, 5_000));
				// The real webview runs its selected sample once on coming back (Run on change): let it end first.
				await settle();
				assert.strictEqual((await run(handle, '{"a":1}')).result.kind, 'ok');
				assert.ok(lastRun().config.includes('root.b = this.a + 1'), lastRun().config);

				// LABEL_TYPED: `first` → `second`: the title at once, the samples on save.
				const label = (from: string, to: string) => {
					const i = doc.getText().indexOf(`label: ${from}`) + 'label: '.length;
					return replace(doc, i, i + from.length, to);
				};
				await label('first', 'second');
				assert.ok(await waitFor(() => handle.panel.title === 'Bloblang: second', 5_000), handle.panel.title);
				assert.ok(await waitFor(() => lastSnapshot(handle)?.title === 'Bloblang: second', 5_000));
				assert.deepStrictEqual(lastSnapshot(handle)?.samples, [sample('a', '{"a":1}')], 'still shown under the old link');
				assert.deepStrictEqual(readSamples(file).mappings, [entry({ label: 'first' }), taken], 'not moved while typing');
				assert.ok(await doc.save());
				await samplesRead(file, [entry({ label: 'second' }), taken]);

				// RELINK_TAKEN: `second` → `taken`, saved: nothing moves; the error; the old link stays.
				await label('second', 'taken');
				assert.ok(await waitFor(() => handle.panel.title === 'Bloblang: taken', 5_000));
				assert.ok(await doc.save());
				assert.ok(await waitFor(() => shown.length > 0, 5_000), 'the error is shown');
				assert.deepStrictEqual(shown, [[couldNotMoveSamples('taken', SAMPLES_USE_IT), 'error']]);
				assert.strictEqual(couldNotMoveSamples('taken', SAMPLES_USE_IT), 'Couldn\'t move the samples to taken: samples already use it.');
				assert.deepStrictEqual(readSamples(file).mappings, [entry({ label: 'second' }), taken]);
				await handle.receive({ type: 'inputEdited', content: '{"a":5}', meta: {} });
				assert.deepStrictEqual(readSamples(file).mappings[0], { label: 'second', selected: 'a', samples: [sample('a', '{"a":5}')] }, 'the old link');
				shown.length = 0;

				// LABEL_REMOVED: the label deleted, saved: the title is the path; the entry moves to the path.
				const l = doc.getText().indexOf('label: taken');
				await replace(doc, l, l + 'label: taken\n      '.length, '');
				assert.ok(await waitFor(() => handle.panel.title === `Bloblang: ${P(2)}`, 5_000), handle.panel.title);
				assert.strictEqual(handle.removed, false);
				assert.ok(await doc.save());
				await samplesRead(file, [{ path: P(2), selected: 'a', samples: [sample('a', '{"a":5}')] }, taken]);
				assert.ok(await waitFor(() => lastSnapshot(handle)?.unlabelledPath === P(2), 5_000), 'the offer is back');
				assert.deepStrictEqual(shown, []);
				await graphed.works();
			} finally {
				panels.dispose();
				await setText(doc, FOLLOW_CONFIG);
				assert.ok(await doc.save());
			}
		});

		test(`DELETED + UNDO + TWO_PANELS (4.10)${g}: the removed state, nothing runs, the hint clears; undo brings it back; the other panel is unaffected`, async () => {
			const editor = await open(name('follow-delete'), FOLLOW_CONFIG);
			const doc = editor.document;
			const { panels } = labelPanels();
			const graphed = await maybeGraph(doc, graph);
			try {
				const deleted = (await panels.show(doc.uri, P(1)))!;
				await deleted.receive({ type: 'ready' });
				const other = (await panels.show(doc.uri, P(2)))!;
				await other.receive({ type: 'ready' });
				assert.strictEqual((await run(deleted, '{"a":1}')).result.kind, 'failed');
				assert.strictEqual(panels.hintRanges(doc.uri).length, 1);

				// DELETED
				const block = '    - mapping: |\n        root.c = 2\n        root.x = this.nope + 1 # FAIL_ON_2\n';
				const at = lineOf(doc, '    - mapping: |');
				await replace(doc, at, at + block.length, '');
				assert.ok(await waitFor(() => deleted.removed, 5_000), 'removed');
				assert.ok(await waitFor(() => lastSnapshot(deleted)?.removed === true, 5_000));
				assert.deepStrictEqual(lastSnapshot(deleted), {
					type: 'snapshot', title: `Bloblang: ${P(1)}`, kind: 'mapping', source: 'root.c = 2\nroot.x = this.nope + 1 # FAIL_ON_2\n',
					binary: 'ok', samples: [], selected: null, removed: true,
					fileName: name('follow-delete'), samplesFile: name('follow-delete').replace(/\.yaml$/, '.samples.json'),
				});
				assert.strictEqual(deleted.path, P(1), 'its last path');
				assert.deepStrictEqual(panels.hintRanges(doc.uri), [], 'the hint clears');
				const spawned = runs();
				assert.strictEqual((await run(deleted, '{"a":1}')).result.kind, 'error');
				assert.strictEqual(runs(), spawned, 'nothing runs');
				// TWO_PANELS: the other panel follows its own processor; nothing converges.
				assert.ok(await waitFor(() => other.path === P(1), 5_000), other.path);
				assert.strictEqual(other.removed, false);
				assert.strictEqual(other.panel.title, `Bloblang: ${P(1)}`);
				assert.strictEqual(panels.panelFor(doc.uri, P(1)), other, 'the key is the live panel\'s');
				assert.strictEqual(await panels.show(doc.uri, P(1)), other);
				assert.strictEqual((await run(other, '{"a":1}')).result.kind, 'ok');
				assert.ok(lastRun().config.includes('root.d = 3'), lastRun().config);

				// UNDO
				await vscode.window.showTextDocument(doc, { viewColumn: editor.viewColumn, preserveFocus: false });
				await vscode.commands.executeCommand('undo');
				assert.ok(await waitFor(() => !deleted.removed, 5_000), 'back');
				assert.strictEqual(doc.getText(), FOLLOW_CONFIG);
				assert.ok(await waitFor(() => lastSnapshot(deleted)?.removed === undefined, 5_000));
				assert.deepStrictEqual([deleted.path, other.path], [P(1), P(2)]);
				assert.strictEqual(panels.panelFor(doc.uri, P(1)), deleted);
				assert.strictEqual(panels.panelFor(doc.uri, P(2)), other);
				assert.strictEqual((await run(deleted, '{"a":1}')).result.kind, 'failed');
				assert.ok(lastRun().config.includes('root.c = 2'), lastRun().config);
				await graphed.works();
			} finally {
				panels.dispose();
				await setText(doc, FOLLOW_CONFIG);
				assert.ok(await doc.save());
			}
		});

		test(`AI-7 with 4.16 (4.10)${g}: Add label relinks at once; a typed rename then moves the samples on save`, async () => {
			const doc = (await open(name('follow-addlabel'), FOLLOW_CONFIG)).document;
			const file = samplesFile(name('follow-addlabel'));
			fs.writeFileSync(file, JSON.stringify({ version: 1, mappings: [{ path: P(2), selected: 'a', samples: [sample('a')] }] }));
			const { panels, shown, answer } = labelPanels();
			const graphed = await maybeGraph(doc, graph);
			try {
				const handle = (await panels.show(doc.uri, P(2)))!;
				await handle.receive({ type: 'ready' });
				answer.value = 'mutation_1';
				await handle.receive({ type: 'addLabelRequested' });
				assert.deepStrictEqual(readSamples(file).mappings, [{ label: 'mutation_1', selected: 'a', samples: [sample('a')] }], 'relinked at once');
				assert.strictEqual(handle.panel.title, 'Bloblang: mutation_1');
				// A save with the link unchanged writes nothing.
				const bytes = fs.readFileSync(file, 'utf8');
				assert.ok(await doc.save());
				await settle();
				assert.strictEqual(fs.readFileSync(file, 'utf8'), bytes);
				// The typed rename.
				const i = doc.getText().indexOf('label: mutation_1') + 'label: '.length;
				await replace(doc, i, i + 'mutation_1'.length, 'totals');
				assert.ok(await waitFor(() => handle.panel.title === 'Bloblang: totals', 5_000), handle.panel.title);
				assert.ok(await doc.save());
				await samplesRead(file, [{ label: 'totals', selected: 'a', samples: [sample('a')] }]);
				assert.ok(await waitFor(() => lastSnapshot(handle)?.title === 'Bloblang: totals', 5_000));
				assert.deepStrictEqual(lastSnapshot(handle)?.samples, [sample('a')]);
				assert.deepStrictEqual(shown, []);
				await graphed.works();
			} finally {
				panels.dispose();
				await setText(doc, FOLLOW_CONFIG);
				assert.ok(await doc.save());
			}
		});

		test(`LABEL_PREFIX + WHOLE_LINE + BROKEN_YAML (4.10)${g}: a typed label takes nothing from another panel; a replaced line keeps the processor; broken YAML removes no panel`, async () => {
			const doc = (await open(name('follow-typing'), FOLLOW_CONFIG)).document;
			const { panels } = labelPanels();
			const graphed = await maybeGraph(doc, graph);
			try {
				const b = (await panels.show(doc.uri, P(0)))!;
				await b.receive({ type: 'ready' });
				const a = (await panels.show(doc.uri, P(1)))!;
				await a.receive({ type: 'ready' });

				// LABEL_PREFIX: `label: firstx` typed on A's processor, passing through `label: first` (B's).
				const at = doc.getText().indexOf('mapping: |');
				await insert(doc, at, 'label: f\n      ');
				for (const [offset, typed] of [[0, 'i'], [1, 'r'], [2, 's'], [3, 't'], [4, 'x']] as const) {
					await insert(doc, at + 'label: f'.length + offset, typed);
				}
				assert.ok(await waitFor(() => a.panel.title === 'Bloblang: firstx', 5_000), a.panel.title);
				assert.deepStrictEqual([a.path, a.removed, b.path, b.removed, b.panel.title], [P(1), false, P(0), false, 'Bloblang: first']);

				// WHOLE_LINE: B's `- label: first` line replaced in one edit by `- label: b`.
				const line = lineOf(doc, '    - label: first');
				await replace(doc, line, line + '    - label: first'.length, '    - label: b');
				assert.ok(await waitFor(() => b.panel.title === 'Bloblang: b', 5_000), b.panel.title);
				assert.deepStrictEqual([b.path, b.removed], [P(0), false]);

				// BROKEN_YAML: a stray line in the processors list: nothing changes while it is broken.
				const stray = lineOf(doc, '    - label: firstx');
				await insert(doc, stray, '  mapping: root.z = 9\n');
				await settle();
				assert.deepStrictEqual([a.path, a.removed, a.panel.title, b.path, b.removed, b.panel.title], [P(1), false, 'Bloblang: firstx', P(0), false, 'Bloblang: b']);
				assert.strictEqual(lastSnapshot(a)?.removed, undefined);
				assert.strictEqual((await run(a, '{"a":1}')).result.kind, 'failed', 'runs use the last processor found');
				assert.ok(lastRun().config.includes('root.c = 2'), lastRun().config);
				// Fixed with an indent change: a new processor above A's; A's path follows.
				await insert(doc, stray + 2, '  - ');
				assert.ok(await waitFor(() => a.path === P(2), 5_000), a.path);
				assert.deepStrictEqual([a.removed, a.panel.title, b.path, b.panel.title], [false, 'Bloblang: firstx', P(0), 'Bloblang: b']);
				assert.strictEqual(panels.panelFor(doc.uri, P(1)), undefined, 'the new processor has no panel');
				await graphed.works();
			} finally {
				panels.dispose();
				await setText(doc, FOLLOW_CONFIG);
				assert.ok(await doc.save());
			}
		});

		test(`INSERT_AT_NEXT_LINE (4.10)${g}: a processor inserted at the start of the next item's line takes no panel's processor`, async () => {
			const doc = (await open(name('follow-next-line'), FOLLOW_CONFIG)).document;
			const { panels } = labelPanels();
			const graphed = await maybeGraph(doc, graph);
			try {
				const first = (await panels.show(doc.uri, P(0)))!;
				await first.receive({ type: 'ready' });
				const second = (await panels.show(doc.uri, P(1)))!;
				await second.receive({ type: 'ready' });
				await insert(doc, lineOf(doc, '    - mapping: |'), '    - mapping: root.pasted = 0\n');
				assert.ok(await waitFor(() => second.path === P(2), 5_000), second.path);
				assert.deepStrictEqual([first.path, first.removed, first.panel.title], [P(0), false, 'Bloblang: first']);
				assert.strictEqual(panels.panelFor(doc.uri, P(1)), undefined, 'the inserted processor has no panel');
				assert.strictEqual((await run(first, '{"a":1}')).result.kind, 'ok');
				assert.ok(lastRun().config.includes('root.b = this.a + 1') && !lastRun().config.includes('root.pasted'), lastRun().config);
				await graphed.works();
			} finally {
				panels.dispose();
				await setText(doc, FOLLOW_CONFIG);
				assert.ok(await doc.save());
			}
		});

		test(`UNDO_RELINK (4.10)${g}: delete A, save, undo: A and B on their processors, never sharing a link, both refreshed`, async () => {
			const editor = await open(name('follow-undo-relink'), FOLLOW_CONFIG);
			const doc = editor.document;
			const file = samplesFile(name('follow-undo-relink'));
			const bEntry = (at: string, content = '{"b":1}') => ({ path: at, selected: 'b', samples: [sample('b', content)] });
			fs.writeFileSync(file, JSON.stringify({ version: 1, mappings: [bEntry(P(2))] }));
			const { panels, shown } = labelPanels();
			const graphed = await maybeGraph(doc, graph);
			/** The samples `handle` shows now: from its last snapshot or `samples`. */
			const showing = (handle: BloblangPanelHandle) => {
				const last = [...handle.posted].reverse().find((m) => m.type === 'snapshot' || m.type === 'samples');
				return last && (last.type === 'snapshot' || last.type === 'samples') ? last.samples : undefined;
			};
			try {
				const a = (await panels.show(doc.uri, P(1)))!;
				await a.receive({ type: 'ready' });
				const b = (await panels.show(doc.uri, P(2)))!;
				await b.receive({ type: 'ready' });
				assert.deepStrictEqual([showing(a), showing(b)], [[], [sample('b', '{"b":1}')]]);

				const block = '    - mapping: |\n        root.c = 2\n        root.x = this.nope + 1 # FAIL_ON_2\n';
				const at = lineOf(doc, '    - mapping: |');
				await replace(doc, at, at + block.length, '');
				assert.ok(await waitFor(() => a.removed && b.path === P(1), 5_000));
				assert.ok(await doc.save());
				await samplesRead(file, [bEntry(P(1))]);

				await vscode.window.showTextDocument(doc, { viewColumn: editor.viewColumn, preserveFocus: false });
				await vscode.commands.executeCommand('undo');
				assert.ok(await waitFor(() => !a.removed && a.path === P(1) && b.path === P(2), 5_000), `${a.removed} ${a.path} ${b.path}`);
				await settle();
				assert.deepStrictEqual([showing(a), showing(b)], [[], [sample('b', '{"b":1}')]], 'A does not show B\'s samples');
				// A sample added on A before the save is not saved, and says so: B's entry is untouched.
				await a.receive({ type: 'sampleAdded', name: 'lost' });
				assert.deepStrictEqual(readSamples(file).mappings, [bEntry(P(1))]);
				assert.deepStrictEqual(shown, [[SAMPLES_WAIT_FOR_SAVE, 'info']]);
				assert.strictEqual(SAMPLES_WAIT_FOR_SAVE, 'This processor\'s samples can\'t be saved until the file is saved.');
				shown.length = 0;

				// The save: B's entry moves back; A's link follows to its path; both are refreshed.
				const fromA = a.posted.length;
				const fromB = b.posted.length;
				assert.ok(await doc.save());
				await samplesRead(file, [bEntry(P(2))]);
				assert.ok(await waitFor(() => a.posted.length > fromA && b.posted.length > fromB, 5_000), 'both refreshed');
				assert.deepStrictEqual([showing(a), showing(b)], [[], [sample('b', '{"b":1}')]]);
				await a.receive({ type: 'sampleAdded', name: 'a' });
				await samplesRead(file, [bEntry(P(2)), { path: P(1), selected: 'a', samples: [sample('a')] }]);
				assert.deepStrictEqual(shown, []);
				await graphed.works();
			} finally {
				panels.dispose();
				await setText(doc, FOLLOW_CONFIG);
				assert.ok(await doc.save());
			}
		});

		test(`CLOSE_UNSAVED (4.10)${g}: an insert above, closed without saving, reopened: the panel is on its processor at the saved path`, async () => {
			// Opened as a user would (`vscode.diff`): a document an extension opened stays open for minutes after its editor
			// closes. In a diff editor (4.17): the file has no text tab, so its panel outlives the document's close.
			const uri = vscode.Uri.file(path.join(dir, name('follow-close')));
			fs.writeFileSync(uri.fsPath, FOLLOW_CONFIG);
			const left = vscode.Uri.file(path.join(dir, `${name('follow-close')}.left.txt`));
			fs.writeFileSync(left.fsPath, '');
			const showDiff = () => vscode.commands.executeCommand('vscode.diff', left, uri, 'diff', { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
			const opened = async () => {
				await showDiff();
				let found: vscode.TextDocument | undefined;
				assert.ok(await waitFor(() => (found = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())) !== undefined, 5_000));
				assert.ok(await waitFor(() => api().detection.has(uri), 5_000));
				return found!;
			};
			let doc = await opened();
			const { panels } = labelPanels();
			await maybeGraph(doc, graph);
			try {
				const handle = (await panels.show(doc.uri, P(1)))!;
				await handle.receive({ type: 'ready' });
				await insert(doc, lineOf(doc, '    - label: first'), '    - mapping: root.new = 0\n');
				assert.ok(await waitFor(() => handle.path === P(2), 5_000), handle.path);
				await showDiff();
				await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
				assert.ok(await waitFor(() => !vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString()), 20_000), 'the document closed');
				doc = await opened();
				assert.strictEqual(doc.getText(), FOLLOW_CONFIG);
				assert.ok(await waitFor(() => handle.path === P(1), 5_000), handle.path);
				assert.strictEqual(handle.removed, false);
				assert.strictEqual(handle.panel.title, `Bloblang: ${P(1)}`);
				assert.strictEqual((await run(handle, '{"a":1}')).result.kind, 'failed');
				assert.ok(lastRun().config.includes('root.c = 2') && !lastRun().config.includes('root.new'), lastRun().config);
				// An edit after the reopen: still tracked. (With the graph open, the graph's own behaviour
				// on its document's close is unchanged here.)
				await insert(doc, 0, '# reopened\n');
				await settle();
				assert.deepStrictEqual([handle.path, handle.removed], [P(1), false]);
			} finally {
				panels.dispose();
				await setText(doc, FOLLOW_CONFIG);
				assert.ok(await doc.save());
			}
		});
	}

	test('SAVED_POSITION (4.10): a refused relink, saved, closed, reopened: the panel is on its own processor; a panel with no samples to move is refused silently', async () => {
		const uri = vscode.Uri.file(path.join(dir, 'follow-saved-position.yaml'));
		fs.writeFileSync(uri.fsPath, FOLLOW_CONFIG);
		const file = samplesFile('follow-saved-position.yaml');
		const firstEntry = { label: 'first', selected: 'a', samples: [sample('a', '{"a":1}')] };
		const taken = { label: 'taken', selected: null, samples: [sample('t')] };
		const used = { label: 'used', selected: null, samples: [sample('u')] };
		fs.writeFileSync(file, JSON.stringify({ version: 1, mappings: [firstEntry, taken, used] }));
		// Opened as a user would, so that closing its editor closes it; in a diff editor (4.17): the file has no text tab,
		// so its panels outlive the document's close.
		const left = vscode.Uri.file(path.join(dir, 'follow-saved-position.left.txt'));
		fs.writeFileSync(left.fsPath, '');
		const showDiff = () => vscode.commands.executeCommand('vscode.diff', left, uri, 'diff', { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
		const opened = async () => {
			await showDiff();
			let found: vscode.TextDocument | undefined;
			assert.ok(await waitFor(() => (found = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())) !== undefined, 5_000));
			assert.ok(await waitFor(() => api().detection.has(uri), 5_000));
			return found!;
		};
		let doc = await opened();
		const { panels, shown } = labelPanels();
		try {
			const handle = (await panels.show(doc.uri, P(0)))!;
			await handle.receive({ type: 'ready' });
			const mutation = (await panels.show(doc.uri, P(2)))!;
			await mutation.receive({ type: 'ready' });
			// P(0)'s label becomes `taken`, P(1) gets `first`, the mutation gets `used`; saved.
			const i = doc.getText().indexOf('label: first') + 'label: '.length;
			await replace(doc, i, i + 'first'.length, 'taken');
			await insert(doc, doc.getText().indexOf('mapping: |'), 'label: first\n      ');
			await insert(doc, doc.getText().indexOf('mutation: root.d'), 'label: used\n      ');
			assert.ok(await waitFor(() => handle.panel.title === 'Bloblang: taken' && mutation.panel.title === 'Bloblang: used', 5_000));
			assert.ok(await doc.save());
			assert.ok(await waitFor(() => shown.length > 0, 5_000), 'the error is shown');
			await settle();
			assert.deepStrictEqual(shown, [[couldNotMoveSamples('taken', SAMPLES_USE_IT), 'error']], 'only for the panel with samples to move');
			assert.deepStrictEqual(readSamples(file).mappings, [firstEntry, taken, used]);
			// Closed (no unsaved changes) and reopened: still on its own processor, not the one now labelled `first`.
			await showDiff();
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			assert.ok(await waitFor(() => !vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString()), 20_000), 'the document closed');
			doc = await opened();
			await settle();
			assert.deepStrictEqual([handle.path, handle.removed, handle.panel.title], [P(0), false, 'Bloblang: taken']);
			assert.deepStrictEqual([mutation.path, mutation.removed], [P(2), false]);
			assert.strictEqual((await run(handle, '{"a":1}')).result.kind, 'ok');
			assert.ok(lastRun().config.includes('root.b = this.a + 1'), lastRun().config);
		} finally {
			panels.dispose();
			await setText(doc, FOLLOW_CONFIG);
			assert.ok(await doc.save());
		}
	});

	// Ticket 4.17: the panel closes with its file's last tab, follows a rename (with its samples file),
	// and opens in one test group below the graph.
	const textTabs = (uri: vscode.Uri) => vscode.window.tabGroups.all.flatMap((g) => g.tabs)
		.filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
	const groupAt = (column: vscode.ViewColumn | undefined) => vscode.window.tabGroups.all.find((g) => g.viewColumn === column);
	/** Whether the group in `column` holds webviews of `viewType` and nothing else. */
	const holdsOnly = (column: vscode.ViewColumn | undefined, viewType: string) => {
		const group = groupAt(column);
		return group !== undefined && group.tabs.length > 0
			&& group.tabs.every((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith(viewType));
	};
	/** Whether `handle`'s panel was disposed, from now on. */
	const disposal = (handle: BloblangPanelHandle) => {
		let gone = false;
		handle.panel.onDidDispose(() => (gone = true));
		return () => gone;
	};
	async function renameFile(from: vscode.Uri, to: vscode.Uri, options?: { overwrite?: boolean }): Promise<void> {
		const edit = new vscode.WorkspaceEdit();
		edit.renameFile(from, to, options);
		assert.ok(await vscode.workspace.applyEdit(edit), 'the rename applied');
	}
	/** The editor layout: top-level groups left to right, each with the groups it is split into. */
	const layout = async () => (await vscode.commands.executeCommand<{ groups: { groups?: unknown[] }[] }>('vscode.getEditorLayout')).groups;
	const snapshots = (handle: BloblangPanelHandle) => handle.posted.filter((m) => m.type === 'snapshot').length;

	test('TAB_CLOSE (4.17): the file in two groups: closing one tab keeps the panel; closing the last closes it and its hint', async () => {
		const doc = (await open('tab-close.yaml', ERRORS_CONFIG)).document;
		const handle = await show(doc.uri, 'pipeline.processors[1]');
		const gone = disposal(handle);
		assert.strictEqual((await run(handle, '{"a":1}')).result.kind, 'failed');
		assert.strictEqual(api().bloblangPanels.hintRanges(doc.uri).length, 1, 'the hint is shown');
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Three, preview: false });
		assert.ok(await waitFor(() => textTabs(doc.uri).length === 2, 10_000));
		await vscode.window.tabGroups.close(textTabs(doc.uri)[1]);
		await settle();
		assert.strictEqual(api().bloblangPanels.panelFor(doc.uri, 'pipeline.processors[1]'), handle, 'one tab left: the panel stays');
		assert.ok(!gone());
		await vscode.window.tabGroups.close(textTabs(doc.uri)[0]);
		assert.ok(await waitFor(() => gone(), 10_000), 'the panel closed with the last tab');
		assert.strictEqual(api().bloblangPanels.panelFor(doc.uri, 'pipeline.processors[1]'), undefined);
		assert.deepStrictEqual(api().bloblangPanels.hintRanges(doc.uri), [], 'its hint is gone');
	});

	test('RENAME (4.17): the same panel under the new name, its snapshot names the new files, the samples file moved and still shown', async () => {
		const entry = { label: 'first', selected: 'one', samples: [sample('one', '{"a":1}')] };
		fs.writeFileSync(samplesFile('rename-a.yaml'), JSON.stringify({ version: 1, mappings: [entry] }));
		const doc = (await open('rename-a.yaml', CONFIG)).document;
		const handle = await show(doc.uri, FIRST);
		const gone = disposal(handle);
		await handle.receive({ type: 'ready' });
		assert.deepStrictEqual([lastSnapshot(handle)?.fileName, lastSnapshot(handle)?.samples], ['rename-a.yaml', entry.samples]);
		const to = vscode.Uri.file(path.join(dir, 'rename-b.yaml'));
		await renameFile(doc.uri, to);
		assert.ok(await waitFor(() => api().bloblangPanels.panelFor(to, FIRST) === handle, 10_000), 'the panel is keyed by the new URI');
		assert.strictEqual(api().bloblangPanels.panelFor(doc.uri, FIRST), undefined);
		assert.strictEqual(handle.uri.toString(), to.toString());
		assert.ok(await waitFor(() => lastSnapshot(handle)?.fileName === 'rename-b.yaml', 10_000), JSON.stringify(lastSnapshot(handle)));
		assert.deepStrictEqual([lastSnapshot(handle)?.samplesFile, lastSnapshot(handle)?.samples, lastSnapshot(handle)?.selected],
			['rename-b.samples.json', entry.samples, 'one']);
		assert.ok(!fs.existsSync(samplesFile('rename-a.yaml')), 'the old samples file is gone');
		assert.deepStrictEqual(readSamples(samplesFile('rename-b.yaml')).mappings, [entry]);
		await settle();
		assert.ok(!gone(), 'the rename did not close the panel');
		assert.strictEqual(handle.panel.title, 'Bloblang: first');
		assert.strictEqual((await run(handle, '{"a":1}')).result.kind, 'ok');
		// A sample change goes to the new file.
		await handle.receive({ type: 'sampleAdded', name: 'two' });
		await samplesRead(samplesFile('rename-b.yaml'), [{ ...entry, selected: 'two', samples: [...entry.samples, sample('two')] }]);
		assert.ok(!fs.existsSync(samplesFile('rename-a.yaml')));
	});

	test('RENAME_NEVER (4.13): a rename announced and never reported blocks the tab close until it expires; then the last tab closes the panel', async () => {
		const limit = 3_000;
		// A registry of the test's own hears the test's announcement; VS Code reports nothing for it.
		const will = new vscode.EventEmitter<vscode.FileWillRenameEvent>();
		const workspace = vscode.workspace as { onWillRenameFiles: unknown };
		const original = workspace.onWillRenameFiles;
		workspace.onWillRenameFiles = will.event;
		let panels: BloblangPanels;
		try {
			panels = new BloblangPanels({
				extensionUri: vscode.extensions.getExtension(EXTENSION_ID)!.extensionUri,
				log: () => undefined,
				binary: api().redpandaConnect,
				actions: undefined,
				storageDir: path.join(dir, 'storage'),
				detection: api().detection,
				pendingRenameMs: limit,
			});
		} finally {
			workspace.onWillRenameFiles = original;
		}
		try {
			const doc = (await open('rename-never.yaml', CONFIG)).document;
			const handle = (await panels.show(doc.uri, FIRST))!;
			assert.ok(handle);
			const gone = disposal(handle);
			will.fire({
				files: [{ oldUri: doc.uri, newUri: vscode.Uri.file(path.join(dir, 'rename-never-b.yaml')) }],
				waitUntil: () => undefined,
				token: new vscode.CancellationTokenSource().token,
			} as vscode.FileWillRenameEvent);
			const announced = Date.now();
			// Before the time limit: the last tab's close is no close.
			await vscode.window.tabGroups.close(textTabs(doc.uri)[0]);
			await settle();
			assert.ok(!gone(), 'the pending rename keeps the panel');
			assert.ok(Date.now() - announced < limit, 'the control ran before the time limit');
			await vscode.window.showTextDocument(doc.uri, { viewColumn: vscode.ViewColumn.One, preview: false });
			assert.ok(await waitFor(() => textTabs(doc.uri).length === 1, 10_000));
			// Past the time limit, the rename no longer counts.
			assert.ok(await waitFor(() => Date.now() - announced >= limit + 100, limit + 1_000));
			await vscode.window.tabGroups.close(textTabs(doc.uri)[0]);
			assert.ok(await waitFor(() => gone(), 10_000), 'the panel closed with its last tab');
			assert.strictEqual(panels.panelFor(doc.uri, FIRST), undefined);
		} finally {
			panels.dispose();
			will.dispose();
		}
	});

	test('RENAME_DIRTY + AI-7 (4.17): a rename with unsaved edits above the processor keeps the panel on it; the save then moves its samples', async () => {
		const pathEntry = { path: UNLABELLED, selected: null, samples: [sample('x')] };
		fs.writeFileSync(samplesFile('rename-dirty.yaml'), JSON.stringify({ version: 1, mappings: [pathEntry] }));
		const doc = (await open('rename-dirty.yaml', CONFIG)).document;
		const handle = await show(doc.uri, UNLABELLED);
		const gone = disposal(handle);
		await handle.receive({ type: 'ready' });
		await insert(doc, lineOf(doc, '    - label: first'), '    - mapping: root.new = 0\n');
		assert.ok(await waitFor(() => handle.path === P(3), 5_000), handle.path);
		assert.ok(doc.isDirty);
		const to = vscode.Uri.file(path.join(dir, 'rename-dirty-b.yaml'));
		await renameFile(doc.uri, to);
		assert.ok(await waitFor(() => api().bloblangPanels.panelFor(to, P(3)) === handle, 10_000), `the panel follows: ${handle.path}`);
		await settle();
		assert.deepStrictEqual([handle.path, handle.removed, gone()], [P(3), false, false], 'not reset to its saved path');
		const renamed = vscode.workspace.textDocuments.find((d) => d.uri.toString() === to.toString());
		assert.ok(renamed?.isDirty, 'the renamed document keeps the edits');
		assert.ok(await waitFor(() => lastSnapshot(handle)?.fileName === 'rename-dirty-b.yaml', 10_000));
		assert.deepStrictEqual(lastSnapshot(handle)?.samples, pathEntry.samples);
		// AI-7: saved, the samples move to the processor's new path in the new samples file.
		assert.ok(await renamed.save());
		await samplesRead(samplesFile('rename-dirty-b.yaml'), [{ ...pathEntry, path: P(3) }]);
		assert.ok(await waitFor(() => lastSnapshot(handle)?.unlabelledPath === P(3), 5_000), 'the relinked samples are shown');
		assert.strictEqual((await run(handle, '{"a":1}')).result.kind, 'failed');
		assert.ok(lastRun().config.includes('FAIL_ME'), lastRun().config);
	});

	test('RENAME_FOLDER (4.17): the config\'s folder renamed: the panel follows; its samples file moved with the folder', async () => {
		const entry = { label: 'first', selected: null, samples: [sample('f')] };
		fs.mkdirSync(path.join(dir, 'rename-folder'));
		fs.writeFileSync(path.join(dir, 'rename-folder', 'cfg.samples.json'), JSON.stringify({ version: 1, mappings: [entry] }));
		const doc = (await open(path.join('rename-folder', 'cfg.yaml'), CONFIG)).document;
		const handle = await show(doc.uri, FIRST);
		const gone = disposal(handle);
		await handle.receive({ type: 'ready' });
		const before = snapshots(handle);
		const folder = vscode.Uri.file(path.join(dir, 'rename-folder-moved'));
		await renameFile(vscode.Uri.file(path.join(dir, 'rename-folder')), folder);
		const to = vscode.Uri.joinPath(folder, 'cfg.yaml');
		assert.ok(await waitFor(() => api().bloblangPanels.panelFor(to, FIRST) === handle, 10_000), 'the panel follows the folder');
		assert.ok(await waitFor(() => snapshots(handle) > before, 10_000), 'a new snapshot');
		assert.deepStrictEqual([lastSnapshot(handle)?.fileName, lastSnapshot(handle)?.samplesFile, lastSnapshot(handle)?.samples],
			['cfg.yaml', 'cfg.samples.json', entry.samples]);
		assert.deepStrictEqual(readSamples(path.join(folder.fsPath, 'cfg.samples.json')).mappings, [entry]);
		await settle();
		assert.ok(!gone(), 'the rename did not close the panel');
	});

	test('RENAME_TARGET_EXISTS (4.17): the new samples file exists: both are left, the user is told, the panel shows the new one', async () => {
		const mine = { label: 'first', selected: null, samples: [sample('mine')] };
		const theirs = { label: 'first', selected: 'theirs', samples: [sample('theirs', '{"t":1}')] };
		fs.writeFileSync(samplesFile('target-a.yaml'), JSON.stringify({ version: 1, mappings: [mine] }));
		fs.writeFileSync(samplesFile('target-b.yaml'), JSON.stringify({ version: 1, mappings: [theirs] }));
		const doc = (await open('target-a.yaml', CONFIG)).document;
		const shown: [string, string | undefined][] = [];
		const { panels } = testBloblangPanels(undefined, undefined, (message, kind) => shown.push([message, kind]));
		try {
			const handle = (await panels.show(doc.uri, FIRST))!;
			await handle.receive({ type: 'ready' });
			assert.deepStrictEqual(lastSnapshot(handle)?.samples, mine.samples);
			const to = vscode.Uri.file(path.join(dir, 'target-b.yaml'));
			await renameFile(doc.uri, to);
			assert.ok(await waitFor(() => shown.length > 0, 10_000), 'the user is told');
			assert.deepStrictEqual(shown, [[samplesNotMoved('target-b.samples.json'), 'info']]);
			assert.ok(await waitFor(() => lastSnapshot(handle)?.fileName === 'target-b.yaml', 10_000));
			assert.deepStrictEqual([lastSnapshot(handle)?.samples, lastSnapshot(handle)?.selected], [theirs.samples, 'theirs']);
			assert.deepStrictEqual(readSamples(samplesFile('target-a.yaml')).mappings, [mine]);
			assert.deepStrictEqual(readSamples(samplesFile('target-b.yaml')).mappings, [theirs]);
		} finally {
			panels.dispose();
		}
	});

	test('COLLISION (4.17): renamed onto a file whose same processor has a panel: the incoming panel closes', async () => {
		const one = (await open('collide-1.yaml', CONFIG)).document;
		const two = (await open('collide-2.yaml', CONFIG)).document;
		const incoming = await show(one.uri, FIRST);
		const gone = disposal(incoming);
		const there = await show(two.uri, FIRST);
		assert.notStrictEqual(incoming, there);
		const thereGone = disposal(there);
		await renameFile(one.uri, two.uri, { overwrite: true });
		assert.ok(await waitFor(() => gone(), 10_000), 'the incoming panel closed');
		await settle();
		assert.ok(!thereGone(), 'the panel already there stays');
		assert.strictEqual(api().bloblangPanels.panelFor(two.uri, FIRST), there);
		assert.strictEqual(api().bloblangPanels.panelFor(one.uri, FIRST), undefined);
	});

	test('PLACE_WITH_GRAPH + PLACE_SECOND (4.17): a new group below the graph\'s, holding only test panels; every test panel goes there; focus stays in the YAML', async () => {
		const other = (await open('place-other.yaml', CONFIG)).document;
		const doc = (await open('place-graph.yaml', CONFIG)).document;
		const graph = (await api().graphPanels.show(doc.uri))!;
		await graph.lockSettled;
		assert.ok(await waitFor(() => vscode.window.activeTextEditor?.document === doc, 10_000));
		const first = await show(doc.uri, FIRST);
		assert.ok(await waitFor(() => first.panel.viewColumn !== undefined, 5_000));
		const column = first.panel.viewColumn;
		assert.ok(column !== graph.panel.viewColumn && column !== vscode.ViewColumn.One, `the test panel's group: ${column}`);
		assert.ok(holdsOnly(graph.panel.viewColumn, GRAPH_VIEW_TYPE), 'the graph group holds only graphs');
		assert.ok(holdsOnly(column, BLOBLANG_VIEW_TYPE), 'the test group holds only test panels');
		const groups = await layout();
		assert.strictEqual(groups.length, 2, JSON.stringify(groups));
		assert.strictEqual(groups[1].groups?.length, 2, `the test group is below the graph's: ${JSON.stringify(groups)}`);
		assert.ok(await waitFor(() => vscode.window.activeTextEditor?.document === doc, 10_000), 'focus is back in the YAML');
		assert.strictEqual(vscode.window.tabGroups.activeTabGroup.viewColumn, vscode.ViewColumn.One);

		// PLACE_SECOND: another processor of the file, and another file's.
		const second = await show(doc.uri, NESTED);
		const third = await show(other.uri, FIRST);
		assert.ok(await waitFor(() => second.panel.viewColumn !== undefined && third.panel.viewColumn !== undefined, 5_000));
		assert.deepStrictEqual([second.panel.viewColumn, third.panel.viewColumn], [column, column], 'the same test group');
		assert.strictEqual(vscode.window.tabGroups.all.length, 3);
		assert.ok(holdsOnly(graph.panel.viewColumn, GRAPH_VIEW_TYPE));
		assert.strictEqual(vscode.window.activeTextEditor?.document, doc, 'focus stays in the YAML');
	});

	test('PLACE_GRAPH_LEFT (4.17): A, the graph group, then B: the test group below the graph; focus back to B in its own group', async () => {
		const a = (await open('place-left-a.yaml', CONFIG)).document;
		const graphA = (await api().graphPanels.show(a.uri))!;
		await graphA.lockSettled;
		const b = (await open('place-left-b.yaml', CONFIG, vscode.ViewColumn.Three)).document;
		const graphB = (await api().graphPanels.show(b.uri))!;
		await graphB.lockSettled;
		assert.ok(await waitFor(() => vscode.window.activeTextEditor?.document === b, 10_000));
		assert.deepStrictEqual([graphA.panel.viewColumn, graphB.panel.viewColumn], [vscode.ViewColumn.Two, vscode.ViewColumn.Two], 'one graph group');
		assert.deepStrictEqual(textTabs(b.uri).map((t) => t.group.viewColumn), [vscode.ViewColumn.Three]);
		const handle = await show(b.uri, FIRST);
		assert.ok(await waitFor(() => handle.panel.viewColumn !== undefined, 5_000));
		assert.strictEqual(handle.panel.viewColumn, vscode.ViewColumn.Three, 'the new group, below the graph\'s');
		assert.ok(holdsOnly(handle.panel.viewColumn, BLOBLANG_VIEW_TYPE), 'the test group holds only test panels');
		assert.ok(holdsOnly(vscode.ViewColumn.Two, GRAPH_VIEW_TYPE), 'the graph group holds only graphs');
		assert.ok(await waitFor(() => vscode.window.activeTextEditor?.document === b, 10_000), 'focus is back in B');
		assert.deepStrictEqual(textTabs(b.uri).map((t) => t.group.viewColumn), [vscode.ViewColumn.Four], 'B stays in its own group, alone');
		assert.strictEqual(vscode.window.tabGroups.activeTabGroup.viewColumn, vscode.ViewColumn.Four);
		assert.strictEqual(vscode.window.activeTextEditor?.viewColumn, vscode.ViewColumn.Four);
	});

	test('PLACE_NO_GRAPH + GRAPH_AFTER (4.17): beside the YAML with no graph; a graph opened later goes into a new locked group above the test group', async () => {
		const doc = (await open('place-none.yaml', CONFIG)).document;
		const handle = await show(doc.uri, FIRST);
		assert.ok(await waitFor(() => handle.panel.viewColumn === vscode.ViewColumn.Two, 5_000), `beside: ${handle.panel.viewColumn}`);
		assert.strictEqual(vscode.window.tabGroups.all.length, 2);
		assert.strictEqual(vscode.window.activeTextEditor?.document, doc);

		// GRAPH_AFTER
		const lines = api().outputLines().length;
		const graph = (await api().graphPanels.show(doc.uri))!;
		await graph.lockSettled;
		assert.ok(await waitFor(() => graph.panel.viewColumn !== undefined && handle.panel.viewColumn !== undefined, 5_000));
		assert.notStrictEqual(graph.panel.viewColumn, handle.panel.viewColumn, 'the graph is not in the test group');
		assert.ok(holdsOnly(graph.panel.viewColumn, GRAPH_VIEW_TYPE), 'the graph group holds only graphs');
		assert.ok(holdsOnly(handle.panel.viewColumn, BLOBLANG_VIEW_TYPE), 'the test group holds only test panels');
		assert.ok(graph.panel.viewColumn! < handle.panel.viewColumn!, 'the graph is above');
		const groups = await layout();
		assert.strictEqual(groups[1]?.groups?.length, 2, `the graph's group is above the test group: ${JSON.stringify(groups)}`);
		assert.ok(await waitFor(() => vscode.window.activeTextEditor?.document === doc, 10_000), 'focus is back in the YAML');
		assert.ok(!api().outputLines().slice(lines).some((l) => /not locked|could not (lock|return focus)|could not open a group/.test(l)),
			api().outputLines().slice(lines).join(' | '));
		// Locked: with the graph active, a file opened with no column does not go into its group.
		graph.panel.reveal(undefined, false);
		assert.ok(await waitFor(() => graph.panel.active, 10_000), 'the graph is active');
		const notes = vscode.Uri.file(path.join(dir, 'place-notes.txt'));
		fs.writeFileSync(notes.fsPath, 'notes\n');
		await vscode.commands.executeCommand('vscode.open', notes);
		assert.ok(await waitFor(() => textTabs(notes).length > 0, 10_000));
		assert.ok(holdsOnly(graph.panel.viewColumn, GRAPH_VIEW_TYPE), 'the graph group is locked');
	});

	// From previous step (4.18).
	const PREVIOUS_CONFIG = [
		'input:',
		'  stdin: {}',
		'pipeline:',
		'  processors:',
		'    - label: seed',
		'      mapping: meta x = "y"',
		'    - label: plain',
		'      mapping: root.c = 4',
		'    - label: tail',
		'      mapping: root = this',
		'    - log:',
		'        message: hi',
		'    - mapping: root = this',
		'    - try:',
		'        - mapping: root.t = 1',
		'        - mapping: root.u = 2',
		'    - switch:',
		'        - check: this.a > 0',
		'          processors:',
		'            - label: case_a',
		'              mapping: root.s = 1',
		'            - mapping: root.s = 2',
		'    - label: gone',
		'      mapping: root = deleted()',
		'    - label: after_gone',
		'      mapping: root = this',
		'    - label: broken',
		'      mapping: root.b = this.nope.or("FAIL_ME")',
		'    - label: after_broken',
		'      mapping: root = this',
		'    - label: slow',
		'      mapping: root.s = "SLOW_RUN"',
		'    - label: after_slow',
		'      mapping: root = this',
		'processor_resources:',
		'  - label: res_a',
		'    mapping: root = this',
		'  - label: res_b',
		'    mapping: root = this',
		'output:',
		'  stdout: {}',
		'',
	].join('\n');
	const AT = (i: number) => `pipeline.processors[${i}]`;
	const TRY_1 = 'pipeline.processors[5].try[1]';
	const TRY_0 = 'pipeline.processors[5].try[0]';
	const CASE_1 = 'pipeline.processors[6].switch[0].processors[1]';
	/** A samples file with one selected sample `s` per link (a label, or a path starting `pipeline.`). */
	const writeSamples = (name: string, links: Record<string, string>) => fs.writeFileSync(samplesFile(name), JSON.stringify({
		version: 1,
		mappings: Object.entries(links).map(([link, content]) => ({
			...(link.startsWith('pipeline.') ? { path: link } : { label: link }), selected: 's', samples: [sample('s', content)],
		})),
	}));
	/** The entry of `link` in the samples file beside `name`. */
	const entryOf = (name: string, link: string) => (readSamples(samplesFile(name)).mappings as { label?: string; path?: string; samples: unknown[] }[])
		.find((m) => m.label === link || (m.label === undefined && m.path === link));
	/**
	 * A test BloblangPanels recording what it shows and the Bloblang of each run (`ran`), on `run`, else
	 * on the real runner (the fake binary). The real webview runs a sample the host posts, so a run of
	 * the panel's own Bloblang may follow: `stepRuns` leaves those out.
	 */
	function previousPanels(run: MappingTestRunner = runMappingTest) {
		const shown: [string, string | undefined][] = [];
		const ran: string[] = [];
		const recording: MappingTestRunner = (state, kind, source, ...rest) => {
			ran.push(source);
			return run(state, kind, source, ...rest);
		};
		const { panels } = testBloblangPanels(undefined, async () => true, (message, kind) => shown.push([message, kind]), undefined, recording);
		const stepRuns = (from: number, own: string) => ran.slice(from).filter((source) => source !== own);
		return { panels, shown, ran, stepRuns };
	}
	async function readyPanel(panels: BloblangPanels, uri: vscode.Uri, processorPath: string): Promise<BloblangPanelHandle> {
		const handle = (await panels.show(uri, processorPath))!;
		assert.ok(handle, `no panel for ${processorPath}`);
		await handle.receive({ type: 'ready' });
		return handle;
	}

	test('SEED + NAME_TAKEN + CHAIN (4.18): the previous step\'s output becomes a selected sample "from <step>", saved and posted; a chain runs in order', async () => {
		const doc = (await open('previous.yaml', PREVIOUS_CONFIG)).document;
		writeSamples('previous.yaml', { seed: '{"a":1}' });
		const { panels, shown, ran, stepRuns } = previousPanels();
		try {
			// SEED: [0] has a selected sample, the panel is on [1].
			const plain = await readyPanel(panels, doc.uri, AT(1));
			assert.strictEqual(lastSnapshot(plain)?.previousStep, 'seed');
			const before = ran.length;
			await plain.receive({ type: 'sampleFromPreviousRequested' });
			assert.deepStrictEqual(stepRuns(before, 'root.c = 4'), ['meta x = "y"'], 'one run: the previous step');
			const fromSeed = sample('from seed', '{"b":2}', { x: 'y' });
			assert.deepStrictEqual(entryOf('previous.yaml', 'plain'), { label: 'plain', selected: 'from seed', samples: [fromSeed] });
			assert.deepStrictEqual(samplesMessages(plain).at(-1), { type: 'samples', samples: [fromSeed], selected: 'from seed' });
			assert.deepStrictEqual(results(plain), [], 'the panel\'s own run loop posts nothing');
			assert.deepStrictEqual(entryOf('previous.yaml', 'seed'), { label: 'seed', selected: 's', samples: [sample('s', '{"a":1}')] }, 'the seed entry is unchanged');

			// NAME_TAKEN
			await plain.receive({ type: 'sampleFromPreviousRequested' });
			assert.deepStrictEqual(entryOf('previous.yaml', 'plain'), {
				label: 'plain', selected: 'from seed 2', samples: [fromSeed, { ...fromSeed, name: 'from seed 2' }],
			});
			plain.panel.dispose();

			// CHAIN: [0] has a sample, [1] none (a fresh file), the panel on [2]: [0] then [1], [1]'s output saved.
			writeSamples('previous.yaml', { seed: '{"a":1}' });
			const tail = await readyPanel(panels, doc.uri, AT(2));
			assert.strictEqual(lastSnapshot(tail)?.previousStep, 'plain');
			const start = ran.length;
			await tail.receive({ type: 'sampleFromPreviousRequested' });
			assert.deepStrictEqual(stepRuns(start, 'root = this'), ['meta x = "y"', 'root.c = 4'], 'two runs: seed, then plain');
			// plain's output content, with the metadata seed set (carried into plain's input).
			assert.deepStrictEqual(entryOf('previous.yaml', 'tail'), {
				label: 'tail', selected: 'from plain', samples: [sample('from plain', '{"a":1,"b":3,"c":4}', { x: 'y' })],
			});
			assert.deepStrictEqual(shown, []);
		} finally {
			panels.dispose();
		}
	});

	test('DELETED + FAILED + NO_SAMPLE (4.18): nothing is saved, and the message names the step', async () => {
		const doc = (await open('previous-errors.yaml', PREVIOUS_CONFIG)).document;
		writeSamples('previous-errors.yaml', { gone: '{"a":1}', broken: '{"a":1}' });
		const bytes = () => fs.readFileSync(samplesFile('previous-errors.yaml'), 'utf8');
		const { panels, shown, ran, stepRuns } = previousPanels();
		try {
			const saved = bytes();
			const afterGone = await readyPanel(panels, doc.uri, AT(8));
			assert.strictEqual(lastSnapshot(afterGone)?.previousStep, 'gone');
			await afterGone.receive({ type: 'sampleFromPreviousRequested' });
			assert.deepStrictEqual(shown.at(-1), [previousDeleted('gone'), 'error']);
			assert.strictEqual(previousDeleted('gone'), '"gone" deleted the message; no sample was saved.');

			const afterBroken = await readyPanel(panels, doc.uri, AT(10));
			await afterBroken.receive({ type: 'sampleFromPreviousRequested' });
			const [message, kind] = shown.at(-1)!;
			assert.strictEqual(kind, 'error');
			assert.ok(message.startsWith('"broken" failed: ') && message.includes('fake failure'), message);
			assert.strictEqual(previousFailed('broken', 'm'), '"broken" failed: m');
			assert.strictEqual(bytes(), saved, 'nothing saved');
			assert.deepStrictEqual([...samplesMessages(afterGone), ...samplesMessages(afterBroken)], []);

			// NO_SAMPLE: no step of the chain has a sample.
			const plain = await readyPanel(panels, doc.uri, AT(1));
			const before = ran.length;
			await plain.receive({ type: 'sampleFromPreviousRequested' });
			assert.deepStrictEqual(shown.at(-1), [previousHasNoSample('seed'), 'info']);
			assert.strictEqual(previousHasNoSample('seed'), '"seed" has no sample to run.');
			assert.deepStrictEqual(stepRuns(before, 'root.c = 4'), [], 'nothing runs');
			assert.strictEqual(bytes(), saved, 'nothing saved');
		} finally {
			panels.dispose();
		}
	});

	test('NO_PREVIOUS + NESTED + UPDATES (4.18): no previousStep for a first item, after another kind or for a resource; nested lists only; it follows edits', async () => {
		const doc = (await open('previous-nested.yaml', PREVIOUS_CONFIG)).document;
		writeSamples('previous-nested.yaml', { [AT(4)]: '{"a":1}' });
		const { panels, shown } = previousPanels();
		try {
			// NO_PREVIOUS
			for (const at of [AT(0), AT(4), 'processor_resources[1]', TRY_0]) {
				const handle = await readyPanel(panels, doc.uri, at);
				assert.ok(lastSnapshot(handle) && !('previousStep' in lastSnapshot(handle)!), `${at}: ${JSON.stringify(lastSnapshot(handle))}`);
				const before = handle.posted.length;
				await handle.receive({ type: 'sampleFromPreviousRequested' });
				assert.strictEqual(handle.posted.at(-1)?.type, 'snapshot', `${at}: the panel's state goes back`);
				assert.ok(handle.posted.length === before + 1);
			}
			assert.deepStrictEqual(shown, []);

			// NESTED: the try: list's own previous step only (AT(4), outside it, has a sample).
			const inTry = await readyPanel(panels, doc.uri, TRY_1);
			assert.strictEqual(lastSnapshot(inTry)?.previousStep, TRY_0);
			await inTry.receive({ type: 'sampleFromPreviousRequested' });
			assert.deepStrictEqual(shown.at(-1), [previousHasNoSample(TRY_0), 'info']);
			writeSamples('previous-nested.yaml', { [AT(4)]: '{"a":1}', [TRY_0]: '{"a":1}' });
			await inTry.receive({ type: 'sampleFromPreviousRequested' });
			assert.deepStrictEqual(entryOf('previous-nested.yaml', TRY_1), {
				path: TRY_1, selected: `from ${TRY_0}`, samples: [sample(`from ${TRY_0}`, '{"b":2}')],
			});
			const inCase = await readyPanel(panels, doc.uri, CASE_1);
			assert.strictEqual(lastSnapshot(inCase)?.previousStep, 'case_a');

			// UPDATES: a renamed previous step, then one of another kind.
			const plain = await readyPanel(panels, doc.uri, AT(1));
			await setText(doc, PREVIOUS_CONFIG.replace('label: seed\n', 'label: seed2\n'));
			assert.ok(await waitFor(() => lastSnapshot(plain)?.previousStep === 'seed2', 5_000), JSON.stringify(lastSnapshot(plain)));
			await setText(doc, PREVIOUS_CONFIG.replace('label: seed\n      mapping: meta x = "y"\n', 'label: seed\n      log:\n        message: x\n'));
			assert.ok(await waitFor(() => lastSnapshot(plain) !== undefined && lastSnapshot(plain)!.previousStep === undefined, 5_000), JSON.stringify(lastSnapshot(plain)));
		} finally {
			panels.dispose();
			await setText(doc, PREVIOUS_CONFIG);
			assert.ok(await doc.save());
		}
	});

	test('BUSY (4.18): a second request while one runs is ignored', async () => {
		const doc = (await open('previous-busy.yaml', PREVIOUS_CONFIG)).document;
		writeSamples('previous-busy.yaml', { slow: '{"a":1}' });
		const { panels, ran, stepRuns } = previousPanels();
		try {
			const handle = await readyPanel(panels, doc.uri, AT(12));
			assert.strictEqual(lastSnapshot(handle)?.previousStep, 'slow');
			const before = ran.length;
			const first = handle.receive({ type: 'sampleFromPreviousRequested' });
			const second = handle.receive({ type: 'sampleFromPreviousRequested' });
			await Promise.all([first, second]);
			const slow = 'root.s = "SLOW_RUN"';
			assert.deepStrictEqual(stepRuns(before, 'root = this'), [slow], 'one run');
			assert.deepStrictEqual(entryOf('previous-busy.yaml', 'after_slow')?.samples, [sample('from slow', '{"b":2}')]);
			// Once it is done, another request runs again.
			await handle.receive({ type: 'sampleFromPreviousRequested' });
			assert.deepStrictEqual(stepRuns(before, 'root = this'), [slow, slow]);
		} finally {
			panels.dispose();
		}
	});

	test('META + CHAIN_INPUT (4.18): non-string output metadata is saved as JSON text; each step gets the previous output', async () => {
		const doc = (await open('previous-meta.yaml', PREVIOUS_CONFIG)).document;
		writeSamples('previous-meta.yaml', { seed: '{"a":1}' });
		const calls: [string, string, Record<string, string>][] = [];
		const run: MappingTestRunner = async (_state, _kind, source, content, meta) => {
			if (source !== 'root = this') {
				// Not the panel's own runs (the real webview runs the sample it is sent).
				calls.push([source, content, { ...meta }]);
			}
			return {
				result: {
					kind: 'ok', content: `${content}+`, meta: { ...meta, [`n${calls.length}`]: calls.length, o: { p: [1, 'two'] }, s: 'x', z: null },
					changes: { fields: null, meta: { added: [], changed: [], removed: [] } },
				},
				durationMs: 1, binary: null,
			};
		};
		const { panels } = previousPanels(run);
		try {
			const tail = await readyPanel(panels, doc.uri, AT(2));
			await tail.receive({ type: 'sampleFromPreviousRequested' });
			assert.deepStrictEqual(calls, [
				['meta x = "y"', '{"a":1}', {}],
				['root.c = 4', '{"a":1}+', { n1: '1', o: '{"p":[1,"two"]}', s: 'x', z: 'null' }],
			]);
			assert.deepStrictEqual(entryOf('previous-meta.yaml', 'tail')?.samples, [
				sample('from plain', '{"a":1}++', { n1: '1', o: '{"p":[1,"two"]}', s: 'x', z: 'null', n2: '2' }),
			]);
		} finally {
			panels.dispose();
		}
	});

	test('UNSAVED + CHANGED_DURING (4.18): unsaved changes run nothing; an edit during the runs saves nothing; both say why', async () => {
		const doc = (await open('previous-unsaved.yaml', PREVIOUS_CONFIG)).document;
		writeSamples('previous-unsaved.yaml', { seed: '{"a":1}', slow: '{"a":1}' });
		const bytes = () => fs.readFileSync(samplesFile('previous-unsaved.yaml'), 'utf8');
		const saved = bytes();
		const { panels, shown, ran, stepRuns } = previousPanels();
		try {
			const plain = await readyPanel(panels, doc.uri, AT(1));
			const afterSlow = await readyPanel(panels, doc.uri, AT(12));
			// UNSAVED: a processor inserted above; the panel follows plain to [2].
			await setText(doc, PREVIOUS_CONFIG.replace('    - label: seed\n', '    - mapping: root = 0\n    - label: seed\n'));
			assert.ok(doc.isDirty);
			assert.ok(await waitFor(() => plain.path === AT(2), 5_000), plain.path);
			let before = ran.length;
			await plain.receive({ type: 'sampleFromPreviousRequested' });
			assert.deepStrictEqual(shown.at(-1), [saveFirst('previous-unsaved.yaml'), 'info']);
			assert.strictEqual(saveFirst('previous-unsaved.yaml'), 'Save previous-unsaved.yaml first: samples are linked to the saved file.');
			assert.deepStrictEqual(stepRuns(before, 'root.c = 4'), [], 'nothing runs');
			assert.strictEqual(bytes(), saved, 'nothing saved');
			await setText(doc, PREVIOUS_CONFIG);
			assert.ok(await doc.save());

			// CHANGED_DURING: an edit while the slow previous step runs.
			before = ran.length;
			const request = afterSlow.receive({ type: 'sampleFromPreviousRequested' });
			assert.ok(await waitFor(() => stepRuns(before, 'root = this').length === 1, 5_000), 'the slow step runs');
			await setText(doc, `${PREVIOUS_CONFIG}# edited\n`);
			await request;
			assert.deepStrictEqual(shown.at(-1), [PREVIOUS_FILE_CHANGED, 'info']);
			assert.strictEqual(bytes(), saved, 'nothing saved');
		} finally {
			panels.dispose();
			await setText(doc, PREVIOUS_CONFIG);
			assert.ok(await doc.save());
		}
	});

	test('NAME_RACE + UNREADABLE (4.18): a name taken meanwhile is made unique again once, else the error; an unreadable file says so', async () => {
		const doc = (await open('previous-race.yaml', PREVIOUS_CONFIG)).document;
		writeSamples('previous-race.yaml', { seed: '{"a":1}' });
		const { panels, shown } = previousPanels();
		const store = panels.samples;
		const update = store.update.bind(store);
		/** How many more adds a sample of the same name lands just before. */
		let races = 1;
		(store as { update: typeof store.update }).update = async (uri, ref, change) => {
			if (change.type === 'add' && races > 0) {
				races--;
				await update(uri, ref, { type: 'add', sample: sample(change.sample.name, 'other') });
			}
			return update(uri, ref, change);
		};
		try {
			const plain = await readyPanel(panels, doc.uri, AT(1));
			await plain.receive({ type: 'sampleFromPreviousRequested' });
			const fromSeed2 = sample('from seed 2', '{"b":2}', { x: 'y' });
			assert.deepStrictEqual(entryOf('previous-race.yaml', 'plain'), {
				label: 'plain', selected: 'from seed 2', samples: [sample('from seed', 'other'), fromSeed2],
			});
			assert.deepStrictEqual(samplesMessages(plain).at(-1)?.selected, 'from seed 2');
			assert.strictEqual(shown.length, 0);

			// Taken on both tries: nothing of ours is saved, and the error says why.
			races = 2;
			await plain.receive({ type: 'sampleFromPreviousRequested' });
			assert.deepStrictEqual(shown.at(-1), [couldNotSaveSamples(PREVIOUS_NAME_TAKEN), 'error']);
			const names = (entryOf('previous-race.yaml', 'plain')?.samples as { name: string; content: string }[]).map((x) => [x.name, x.content]);
			assert.deepStrictEqual(names, [['from seed', 'other'], ['from seed 2', '{"b":2}'], ['from seed 3', 'other'], ['from seed 4', 'other']]);

			// UNREADABLE
			fs.writeFileSync(samplesFile('previous-race.yaml'), '{');
			await plain.receive({ type: 'sampleFromPreviousRequested' });
			const [message, kind] = shown.at(-1)!;
			assert.strictEqual(kind, 'error');
			assert.ok(message.startsWith('The samples file can\'t be read: '), message);
			assert.strictEqual(samplesUnreadable('r'), 'The samples file can\'t be read: r');
		} finally {
			panels.dispose();
		}
	});
});
