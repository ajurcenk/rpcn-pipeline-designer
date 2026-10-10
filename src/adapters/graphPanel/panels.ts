// The graph panel registry (tickets 3.1, 3.6, AD-1, AD-6): one WebviewPanel per file, beside the
// editor, keyed by `uri.toString()`. The webview posts `ready` (again whenever it is recreated,
// since `retainContextWhenHidden` is off) and gets a fresh `snapshot`. On every change to a file
// with an open panel the host sends the complete `model`, or, while the YAML does not parse, only
// `parseError`; the webview keeps the last valid graph under a banner. The snapshot carries the
// panel's last valid model (or `null`) and the current `parseError`. Navigation (ticket 3.7, AD-8):
// the host tracks each file's driving editor (the text editor for it the user last moved the cursor
// in or focused, from the editor objects the events carry; never `window.activeTextEditor`, which
// 1.100 leaves `undefined` or wrong while a webview has focus). A `nodeActivated` (click or
// keyboard) selects that node's YAML range in the driving editor and reveals it centred, and
// `bannerClicked` selects the parse error the same way. On every cursor move in a driving editor
// and after every model, the host sends `selection` with `nodeAt` of the cursor, only when it
// changed, and none while the YAML does not parse; it never moves the cursor or reveals the panel
// for a `selection`. Nothing edits the text (AD-19). The model is built with the ComponentCatalog
// of the current schema (AD-20, ticket 3.3), derived once per schema object; with no schema the
// model is empty. Node status (ticket 3.8, AD-17): each panel's NodeStatusService part maps the
// file's diagnostics (`LintDiagnostics.diagnosticsFor`: Red Hat's plus the deduplicated lint ones)
// to nodes with `nodeStatusOf` (through `nodeAt` only) and sends `nodeStatus` after every model and
// whenever those diagnostics change, only when the mapped status changed; while the YAML does not
// parse the status is frozen (nothing is sent, the snapshot carries the last one) and the next
// valid model recomputes it. Host status is not sent yet (3.9), so the snapshot says nothing is
// known.

import * as path from 'path';
import * as vscode from 'vscode';
import { componentCatalogue, type ComponentCatalog } from '../../core/catalogue';
import { buildPipelineModel, nodeAt } from '../../core/graph';
import { nodeStatusOf, type StatusDiagnostic, type StatusSeverity } from '../../core/nodeStatus';
import { errorSelection, parseErrorOf } from '../../core/parseError';
import type { JsonObject } from '../../core/schema';
import {
	parseWebviewMessage, type HostMessage, type HostStatus, type NodeStatusById, type ParseError, type PipelineModel,
} from '../../shared/protocol';
import { LINT_SOURCE, type LintDiagnostics } from '../vscode/diagnostics';
import { parsedDocument } from '../vscode/parseCache';
import { graphHtml } from './html';

export const SHOW_GRAPH_COMMAND = 'redpandaConnect.showGraph';
export const GRAPH_VIEW_TYPE = 'redpandaConnect.graph';

/** The tab title of a file's graph panel. */
export function graphTitle(uri: vscode.Uri): string {
	return `Graph: ${path.posix.basename(uri.path)}`;
}

/** Until the host reports its status (3.9), the snapshot says nothing is known yet. */
const SNAPSHOT_HOST_STATUS: HostStatus = { binary: 'unresolved', schema: 'none' };

/** What the graph needs of the file's diagnostics (AD-17): the deduplicated set and its change event. */
export type GraphDiagnostics = Pick<LintDiagnostics, 'diagnosticsFor' | 'onDidChangeDiagnostics'>;

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

/** How many of a panel's posted messages `posted` keeps (test seam; a bound, not a log). */
export const MAX_POSTED = 50;

/** One file's panel, as seen by tests (the host-side seam; tests don't drive the webview DOM). */
export interface GraphPanelHandle {
	readonly uri: vscode.Uri;
	readonly panel: vscode.WebviewPanel;
	/**
	 * The last MAX_POSTED messages posted to the webview, in order (the oldest are dropped, so a
	 * long-lived panel does not keep a model per keystroke).
	 */
	readonly posted: readonly HostMessage[];
	/** Handles `message` as if the webview had posted it. */
	receive(message: unknown): Promise<void>;
}

