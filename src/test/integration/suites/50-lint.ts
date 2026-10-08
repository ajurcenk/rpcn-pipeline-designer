import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { type ExtensionApi } from '../../../extension';
import { connectScript, fixtureBodies, makeTempDir, readCounter, toolPath, writeFakeBinary } from '../../helpers/fakeBinary';
import { EXTENSION_ID, waitFor } from '../helpers';

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
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('UNKNOWN_FIELD / DEPRECATED / FIRST_EDIT: save shows Error and Warning on their lines; the first edit clears them', async () => {
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
		assert.deepStrictEqual(lintOf(doc), []);
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

	test('QUICK_FIX (2.5): a lint "not recognised" finding offers "Change to `topic`"; applying changes only the key', async () => {
		const text = '# keep me\ninput:\n  stdin: {}\noutput:\n  kafka_franz:\n    seed_brokers: [ "${B}" ]  # brokers\n    topci: t\n';
		const doc = await openSaved('fix.yaml', text);
		assert.ok(await waitFor(() => api().schemaStore.current !== undefined, 30_000));
		await editAndSave(doc); // appends '\n'
		assert.ok(await waitFor(() => lintOf(doc).length === 1, 15_000), JSON.stringify(lintOf(doc)));
		const diagnostic = vscode.languages.getDiagnostics(doc.uri).find((d) => d.source === 'Redpanda Connect')!;
		const list = await vscode.commands.executeCommand<vscode.CodeAction[]>(
			'vscode.executeCodeActionProvider', doc.uri, diagnostic.range, vscode.CodeActionKind.QuickFix.value);
		const ours = list.filter((a) => a.title.startsWith('Change to'));
		assert.strictEqual(ours[0]?.title, 'Change to `topic`', JSON.stringify(list.map((a) => a.title)));
		assert.ok(await vscode.workspace.applyEdit(ours[0].edit!));
		assert.strictEqual(doc.getText(), `${text.replace('topci:', 'topic:')}\n`);
		assert.deepStrictEqual(lintOf(doc), [], 'the fix is an edit, so lint findings clear');
	});

	test('OPTION_FIX (2.14): an invalid option offers "Change to `tcp`"; applying changes only the value', async () => {
		const text = 'input:\n  socket_server:\n    network: tpc  # keep\n    address: 0.0.0.0:6000\noutput:\n  stdout: {}\n';
		const doc = await openSaved('option.yaml', text);
		assert.ok(await waitFor(() => api().schemaStore.current !== undefined, 30_000));
		await editAndSave(doc);
		assert.ok(await waitFor(() => lintOf(doc).length === 1, 15_000), JSON.stringify(lintOf(doc)));
		const diagnostic = vscode.languages.getDiagnostics(doc.uri).find((d) => d.source === 'Redpanda Connect')!;
		const list = await vscode.commands.executeCommand<vscode.CodeAction[]>(
			'vscode.executeCodeActionProvider', doc.uri, diagnostic.range, vscode.CodeActionKind.QuickFix.value);
		const ours = list.filter((a) => a.title.startsWith('Change to'));
		assert.strictEqual(ours[0]?.title, 'Change to `tcp`', JSON.stringify(list.map((a) => a.title)));
		assert.ok(await vscode.workspace.applyEdit(ours[0].edit!));
		assert.strictEqual(doc.getText(), `${text.replace('network: tpc', 'network: tcp')}\n`);
		assert.deepStrictEqual(lintOf(doc), [], 'the fix is an edit, so lint findings clear');
	});

	test('FIX_ALL (2.22): one light bulb fixes all three findings in one undo step; the next save reports none', async () => {
		const text = 'input:\n  socket_server:\n    network: tpc  # keep\n    adress: 0.0.0.0:6000\noutput:\n  kafka_franz:\n    seed_brokers: [x]\n    topci: t\n';
		const doc = await openSaved('fixall.yaml', text);
		assert.ok(await waitFor(() => api().schemaStore.current !== undefined, 30_000));
		await editAndSave(doc); // appends '\n'
		const saved = doc.getText();
		assert.ok(await waitFor(() => lintOf(doc).length === 3, 15_000), JSON.stringify(lintOf(doc)));
		const tpc = vscode.languages.getDiagnostics(doc.uri).find((d) => d.source === 'Redpanda Connect' && d.message.startsWith('value tpc'))!;
		const list = await vscode.commands.executeCommand<vscode.CodeAction[]>(
			'vscode.executeCodeActionProvider', doc.uri, tpc.range, vscode.CodeActionKind.QuickFix.value);
		const titles = list.map((a) => a.title);
		const index = titles.indexOf('Fix all lint findings with a clear fix (3)');
		assert.ok(index > titles.indexOf('Change to `tcp`') && titles.indexOf('Change to `tcp`') >= 0, JSON.stringify(titles));
		assert.ok(await vscode.workspace.applyEdit(list[index].edit!));
		const fixed = `${text.replace('network: tpc', 'network: tcp').replace('adress:', 'address:').replace('topci:', 'topic:')}\n`;
		assert.strictEqual(doc.getText(), fixed);
		await vscode.commands.executeCommand('undo');
		assert.strictEqual(doc.getText(), saved, 'one undo step reverts all three');
		await vscode.commands.executeCommand('redo');
		assert.strictEqual(doc.getText(), fixed);
		const lints = () => readCounter(counter).filter((l) => l === 'lint').length;
		const before = lints();
		assert.ok(await doc.save());
		assert.ok(await waitFor(() => lints() === before + 1, 15_000), 'fixall.yaml was not linted');
		await new Promise((r) => setTimeout(r, 500));
		assert.deepStrictEqual(lintOf(doc), []);
	});
});
