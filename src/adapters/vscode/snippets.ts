// Pipeline snippets (ticket 2.10, CAP-5) as completion items, so they appear only where they fit:
// detected Redpanda Connect files (and the whole-pipeline starter in a blank YAML file, where a
// newcomer starts), at the top level, in an `input:` / `output:` slot or on a processor list item.

import * as vscode from 'vscode';
import { slotAt } from '../../core/gapCompletion';
import { renderSnippet, snippetSlotOf, snippetsFor } from '../../core/snippets';
import { parseYaml, topLevelKeys } from '../../core/yamlPath';

export class SnippetCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private readonly isDetected: (uri: vscode.Uri) => boolean) {}

	provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
		try {
			const text = doc.getText();
			const blank = text.trim() === '';
			if (!blank && !this.isDetected(doc.uri)) {
				return undefined;
			}
			const parsed = parseYaml(text);
			const slot = snippetSlotOf(slotAt(parsed, text, doc.offsetAt(position)));
			if (!slot || (blank && slot !== 'root')) {
				return undefined;
			}
			const items = snippetsFor(slot, topLevelKeys(parsed)).map((s) => {
				const item = new vscode.CompletionItem({ label: s.label, description: 'snippet' }, vscode.CompletionItemKind.Snippet);
				item.insertText = new vscode.SnippetString(s.body);
				item.filterText = `${s.prefix} ${s.label}`;
				item.detail = s.description;
				item.documentation = new vscode.MarkdownString().appendCodeblock(renderSnippet(s.body), 'yaml');
				item.sortText = `~${s.label}`; // after the field and value items
				return item;
			});
			return items.length > 0 ? items : undefined;
		} catch {
			return undefined;
		}
	}
}