class GraphPanel implements GraphPanelHandle {
	readonly posted: HostMessage[] = [];
	private readonly subscriptions: vscode.Disposable[] = [];
	/** The last valid model built for this panel; `null` until the YAML first parses. */
	private lastModel: PipelineModel | null = null;
	/** The state of the last document version seen, so a cursor move does not rebuild the model. */
	private built?: {
		readonly doc: vscode.TextDocument;
		readonly version: number;
		readonly catalogue: ComponentCatalog | undefined;
		readonly state: { readonly model?: PipelineModel; readonly parseError?: ParseError };
	};
	/**
	 * The selection the webview was last sent (in a snapshot or a `selection`), only so that an
	 * unchanged one is not sent again. It is never used to decide the selection, which is always
	 * `nodeAt` of the cursor in the current model (AD-8).
	 */
	private sentSelection: string | null = null;
	/**
	 * The node status last computed from a valid model and sent (in a snapshot or a `nodeStatus`),
	 * with its serialisation; frozen while the YAML does not parse (AD-17).
	 */
	private status: NodeStatusById = {};
	private sentStatus = '{}';
	/**
	 * The serialisation of the last status handed to `post` and not yet resolved, so that two
	 * diagnostics changes in a row do not both send the same status while the first post is in flight.
	 */
	private postingStatus: string | undefined;

	constructor(
		readonly uri: vscode.Uri,
		readonly panel: vscode.WebviewPanel,
		private readonly log: (line: string) => void,
		private readonly catalogue: () => ComponentCatalog | undefined,
		/** The file's driving editor, else a visible editor for it (`undefined`: none is visible). */
		private readonly editor: () => vscode.TextEditor | undefined,
		/** The file's diagnostics: Red Hat's plus the deduplicated lint ones (AD-12, AD-17). */
		private readonly diagnostics: () => readonly vscode.Diagnostic[],
	) {
		this.subscriptions.push(panel.webview.onDidReceiveMessage((m) => this.receive(m)));
	}

	async receive(message: unknown): Promise<void> {
		try {
			const msg = parseWebviewMessage(message);
			if (msg?.type === 'ready') {
				const doc = await this.document();
				const state = this.state(doc);
				// While the YAML is broken the highlight stays as it was (BROKEN, SNAPSHOT).
				const selection = state.model ? this.cursorNode(state.model) : this.sentSelection;
				this.sentSelection = selection;
				// While the YAML is broken, the frozen status (SNAPSHOT).
				const status = state.model ? this.computeStatus(doc, state.model) : undefined;
				const delivered = await this.post({
					type: 'snapshot',
					// While the YAML is broken, the last valid model of this panel (FIRST_BROKEN, RECREATED).
					model: state.model ?? this.lastModel,
					...(state.parseError ? { parseError: state.parseError } : {}),
					nodeStatus: this.status,
					selection,
					hostStatus: SNAPSHOT_HOST_STATUS,
				});
				if (delivered) {
					this.sentStatus = status ?? JSON.stringify(this.status);
				}
			} else if (msg?.type === 'nodeActivated') {
				await this.activate(msg.nodeId);
			} else if (msg?.type === 'bannerClicked') {
				await this.selectParseError();
			}
		} catch (e) {
			this.fail(e);
		}
	}

	/**
	 * The panel's document changed (AD-6): the complete model, or only the parse error. After a
	 * model, the node under the cursor is recomputed (AFTER_EDIT).
	 */
	async changed(doc: vscode.TextDocument): Promise<void> {
		try {
			const state = this.state(doc);
			if (state.parseError) {
				await this.post({ type: 'parseError', ...state.parseError });
				return;
			}
			await this.post({ type: 'model', model: state.model! });
			await this.sendSelection(state.model!);
			// Known, transient: Red Hat's published ranges are not shifted by an edit, so until Red Hat
			// republishes (debounced, well under a second) one of its markers can sit one node off.
			await this.sendStatus(doc, state.model!);
		} catch (e) {
			this.fail(e);
		}
	}

