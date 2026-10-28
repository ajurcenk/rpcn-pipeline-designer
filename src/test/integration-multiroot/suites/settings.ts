// Per-folder settings in a real multi-root workspace (ticket 28): ticket 4 made `redpandaConnect.envFile`
// per folder, and its tests inject the folder and where the value is defined. Here VS Code itself
// answers `getConfiguration(…, resource)`, `getWorkspaceFolder` and `inspect`: with a relative
// `envFile` in folder B's settings, lint, Run, the live Bloblang parse and the test panel on B's config
// pass B's env file, and A's config none; with it only in the workspace settings, both pass the first
// folder's (A's). A fake binary records each command's argv. Each test sets its settings at the folder
// or workspace level and removes them after, so the fixture on disk stays as committed.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TEST_MAPPING_COMMAND, type BloblangPanelHandle } from '../../../adapters/bloblangPanel/panels';
import { type ExtensionApi } from '../../../extension';
import {
	bloblParseBody, connectScript, envCaptureLine, fixtureBodies, makeTempDir, mappingTestRunBody, REPO_ROOT, writeFakeBinary,
} from '../../helpers/fakeBinary';
import { EXTENSION_ID, runOnEditor, waitFor } from '../../integration/helpers';

type FolderName = 'a' | 'b';
/** Per feature, the `--env-file` of each command it ran (`null`: none). */
type EnvFiles = Record<'lint' | 'run' | 'parse' | 'panel', (string | null)[]>;
/** Per feature, the argv of each command it ran. */
type Argvs = Record<keyof EnvFiles, string[]>;

const FIXTURE = path.join(REPO_ROOT, 'test', 'multiroot');
const WORKSPACE_FILE = path.join(FIXTURE, 'multiroot.code-workspace');
const MAPPING = 'root.b = this.a + 1';

