// One file's graph panel (tickets 3.1, 3.6, 3.7, 3.8, 3.9, 3.11; split out of panels.ts in
// ticket 3.12): the webview's messages, the model, the selection, the node status and the host
// status of one file. See panels.ts for the whole picture. Node figures (ticket 7.3, AD-17, AD-25):
// the panel holds the file's metrics feed (shared with its Pipeline Metrics tab) while it lives,
// visible while the panel is; each reading of a live run, and the last one again after each new
// model, is mapped onto the panel's current model (`nodeFiguresOf`, the tab's mapping) and sent as
// `nodeFigures` when it changed; while the YAML does
// not parse the figures are frozen, and with no live run (stopped, not running, hidden) they are `{}`.

import * as path from 'path';
import * as vscode from 'vscode';
import type { ComponentCatalog } from '../../core/catalogue';
import { buildPipelineModel, componentPaths, nodeAt } from '../../core/graph';
import { nodeFiguresOf } from '../../core/metrics';
import { nodeStatusOf } from '../../core/nodeStatus';
import { errorSelection, parseErrorOf } from '../../core/parseError';
import type { BinaryActions } from '../redpandaConnect/notify';
import { errorText } from '../../shared/errorText';
import {
	parseWebviewMessage, type HostMessage, type HostStatus, type NodeFiguresById, type NodeStatusById, type ParseError, type PipelineModel,
} from '../../shared/protocol';
import type { MetricsFeeds, MetricsSubscription, MetricsUpdate } from '../vscode/metricsFeed';
import { parsedDocument } from '../vscode/parseCache';
import { statusDiagnostics } from './status';
import type { GraphPanelSource } from './groups';
import { openDocument } from './tabs';

/** How many of a panel's posted messages `posted` keeps (test seam; a bound, not a log). */
export const MAX_POSTED = 50;

/** What a graph panel needs of the metrics feeds (ticket 7.3). */
export type GraphMetrics = Pick<MetricsFeeds, 'subscribe'>;

/** A built document: its model and its components' paths (AD-25), or its parse error. */
interface BuiltState {
	readonly model?: PipelineModel;
	readonly paths?: ReadonlyMap<string, string>;
	readonly parseError?: ParseError;
}

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
	/**
	 * Test seam (bug 15): resolves once the panel's whole lock sequence has ended (in time or
	 * late, by lock, skip, expiry or disposal). `open` resolves earlier; production never awaits it.
	 */
	readonly lockSettled: Promise<void>;
	/**
	 * Test seam (bug 37): the `ready` messages the webview itself posted and the panel has answered
	 * (two in a development build, StrictMode). A test waits for them before it moves the cursor: a
	 * later snapshot carries the cursor's node, so that move would post no `selection` of its own.
	 */
	readonly webviewReadies: number;
}

export class GraphPanel implements GraphPanelHandle {
	readonly posted: HostMessage[] = [];
	webviewReadies = 0;
	private settle!: () => void;
	readonly lockSettled = new Promise<void>((resolve) => {
		this.settle = resolve;
	});
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
		readonly state: BuiltState;
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
	/**
	 * Counts the posts that carry a node status (a snapshot or a `nodeStatus`), so that only the
	 * latest one, once it resolves, decides what was sent: an older post resolving later must not
	 * overwrite it (F1).
	 */
	private statusPosts = 0;
	/** Set once the panel is disposed: nothing is posted after that (F6). */
	private disposed = false;
	/** The serialisation of the host status last handed to the webview (snapshot or `hostStatus`). */
	private sentHost: string | undefined;
	/**
	 * The catalogue the webview's model was built with, so that a new schema sends the model once;
	 * `undefined` while the webview has no model built with a schema it still shows.
	 */
	private modelCatalogue: ComponentCatalog | undefined;
	/** The metrics feeds (ticket 7.3), once connected, and the hold on this file's feed. */
	private metrics: GraphMetrics | undefined;
	private metricsSubscription: MetricsSubscription | undefined;
	/** The feed's last update. */
	private metricsUpdate: MetricsUpdate | undefined;
	/** The node figures last mapped and sent (in a snapshot or a `nodeFigures`), with its serialisation. */
	private figures: NodeFiguresById = {};
	private sentFigures = '{}';
	private fileUri: vscode.Uri;