	/**
	 * The file's diagnostics changed: `nodeStatus` when the mapped status changed (SEND, SAME,
	 * CLEAR), nothing while the YAML does not parse (FROZEN). The service creates no diagnostics,
	 * so the only churn it could cause itself is re-sending an unchanged status, which it never does.
	 */
	async diagnosticsChanged(): Promise<void> {
		try {
			const key = this.uri.toString();
			const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
			if (!doc) {
				// The document is gone: its diagnostics no longer describe anything the graph shows.
				this.status = {};
				await this.postStatus('{}');
				return;
			}
			const state = this.state(doc);
			if (state.model) {
				await this.sendStatus(doc, state.model);
			}
		} catch (e) {
			this.fail(e);
		}
	}

	/**
	 * The cursor moved in (or focus moved to) the file's driving editor: `selection` with the node
	 * under the cursor, when it changed (CURSOR, CURSOR_SAME, CURSOR_OUTSIDE). Nothing while the
	 * YAML does not parse (BROKEN): the last valid model's ranges no longer match the text. It
	 * never moves focus or reveals the panel (FOCUS).
	 */
	async cursorMoved(doc: vscode.TextDocument): Promise<void> {
		try {
			const state = this.state(doc);
			if (state.model) {
				await this.sendSelection(state.model);
			}
		} catch (e) {
			this.fail(e);
		}
	}

	dispose(): void {
		this.subscriptions.forEach((d) => d.dispose());
	}

	/**
	 * Posts `message`; `true` once the post resolved, `false` if it threw (a disposed panel). A
	 * post that resolves `false` (a webview that is not live yet) still counts as sent: such a
	 * webview posts `ready` when it comes alive and gets the full snapshot, so re-sending would only
	 * churn.
	 */
	private async post(message: HostMessage): Promise<boolean> {
		this.posted.push(message);
		if (this.posted.length > MAX_POSTED) {
			this.posted.splice(0, this.posted.length - MAX_POSTED);
		}
		try {
			await this.panel.webview.postMessage(message);
			return true;
		} catch (e) {
			this.fail(e);
			return false;
		}
	}

	/**
	 * Maps the file's diagnostics onto `model` and makes that the current status; returns its
	 * serialisation. What was sent is recorded only once a post succeeds.
	 */
	private computeStatus(doc: vscode.TextDocument, model: PipelineModel): string {
		this.status = nodeStatusOf(model, statusDiagnostics(doc, this.diagnostics()));
		return JSON.stringify(this.status);
	}

	/** Sends `nodeStatus` for `model`, unless the webview already has (or is being sent) that status. */
	private async sendStatus(doc: vscode.TextDocument, model: PipelineModel): Promise<void> {
		await this.postStatus(this.computeStatus(doc, model));
	}

	/**
	 * Posts the current status (whose serialisation is `serialised`) unless it is the one sent or
	 * in flight; it becomes the sent one only once the post succeeded.
	 */
	private async postStatus(serialised: string): Promise<void> {
		if (serialised === (this.postingStatus ?? this.sentStatus)) {
			return;
		}
		this.postingStatus = serialised;
		const ok = await this.post({ type: 'nodeStatus', byId: this.status });
		if (this.postingStatus === serialised) {
			this.postingStatus = undefined;
		}
		if (ok) {
			this.sentStatus = serialised;
		}
	}

	/** Sends `selection` for the cursor in `model`, unless the webview already has it. */
	private async sendSelection(model: PipelineModel): Promise<void> {
		const nodeId = this.cursorNode(model);
		if (nodeId !== this.sentSelection) {
			this.sentSelection = nodeId;
			await this.post({ type: 'selection', nodeId });
		}
	}

	/**
	 * The node under the cursor of the file's editor (`nodeAt`, AD-16), `null` outside every node
	 * or with no editor. The cursor is the selection's start, so that a node selected by a click
	 * (anchor at its start, cursor at its end, which is outside the range) names that node.
	 */
	private cursorNode(model: PipelineModel): string | null {
		const editor = this.editor();
		if (!editor) {
			return null;
		}
		return nodeAt(model, editor.document.offsetAt(editor.selection.start)) ?? null;
	}

