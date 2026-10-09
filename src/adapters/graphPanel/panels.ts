// The graph panel registry (tickets 3.1, 3.6, AD-1, AD-6): one WebviewPanel per file, beside the
// editor, keyed by `uri.toString()`. The webview posts `ready` (again whenever it is recreated,
// since `retainContextWhenHidden` is off) and gets a fresh `snapshot`. On every change to a file
// with an open panel the host sends the complete `model`, or, while the YAML does not parse, only
// `parseError`; the webview keeps the last valid graph under a banner. The snapshot carries the
// panel's last valid model (or `null`) and the current `parseError`. A `nodeActivated` (click or
// keyboard) selects and reveals that node's YAML range in the file's text editor, and
// `bannerClicked` selects the parse error. Nothing edits the text (AD-19). The model is built with
// the ComponentCatalog of the current schema (AD-20, ticket 3.3), derived once per schema object;
// with no schema the model is empty. Node status, selection and host status are not sent yet
// (3.7-3.9), so the snapshot carries them empty.

import * as path from 'path';
import * as vscode from 'vscode';
import { componentCatalogue, type ComponentCatalog } from '../../core/catalogue';
import { buildPipelineModel } from '../../core/graph';
import { errorSelection, parseErrorOf } from '../../core/parseError';
import type { JsonObject } from '../../core/schema';
import { parseWebviewMessage, type HostMessage, type HostStatus, type ParseError, type PipelineModel } from '../../shared/protocol';
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

	constructor(
		readonly uri: vscode.Uri,
		readonly panel: vscode.WebviewPanel,
		private readonly log: (line: string) => void,
		private readonly catalogue: () => ComponentCatalog | undefined,
	) {
		this.subscriptions.push(panel.webview.onDidReceiveMessage((m) => this.receive(m)));
	}

	async receive(message: unknown): Promise<void> {
		try {
			const msg = parseWebviewMessage(message);
			if (msg?.type === 'ready') {
				const state = this.state(await this.document());
				await this.post({
					type: 'snapshot',
					// While the YAML is broken, the last valid model of this panel (FIRST_BROKEN, RECREATED).
					model: state.model ?? this.lastModel,
					...(state.parseError ? { parseError: state.parseError } : {}),
					nodeStatus: {},
					selection: null,
					hostStatus: SNAPSHOT_HOST_STATUS,
				});
			} else if (msg?.type === 'nodeActivated') {
				await this.activate(msg.nodeId);
			} else if (msg?.type === 'bannerClicked') {
				await this.selectParseError();
			}
		} catch (e) {
			this.fail(e);
		}
	}

	/** The panel's document changed (AD-6): the complete model, or only the parse error. */
	async changed(doc: vscode.TextDocument): Promise<void> {
		try {
			const state = this.state(doc);
			await this.post(state.parseError ? { type: 'parseError', ...state.parseError } : { type: 'model', model: state.model! });
		} catch (e) {
			this.fail(e);
		}
	}

	dispose(): void {
		this.subscriptions.forEach((d) => d.dispose());
	}

	private async post(message: HostMessage): Promise<void> {
		this.posted.push(message);
		if (this.posted.length > MAX_POSTED) {
			this.posted.splice(0, this.posted.length - MAX_POSTED);
		}
		await this.panel.webview.postMessage(message);
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
		const { text, parsed } = parsedDocument(doc);
		const parseError = parseErrorOf(parsed);
		if (parseError) {
			return { parseError };
		}
		// With no schema snapshot the catalogue is undefined and the builder gives the empty model
		// (the no-binary empty state is ticket 3.9).
		const model = buildPipelineModel(parsed, text, this.catalogue());
		this.lastModel = model;
		return { model };
	}

	private fail(e: unknown): void {
		this.log(`Graph ${path.posix.basename(this.uri.path)}: ${e instanceof Error ? e.message : String(e)}`);
	}

	/** Selects and reveals the node's range; an unknown id does nothing. */
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

	/** Selects and reveals `range` in the file's text editor (its visible column, else the first). */
	private async select(doc: vscode.TextDocument, range: vscode.Range): Promise<void> {
		const key = this.uri.toString();
		const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
		const editor = await vscode.window.showTextDocument(doc, {
			viewColumn: visible?.viewColumn ?? vscode.ViewColumn.One,
			preserveFocus: false,
		});
		editor.selection = new vscode.Selection(range.start, range.end);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}
}

export interface GraphPanelsOptions {
	readonly extensionUri: vscode.Uri;
	readonly log: (line: string) => void;
	/** The current transformed schema (AD-10), `undefined` while there is none. */
	readonly schema: () => JsonObject | undefined;
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
	private readonly changes: vscode.Disposable;

	constructor(private readonly options: GraphPanelsOptions) {
		// One subscription for all panels: a change goes to the panel of its file, if one is open
		// (OTHER_DOC, CLOSED). Events with no content change (dirty state, save) send nothing.
		this.changes = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.contentChanges.length > 0) {
				void this.panels.get(e.document.uri.toString())?.changed(e.document);
			}
		});
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
			const graph = new GraphPanel(target, panel, this.options.log, () => catalogueOf(this.options.schema()));
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
		this.changes.dispose();
		for (const graph of [...this.panels.values()]) {
			graph.panel.dispose();
		}
		this.panels.clear();
	}
}