	constructor(
		/** The file's URI; a rename (`onDidRenameFiles`) replaces it. */
		uri: vscode.Uri,
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
		/** The VS Code API it reaches: the registry's Source (`GraphPanelsOptions.source`). */
		private readonly source: GraphPanelSource,
		/** Test seam (`GraphPanelsOptions.ignoreWebviewMessages`): the webview's own messages are not handled. */
		ignoreWebviewMessages = false,
	) {
		this.fileUri = uri;
		if (!ignoreWebviewMessages) {
			this.subscriptions.push(panel.webview.onDidReceiveMessage(async (m) => {
				await this.receive(m);
				if ((m as { type?: unknown } | null)?.type === 'ready') {
					this.webviewReadies++;
				}
			}));
		}
	}

	/** The file's URI; a rename replaces it, and the panel then holds the new file's metrics feed. */
	get uri(): vscode.Uri {
		return this.fileUri;
	}

	set uri(uri: vscode.Uri) {
		const changed = uri.toString() !== this.fileUri.toString();
		this.fileUri = uri;
		if (changed && this.metrics) {
			this.subscribeMetrics();
		}
	}

	/**
	 * Ticket 7.3: holds the file's metrics feed while the panel lives, visible while the panel is (the
	 * feed reads while its tab or its graph is visible).
	 */
	connectMetrics(metrics: GraphMetrics): void {
		if (this.disposed || this.metrics) {
			return;
		}
		this.metrics = metrics;
		this.subscribeMetrics();
		this.subscriptions.push(this.panel.onDidChangeViewState(() => this.metricsSubscription?.setVisible(this.panel.visible)));
	}

	private subscribeMetrics(): void {
		this.metricsSubscription?.dispose();
		const sub = this.metrics!.subscribe(this.fileUri, (update) => {
			if (this.metricsSubscription === sub) {
				this.metricsUpdated(update);
			}
		}, this.panel.visible);
		this.metricsSubscription = sub;
		this.metricsUpdated(sub.feed.update);
	}

	private metricsUpdated(update: MetricsUpdate): void {
		this.metricsUpdate = update;
		void this.sendFigures().catch((e: unknown) => this.fail(e));
	}

	/**
	 * Maps the feed's last reading onto the current model and posts `nodeFigures` when it changed:
	 * `{}` without a live run (the figures of a stopped run are not shown) or an open document; frozen
	 * while the YAML does not parse (as the node status, AD-17). Ticket 7.6: the feed's figures are over
	 * the session's window (the tab's choice, 5 min when it was never opened), so each node matches its
	 * row; a new window is a new update, re-posted here.
	 */
	private async sendFigures(): Promise<void> {
		const update = this.metricsUpdate;
		let figures: NodeFiguresById = {};
		if (update?.state.kind === 'live' && update.figures) {
			const doc = openDocument(this.uri.toString(), this.source.workspace.textDocuments);
			const state = doc ? this.state(doc) : undefined;
			if (state?.parseError) {
				return;
			}
			if (state?.model) {
				figures = nodeFiguresOf(state.model, state.paths ?? new Map(), update.figures);
			}
		}
		this.figures = figures;
		const serialised = JSON.stringify(figures);
		if (serialised === this.sentFigures) {
			return;
		}
		this.sentFigures = serialised;
		await this.post({ type: 'nodeFigures', byId: figures });
	}

