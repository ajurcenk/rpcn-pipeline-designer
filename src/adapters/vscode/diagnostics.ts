// Lint diagnostics (AD-12, AD-17). On save of a detected `file:` document, runs lint and
// publishes its findings on whole lines in our own collection (source `Redpanda Connect`). A
// lint finding on a line Red Hat YAML already flags is suppressed, and lint's YAML syntax
// findings are suppressed while Red Hat reports any syntax error; both are re-checked whenever
// Red Hat's diagnostics change. The first edit after a save clears the file's lint findings, as does the
// file stopping being detected (which includes close). One lint per URI runs at a time: a save
// during a run queues one rerun, and a result is dropped if the file was edited, saved again,
// closed or undetected since its save (a generation per URI). `diagnosticsFor` is epic 3's
// deduped view, which the graph's node status reads (AD-17): Red Hat's diagnostics, the
// published lint ones and the published live Bloblang ones (ticket 6, `bloblangErrors`); its
// event fires when any of the three change. Lint's duplicate of a live Bloblang error (ticket
// 4.5) is hidden: a finding on a line of that processor (its key line through the line after its
// value) whose message starts with the live error's. The live error wins over lint's duplicate,
// whose position is unreliable. The Bloblang collection is its own, so the first edit after a
// save leaves it alone. In that view Red Hat's diagnostics are held, shifted by the edits, until
// Red Hat republishes (story 13): their offsets are taken when Red Hat publishes and moved
// through each content change, so a marker never lands on another node meanwhile; one whose start
// was replaced or deleted, and every syntax error, is left out, and a change that can't be mapped
// leaves them all out until Red Hat republishes. Lint's suppression on Red Hat's lines reads Red Hat's own ranges.

import * as path from 'path';
import * as vscode from 'vscode';
import { documentLine, LintFinding, suppressFlaggedLines } from '../../core/lint';
import { mapRange, TextChange } from '../../core/processorTracking';
import type { LintResult } from '../redpandaConnect/lint';
import type { LiveBloblangError } from './bloblangDiagnostics';

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
	/**
	 * The live Bloblang errors (4.5): lint's duplicate of one is hidden, and the published
	 * diagnostics are part of `diagnosticsFor` (ticket 6).
	 */
	readonly bloblangErrors?: {
		liveErrorsFor(uri: vscode.Uri): readonly LiveBloblangError[];
		diagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[];
		readonly onDidChangeDiagnostics: vscode.Event<vscode.Uri>;
	};
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

