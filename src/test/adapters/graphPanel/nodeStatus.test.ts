import * as assert from 'assert';
import * as vscode from 'vscode';
import { statusDiagnostics } from '../../../adapters/graphPanel/panels';
import { BLOBLANG_SOURCE } from '../../../adapters/vscode/bloblangDiagnostics';
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

	test('a Bloblang diagnostic (ticket 6) maps at its range start, inside the mapping\'s value', async () => {
		const text = 'pipeline:\n  processors:\n    - mapping: root = this +\n';
		const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: text });
		const bloblang = new vscode.Diagnostic(new vscode.Range(2, 27, 2, 28), 'expected thing', vscode.DiagnosticSeverity.Error);
		bloblang.source = BLOBLANG_SOURCE;
		assert.deepStrictEqual(statusDiagnostics(doc, [bloblang]), [
			{ offset: text.indexOf('+'), severity: 'error', message: 'expected thing' },
		]);
	});

	test('a Bloblang diagnostic at a line\'s end, in trailing whitespace or on a blank line (ticket 20) maps at the last non-whitespace character before it', async () => {
		const text = 'pipeline:\n  processors:\n    - mapping: |\n        root.a = 1\n        root.b = this.b *   \n\n    - mapping: root.c = this.c *';
		const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: text });
		const bloblang = (line: number, char: number, message: string, source = BLOBLANG_SOURCE) => {
			const d = new vscode.Diagnostic(new vscode.Range(line, char, line, char), message, vscode.DiagnosticSeverity.Error);
			d.source = source;
			return d;
		};
		const lastStar = text.lastIndexOf('*');
		const blockStar = text.indexOf('*');
		const diagnostics = [
			bloblang(6, doc.lineAt(6).text.length, 'end of text'),
			bloblang(4, doc.lineAt(4).text.length, 'line end after whitespace'),
			bloblang(4, doc.lineAt(4).text.indexOf('*') + 2, 'inside trailing whitespace'),
			bloblang(5, 0, 'blank line'),
			// Not at the end: unchanged.
			bloblang(3, 8, 'mid-line'),
			// Other sources at a line's end: unchanged.
			bloblang(6, doc.lineAt(6).text.length, 'red hat', 'YAML'),
		];
		assert.deepStrictEqual(statusDiagnostics(doc, diagnostics).map((d) => [d.offset, d.message]), [
			[lastStar, 'end of text'],
			[blockStar, 'line end after whitespace'],
			[blockStar, 'inside trailing whitespace'],
			[blockStar, 'blank line'],
			[text.indexOf('root.a'), 'mid-line'],
			[text.length, 'red hat'],
		]);
	});
});