	private async document(): Promise<vscode.TextDocument> {
		const key = this.uri.toString();
		return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key)
			?? vscode.workspace.openTextDocument(this.uri);
	}

	/**
	 * The document's model, or its parse error (one parse per version, through the shared cache).
	 * A valid model becomes the panel's last valid model.
	 */
	private state(doc: vscode.TextDocument): { readonly model?: PipelineModel; readonly parseError?: ParseError } {
		const catalogue = this.catalogue();
		if (this.built?.doc === doc && this.built.version === doc.version && this.built.catalogue === catalogue) {
			return this.built.state;
		}
		const { text, parsed } = parsedDocument(doc);
		const parseError = parseErrorOf(parsed);
		let state: { readonly model?: PipelineModel; readonly parseError?: ParseError };
		if (parseError) {
			state = { parseError };
		} else {
			// With no schema snapshot the catalogue is undefined and the builder gives the empty model
			// (the no-binary empty state is ticket 3.9).
			const model = buildPipelineModel(parsed, text, catalogue);
			this.lastModel = model;
			state = { model };
		}
		this.built = { doc, version: doc.version, catalogue, state };
		return state;
	}

	private fail(e: unknown): void {
		this.log(`Graph ${path.posix.basename(this.uri.path)}: ${e instanceof Error ? e.message : String(e)}`);
	}

	/**
	 * Selects the node's range and reveals it centred (CLICK_CENTRED); a group's range is its
	 * whole block (HEADER). An unknown id does nothing.
	 */
	private async activate(nodeId: string): Promise<void> {
		const doc = await this.document();
		const node = this.state(doc).model?.nodes.find((n) => n.id === nodeId);
		if (!node) {
			return;
		}
		await this.select(doc, new vscode.Range(doc.positionAt(node.range[0]), doc.positionAt(node.range[1])));
	}

	/**
	 * Selects and reveals the current parse error (`errorSelection`: its range, or its position to
	 * the end of its line, never into the next line). Nothing happens when the YAML parses.
	 */
	private async selectParseError(): Promise<void> {
		const doc = await this.document();
		const error = this.state(doc).parseError;
		if (!error) {
			return;
		}
		const [start, end] = errorSelection(parsedDocument(doc).text, error.range);
		await this.select(doc, new vscode.Range(doc.positionAt(start), doc.positionAt(end)));
	}

	/**
	 * Selects `range` and reveals it centred in the file's driving editor, else a visible editor
	 * for the file, else column One (DRIVING, DRIVING_CLOSED), moving focus there: that is what
	 * selecting there means. `showTextDocument` into that editor's column focuses that editor and
	 * opens no new one.
	 */
	private async select(doc: vscode.TextDocument, range: vscode.Range): Promise<void> {
		const editor = await vscode.window.showTextDocument(doc, {
			viewColumn: this.editor()?.viewColumn ?? vscode.ViewColumn.One,
			preserveFocus: false,
		});
		editor.selection = new vscode.Selection(range.start, range.end);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
	}
}

export interface GraphPanelsOptions {
	readonly extensionUri: vscode.Uri;
	readonly log: (line: string) => void;
	/** The current transformed schema (AD-10), `undefined` while there is none. */
	readonly schema: () => JsonObject | undefined;
	/** The files' diagnostics for node status (AD-17): `LintDiagnostics` in production. */
	readonly diagnostics: GraphDiagnostics;
}

/** One catalogue per schema object: derived once, dropped with the schema (AD-20). */
const catalogues = new WeakMap<JsonObject, ComponentCatalog>();

