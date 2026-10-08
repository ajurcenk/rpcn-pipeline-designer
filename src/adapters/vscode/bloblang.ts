// Bloblang completion and hover (AD-14 amended, ticket 2.19): functions and methods from the
// binary's docs (carried in the served schema), inside Bloblang only. The context rules and
// docs are pure (`src/core/bloblang.ts`); this module maps them to VS Code items.

import * as vscode from 'vscode';
import {
	bloblangCatalogOf, bloblangContext, bloblangHoverAt, bloblangItems, bloblangMarkdown, bloblangSnippet,
} from '../../core/bloblang';
import type { JsonObject } from '../../core/schema';
import { parseYaml } from '../../core/yamlPath';

export interface BloblangProviderOptions {
	readonly schema: () => JsonObject | undefined;
	readonly isDetected: (uri: vscode.Uri) => boolean;
}

export class BloblangProvider implements vscode.CompletionItemProvider, vscode.HoverProvider {
	static readonly triggerCharacters = ['.'];

	constructor(private readonly options: BloblangProviderOptions) {}

	provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
		try {
			const schema = this.options.schema();
			const catalog = schema && this.options.isDetected(doc.uri) ? bloblangCatalogOf(schema) : undefined;
			if (!catalog) {
				return undefined;
			}
			const text = doc.getText();
			const context = bloblangContext(parseYaml(text), text, doc.offsetAt(position));
			if (!context) {
				return undefined;
			}
			// Replace the whole word under the cursor; keep an existing `(` instead of adding a second.
			const offset = doc.offsetAt(position);
			const wordEnd = offset + (/^\w*/.exec(text.slice(offset))?.[0].length ?? 0);
			const parenFollows = /^\s*\(/.test(text.slice(wordEnd));
			const range = { inserting: new vscode.Range(doc.positionAt(context.start), position),
				replacing: new vscode.Range(doc.positionAt(context.start), doc.positionAt(wordEnd)) };
			return bloblangItems(catalog, context).map((entry, i) => {
				const item = new vscode.CompletionItem(entry.name,
					entry.kind === 'method' ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Function);
				item.insertText = new vscode.SnippetString(bloblangSnippet(entry, parenFollows));
				item.range = range;
				item.detail = `${entry.kind}${entry.category ? ` · ${entry.category}` : ''}`;
				item.documentation = new vscode.MarkdownString(bloblangMarkdown(entry));
				item.sortText = String(i).padStart(4, '0');
				if (entry.status === 'deprecated') {
					item.tags = [vscode.CompletionItemTag.Deprecated];
				}
				return item;
			});
		} catch {
			return undefined;
		}
	}

	provideHover(doc: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		try {
			const schema = this.options.schema();
			const catalog = schema && this.options.isDetected(doc.uri) ? bloblangCatalogOf(schema) : undefined;
			if (!catalog) {
				return undefined;
			}
			const text = doc.getText();
			const found = bloblangHoverAt(catalog, parseYaml(text), text, doc.offsetAt(position));
			return found
				? new vscode.Hover(new vscode.MarkdownString(bloblangMarkdown(found.entry)),
					new vscode.Range(doc.positionAt(found.start), doc.positionAt(found.end)))
				: undefined;
		} catch {
			return undefined;
		}
	}
}
