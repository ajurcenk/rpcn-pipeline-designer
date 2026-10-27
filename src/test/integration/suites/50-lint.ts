import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { type ExtensionApi } from '../../../extension';
import { connectScript, fixtureBodies, makeTempDir, readCounter, toolPath, writeFakeBinary } from '../../helpers/fakeBinary';
import { EXTENSION_ID, focusState, runOnEditor, waitFor } from '../helpers';

suite('Lint on save (integration)', function () {
	this.timeout(90_000);
	let dir: string;
	let counter: string;
	const originalPath = process.env.PATH;
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const config = () => vscode.workspace.getConfiguration('redpandaConnect');

	/** Lint diagnostics (our source only) for `doc`, as `[line, severity, message]`. */
	const lintOf = (doc: vscode.TextDocument) => vscode.languages.getDiagnostics(doc.uri)
		.filter((d) => d.source === 'Redpanda Connect')
		.map((d) => [d.range.start.line + 1, d.severity, d.message]);

	/**
	 * The Quick Fixes at `range` once `want` is among them (ticket 27): VS Code's copy of the
	 * diagnostics, which the request reads, can lag the extension's, so the request repeats until
	 * then (10 s; the last list otherwise, which the caller's assertion shows).
	 */
	async function quickFixes(doc: vscode.TextDocument, range: vscode.Range, want: string): Promise<vscode.CodeAction[]> {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const list = await vscode.commands.executeCommand<vscode.CodeAction[]>(
				'vscode.executeCodeActionProvider', doc.uri, range, vscode.CodeActionKind.QuickFix.value);
			if (list.some((a) => a.title === want) || Date.now() > deadline) {
				return list;
			}
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	/**
	 * Runs `command` (`undo` / `redo`) on `doc` until its text is `text` (ticket 27): VS Code now and
	 * then ignores the command on a busy machine (keyboard focus), and the text arrives after the
	 * command resolves. Up to three tries, 5 s each (a command applied that late is not retried, so
	 * never applied twice); each retry prints the focus state for the log. The number of tries.
	 */
	async function untilText(doc: vscode.TextDocument, command: string, text: string): Promise<number> {
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt > 0) {
				console.log(`[ticket 27] ${command} did not change ${path.basename(doc.uri.fsPath)}; retrying: ${focusState()}`);
			}
			const version = doc.version;
			await runOnEditor(doc, command);
			if (await waitFor(() => doc.getText() === text, 5_000) || doc.version !== version) {
				return attempt + 1;
			}
		}
		return 3;
	}

	async function openSaved(name: string, text: string): Promise<vscode.TextDocument> {
		const file = path.join(dir, name);
		fs.writeFileSync(file, text);
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);
		return doc;
	}

	/** Makes the document dirty with a no-op-looking edit, then saves it. */
	async function editAndSave(doc: vscode.TextDocument, text = '\n'): Promise<void> {
		const edit = new vscode.WorkspaceEdit();
		edit.insert(doc.uri, doc.positionAt(doc.getText().length), text);
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.ok(await doc.save());
	}

	suiteSetup(async () => {
		const fixtures = fixtureBodies('4.112.0'); // absolute tool paths: resolved before PATH is filtered
		const grep = toolPath('grep');
		const cut = toolPath('cut');
		const cat = toolPath('cat');
		process.env.PATH = (originalPath ?? '').split(path.delimiter)
			.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
			.join(path.delimiter);
		dir = makeTempDir('rpcn-lint-');
		counter = path.join(dir, 'counter');
		// Lints like the spike: findings for lines that contain `nope:` or `codec:` in the target.
		const syntaxLine = path.join(dir, 'syntax-line');
		const lint = [
			// For syntax.yaml: a YAML syntax error at (1,1) naming the line in `syntax-line`, like real lint.
			`case "$last" in */syntax.yaml) echo "$last(1,1) yaml: line $('${cat}' '${syntaxLine}'): did not find expected key" >&2; exit 1 ;; esac`,
			'found=0',
			`for n in $('${grep}' -n 'nope:' "$last" | '${cut}' -d: -f1); do echo "$last($n,1) field nope not recognised" >&2; found=1; done`,
			`for n in $('${grep}' -n 'codec:' "$last" | '${cut}' -d: -f1); do echo "$last($n,1) field codec is deprecated" >&2; found=1; done`,
			`for n in $('${grep}' -n 'topci:' "$last" | '${cut}' -d: -f1); do echo "$last($n,1) field topci not recognised" >&2; found=1; done`,
			`for n in $('${grep}' -n 'network: tpc' "$last" | '${cut}' -d: -f1); do echo "$last($n,1) value tpc is not a valid option for this field" >&2; found=1; done`,
			`for n in $('${grep}' -n 'adress:' "$last" | '${cut}' -d: -f1); do echo "$last($n,1) field adress not recognised" >&2; found=1; done`,
			`for n in $('${grep}' -n 'request_mapp:' "$last" | '${cut}' -d: -f1); do echo "$last($n,1) field request_mapp not recognised" >&2; found=1; done`,
			'exit $found',
		].join('\n');
		const bin = writeFakeBinary(dir, 'redpanda-connect', connectScript({ version: '4.112.0', ...fixtures, lint, counterFile: counter }));
		await config().update('binaryPath', bin, vscode.ConfigurationTarget.Global);
		assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'ok'
			&& (api().redpandaConnect.state as { path: string }).path === bin, 30_000), JSON.stringify(api().redpandaConnect.state));
	});

	suiteTeardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		process.env.PATH = originalPath;
		await config().update('binaryPath', undefined, vscode.ConfigurationTarget.Global);
		await config().update('resourceFiles', undefined, vscode.ConfigurationTarget.Global);
		await config().update('env', undefined, vscode.ConfigurationTarget.Global);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('UNKNOWN_FIELD / DEPRECATED / INSERT_ABOVE: save shows Error and Warning on their lines; a line inserted above moves them', async () => {
		const doc = await openSaved('lint.yaml', 'input:\n  generate:\n    mapping: root = {}\n    nope: 1\noutput:\n  file:\n    path: x\n    codec: lines\n');
		assert.ok(api().detection.isDetected(doc.uri));
		await editAndSave(doc);
		assert.ok(await waitFor(() => lintOf(doc).length === 2, 15_000), JSON.stringify(vscode.languages.getDiagnostics(doc.uri).map((d) => [d.source, d.range.start.line, d.message])) + ' runs: ' + readCounter(counter).join(',') + '\n' + api().outputLines().slice(-3).join('\n'));
		assert.deepStrictEqual(lintOf(doc), [
			[4, vscode.DiagnosticSeverity.Error, 'field nope not recognised'],
			[8, vscode.DiagnosticSeverity.Warning, 'field codec is deprecated'],
		]);
		assert.deepStrictEqual(api().lintDiagnostics.diagnosticsFor(doc.uri).filter((d) => d.source === 'Redpanda Connect').length, 2);
		const edit = new vscode.WorkspaceEdit();
		edit.insert(doc.uri, new vscode.Position(0, 0), '# x\n');
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.deepStrictEqual(lintOf(doc), [
			[5, vscode.DiagnosticSeverity.Error, 'field nope not recognised'],
			[9, vscode.DiagnosticSeverity.Warning, 'field codec is deprecated'],
		]);
	});

	test('NOT_DETECTED: saving a non-Redpanda-Connect YAML runs no lint', async () => {
		const lints = () => readCounter(counter).filter((l) => l === 'lint').length;
		const before = lints();
		const doc = await openSaved('k8s.yaml', 'kind: Pod\nnope: 1\n');
		assert.ok(!api().detection.isDetected(doc.uri));
		await editAndSave(doc);
		// Positive control: a detected save afterwards is linted, so the undetected one had its chance.
		const control = await openSaved('control.yaml', 'input:\n  generate:\n    nope: 1\n');
		await editAndSave(control);
		assert.ok(await waitFor(() => lintOf(control).length === 1, 15_000));
		assert.strictEqual(lints(), before + 1);
		assert.deepStrictEqual(lintOf(doc), []);
	});

	test('YAML_SYNTAX with real Red Hat: lint\'s syntax error (on another line) is hidden while Red Hat reports one', async () => {
		const doc = await openSaved('syntax.yaml', 'input:\n  generate:\n    mapping: root = {}\n  - bad\noutput:\n  stdout: {}\n');
		assert.ok(api().detection.isDetected(doc.uri));
		const redHat = () => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'YAML');
		assert.ok(await waitFor(() => redHat().length > 0, 30_000), 'Red Hat reported no syntax error');
		const line = redHat()[0].range.start.line + 1;
		// Like go-yaml, lint names the line where the enclosing block starts, not Red Hat's line.
		assert.notStrictEqual(line, 1);
		fs.writeFileSync(path.join(dir, 'syntax-line'), '1');
		const lints = () => readCounter(counter).filter((l) => l === 'lint').length;
		const before = lints();
		await editAndSave(doc);
		assert.ok(await waitFor(() => lints() === before + 1, 15_000), 'syntax.yaml was not linted');
		// Give the controller the result (and Red Hat its re-validation); it must not show on Red Hat's line.
		await new Promise((r) => setTimeout(r, 1_000));
		assert.ok(redHat().some((d) => d.range.start.line + 1 === line), 'Red Hat still flags the line');
		assert.deepStrictEqual(lintOf(doc), []);
		const ours = api().lintDiagnostics.diagnosticsFor(doc.uri).filter((d) => d.source === 'Redpanda Connect');
		assert.deepStrictEqual(ours, []);
	});

	test('BUILDER_FAIL: a relative resourceFiles entry with no workspace logs one line and publishes nothing', async () => {
		await config().update('resourceFiles', ['res.yaml'], vscode.ConfigurationTarget.Global);
		try {
			const doc = await openSaved('builder.yaml', 'input:\n  generate:\n    nope: 1\n');
			const expected = 'Lint builder.yaml: redpandaConnect.resourceFiles "res.yaml" is a relative path, but no workspace folder is open.';
			await editAndSave(doc);
			assert.ok(await waitFor(() => api().outputLines().includes(expected), 15_000), api().outputLines().slice(-5).join('\n'));
			await new Promise((r) => setTimeout(r, 500));
			assert.strictEqual(api().outputLines().filter((l) => l === expected).length, 1);
			assert.deepStrictEqual(lintOf(doc), []);
		} finally {
			await config().update('resourceFiles', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test('ticket 29 INVALID: lint on save with bad redpandaConnect.env entries logs one line naming the keys, never a value; lint still runs', async () => {
		await config().update('env', { '1X': 'tok-29-secret-bad', OK: 5, GOOD: 'tok-29-secret-good' }, vscode.ConfigurationTarget.Global);
		try {
			// No mapping in it, so only lint reads the setting.
			const doc = await openSaved('env-invalid.yaml', 'input:\n  generate:\n    nope: 1\n');
			const lints = () => readCounter(counter).filter((l) => l === 'lint').length;
			const before = lints();
			const isLine = (l: string) => l.startsWith('redpandaConnect.env: left out ');
			await editAndSave(doc);
			assert.ok(await waitFor(() => lints() > before, 15_000), 'lint did not run');
			assert.ok(await waitFor(() => api().outputLines().some(isLine), 5_000), api().outputLines().slice(-5).join('\n'));
			await editAndSave(doc);
			assert.ok(await waitFor(() => lints() > before + 1, 15_000), 'lint did not run again');
			const logged = api().outputLines().filter(isLine);
			assert.strictEqual(logged.length, 1, JSON.stringify(logged));
			assert.match(logged[0], /"1X", "OK"/);
			assert.ok(!logged[0].includes('GOOD'), logged[0]);
			assert.deepStrictEqual(api().outputLines().filter((l) => l.includes('tok-29-secret')), [], 'no value is logged');
		} finally {
			await config().update('env', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test('QUICK_FIX (2.5): a lint "not recognised" finding offers "Change to `topic`"; applying changes only the key', async () => {
		const text = '# keep me\ninput:\n  stdin: {}\noutput:\n  kafka_franz:\n    seed_brokers: [ "${B}" ]  # brokers\n    topci: t\n';
		const doc = await openSaved('fix.yaml', text);
		assert.ok(await waitFor(() => api().schemaStore.current !== undefined, 30_000));
		await editAndSave(doc); // appends '\n'
		assert.ok(await waitFor(() => lintOf(doc).length === 1, 15_000), JSON.stringify(lintOf(doc)));
		const diagnostic = vscode.languages.getDiagnostics(doc.uri).find((d) => d.source === 'Redpanda Connect')!;
		const list = await quickFixes(doc, diagnostic.range, 'Change to `topic`');
		const ours = list.filter((a) => a.title.startsWith('Change to'));
		assert.strictEqual(ours[0]?.title, 'Change to `topic`', JSON.stringify(list.map((a) => a.title)));
		assert.ok(await vscode.workspace.applyEdit(ours[0].edit!));
		assert.strictEqual(doc.getText(), `${text.replace('topci:', 'topic:')}\n`);
		assert.deepStrictEqual(lintOf(doc), [], 'the fix edits the finding\'s line, so its finding goes');
	});

	test('QUICK_FIX in a name-keyed map (ticket 7): request_mapp in a workflow branch offers "Change to `request_map`", preferred; applying changes only the key', async () => {
		const text = 'input:\n  stdin: {}\npipeline:\n  processors:\n    - workflow:\n        branches:\n          enrich:\n            request_mapp: root = this  # keep\noutput:\n  drop: {}\n';
		const doc = await openSaved('fix-branch.yaml', text);
		assert.ok(await waitFor(() => api().schemaStore.current !== undefined, 30_000));
		await editAndSave(doc); // appends '\n'
		assert.ok(await waitFor(() => lintOf(doc).length === 1, 15_000), JSON.stringify(lintOf(doc)));
		const diagnostic = vscode.languages.getDiagnostics(doc.uri).find((d) => d.source === 'Redpanda Connect')!;
		const list = await quickFixes(doc, diagnostic.range, 'Change to `request_map`');
		const ours = list.filter((a) => a.title.startsWith('Change to'));
		assert.strictEqual(ours[0]?.title, 'Change to `request_map`', JSON.stringify(list.map((a) => a.title)));
		assert.ok(ours[0].isPreferred, 'a clear winner is preferred');
		assert.ok(await vscode.workspace.applyEdit(ours[0].edit!));
		assert.strictEqual(doc.getText(), `${text.replace('request_mapp:', 'request_map:')}\n`);
		assert.deepStrictEqual(lintOf(doc), [], 'the fix edits the finding\'s line, so its finding goes');
	});

	test('OPTION_FIX (2.14): an invalid option offers "Change to `tcp`"; applying changes only the value', async () => {
		const text = 'input:\n  socket_server:\n    network: tpc  # keep\n    address: 0.0.0.0:6000\noutput:\n  stdout: {}\n';
		const doc = await openSaved('option.yaml', text);
		assert.ok(await waitFor(() => api().schemaStore.current !== undefined, 30_000));
		await editAndSave(doc);
		assert.ok(await waitFor(() => lintOf(doc).length === 1, 15_000), JSON.stringify(lintOf(doc)));
		const diagnostic = vscode.languages.getDiagnostics(doc.uri).find((d) => d.source === 'Redpanda Connect')!;
		const list = await quickFixes(doc, diagnostic.range, 'Change to `tcp`');
		const ours = list.filter((a) => a.title.startsWith('Change to'));
		assert.strictEqual(ours[0]?.title, 'Change to `tcp`', JSON.stringify(list.map((a) => a.title)));
		assert.ok(await vscode.workspace.applyEdit(ours[0].edit!));
		assert.strictEqual(doc.getText(), `${text.replace('network: tpc', 'network: tcp')}\n`);
		assert.deepStrictEqual(lintOf(doc), [], 'the fix edits the finding\'s line, so its finding goes');
	});

	test('QUICK_FIX keeps the others (ticket 10): after the fix on one finding, the next keeps its fix; the save replaces them all', async () => {
		const text = 'input:\n  socket_server:\n    network: tpc  # keep\n    address: 0.0.0.0:6000\noutput:\n  kafka_franz:\n    seed_brokers: [x]\n    topci: t\n';
		const doc = await openSaved('fixone.yaml', text);
		assert.ok(await waitFor(() => api().schemaStore.current !== undefined, 30_000));
		await editAndSave(doc); // appends '\n'
		assert.ok(await waitFor(() => lintOf(doc).length === 2, 15_000), JSON.stringify(lintOf(doc)));
		const fix = async (message: string, title: string) => {
			const diagnostic = vscode.languages.getDiagnostics(doc.uri).find((d) => d.source === 'Redpanda Connect' && d.message.startsWith(message))!;
			assert.ok(diagnostic, `${message}: ${JSON.stringify(lintOf(doc))}`);
			const list = await quickFixes(doc, diagnostic.range, title);
			const action = list.find((a) => a.title === title);
			assert.ok(action, JSON.stringify(list.map((a) => a.title)));
			assert.ok(await vscode.workspace.applyEdit(action.edit!));
		};
		await fix('value tpc', 'Change to `tcp`');
		assert.deepStrictEqual(lintOf(doc), [[8, vscode.DiagnosticSeverity.Error, 'field topci not recognised']], 'only the fixed line\'s finding goes');
		// A comment line above: the finding moves, and its Quick Fix still applies on its new line.
		const edit = new vscode.WorkspaceEdit();
		edit.insert(doc.uri, new vscode.Position(0, 0), '# nope: 1\n');
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.deepStrictEqual(lintOf(doc), [[9, vscode.DiagnosticSeverity.Error, 'field topci not recognised']]);
		await fix('field topci', 'Change to `topic`');
		assert.strictEqual(doc.getText(), `# nope: 1\n${text.replace('network: tpc', 'network: tcp').replace('topci:', 'topic:')}\n`);
		assert.deepStrictEqual(lintOf(doc), []);
		// SAVE: lint's fresh findings replace the held ones (the comment's `nope:` is new to them).
		assert.ok(await doc.save());
		assert.ok(await waitFor(() => lintOf(doc).length === 1, 15_000), JSON.stringify(lintOf(doc)));
		assert.deepStrictEqual(lintOf(doc), [[1, vscode.DiagnosticSeverity.Error, 'field nope not recognised']]);
	});

	test('FIX_ALL (2.22): one light bulb fixes all three findings in one undo step; the next save reports none', async () => {
		const text = 'input:\n  socket_server:\n    network: tpc  # keep\n    adress: 0.0.0.0:6000\noutput:\n  kafka_franz:\n    seed_brokers: [x]\n    topci: t\n';
		const doc = await openSaved('fixall.yaml', text);
		assert.ok(await waitFor(() => api().schemaStore.current !== undefined, 30_000));
		await editAndSave(doc); // appends '\n'
		const saved = doc.getText();
		assert.ok(await waitFor(() => lintOf(doc).length === 3, 15_000), JSON.stringify(lintOf(doc)));
		const tpc = vscode.languages.getDiagnostics(doc.uri).find((d) => d.source === 'Redpanda Connect' && d.message.startsWith('value tpc'))!;
		const list = await quickFixes(doc, tpc.range, 'Fix all lint findings with a clear fix (3)');
		const titles = list.map((a) => a.title);
		const index = titles.indexOf('Fix all lint findings with a clear fix (3)');
		assert.ok(index > titles.indexOf('Change to `tcp`') && titles.indexOf('Change to `tcp`') >= 0, JSON.stringify(titles));
		assert.ok(await vscode.workspace.applyEdit(list[index].edit!));
		const fixed = `${text.replace('network: tpc', 'network: tcp').replace('adress:', 'address:').replace('topci:', 'topic:')}\n`;
		assert.strictEqual(doc.getText(), fixed);
		const undos = await untilText(doc, 'undo', saved);
		assert.strictEqual(doc.getText(), saved, `one undo step reverts all three (${undos} tries): ${focusState()}; dirty ${doc.isDirty}, version ${doc.version}`);
		const redos = await untilText(doc, 'redo', fixed);
		assert.strictEqual(doc.getText(), fixed, `redo (${redos} tries): ${focusState()}`);
		const lints = () => readCounter(counter).filter((l) => l === 'lint').length;
		const before = lints();
		assert.ok(await doc.save());
		assert.ok(await waitFor(() => lints() === before + 1, 15_000), 'fixall.yaml was not linted');
		await new Promise((r) => setTimeout(r, 500));
		assert.deepStrictEqual(lintOf(doc), []);
	});
});
