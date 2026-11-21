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
//
// Ticket 7.6: the header's 1 / 5 / 15 min control chooses the window the figures are over (5 min until
// one is chosen; the choice is the session's, in memory, shared with the graphs through the feeds): the
// rows and trends are recomputed at once from the readings kept, with no read, and the footer says it.
//
// Ticket 7.7: each reading's rows carry their share of the pipeline's time and the marks (the slowest,
// errors), and the tab gets the summary line made from them (`metricsSummary`, core): the slowest, the
// input's and the output's rates and their gap, the components with errors.
//
// Ticket 8 (board 5): each state but live shows a title, a body and its buttons (`metricsStateActions`,
// shared with the webview), which the host carries out on the tab's current binding only (a button the
// state does not show is ignored): Run <file> (the file's Run), Show <pipeline> on <cluster> (a not-running
// file's `.cloud.json` pipeline, through Show metrics), Open the metrics section (the config's top-level
// `metrics:` key, else the file's start), Read again and Retry now (the feed's), Set up metrics access… and
// Forget metrics access (the Cloud view's commands on the bound cluster; while a set-up runs from the tab
// its buttons are disabled), Show output (the "Redpanda Connect" channel).
//
// Ticket 9 (board 5): one resolver (`showFor`) decides the source for Show Pipeline Metrics, the Run's
// status bar menu and the graph's Open Pipeline Metrics: the file (the argument, else the active config)
// → its local run when one runs (`show`) → its own `.cloud.json` pipeline (Show metrics, the Cloud view's
// command) → the file itself (Not running, with Run). With no active config, a pick of the running files
// and the Cloud pipelines the Cloud view has loaded (`NO_CONFIG_MESSAGE` when there are none). A tab
// opened by clicking it with nothing bound binds the same way without a pick (`bindOnOpen`): the active
// config's run, else its mapping, else the only running file; else "No pipeline chosen" stays. While the
// tab is visible and live on a local run, `readingRun` gives the run and its output rate (the status bar).

import * as path from 'path';
import * as vscode from 'vscode';
import {
	cloudSourceLabel, localSourceLabel, metricsStateActions, parseMetricsWebviewMessage, type MetricRow, type MetricsActionType, type MetricsHostMessage,
	type MetricsMappedPipeline, type MetricsPanelState, type MetricsSort, type MetricsSummary, type MetricsWindowMinutes,
} from '../../shared/metricsProtocol';
import type { ComponentFigures } from '../../core/metrics';
import { metricRows, metricsSectionRange, metricsSummary, sortRows } from '../../core/metrics';
import { parseYaml } from '../../core/yamlPath';
import { errorText } from '../../shared/errorText';
import { webviewHtml } from '../graphPanel/html';
import { FORGET_METRICS_ACCESS_COMMAND, SET_UP_METRICS_ACCESS_COMMAND, SHOW_CLOUD_METRICS_COMMAND } from './cloudMetrics';
import { RUN_COMMAND } from './run';
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
	/** Ticket 8: shows the "Redpanda Connect" output channel (Show output). */
	readonly showOutput?: () => void;
	/** Ticket 8: the Cloud pipeline a config's `.cloud.json` maps it to; `undefined`: none (or it can't be read). */
	readonly mappingOf?: (uri: vscode.Uri) => Promise<MappedPipelineOf | undefined>;
	/** Ticket 8: runs a command (default: VS Code's; a test seam). */
	readonly executeCommand?: (command: string, ...args: unknown[]) => Thenable<unknown>;
	/** Ticket 9: the files whose local run lives (default: none). */
	readonly runningUris?: () => readonly vscode.Uri[];
	/** Ticket 9: whether `uri` is a Redpanda Connect config (the active editor's file; default: any). */
	readonly isConfig?: (uri: vscode.Uri) => boolean;
	/** Ticket 9: the Cloud pipelines the Cloud view has already loaded (no request; default: none). */
	readonly cloudPipelines?: () => readonly LoadedCloudPipeline[];
}

/** Ticket 9: a Cloud pipeline the Cloud view has loaded, as the pick lists it. */
export interface LoadedCloudPipeline {
	readonly clusterId: string;
	readonly clusterName: string;
	readonly pipelineId: string;
	readonly pipelineName: string;
}

