// Pipeline snippets (ticket 2.10, CAP-5) as completion items, so they appear only where they fit:
// detected Redpanda Connect files (and the whole-pipeline starter in a blank YAML file, where a
// newcomer starts), at the top level, in an `input:` / `output:` slot or on a processor list item.

import * as vscode from 'vscode';
import { slotAt } from '../../core/gapCompletion';
import { renderSnippet, snippetSlotOf, snippetsFor } from '../../core/snippets';
import { topLevelKeys } from '../../core/yamlPath';
import { parsedDocument } from './parseCache';

export class SnippetCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private readonly isDetected: (uri: vscode.Uri) => boolean) {}

	provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
		try {
			const { text, parsed } = parsedDocument(doc);
			const offset = doc.offsetAt(position);
			const typed = typedWordAt(text, offset);
			const blank = text.trim() === '' || (typed !== undefined && !this.isDetected(doc.uri));
			if (!blank && !this.isDetected(doc.uri)) {
				return undefined;
			}
			// A blank file gets the top-level snippets, also while their prefix is typed (ticket 11).
			const slot = snippetSlotOf(slotAt(parsed, text, offset));
			if (!slot || (blank && slot !== 'root')) {
				return undefined;
			}
			const replaced = typed !== undefined && blank ? new vscode.Range(doc.positionAt(typed), position) : undefined;
			const items = snippetsFor(slot, blank ? [] : topLevelKeys(parsed)).map((s) => {
				const item = new vscode.CompletionItem({ label: s.label, description: 'snippet' }, vscode.CompletionItemKind.Snippet);
				item.insertText = new vscode.SnippetString(s.body);
				item.filterText = `${s.prefix} ${s.label}`;
				item.detail = s.description;
				item.documentation = new vscode.MarkdownString().appendCodeblock(renderSnippet(s.body), 'yaml');
				item.sortText = `~${s.label}`; // after the field and value items
				if (replaced) {
					item.range = replaced; // VS Code's YAML word stops at `-`: the whole `rpcn-…` goes
				}
				return item;
			});
			return items.length > 0 ? items : undefined;
		} catch {
			return undefined;
		}
	}
}

/**
 * Where the word typed at `offset` starts, when it is the file's only content and starts a
 * top-level snippet's prefix (`rpcn-…`, any case; ticket 11); otherwise `undefined`.
 */
function typedWordAt(text: string, offset: number): number | undefined {
	let start = offset;
	while (start > 0 && /[\w-]/.test(text[start - 1])) {
		start--;
	}
	const word = text.slice(start, offset).toLowerCase();
	if (word === '' || text.slice(0, start).trim() !== '' || text.slice(offset).trim() !== '') {
		return undefined;
	}
	return snippetsFor('root', []).some((s) => s.prefix.startsWith(word)) ? start : undefined;
}
