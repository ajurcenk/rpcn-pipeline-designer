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
