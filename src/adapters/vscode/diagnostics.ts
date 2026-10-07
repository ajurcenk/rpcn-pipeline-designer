// Lint diagnostics (AD-12, AD-17). On save of a detected `file:` document, runs lint and
// publishes its findings on whole lines in our own collection (source `Redpanda Connect`). A
// lint finding on a line Red Hat YAML already flags is suppressed, and lint's YAML syntax
// findings are suppressed while Red Hat reports any syntax error; both are re-checked whenever
// Red Hat's diagnostics change. The first edit after a save clears the file's lint findings, as does the
// file stopping being detected (which includes close). One lint per URI runs at a time: a save
// during a run queues one rerun, and a result is dropped if the file was edited, saved again,
// closed or undetected since its save (a generation per URI). `diagnosticsFor` is epic 3's
// deduped view: Red Hat's diagnostics plus the published lint ones.

import * as path from 'path';
import * as vscode from 'vscode';
import { documentLine, LintFinding, suppressFlaggedLines } from '../../core/lint';
import type { LintResult } from '../redpandaConnect/lint';

export const LINT_SOURCE = 'Redpanda Connect';
const COLLECTION_NAME = 'redpanda-connect-lint';

/** Red Hat YAML 1.24.0 sources: `YAML` (syntax) and `yaml-schema: <name>` (schema). */
export function isRedHatDiagnostic(d: vscode.Diagnostic): boolean {
	return d.source === 'YAML' || (d.source?.startsWith('yaml-schema') ?? false);
}

/** What the controller needs from VS Code (tests pass fakes). */
export interface DiagnosticsSource {
	readonly textDocuments: readonly vscode.TextDocument[];
	readonly onDidSaveTextDocument: vscode.Event<vscode.TextDocument>;
	readonly onDidChangeTextDocument: vscode.Event<vscode.TextDocumentChangeEvent>;
	readonly onDidCloseTextDocument: vscode.Event<vscode.TextDocument>;
	readonly onDidChangeDiagnostics: vscode.Event<vscode.DiagnosticChangeEvent>;
	getDiagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[];
	createDiagnosticCollection(name: string): vscode.DiagnosticCollection;
}

export interface DetectionView {
	isDetected(uri: string | vscode.Uri): boolean;
	readonly onDidChangeDetection: vscode.Event<{ readonly uri: string; readonly detected: boolean }>;
}

export interface LintDiagnosticsOptions {
	readonly detection: DetectionView;
	/** Lints the saved file (`lintFile` with the current binary state in production). */
	readonly lint: (doc: vscode.TextDocument) => Promise<LintResult>;
	readonly log: (line: string) => void;
	readonly source?: DiagnosticsSource;
}

interface UriState {
	/** Bumped by every save, edit, undetect; a lint result applies only if it is unchanged. */
	generation: number;
	running: boolean;
	/** The generation of a save made while a lint was running (one rerun). */
	queued: number | undefined;
	raw: readonly LintFinding[];
	/** Signature of what `diagnosticsFor` last returned, to fire only on change. */
	signature: string;
}

export function defaultDiagnosticsSource(): DiagnosticsSource {
	return {
		get textDocuments() { return vscode.workspace.textDocuments; },
		onDidSaveTextDocument: vscode.workspace.onDidSaveTextDocument,
		onDidChangeTextDocument: vscode.workspace.onDidChangeTextDocument,
		onDidCloseTextDocument: vscode.workspace.onDidCloseTextDocument,
		onDidChangeDiagnostics: vscode.languages.onDidChangeDiagnostics,
		getDiagnostics: (uri) => vscode.languages.getDiagnostics(uri),
		createDiagnosticCollection: (name) => vscode.languages.createDiagnosticCollection(name),
	};
}

export class LintDiagnostics implements vscode.Disposable {
	private readonly states = new Map<string, UriState>();
	private readonly collection: vscode.DiagnosticCollection;
	private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly source: DiagnosticsSource;
	private disposed = false;

	/** Fires with a URI whenever `diagnosticsFor(uri)` changes. */
	readonly onDidChangeDiagnostics: vscode.Event<vscode.Uri> = this.emitter.event;

	constructor(private readonly options: LintDiagnosticsOptions) {
		this.source = options.source ?? defaultDiagnosticsSource();
		this.collection = this.source.createDiagnosticCollection(COLLECTION_NAME);
		this.subscriptions.push(
			this.collection,
			this.emitter,
			this.source.onDidSaveTextDocument((doc) => this.onSave(doc)),
			this.source.onDidChangeTextDocument((e) => {
				if (e.contentChanges.length > 0) {
					this.invalidate(e.document.uri);
				}
			}),
			// States are kept (not deleted) so a running lint stays the only one for its URI.
			options.detection.onDidChangeDetection((e) => {
				if (!e.detected) {
					this.invalidate(vscode.Uri.parse(e.uri));
				}
			}),
			// A session-marked file stays detected after close; its findings still go.
			this.source.onDidCloseTextDocument((doc) => this.invalidate(doc.uri)),
			this.source.onDidChangeDiagnostics((e) => e.uris.forEach((uri) => this.refresh(uri))),
		);
	}

