// The graph's status mapping (tickets 3.3, 3.8, 3.9; split out of panels.ts in ticket 3.12): node
// status diagnostics, the host status and the component catalogue per schema. See panels.ts.

import * as vscode from 'vscode';
import { componentCatalogue, type ComponentCatalog } from '../../core/catalogue';
import type { StatusDiagnostic, StatusSeverity } from '../../core/nodeStatus';
import type { JsonObject } from '../../core/schema';
import type { BinaryState } from '../redpandaConnect/binary';
import type { SchemaSnapshot } from '../redpandaConnect/schema';
import type { HostStatus } from '../../shared/protocol';
import { LINT_SOURCE } from '../vscode/diagnostics';

const SEVERITIES: Readonly<Record<vscode.DiagnosticSeverity, StatusSeverity>> = {
	[vscode.DiagnosticSeverity.Error]: 'error',
	[vscode.DiagnosticSeverity.Warning]: 'warning',
	[vscode.DiagnosticSeverity.Information]: 'information',
	[vscode.DiagnosticSeverity.Hint]: 'hint',
};

/**
 * The offset each diagnostic maps at: a lint finding (a whole line from column 1) at the first
 * non-whitespace character of its start line, so that the line's indentation does not land in
 * the parent node; any other diagnostic at its range's start.
 */
export function statusDiagnostics(doc: vscode.TextDocument, diagnostics: readonly vscode.Diagnostic[]): StatusDiagnostic[] {
	return diagnostics.map((d) => {
		let offset = doc.offsetAt(d.range.start);
		if (d.source === LINT_SOURCE && d.range.start.line < doc.lineCount) {
			const line = doc.lineAt(d.range.start.line);
			if (!line.isEmptyOrWhitespace) {
				offset = doc.offsetAt(new vscode.Position(line.lineNumber, line.firstNonWhitespaceCharacterIndex));
			}
		}
		return { offset, severity: SEVERITIES[d.severity] ?? 'hint', message: d.message };
	});
}

/** What the graph needs of the binary state (ticket 3.9). */
export interface GraphBinary {
	readonly state: BinaryState;
	readonly onDidChange: vscode.Event<BinaryState>;
}

/** What the graph needs of the schema store (ticket 3.9). */
export interface GraphSchema {
	readonly current: Pick<SchemaSnapshot, 'json'> | undefined;
	/** Whether a generation is in progress. */
	readonly loading: boolean;
	readonly onDidChange: vscode.Event<unknown>;
	/** Resolves once the generation in progress (if any) has finished. */
	settled(): Promise<unknown>;
}

/**
 * The host status (ticket 3.9): the binary state's kind; the schema `ok` when there is one,
 * `loading` while the binary is `ok` and a generation is in progress, else `none`.
 */
export function hostStatusOf(binary: BinaryState, schema: Pick<GraphSchema, 'current' | 'loading'>): HostStatus {
	return {
		binary: binary.kind,
		schema: schema.current ? 'ok' : binary.kind === 'ok' && schema.loading ? 'loading' : 'none',
	};
}

/** One catalogue per schema object: derived once, dropped with the schema (AD-20). */
const catalogues = new WeakMap<JsonObject, ComponentCatalog>();

export function catalogueOf(schema: JsonObject | undefined): ComponentCatalog | undefined {
	if (!schema) {
		return undefined;
	}
	let catalogue = catalogues.get(schema);
	if (!catalogue) {
		catalogue = componentCatalogue(schema);
		catalogues.set(schema, catalogue);
	}
	return catalogue;
}
