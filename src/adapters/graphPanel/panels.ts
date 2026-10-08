// The graph panel registry (ticket 3.1, AD-1): one WebviewPanel per file, beside the editor,
// keyed by `uri.toString()`. The webview posts `ready` (again whenever it is recreated, since
// `retainContextWhenHidden` is off) and gets a fresh `snapshot`; a `nodeActivated` click selects
// and reveals that node's YAML range in the file's text editor. Nothing edits the text (AD-19).

import * as path from 'path';
import * as vscode from 'vscode';
import { buildPipelineModel } from '../../core/graph';
import type { HostMessage, PipelineModel, WebviewMessage } from '../../shared/protocol';
import { parsedDocument } from '../vscode/parseCache';
import { graphHtml } from './html';

export const SHOW_GRAPH_COMMAND = 'redpandaConnect.showGraph';
export const GRAPH_VIEW_TYPE = 'redpandaConnect.graph';

/** The tab title of a file's graph panel. */
export function graphTitle(uri: vscode.Uri): string {
	return `Graph: ${path.posix.basename(uri.path)}`;
}

/** One file's panel, as seen by tests (the host-side seam; tests don't drive the webview DOM). */
export interface GraphPanelHandle {
	readonly uri: vscode.Uri;
	readonly panel: vscode.WebviewPanel;
	/** Every message posted to the webview, in order. */
	readonly posted: readonly HostMessage[];
	/** Handles `message` as if the webview had posted it. */
	receive(message: unknown): Promise<void>;
}

class GraphPanel implements GraphPanelHandle {
	readonly posted: HostMessage[] = [];
	private readonly subscriptions: vscode.Disposable[] = [];

	constructor(
		readonly uri: vscode.Uri,
		readonly panel: vscode.WebviewPanel,
		private readonly log: (line: string) => void,
	) {
		this.subscriptions.push(panel.webview.onDidReceiveMessage((m) => this.receive(m)));
	}

	async receive(message: unknown): Promise<void> {
		try {
			const msg = asWebviewMessage(message);
			if (msg?.type === 'ready') {
				await this.post({ type: 'snapshot', model: await this.model() });
			} else if (msg?.type === 'nodeActivated') {
				await this.activate(msg.nodeId);
			}
		} catch (e) {
			this.log(`Graph ${path.posix.basename(this.uri.path)}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	dispose(): void {
		this.subscriptions.forEach((d) => d.dispose());
	}

	private async post(message: HostMessage): Promise<void> {
		this.posted.push(message);
		await this.panel.webview.postMessage(message);
	}

	private async document(): Promise<vscode.TextDocument> {
		const key = this.uri.toString();
		return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key)
			?? vscode.workspace.openTextDocument(this.uri);
	}

	private async model(doc?: vscode.TextDocument): Promise<PipelineModel> {
		const d = doc ?? await this.document();
		const { text, parsed } = parsedDocument(d);
		return buildPipelineModel(parsed, text);
	}

	/** Selects and reveals the node's range; an unknown id does nothing. */
	private async activate(nodeId: string): Promise<void> {
		const doc = await this.document();
		const node = (await this.model(doc)).nodes.find((n) => n.id === nodeId);
		if (!node) {
			return;
		}
		const range = new vscode.Range(doc.positionAt(node.range[0]), doc.positionAt(node.range[1]));
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

/** Validates a message from the webview; `undefined` for anything else. */
function asWebviewMessage(message: unknown): WebviewMessage | undefined {
	if (typeof message !== 'object' || message === null) {
		return undefined;
	}
	const m = message as { type?: unknown; nodeId?: unknown; via?: unknown };
	if (m.type === 'ready') {
		return { type: 'ready' };
	}
	if (m.type === 'nodeActivated' && typeof m.nodeId === 'string' && m.via === 'click') {
		return { type: 'nodeActivated', nodeId: m.nodeId, via: 'click' };
	}
	return undefined;
}

export interface GraphPanelsOptions {
	readonly extensionUri: vscode.Uri;
	readonly log: (line: string) => void;
}

/** All open graph panels, one per file (AD-1). */
export class GraphPanels implements vscode.Disposable {
	private readonly panels = new Map<string, GraphPanel>();

	constructor(private readonly options: GraphPanelsOptions) {}

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
			const graph = new GraphPanel(target, panel, this.options.log);
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
		for (const graph of [...this.panels.values()]) {
			graph.panel.dispose();
		}
		this.panels.clear();
	}
}
