// Quick Fixes on our lint diagnostics (CAP-3): "Change to `<name>`" for
//   - `field X not recognised` → the closest field names valid at that position (2.5), and
//   - `value X is not a valid option for this field` → the closest options of that field (2.14).
// Each fix replaces only the key or value token (AD-19). The YAML lookup, schema walk, ranking and
// quoting are pure (`src/core`); this module maps between documents and offsets.

import * as vscode from 'vscode';
import type { JsonObject } from '../../core/schema';
import { candidateFields, optionsAt } from '../../core/schemaFields';
import { hasClearWinner, rankNames, Suggestion } from '../../core/suggest';
import { findKeyOnLine, findValueOnLine, ParsedYaml, parseYaml, yamlString } from '../../core/yamlPath';
import { LINT_SOURCE } from './diagnostics';

const UNKNOWN_FIELD = /^field (\S+) not recognised$/;
const INVALID_OPTION = /^value (.+) is not a valid option for this field$/;
/** With no close option, a closed list this short is offered whole (2.14). */
export const MAX_FALLBACK_OPTIONS = 5;

export class LintQuickFix implements vscode.CodeActionProvider {
	static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

	/** `schema` returns the current transformed schema, or `undefined` when there is none. */
	constructor(private readonly schema: () => JsonObject | undefined) {}

	provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
		try {
			const schema = this.schema();
			if (!schema) {
				return [];
			}
			const ours = context.diagnostics.filter((d) => d.source === LINT_SOURCE
				&& (UNKNOWN_FIELD.test(d.message) || INVALID_OPTION.test(d.message)));
			if (ours.length === 0) {
				return [];
			}
			const parsed = parseYaml(doc.getText()); // once per request, whatever the number of diagnostics
			return ours.flatMap((diagnostic) => {
				const field = UNKNOWN_FIELD.exec(diagnostic.message);
				return field
					? this.fieldFixes(doc, parsed, diagnostic, schema, field[1])
					: this.optionFixes(doc, parsed, diagnostic, schema, INVALID_OPTION.exec(diagnostic.message)![1]);
			});
		} catch {
			return [];
		}
	}

	private fieldFixes(
		doc: vscode.TextDocument, parsed: ParsedYaml | undefined, diagnostic: vscode.Diagnostic, schema: JsonObject, key: string,
	): vscode.CodeAction[] {
		const location = findKeyOnLine(parsed, diagnostic.range.start.line + 1, key);
		const fields = location && candidateFields(schema, location.path, location.siblings);
		if (!location || !fields) {
			return [];
		}
		const ranked = rankNames(key, fields, location.siblings);
		// Preferred (Auto Fix) only for a clear winner, never for an alphabetical tie-break.
		return actions(doc, diagnostic, location, ranked, hasClearWinner(ranked), (name) => name);
	}

	private optionFixes(
		doc: vscode.TextDocument, parsed: ParsedYaml | undefined, diagnostic: vscode.Diagnostic, schema: JsonObject, value: string,
	): vscode.CodeAction[] {
		const location = findValueOnLine(parsed, diagnostic.range.start.line + 1, value);
		const options = location ? optionsAt(schema, location.path, location.key) : [];
		if (!location || options.length === 0) {
			return [];
		}
		const ranked = rankNames(value, options, [], true);
		if (ranked.length > 0) {
			return actions(doc, diagnostic, location, ranked, hasClearWinner(ranked), yamlString);
		}
		// Nothing close: a short closed list is offered whole, none preferred.
		const all = options.length <= MAX_FALLBACK_OPTIONS ? [...options].sort().map((name) => ({ name, distance: 0 })) : [];
		return actions(doc, diagnostic, location, all, false, yamlString);
	}
}

function actions(
	doc: vscode.TextDocument,
	diagnostic: vscode.Diagnostic,
	location: { readonly start: number; readonly end: number },
	ranked: readonly Suggestion[],
	preferred: boolean,
	source: (name: string) => string,
): vscode.CodeAction[] {
	const range = new vscode.Range(doc.positionAt(location.start), doc.positionAt(location.end));
	return ranked.map(({ name }, i) => {
		const action = new vscode.CodeAction(`Change to \`${name}\``, vscode.CodeActionKind.QuickFix);
		action.diagnostics = [diagnostic];
		action.isPreferred = preferred && i === 0;
		action.edit = new vscode.WorkspaceEdit();
		action.edit.replace(doc.uri, range, source(name));
		return action;
	});
}
