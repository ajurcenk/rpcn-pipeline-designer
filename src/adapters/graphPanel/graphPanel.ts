// One file's graph panel (tickets 3.1, 3.6, 3.7, 3.8, 3.9, ticket 11; split out of panels.ts in
// ticket 3.12): the webview's messages, the model, the selection, the node status and the host
// status of one file. See panels.ts for the whole picture.

import * as path from 'path';
import * as vscode from 'vscode';
import type { ComponentCatalog } from '../../core/catalogue';
import { buildPipelineModel, nodeAt } from '../../core/graph';
import { nodeStatusOf } from '../../core/nodeStatus';
import { errorSelection, parseErrorOf } from '../../core/parseError';
import type { BinaryActions } from '../redpandaConnect/notify';
import {
	parseWebviewMessage, type HostMessage, type HostStatus, type NodeStatusById, type ParseError, type PipelineModel,
} from '../../shared/protocol';
import { parsedDocument } from '../vscode/parseCache';
import { statusDiagnostics } from './status';
import { openDocument } from './tabs';

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

export class GraphPanel implements GraphPanelHandle {
	readonly posted: HostMessage[] = [];
	/** Whether a text tab of the file has been open since the panel opened (TAB_CLOSE). */
	hadTab = false;
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
	/** The serialisation of the host status last handed to the webview (snapshot or `hostStatus`). */
	private sentHost: string | undefined;
	/**
	 * The catalogue the webview's model was built with, so that a new schema sends the model once;
	 * `undefined` while the webview has no model built with a schema it still shows.
	 */
	private modelCatalogue: ComponentCatalog | undefined;

	constructor(
		/** The file's URI; a rename (`onDidRenameFiles`) replaces it. */
		public uri: vscode.Uri,
		readonly panel: vscode.WebviewPanel,
		private readonly log: (line: string) => void,
		private readonly catalogue: () => ComponentCatalog | undefined,
		/** The file's driving editor, else a visible editor for it (`undefined`: none is visible). */
		private readonly editor: () => vscode.TextEditor | undefined,
		/** The file's diagnostics: Red Hat's plus the deduplicated lint ones (AD-12, AD-17). */
		private readonly diagnostics: () => readonly vscode.Diagnostic[],
		/** The binary and schema status (ticket 3.9). */
		private readonly hostStatus: () => HostStatus,
		/** The binary warning's actions; `undefined`: the empty state's buttons do nothing. */
		private readonly actions: () => BinaryActions | undefined,
	) {
		this.subscriptions.push(panel.webview.onDidReceiveMessage((m) => this.receive(m)));
	}

	async receive(message: unknown): Promise<void> {
		try {
			const msg = parseWebviewMessage(message);
			if (msg?.type === 'ready') {
				const doc = await this.document();
				// Read after the await, with the catalogue, so a change meanwhile is not overwritten.
				const hostStatus = this.hostStatus();
				const state = this.state(doc);
				const catalogue = this.built?.catalogue;
				// While the YAML is broken the highlight stays as it was (BROKEN, SNAPSHOT).
				const selection = state.model ? this.cursorNode(state.model) : this.sentSelection;
				this.sentSelection = selection;
				// While the YAML is broken, the frozen status (SNAPSHOT).
				const status = state.model ? this.computeStatus(doc, state.model) : undefined;
				// While the YAML is broken, the last valid model of this panel (FIRST_BROKEN, RECREATED);
				// with no schema, none (MISSING).
				const model = catalogue ? state.model ?? this.lastModel : null;
				this.sentHost = JSON.stringify(hostStatus);
				this.modelCatalogue = model ? catalogue : undefined;
				const delivered = await this.post({
					type: 'snapshot',
					model,
					...(state.parseError ? { parseError: state.parseError } : {}),
					nodeStatus: this.status,
					selection,
					hostStatus,
				});
				if (delivered) {
					this.sentStatus = status ?? JSON.stringify(this.status);
				}
			} else if (msg?.type === 'nodeActivated') {
				await this.activate(msg.nodeId);
			} else if (msg?.type === 'bannerClicked') {
				await this.selectParseError();
			} else if (msg?.type === 'installGuideRequested') {
				await this.actions()?.installGuide();
			} else if (msg?.type === 'setPathRequested') {
				await this.actions()?.setPath();
			} else if (msg?.type === 'retryRequested') {
				await this.actions()?.retry();
			} else if (msg?.type === 'focusEditorRequested') {
				await this.focusEditor();
			}
		} catch (e) {
			this.fail(e);
		}
	}

