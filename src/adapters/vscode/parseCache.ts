// One YAML parse per document version (ticket 2.12), shared by the completion, hover and Quick Fix
// providers: VS Code asks several of them on the same keystroke, and each used to parse the
// whole document again. Only the latest version of each document is kept.

import type * as vscode from 'vscode';
import { ParsedYaml, parseYaml } from '../../core/yamlPath';

const cache = new Map<string, { readonly version: number; readonly text: string; readonly parsed: ParsedYaml | undefined }>();

/** The document's text and its parse, computed once per version. */
export function parsedDocument(doc: vscode.TextDocument): { readonly text: string; readonly parsed: ParsedYaml | undefined } {
	const key = doc.uri.toString();
	const hit = cache.get(key);
	if (hit && hit.version === doc.version) {
		return hit;
	}
	const text = doc.getText();
	const entry = { version: doc.version, text, parsed: parseYaml(text) };
	cache.set(key, entry);
	return entry;
}

/** Drops a closed document's entry. */
export function forgetDocument(uri: vscode.Uri): void {
	cache.delete(uri.toString());
}