/** Ticket 9: an entry of the pick (no active config): a running file, or a loaded Cloud pipeline. */
export type MetricsPickItem =
	| { readonly kind: 'local'; readonly label: string; readonly description: string; readonly uri: vscode.Uri }
	| { readonly kind: 'cloud'; readonly label: string; readonly description: string; readonly pipeline: LoadedCloudPipeline };

/** Ticket 9: the pick's seam (`MetricsPanel.ui`). */
export interface MetricsPanelUi {
	pick(title: string, items: readonly MetricsPickItem[]): Thenable<MetricsPickItem | undefined>;
}

export const METRICS_PICK_TITLE = 'Show the metrics of';

const defaultUi: MetricsPanelUi = {
	pick: async (title, items) => {
		const picked = await vscode.window.showQuickPick(items.map((item) => ({ label: item.label, description: item.description, item })), { title, placeHolder: 'A running file or a Cloud pipeline' });
		return picked?.item;
	},
};

/** Ticket 8: a config's mapped Cloud pipeline: its ids and the names its button shows. */
export interface MappedPipelineOf extends MetricsMappedPipeline {
	readonly clusterId: string;
	readonly pipelineId: string;
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
	/** Ticket 7.7: the summary line of `configRows` (`null`: not shown). */
	private configSummary: MetricsSummary | null = null;
	private sort: MetricsSort | null = null;
	/** Ticket 8: the bound file's mapped Cloud pipeline, read when it is not running. */
	private mapped: MappedPipelineOf | undefined;
	/** Bumped on every read of the mapping, so an older one is dropped. */
	private mappingReads = 0;
	/** Ticket 8: the clusters whose Set up metrics access… runs from this tab. */
	private readonly settingUpFor = new Set<string>();
	/** Ticket 8: the state buttons carried out, in order (test seam). */
	readonly actions: MetricsActionType[] = [];
	/** Ticket 9: the pick shown with no active config (a test seam). */
	ui: MetricsPanelUi = defaultUi;
	/** Ticket 9: a bind on the tab's own opening runs (`bindOnOpen`). */
	private bindingOnOpen = false;
	/** Ticket 9: the active config whose mapping a bind on opening tried (once per config, so its messages don't repeat). */
	private mappingTriedFor: string | undefined;
	private readonly changed = new vscode.EventEmitter<void>();
	/** Fires when the rows or the state change (test seam). */
	readonly onDidChange = this.changed.event;

	constructor(private readonly options: MetricsPanelOptions) {}

