import * as assert from 'assert';
import * as vscode from 'vscode';
import { newVariableLevel } from '../../../adapters/vscode/environmentView';

const folder = { uri: vscode.Uri.file('/w/b'), name: 'b', index: 0 } as vscode.WorkspaceFolder;

// Ticket 31: where a new plain variable goes, by the number of workspace folders (as the README says).
suite('adapters/vscode environmentView', () => {
	test('a new plain variable: folder settings with several folders, workspace settings with one (also from a .code-workspace), user settings without', () => {
		assert.strictEqual(newVariableLevel(folder, 2), 'folder');
		assert.strictEqual(newVariableLevel(folder, 1), 'workspace');
		assert.strictEqual(newVariableLevel(undefined, 2), 'user', 'a config in no folder');
		assert.strictEqual(newVariableLevel(undefined, 0), 'user');
	});
});
