// The Pipeline Metrics tab (ticket 7.2, AD-25): a webview view in its own container in the bottom
// panel, next to Pipeline Logs. **Show Pipeline Metrics** binds it to the active editor's config (not
// to whichever editor is active later) and opens it. The readings come from the file's metrics feed
// (`metricsFeed.ts`, ticket 7.3), which the file's graph shares: it reads the run's `/metrics` every
// 2 s while the tab or the graph is visible. Each reading becomes the rows (`src/core/metrics.ts`: one
// per component of the config's model in config order, nested ones indented, a series with no node
// last); the host computes every figure and the order (a header's sort), the webview only renders.
//
// States (the feed's): no run → "Run this file to see its metrics" (nothing is read); the run
// stopped → its last figures stay, marked stopped, reading stops; a rerun of the file resumes on its
// new port (the figures start again). A config whose own `metrics` section is not `prometheus` is "no
// metrics served" with its type, and is not read (the run's `http` section is always overridden,
// AD-25); so is an answer that holds no Connect metrics. A read that fails otherwise is tried again at
// the interval, quietly until 3 failures in a row. Hidden, the tab tells the feed so; closing it drops
// its hold on the feed, and the feed drops every reading once nothing that shows them is visible.

import * as path from 'path';
import * as vscode from 'vscode';
import {
	localSourceLabel, parseMetricsWebviewMessage, type MetricRow, type MetricsHostMessage, type MetricsPanelState, type MetricsSort,
} from '../../shared/metricsProtocol';
import type { ComponentFigures } from '../../core/metrics';
import { metricRows, sortRows } from '../../core/metrics';
import { webviewHtml } from '../graphPanel/html';
import type { MetricsFeeds, MetricsSourceFactory, MetricsSubscription, MetricsUpdate } from './metricsFeed';

export { METRICS_INTERVAL_MS, NO_SERIES_READS, QUIET_FAILURES, type MetricsConfig, type MetricsRun, type MetricsSourceFactory } from './metricsFeed';

export const METRICS_VIEW_ID = 'redpandaConnect.pipelineMetrics';
export const SHOW_METRICS_COMMAND = 'redpandaConnect.showPipelineMetrics';
export const NO_CONFIG_MESSAGE = 'Open a Redpanda Connect config to see the metrics of its run.';
/** How many of the posted messages `posted` keeps (test seam). */
const MAX_POSTED = 200;

export interface MetricsPanelOptions {
	readonly extensionUri: vscode.Uri;
	readonly log: (line: string) => void;
	/** The files' metrics feeds (shared with the graph panels). */
	readonly feeds: MetricsFeeds;
	/** The active editor's document URI (default: VS Code's). */
	readonly activeUri?: () => vscode.Uri | undefined;
	readonly showInformationMessage?: (message: string) => void;
	/** Opens the tab (default: the view's focus command; a test seam). */
	readonly focus?: () => Thenable<unknown>;
}

const NONE: MetricsPanelState = { kind: 'none' };

export class MetricsPanel implements vscode.Disposable {
	/** The last messages posted to the webview, in order (test seam). */
	readonly posted: MetricsHostMessage[] = [];
	private view: vscode.WebviewView | undefined;
	private viewSubscriptions: vscode.Disposable[] = [];
	private ready = false;
	private uri: vscode.Uri | undefined;
	/** The hold on the bound file's feed. */
	private subscription: MetricsSubscription | undefined;
	private update: MetricsUpdate | undefined;
	/** The figures the rows were made from (a new reading is a new map). */
	private rowsFrom: ReadonlyMap<string, ComponentFigures> | undefined;
	private configRows: MetricRow[] = [];
	private sort: MetricsSort | null = null;
	private readonly changed = new vscode.EventEmitter<void>();
	/** Fires when the rows or the state change (test seam). */
	readonly onDidChange = this.changed.event;

	constructor(private readonly options: MetricsPanelOptions) {}

	register(): vscode.Disposable[] {
		return [
			vscode.window.registerWebviewViewProvider(METRICS_VIEW_ID, this),
			vscode.commands.registerCommand(SHOW_METRICS_COMMAND, (uri?: vscode.Uri) => this.showFor(uri)),
		];
	}

	/** Test seam: the source a port is read through (default: the local `/metrics`), for every feed. */
	setSourceFactory(factory: MetricsSourceFactory | undefined): void {
		this.options.feeds.setSourceFactory(factory);
	}

	/** The bound file's URI string; `undefined` before the first Show Pipeline Metrics. */
	get file(): string | undefined {
		return this.uri?.toString();
	}

	get state(): MetricsPanelState {
		return this.update?.state ?? NONE;
	}

	/** The rows as shown (sorted). */
	rows(): readonly MetricRow[] {
		return sortRows(this.configRows, this.sort);
	}

	/** How many reads of the bound file's feed were started (test seam). */
	get readCount(): number {
		return this.subscription?.feed.readCount ?? 0;
	}

	get visible(): boolean {
		return this.view?.visible === true;
	}

