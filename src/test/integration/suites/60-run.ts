import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { type ExtensionApi } from '../../../extension';
import { connectScript, fixtureBodies, makeTempDir, readCounter, writeFakeBinary } from '../../helpers/fakeBinary';
import { EXTENSION_ID, waitFor } from '../helpers';

suite('Run and Stop (integration)', function () {
	this.timeout(90_000);
	let dir: string;
	let counter: string;
	let events: string;
	const originalPath = process.env.PATH;
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const config = () => vscode.workspace.getConfiguration('redpandaConnect');
	const runTerminals = (name: string) => vscode.window.terminals.filter((t) => t.name === `Redpanda Connect: ${name}`);
	const eventLines = () => (fs.existsSync(events) ? fs.readFileSync(events, 'utf8').split('\n').filter(Boolean) : []);

	async function open(name: string, text: string): Promise<vscode.TextDocument> {
		const file = path.join(dir, name);
		fs.writeFileSync(file, text);
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);
		return doc;
	}

	suiteSetup(async () => {
		const fixtures = fixtureBodies('4.112.0');
		process.env.PATH = (originalPath ?? '').split(path.delimiter)
			.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
			.join(path.delimiter);
		dir = makeTempDir('rpcn-run-');
		counter = path.join(dir, 'counter');
		events = path.join(dir, 'events');
		// Like run_generate.yaml: prints, then waits; SIGINT ends it with exit 0 (spike).
		const run = [
			`echo "started cwd=$(pwd) argv=$*" >> '${events}'`,
			`trap 'echo "interrupted" >> '"'${events}'"'; exit 0' INT`,
			'echo tick',
			'while :; do sleep 0.05; done',
		].join('\n');
		const bin = writeFakeBinary(dir, 'redpanda-connect', connectScript({ version: '4.112.0', ...fixtures, run, counterFile: counter }));
		await config().update('binaryPath', bin, vscode.ConfigurationTarget.Global);
		assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'ok'
			&& (api().redpandaConnect.state as { path: string }).path === bin, 30_000));
	});

	suiteTeardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		vscode.window.terminals.filter((t) => t.name.startsWith('Redpanda Connect: ')).forEach((t) => t.dispose());
		process.env.PATH = originalPath;
		await config().update('binaryPath', undefined, vscode.ConfigurationTarget.Global);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('RUN / STOP / RERUN: run in the file\'s terminal, Stop interrupts, Run again reuses the terminal', async () => {
		const doc = await open('pipe.yaml', 'input:\n  generate:\n    mapping: root = "tick"\noutput:\n  stdout: {}\n');
		assert.ok(api().detection.isDetected(doc.uri));
		await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
		assert.ok(await waitFor(() => eventLines().length === 1, 15_000), 'the binary was not started');
		// The builder's argv exactly: no other flags (no --chilled / --verbose).
		assert.strictEqual(eventLines()[0], `started cwd=${fs.realpathSync(dir)} argv=run --set http.enabled=false ${doc.uri.fsPath}`);
		assert.strictEqual(runTerminals('pipe.yaml').length, 1);
		assert.strictEqual(api().run.phaseOf(doc.uri), 'running');

		await vscode.commands.executeCommand('redpandaConnect.stop', doc.uri);
		assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'exited', 15_000));
		assert.deepStrictEqual(eventLines().slice(1), ['interrupted']);

		await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
		assert.ok(await waitFor(() => eventLines().length === 3, 15_000));
		assert.strictEqual(runTerminals('pipe.yaml').length, 1, 'the terminal is reused');
		await vscode.commands.executeCommand('redpandaConnect.stop', doc.uri);
		assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'exited', 15_000));
	});

	test('DIRTY: Run saves unsaved changes first', async () => {
		const doc = await open('dirty.yaml', 'input:\n  generate:\n    mapping: root = "a"\noutput:\n  stdout: {}\n');
		const edit = new vscode.WorkspaceEdit();
		edit.insert(doc.uri, new vscode.Position(0, 0), '# edited\n');
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.ok(doc.isDirty);
		await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
		assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'running', 15_000));
		assert.strictEqual(doc.isDirty, false);
		assert.ok(fs.readFileSync(doc.uri.fsPath, 'utf8').startsWith('# edited'));
		await vscode.commands.executeCommand('redpandaConnect.stop', doc.uri);
		assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'exited', 15_000));
	});

	test('UNTITLED: an untitled config does not run', async () => {
		const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'input:\n  stdin: {}\n' });
		await vscode.window.showTextDocument(doc);
		assert.ok(await waitFor(() => api().detection.isDetected(doc.uri), 5_000));
		const runs = () => readCounter(counter).filter((l) => l === 'run').length;
		const before = runs();
		await vscode.commands.executeCommand('redpandaConnect.run');
		await vscode.commands.executeCommand('redpandaConnect.runUntitled');
		assert.strictEqual(api().run.phaseOf(doc.uri), undefined);
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
		// Positive control: the same content saved to a file runs.
		const saved = await open('was-untitled.yaml', 'input:\n  stdin: {}\n');
		await vscode.commands.executeCommand('redpandaConnect.run');
		assert.ok(await waitFor(() => runs() === before + 1, 15_000), 'the saved file did not run');
		assert.strictEqual(api().run.phaseOf(saved.uri), 'running');
		await vscode.commands.executeCommand('redpandaConnect.stop');
		assert.ok(await waitFor(() => api().run.phaseOf(saved.uri) === 'exited', 15_000));
	});

	test('NO_BINARY: Run logs one line and opens no terminal', async () => {
		const doc = await open('nobin.yaml', 'input:\n  stdin: {}\n');
		await config().update('binaryPath', path.join(dir, 'gone'), vscode.ConfigurationTarget.Global);
		try {
			assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'missing', 15_000));
			await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
			assert.ok(api().outputLines().includes('Run nobin.yaml: no usable Redpanda Connect binary.'));
			assert.strictEqual(runTerminals('nobin.yaml').length, 0);
		} finally {
			await config().update('binaryPath', path.join(dir, 'redpanda-connect'), vscode.ConfigurationTarget.Global);
			await waitFor(() => api().redpandaConnect.state.kind === 'ok', 15_000);
		}
	});

	test('contributions: icons, palette and editor-title clauses, the untitled entry', () => {
		const contributes = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes;
		const command = (id: string) => contributes.commands.find((c: { command: string }) => c.command === id);
		assert.deepStrictEqual(command('redpandaConnect.run'), { command: 'redpandaConnect.run', title: 'Run', category: 'Redpanda Connect', icon: '$(play)' });
		assert.deepStrictEqual(command('redpandaConnect.stop'), { command: 'redpandaConnect.stop', title: 'Stop', category: 'Redpanda Connect', icon: '$(debug-stop)' });
		assert.deepStrictEqual(command('redpandaConnect.runUntitled'), {
			command: 'redpandaConnect.runUntitled', title: 'Save the file to run it.', category: 'Redpanda Connect', icon: '$(play)', enablement: 'false',
		});
		const palette = Object.fromEntries(contributes.menus.commandPalette.map((m: { command: string; when: string }) => [m.command, m.when]));
		assert.strictEqual(palette['redpandaConnect.run'], 'redpandaConnect.activeEditorDetected');
		assert.strictEqual(palette['redpandaConnect.stop'], 'redpandaConnect.activeEditorRunning');
		assert.strictEqual(palette['redpandaConnect.runUntitled'], 'false');
		// The run entries; the graph's Show / Hide toggle (3.10) is checked by the graph suite.
		const runEntries = contributes.menus['editor/title'].filter((m: { command: string }) => m.command.startsWith('redpandaConnect.run'));
		assert.deepStrictEqual(runEntries, [
			{ command: 'redpandaConnect.run', when: 'resourceScheme != untitled && resourcePath in redpandaConnect.detectedPaths', group: 'navigation' },
			{ command: 'redpandaConnect.runUntitled', when: 'resourceScheme == untitled && resourcePath in redpandaConnect.detectedPaths', group: 'navigation' },
		]);
	});
});
