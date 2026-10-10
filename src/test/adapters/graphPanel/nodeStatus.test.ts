import * as assert from 'assert';
import * as vscode from 'vscode';
import { statusDiagnostics } from '../../../adapters/graphPanel/panels';
import { LINT_SOURCE } from '../../../adapters/vscode/diagnostics';

suite('adapters/graphPanel statusDiagnostics (3.8)', () => {
	test('a lint finding maps at its line\'s first non-whitespace character; others at their start', async () => {
		const text = 'pipeline:\n  processors:\n    - mapping: root = this\n\n';
		const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: text });
		const lint = new vscode.Diagnostic(doc.lineAt(2).range, 'field nope not recognised', vscode.DiagnosticSeverity.Error);
		lint.source = LINT_SOURCE;
		const blankLint = new vscode.Diagnostic(doc.lineAt(3).range, 'blank', vscode.DiagnosticSeverity.Warning);
		blankLint.source = LINT_SOURCE;
		const redHat = new vscode.Diagnostic(new vscode.Range(2, 15, 2, 19), 'precise', vscode.DiagnosticSeverity.Warning);
		redHat.source = 'YAML';
		const info = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'info', vscode.DiagnosticSeverity.Information);
		const hint = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'hint', vscode.DiagnosticSeverity.Hint);
		assert.deepStrictEqual(statusDiagnostics(doc, [lint, blankLint, redHat, info, hint]), [
			{ offset: text.indexOf('- mapping'), severity: 'error', message: 'field nope not recognised' },
			{ offset: text.indexOf('\n\n') + 1, severity: 'warning', message: 'blank' },
			{ offset: text.indexOf('root'), severity: 'warning', message: 'precise' },
			{ offset: 0, severity: 'information', message: 'info' },
			{ offset: 0, severity: 'hint', message: 'hint' },
		]);
	});
});
