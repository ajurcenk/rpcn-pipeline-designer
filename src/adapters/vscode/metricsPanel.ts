// The Pipeline Metrics tab (ticket 7.2, AD-25): a webview view in its own container in the bottom
// panel, next to Pipeline Logs. **Show Pipeline Metrics** binds it to the active editor's config (not
// to whichever editor is active later) and opens it. While the file's local Run lives, the tab reads
// the run's `/metrics` (a `MetricsSource` on the run's 127.0.0.1 port) every 2 s, one read in flight,
// only while the tab is visible: hidden, the timer stops; shown again, it reads at once. Each reading
// becomes the rows (`src/core/metrics.ts`: one per component of the config's model in config order,
// nested ones indented, a series with no node last), rates over the last two readings; the host
// computes every figure and the order (a header's sort), the webview only renders.
//
// States: no run → "Run this file to see its metrics" (nothing is read); the run stopped → its last
// figures stay, marked stopped, reading stops; a rerun of the file resumes on its new port (the
// figures start again). A config whose own `metrics` section is not `prometheus` is "no metrics
// served" with its type, and is not read (the run's `http` section is always overridden, AD-25);
// so is an answer that holds no Connect metrics (a 404, not Prometheus text; no component series
// in 5 reads in a row). A read that fails otherwise (a refused connection while the run starts) is tried
// again at the interval, quietly until 3 failures in a row. Closing the tab drops every reading.

import * as path from 'path';
import * as vscode from 'vscode';
import { errorText } from '../../shared/errorText';
import {
	localSourceLabel, parseMetricsWebviewMessage, type MetricRow, type MetricsHostMessage, type MetricsPanelState, type MetricsSort,
} from '../../shared/metricsProtocol';
import type { PipelineModel } from '../../shared/protocol';
import { figures, metricRows, sortRows, type MetricsReading } from '../../core/metrics';
import { isMetricsReadError, localMetricsSource, type MetricsSource } from '../metrics/source';
import { webviewHtml } from '../graphPanel/html';
import type { RunChange } from './run';

export const METRICS_VIEW_ID = 'redpandaConnect.pipelineMetrics';
export const SHOW_METRICS_COMMAND = 'redpandaConnect.showPipelineMetrics';
/** A local run is read this often (ticket 7.2 decision). */
export const METRICS_INTERVAL_MS = 2_000;
/** Failed reads in a row before the tab says so. */
export const QUIET_FAILURES = 3;
/**
 * Answers in a row with no component series before the tab says no metrics are served: a run that is
 * still starting serves its HTTP server before its components exist.
 */
export const NO_SERIES_READS = 5;
export const NO_CONFIG_MESSAGE = 'Open a Redpanda Connect config to see the metrics of its run.';
/** How many of the posted messages `posted` keeps (test seam). */
const MAX_POSTED = 200;

/** What the tab reads of the Run (`RunController`). */
export interface MetricsRun {
	portOf(uri: string): number | undefined;
	readonly onDidChangeRun: vscode.Event<RunChange>;
}

/** A config as the tab needs it: its model, its components' paths and its `metrics` section's type. */
export interface MetricsConfig {
	readonly model: PipelineModel;
	readonly paths: ReadonlyMap<string, string>;
	readonly metricsType: string | undefined;
}

export interface MetricsPanelOptions {
	readonly extensionUri: vscode.Uri;
	readonly log: (line: string) => void;
	readonly run: MetricsRun;
	/** The config of `uri` now (the open document's text, else the file's). */
	readonly configFor: (uri: vscode.Uri) => MetricsConfig;
	/** The active editor's document URI (default: VS Code's). */
	readonly activeUri?: () => vscode.Uri | undefined;
	readonly intervalMs?: number;
	readonly showInformationMessage?: (message: string) => void;
	/** Opens the tab (default: the view's focus command; a test seam). */
	readonly focus?: () => Thenable<unknown>;
}

export type MetricsSourceFactory = (port: number) => MetricsSource;

const NONE: MetricsPanelState = { kind: 'none' };

