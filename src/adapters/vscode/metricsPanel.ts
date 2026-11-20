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
//
// Ticket 7.5: **Show metrics** on a Cloud pipeline row binds the tab (`showCloud`) to that pipeline's feed:
// its local file's (shared with that file's graph, which then shows the Cloud figures), or, with no file,
// one of its own (rows by path). The header names it ("Cloud · <cluster> · <pipeline>", the endpoint's
// host, the mapped file or "not mapped to a file", the interval); no access and a refused read are
// states of their own. Show Pipeline Metrics on the file binds it back to the local run.

import * as path from 'path';
import * as vscode from 'vscode';
import {
	cloudSourceLabel, localSourceLabel, parseMetricsWebviewMessage, type MetricRow, type MetricsHostMessage, type MetricsPanelState, type MetricsSort,
} from '../../shared/metricsProtocol';
import type { ComponentFigures } from '../../core/metrics';
import { metricRows, sortRows } from '../../core/metrics';
import { webviewHtml } from '../graphPanel/html';
import { cloudMetricsKey, type CloudMetricsBinding, type MetricsFeeds, type MetricsSourceFactory, type MetricsSubscription, type MetricsUpdate } from './metricsFeed';

export {
	CLOUD_METRICS_INTERVAL_MS, CLOUD_MIN_GAP_MS, METRICS_INTERVAL_MS, NO_SERIES_READS, QUIET_FAILURES, type CloudMetricsBinding, type MetricsConfig, type MetricsRun,
	type MetricsSourceFactory,
} from './metricsFeed';

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

	/** "Local run · <file>" or (ticket 7.5) "Cloud · <cluster> · <pipeline>", or `undefined` before the first Show. */
	get title(): string | undefined {
		const source = this.update?.source;
		if (source?.kind === 'cloud') {
			return cloudSourceLabel(source.clusterName, source.pipelineName);
		}
		return this.uri ? localSourceLabel(path.basename(this.uri.fsPath)) : undefined;
	}

	/** Ticket 7.5: the shown file's name (a Cloud pipeline's mapped file; `null`: none). */
	private get fileName(): string | null {
		const source = this.update?.source;
		if (source?.kind === 'cloud') {
			return source.file ? path.basename(source.file.fsPath) : null;
		}
		return this.uri ? path.basename(this.uri.fsPath) : null;
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
		const sub = this.bind(uri);
		if (sub.feed.cloudBinding) {
			// Ticket 7.5: last chosen wins: the file's tab and graph go back to its local run.
			sub.feed.bindLocal();
		} else if (!sub.feed.visible) {
			sub.feed.restart();
		}
		this.rowsFrom = undefined;
		this.configRows = [];
		this.updated(sub, sub.feed.update, false);
		const port = sub.feed.update.port;
		this.options.log(`Pipeline metrics: showing ${path.basename(uri.fsPath)}${port ? ` (127.0.0.1:${port})` : ''}.`);
		await this.opened(sub);
	}

	/**
	 * Ticket 7.5: Show metrics on a Cloud pipeline: the tab is bound to its feed (its local file's, shared
	 * with that file's graph, else its own) and opens; the feed reads the pipeline from now on.
	 */
	async showCloud(binding: CloudMetricsBinding): Promise<void> {
		const sub = this.bind(binding.file ?? cloudMetricsKey(binding.clusterId, binding.pipelineId));
		this.rowsFrom = undefined;
		this.configRows = [];
		sub.feed.bindCloud(binding);
		this.updated(sub, sub.feed.update, false);
		this.options.log(`Pipeline metrics: showing pipeline ${binding.pipelineName} on ${binding.clusterName} (${binding.host})`
			+ `${binding.file ? `, mapped to ${path.basename(binding.file.fsPath)}` : ', not mapped to a file'}.`);
		await this.opened(sub);
	}

	/** The tab's hold on the feed of `uri` (kept when it is already that feed). */
	private bind(uri: vscode.Uri): MetricsSubscription {
		this.uri = uri;
		const old = this.subscription;
		if (old && old.feed.uri.toString() === uri.toString()) {
			return old;
		}
		// Not visible until the tab is focused (as 7.2: the tab's first read comes after the focus).
		const added = this.options.feeds.subscribe(uri, (update) => this.updated(added, update), false);
		this.subscription = added;
		old?.dispose();
		return added;
	}

	/** Posts the bound feed's state and opens the tab. */
	private async opened(sub: MetricsSubscription): Promise<void> {
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
			// Ticket 7.5: the source can change under the tab (a local run taking the file back from the Cloud).
			this.updateDescription();
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
			file: this.fileName,
			port: this.update?.port ?? null,
			state: this.state,
			rows: this.rows(),
			intervalMs: this.update?.intervalMs ?? this.options.feeds.intervalMs,
			sort: this.sort,
			...(this.update?.source.kind === 'cloud' ? { cloud: { host: this.update.source.host } } : {}),
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