suite('Per-folder settings in a multi-root workspace (integration, ticket 28)', function () {
	this.timeout(120_000);
	let dir: string;
	let capture: string;
	/** Ticket 30: `SECRET_30` as each command saw it. */
	let seen: string;
	let edits = 0;
	const originalPath = process.env.PATH;
	const originals = new Map<string, string>();
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const folder = (name: FolderName) => {
		const found = vscode.workspace.workspaceFolders?.find((f) => f.name === name);
		assert.ok(found, `no workspace folder ${name}: ${JSON.stringify(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath))}`);
		return found;
	};
	const configOf = (name: FolderName) => path.join(folder(name).uri.fsPath, 'pipe.yaml');
	const envOf = (name: FolderName) => path.join(folder(name).uri.fsPath, '.env');
	/** The argv lines the fake appended to `<capture>/<file>`. */
	const argvLines = (file: string) => {
		const at = path.join(capture, file);
		return fs.existsSync(at) ? fs.readFileSync(at, 'utf8').split('\n').filter(Boolean) : [];
	};
	const envFileOf = (argv: string) => /(?:^| )--env-file (\S+)/.exec(argv)?.[1] ?? null;
	/** The last `--env-file` (ticket 29: `redpandaConnect.env`'s generated one). */
	const lastEnvFileOf = (argv: string) => [...argv.matchAll(/(?:^| )--env-file (\S+)/g)].pop()?.[1] ?? null;
	const setEnv = (target: vscode.ConfigurationTarget, value: Record<string, string> | undefined, name?: FolderName) => vscode.workspace
		.getConfiguration('redpandaConnect', name ? folder(name).uri : undefined).update('env', value, target);

	const setFolderEnvFile = (name: FolderName, value: string | undefined) => vscode.workspace
		.getConfiguration('redpandaConnect', folder(name).uri).update('envFile', value, vscode.ConfigurationTarget.WorkspaceFolder);
	const setWorkspaceEnvFile = (value: string | undefined) => vscode.workspace
		.getConfiguration('redpandaConnect').update('envFile', value, vscode.ConfigurationTarget.Workspace);

	async function edit(doc: vscode.TextDocument, at: number, length: number, text: string): Promise<void> {
		const change = new vscode.WorkspaceEdit();
		change.replace(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + length)), text);
		assert.ok(await vscode.workspace.applyEdit(change));
	}

	/** Waits until every started live parse has finished and none started for 700 ms (longer than the debounce). */
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

	/**
	 * Lints (on save), runs, test-runs and live-parses the config of folder `name`, and returns the
	 * `--env-file` each command got. The config on disk ends as it started.
	 */
	async function exercise(name: FolderName): Promise<EnvFiles> {
		const got = await exerciseArgv(name);
		return { lint: got.lint.map(envFileOf), run: got.run.map(envFileOf), parse: got.parse.map(envFileOf), panel: got.panel.map(envFileOf) };
	}

	/** As `exercise`, the whole argv of each command. */
	async function exerciseArgv(name: FolderName): Promise<Argvs> {
		const file = configOf(name);
		const original = fs.readFileSync(file, 'utf8');
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc, { preview: false });
		assert.ok(await waitFor(() => api().detection.isDetected(doc.uri), 5_000), `${name}/pipe.yaml is not detected`);
		await quiet();
		const since = (argvFile: string, mark: number) => argvLines(argvFile).slice(mark);

		// Lint on save: a newline added and saved, then removed and saved (the file as committed).
		const lintMark = argvLines('lint-argv').length;
		await edit(doc, doc.getText().length, 0, '\n');
		assert.ok(await doc.save());
		assert.ok(await waitFor(() => argvLines('lint-argv').length > lintMark, 15_000), `${name}: no lint on save`);
		await new Promise((r) => setTimeout(r, 300));
		await edit(doc, doc.getText().length - 1, 1, '');
		assert.ok(await doc.save());
		assert.ok(await waitFor(() => argvLines('lint-argv').length >= lintMark + 2, 15_000), `${name}: no lint on the second save`);
		assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
		const lint = since('lint-argv', lintMark);

		// Run: in the file's terminal; the fake exits at once.
		const runMark = argvLines('run-argv').length;
		await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
		assert.ok(await waitFor(() => argvLines('run-argv').length > runMark, 15_000), `${name}: Run did not start the binary`);
		assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'exited', 15_000), `${name}: Run did not exit`);
		const run = since('run-argv', runMark);
		assert.ok(run.every((l) => l.endsWith(` ${doc.uri.fsPath}`)), JSON.stringify(run));

		// The test panel's run of the mapping.
		const handle = await vscode.commands.executeCommand<BloblangPanelHandle | undefined>(TEST_MAPPING_COMMAND, doc.uri, 'pipeline.processors[0]');
		assert.ok(handle, `${name}: no test panel`);
		const panelMark = argvLines('argv').length;
		const results = handle.posted.filter((m) => m.type === 'result').length;
		await handle.receive({ type: 'run', content: '{"a":1}', meta: {} });
		assert.strictEqual(handle.posted.filter((m) => m.type === 'result').length, results + 1, `${name}: no test run result`);
		const panel = since('argv', panelMark);

		// The live parse of an edited mapping (a text not parsed before, so never a cached outcome).
		const parseMark = argvLines('blobl-argv').length;
		const at = doc.getText().indexOf(MAPPING);
		assert.ok(at >= 0, doc.getText());
		await edit(doc, at, MAPPING.length, `root.b = this.a + ${++edits + 1}`);
		assert.ok(await waitFor(() => argvLines('blobl-argv').length > parseMark, 10_000), `${name}: no live parse`);
		await quiet();
		const parse = since('blobl-argv', parseMark);

		await runOnEditor(doc, 'workbench.action.files.revert');
		assert.ok(await waitFor(() => !doc.isDirty, 5_000), `${name}: the edit was not reverted`);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
		return { lint, run, parse, panel };
	}

	/** What `exercise` returns when every command got `envFile` (`null`: none). */
	function expected(got: EnvFiles, envFile: string | null): EnvFiles {
		const all = (lines: unknown[]) => (lines.length > 0 ? lines.map(() => envFile) : [envFile]);
		return { lint: all(got.lint), run: all(got.run), parse: all(got.parse), panel: all(got.panel) };
	}

	suiteSetup(async () => {
		assert.deepStrictEqual(vscode.workspace.workspaceFolders?.map((f) => f.name), ['a', 'b'], 'the run opens test/multiroot/multiroot.code-workspace');
		for (const file of [WORKSPACE_FILE, path.join(FIXTURE, 'a', 'pipe.yaml'), path.join(FIXTURE, 'b', 'pipe.yaml')]) {
			originals.set(file, fs.readFileSync(file, 'utf8'));
		}
		const fixtures = fixtureBodies('4.112.0'); // absolute tool paths: resolved before PATH is filtered
		dir = makeTempDir('rpcn-multiroot-');
		capture = path.join(dir, 'capture');
		fs.mkdirSync(capture);
		seen = path.join(dir, 'seen');
		const lint = `printf '%s\\n' "$*" >> '${path.join(capture, 'lint-argv')}'\nexit 0`;
		// Run and the test panel's run are both `run …`: every one goes to run-argv, the test run's
		// (mappingTestRunBody) to argv too.
		const run = `printf '%s\\n' "$*" >> '${path.join(capture, 'run-argv')}'\n${mappingTestRunBody(capture)}`;
		const blobl = bloblParseBody(capture);
		process.env.PATH = (originalPath ?? '').split(path.delimiter)
			.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
			.join(path.delimiter);
		const bin = writeFakeBinary(dir, 'redpanda-connect', connectScript({ version: '4.112.0', ...fixtures, lint, run, blobl, envCapture: { file: seen, names: ['SECRET_30'] } }));
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
		await vscode.workspace.getConfiguration('redpandaConnect').update('binaryPath', bin, vscode.ConfigurationTarget.Global);
		assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'ok'
			&& (api().redpandaConnect.state as { path: string }).path === bin, 30_000), JSON.stringify(api().redpandaConnect.state));
	});

	teardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		vscode.window.terminals.filter((t) => t.name.startsWith('Redpanda Connect: ')).forEach((t) => t.dispose());
		await setFolderEnvFile('a', undefined);
		await setFolderEnvFile('b', undefined);
		await setWorkspaceEnvFile(undefined);
		await setEnv(vscode.ConfigurationTarget.WorkspaceFolder, undefined, 'b');
		await setEnv(vscode.ConfigurationTarget.Global, undefined);
		await api().secrets!.clear(async () => true);
		for (const name of ['a', 'b'] as const) {
			await vscode.workspace.getConfiguration('redpandaConnect', folder(name).uri).update('secretEnv', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
		}
	});

	suiteTeardown(async () => {
		process.env.PATH = originalPath;
		await vscode.workspace.getConfiguration('redpandaConnect').update('binaryPath', undefined, vscode.ConfigurationTarget.Global);
		// A folder value leaves a folder settings file (and its `.vscode`) behind, also one an aborted run
		// left with its value: the fixture has none, so they go.
		for (const name of ['a', 'b']) {
			fs.rmSync(path.join(FIXTURE, name, '.vscode'), { recursive: true, force: true });
		}
		// A workspace value written and cleared leaves `"settings": {}`; the files go back as committed.
		for (const [file, text] of originals) {
			if (fs.readFileSync(file, 'utf8') !== text) {
				fs.writeFileSync(file, text);
			}
		}
		if (dir) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('FOLDER_VALUE: a relative envFile in folder B\'s settings resolves against B for B\'s config', async () => {
		await setFolderEnvFile('b', '.env');
		assert.strictEqual(vscode.workspace.getConfiguration('redpandaConnect', folder('b').uri).inspect('envFile')?.workspaceFolderValue, '.env');
		const got = await exercise('b');
		assert.deepStrictEqual(got, expected(got, envOf('b')));
	});

	test('OTHER_FOLDER: folder B\'s envFile does not reach folder A\'s config', async () => {
		await setFolderEnvFile('b', '.env');
		const got = await exercise('a');
		assert.deepStrictEqual(got, expected(got, null));
	});

	test('WORKSPACE_VALUE: a relative envFile only in the workspace settings resolves against the first folder, for configs in either folder', async () => {
		await setWorkspaceEnvFile('.env');
		const inA = await exercise('a');
		assert.deepStrictEqual(inA, expected(inA, envOf('a')), 'the config in A');
		const inB = await exercise('b');
		assert.deepStrictEqual(inB, expected(inB, envOf('a')), 'the config in B');
	});

	test('ticket 29 MERGE: redpandaConnect.env merges the user and folder values by name, the folder\'s winning, for that folder\'s configs only', async () => {
		await setEnv(vscode.ConfigurationTarget.Global, { A: 'user-a', B: 'user-b' });
		await setEnv(vscode.ConfigurationTarget.WorkspaceFolder, { B: 'b-b', C: 'b-c' }, 'b');
		// VS Code's `get` merges object values across levels.
		assert.deepStrictEqual(vscode.workspace.getConfiguration('redpandaConnect', folder('b').uri).get('env'), { A: 'user-a', B: 'b-b', C: 'b-c' });
		const contentsOf = (got: Argvs) => {
			const all = [...got.lint, ...got.run, ...got.parse, ...got.panel];
			assert.ok(got.lint.length > 0 && got.run.length > 0 && got.parse.length > 0 && got.panel.length > 0, JSON.stringify(got));
			return [...new Set(all.map((argv) => {
				const file = lastEnvFileOf(argv);
				assert.ok(file, argv);
				return fs.readFileSync(file, 'utf8');
			}))];
		};
		assert.deepStrictEqual(contentsOf(await exerciseArgv('b')), ['A="user-a"\nB="b-b"\nC="b-c"\n'], 'the config in B');
		assert.deepStrictEqual(contentsOf(await exerciseArgv('a')), ['A="user-a"\nB="user-b"\n'], 'the config in A');
	});

	test('ticket 29: with folder B\'s envFile, redpandaConnect.env\'s file comes after it in every command', async () => {
		await setFolderEnvFile('b', '.env');
		await setEnv(vscode.ConfigurationTarget.WorkspaceFolder, { C: 'b-c' }, 'b');
		const got = await exerciseArgv('b');
		for (const argv of [...got.lint, ...got.run, ...got.parse, ...got.panel]) {
			const files = [...argv.matchAll(/(?:^| )--env-file (\S+)/g)].map((m) => m[1]);
			assert.strictEqual(files.length, 2, argv);
			assert.strictEqual(files[0], envOf('b'));
			assert.strictEqual(fs.readFileSync(files[1], 'utf8'), 'C="b-c"\n');
		}
	});

	test('ticket 30 SET / EVERY_COMMAND: a secret set for folder B is declared in B\'s folder settings and reaches every command on B\'s config, with B\'s value; A\'s config gets A\'s', async () => {
		const seenLines = () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').split('\n').filter(Boolean) : []);
		/** The distinct `SECRET_30` lines (without the command) every command on `name`'s config saw. */
		const seenBy = async (name: FolderName) => {
			// A live parse the last change scheduled may have started before all of it was in place.
			await quiet();
			const mark = seenLines().length;
			const got = await exerciseArgv(name);
			assert.ok(got.lint.length > 0 && got.run.length > 0 && got.parse.length > 0 && got.panel.length > 0, JSON.stringify(got));
			const lines = seenLines().slice(mark);
			assert.deepStrictEqual([...new Set(lines.map((l) => l.split(' ')[0]))].sort(), ['blobl', 'lint', 'run'], JSON.stringify(lines));
			return [...new Set(lines.map((l) => l.slice(l.indexOf(' ') + 1)))];
		};
		const value = (v: string | undefined) => envCaptureLine('run', { SECRET_30: v }).slice('run '.length);
		assert.ok(await api().secrets!.set(folder('b'), 'SECRET_30', 'tok-30-secret-b'));
		const inspect = (name: FolderName) => vscode.workspace.getConfiguration('redpandaConnect', folder(name).uri).inspect('secretEnv');
		assert.deepStrictEqual(inspect('b')?.workspaceFolderValue, ['SECRET_30']);
		assert.strictEqual(inspect('a')?.workspaceFolderValue, undefined);
		assert.strictEqual(inspect('b')?.workspaceValue, undefined);
		assert.deepStrictEqual(await seenBy('b'), [value('tok-30-secret-b')], 'the config in B');
		assert.deepStrictEqual(await seenBy('a'), [value(undefined)], 'the config in A: not declared there');

		assert.ok(await api().secrets!.set(folder('a'), 'SECRET_30', 'tok-30-secret-a'));
		assert.deepStrictEqual(await seenBy('a'), [value('tok-30-secret-a')], 'the config in A');
		assert.deepStrictEqual(await seenBy('b'), [value('tok-30-secret-b')], 'the config in B keeps its own');

		// NO_LEAK: neither the folder settings nor the workspace file hold a value; nothing is logged.
		for (const file of [WORKSPACE_FILE, path.join(FIXTURE, 'a', '.vscode', 'settings.json'), path.join(FIXTURE, 'b', '.vscode', 'settings.json')]) {
			assert.ok(!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes('tok-30'), file);
		}
		assert.ok(!api().outputLines().some((l) => l.includes('tok-30')), 'no value is logged');
	});
});