export class MetricsPanel implements vscode.Disposable {
	/** The last messages posted to the webview, in order (test seam). */
	readonly posted: MetricsHostMessage[] = [];
	private view: vscode.WebviewView | undefined;
	private viewSubscriptions: vscode.Disposable[] = [];
	private readonly subscriptions: vscode.Disposable[] = [];
	private ready = false;
	private uri: vscode.Uri | undefined;
	private port: number | undefined;
	private panelState: MetricsPanelState = NONE;
	private prev: MetricsReading | undefined;
	private configRows: MetricRow[] = [];
	private sort: MetricsSort | null = null;
	/** Failed reads (refused, unreachable) in a row. */
	private failures = 0;
	/** Answers with no component series in a row. */
	private noSeriesReads = 0;
	/** Why a read said this run serves no metrics (reset by a new port). */
	private notServedReason: string | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private inFlight: AbortController | undefined;
	/** Bumped whenever what is read changes: an older read's answer is dropped. */
	private generation = 0;
	private factory: MetricsSourceFactory = (port) => localMetricsSource(port);
	private reads = 0;
	private readonly intervalMs: number;
	private readonly changed = new vscode.EventEmitter<void>();
	/** Fires when the rows or the state change (test seam). */
	readonly onDidChange = this.changed.event;

	constructor(private readonly options: MetricsPanelOptions) {
		this.intervalMs = options.intervalMs ?? METRICS_INTERVAL_MS;
		this.subscriptions.push(this.changed, options.run.onDidChangeRun((change) => this.runChanged(change)));
	}

	register(): vscode.Disposable[] {
		return [
			vscode.window.registerWebviewViewProvider(METRICS_VIEW_ID, this),
			vscode.commands.registerCommand(SHOW_METRICS_COMMAND, (uri?: vscode.Uri) => this.showFor(uri)),
		];
	}

	/** Test seam: the source a port is read through (default: the local `/metrics`). */
	setSourceFactory(factory: MetricsSourceFactory | undefined): void {
		this.factory = factory ?? ((port) => localMetricsSource(port));
	}

	/** The bound file's URI string; `undefined` before the first Show Pipeline Metrics. */
	get file(): string | undefined {
		return this.uri?.toString();
	}

	get state(): MetricsPanelState {
		return this.panelState;
	}

	/** The rows as shown (sorted). */
	rows(): readonly MetricRow[] {
		return sortRows(this.configRows, this.sort);
	}