	register(): vscode.Disposable[] {
		return [
			vscode.window.registerWebviewViewProvider(METRICS_VIEW_ID, this),
			vscode.commands.registerCommand(SHOW_METRICS_COMMAND, (uri?: unknown) => this.showFor(uri instanceof vscode.Uri ? uri : undefined)),
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

	/** Ticket 7.7: the summary line as sent (`null`: not shown). */
	get summary(): MetricsSummary | null {
		return this.configSummary;
	}

	/** How many reads of the bound file's feed were started (test seam). */
	get readCount(): number {
		return this.subscription?.feed.readCount ?? 0;
	}

	get visible(): boolean {
		return this.view?.visible === true;
	}

	/** Ticket 7.6: the window the figures are over (the session's). */
	get windowMinutes(): MetricsWindowMinutes {
		return this.options.feeds.windowMinutes;
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
			view.webview.onDidReceiveMessage((raw: unknown) => this.receive(raw)),
			view.onDidChangeVisibility(() => {
				if (!view.visible) {
					// Not retained while hidden: the page loads again (and posts `ready`) when shown.
					this.ready = false;
				}
				// Hidden, the feed drops its readings unless the graph still shows them.
				this.subscription?.setVisible(view.visible);
				if (view.visible) {
					void this.bindOnOpen();
				}
				// Ticket 9: `readingRun` follows the tab's visibility.
				this.changed.fire();
			}),
			view.onDidDispose(() => {
				if (this.view === view) {
					this.view = undefined;
					this.ready = false;
					this.viewSubscriptions.forEach((s) => s.dispose());
					this.viewSubscriptions = [];
					// Nothing is kept after the tab closes.
					this.subscription?.setVisible(false);
					this.changed.fire();
				}
			}),
		];
		this.updateDescription();
		this.subscription?.setVisible(view.visible);
		if (view.visible) {
			void this.bindOnOpen();
		}
	}

	/**
	 * Ticket 9: the tab opened by clicking it with nothing bound binds as Show Pipeline Metrics does, with
	 * no pick: the active config's run, else its mapped Cloud pipeline, else the only running file; else
	 * nothing ("No pipeline chosen" stays). Never throws.
	 */
	private async bindOnOpen(): Promise<void> {
		if (this.uri || this.bindingOnOpen) {
			return;
		}
		this.bindingOnOpen = true;
		try {
			const active = this.activeConfig();
			if (active && this.isRunning(active)) {
				await this.show(active);
				return;
			}
			// Once per active config (a failing Show metrics would repeat its message on every reveal); a Show
			// meanwhile (the command, a pick) wins over the tab's own bind.
			if (active && this.mappingTriedFor !== active.toString()) {
				this.mappingTriedFor = active.toString();
				await this.showMapped(active, () => !this.uri);
			}
			const running = this.running();
			if (!this.uri && running.length === 1) {
				await this.show(running[0]);
			}
		} catch (err) {
			this.options.log(`Pipeline metrics: binding the opened tab failed: ${errorText(err)}`);
		} finally {
			this.bindingOnOpen = false;
		}
	}

	/**
	 * Ticket 9: the local run the tab reads now, while it is visible and live, with its output rate
	 * (`null`: none yet); `undefined` otherwise (hidden, not live, a Cloud pipeline). No read of its own.
	 */
	get readingRun(): { readonly uri: string; readonly rate: number | null } | undefined {
		if (!this.uri || !this.visible || this.update?.source.kind !== 'local' || this.state.kind !== 'live') {
			return undefined;
		}
		return { uri: this.uri.toString(), rate: this.configSummary?.outputRate ?? null };
	}

	/**
	 * A message from the webview (a test seam too: the integration tests cannot click in it); a state
	 * button's promise settles once its action is done.
	 */
	async receive(raw: unknown): Promise<void> {
		const m = parseMetricsWebviewMessage(raw);
		if (!m) {
			return;
		}
		switch (m.type) {
			case 'ready':
				this.ready = true;
				this.postShow();
				break;
			case 'sort':
				this.sort = m.sort;
				this.postShow();
				this.changed.fire();
				break;
			case 'window': {
				// The feeds recompute their figures and emit (this tab's update posts the rows); with no
				// readings nothing is emitted, so the tab posts the new window itself.
				const before = this.posted.length;
				this.options.feeds.setWindowMinutes(m.minutes);
				if (this.posted.length === before) {
					this.postShow();
					this.changed.fire();
				}
				break;
			}
			default:
				await this.act(m.type);
		}
	}

	/** Ticket 8: the context of the state's buttons now (the host's view of the binding). */
	private get actionContext(): { readonly file: string | null; readonly cloud: boolean; readonly mapped: MetricsMappedPipeline | null } {
		const cloud = this.update?.source.kind === 'cloud';
		return { file: this.fileName, cloud, mapped: !cloud && this.state.kind === 'notRunning' && this.mapped ? this.mapped : null };
	}

	/** Whether a Set up metrics access… of the bound cluster runs from this tab. */
	private get settingUp(): boolean {
		const source = this.update?.source;
		return source?.kind === 'cloud'
			&& (this.settingUpFor.has(source.clusterId) || this.subscription?.feed.cloudBinding?.settingUp?.() === true);
	}

	/** Ticket 8: a state button, carried out on the current binding when the state shows it; ignored otherwise. */
	private async act(type: MetricsActionType): Promise<void> {
		const offered = metricsStateActions(this.state, this.actionContext).some((a) => a.type === type);
		const sub = this.subscription;
		const uri = this.uri;
		if (!offered || !sub || !uri) {
			this.options.log(`Pipeline metrics: ignored ${type}: the tab's state (${this.state.kind}) offers no such action.`);
			return;
		}
		this.actions.push(type);
		if (this.actions.length > MAX_POSTED) {
			this.actions.splice(0, this.actions.length - MAX_POSTED);
		}
		const source = sub.feed.update.source;
		const run = this.command();
		try {
			switch (type) {
				case 'runRequested':
					await run(RUN_COMMAND, uri);
					break;
				case 'showMappedRequested': {
					const m = this.mapped;
					if (m) {
						await run(SHOW_CLOUD_METRICS_COMMAND, { kind: 'pipeline', clusterId: m.clusterId, id: m.pipelineId });
					}
					break;
				}
				case 'metricsSectionRequested':
					await this.openMetricsSection(uri);
					break;
				case 'readAgainRequested':
					sub.feed.readAgain();
					break;
				case 'retryRequested':
					sub.feed.retryNow();
					break;
				case 'outputRequested':
					(this.options.showOutput ?? (() => undefined))();
					break;
				case 'setUpAccessRequested':
					if (source.kind === 'cloud') {
						await this.setUpAccess(source.clusterId, run);
					}
					break;
				case 'forgetAccessRequested':
					if (source.kind === 'cloud' && !this.settingUp) {
						await run(FORGET_METRICS_ACCESS_COMMAND, { kind: 'cluster', id: source.clusterId });
					}
					break;
			}
		} catch (err) {
			const binding = source.kind === 'cloud' ? sub.feed.cloudBinding : undefined;
			const text = errorText(err);
			this.options.log(`Pipeline metrics: ${type} failed: ${binding ? binding.mask(text) : text}`);
		}
	}

	/** Set up metrics access… on `clusterId` (the Cloud view's flow); its buttons disabled while it runs; a second one is ignored. */
	private async setUpAccess(clusterId: string, run: (command: string, ...args: unknown[]) => Thenable<unknown>): Promise<void> {
		if (this.settingUp) {
			return;
		}
		this.settingUpFor.add(clusterId);
		this.postShow();
		this.changed.fire();
		try {
			// Once stored, the feed follows the access change and reads.
			await run(SET_UP_METRICS_ACCESS_COMMAND, { kind: 'cluster', id: clusterId });
		} finally {
			this.settingUpFor.delete(clusterId);
			this.postShow();
			this.changed.fire();
		}
	}

	/** Open the metrics section: the config's top-level `metrics:` key selected in its editor (none: the file's start). */
	private async openMetricsSection(uri: vscode.Uri): Promise<void> {
		const doc = await vscode.workspace.openTextDocument(uri);
		const range = metricsSectionRange(parseYaml(doc.getText()));
		const selection = range ? new vscode.Range(doc.positionAt(range[0]), doc.positionAt(range[1])) : new vscode.Range(0, 0, 0, 0);
		await vscode.window.showTextDocument(doc, { selection, preview: false });
	}

	/** Ticket 8: reads the bound file's mapping (a not-running local file only); posts when it changes. */
	private refreshMapping(): void {
		const uri = this.uri;
		const read = ++this.mappingReads;
		if (!uri || uri.scheme !== 'file' || !this.options.mappingOf || this.update?.source.kind !== 'local') {
			this.mapped = undefined;
			return;
		}
		void this.options.mappingOf(uri).then((m) => m, () => undefined).then((m) => {
			if (read !== this.mappingReads || this.uri?.toString() !== uri.toString()) {
				return;
			}
			const before = JSON.stringify(this.mapped ?? null);
			this.mapped = m;
			if (JSON.stringify(m ?? null) !== before) {
				this.postShow();
				this.changed.fire();
			}
		});
	}

	/**
	 * Show Pipeline Metrics (ticket 9's resolver, for the command, the status bar menu and the graph's
	 * button): `uri` (default: the active config) → its local run when one runs → its own `.cloud.json`
	 * pipeline (Show metrics) → the file itself (Not running). No active config: a pick of the running
	 * files and the loaded Cloud pipelines; none: `NO_CONFIG_MESSAGE`.
	 */
	async showFor(uri?: vscode.Uri): Promise<void> {
		// Only a file on disk is a config here (an untitled or Cloud document can't run): else no config, the pick.
		const target = uri ? (uri.scheme === 'file' ? uri : undefined) : this.activeConfig();
		if (!target) {
			await this.pick();
			return;
		}
		if (!this.isRunning(target) && await this.showMapped(target)) {
			return;
		}
		await this.show(target);
	}

	/** The active editor's file when it is a config on disk. */
	private activeConfig(): vscode.Uri | undefined {
		const active = (this.options.activeUri ?? (() => vscode.window.activeTextEditor?.document.uri))();
		return active?.scheme === 'file' && (this.options.isConfig ?? (() => true))(active) ? active : undefined;
	}

	private running(): readonly vscode.Uri[] {
		return this.options.runningUris?.() ?? [];
	}

	private isRunning(uri: vscode.Uri): boolean {
		return this.running().some((u) => u.toString() === uri.toString());
	}

	private command(): (command: string, ...args: unknown[]) => Thenable<unknown> {
		return this.options.executeCommand ?? ((command: string, ...args: unknown[]) => vscode.commands.executeCommand(command, ...args));
	}

	/** Shows `uri`'s own `.cloud.json` pipeline through Show metrics (its messages when it can't); `false`: no mapping. */
	private async showMapped(uri: vscode.Uri, stillWanted: () => boolean = () => true): Promise<boolean> {
		if (uri.scheme !== 'file' || !this.options.mappingOf) {
			return false;
		}
		const m = await this.options.mappingOf(uri).then((v) => v, () => undefined);
		if (!m) {
			return false;
		}
		if (!stillWanted()) {
			return true;
		}
		this.options.log(`Pipeline metrics: ${path.basename(uri.fsPath)} is not running; showing its Cloud pipeline ${m.pipeline} on ${m.cluster}.`);
		await this.command()(SHOW_CLOUD_METRICS_COMMAND, { kind: 'pipeline', clusterId: m.clusterId, id: m.pipelineId });
		return true;
	}

	/** No active config: a pick of the running files and the loaded Cloud pipelines (none: the message). */
	private async pick(): Promise<void> {
		const items: MetricsPickItem[] = [
			...this.running().map((uri): MetricsPickItem => ({
				// Its folder, so two runs of one name in different folders differ.
				kind: 'local', label: path.basename(uri.fsPath), description: `Local run · ${vscode.workspace.asRelativePath(vscode.Uri.joinPath(uri, '..'))}`, uri,
			})),
			...(this.options.cloudPipelines?.() ?? []).map((p): MetricsPickItem => ({
				kind: 'cloud', label: p.pipelineName, description: `Cloud · ${p.clusterName}`, pipeline: p,
			})),
		];
		if (items.length === 0) {
			(this.options.showInformationMessage ?? ((m: string) => { void vscode.window.showInformationMessage(m); }))(NO_CONFIG_MESSAGE);
			return;
		}
		const picked = await this.ui.pick(METRICS_PICK_TITLE, items);
		if (picked?.kind === 'local') {
			await this.show(picked.uri);
		} else if (picked?.kind === 'cloud') {
			await this.command()(SHOW_CLOUD_METRICS_COMMAND, { kind: 'pipeline', clusterId: picked.pipeline.clusterId, id: picked.pipeline.pipelineId });
		}
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
		this.configSummary = null;
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
		this.configSummary = null;
		sub.feed.bindCloud(binding);
		this.updated(sub, sub.feed.update, false);
		this.options.log(`Pipeline metrics: showing pipeline ${binding.pipelineName} on ${binding.clusterName} (${binding.host})`
			+ `${binding.file ? `, mapped to ${path.basename(binding.file.fsPath)}` : ', not mapped to a file'}.`);
		await this.opened(sub);
	}

	/** The tab's hold on the feed of `uri` (kept when it is already that feed). */
	private bind(uri: vscode.Uri): MetricsSubscription {
		if (this.uri?.toString() !== uri.toString()) {
			this.mapped = undefined;
			this.update = undefined;
		}
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
		const entered = update.state.kind === 'notRunning' && (this.update?.state.kind !== 'notRunning' || this.update.source.kind !== 'local');
		this.update = update;
		if (entered) {
			// Ticket 8: the mapping is read again each time the file stops being run (a deploy may have written it).
			this.refreshMapping();
		}
		if (update.figures !== this.rowsFrom) {
			this.rowsFrom = update.figures;
			if (update.figures) {
				const config = this.options.feeds.configOf(this.uri);
				this.configRows = metricRows(config?.model ?? { nodes: [], edges: [] }, config?.paths ?? new Map(), update.figures);
			} else {
				this.configRows = [];
			}
			this.configSummary = metricsSummary(this.configRows);
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
			windowMinutes: this.windowMinutes,
			summary: this.configSummary,
			...(this.update?.source.kind === 'cloud' ? { cloud: { host: this.update.source.host } } : {}),
			retryAt: this.state.kind === 'unreachable' ? this.update?.nextReadAt ?? null : null,
			lastReadingAt: this.configRows.length > 0 ? this.update?.time ?? null : null,
			settingUp: this.settingUp,
			mapped: this.actionContext.mapped ? { pipeline: this.actionContext.mapped.pipeline, cluster: this.actionContext.mapped.cluster } : null,
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