	/**
	 * The panel's document changed (AD-6): the complete model, or only the parse error; with no
	 * schema, no model. After a model, the node under the cursor is recomputed (AFTER_EDIT).
	 */
	async changed(doc: vscode.TextDocument): Promise<void> {
		try {
			const state = this.state(doc);
			if (state.parseError) {
				await this.post({ type: 'parseError', ...state.parseError });
				return;
			}
			if (state.model) {
				await this.sendModel(doc, state.model);
			}
		} catch (e) {
			this.fail(e);
		}
	}

	/**
	 * The binary state or the schema changed (ticket 3.9): `hostStatus` when it changed (LOST),
	 * then, when a schema the webview's model was not built with is here, the model, the selection
	 * and the node status (SET_PATH, RETRY, LATE_SCHEMA), or the parse error while the YAML does
	 * not parse.
	 */
	async hostChanged(): Promise<void> {
		try {
			const hostStatus = this.hostStatus();
			const serialised = JSON.stringify(hostStatus);
			if (serialised !== this.sentHost) {
				this.sentHost = serialised;
				await this.post({ type: 'hostStatus', ...hostStatus });
			}
			if (hostStatus.schema !== 'ok') {
				// The webview draws no model without a schema; the next schema sends one.
				this.modelCatalogue = undefined;
				return;
			}
			const catalogue = this.catalogue();
			const key = this.uri.toString();
			const doc = openDocument(key);
			if (!catalogue || catalogue === this.modelCatalogue || !doc) {
				return;
			}
			const state = this.state(doc);
			if (state.parseError) {
				// The webview dropped its model and banner with the schema; as in a snapshot, the banner
				// shows again over the last valid graph, if any.
				this.modelCatalogue = catalogue;
				if (this.lastModel) {
					await this.post({ type: 'model', model: this.lastModel });
				}
				await this.post({ type: 'parseError', ...state.parseError });
			} else if (state.model) {
				await this.sendModel(doc, state.model);
			}
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
			const doc = openDocument(key);
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

	/** Sends `model`, then the selection and the node status for it, when they changed. */
	private async sendModel(doc: vscode.TextDocument, model: PipelineModel): Promise<void> {
		this.modelCatalogue = this.built?.catalogue;
		await this.post({ type: 'model', model });
		await this.sendSelection(model);
		// Known, transient: Red Hat's published ranges are not shifted by an edit, so until Red Hat
		// republishes (debounced, well under a second) one of its markers can sit one node off.
		await this.sendStatus(doc, model);
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
		return openDocument(key)
			?? vscode.workspace.openTextDocument(this.uri);
	}

	/**
	 * The document's model, or its parse error (one parse per version, through the shared cache).
	 * A valid model becomes the panel's last valid model. With no schema there is neither (AD-20):
	 * the webview shows an empty state, and the last valid model is kept.
	 */
	private state(doc: vscode.TextDocument): { readonly model?: PipelineModel; readonly parseError?: ParseError } {
		const catalogue = this.catalogue();
		if (this.built?.doc === doc && this.built.version === doc.version && this.built.catalogue === catalogue) {
			return this.built.state;
		}
		const state = catalogue ? this.build(doc, catalogue) : {};
		this.built = { doc, version: doc.version, catalogue, state };
		return state;
	}

	/** The model with `catalogue`, which becomes the last valid model, or the parse error. */
	private build(doc: vscode.TextDocument, catalogue: ComponentCatalog): { readonly model?: PipelineModel; readonly parseError?: ParseError } {
		const { text, parsed } = parsedDocument(doc);
		const parseError = parseErrorOf(parsed);
		let state: { readonly model?: PipelineModel; readonly parseError?: ParseError };
		if (parseError) {
			state = { parseError };
		} else {
			const model = buildPipelineModel(parsed, text, catalogue);
			this.lastModel = model;
			state = { model };
		}
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
	 * Esc on the graph container (ticket 11, ESC): focuses the file's driving editor, else a
	 * visible editor for it, leaving its cursor and selection as they are (no `selection` is
	 * passed). With no editor for the file nothing happens, and nothing is logged.
	 */
	private async focusEditor(): Promise<void> {
		const editor = this.editor();
		if (!editor) {
			return;
		}
		await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
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