	async receive(message: unknown): Promise<void> {
		try {
			const msg = parseWebviewMessage(message);
			if (msg?.type === 'ready') {
				// Only a document already open (4.13): a `ready` never reopens a closed one, which would
				// then stay open for minutes. Closed, the last model and status, if any (READY_CLOSED).
				const doc = openDocument(this.uri.toString(), this.source.workspace.textDocuments);
				if (doc || this.lastModel) {
					await this.postSnapshot(doc);
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
	 * The webview's complete state, `snapshot`, for `doc` (`ready`, and a schema back while the
	 * YAML does not parse). A snapshot sets the live region's baseline and announces nothing (F4).
	 * With no `doc` (`ready` after the document closed, 4.13): the last valid model, the node
	 * status it still holds and the last selection, and no parse error.
	 */
	private async postSnapshot(doc: vscode.TextDocument | undefined): Promise<void> {
		// Read after any await, with the catalogue, so a change meanwhile is not overwritten.
		const hostStatus = this.hostStatus();
		const state = doc ? this.state(doc) : {};
		const catalogue = doc ? this.built?.catalogue : this.catalogue();
		// While the YAML is broken the highlight stays as it was (BROKEN, SNAPSHOT).
		const selection = state.model ? this.cursorNode(state.model) : this.sentSelection;
		this.sentSelection = selection;
		// While the YAML is broken, the frozen status (SNAPSHOT).
		const status = doc && state.model ? this.computeStatus(doc, state.model) : undefined;
		// While the YAML is broken, the last valid model of this panel (FIRST_BROKEN, RECREATED);
		// with no schema, none (MISSING).
		const model = catalogue ? state.model ?? this.lastModel : null;
		this.sentHost = JSON.stringify(hostStatus);
		// The last model without a document was built with an earlier catalogue: what the webview's
		// model was built with is unchanged (a later schema still sends one).
		if (doc || !model) {
			this.modelCatalogue = model ? catalogue : undefined;
		}
		// The snapshot's status supersedes any status post still in flight (F1_RACE).
		const serialised = status ?? JSON.stringify(this.status);
		const seq = ++this.statusPosts;
		this.postingStatus = serialised;
		// The current figures (GRAPH_REOPENED), only when there are any.
		const figures = this.figures;
		this.sentFigures = JSON.stringify(figures);
		const delivered = await this.post({
			type: 'snapshot',
			model,
			...(state.parseError ? { parseError: state.parseError } : {}),
			nodeStatus: this.status,
			selection,
			hostStatus,
			...(Object.keys(figures).length > 0 ? { nodeFigures: figures } : {}),
		});
		this.statusPosted(seq, serialised, delivered);
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
	 * and the node status (SET_PATH, RETRY, LATE_SCHEMA), or, while the YAML does not parse, a
	 * snapshot (the last valid graph under the banner, which a snapshot does not announce, F4).
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
			const doc = openDocument(key, this.source.workspace.textDocuments);
			if (!catalogue || catalogue === this.modelCatalogue || !doc) {
				return;
			}
			const state = this.state(doc);
			if (state.parseError) {
				// The webview dropped its model and banner with the schema; a snapshot shows the banner
				// again over the last valid graph, if any, without announcing it again (F4_LIVE).
				await this.postSnapshot(doc);
				this.modelCatalogue = catalogue;
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
			const doc = openDocument(key, this.source.workspace.textDocuments);
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

	/** Whether the panel was disposed (F6): the lock sequence stops then. */
	get isDisposed(): boolean {
		return this.disposed;
	}

	/**
	 * Ties `disposable` to the panel: it is disposed with it (the late lock sequence's listeners,
	 * bug 15), or at once when the panel is already disposed.
	 */
	own(disposable: vscode.Disposable): void {
		if (this.disposed) {
			disposable.dispose();
		} else {
			this.subscriptions.push(disposable);
		}
	}

	/** Marks the lock sequence ended (`lockSettled`); later calls do nothing. */
	settleLock(): void {
		this.settle();
	}

	dispose(): void {
		this.disposed = true;
		this.metricsSubscription?.dispose();
		this.metricsSubscription = undefined;
		this.settle();
		this.subscriptions.forEach((d) => d.dispose());
	}

	/**
	 * Posts `message`; `true` once the post resolved, `false` if it threw (a disposed panel). A
	 * post that resolves `false` (a webview that is not live yet) still counts as sent: such a
	 * webview posts `ready` when it comes alive and gets the full snapshot, so re-sending would only
	 * churn. After the panel is disposed nothing is posted (`false`), and a post the disposal
	 * interrupted logs nothing (F6).
	 */
	private async post(message: HostMessage): Promise<boolean> {
		if (this.disposed) {
			return false;
		}
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
		const seq = ++this.statusPosts;
		this.postingStatus = serialised;
		const ok = await this.post({ type: 'nodeStatus', byId: this.status });
		this.statusPosted(seq, serialised, ok);
	}

	/**
	 * A status post (number `seq`, of `serialised`) resolved: only the latest one decides what was
	 * sent, since the webview applies the posts in order and keeps the last (F1).
	 */
	private statusPosted(seq: number, serialised: string, delivered: boolean): void {
		if (seq !== this.statusPosts) {
			return;
		}
		this.postingStatus = undefined;
		if (delivered) {
			this.sentStatus = serialised;
		}
	}

	/** Sends `model`, then the selection and the node status for it, when they changed. */
	private async sendModel(doc: vscode.TextDocument, model: PipelineModel): Promise<void> {
		this.modelCatalogue = this.built?.catalogue;
		await this.post({ type: 'model', model });
		await this.sendSelection(model);
		// Red Hat's diagnostics in the view are held at their shifted ranges until it republishes (story 13).
		await this.sendStatus(doc, model);
		// Ticket 7.3: the last reading's figures on the new model's ids (a node gone loses its line).
		await this.sendFigures();
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
		return openDocument(key, this.source.workspace.textDocuments)
			?? this.source.workspace.openTextDocument(this.uri);
	}

	/**
	 * The document's model, or its parse error (one parse per version, through the shared cache).
	 * A valid model becomes the panel's last valid model. With no schema there is neither (AD-20):
	 * the webview shows an empty state, and the last valid model is kept.
	 */
	private state(doc: vscode.TextDocument): BuiltState {
		const catalogue = this.catalogue();
		if (this.built?.doc === doc && this.built.version === doc.version && this.built.catalogue === catalogue) {
			return this.built.state;
		}
		const state = catalogue ? this.build(doc, catalogue) : {};
		this.built = { doc, version: doc.version, catalogue, state };
		return state;
	}

	/** The model with `catalogue`, which becomes the last valid model, or the parse error. */
	private build(doc: vscode.TextDocument, catalogue: ComponentCatalog): BuiltState {
		const { text, parsed } = parsedDocument(doc);
		const parseError = parseErrorOf(parsed);
		let state: BuiltState;
		if (parseError) {
			state = { parseError };
		} else {
			const model = buildPipelineModel(parsed, text, catalogue);
			this.lastModel = model;
			state = { model, paths: componentPaths(parsed, text, catalogue) };
		}
		return state;
	}

	/** Logs `e`; nothing once the panel is disposed: what fails then is only the disposal (F6). */
	private fail(e: unknown): void {
		if (this.disposed) {
			return;
		}
		this.log(`Graph ${path.posix.basename(this.uri.path)}: ${errorText(e)}`);
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
	 * Esc on the graph container (ticket 3.11, ESC): focuses the file's driving editor, else a
	 * visible editor for it, leaving its cursor and selection as they are (no `selection` is
	 * passed). With no editor for the file nothing happens, and nothing is logged.
	 */
	private async focusEditor(): Promise<void> {
		const editor = this.editor();
		if (!editor) {
			return;
		}
		await this.source.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
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
		const editor = await this.source.window.showTextDocument(doc, {
			viewColumn: this.editor()?.viewColumn ?? vscode.ViewColumn.One,
			preserveFocus: false,
		});
		editor.selection = new vscode.Selection(range.start, range.end);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
	}
}
