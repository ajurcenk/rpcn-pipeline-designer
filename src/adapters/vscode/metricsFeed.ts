// The metrics feed of one file (ticket 7.3, AD-25): one reader per config, shared by the file's
// Pipeline Metrics tab and its graph panel, so both show the same reading. Each consumer subscribes
// with a visible flag; the feed reads while any subscriber is visible and stops when none is (the
// readings are then dropped: no rate spans the hidden time, nothing is kept after the tab and the
// graph are gone). The reading logic is ticket 7.2's, moved out of `MetricsPanel` unchanged: while the
// file's local Run lives, the run's `/metrics` (a `MetricsSource` on its 127.0.0.1 port) is read every
// 2 s, one read in flight; a new port starts the figures again; a config whose own `metrics` section is
// not `prometheus`, or an answer that holds no Connect metrics (a 404, not Prometheus text; no
// component series in 5 reads in a row), is "no metrics served" and is not read; a read that fails
// otherwise is tried again at the interval, quietly until 3 failures in a row. Each change is emitted
// to every subscriber as a `MetricsUpdate`: the state, the port, and the figures of the last reading
// (each consumer maps them onto its own model: the tab's rows, the graph's node figures).

import * as path from 'path';
import * as vscode from 'vscode';
import { errorText } from '../../shared/errorText';
import type { MetricsPanelState } from '../../shared/metricsProtocol';
import type { PipelineModel } from '../../shared/protocol';
import { figures, type ComponentFigures, type MetricsReading } from '../../core/metrics';
import { isMetricsReadError, localMetricsSource, type MetricsSource } from '../metrics/source';
import type { RunChange } from './run';

/** A local run is read this often (ticket 7.2 decision). */
export const METRICS_INTERVAL_MS = 2_000;
/** Failed reads in a row before the feed says so. */
export const QUIET_FAILURES = 3;
/**
 * Answers in a row with no component series before the feed says no metrics are served: a run that is
 * still starting serves its HTTP server before its components exist.
 */
export const NO_SERIES_READS = 5;

/** What the feed reads of the Run (`RunController`). */
export interface MetricsRun {
	portOf(uri: string): number | undefined;
	readonly onDidChangeRun: vscode.Event<RunChange>;
}

/** A config as the metrics need it: its model, its components' paths and its `metrics` section's type. */
export interface MetricsConfig {
	readonly model: PipelineModel;
	readonly paths: ReadonlyMap<string, string>;
	readonly metricsType: string | undefined;
}

export type MetricsSourceFactory = (port: number) => MetricsSource;

/** What a feed tells its subscribers on each change. */
export interface MetricsUpdate {
	readonly state: MetricsPanelState;
	/** The run's metrics port; `undefined` while it has none. */
	readonly port: number | undefined;
	/**
	 * The figures of the last reading (kept, marked by the state, after the run stops); `undefined`
	 * with none. A new reading is a new map, so a consumer can tell one apart by identity.
	 */
	readonly figures: ReadonlyMap<string, ComponentFigures> | undefined;
	/** When the last reading was made (ms since the epoch); `undefined` with none. */
	readonly time: number | undefined;
}

/** A consumer's hold on a feed: its visibility, and its end. */
export interface MetricsSubscription extends vscode.Disposable {
	setVisible(visible: boolean): void;
	readonly feed: MetricsFeed;
}

export interface MetricsFeedsOptions {
	readonly log: (line: string) => void;
	readonly run: MetricsRun;
	/** The config of `uri` now (the open document's text, else the file's; its `metrics` type from disk). */
	readonly configFor: (uri: vscode.Uri) => MetricsConfig;
	readonly intervalMs?: number;
}

const NONE: MetricsPanelState = { kind: 'none' };

interface Subscriber {
	readonly listener: (update: MetricsUpdate) => void;
	visible: boolean;
}

