import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BinaryState } from '../adapters/redpandaConnect/binary';
import type { ExtensionApi } from '../extension';
import { makeTempDir, VERSION_4_112_SCRIPT, versionScript, writeFakeBinary } from './helpers/fakeBinary';

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
	const originalPath = process.env.PATH;

	suiteSetup(async () => {
		// PATH wins over binaryPath (AD-9): hide any real rpk / redpanda-connect from the
		// extension host (same process) so these tests exercise the setting.
		process.env.PATH = (originalPath ?? '').split(path.delimiter)
			.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
			.join(path.delimiter);
		dir = makeTempDir('rpcn-integration-');
		fakeBinary = writeFakeBinary(dir, 'redpanda-connect', VERSION_4_112_SCRIPT);
		await vscode.workspace.getConfiguration('redpandaConnect')
			.update('binaryPath', fakeBinary, vscode.ConfigurationTarget.Global);
	});

	suiteTeardown(async () => {
		process.env.PATH = originalPath;
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
		await api.activationResolved;
		assert.deepStrictEqual(api.redpandaConnect.state, {
			kind: 'ok', path: fakeBinary, version: '4.112.0', invocation: [fakeBinary],
		});
		assert.deepStrictEqual(api.outputLines(), [`Redpanda Connect 4.112.0 (${fakeBinary})`]);
	});

	test('SETTING_CHANGED: flipping binaryPath between ok, missing and invalid updates binaryState without a reload', async () => {
		const api = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
		const rc = api.redpandaConnect;
		const missing = path.join(dir, 'does-not-exist');
		const old = writeFakeBinary(dir, 'redpanda-connect-old', versionScript('4.63.0'));
		const events: BinaryState[] = [];
		const sub = rc.onDidChange((s) => events.push(s));
		const linesBefore = api.outputLines().length;

		const setBinaryPath = async (value: string, expected: BinaryState['kind']) => {
			const changed = new Promise<BinaryState>((resolve) => {
				const once = rc.onDidChange((s) => { once.dispose(); resolve(s); });
			});
			await vscode.workspace.getConfiguration('redpandaConnect')
				.update('binaryPath', value, vscode.ConfigurationTarget.Global);
			const state = await Promise.race([
				changed,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no onDidChange for ${value}`)), 10_000)),
			]);
			await rc.refresh(); // settle any queued run
			assert.strictEqual(state.kind, expected);
			assert.strictEqual(rc.state.kind, expected);
		};

		try {
			await setBinaryPath(missing, 'missing');
			await setBinaryPath(old, 'invalid');
			assert.deepStrictEqual(rc.state, { kind: 'invalid', path: old, reason: 'belowMinimum', version: '4.63.0' });
			await setBinaryPath(fakeBinary, 'ok');
		} finally {
			sub.dispose();
		}

		assert.deepStrictEqual(events.map((e) => e.kind), ['missing', 'invalid', 'ok']);
		assert.deepStrictEqual(api.outputLines().slice(linesBefore), [
			'No Redpanda Connect binary found: neither "rpk" nor "redpanda-connect" is on PATH, '
				+ `and no binary was found at redpandaConnect.binaryPath "${missing}".`,
			`Redpanda Connect 4.63.0 (${old}) is older than the minimum supported version 4.100.0.`,
			`Redpanda Connect 4.112.0 (${fakeBinary})`,
		]);
	});
});