/** Red Hat's diagnostics of a URI as taken when its set changed, shifted by the edits since (story 13). */
interface HeldRedHat {
	/**
	 * Red Hat's set they were taken from. Compared by identity: each republish creates new objects,
	 * even with the same content, while another collection's change leaves them as they are.
	 */
	readonly published: readonly vscode.Diagnostic[];
	/** The document version the offsets are for; another version gets none until Red Hat republishes. */
	version: number;
	held: readonly { readonly diagnostic: vscode.Diagnostic; readonly range: readonly [number, number] }[];
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
	private readonly redHatHeld = new Map<string, HeldRedHat>();
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
					this.shiftRedHat(e);
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
			this.source.onDidCloseTextDocument((doc) => {
				this.redHatHeld.delete(doc.uri.toString());
				this.invalidate(doc.uri);
			}),
			this.source.onDidChangeDiagnostics((e) => e.uris.forEach((uri) => {
				this.takeRedHat(uri);
				this.refresh(uri);
			})),
		);
		if (options.bloblangErrors) {
			this.subscriptions.push(options.bloblangErrors.onDidChangeDiagnostics((uri) => this.refresh(uri)));
		}
	}

	/** Red Hat's diagnostics for the URI (held, story 13), the published (deduped) lint ones and the published Bloblang ones. */
	diagnosticsFor(uri: vscode.Uri): vscode.Diagnostic[] {
		return [...this.heldRedHat(uri), ...(this.collection.get(uri) ?? []), ...this.bloblang(uri)];
	}

	/** Red Hat's set changed (or any collection did): a new set is taken with its offsets now. */
	private takeRedHat(uri: vscode.Uri): void {
		const key = uri.toString();
		if (!this.options.detection.isDetected(uri)) {
			this.redHatHeld.delete(key); // only the files the graph reads
			return;
		}
		const redHat = this.redHat(uri);
		const previous = this.redHatHeld.get(key)?.published;
		if (previous && previous.length === redHat.length && previous.every((d, i) => d === redHat[i])) {
			return; // another collection changed, not Red Hat's: the held offsets stay as shifted
		}
		const doc = this.document(uri);
		if (!doc) {
			this.redHatHeld.delete(key);
			return;
		}
		this.redHatHeld.set(key, { published: redHat, version: doc.version, held: redHat.map((diagnostic) =>
			({ diagnostic, range: [doc.offsetAt(diagnostic.range.start), doc.offsetAt(diagnostic.range.end)] as const })) });
	}

	/** An edit: the held offsets move through its changes; one whose start was replaced goes. */
	private shiftRedHat(e: vscode.TextDocumentChangeEvent): void {
		const held = this.redHatHeld.get(e.document.uri.toString());
		if (!held) {
			return;
		}
		const changes: TextChange[] = e.contentChanges.map((c) => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text }));
		if (changes.some((c) => typeof c.offset !== 'number' || typeof c.length !== 'number' || typeof c.text !== 'string')) {
			held.held = []; // can't be mapped: none until Red Hat republishes
		} else {
			// A syntax error (source `YAML`) describes the text's structure, which the edit may have fixed:
			// it goes until Red Hat republishes. Schema diagnostics are held.
			held.held = held.held
				.filter(({ diagnostic }) => diagnostic.source !== 'YAML')
				.filter(({ range: [start] }) => !changes.some((c) => c.length > 0 && c.offset <= start && start < c.offset + c.length))
				.map((h) => {
					// Text inserted exactly at its start (a node typed at the cursor) goes before it, not into it.
					const [start, end] = mapRange(h.range, changes);
					const before = changes.filter((c) => c.length === 0 && c.offset === h.range[0]).reduce((n, c) => n + c.text.length, 0);
					return { diagnostic: h.diagnostic, range: [start + before, Math.max(start + before, end + (h.range[0] === h.range[1] ? before : 0))] as const };
				});
		}
		held.version = e.document.version;
		// The shift alone fires nothing: the graph rebuilds on this edit with the shifted ranges, and an
		// event now would send the new model's status before the model (the view's listener runs first).
		const state = this.states.get(e.document.uri.toString());
		if (state) {
			state.signature = signatureOf([...this.heldRedHat(e.document.uri), ...(this.collection.get(e.document.uri) ?? []), ...this.bloblang(e.document.uri)]);
		}
	}

	/** Red Hat's diagnostics at their held ranges for the current text; Red Hat's own when none are held. */
	private heldRedHat(uri: vscode.Uri): vscode.Diagnostic[] {
		const held = this.redHatHeld.get(uri.toString());
		if (!held) {
			return this.redHat(uri);
		}
		const doc = this.document(uri);
		if (!doc || doc.version !== held.version) {
			return [];
		}
		return held.held.map(({ diagnostic, range: [start, end] }) => {
			const moved = new vscode.Diagnostic(new vscode.Range(doc.positionAt(start), doc.positionAt(end)), diagnostic.message, diagnostic.severity);
			moved.source = diagnostic.source;
			moved.code = diagnostic.code;
			return moved;
		});
	}

	dispose(): void {
		this.disposed = true;
		for (const d of this.subscriptions.splice(0)) {
			d.dispose();
		}
		this.states.clear();
		this.redHatHeld.clear();
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
		const live = this.options.bloblangErrors?.liveErrorsFor(uri) ?? [];
		const raw = live.length === 0 ? state.raw : state.raw.filter((f) => !live.some((e) =>
			e.firstLine <= f.line && f.line <= e.lastLine && f.message.startsWith(e.message)));
		const redHatSyntax = redHat.some((d) => d.source === 'YAML');
		const published = doc ? suppressFlaggedLines(raw, flagged, redHatSyntax).map((f) => toDiagnostic(doc, f)) : [];
		if (signatureOf(published) !== signatureOf(this.collection.get(uri) ?? [])) {
			if (published.length > 0) {
				this.collection.set(uri, published);
			} else {
				this.collection.delete(uri);
			}
		}
		const signature = signatureOf([...this.heldRedHat(uri), ...published, ...this.bloblang(uri)]);
		if (signature !== state.signature) {
			state.signature = signature;
			this.emitter.fire(uri);
		}
	}

	private redHat(uri: vscode.Uri): vscode.Diagnostic[] {
		return this.source.getDiagnostics(uri).filter((d) => d.source !== LINT_SOURCE && isRedHatDiagnostic(d));
	}

	private bloblang(uri: vscode.Uri): readonly vscode.Diagnostic[] {
		return this.options.bloblangErrors?.diagnostics(uri) ?? [];
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
