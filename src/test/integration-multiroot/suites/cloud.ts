// Where the first deploy's compute-unit choice is saved (ticket 5.3) in a real multi-root workspace:
// a config in a workspace folder → that folder's settings; one outside every folder → the workspace's.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { unitsTarget } from '../../../adapters/vscode/cloudView';
import { REPO_ROOT } from '../../helpers/fakeBinary';

suite('Cloud compute-unit setting target in a multi-root workspace (integration, ticket 5.3)', () => {
	test('a config in a folder: WorkspaceFolder; outside every folder: Workspace', () => {
		const inFolder = vscode.Uri.file(path.join(REPO_ROOT, 'test', 'multiroot', 'b', 'orders.yaml'));
		assert.ok(vscode.workspace.getWorkspaceFolder(inFolder), 'the fixture folder b is open');
		assert.strictEqual(unitsTarget(inFolder).target, vscode.ConfigurationTarget.WorkspaceFolder);
		assert.match(unitsTarget(inFolder).where, /folder b/);
		const outside = vscode.Uri.file(path.join(REPO_ROOT, 'outside-every-folder.yaml'));
		assert.strictEqual(unitsTarget(outside).target, vscode.ConfigurationTarget.Workspace);
	});
});