function catalogueOf(schema: JsonObject | undefined): ComponentCatalog | undefined {
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

/** All open graph panels, one per file (AD-1). */
export class GraphPanels implements vscode.Disposable {
	private readonly panels = new Map<string, GraphPanel>();
	/**
	 * Each file's driving editor (AD-1, AD-8): the text editor for it the user last moved the
	 * cursor in or focused, by `uri.toString()`, tracked for every file so that a panel opened
	 * later has one. Entries whose editor is no longer visible are dropped.
	 */
	private readonly driving = new Map<string, vscode.TextEditor>();
	/** The text editor last focused (from `onDidChangeActiveTextEditor`), for any file. */
	private focused: vscode.TextEditor | undefined;
	private readonly subscriptions: vscode.Disposable[];

	constructor(private readonly options: GraphPanelsOptions) {
		// One subscription per event for all panels: an event goes to the panel of its file, if one
		// is open (OTHER_DOC, OTHER_FILE, CLOSED). Events with no content change (dirty state, save)
		// send nothing.
		this.subscriptions = [
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (e.contentChanges.length > 0) {
					void this.panels.get(e.document.uri.toString())?.changed(e.document);
				}
			}),
			// The editor objects these events carry, never `window.activeTextEditor` (spike 3.14).
			// A selection change with no kind is VS Code's own (the text moved, or a programmatic
			// set): it makes its editor the driving one only when that editor has focus, so a
			// second split editor whose cursor shifts with an edit does not take over.
			vscode.window.onDidChangeTextEditorSelection((e) => {
				if (e.kind !== undefined || e.textEditor === this.focused) {
					this.drive(e.textEditor);
				} else {
					this.follow(e.textEditor);
				}
			}),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor) {
					this.focused = editor;
					this.drive(editor);
				}
			}),
			// Node status (AD-17): only files with a panel.
			options.diagnostics.onDidChangeDiagnostics((uri) => {
				void this.panels.get(uri.toString())?.diagnosticsChanged();
			}),
			vscode.window.onDidChangeVisibleTextEditors((visible) => {
				for (const [key, editor] of [...this.driving]) {
					if (!visible.includes(editor)) {
						this.driving.delete(key);
					}
				}
			}),
		];
	}

	/**
	 * `editor` becomes its file's driving editor, and that file's panel follows its cursor. An
	 * editor with no column (a diff side) is never a driving editor: a reveal could not target it.
	 */
	private drive(editor: vscode.TextEditor): void {
		if (editor.viewColumn === undefined) {
			return;
		}
		this.driving.set(editor.document.uri.toString(), editor);
		this.follow(editor);
	}

	/** The panel of `editor`'s file follows its cursor, if `editor` is the one navigation uses. */
	private follow(editor: vscode.TextEditor): void {
		const key = editor.document.uri.toString();
		if (this.editorFor(key) === editor) {
			void this.panels.get(key)?.cursorMoved(editor.document);
		}
	}

	/**
	 * The text editor navigation uses for a file: its driving editor while it is visible, else a
	 * visible editor for the file (DRIVING_CLOSED), else `undefined`. Editors with no column are
	 * skipped.
	 */
	private editorFor(key: string): vscode.TextEditor | undefined {
		const visible = vscode.window.visibleTextEditors.filter((e) => e.viewColumn !== undefined);
		const driving = this.driving.get(key);
		if (driving && visible.includes(driving)) {
			return driving;
		}
		return visible.find((e) => e.document.uri.toString() === key);
	}

	registerCommands(): vscode.Disposable[] {
		return [vscode.commands.registerCommand(SHOW_GRAPH_COMMAND, (uri?: vscode.Uri) => this.show(uri))];
	}

	/** Opens (or reveals) the graph of `uri`, default the active editor's file. Never throws. */
	show(uri?: vscode.Uri): GraphPanelHandle | undefined {
		try {
			const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
			if (!target) {
				this.options.log('Show graph: no active editor.');
				return undefined;
			}
			const key = target.toString();
			const open = this.panels.get(key);
			if (open) {
				open.panel.reveal(undefined, true);
				return open;
			}
			const title = graphTitle(target);
			const panel = vscode.window.createWebviewPanel(
				GRAPH_VIEW_TYPE,
				title,
				{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
				{
					enableScripts: true,
					retainContextWhenHidden: false,
					localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, 'dist')],
				},
			);
			const graph = new GraphPanel(
				target,
				panel,
				this.options.log,
				() => catalogueOf(this.options.schema()),
				() => this.editorFor(key),
				() => this.options.diagnostics.diagnosticsFor(target),
			);
			this.panels.set(key, graph);
			panel.onDidDispose(() => {
				graph.dispose();
				if (this.panels.get(key) === graph) {
					this.panels.delete(key);
				}
			});
			panel.webview.html = graphHtml(panel.webview, this.options.extensionUri, title);
			return graph;
		} catch (e) {
			this.options.log(`Show graph: ${e instanceof Error ? e.message : String(e)}`);
			return undefined;
		}
	}

	/** The open panel of `uri`, if any (test seam). */
	panelFor(uri: vscode.Uri): GraphPanelHandle | undefined {
		return this.panels.get(uri.toString());
	}

	/** How many graph panels are open. */
	get size(): number {
		return this.panels.size;
	}

	dispose(): void {
		this.subscriptions.forEach((d) => d.dispose());
		this.driving.clear();
		for (const graph of [...this.panels.values()]) {
			graph.panel.dispose();
		}
		this.panels.clear();
	}
}