/** One file's reader (see the header). */
export class MetricsFeed {
	private readonly subscribers = new Set<Subscriber>();
	private port: number | undefined;
	private panelState: MetricsPanelState = NONE;
	private prev: MetricsReading | undefined;
	private last: ReadonlyMap<string, ComponentFigures> | undefined;
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
	private reads = 0;

	constructor(
		readonly uri: vscode.Uri,
		private readonly feeds: MetricsFeeds,
		private readonly options: MetricsFeedsOptions,
		private readonly intervalMs: number,
	) {
		this.refreshState();
	}

	get state(): MetricsPanelState {
		return this.panelState;
	}

	/** How many reads were started (test seam). */
	get readCount(): number {
		return this.reads;
	}

	/** Whether any subscriber is visible. */
	get visible(): boolean {
		return [...this.subscribers].some((s) => s.visible);
	}

	get update(): MetricsUpdate {
		return { state: this.panelState, port: this.port, figures: this.last, time: this.prev?.time };
	}

	/** Subscribes `listener` (visible or not); it is called on each change, not at once. */
	subscribe(listener: (update: MetricsUpdate) => void, visible: boolean): MetricsSubscription {
		const subscriber: Subscriber = { listener, visible };
		this.subscribers.add(subscriber);
		let disposed = false;
		if (visible) {
			this.resume();
		}
		return {
			feed: this,
			setVisible: (v: boolean) => {
				if (disposed || subscriber.visible === v) {
					return;
				}
				const before = this.visible;
				subscriber.visible = v;
				this.visibilityChanged(before);
			},
			dispose: () => {
				if (disposed) {
					return;
				}
				disposed = true;
				const before = this.visible;
				this.subscribers.delete(subscriber);
				this.visibilityChanged(before);
				if (this.subscribers.size === 0) {
					this.feeds.release(this);
				}
			},
		};
	}

	/** The readings start again (Show Pipeline Metrics binds the tab anew, ticket 7.2). */
	restart(): void {
		this.pause();
		this.generation++;
		this.port = undefined;
		this.prev = undefined;
		this.last = undefined;
		this.failures = 0;
		this.refreshState();
		this.emit();
		this.resume();
	}

	/** Stops reading for good (the feeds are disposed, or the last subscriber went). */
	dispose(): void {
		this.pause();
		this.generation++;
	}

	private visibilityChanged(before: boolean): void {
		const now = this.visible;
		if (now === before) {
			return;
		}
		if (now) {
			this.resume();
		} else {
			this.pause();
			// Rates start again on show: none spans the hidden time; nothing is kept while unseen.
			this.dropReadings();
			this.emit();
		}
	}

	/** Drops the readings and figures (no subscriber visible); a live feed waits for its next reading. */
	private dropReadings(): void {
		this.prev = undefined;
		this.last = undefined;
		this.failures = 0;
		this.noSeriesReads = 0;
		this.refreshState();
		if (this.panelState.kind === 'live' || this.panelState.kind === 'unreachable') {
			this.panelState = { kind: 'waiting' };
		}
	}