	/** How many reads were started (test seam). */
	get readCount(): number {
		return this.reads;
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
				if (view.visible) {
					this.resume();
				} else {
					// Not retained while hidden: the page loads again (and posts `ready`) when shown.
					this.ready = false;
					this.pause();
					// Rates start again on show: none spans the hidden time.
					this.dropReadings();
				}
			}),
			view.onDidDispose(() => {
				if (this.view === view) {
					this.view = undefined;
					this.ready = false;
					this.viewSubscriptions.forEach((s) => s.dispose());
					this.viewSubscriptions = [];
					this.pause();
					// Nothing is kept after the tab closes.
					this.dropReadings();
				}
			}),
		];
		this.updateDescription();
		if (view.visible) {
			this.resume();
		}
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

	/** Binds the tab to `uri` (its readings start again) and opens it. */
	async show(uri: vscode.Uri): Promise<void> {
		this.pause();
		this.generation++;
		this.uri = uri;
		this.port = undefined;
		this.prev = undefined;
		this.configRows = [];
		this.failures = 0;
		this.refreshState();
		this.options.log(`Pipeline metrics: showing ${path.basename(uri.fsPath)}${this.port ? ` (127.0.0.1:${this.port})` : ''}.`);
		this.updateDescription();
		this.postShow();
		this.changed.fire();
		await (this.options.focus ?? (() => vscode.commands.executeCommand(`${METRICS_VIEW_ID}.focus`)))();
		this.resume();
	}

	dispose(): void {
		this.pause();
		this.viewSubscriptions.forEach((s) => s.dispose());
		this.subscriptions.forEach((s) => s.dispose());
	}

	/** Drops the readings and rows (hidden or closed); a live tab waits for its next reading. */
	private dropReadings(): void {
		this.prev = undefined;
		this.configRows = [];
		this.failures = 0;
		this.noSeriesReads = 0;
		this.refreshState();
		if (this.panelState.kind === 'live' || this.panelState.kind === 'unreachable') {
			this.panelState = { kind: 'waiting' };
		}
	}

	/** The state for the bound file's run now; a new port starts the figures again. */
	private refreshState(): void {
		const uri = this.uri;
		if (!uri) {
			this.panelState = NONE;
			return;
		}
		const port = this.options.run.portOf(uri.toString());
		if (port === undefined) {
			this.port = undefined;
			this.panelState = this.configRows.length > 0 ? { kind: 'stopped' } : { kind: 'notRunning' };
			return;
		}
		if (port !== this.port) {
			this.port = port;
			this.prev = undefined;
			this.failures = 0;
			this.noSeriesReads = 0;
			this.notServedReason = undefined;
			this.generation++;
			this.panelState = { kind: 'waiting' };
		}
		const type = this.configOf(uri)?.metricsType;
		if (type !== undefined && type !== 'prometheus') {
			this.panelState = { kind: 'notServed', reason: `this config's \`metrics\` section is \`${type}\`.` };
		} else if (this.notServedReason !== undefined) {
			this.panelState = { kind: 'notServed', reason: this.notServedReason };
		} else if (this.panelState.kind !== 'live' && this.panelState.kind !== 'unreachable') {
			this.panelState = this.prev ? { kind: 'live' } : { kind: 'waiting' };
		}
	}

	private runChanged(change: RunChange): void {
		if (!this.uri || change.uri !== this.uri.toString()) {
			return;
		}
		const before = this.port;
		this.refreshState();
		if (this.port === undefined || this.port !== before) {
			this.pause();
			if (this.port !== undefined) {
				this.options.log(`Pipeline metrics: ${path.basename(this.uri.fsPath)} runs on 127.0.0.1:${this.port}.`);
			}
		}
		this.postShow();
		this.changed.fire();
		this.resume();
	}

	/** Whether the tab reads now: bound to a running file whose metrics are served, and visible. */
	private get reading(): boolean {
		return this.visible && this.port !== undefined && this.panelState.kind !== 'notServed';
	}

	/** Reads at once (when it should) and then every interval. */
	private resume(): void {
		if (this.reading && !this.timer && !this.inFlight) {
			void this.readNow();
		}
	}

	/** Stops the timer and drops the read in flight. */
	private pause(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.inFlight?.abort();
		this.inFlight = undefined;
	}

	private async readNow(): Promise<void> {
		this.timer = undefined;
		const uri = this.uri;
		const port = this.port;
		if (!uri || port === undefined || this.inFlight || !this.reading) {
			return;
		}
		const generation = this.generation;
		const abort = new AbortController();
		this.inFlight = abort;
		this.reads++;
		try {
			const reading = await this.factory(port).read(abort.signal);
			if (abort.signal.aborted || generation !== this.generation) {
				return;
			}
			const config = this.configOf(uri);
			this.configRows = metricRows(config?.model ?? { nodes: [], edges: [] }, config?.paths ?? new Map(), figures(this.prev, reading));
			this.prev = reading;
			this.failures = 0;
			this.noSeriesReads = 0;
			this.panelState = { kind: 'live' };
		} catch (err) {
			if (abort.signal.aborted || generation !== this.generation) {
				return;
			}
			this.failed(err, port);
		} finally {
			if (this.inFlight === abort) {
				this.inFlight = undefined;
			}
		}
		this.postShow();
		this.changed.fire();
		if (this.reading && !this.timer) {
			this.timer = setTimeout(() => void this.readNow(), this.intervalMs);
		}
	}

	private failed(err: unknown, port: number): void {
		const name = this.uri ? path.basename(this.uri.fsPath) : '';
		if (isMetricsReadError(err) && err.kind === 'notServed' && !err.noSeries) {
			this.notServedReason = `${err.message}.`;
			this.panelState = { kind: 'notServed', reason: this.notServedReason };
			this.options.log(`Pipeline metrics: ${name}: ${err.message}.`);
			return;
		}
		const message = isMetricsReadError(err) ? err.message : errorText(err);
		const noSeries = isMetricsReadError(err) && err.noSeries === true;
		// Each kind counts in a row: the other kind starts its count again.
		if (noSeries) {
			this.noSeriesReads++;
			this.failures = 0;
		} else {
			this.failures++;
			this.noSeriesReads = 0;
		}
		const count = noSeries ? this.noSeriesReads : this.failures;
		const limit = noSeries ? NO_SERIES_READS : QUIET_FAILURES;
		if (count === limit) {
			this.options.log(`Pipeline metrics: ${name} (127.0.0.1:${port}): ${message}.`);
		}
		if (count < limit) {
			return;
		}
		if (noSeries) {
			this.notServedReason = `${message}.`;
			this.panelState = { kind: 'notServed', reason: this.notServedReason };
		} else {
			this.panelState = { kind: 'unreachable', message };
		}
	}

	private configOf(uri: vscode.Uri): MetricsConfig | undefined {
		try {
			return this.options.configFor(uri);
		} catch (err) {
			this.options.log(`Pipeline metrics: could not read ${path.basename(uri.fsPath)}: ${errorText(err)}`);
			return undefined;
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
			port: this.port ?? null,
			state: this.panelState,
			rows: this.rows(),
			intervalMs: this.intervalMs,
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
