import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { STOP_GRACE_MS } from '../../../adapters/vscode/run';
import { type ExtensionApi } from '../../../extension';
import { makeTempDir, REPO_ROOT } from '../../helpers/fakeBinary';
import { EXTENSION_ID, waitFor } from '../helpers';

// Ticket 9: Run and Stop (2.7) with the pinned real binaries from scripts/spike/fetch-binaries.sh,
// never the user's installed rpk, redpanda-connect or managed connect (taken off PATH; binaryPath
// points at the cached binary). Without a cached binary a version is skipped locally and fails in
// CI (`CI` set), as in the corpus harness.
const VERSIONS = ['4.100.0', '4.112.0'];
const IN_CI = !!process.env.CI && process.env.CI !== 'false';
const FIXTURE = path.join(REPO_ROOT, 'test', 'corpus', 'fixtures', 'run_generate.yaml');
const binaryOf = (ver: string) => path.join(REPO_ROOT, '.cache', 'redpanda-connect', ver, 'redpanda-connect');
/** As the corpus harness's `hasBinary`: the cached binary exists and is executable. */
function hasBinary(ver: string): boolean {
	try {
		fs.accessSync(binaryOf(ver), fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

suite('Run and Stop with a real binary (integration, ticket 9)', function () {
	// Longer than the waits of one test added up (about 125 s), so a slow run fails on its own message.
	this.timeout(180_000);
	const originalPath = process.env.PATH;
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const config = () => vscode.workspace.getConfiguration('redpandaConnect');
	const runTerminals = () => vscode.window.terminals.filter((t) => t.name === 'Redpanda Connect: run_generate.yaml');
	const ticks = (uri: vscode.Uri) => (api().run.outputOf(uri) ?? '').split('tick').length - 1;

	suiteSetup(() => {
		process.env.PATH = (originalPath ?? '').split(path.delimiter)
			.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
			.join(path.delimiter);
	});

	suiteTeardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		runTerminals().forEach((t) => t.dispose());
		process.env.PATH = originalPath;
		await config().update('binaryPath', undefined, vscode.ConfigurationTarget.Global);
	});

	// Ticket 29: what the pipeline sees with `redpandaConnect.env`, the env file and the process
	// environment all naming WINS; `env()` and `${…}` read the same variables.
	const ESCAPES = 'a b # c "q" back\\slash\nnew\rcr $X ${HOME} ünïcødé ✓';
	const ENV_CONFIG = [
		'input:',
		'  generate:',
		'    count: 1',
		'    interval: ""',
		'    mapping: |',
		'      root.wins = env("WINS")',
		'      root.interpolated = "${WINS}"',
		'      root.file_only = env("FILE_ONLY")',
		'      root.process_only = env("PROCESS_ONLY")',
		'      root.escapes = env("ESCAPES")',
		'      root.empty = env("EMPTY")',
		'output:',
		'  stdout: {}',
		'logger:',
		'  level: off',
		'',
	].join('\n');
	for (const ver of VERSIONS) {
		test(`ticket 29 WINS / ESCAPES / CHANGED with Redpanda Connect ${ver}: redpandaConnect.env beats the env file and the process env; values arrive exactly`, async function () {
			const bin = binaryOf(ver);
			if (!hasBinary(ver)) {
				const message = `no cached executable Redpanda Connect ${ver} at ${bin}: run scripts/spike/fetch-binaries.sh`;
				if (IN_CI) {
					assert.fail(message);
				}
				console.warn(`skipped: ${message}`);
				this.skip();
			}
			const dir = makeTempDir(`rpcn-run-env-${ver}-`);
			const saved = { WINS: process.env.WINS, PROCESS_ONLY: process.env.PROCESS_ONLY };
			try {
				process.env.WINS = 'from-process';
				process.env.PROCESS_ONLY = 'p';
				await config().update('binaryPath', bin, vscode.ConfigurationTarget.Global);
				assert.ok(await waitFor(() => {
					const state = api().redpandaConnect.state;
					return state.kind === 'ok' && state.path === bin && state.version === ver;
				}, 30_000), `the extension resolved ${bin}: ${JSON.stringify(api().redpandaConnect.state)}`);
				const envFile = path.join(dir, 'user.env');
				fs.writeFileSync(envFile, 'WINS=from-file\nFILE_ONLY=f\n');
				await config().update('envFile', envFile, vscode.ConfigurationTarget.Global);
				await config().update('env', { WINS: 'from-setting', ESCAPES, EMPTY: '' }, vscode.ConfigurationTarget.Global);
				const file = path.join(dir, 'env_values.yaml');
				fs.writeFileSync(file, ENV_CONFIG);
				const doc = await vscode.workspace.openTextDocument(file);
				await vscode.window.showTextDocument(doc);
				assert.ok(await waitFor(() => api().detection.isDetected(doc.uri), 5_000));
				/** Runs the config (it ends after its one message) and returns the message. */
				const runOnce = async (): Promise<Record<string, string | null>> => {
					const runs = (api().run.outputOf(doc.uri) ?? '').split('"wins"').length;
					await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
					assert.ok(await waitFor(() => (api().run.outputOf(doc.uri) ?? '').split('"wins"').length > runs
						&& api().run.phaseOf(doc.uri) === 'exited', 30_000), `no message: ${JSON.stringify(api().run.outputOf(doc.uri))}`);
					const messages = (api().run.outputOf(doc.uri) ?? '').match(/\{"[^\r\n]*\}/g) ?? [];
					return JSON.parse(messages[messages.length - 1]) as Record<string, string | null>;
				};
				assert.deepStrictEqual(await runOnce(), {
					wins: 'from-setting', interpolated: 'from-setting', file_only: 'f', process_only: 'p', escapes: ESCAPES, empty: '',
				});
				// CHANGED: an edit of the setting reaches the next run, no restart.
				await config().update('env', { WINS: 'changed' }, vscode.ConfigurationTarget.Global);
				const changed = await runOnce();
				assert.strictEqual(changed.wins, 'changed');
				assert.strictEqual(changed.escapes, null, 'a variable no longer set is not passed');
			} finally {
				for (const [name, value] of Object.entries(saved)) {
					if (value === undefined) {
						delete process.env[name];
					} else {
						process.env[name] = value;
					}
				}
				await config().update('env', undefined, vscode.ConfigurationTarget.Global);
				await config().update('envFile', undefined, vscode.ConfigurationTarget.Global);
				await vscode.commands.executeCommand('workbench.action.closeAllEditors');
				vscode.window.terminals.filter((t) => t.name === 'Redpanda Connect: env_values.yaml').forEach((t) => t.dispose());
				await waitFor(() => !vscode.window.terminals.some((t) => t.name === 'Redpanda Connect: env_values.yaml'), 10_000);
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	// Ticket 30: a secret the env file or `redpandaConnect.env` also sets loses to them; one only the
	// secret storage holds arrives, through `env()` and `${…}` alike.
	const SECRET_CONFIG = [
		'input:',
		'  generate:',
		'    count: 1',
		'    interval: ""',
		'    mapping: |',
		'      root.secret = env("SECRET_30")',
		'      root.interpolated = "${SECRET_30}"',
		'      root.file_clash = env("FILE_CLASH_30")',
		'      root.env_clash = env("ENV_CLASH_30")',
		'output:',
		'  stdout: {}',
		'logger:',
		'  level: off',
		'',
	].join('\n');
	for (const ver of VERSIONS) {
		test(`ticket 30 EVERY_COMMAND / CLASH with Redpanda Connect ${ver}: a stored secret reaches the pipeline; the env file and redpandaConnect.env win over it`, async function () {
			const bin = binaryOf(ver);
			if (!hasBinary(ver)) {
				const message = `no cached executable Redpanda Connect ${ver} at ${bin}: run scripts/spike/fetch-binaries.sh`;
				if (IN_CI) {
					assert.fail(message);
				}
				console.warn(`skipped: ${message}`);
				this.skip();
			}
			const dir = makeTempDir(`rpcn-run-secret-${ver}-`);
			const secrets = api().secrets!;
			try {
				await config().update('binaryPath', bin, vscode.ConfigurationTarget.Global);
				assert.ok(await waitFor(() => {
					const state = api().redpandaConnect.state;
					return state.kind === 'ok' && state.path === bin && state.version === ver;
				}, 30_000), `the extension resolved ${bin}: ${JSON.stringify(api().redpandaConnect.state)}`);
				const envFile = path.join(dir, 'user.env');
				fs.writeFileSync(envFile, 'FILE_CLASH_30=from-file\n');
				await config().update('envFile', envFile, vscode.ConfigurationTarget.Global);
				await config().update('env', { ENV_CLASH_30: 'from-setting' }, vscode.ConfigurationTarget.Global);
				for (const name of ['SECRET_30', 'FILE_CLASH_30', 'ENV_CLASH_30']) {
					assert.ok(await secrets.set(undefined, name, `tok-30-secret-${name}`));
				}
				const file = path.join(dir, 'secret_values.yaml');
				fs.writeFileSync(file, SECRET_CONFIG);
				const doc = await vscode.workspace.openTextDocument(file);
				await vscode.window.showTextDocument(doc);
				assert.ok(await waitFor(() => api().detection.isDetected(doc.uri), 5_000));
				await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
				assert.ok(await waitFor(() => (api().run.outputOf(doc.uri) ?? '').includes('"secret"')
					&& api().run.phaseOf(doc.uri) === 'exited', 30_000), `no message: ${JSON.stringify(api().run.outputOf(doc.uri))}`);
				const messages = (api().run.outputOf(doc.uri) ?? '').match(/\{"[^\r\n]*\}/g) ?? [];
				assert.deepStrictEqual(JSON.parse(messages[messages.length - 1]), {
					secret: 'tok-30-secret-SECRET_30', interpolated: 'tok-30-secret-SECRET_30', file_clash: 'from-file', env_clash: 'from-setting',
				});
				const clashes = api().outputLines().filter((l) => l.startsWith('redpandaConnect.secretEnv: ') && l.includes(' is also set by '));
				assert.ok(clashes.some((l) => l.startsWith('redpandaConnect.secretEnv: FILE_CLASH_30 is also set by the redpandaConnect.envFile file')), JSON.stringify(clashes));
				assert.ok(clashes.some((l) => l.startsWith('redpandaConnect.secretEnv: ENV_CLASH_30 is also set by redpandaConnect.env')), JSON.stringify(clashes));
				assert.ok(!api().outputLines().some((l) => l.includes('tok-30-secret')), 'no value is logged');
				// The terminal shows the argv, not the environment: the value is only in the pipeline's own output.
				const argvLine = (api().run.outputOf(doc.uri) ?? '').split('\n').find((l) => l.includes('$ '));
				assert.ok(argvLine && !argvLine.includes('tok-30-secret'), argvLine);
			} finally {
				await secrets.clear(async () => true);
				await config().update('secretEnv', undefined, vscode.ConfigurationTarget.Global);
				await config().update('env', undefined, vscode.ConfigurationTarget.Global);
				await config().update('envFile', undefined, vscode.ConfigurationTarget.Global);
				await vscode.commands.executeCommand('workbench.action.closeAllEditors');
				vscode.window.terminals.filter((t) => t.name === 'Redpanda Connect: secret_values.yaml').forEach((t) => t.dispose());
				await waitFor(() => !vscode.window.terminals.some((t) => t.name === 'Redpanda Connect: secret_values.yaml'), 10_000);
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	for (const ver of VERSIONS) {
		test(`RUN / STOP / RERUN with Redpanda Connect ${ver}: output streams, Stop ends it with "Pipeline stopped", Run again reuses the terminal`, async function () {
			const bin = binaryOf(ver);
			if (!hasBinary(ver)) {
				const message = `no cached executable Redpanda Connect ${ver} at ${bin}: run scripts/spike/fetch-binaries.sh`;
				if (IN_CI) {
					assert.fail(message);
				}
				console.warn(`skipped: ${message}`);
				this.skip();
			}
			const dir = makeTempDir(`rpcn-run-real-${ver}-`);
			try {
				await config().update('binaryPath', bin, vscode.ConfigurationTarget.Global);
				assert.ok(await waitFor(() => {
					const state = api().redpandaConnect.state;
					return state.kind === 'ok' && state.path === bin && state.version === ver;
				}, 30_000), `the extension resolved ${bin}: ${JSON.stringify(api().redpandaConnect.state)}`);
				const file = path.join(dir, 'run_generate.yaml');
				fs.copyFileSync(FIXTURE, file);
				const doc = await vscode.workspace.openTextDocument(file);
				await vscode.window.showTextDocument(doc);
				assert.ok(api().detection.isDetected(doc.uri));

				// AC 1: the generated message shows in the file's terminal while the pipeline runs.
				await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
				assert.ok(await waitFor(() => ticks(doc.uri) >= 1, 30_000), `no message in the terminal: ${JSON.stringify(api().run.outputOf(doc.uri))}`);
				assert.strictEqual(api().run.phaseOf(doc.uri), 'running', 'still running after its message');
				assert.strictEqual(runTerminals().length, 1);
				const terminal = runTerminals()[0];

				// AC 2: Stop ends it within the grace period; the status bar says so.
				const stopped = Date.now();
				await vscode.commands.executeCommand('redpandaConnect.stop', doc.uri);
				assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'exited', STOP_GRACE_MS + 5_000), 'the run did not end');
				assert.ok(Date.now() - stopped < STOP_GRACE_MS, `ended after the grace period (${Date.now() - stopped} ms)`);
				await vscode.window.showTextDocument(doc);
				assert.ok(await waitFor(() => api().run.statusBarText?.includes('Pipeline stopped') === true, 5_000), `status bar: ${api().run.statusBarText}`);

				// AC 3: Run again reuses the same terminal.
				const before = ticks(doc.uri);
				await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
				assert.ok(await waitFor(() => ticks(doc.uri) > before, 30_000), 'no message from the second run');
				assert.deepStrictEqual(runTerminals(), [terminal], 'the same terminal is reused');
				await vscode.commands.executeCommand('redpandaConnect.stop', doc.uri);
				assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'exited', STOP_GRACE_MS + 5_000));
			} finally {
				await vscode.commands.executeCommand('workbench.action.closeAllEditors');
				runTerminals().forEach((t) => t.dispose());
				// The next version's terminal has the same name: this one must be gone first.
				await waitFor(() => runTerminals().length === 0, 10_000);
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});
