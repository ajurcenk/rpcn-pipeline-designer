// Live Bloblang syntax diagnostics, end to end (ticket 4.5): typing in a mapping, the debounced
// `blobl --file` parse on a fake (`bloblParseBody`: `ERR@<line>:<char>` is a parse error there,
// `UNSET` an unset env var, `SLOW` a 1 s parse), the `Bloblang` collection at 4.3's mapped
// positions, and the boundaries the entry meets: lint on save (2.4) hides its duplicate and keeps
// the rest, and a 4.2 test run still works while a parse is in flight. Ticket 6: the errors mark
// their processors' nodes in the real graph panel (AD-17), seen through its posted `nodeStatus`.
// Ticket 22: a `generate` input's mapping (at `input` and in a broker's `inputs`) too.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TEST_MAPPING_COMMAND, type BloblangPanelHandle } from '../../../adapters/bloblangPanel/panels';
import type { GraphPanelHandle } from '../../../adapters/graphPanel/panels';
import type { NodeStatus, NodeStatusById } from '../../../shared/protocol';
import { BLOBLANG_SOURCE } from '../../../adapters/vscode/bloblangDiagnostics';
import { type ExtensionApi } from '../../../extension';
import { bloblParseBody, connectScript, fixtureBodies, makeTempDir, readCounter, toolPath, writeFakeBinary } from '../../helpers/fakeBinary';
import { live, settle, showGraph } from '../graphHelpers';
import { EXTENSION_ID, runOnEditor, waitFor } from '../helpers';

const ENV_LINE = 'Bloblang parse: failed to replace env vars: required environment variables were not set: [UNSET]';

/** A config with a block, a plain, a nested and a resource mapping. */
const CONFIG = [
	'input:',
	'  stdin: {}',
	'pipeline:',
	'  processors:',
	'    - mapping: |',
	'        root.a = this.a',
	'        root.b = this.b',
	'    - switch:',
	'        - check: this.a > 0',
	'          processors:',
	'            - mutation: root.c = 1',
	'    - mapping: root.d = 1',
	'output:',
	'  stdout: {}',
	'processor_resources:',
	'  - label: res',
	'    mapping: root.e = 1',
	'',
].join('\n');

/** The node ids of CONFIG's processors (ticket 6). */
const SWITCH_ID = 'path:pipeline.processors[1]';
const CASE_ID = `${SWITCH_ID}.switch[0]`;
const MUTATION_ID = `${CASE_ID}.processors[0]`;
const PLAIN_ID = 'path:pipeline.processors[2]';
const RESOURCE_ID = 'res:processor:res';
const MESSAGE = 'expected fake thing';
/** CONFIG with its block mapping labelled `blk`. */
const LABELLED = CONFIG.replace('    - mapping: |', '    - label: blk\n      mapping: |');
const BLOCK_ID = 'label:blk';

/** A config whose input is a `generate` with a block mapping (ticket 22). */
const GENERATE = [
	'input:',
	'  generate:',
	'    interval: 1s',
	'    mapping: |',
	'      root = this.a',
	'      root.b = 1',
	'pipeline:',
	'  processors:',
	'    - mapping: root.d = 1',
	'output:',
	'  stdout: {}',
	'',
].join('\n');
/** The input node (with GENERATE a generate, with BROKER the broker). */
const GENERATE_ID = 'path:input';
/** A broker whose second input is a `generate` with a single-quoted mapping (ticket 22). */
const BROKER = [
	'input:',
	'  broker:',
	'    inputs:',
	'      - stdin: {}',
	'      - generate:',
	'          count: 1',
	`          mapping: 'root = "x"'`,
	'output:',
	'  stdout: {}',
	'',
].join('\n');
const BROKER_CHILD_ID = 'path:input.broker.inputs[1]';

/** A node's status for its own messages; a group's for rolled-up ones. */
const own = (...messages: string[]): NodeStatus => ({ severity: 'error', own: 'error', messages, ownMessages: messages });
const rolled = (...messages: string[]): NodeStatus => ({ severity: 'error', messages });

type Shown = [line: number, start: number, endLine: number, end: number, message: string, severity: vscode.DiagnosticSeverity];

