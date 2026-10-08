import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BinaryState, RedpandaConnect } from '../../../adapters/redpandaConnect/binary';
import { BinaryNotifier, MISSING_MESSAGE, NOTIFICATION_ACTIONS } from '../../../adapters/redpandaConnect/notify';
import { createVsCodeNotifier, type ExtensionApi } from '../../../extension';
import { SchemaSnapshot, SchemaStore } from '../../../adapters/redpandaConnect/schema';
import { schemaFileName } from '../../../core/schema';
import { connectScript, makeTempDir, readCounter, versionScript, writeFakeBinary } from '../../helpers/fakeBinary';
import { binaryLines, EXTENSION_ID, waitFor } from '../helpers';

// The tests in this suite run in order: NON_YAML must run before the extension is activated.
suite('Extension tracer path (integration)', () => {
	let dir: string;
	let fakeBinary: string;
	let counter: string;
	const originalPath = process.env.PATH;

	suiteSetup(async () => {
		// PATH wins over binaryPath (AD-9): hide any real rpk / redpanda-connect from the
		// extension host (same process) so these tests exercise the setting.
		process.env.PATH = (originalPath ?? '').split(path.delimiter)
			.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
			.join(path.delimiter);
		dir = makeTempDir('rpcn-integration-');
		counter = path.join(dir, 'count');
		fakeBinary = writeFakeBinary(dir, 'redpanda-connect', connectScript({ version: '4.112.0', counterFile: counter }));
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
		assert.deepStrictEqual(binaryLines(api), [`Redpanda Connect 4.112.0 (${fakeBinary})`]);
	});

	test('SETTING_CHANGED: flipping binaryPath between ok, missing and invalid updates binaryState without a reload', async () => {
		const api = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
		const rc = api.redpandaConnect;
		const missing = path.join(dir, 'does-not-exist');
		const old = writeFakeBinary(dir, 'redpanda-connect-old', versionScript('4.63.0'));
		const events: BinaryState[] = [];
		const sub = rc.onDidChange((s) => events.push(s));
		const linesBefore = binaryLines(api).length;

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
		assert.deepStrictEqual(binaryLines(api).slice(linesBefore), [
			'No Redpanda Connect binary found: neither "rpk" nor "redpanda-connect" is on PATH, '
				+ `and no binary was found at redpandaConnect.binaryPath "${missing}".`,
			`Redpanda Connect 4.63.0 (${old}) is older than the minimum supported version 4.100.0.`,
			`Redpanda Connect 4.112.0 (${fakeBinary})`,
		]);
	});
	test('SCHEMA_ACCEPTANCE: the schema is cached in globalStorage; a second activation spawns no list; Refresh schema regenerates', async () => {
		const api = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
		const store = api.schemaStore;
		await api.redpandaConnect.refresh();
		const current = await store.settled();
		assert.ok(current, 'no schema after activation');
		assert.strictEqual(current.path, fakeBinary);
		assert.strictEqual(path.basename(current.uri.fsPath), schemaFileName(fakeBinary, '4.112.0'));
		assert.ok(fs.existsSync(current.uri.fsPath));
		const storageDir = path.dirname(current.uri.fsPath);

		// A second activation: a new store over the same globalStorage and binary state.
		const listRuns = () => readCounter(counter).filter((l) => l !== 'version').length;
		const before = listRuns();
		const lines: string[] = [];
		const second = new SchemaStore({ binary: api.redpandaConnect, storageUri: vscode.Uri.file(storageDir), log: (l) => lines.push(l) });
		try {
			const cached = await second.settled();
			assert.ok(cached);
			assert.deepStrictEqual(cached.json, current.json);
			assert.strictEqual(listRuns(), before, 'a list process was spawned on a cache hit');
			assert.deepStrictEqual(lines, [`Schema: using the cached schema for Redpanda Connect 4.112.0 (${current.uri.fsPath}).`]);
		} finally {
			second.dispose();
		}

		// Refresh schema: visible in the Command Palette, regenerates even on a cache hit.
		const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as {
			contributes: { menus: { commandPalette: { command: string }[] } };
		};
		assert.ok(!pkg.contributes.menus.commandPalette.some((m) => m.command === 'redpandaConnect.refreshSchema'));
		const changed = new Promise<SchemaSnapshot | undefined>((resolve) => {
			const once = store.onDidChange((s) => { once.dispose(); resolve(s); });
		});
		await vscode.commands.executeCommand('redpandaConnect.refreshSchema');
		const refreshed = await changed;
		assert.ok(refreshed && refreshed !== current);
		assert.strictEqual(store.current, refreshed);
		assert.ok(listRuns() > before, 'Refresh schema did not run list');
	});

	test('NOTIFY_MISSING: a missing resolution goes through the real VS Code notifier without throwing', async () => {
		const lines: string[] = [];
		const real = createVsCodeNotifier((line) => lines.push(line));
		const shown: { message: string; actions: readonly string[] }[] = [];
		const notifier: BinaryNotifier = {
			...real,
			showWarning: (message, actions) => {
				shown.push({ message, actions });
				return real.showWarning(message, actions); // stays open: never clicked here
			},
		};
		const rc = new RedpandaConnect({
			log: (line) => lines.push(line),
			notifier,
			environment: () => ({ binaryPathSetting: '', envPath: '', homeDir: dir, workspaceFolder: undefined }),
		});
		try {
			assert.strictEqual((await rc.refresh()).kind, 'missing');
			assert.deepStrictEqual(shown, [{ message: MISSING_MESSAGE, actions: NOTIFICATION_ACTIONS }]);
			assert.ok(!lines.some((l) => l.includes('notification action failed')), lines.join('\n'));
		} finally {
			rc.dispose();
		}
	});

	test('SET_PATH_ACCEPTANCE: Set path writes the absolute path at Global scope and binaryState becomes ok without a reload', async () => {
		const config = () => vscode.workspace.getConfiguration('redpandaConnect');
		await config().update('binaryPath', path.join(dir, 'not-there'), vscode.ConfigurationTarget.Global);
		const lines: string[] = [];
		const real = createVsCodeNotifier((line) => lines.push(line));
		const shown: string[] = [];
		const notifier: BinaryNotifier = {
			...real,
			showWarning: async (message) => { shown.push(message); return 'Set path'; },
			pickBinary: async () => fakeBinary, // the picker itself needs a human
		};
		// Default environment: the real setting and the (filtered) PATH of the extension host.
		const rc = new RedpandaConnect({ log: () => undefined, notifier });
		try {
			assert.strictEqual((await rc.refresh()).kind, 'missing');
			assert.ok(await waitFor(() => rc.state.kind === 'ok', 10_000), `state stayed ${rc.state.kind}`);
			assert.deepStrictEqual(rc.state, { kind: 'ok', path: fakeBinary, version: '4.112.0', invocation: [fakeBinary] });
			assert.strictEqual(config().inspect<string>('binaryPath')?.globalValue, fakeBinary);
			assert.ok(path.isAbsolute(fakeBinary));
			await rc.refresh();
			assert.deepStrictEqual(shown, [MISSING_MESSAGE]);
			assert.deepStrictEqual(lines, [], 'no workspace override expected');
		} finally {
			rc.dispose();
		}
	});
});