	/** The state for the file's run now; a new port starts the figures again. */
	private refreshState(): void {
		const uri = this.uri;
		const port = this.options.run.portOf(uri.toString());
		if (port === undefined) {
			this.port = undefined;
			this.panelState = this.last !== undefined ? { kind: 'stopped' } : { kind: 'notRunning' };
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
		const type = this.feeds.configOf(uri)?.metricsType;
		if (type !== undefined && type !== 'prometheus') {
			this.panelState = { kind: 'notServed', reason: `this config's \`metrics\` section is \`${type}\`.` };
		} else if (this.notServedReason !== undefined) {
			this.panelState = { kind: 'notServed', reason: this.notServedReason };
		} else if (this.panelState.kind !== 'live' && this.panelState.kind !== 'unreachable') {
			this.panelState = this.prev ? { kind: 'live' } : { kind: 'waiting' };
		}
	}

	/** The file's run started, stopped or changed port. */
	runChanged(change: RunChange): void {
		if (change.uri !== this.uri.toString()) {
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
		this.emit();
		this.resume();
	}

	/** Whether the feed reads now: a running file whose metrics are served, with a visible subscriber. */
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
		const port = this.port;
		if (port === undefined || this.inFlight || !this.reading) {
			return;
		}
		const generation = this.generation;
		const abort = new AbortController();
		this.inFlight = abort;
		this.reads++;
		try {
			const reading = await this.feeds.factory(port).read(abort.signal);
			if (abort.signal.aborted || generation !== this.generation) {
				return;
			}
			this.last = figures(this.prev, reading);
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
		this.emit();
		if (this.reading && !this.timer) {
			this.timer = setTimeout(() => void this.readNow(), this.intervalMs);
		}
	}

	private failed(err: unknown, port: number): void {
		const name = path.basename(this.uri.fsPath);
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

	private emit(): void {
		const update = this.update;
		for (const s of [...this.subscribers]) {
			try {
				s.listener(update);
			} catch (err) {
				this.options.log(`Pipeline metrics: ${path.basename(this.uri.fsPath)}: ${errorText(err)}`);
			}
		}
	}
}

/**
 * The feeds of all files, by `uri.toString()`: a feed is made on its first subscription and goes with
 * its last. It follows the Run's changes and holds the one `configFor` and the source seam.
 */
export class MetricsFeeds implements vscode.Disposable {
	private readonly feeds = new Map<string, MetricsFeed>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private sourceFactory: MetricsSourceFactory = (port) => localMetricsSource(port);
	readonly intervalMs: number;

	constructor(private readonly options: MetricsFeedsOptions) {
		this.intervalMs = options.intervalMs ?? METRICS_INTERVAL_MS;
		this.subscriptions.push(options.run.onDidChangeRun((change) => this.feeds.get(change.uri)?.runChanged(change)));
	}

	/** Test seam: the source a port is read through (default: the local `/metrics`). */
	setSourceFactory(factory: MetricsSourceFactory | undefined): void {
		this.sourceFactory = factory ?? ((port) => localMetricsSource(port));
	}

	/** The source of `port` (through the seam). */
	factory(port: number): MetricsSource {
		return this.sourceFactory(port);
	}

	/** Subscribes `listener` to the feed of `uri` (made when there is none). */
	subscribe(uri: vscode.Uri, listener: (update: MetricsUpdate) => void, visible: boolean): MetricsSubscription {
		return this.feedFor(uri).subscribe(listener, visible);
	}

	/** The feed of `uri`, made when there is none (it goes with its last subscriber). */
	feedFor(uri: vscode.Uri): MetricsFeed {
		const key = uri.toString();
		let feed = this.feeds.get(key);
		if (!feed) {
			feed = new MetricsFeed(uri, this, this.options, this.intervalMs);
			this.feeds.set(key, feed);
		}
		return feed;
	}

	/** The open feed of `uri`, if any (test seam). */
	feedOf(uri: vscode.Uri): MetricsFeed | undefined {
		return this.feeds.get(uri.toString());
	}

	/** The config of `uri`, or `undefined` (logged) when it cannot be read. */
	configOf(uri: vscode.Uri): MetricsConfig | undefined {
		try {
			return this.options.configFor(uri);
		} catch (err) {
			this.options.log(`Pipeline metrics: could not read ${path.basename(uri.fsPath)}: ${errorText(err)}`);
			return undefined;
		}
	}

	/** A feed's last subscriber went: it stops and is forgotten. */
	release(feed: MetricsFeed): void {
		feed.dispose();
		const key = feed.uri.toString();
		if (this.feeds.get(key) === feed) {
			this.feeds.delete(key);
		}
	}

	dispose(): void {
		this.subscriptions.forEach((s) => s.dispose());
		this.feeds.forEach((f) => f.dispose());
		this.feeds.clear();
	}
}
