import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../extension';
import { makeTempDir, VERSION_4_112_SCRIPT, writeFakeBinary } from './helpers/fakeBinary';

const EXTENSION_ID = 'ajurcenk.rpcn-pipeline-designer';

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return true;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	return predicate();
}

// The tests in this suite run in order: NON_YAML must run before the extension is activated.
suite('Extension tracer path (integration)', () => {
	let dir: string;
	let fakeBinary: string;

	suiteSetup(async () => {
		dir = makeTempDir('rpcn-integration-');
		fakeBinary = writeFakeBinary(dir, 'redpanda-connect', VERSION_4_112_SCRIPT);
		await vscode.workspace.getConfiguration('redpandaConnect')
			.update('binaryPath', fakeBinary, vscode.ConfigurationTarget.Global);
	});

	suiteTeardown(async () => {
		await vscode.workspace.getConfiguration('redpandaConnect')
			.update('binaryPath', undefined, vscode.ConfigurationTarget.Global);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('the extension and its Red Hat YAML dependency are installed', () => {
		assert.ok(vscode.extensions.getExtension(EXTENSION_ID), `${EXTENSION_ID} not found`);
		assert.ok(vscode.extensions.getExtension('redhat.vscode-yaml'), 'redhat.vscode-yaml not installed');
	});

	test('NON_YAML: opening a non-YAML file does not activate the extension', async () => {
		const txt = path.join(dir, 'notes.txt');
		fs.writeFileSync(txt, 'hello\n');
		const doc = await vscode.workspace.openTextDocument(txt);
		await vscode.window.showTextDocument(doc);
		await new Promise((r) => setTimeout(r, 500));
		assert.strictEqual(vscode.extensions.getExtension(EXTENSION_ID)!.isActive, false);
	});

	test('HAPPY_PATH: opening a YAML file logs the binary version to the output channel', async () => {
		const yamlFile = path.join(dir, 'pipeline.yaml');
		fs.writeFileSync(yamlFile, 'input:\n  stdin: {}\noutput:\n  stdout: {}\n');
		const doc = await vscode.workspace.openTextDocument(yamlFile);
		assert.strictEqual(doc.languageId, 'yaml');
		await vscode.window.showTextDocument(doc);

		const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!;
		assert.ok(await waitFor(() => ext.isActive, 15_000), 'extension did not activate on a YAML file');

		const api = ext.exports;
		await api.versionChecked;
		assert.deepStrictEqual(api.outputLines(), [`Redpanda Connect 4.112.0 (${fakeBinary})`]);
	});
});