	/** Red Hat's diagnostics for the URI plus the published (deduped) lint ones. */
	diagnosticsFor(uri: vscode.Uri): vscode.Diagnostic[] {
		return [...this.redHat(uri), ...(this.collection.get(uri) ?? [])];
	}

	dispose(): void {
		this.disposed = true;
		for (const d of this.subscriptions.splice(0)) {
			d.dispose();
		}
		this.states.clear();
	}

	private state(uri: vscode.Uri): UriState {
		const key = uri.toString();
		let state = this.states.get(key);
		if (!state) {
			state = { generation: 0, running: false, queued: undefined, raw: [], signature: '' };
			this.states.set(key, state);
		}
		return state;
	}

	private onSave(doc: vscode.TextDocument): void {
		if (doc.uri.scheme !== 'file' || !this.options.detection.isDetected(doc.uri)) {
			return;
		}
		const state = this.state(doc.uri);
		state.generation++;
		if (state.running) {
			state.queued = state.generation;
			return;
		}
		void this.runLint(doc.uri, state.generation);
	}

	private async runLint(uri: vscode.Uri, generation: number): Promise<void> {
		const state = this.state(uri);
		const doc = this.document(uri);
		if (!doc) {
			return;
		}
		state.running = true;
		let result: LintResult;
		try {
			result = await this.options.lint(doc);
		} catch (err) {
			result = { kind: 'failed', logLine: `Lint ${path.posix.basename(uri.path)}: ${String(err)}` };
		} finally {
			state.running = false;
		}
		if (this.disposed) {
			return;
		}
		// Logged even when stale: the run happened and its problems are real.
		if (result.kind === 'failed') {
			this.options.log(result.logLine);
		} else if (result.kind === 'findings') {
			result.logLines.forEach((l) => this.options.log(l));
		}
		if (state.generation === generation && this.options.detection.isDetected(uri)) {
			state.raw = result.kind === 'findings' ? result.findings : [];
			this.refresh(uri);
		}
		const queued = state.queued;
		state.queued = undefined;
		if (queued !== undefined && queued === state.generation && this.options.detection.isDetected(uri)) {
			await this.runLint(uri, queued);
		}
	}

	/** Edit, undetect or close: forget the findings and drop running and queued results. */
	private invalidate(uri: vscode.Uri): void {
		const state = this.states.get(uri.toString());
		if (!state) {
			return;
		}
		state.generation++;
		state.queued = undefined;
		state.raw = [];
		this.refresh(uri);
	}

	/** Re-publishes the URI's lint diagnostics against Red Hat's current lines; fires on change. */
	private refresh(uri: vscode.Uri): void {
		if (this.disposed) {
			return;
		}
		// Detected files are tracked from their first diagnostics change, so epic 3 hears about
		// Red Hat-only changes too.
		const state = this.states.get(uri.toString())
			?? (this.options.detection.isDetected(uri) ? this.state(uri) : undefined);
		if (!state) {
			return;
		}
		const doc = this.document(uri);
		const redHat = this.redHat(uri);
		const flagged = new Set(redHat.flatMap((d) => linesOf(d.range)));
		const redHatSyntax = redHat.some((d) => d.source === 'YAML');
		const published = doc ? suppressFlaggedLines(state.raw, flagged, redHatSyntax).map((f) => toDiagnostic(doc, f)) : [];
		if (signatureOf(published) !== signatureOf(this.collection.get(uri) ?? [])) {
			if (published.length > 0) {
				this.collection.set(uri, published);
			} else {
				this.collection.delete(uri);
			}
		}
		const signature = signatureOf([...redHat, ...published]);
		if (signature !== state.signature) {
			state.signature = signature;
			this.emitter.fire(uri);
		}
	}

	private redHat(uri: vscode.Uri): vscode.Diagnostic[] {
		return this.source.getDiagnostics(uri).filter((d) => d.source !== LINT_SOURCE && isRedHatDiagnostic(d));
	}

	private document(uri: vscode.Uri): vscode.TextDocument | undefined {
		const key = uri.toString();
		return this.source.textDocuments.find((d) => d.uri.toString() === key);
	}
}

/** A finding as a whole-line diagnostic; a line past the end is clamped to the last line. */
function toDiagnostic(doc: vscode.TextDocument, finding: LintFinding): vscode.Diagnostic {
	const line = documentLine(finding.line, doc.lineCount);
	const severity = finding.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
	const diagnostic = new vscode.Diagnostic(doc.lineAt(line).range, finding.message, severity);
	diagnostic.source = LINT_SOURCE;
	return diagnostic;
}

/** 1-based lines a range touches (a range ending at column 0 does not touch its end line). */
function linesOf(range: vscode.Range): number[] {
	const last = range.end.line > range.start.line && range.end.character === 0 ? range.end.line - 1 : range.end.line;
	const lines: number[] = [];
	for (let line = range.start.line; line <= last; line++) {
		lines.push(line + 1);
	}
	return lines;
}

function signatureOf(diagnostics: readonly vscode.Diagnostic[]): string {
	return JSON.stringify(diagnostics.map((d) => [d.source, d.severity, d.range.start.line, d.range.start.character,
		d.range.end.line, d.range.end.character, d.message]));
}
