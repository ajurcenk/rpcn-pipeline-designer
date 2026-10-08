// Bloblang completion and hover (AD-14 amended, ticket 2.19): functions and methods from the
// binary's docs (carried in the served schema), inside Bloblang only. The context rules and
// docs are pure (`src/core/bloblang.ts`); this module maps them to VS Code items.

import * as vscode from 'vscode';
import {
	bloblangCatalogOf, bloblangContext, bloblangHoverAt, bloblangItems, bloblangMarkdown, bloblangSnippet,
} from '../../core/bloblang';
import type { JsonObject } from '../../core/schema';
import { fieldSuggestions, knownNames, nameSuggestions, NameSuggestion, originText } from '../../core/bloblangNames';
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
			const parsed = parseYaml(text);
			const context = bloblangContext(parsed, text, doc.offsetAt(position));
			if (!context) {
				return undefined;
			}
			// Replace the whole word under the cursor; keep an existing `(` instead of adding a second.
			const offset = doc.offsetAt(position);
			const wordEnd = offset + (/^\w*/.exec(text.slice(offset))?.[0].length ?? 0);
			const parenFollows = /^\s*\(/.test(text.slice(wordEnd));
			const range = { inserting: new vscode.Range(doc.positionAt(context.start), position),
				replacing: new vscode.Range(doc.positionAt(context.start), doc.positionAt(wordEnd)) };
			// Names already written above the cursor (2.20): fields after `this.` / `root.`, `$` variables, `@` metadata.
			const names = context.receiver || context.kind === 'variable' || context.kind === 'metadata'
				? knownNames(parsed, text, offset, context) : undefined;
			const suggestions: NameSuggestion[] = !names ? []
				: context.kind === 'variable' ? nameSuggestions(names.variables)
					: context.kind === 'metadata' ? nameSuggestions(names.metadata)
						: fieldSuggestions(names, context.receiver!.path);
			const nameItems = suggestions.map((s, i) => {
				const item = new vscode.CompletionItem(s.name, context.kind === 'method'
					? vscode.CompletionItemKind.Field : vscode.CompletionItemKind.Variable);
				item.range = range;
				item.detail = originText(s);
				const shown = context.kind === 'variable' ? `$${s.name}` : context.kind === 'metadata' ? `@${s.name}`
					: [context.receiver!.base, ...(s.path ?? [])].join('.');
				item.documentation = new vscode.MarkdownString(`\`${shown}\` — ${originText(s)}${s.hasChildren ? '; it has known fields of its own' : ''}.`);
				item.sortText = `0${String(i).padStart(4, '0')}`;
				return item;
			});
			const catalogItems = bloblangItems(catalog, context).map((entry, i) => {
				const item = new vscode.CompletionItem(entry.name,
					entry.kind === 'method' ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Function);
				item.insertText = new vscode.SnippetString(bloblangSnippet(entry, parenFollows));
				item.range = range;
				item.detail = `${entry.kind}${entry.category ? ` · ${entry.category}` : ''}`;
				item.documentation = new vscode.MarkdownString(bloblangMarkdown(entry));
				item.sortText = `1${String(i).padStart(4, '0')}`;
				if (entry.status === 'deprecated') {
					item.tags = [vscode.CompletionItemTag.Deprecated];
				}
				return item;
			});
			const items = [...nameItems, ...catalogItems];
			return items.length > 0 ? items : undefined;
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
