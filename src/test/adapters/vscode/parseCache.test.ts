import * as assert from 'assert';
import * as vscode from 'vscode';
import { forgetDocument, parsedDocument } from '../../../adapters/vscode/parseCache';

suite('adapters/vscode parseCache (2.12)', () => {
	test('PARSE_CACHE: one parse per document version; a new version re-parses', async () => {
		const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'input:\n  stdin: {}\n' });
		const first = parsedDocument(doc);
		assert.strictEqual(parsedDocument(doc), first, 'same version: the same entry');
		assert.strictEqual(first.text, doc.getText());
		const editor = await vscode.window.showTextDocument(doc);
		await editor.edit((e) => e.insert(new vscode.Position(0, 0), '# x\n'));
		const second = parsedDocument(doc);
		assert.notStrictEqual(second, first);
		assert.ok(second.text.startsWith('# x'));
		forgetDocument(doc.uri);
		assert.notStrictEqual(parsedDocument(doc), second, 'forgotten: parsed again');
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
	});
});
