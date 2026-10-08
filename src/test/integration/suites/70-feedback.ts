import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { REFRESH_NO_BINARY_LINE, type ExtensionApi } from '../../../extension';
import { connectScript, fixtureBodies, makeTempDir, toolPath, writeFakeBinary } from '../../helpers/fakeBinary';
import { EXTENSION_ID, waitFor, waitForAsync } from '../helpers';

suite('Binary and schema changes reach open files (2.8, integration)', function () {
	this.timeout(120_000);
	let dir: string;
	let fakeBinary: string;
	let counter: string;
	const originalPath = process.env.PATH;
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const config = () => vscode.workspace.getConfiguration('redpandaConnect');
	const labelsAt = async (doc: vscode.TextDocument, position: vscode.Position) => {
		const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, position);
		return (list?.items ?? []).filter((it) => it.kind !== vscode.CompletionItemKind.Text)
			.map((it) => (typeof it.label === 'string' ? it.label : it.label.label));
	};

	suiteSetup(async () => {
		const fixtures = fixtureBodies('4.112.0');
		const grep = toolPath('grep');
		const cut = toolPath('cut');
		process.env.PATH = (originalPath ?? '').split(path.delimiter)
			.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
			.join(path.delimiter);
		dir = makeTempDir('rpcn-feedback-');
		counter = path.join(dir, 'counter');
		const lint = [
			'found=0',
			`for n in $('${grep}' -n 'nope:' "$last" | '${cut}' -d: -f1); do echo "$last($n,1) field nope not recognised" >&2; found=1; done`,
			'exit $found',
		].join('\n');
		fakeBinary = writeFakeBinary(dir, 'redpanda-connect', connectScript({ version: '4.112.0', ...fixtures, lint, counterFile: counter }));
		await config().update('binaryPath', path.join(dir, 'not-installed-yet'), vscode.ConfigurationTarget.Global);
		assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'missing', 30_000), JSON.stringify(api().redpandaConnect.state));
	});

	suiteTeardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		process.env.PATH = originalPath;
		await config().update('binaryPath', undefined, vscode.ConfigurationTarget.Global);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('REFRESH_NO_BINARY: Refresh Schema with no usable binary logs one line (and shows the warning again)', async () => {
		const before = api().outputLines().filter((l) => l === REFRESH_NO_BINARY_LINE).length;
		await vscode.commands.executeCommand('redpandaConnect.refreshSchema');
		assert.strictEqual(api().outputLines().filter((l) => l === REFRESH_NO_BINARY_LINE).length, before + 1);
		assert.strictEqual(api().schemaStore.current, undefined);
	});

	test('SET_PATH_OPEN_FILE: after Set path, an already open file gets completion and lint on save, no reopen', async () => {
		const file = path.join(dir, 'open.yaml');
		fs.writeFileSync(file, 'input:\n  socket:\n    \noutput:\n  stdout: {}\n');
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);
		assert.ok(api().detection.isDetected(doc.uri));
		assert.deepStrictEqual(await labelsAt(doc, new vscode.Position(2, 4)), [], 'no schema yet: no completion');

		// What the warning's Set path does: write the setting; the binary and schema follow.
		await config().update('binaryPath', fakeBinary, vscode.ConfigurationTarget.Global);
		assert.ok(await waitFor(() => api().schemaStore.current?.path === fakeBinary, 30_000), 'no schema after Set path');

		let labels: string[] = [];
		assert.ok(await waitForAsync(async () => {
			labels = await labelsAt(doc, new vscode.Position(2, 4));
			return labels.includes('address') && labels.includes('network');
		}, 30_000), `completion did not follow the new schema: ${labels.join(', ')}`);

		const edit = new vscode.WorkspaceEdit();
		edit.insert(doc.uri, new vscode.Position(2, 4), 'nope: 1');
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.ok(await doc.save());
		const lintOf = () => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'Redpanda Connect').map((d) => d.message);
		assert.ok(await waitFor(() => lintOf().length === 1, 15_000), `lint did not run: ${JSON.stringify(lintOf())}`);
		assert.deepStrictEqual(lintOf(), ['field nope not recognised']);
	});
});