	/** "Local run · <file>", or `undefined` before the first Show Pipeline Metrics. */
	get title(): string | undefined {
		return this.uri ? localSourceLabel(path.basename(this.uri.fsPath)) : undefined;
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.viewSubscriptions.forEach((s) => s.dispose());
		this.view = view;
		this.ready = false;
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, 'dist')] };
		view.webview.html = webviewHtml(view.webview, this.options.extensionUri, 'metrics', 'Pipeline Metrics');
		this.viewSubscriptions = [
			view.webview.onDidReceiveMessage((raw: unknown) => {
				const m = parseMetricsWebviewMessage(raw);
				switch (m?.type) {
					case 'ready':
						this.ready = true;
						this.postShow();
						break;
					case 'sort':
						this.sort = m.sort;
						this.postShow();
						this.changed.fire();
						break;
				}
			}),
			view.onDidChangeVisibility(() => {
				if (!view.visible) {
					// Not retained while hidden: the page loads again (and posts `ready`) when shown.
					this.ready = false;
				}
				// Hidden, the feed drops its readings unless the graph still shows them.
				this.subscription?.setVisible(view.visible);
			}),
			view.onDidDispose(() => {
				if (this.view === view) {
					this.view = undefined;
					this.ready = false;
					this.viewSubscriptions.forEach((s) => s.dispose());
					this.viewSubscriptions = [];
					// Nothing is kept after the tab closes.
					this.subscription?.setVisible(false);
				}
			}),
		];
		this.updateDescription();
		this.subscription?.setVisible(view.visible);
	}

	/** Show Pipeline Metrics: `uri` (default: the active editor's file) is bound, and the tab opens. */
	async showFor(uri?: vscode.Uri): Promise<void> {
		const target = uri ?? (this.options.activeUri ?? (() => vscode.window.activeTextEditor?.document.uri))();
		if (!target) {
			(this.options.showInformationMessage ?? ((m: string) => { void vscode.window.showInformationMessage(m); }))(NO_CONFIG_MESSAGE);
			return;
		}
		await this.show(target);
	}

	/**
	 * Binds the tab to `uri` and opens it. A feed already reading (for the file's graph, or for this tab
	 * already bound to it) is kept as it is, and the tab takes its current update (ticket 7.3: one
	 * reading for both); otherwise its readings start again (ticket 7.2).
	 */
	async show(uri: vscode.Uri): Promise<void> {
		this.uri = uri;
		const old = this.subscription;
		let sub: MetricsSubscription;
		if (old && old.feed.uri.toString() === uri.toString()) {
			sub = old;
		} else {
			// Not visible until the tab is focused (as 7.2: the tab's first read comes after the focus).
			const added = this.options.feeds.subscribe(uri, (update) => this.updated(added, update), false);
			sub = added;
			this.subscription = sub;
			old?.dispose();
		}
		if (!sub.feed.visible) {
			sub.feed.restart();
		}
		this.rowsFrom = undefined;
		this.configRows = [];
		this.updated(sub, sub.feed.update, false);
		const port = sub.feed.update.port;
		this.options.log(`Pipeline metrics: showing ${path.basename(uri.fsPath)}${port ? ` (127.0.0.1:${port})` : ''}.`);
		this.updateDescription();
		this.postShow();
		this.changed.fire();
		await (this.options.focus ?? (() => vscode.commands.executeCommand(`${METRICS_VIEW_ID}.focus`)))();
		if (this.subscription === sub) {
			sub.setVisible(this.visible);
		}
	}

	dispose(): void {
		this.viewSubscriptions.forEach((s) => s.dispose());
		this.subscription?.dispose();
		this.subscription = undefined;
		this.changed.dispose();
	}

	/** The feed changed: the rows of a new reading, with the config now; the state. */
	private updated(sub: MetricsSubscription, update: MetricsUpdate, post = true): void {
		if (sub !== this.subscription || !this.uri) {
			return;
		}
		this.update = update;
		if (update.figures !== this.rowsFrom) {
			this.rowsFrom = update.figures;
			if (update.figures) {
				const config = this.options.feeds.configOf(this.uri);
				this.configRows = metricRows(config?.model ?? { nodes: [], edges: [] }, config?.paths ?? new Map(), update.figures);
			} else {
				this.configRows = [];
			}
		}
		if (post) {
			this.postShow();
			this.changed.fire();
		}
	}

	private updateDescription(): void {
		if (this.view) {
			this.view.description = this.title;
		}
	}

	private postShow(): void {
		const message: MetricsHostMessage = {
			type: 'show',
			source: this.title ?? null,
			file: this.uri ? path.basename(this.uri.fsPath) : null,
			port: this.update?.port ?? null,
			state: this.state,
			rows: this.rows(),
			intervalMs: this.options.feeds.intervalMs,
			sort: this.sort,
		};
		this.posted.push(message);
		if (this.posted.length > MAX_POSTED) {
			this.posted.splice(0, this.posted.length - MAX_POSTED);
		}
		if (this.view && this.ready) {
			void this.view.webview.postMessage(message);
		}
	}
}
