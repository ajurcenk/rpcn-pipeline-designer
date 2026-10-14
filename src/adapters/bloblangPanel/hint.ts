// The end-of-line hint of a failed test run (ticket 4.8, E4 R6): while a panel's latest result is
// `failed` with a file line, that line of the YAML editor ends with ` ✕ fails on this input`, an
// `after` decoration in the theme's error foreground, italic. One decoration type serves every
// panel; each panel sets or clears its own line, and the hints of all panels on a document are
// applied together to each visible editor of it (again whenever the visible editors change).

import * as vscode from 'vscode';

export const HINT_TEXT = ' ✕ fails on this input';

interface Hint {
	readonly uri: string;
	/** 0-based document line. */
	readonly line: number;
}

/** The hints of every Bloblang panel, by panel key. */
export class BloblangHints implements vscode.Disposable {
	private readonly hints = new Map<string, Hint>();
	private readonly type: vscode.TextEditorDecorationType;
	private readonly subscription: vscode.Disposable;

	constructor() {
		this.type = vscode.window.createTextEditorDecorationType({
			after: { contentText: HINT_TEXT, color: new vscode.ThemeColor('errorForeground'), fontStyle: 'italic' },
		});
		this.subscription = vscode.window.onDidChangeVisibleTextEditors((editors) => {
			for (const editor of editors) {
				this.apply(editor);
			}
		});
	}

	/** Sets the hint of panel `key` on 0-based `line` of `uri` (and reapplies it), or clears it (`undefined`). */
	set(key: string, uri: vscode.Uri, line: number | undefined): void {
		const old = this.hints.get(key);
		if (line === undefined) {
			if (!old) {
				return;
			}
			this.hints.delete(key);
		} else {
			// Set again even when unchanged: an edit may have moved the line's end.
			this.hints.set(key, { uri: uri.toString(), line });
		}
		this.refresh(uri.toString());
		if (old && old.uri !== uri.toString()) {
			this.refresh(old.uri);
		}
	}

	/** The hints' current ranges in `uri`'s open document, at each line's end (test seam). */
	ranges(uri: vscode.Uri): vscode.Range[] {
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
		return doc ? this.rangesIn(doc) : [];
	}

	private rangesIn(doc: vscode.TextDocument): vscode.Range[] {
		const key = doc.uri.toString();
		const lines = new Set<number>();
		for (const hint of this.hints.values()) {
			if (hint.uri === key && hint.line < doc.lineCount) {
				lines.add(hint.line);
			}
		}
		return [...lines].sort((a, b) => a - b).map((line) => {
			const end = doc.lineAt(line).range.end;
			return new vscode.Range(end, end);
		});
	}

	private refresh(uri: string): void {
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.uri.toString() === uri) {
				this.apply(editor);
			}
		}
	}

	private apply(editor: vscode.TextEditor): void {
		editor.setDecorations(this.type, this.rangesIn(editor.document));
	}

	dispose(): void {
		this.hints.clear();
		this.subscription.dispose();
		this.type.dispose();
	}
}
