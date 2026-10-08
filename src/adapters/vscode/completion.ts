// Completion where Red Hat returns none (AD-11 amended, ticket 2.16): for detected files, items
// from the served schema in the gaps `src/core/gapCompletion.ts` recognises (an empty block or an
// empty value inside a component). Silent everywhere else.

import * as vscode from 'vscode';
import { gapContext, gapItems } from '../../core/gapCompletion';
import type { JsonObject } from '../../core/schema';
import { parseYaml } from '../../core/yamlPath';

export interface GapCompletionOptions {
	readonly schema: () => JsonObject | undefined;
	readonly isDetected: (uri: vscode.Uri) => boolean;
}

export class GapCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private readonly options: GapCompletionOptions) {}

	provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
		try {
			const schema = this.options.schema();
			if (!schema || !this.options.isDetected(doc.uri)) {
				return undefined;
			}
			const text = doc.getText();
			const context = gapContext(parseYaml(text), text, doc.offsetAt(position));
			if (!context) {
				return undefined;
			}
			const items = gapItems(schema, context);
			return items.length === 0 ? undefined : items.map((item, i) => {
				const ci = new vscode.CompletionItem(item.label,
					item.kind === 'field' ? vscode.CompletionItemKind.Property : vscode.CompletionItemKind.Value);
				ci.insertText = new vscode.SnippetString(item.snippet);
				if (item.documentation) {
					ci.documentation = new vscode.MarkdownString(item.documentation);
				}
				ci.sortText = String(i).padStart(4, '0');
				if (item.deprecated) {
					ci.tags = [vscode.CompletionItemTag.Deprecated];
				}
				return ci;
			});
		} catch {
			return undefined;
		}
	}
}
