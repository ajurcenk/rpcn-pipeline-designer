// Quick Fixes on our lint diagnostics (CAP-3): "Change to `<name>`" for
//   - `field X not recognised` → the closest field names valid at that position (2.5), and
//   - `value X is not a valid option for this field` → the closest options of that field (2.14).
// Each fix replaces only the key or value token (AD-19). The YAML lookup, schema walk, ranking and
// quoting are pure (`src/core`); this module maps between documents and offsets.
// "Fix all lint findings with a clear fix (N)" (2.22) applies, as one edit, the preferred fix of every
// lint finding in the file that has one: the first edit after a save clears all findings (AD-17), so
// without it each fix would need its own save.

import * as vscode from 'vscode';
import type { JsonObject } from '../../core/schema';
import { candidateFields, optionsAt } from '../../core/schemaFields';
import { hasClearWinner, rankNames, Suggestion } from '../../core/suggest';
import { findKeyOnLine, findValueOnLine, ParsedYaml, yamlString } from '../../core/yamlPath';
import { parsedDocument } from './parseCache';
import { LINT_SOURCE } from './diagnostics';

const UNKNOWN_FIELD = /^field (\S+) not recognised$/;
const INVALID_OPTION = /^value (.+) is not a valid option for this field$/;
const handled = (d: vscode.Diagnostic) => d.source === LINT_SOURCE && (UNKNOWN_FIELD.test(d.message) || INVALID_OPTION.test(d.message));
/** With no close option, a closed list this short is offered whole (2.14). */
export const MAX_FALLBACK_OPTIONS = 5;

export class LintQuickFix implements vscode.CodeActionProvider {
	static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

	/**
	 * `schema` returns the current transformed schema, or `undefined` when there is none.
	 * `allDiagnostics` returns every diagnostic shown for a document (for Fix all, which covers the whole file).
	 */
	constructor(
		private readonly schema: () => JsonObject | undefined,
		private readonly allDiagnostics: (uri: vscode.Uri) => readonly vscode.Diagnostic[] = (uri) => vscode.languages.getDiagnostics(uri),
	) {}

	provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
		try {
			const schema = this.schema();
			if (!schema) {
				return [];
			}
			const ours = context.diagnostics.filter(handled);
			if (ours.length === 0) {
				return [];
			}
			const { parsed } = parsedDocument(doc); // once per document version, shared with the other providers
			const fixes = (diagnostic: vscode.Diagnostic) => {
				const field = UNKNOWN_FIELD.exec(diagnostic.message);
				return field
					? this.fieldFixes(doc, parsed, diagnostic, schema, field[1])
					: this.optionFixes(doc, parsed, diagnostic, schema, INVALID_OPTION.exec(diagnostic.message)![1]);
			};
			const perFinding = ours.flatMap(fixes);
			let all: vscode.CodeAction | undefined;
			try {
				all = this.fixAll(doc, fixes);
			} catch {
				all = undefined; // the per-finding fixes still stand
			}
			return all ? [...perFinding, all] : perFinding;
		} catch {
			return [];
		}
	}

	/**
	 * One action with the preferred fix of every handled lint finding in the document, or `undefined`
	 * with fewer than two distinct replaces. Same or overlapping ranges are applied once; the first in
	 * document order wins. N in the title is the number of findings fixed.
	 */
	private fixAll(doc: vscode.TextDocument, fixes: (d: vscode.Diagnostic) => vscode.CodeAction[]): vscode.CodeAction | undefined {
		const candidates = this.allDiagnostics(doc.uri).filter(handled).flatMap((diagnostic) => {
			const preferred = fixes(diagnostic).find((a) => a.isPreferred);
			const edit = preferred?.edit?.get(doc.uri)[0];
			return edit ? [{ diagnostic, edit, start: doc.offsetAt(edit.range.start), end: doc.offsetAt(edit.range.end) }] : [];
		}).sort((a, b) => a.start - b.start || a.end - b.end);
		const kept: typeof candidates = [];
		const diagnostics: vscode.Diagnostic[] = [];
		for (const c of candidates) {
			const same = kept.find((k) => k.start === c.start && k.end === c.end && k.edit.newText === c.edit.newText);
			if (same) {
				diagnostics.push(c.diagnostic); // the same edit fixes it too
			} else if (!kept.some((k) => c.start < k.end && k.start < c.end)) {
				kept.push(c);
				diagnostics.push(c.diagnostic);
			}
		}
		if (kept.length < 2) {
			return undefined;
		}
		const action = new vscode.CodeAction(`Fix all lint findings with a clear fix (${diagnostics.length})`, vscode.CodeActionKind.QuickFix);
		action.diagnostics = diagnostics;
		action.isPreferred = false;
		action.edit = new vscode.WorkspaceEdit();
		for (const { edit } of kept) {
			action.edit.replace(doc.uri, edit.range, edit.newText);
		}
		return action;
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
