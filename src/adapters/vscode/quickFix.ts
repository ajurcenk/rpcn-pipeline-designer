// Quick Fix for unknown fields (2.5, CAP-3): for our lint diagnostic `field X not recognised`,
// offers "Change to `<name>`" for the closest field names valid at that position in the
// current schema. Each fix replaces only the key token (AD-19). The YAML lookup, schema walk and
// ranking are pure (`src/core`); this module maps between documents and offsets.

import * as vscode from 'vscode';
import type { JsonObject } from '../../core/schema';
import { candidateFields } from '../../core/schemaFields';
import { hasClearWinner, rankNames } from '../../core/suggest';
import { findKeyOnLine, ParsedYaml, parseYaml } from '../../core/yamlPath';
import { LINT_SOURCE } from './diagnostics';

const UNKNOWN_FIELD = /^field (\S+) not recognised$/;

export class UnknownFieldQuickFix implements vscode.CodeActionProvider {
	static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

	/** `schema` returns the current transformed schema, or `undefined` when there is none. */
	constructor(private readonly schema: () => JsonObject | undefined) {}

	provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
		try {
			const schema = this.schema();
			if (!schema) {
				return [];
			}
			const ours = context.diagnostics.filter((d) => d.source === LINT_SOURCE && UNKNOWN_FIELD.test(d.message));
			if (ours.length === 0) {
				return [];
			}
			const parsed = parseYaml(doc.getText()); // once per request, whatever the number of diagnostics
			return ours.flatMap((diagnostic) => this.fixesFor(doc, parsed, diagnostic, schema));
		} catch {
			return [];
		}
	}

	private fixesFor(
		doc: vscode.TextDocument, parsed: ParsedYaml | undefined, diagnostic: vscode.Diagnostic, schema: JsonObject,
	): vscode.CodeAction[] {
		const key = UNKNOWN_FIELD.exec(diagnostic.message)![1];
		const location = findKeyOnLine(parsed, diagnostic.range.start.line + 1, key);
		const fields = location && candidateFields(schema, location.path, location.siblings);
		if (!location || !fields) {
			return [];
		}
		const range = new vscode.Range(doc.positionAt(location.start), doc.positionAt(location.end));
		const ranked = rankNames(key, fields, location.siblings);
		// Preferred (Auto Fix) only for a clear winner, never for an alphabetical tie-break.
		const preferred = hasClearWinner(ranked);
		return ranked.map(({ name }, i) => {
			const action = new vscode.CodeAction(`Change to \`${name}\``, vscode.CodeActionKind.QuickFix);
			action.diagnostics = [diagnostic];
			action.isPreferred = preferred && i === 0;
			action.edit = new vscode.WorkspaceEdit();
			action.edit.replace(doc.uri, range, name);
			return action;
		});
	}
}