suite('Live Bloblang diagnostics (integration, 4.5)', function () {
	this.timeout(90_000);
	let dir: string;
	let capture: string;
	let counter: string;
	let bin: string;
	const originalPath = process.env.PATH;
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const config = () => vscode.workspace.getConfiguration('redpandaConnect');
	const spawns = () => readCounter(counter).filter((l) => l === 'blobl').length;
	const bloblArgv = () => (fs.existsSync(path.join(capture, 'blobl-argv'))
		? fs.readFileSync(path.join(capture, 'blobl-argv'), 'utf8').split('\n').filter(Boolean) : []);

	const bloblangOf = (uri: vscode.Uri): Shown[] => vscode.languages.getDiagnostics(uri)
		.filter((d) => d.source === BLOBLANG_SOURCE)
		.map((d) => [d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character, d.message, d.severity]);
	const lintOf = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri)
		.filter((d) => d.source === 'Redpanda Connect')
		.map((d) => [d.range.start.line, d.message]);

	async function open(name: string, text: string, detected = true): Promise<vscode.TextEditor> {
		const file = path.join(dir, name);
		fs.writeFileSync(file, text);
		const doc = await vscode.workspace.openTextDocument(file);
		const editor = await vscode.window.showTextDocument(doc);
		if (detected) {
			assert.ok(await waitFor(() => api().detection.isDetected(doc.uri), 5_000));
		}
		await quiet();
		return editor;
	}

	/** Waits until every started parse has finished and none started for 700 ms (longer than the debounce). */
	async function quiet(): Promise<void> {
		let count = api().bloblangDiagnostics.parseCount;
		let since = Date.now();
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 50));
			const now = api().bloblangDiagnostics.parseCount;
			if (now !== count) {
				count = now;
				since = Date.now();
			} else if (Date.now() - since > 700 && api().bloblangDiagnostics.inFlight === 0) {
				return;
			}
		}
		assert.fail('the parses never settled');
	}

	/** Replaces the first `needle` after `after` (a needle's occurrence) with `text`. */
	async function replace(editor: vscode.TextEditor, needle: string, text: string, after = ''): Promise<void> {
		const doc = editor.document;
		const start = doc.getText().indexOf(needle, after ? doc.getText().indexOf(after) : 0);
		assert.ok(start >= 0, `no ${needle}`);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(start + needle.length)), text);
		assert.ok(await vscode.workspace.applyEdit(edit));
	}

	/** The 0-based line and UTF-16 column of `needle` (its `nth` occurrence) in the document. */
	function at(doc: vscode.TextDocument, needle: string, nth = 0): vscode.Position {
		let offset = -1;
		for (let i = 0; i <= nth; i++) {
			offset = doc.getText().indexOf(needle, offset + 1);
		}
		assert.ok(offset >= 0, `no ${needle}`);
		return doc.positionAt(offset);
	}

	/** The `nodeStatus` messages the graph panel posted, in order. */
	const statuses = (handle: GraphPanelHandle): NodeStatusById[] =>
		handle.posted.flatMap((m) => (m.type === 'nodeStatus' ? [m.byId] : []));

	/** Opens the real graph panel of `doc` (once the schema is there) and answers its `ready`. */
	async function graph(doc: vscode.TextDocument): Promise<GraphPanelHandle> {
		assert.ok(await waitFor(() => api().schemaStore.current !== undefined, 15_000), 'a schema for the graph');
		const handle = await showGraph(doc);
		await handle.receive({ type: 'ready' });
		return handle;
	}

	/** The status the webview has: the last `nodeStatus`, or a later snapshot's. */
	const shownStatus = (handle: GraphPanelHandle): NodeStatusById | undefined => handle.posted.flatMap((m) =>
		(m.type === 'nodeStatus' ? [m.byId] : m.type === 'snapshot' ? [m.nodeStatus] : [])).at(-1);

	/** Waits until the status the webview has is `expected`. */
	async function expectStatus(handle: GraphPanelHandle, expected: NodeStatusById, what: string): Promise<void> {
		assert.ok(await waitFor(() => JSON.stringify(shownStatus(handle) ?? {}) === JSON.stringify(expected), 10_000),
			`${what}: ${JSON.stringify(shownStatus(handle))}`);
	}

	const error = (pos: vscode.Position, width = 1): Shown =>
		[pos.line, pos.character, pos.line, pos.character + width, 'expected fake thing', vscode.DiagnosticSeverity.Error];

	suiteSetup(async () => {
		const fixtures = fixtureBodies('4.112.0');
		dir = makeTempDir('rpcn-bloblang-diag-');
		capture = path.join(dir, 'capture');
		fs.mkdirSync(capture);
		counter = path.join(dir, 'counter');
		const blobl = bloblParseBody(capture);
		const grep = toolPath('grep');
		const cut = toolPath('cut');
		// Lint reports the live error's message plus `, got: …` (as real lint does) on every line
		// holding LINTME, another message on the `output:` line, and `nope:` lines.
		const lint = [
			'found=0',
			`for n in $('${grep}' -n 'LINTME' "$last" | '${cut}' -d: -f1); do echo "$last($n,3) expected fake thing, got: x" >&2; found=1; done`,
			`for n in $('${grep}' -n '^output:' "$last" | '${cut}' -d: -f1); do echo "$last($n,1) another finding" >&2; found=1; done`,
			`for n in $('${grep}' -n 'nope:' "$last" | '${cut}' -d: -f1); do echo "$last($n,1) field nope not recognised" >&2; found=1; done`,
			'exit $found',
		].join('\n');
		process.env.PATH = (originalPath ?? '').split(path.delimiter)
			.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
			.join(path.delimiter);
		bin = writeFakeBinary(dir, 'redpanda-connect', connectScript({ version: '4.112.0', ...fixtures, blobl, lint, counterFile: counter }));
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
		await config().update('binaryPath', bin, vscode.ConfigurationTarget.Global);
		assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'ok'
			&& (api().redpandaConnect.state as { path: string }).path === bin, 30_000));
	});

	teardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		assert.ok(await waitFor(() => api().graphPanels.size === 0, 10_000), 'closing the editors disposes the graph panels');
	});

	suiteTeardown(async () => {
		process.env.PATH = originalPath;
		await config().update('binaryPath', undefined, vscode.ConfigurationTarget.Global);
		await config().update('envFile', undefined, vscode.ConfigurationTarget.Global);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('ERROR_SHOWN / FIXED: an error typed in a block mapping shows at the mapped line and column, and clears when fixed', async () => {
		const editor = await open('shown.yaml', CONFIG);
		const doc = editor.document;
		assert.deepStrictEqual(bloblangOf(doc.uri), []);
		await replace(editor, 'root.b = this.b', 'root.b = this.b + ERR@2:17');
		const started = Date.now();
		// Mapping line 2, char 17 is the `+` (`root.b = this.b +`, under an 8-space indent).
		const expected = [error(at(doc, '+ ERR@2:17'))];
		assert.ok(await waitFor(() => JSON.stringify(bloblangOf(doc.uri)) === JSON.stringify(expected), 5_000), JSON.stringify(bloblangOf(doc.uri)));
		assert.ok(Date.now() - started < 2_000, `shown after ${Date.now() - started} ms`);
		assert.deepStrictEqual(bloblangOf(doc.uri), expected);

		await replace(editor, ' + ERR@2:17', '');
		assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 0, 5_000), 'the diagnostic clears once it parses');
	});

	test('BOUNDARY 4.3 / NESTED: a switch case\'s mutation, a processor resource, a double-quoted and an emoji line each at their own position', async () => {
		const text = CONFIG
			.replace('mutation: root.c = 1', 'mutation: root.c = 1 ERR@1:6')
			.replace('mapping: root.e = 1', 'mapping: root.e = 1 ERR@1:8')
			.replace('mapping: root.d = 1', 'mapping: "root.d = \\"x\\" ERR@1:12"')
			.replace('        root.a = this.a', '        root.a = "😀" ERR@1:11');
		const editor = await open('nested.yaml', text);
		const doc = editor.document;
		const expected = [
			// Block line 1 char 11 is the emoji: two UTF-16 units wide.
			error(at(doc, '😀'), 2),
			// Plain: char 6 is the `c` of `root.c`.
			error(at(doc, 'c = 1 ERR')),
			// Double-quoted: decoded `root.d = "x" …`, char 12 is the closing `"`, from its `\"`.
			error(at(doc, '\\"', 1), 1),
			error(at(doc, '= 1 ERR@1:8')),
		];
		assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 4, 5_000), JSON.stringify(bloblangOf(doc.uri)));
		const sorted = (s: Shown[]) => [...s].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		assert.deepStrictEqual(sorted(bloblangOf(doc.uri)), sorted(expected));
	});

	test('TRY_CATCH_FIX (4.12): a mapping directly in try: and a mutation directly in catch: get their diagnostics', async () => {
		const text = [
			'input:',
			'  stdin: {}',
			'pipeline:',
			'  processors:',
			'    - try:',
			'        - mapping: root.t = 1 ERR@1:6',
			'    - catch:',
			'        - mutation: |',
			'            root.c = 2',
			'            root.d = 3 ERR@2:8',
			'output:',
			'  stdout: {}',
			'',
		].join('\n');
		const editor = await open('try-catch.yaml', text);
		const doc = editor.document;
		// Plain in try: char 6 is the `t` of `root.t`; block in catch: line 2 char 8 is its `=`.
		const expected = [error(at(doc, 't = 1 ERR')), error(at(doc, '= 3 ERR'))];
		assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 2, 5_000), JSON.stringify(bloblangOf(doc.uri)));
		const sorted = (s: Shown[]) => [...s].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		assert.deepStrictEqual(sorted(bloblangOf(doc.uri)), sorted(expected));
	});

	test('BURST / UNCHANGED: 10 keystrokes in one mapping run blobl once for it; an edit outside every mapping runs none', async () => {
		const editor = await open('burst.yaml', CONFIG);
		const doc = editor.document;
		const before = { spawns: spawns(), parses: api().bloblangDiagnostics.parseCount };
		const parsed: string[] = [];
		const listener = api().bloblangDiagnostics.onDidParse((t) => parsed.push(t));
		try {
			let changes = 0;
			const counting = vscode.workspace.onDidChangeTextDocument((e) => { changes += e.document === doc && e.contentChanges.length > 0 ? 1 : 0; });
			const started = Date.now();
			const base = doc.getText().indexOf('root.d = 1') + 'root.d = 1'.length;
			// Ten keystrokes; the debounce restarts on each, so only the gaps must stay under 300 ms.
			let gap = 0;
			for (const [i, ch] of [...' + 1234567'].entries()) {
				const sent = Date.now();
				const edit = new vscode.WorkspaceEdit();
				edit.insert(doc.uri, doc.positionAt(base + i), ch);
				assert.ok(await vscode.workspace.applyEdit(edit));
				gap = Math.max(gap, Date.now() - sent);
			}
			counting.dispose();
			assert.strictEqual(changes, 10, 'ten separate changes');
			assert.ok(gap < 300 && Date.now() - started < 3_000, `a keystroke took ${gap} ms`);
			assert.ok(doc.getText().includes('root.d = 1 + 1234567'));
			await quiet();
			assert.deepStrictEqual(parsed, ['root.d = 1 + 1234567']);
			assert.strictEqual(spawns() - before.spawns, 1);

			await replace(editor, 'stdout: {}', 'stdout: { codec: lines }');
			await replace(editor, 'stdin: {}', 'stdin: { }');
			await new Promise((r) => setTimeout(r, 600));
			await quiet();
			assert.deepStrictEqual(parsed, ['root.d = 1 + 1234567'], 'no parse for an edit outside the mappings');
			assert.strictEqual(spawns() - before.spawns, 1);
		} finally {
			listener.dispose();
		}
	});

	test('STALE: a result for text that changed again is dropped; the newer text\'s result is shown', async () => {
		const editor = await open('stale.yaml', CONFIG.replace('mapping: root.d = 1', 'mapping: root.d = 1 SLOW'));
		const doc = editor.document;
		const seen: Shown[][] = [];
		const listener = vscode.languages.onDidChangeDiagnostics((e) => {
			if (e.uris.some((u) => u.toString() === doc.uri.toString())) {
				seen.push(bloblangOf(doc.uri));
			}
		});
		try {
			const argv = bloblArgv().length;
			await replace(editor, 'SLOW', 'SLOW ERR@1:1');
			// The slow parse of the error text has started (the fake logs its argv first).
			assert.ok(await waitFor(() => bloblArgv().length > argv, 5_000));
			await replace(editor, 'SLOW ERR@1:1', 'SLOW ERR@1:5');
			await quiet();
			assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 1, 5_000));
			assert.deepStrictEqual(bloblangOf(doc.uri), [error(at(doc, '.d = 1 SLOW ERR@1:5'))]);
			assert.ok(seen.every((s) => s.every((d) => d[1] === at(doc, '.d = 1 SLOW').character)), `the stale result was shown: ${JSON.stringify(seen)}`);
		} finally {
			listener.dispose();
		}
	});

	test('YAML_BROKEN: a YAML error elsewhere clears the file\'s Bloblang diagnostics; they come back (from the cache) once it parses', async () => {
		const editor = await open('broken.yaml', CONFIG.replace('mapping: root.d = 1', 'mapping: root.d = 1 ERR@1:1'));
		const doc = editor.document;
		assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 1, 5_000));
		const spawned = spawns();
		await replace(editor, 'stdout: {}', 'stdout: { codec: [lines }');
		assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 0, 5_000), 'cleared while the YAML does not parse');
		await replace(editor, 'stdout: { codec: [lines }', 'stdout: {}');
		// Story 18: the edit that fixes the YAML republishes at once, not after the 300 ms debounce.
		assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 1, 150), 'back once it parses, without the debounce');
		await quiet();
		assert.strictEqual(spawns(), spawned, 'unchanged mappings are not parsed again');
	});

	test('ENV_VAR: an unset ${VAR} gives no diagnostic and one log line', async () => {
		const editor = await open('env.yaml', CONFIG.replace('mapping: root.d = 1', 'mapping: root.d = "${UNSET}"'));
		const doc = editor.document;
		assert.ok(await waitFor(() => api().outputLines().includes(ENV_LINE), 5_000));
		await replace(editor, 'root.d = "${UNSET}"', 'root.d = "${UNSET} x"');
		await quiet();
		assert.deepStrictEqual(bloblangOf(doc.uri), []);
		assert.strictEqual(api().outputLines().filter((l) => l === ENV_LINE).length, 1);
	});

	test('LINT_DEDUPE / LINT_KEPT: on save, lint\'s finding inside a mapping with a live error is hidden; the others stay; an edit drops lint\'s finding on its line, not Bloblang', async () => {
		const text = CONFIG
			.replace('mapping: root.d = 1', 'mapping: root.d = 1 ERR@1:1 LINTME')
			.replace('mapping: root.e = 1', 'mapping: root.e = 1 LINTME')
			.replace('  stdin: {}', '  stdin: {}\n  nope: 1');
		const editor = await open('dedupe.yaml', text);
		const doc = editor.document;
		const sorted = () => lintOf(doc.uri).sort((x, y) => Number(x[0]) - Number(y[0]));
		const nope = () => [at(doc, 'nope:').line, 'field nope not recognised'];
		const kept = () => [at(doc, 'root.e = 1').line, 'expected fake thing, got: x'];
		const duplicate = () => [at(doc, 'root.d = 1').line, 'expected fake thing, got: x'];
		// LINT_KEPT: the line after the erroring one-line mapping is in its span, but the message differs.
		const other = () => [at(doc, 'output:').line, 'another finding'];
		const byLine = (rows: unknown[][]) => rows.sort((x, y) => Number(x[0]) - Number(y[0]));
		const expectLint = async (rows: unknown[][], what: string) => assert.ok(
			await waitFor(() => JSON.stringify(sorted()) === JSON.stringify(rows), 15_000), `${what}: ${JSON.stringify(sorted())}`);
		assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 1, 5_000));

		// LINT_DEDUPE: the duplicate inside the mapping with a live error is hidden.
		await replace(editor, 'stdin: {}', 'stdin: { }');
		assert.ok(await doc.save());
		await expectLint(byLine([nope(), other(), kept()]), 'LINT_DEDUPE');
		assert.deepStrictEqual(bloblangOf(doc.uri), [error(at(doc, 'root.d = 1 ERR'))]);

		// LINT_KEPT: with the error fixed, lint's finding there shows as before.
		await replace(editor, 'ERR@1:1 ', '');
		// The edit drops the (hidden) duplicate on its line; the others stay (ticket 10).
		await expectLint(byLine([nope(), other(), kept()]), 'an edit drops only the findings on its lines');
		assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 0, 5_000));
		await quiet();
		assert.ok(await doc.save());
		await expectLint(byLine([nope(), duplicate(), other(), kept()]), 'LINT_KEPT');

		// Saved before the parse answers: lint is re-filtered when the Bloblang diagnostic arrives.
		// (The edit already drops the held duplicate on its line, ticket 10, so wait for the save's lint
		// run and the live error before checking that the fresh duplicate is hidden.)
		const lints = () => readCounter(counter).filter((l) => l === 'lint').length;
		const linted = lints();
		await replace(editor, 'root.d = 1 LINTME', 'root.d = 1 ERR@1:1 LINTME');
		assert.ok(await doc.save());
		assert.ok(await waitFor(() => lints() > linted && bloblangOf(doc.uri).length === 1, 15_000), 'linted, and the live error arrived');
		await quiet();
		await expectLint(byLine([nope(), other(), kept()]), 're-filtered');
		assert.strictEqual(bloblangOf(doc.uri).length, 1);

		// An edit on a finding's line drops that finding, not Bloblang.
		await replace(editor, 'nope: 1', 'nope: 2');
		await expectLint(byLine([other(), kept()]), 'dropped by the edit');
		await quiet();
		assert.strictEqual(bloblangOf(doc.uri).length, 1);
		assert.ok(await doc.save());
	});

	test('CLOSE (undetected): a file that stops being a config loses its Bloblang diagnostics', async () => {
		// Closing is covered by the unit suite: the extension host closes a document long after its tab.
		const editor = await open('undetect.yaml', CONFIG.replace('mapping: root.d = 1', 'mapping: root.d = 1 ERR@1:1'));
		const doc = editor.document;
		assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 1, 5_000));
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
			'name: x\nsteps:\n  processors:\n    - mapping: root.d = 1 ERR@1:1\n');
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.ok(await waitFor(() => !api().detection.isDetected(doc.uri), 5_000));
		assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 0, 5_000));
		await new Promise((r) => setTimeout(r, 600));
		await quiet();
		assert.deepStrictEqual(bloblangOf(doc.uri), []);
		await runOnEditor(doc, 'workbench.action.revertAndCloseActiveEditor');
	});

	test('UNTITLED and non-detected files get none and never spawn', async () => {
		const before = spawns();
		const untitled = await vscode.workspace.openTextDocument({ language: 'yaml', content: CONFIG.replace('root.d = 1', 'root.d = 1 ERR@1:1') });
		await vscode.window.showTextDocument(untitled);
		assert.ok(await waitFor(() => api().detection.isDetected(untitled.uri), 5_000));
		const plain = await open('plain.yaml', 'name: x\nsteps:\n  processors:\n    - mapping: root = 1 ERR@1:1\n', false);
		assert.ok(!api().detection.isDetected(plain.document.uri));
		await new Promise((r) => setTimeout(r, 600));
		await quiet();
		assert.deepStrictEqual(bloblangOf(untitled.uri), []);
		assert.deepStrictEqual(bloblangOf(plain.document.uri), []);
		assert.strictEqual(spawns(), before);
		await runOnEditor(untitled, 'workbench.action.revertAndCloseActiveEditor');
	});

	test('BOUNDARY 4.2: a test run works while a parse is in flight', async () => {
		const editor = await open('panel.yaml', CONFIG);
		const doc = editor.document;
		const handle = await vscode.commands.executeCommand<BloblangPanelHandle | undefined>(TEST_MAPPING_COMMAND, doc.uri, 'pipeline.processors[2]');
		assert.ok(handle);
		const argv = bloblArgv().length;
		await replace(editor, 'root.d = 1', 'root.d = 1 SLOW ERR@1:1 panel');
		assert.ok(await waitFor(() => bloblArgv().length > argv, 5_000), `the slow parse started: ${JSON.stringify(bloblArgv().slice(-2))} ${doc.getText()}`);
		const results = () => handle.posted.filter((m) => m.type === 'result').length;
		const before = results();
		await handle.receive({ type: 'run', content: '{"a":1}', meta: {} });
		assert.strictEqual(results(), before + 1);
		assert.deepStrictEqual(handle.posted.filter((m) => m.type === 'result').pop()?.result, { kind: 'deleted' });
		assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 1, 5_000));
	});

	test('the env file reaches blobl', async () => {
		const envFile = path.join(dir, 'parse.env');
		fs.writeFileSync(envFile, 'FOO=bar\n');
		await config().update('envFile', envFile, vscode.ConfigurationTarget.Global);
		try {
			const editor = await open('envfile.yaml', CONFIG);
			await replace(editor, 'root.d = 1', 'root.d = 2');
			await quiet();
			const last = bloblArgv().pop()!;
			assert.ok(last.startsWith(`blobl --env-file ${envFile} --file `), last);
		} finally {
			await config().update('envFile', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test('GRAPH MARKED / CHURN / CLEARED (ticket 6): a live error marks its labelled block mapping\'s node with the binary\'s message; a move inside it posts nothing; the fix clears it', async () => {
		const editor = await open('graph-marked.yaml', LABELLED);
		const doc = editor.document;
		const handle = await graph(doc);
		await replace(editor, 'root.b = this.b', 'root.b = this.b + ERR@2:17');
		await expectStatus(handle, { [BLOCK_ID]: own(MESSAGE) }, 'MARKED');

		// CHURN: the diagnostic moves within the mapping; the node status stays the same.
		const count = statuses(handle).length;
		await replace(editor, 'ERR@2:17', 'ERR@2:18');
		const moved = [error(at(doc, ' ERR@2:18'))];
		assert.ok(await waitFor(() => JSON.stringify(bloblangOf(doc.uri)) === JSON.stringify(moved), 5_000), JSON.stringify(bloblangOf(doc.uri)));
		await quiet();
		await settle();
		assert.strictEqual(statuses(handle).length, count, 'no new nodeStatus for an unchanged status');

		// CLEARED
		await replace(editor, ' + ERR@2:18', '');
		await expectStatus(handle, {}, 'CLEARED');
	});

	test('GRAPH NESTED / COLLAPSED (ticket 6): a switch case\'s mutation and a processor resource are marked; the case and the switch roll it up', async () => {
		const editor = await open('graph-nested.yaml', CONFIG);
		const doc = editor.document;
		const handle = await graph(doc);
		await replace(editor, 'mutation: root.c = 1', 'mutation: root.c = 1 ERR@1:6');
		await replace(editor, 'mapping: root.e = 1', 'mapping: root.e = 1 ERR@1:8');
		// The switch's roll-up is what its header shows when collapsed (3.8, the webview unchanged).
		await expectStatus(handle, {
			[SWITCH_ID]: rolled(MESSAGE),
			[CASE_ID]: rolled(MESSAGE),
			[MUTATION_ID]: own(MESSAGE),
			[RESOURCE_ID]: own(MESSAGE),
		}, 'NESTED');
	});

	test('GRAPH AT_END (ticket 20): an error past a mapping\'s last character marks its processor: last in its list, nested, last in the file, and on a blank line after a block', async () => {
		const editor = await open('graph-at-end.yaml', LABELLED);
		const doc = editor.document;
		const handle = await graph(doc);
		// Each `root.x = 1 ERR@1:20` is 19 characters: char 20 is just past the mapping's end.
		await replace(editor, 'mapping: root.d = 1', 'mapping: root.d = 1 ERR@1:20');
		await replace(editor, 'mutation: root.c = 1', 'mutation: root.c = 1 ERR@1:20');
		await replace(editor, 'mapping: root.e = 1', 'mapping: root.e = 1 ERR@1:20');
		// The block mapping has two lines: line 3 is past its last.
		await replace(editor, 'root.b = this.b', 'root.b = this.b ERR@3:1');
		assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 4, 5_000), JSON.stringify(bloblangOf(doc.uri)));
		await expectStatus(handle, {
			[BLOCK_ID]: own(MESSAGE),
			[SWITCH_ID]: rolled(MESSAGE),
			[CASE_ID]: rolled(MESSAGE),
			[MUTATION_ID]: own(MESSAGE),
			[PLAIN_ID]: own(MESSAGE),
			[RESOURCE_ID]: own(MESSAGE),
		}, 'AT_END');
	});

	test('GENERATE TOP / FIX (ticket 22): an error in a generate input\'s block mapping is underlined and marks the input\'s node; the fix clears both', async () => {
		const editor = await open('generate-top.yaml', GENERATE);
		const doc = editor.document;
		const handle = await graph(doc);
		assert.deepStrictEqual(bloblangOf(doc.uri), []);
		await replace(editor, 'root.b = 1', 'root.b = 1 +ERR@2:12');
		// Mapping line 2, char 12 is the `+` (`root.b = 1 +`, under a 6-space indent).
		const expected = [error(at(doc, '+ERR@2:12'))];
		assert.ok(await waitFor(() => JSON.stringify(bloblangOf(doc.uri)) === JSON.stringify(expected), 5_000), JSON.stringify(bloblangOf(doc.uri)));
		await expectStatus(handle, { [GENERATE_ID]: own(MESSAGE) }, 'TOP');

		await replace(editor, ' +ERR@2:12', '');
		assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 0, 5_000), 'the diagnostic clears once it parses');
		await expectStatus(handle, {}, 'FIX');

		// AT_END (ticket 20): an error past the mapping's last line marks the input too.
		await replace(editor, 'root.b = 1', 'root.b = 1 ERR@3:1');
		assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 1, 5_000), JSON.stringify(bloblangOf(doc.uri)));
		await expectStatus(handle, { [GENERATE_ID]: own(MESSAGE) }, 'AT_END');
	});

	test('GENERATE BROKER / QUOTED (ticket 22): a broker child\'s single-quoted generate mapping is underlined at its column and marks that child', async () => {
		const editor = await open('generate-broker.yaml', BROKER);
		const doc = editor.document;
		const handle = await graph(doc);
		await replace(editor, `'root = "x"'`, `'root = "x" ERR@1:10'`);
		// Decoded `root = "x" …`: char 10 is the closing `"`.
		const expected = [error(at(doc, '" ERR@1:10'))];
		assert.ok(await waitFor(() => JSON.stringify(bloblangOf(doc.uri)) === JSON.stringify(expected), 5_000), JSON.stringify(bloblangOf(doc.uri)));
		await expectStatus(handle, { [GENERATE_ID]: rolled(MESSAGE), [BROKER_CHILD_ID]: own(MESSAGE) }, 'BROKER');
		await replace(editor, ' ERR@1:10', '');
		await expectStatus(handle, {}, 'FIX');
		assert.deepStrictEqual(bloblangOf(doc.uri), []);
	});

	test('GRAPH FROZEN (ticket 6, story 18): while the YAML does not parse no status is sent and the marker stays; once it parses the status is recomputed and the marker does not blink', async () => {
		const editor = await open('graph-frozen.yaml', CONFIG.replace('mapping: root.d = 1', 'mapping: root.d = 1 ERR@1:1'));
		const doc = editor.document;
		const handle = await graph(doc);
		const marked = { [PLAIN_ID]: own(MESSAGE) };
		await expectStatus(handle, marked, 'marked');
		const brokenYaml = async () => {
			const count = statuses(handle).length;
			await replace(editor, 'stdout: {}', 'stdout: { codec: [lines }');
			assert.ok(await waitFor(() => live(handle).at(-1)?.type === 'parseError', 10_000), 'the banner');
			// 4.5 clears the Bloblang diagnostics while the YAML does not parse.
			assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 0, 5_000));
			await settle();
			assert.strictEqual(statuses(handle).length, count, 'frozen while broken');
			await handle.receive({ type: 'ready' });
			const snapshot = handle.posted.filter((m) => m.type === 'snapshot').at(-1);
			assert.ok(snapshot?.type === 'snapshot' && snapshot.parseError);
			assert.deepStrictEqual(snapshot.nodeStatus, marked, 'the marker stays');
		};
		const fixYaml = () => replace(editor, 'stdout: { codec: [lines }', 'stdout: {}');

		await brokenYaml();
		const beforeFix = statuses(handle).length;
		await fixYaml();
		assert.ok(await waitFor(() => bloblangOf(doc.uri).length === 1, 5_000), 'back once it parses');
		assert.ok(await waitFor(() => live(handle).at(-1)?.type === 'model', 10_000), 'the model is sent again');
		await quiet();
		await settle();
		// Story 18: the model is mapped against the error 4.5 republished in the same change event,
		// so the marker never goes: no other status is posted (the unchanged one is not sent again).
		assert.deepStrictEqual(statuses(handle).slice(beforeFix).filter((s) => JSON.stringify(s) !== JSON.stringify(marked)), [],
			`no blink: ${JSON.stringify(statuses(handle).slice(beforeFix))}`);
		await handle.receive({ type: 'ready' });
		const current = handle.posted.filter((m) => m.type === 'snapshot').at(-1);
		assert.ok(current?.type === 'snapshot' && !current.parseError);
		assert.deepStrictEqual(current.nodeStatus, marked, 'the current status is the marker');

		// Fixed while the YAML is broken: once it parses, the recomputed status is empty.
		await brokenYaml();
		await replace(editor, ' ERR@1:1', '');
		await fixYaml();
		await expectStatus(handle, {}, 'recomputed');
		assert.deepStrictEqual(bloblangOf(doc.uri), []);
	});

	test('GRAPH WITH_LINT (ticket 6): a lint finding and a live error on one processor, saved, give one status with both; lint\'s duplicate stays hidden', async () => {
		const ONE_ID = 'label:one';
		const NOPE = 'field nope not recognised';
		const editor = await open('graph-lint.yaml', CONFIG.replace('    - mapping: root.d = 1',
			'    - label: one\n      mapping: root.d = 1 ERR@1:1 LINTME\n      nope: 1'));
		const doc = editor.document;
		const handle = await graph(doc);
		await expectStatus(handle, { [ONE_ID]: own(MESSAGE) }, 'the live error');
		await replace(editor, 'stdin: {}', 'stdin: { }');
		assert.ok(await doc.save());
		assert.ok(await waitFor(() => (shownStatus(handle)?.[ONE_ID]?.ownMessages?.length ?? 0) === 2, 15_000),
			JSON.stringify(shownStatus(handle)));
		const status = shownStatus(handle)![ONE_ID];
		assert.deepStrictEqual({ ...status, messages: [...status.messages].sort(), ownMessages: [...status.ownMessages!].sort() },
			own(MESSAGE, NOPE));
		assert.ok(!lintOf(doc.uri).some(([, m]) => String(m).startsWith(MESSAGE)), `lint's duplicate is hidden: ${JSON.stringify(lintOf(doc.uri))}`);
	});

	test('NO_BINARY: no diagnostics and no spawn; after Set path they appear', async () => {
		await config().update('binaryPath', path.join(dir, 'gone'), vscode.ConfigurationTarget.Global);
		try {
			assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'missing', 15_000));
			const before = spawns();
			const editor = await open('nobin.yaml', CONFIG.replace('mapping: root.d = 1', 'mapping: root.d = 1 ERR@1:1'));
			const uri = editor.document.uri;
			// Ticket 6: without a binary the graph has no model (3.9 empty state), so there is nothing to mark.
			const handle = await showGraph(editor.document);
			await handle.receive({ type: 'ready' });
			await replace(editor, 'ERR@1:1', 'ERR@1:2');
			await new Promise((r) => setTimeout(r, 600));
			await quiet();
			assert.deepStrictEqual(bloblangOf(uri), []);
			assert.strictEqual(spawns(), before);
			await config().update('binaryPath', bin, vscode.ConfigurationTarget.Global);
			assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'ok', 15_000));
			assert.ok(await waitFor(() => bloblangOf(uri).length === 1, 10_000), 'the diagnostic appears once the binary is found');
			await expectStatus(handle, { [PLAIN_ID]: own(MESSAGE) }, 'the marker appears once the binary is found');
		} finally {
			await config().update('binaryPath', bin, vscode.ConfigurationTarget.Global);
			assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'ok', 15_000));
		}
	});
});
