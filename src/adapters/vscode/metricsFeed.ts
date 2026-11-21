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
//
// Ticket 7.5: a feed is bound to a source: the file's local run (the above, unchanged), or a Cloud
// pipeline (Show metrics on its row), last chosen wins: Show metrics binds the pipeline's file to the
// Cloud; Show Pipeline Metrics on the file, or a local run of it starting, binds it back to the run. A
// pipeline with no local file has a feed of its own, keyed by a synthetic per-pipeline URI
// (`cloudMetricsKey`). The Cloud is read every 10 s (AD-25), one read in flight, never sooner than 5 s
// after the last read began; a read that fails is tried again after 5, 10, 20, 30, 60 s, then every 60 s
// (quietly until 3 failures in a row); a refused read (401/403) is the `refused` state and is not read
// again until the cluster's access changes or Show metrics runs again; no access is the `noAccess`
// state, nothing read, and the feed follows the access as it is set or forgotten. Its error texts are
// masked by the binding (the Cloud view's mask) before they are shown or logged.
//
// Ticket 7.6, the live window: the feed keeps the last 15 minutes of readings in memory, compactly
// (`compactReading`: per component, not the whole text), in place of the one reading before; each
// update's figures are over the session's window (`MetricsFeeds.windowMinutes`, 5 min until the tab
// chooses another; one choice for the tab and the graphs, held until VS Code restarts). Choosing a
// window recomputes every feed's figures at once, with no read. The readings are dropped at the same
// points as before: nothing showing them visible, a new port, a restart or rebind, an access change.
//
// Ticket 8 (board 5), the tab's state buttons: Read again (`readAgain`: a fresh read cycle, the
// not-served reason and the 5-answer count dropped) and Retry now (`retryNow`: the next read at once,
// within the Cloud floor). Each update says when the next read is due (`nextReadAt`), for the
// unreachable state's "Retrying in N s"; a not-served state says why (`cause`: the config's type, the
// endpoint's answer, or no series yet).

import * as path from 'path';
import * as vscode from 'vscode';
import { errorText } from '../../shared/errorText';
import { RETRY_DELAYS_MS, retryDelayMs } from '../../shared/retry';
import { DEFAULT_WINDOW_MINUTES, type MetricsPanelState, type MetricsWindowMinutes, type NotServedCause } from '../../shared/metricsProtocol';
import type { PipelineModel } from '../../shared/protocol';
import { compactReading, figures, keepReading, type CompactReading, type ComponentFigures } from '../../core/metrics';
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
/** Ticket 7.5 (AD-25): a Cloud pipeline is read this often. */
export const CLOUD_METRICS_INTERVAL_MS = 10_000;
/** Ticket 7.5 (AD-25): a Cloud endpoint is never read sooner than this after the last read began. */
export const CLOUD_MIN_GAP_MS = 5_000;
/** Ticket 7.5: what the Cloud no-series state says to do. */
export const CLOUD_NO_SERIES_HINT = 'Read again once the pipeline runs.';
/** Ticket 7.5: the scheme of a feed key of a Cloud pipeline with no local file. */
export const CLOUD_METRICS_SCHEME = 'redpanda-cloud-metrics';

/** Ticket 7.5: the feed key of a Cloud pipeline with no local file. */
export function cloudMetricsKey(clusterId: string, pipelineId: string): vscode.Uri {
	return vscode.Uri.from({ scheme: CLOUD_METRICS_SCHEME, path: `/${clusterId}/${pipelineId}` });
}

/** Ticket 7.5: how a Cloud feed is timed (the test seam shortens it). */
export interface CloudTiming {
	readonly intervalMs: number;
	readonly minGapMs: number;
	readonly retryDelaysMs: readonly number[];
}

export const CLOUD_TIMING: CloudTiming = { intervalMs: CLOUD_METRICS_INTERVAL_MS, minGapMs: CLOUD_MIN_GAP_MS, retryDelaysMs: RETRY_DELAYS_MS };

/**
 * Ticket 7.5: a Cloud pipeline a feed reads, as the Cloud view gives it. The source is built from the
 * cluster's access held now (none: no access); the password never leaves it.
 */
export interface CloudMetricsBinding {
	readonly clusterId: string;
	readonly clusterName: string;
	readonly pipelineId: string;
	readonly pipelineName: string;
	/** The cluster's Prometheus endpoint host, as shown. */
	readonly host: string;
	/** The pipeline's local file; `undefined`: not mapped to one (the feed's key is `cloudMetricsKey`). */
	readonly file: vscode.Uri | undefined;
	/** The source with the cluster's access now; `undefined`: no access. */
	source(): MetricsSource | undefined;
	/** Fires when the cluster's metrics access is set, replaced or forgotten. */
	readonly onDidChangeAccess: vscode.Event<void>;
	/** An error text with the Cloud view's secrets masked. */
	mask(text: string): string;
	/** Ticket 8: whether a Set up metrics access… of the cluster runs now (from any entry point). */
	settingUp?(): boolean;
	/** Ticket 8: fires when one starts or ends. */
	readonly onDidChangeSettingUp?: vscode.Event<void>;
}

/** What a feed reads, as its subscribers are told. */
export type MetricsSourceInfo =
	| { readonly kind: 'local' }
	| {
		readonly kind: 'cloud'; readonly clusterId: string; readonly clusterName: string; readonly pipelineId: string; readonly pipelineName: string;
		readonly host: string; readonly file: vscode.Uri | undefined;
	};

const LOCAL: MetricsSourceInfo = { kind: 'local' };

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
	 * The figures of the last reading over the session's window (kept, marked by the state, after the
	 * run stops); `undefined` with none. A new reading, or a new window, is a new map, so a consumer can
	 * tell one apart by identity.
	 */
	readonly figures: ReadonlyMap<string, ComponentFigures> | undefined;
	/** When the last reading was made (ms since the epoch); `undefined` with none. */
	readonly time: number | undefined;
	/** Ticket 7.5: what is read (the local run, or a Cloud pipeline). */
	readonly source: MetricsSourceInfo;
	/** Ticket 7.5: how often it is read. */
	readonly intervalMs: number;
	/** Ticket 8: when the next read is due (ms since the epoch); `undefined`: none set (none, or one in flight). */
	readonly nextReadAt: number | undefined;
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
	/** Ticket 7.6: the last 15 minutes of readings, oldest first (compact). */
	private readings: CompactReading[] = [];
	private last: ReadonlyMap<string, ComponentFigures> | undefined;
	/** Failed reads (refused, unreachable) in a row. */
	private failures = 0;
	/** Answers with no component series in a row. */
	private noSeriesReads = 0;
	/** Why a read said this run serves no metrics (reset by a new port, a restart, Read again). */
	private notServed: { readonly reason: string; readonly cause: NotServedCause } | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** Ticket 8: when `timer` fires. */
	private timerAt: number | undefined;
	private inFlight: AbortController | undefined;
	/** Bumped whenever what is read changes: an older read's answer is dropped. */
	private generation = 0;
	private reads = 0;
	/** Ticket 7.5: the Cloud pipeline read instead of the local run (last chosen wins). */
	private cloud: CloudMetricsBinding | undefined;
	private cloudInfo: MetricsSourceInfo = LOCAL;
	private accessSubscription: vscode.Disposable | undefined;
	/** Ticket 7.5: why the Cloud refused the last read (masked); not read again until the access changes. */
	private refusedMessage: string | undefined;

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
		return {
			state: this.panelState, port: this.port, figures: this.last, time: this.readings.at(-1)?.time, source: this.cloudInfo,
			intervalMs: this.cloud ? this.feeds.cloudTiming.intervalMs : this.intervalMs,
			nextReadAt: this.timer ? this.timerAt : undefined,
		};
	}

	/** Ticket 7.5: the Cloud pipeline it reads, if any. */
	get cloudBinding(): CloudMetricsBinding | undefined {
		return this.cloud;
	}

	/**
	 * Ticket 7.5: Show metrics on a Cloud pipeline: the feed reads it from now on (its readings start
	 * again; a refused or failing state is tried again), and follows its cluster's access.
	 */
	bindCloud(binding: CloudMetricsBinding): void {
		this.accessSubscription?.dispose();
		this.cloud = binding;
		this.cloudInfo = {
			kind: 'cloud', clusterId: binding.clusterId, clusterName: binding.clusterName, pipelineId: binding.pipelineId,
			pipelineName: binding.pipelineName, host: binding.host, file: binding.file,
		};
		const access = binding.onDidChangeAccess(() => this.accessChanged(binding));
		// Ticket 8: a set-up of the cluster starting or ending (the tab's buttons follow it).
		const setUp = binding.onDidChangeSettingUp?.(() => this.emit());
		this.accessSubscription = { dispose: () => { access.dispose(); setUp?.dispose(); } };
		this.restart();
	}

	/**
	 * Ticket 7.5: Show Pipeline Metrics on the file, or a local run of it starting: the feed reads the
	 * local run again (its readings start again). Already local: nothing changes.
	 */
	bindLocal(): void {
		if (!this.cloud) {
			return;
		}
		this.unbindCloud();
		this.restart();
	}

	private unbindCloud(): void {
		this.accessSubscription?.dispose();
		this.accessSubscription = undefined;
		this.cloud = undefined;
		this.cloudInfo = LOCAL;
		this.refusedMessage = undefined;
		this.notServed = undefined;
	}

	/** Ticket 7.5: the cluster's access was set, replaced or forgotten. */
	private accessChanged(binding: CloudMetricsBinding): void {
		if (this.cloud !== binding) {
			return;
		}
		const has = binding.source() !== undefined;
		if (!has) {
			this.pause();
			this.generation++;
			this.readings = [];
			this.last = undefined;
			this.failures = 0;
			this.noSeriesReads = 0;
			this.refusedMessage = undefined;
			this.refreshState();
			this.emit();
			return;
		}
		// Set or replaced: a read in flight with the old access is dropped (its answer could be a stale
		// refusal) and the feed reads again with the new one, within the floor.
		this.pause();
		this.generation++;
		this.refusedMessage = undefined;
		this.failures = 0;
		if (this.panelState.kind !== 'live') {
			this.panelState = { kind: 'waiting' };
		}
		this.refreshState();
		this.emit();
		this.resume();
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
		this.readings = [];
		this.last = undefined;
		this.failures = 0;
		this.noSeriesReads = 0;
		this.refusedMessage = undefined;
		this.notServed = undefined;
		if (this.cloud) {
			this.panelState = { kind: 'waiting' };
		}
		this.refreshState();
		this.emit();
		this.resume();
	}

	/**
	 * Ticket 8: Read again (a not-served state's button): a fresh read cycle on the same source; the
	 * reason and the 5-answer count are dropped (a config's own `metrics` type still says so).
	 */
	readAgain(): void {
		this.options.log(`Pipeline metrics: ${this.where()}: reading again.`);
		this.restart();
	}

	/** Ticket 8: Retry now (the unreachable state's button): the next read at once (a Cloud one within its floor). */
	retryNow(): void {
		if (this.inFlight || !this.reading) {
			return;
		}
		clearTimeout(this.timer);
		this.timer = undefined;
		this.timerAt = undefined;
		this.resume();
		this.emit();
	}

	/** What the feed reads, for its log lines. */
	private where(): string {
		const c = this.cloud;
		return c ? `${c.pipelineName} on ${c.clusterName} (${c.host})` : path.basename(this.uri.fsPath);
	}

	/** Sets the timer of the next read, `ms` from now. */
	private schedule(ms: number): void {
		this.timerAt = Date.now() + ms;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.timerAt = undefined;
			void this.readNow();
		}, ms);
	}

	/** Stops reading for good (the feeds are disposed, or the last subscriber went). */
	dispose(): void {
		this.pause();
		this.generation++;
		this.accessSubscription?.dispose();
		this.accessSubscription = undefined;
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
		this.readings = [];
		this.last = undefined;
		this.failures = 0;
		this.noSeriesReads = 0;
		this.refreshState();
		if (this.panelState.kind === 'live' || this.panelState.kind === 'unreachable') {
			this.panelState = { kind: 'waiting' };
		}
	}

	/** The state for the file's run (or, ticket 7.5, its Cloud pipeline) now; a new port starts the figures again. */
	private refreshState(): void {
		if (this.cloud) {
			this.refreshCloudState(this.cloud);
			return;
		}
		const uri = this.uri;
		const port = this.options.run.portOf(uri.toString());
		if (port === undefined) {
			this.port = undefined;
			this.panelState = this.last !== undefined ? { kind: 'stopped' } : { kind: 'notRunning' };
			return;
		}
		if (port !== this.port) {
			this.port = port;
			this.readings = [];
			this.failures = 0;
			this.noSeriesReads = 0;
			this.notServed = undefined;
			this.generation++;
			this.panelState = { kind: 'waiting' };
		}
		const type = this.feeds.configOf(uri)?.metricsType;
		if (type !== undefined && type !== 'prometheus') {
			this.panelState = { kind: 'notServed', reason: `this config's \`metrics\` section is \`${type}\`.`, cause: 'type' };
		} else if (this.notServed !== undefined) {
			this.panelState = { kind: 'notServed', ...this.notServed };
		} else if (this.panelState.kind !== 'live' && this.panelState.kind !== 'unreachable') {
			this.panelState = this.readings.length > 0 ? { kind: 'live' } : { kind: 'waiting' };
		}
	}

	/**
	 * Ticket 7.5: the state of a Cloud pipeline: no access, refused, not served (as the local run's), else
	 * waiting until its first reading. The deployed config's own `metrics` section is not checked.
	 */
	private refreshCloudState(binding: CloudMetricsBinding): void {
		this.port = undefined;
		if (binding.source() === undefined) {
			this.panelState = { kind: 'noAccess', cluster: binding.clusterName };
		} else if (this.refusedMessage !== undefined) {
			this.panelState = { kind: 'refused', cluster: binding.clusterName, message: this.refusedMessage };
		} else if (this.notServed !== undefined) {
			this.panelState = { kind: 'notServed', ...this.notServed };
		} else if (this.panelState.kind !== 'live' && this.panelState.kind !== 'unreachable') {
			this.panelState = this.readings.length > 0 ? { kind: 'live' } : { kind: 'waiting' };
		}
	}

	/** The file's run started, stopped or changed port. */
	runChanged(change: RunChange): void {
		if (change.uri !== this.uri.toString()) {
			return;
		}
		if (this.cloud) {
			// Ticket 7.5: a local run of the file starting takes it back from the Cloud (last chosen wins).
			if (change.phase === 'running') {
				this.unbindCloud();
				this.restart();
			}
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

	/**
	 * Whether the feed reads now: a running file whose metrics are served, with a visible subscriber;
	 * (ticket 7.5) a Cloud pipeline with access that was not refused and is served.
	 */
	private get reading(): boolean {
		if (this.cloud) {
			const kind = this.panelState.kind;
			return this.visible && kind !== 'noAccess' && kind !== 'refused' && kind !== 'notServed';
		}
		return this.visible && this.port !== undefined && this.panelState.kind !== 'notServed';
	}

	/** Reads at once (when it should; a Cloud read not sooner than the floor after the last) and then every interval. */
	private resume(): void {
		if (!this.reading || this.timer || this.inFlight) {
			return;
		}
		const wait = this.cloud ? this.floorWait(this.cloud) : 0;
		if (wait > 0) {
			this.schedule(wait);
		} else {
			void this.readNow();
		}
	}

	/** Stops the timer and drops the read in flight. */
	private pause(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.timerAt = undefined;
		this.inFlight?.abort();
		this.inFlight = undefined;
	}

	private async readNow(): Promise<void> {
		if (this.cloud) {
			return this.readCloud(this.cloud);
		}
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
			this.readings = keepReading(this.readings, compactReading(reading));
			this.last = figures(this.readings, this.feeds.windowMs);
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
		if (this.reading && !this.timer) {
			this.schedule(this.intervalMs);
		}
		// Ticket 8: after the next read is set, so the update says when it is due.
		this.emit();
	}

	/**
	 * Ticket 7.5: one read of a Cloud pipeline, then the next: at the interval after a reading, after the
	 * backoff after a failure, none after a refusal or no metrics served.
	 */
	private async readCloud(binding: CloudMetricsBinding): Promise<void> {
		this.timer = undefined;
		if (this.inFlight || !this.reading) {
			return;
		}
		const source = binding.source();
		if (!source) {
			this.refreshState();
			this.emit();
			return;
		}
		// The floor is the cluster's: another feed of it (or this one before a re-Show) may have read just now.
		const wait = this.floorWait(binding);
		if (wait > 0) {
			this.schedule(wait);
			return;
		}
		const generation = this.generation;
		const abort = new AbortController();
		this.inFlight = abort;
		this.reads++;
		this.feeds.cloudReadStarted(binding.clusterId);
		let next = this.feeds.cloudTiming.intervalMs;
		try {
			const reading = await source.read(abort.signal);
			if (abort.signal.aborted || generation !== this.generation) {
				return;
			}
			this.readings = keepReading(this.readings, compactReading(reading));
			this.last = figures(this.readings, this.feeds.windowMs);
			this.failures = 0;
			this.noSeriesReads = 0;
			this.panelState = { kind: 'live' };
		} catch (err) {
			if (abort.signal.aborted || generation !== this.generation) {
				return;
			}
			this.cloudFailed(err, binding);
			if (!isMetricsReadError(err) || (err.kind === 'unreachable')) {
				next = retryDelayMs(this.failures, this.feeds.cloudTiming.retryDelaysMs);
			}
		} finally {
			if (this.inFlight === abort) {
				this.inFlight = undefined;
			}
		}
		if (this.reading && !this.timer && this.cloud === binding) {
			this.schedule(Math.max(next, this.feeds.cloudTiming.minGapMs));
		}
		this.emit();
	}

	/** How long a Cloud read of `binding`'s cluster must wait for the floor (0: none). */
	private floorWait(binding: CloudMetricsBinding): number {
		const last = this.feeds.lastCloudReadOf(binding.clusterId);
		return last === undefined ? 0 : last + this.feeds.cloudTiming.minGapMs - Date.now();
	}

	private cloudFailed(err: unknown, binding: CloudMetricsBinding): void {
		const where = `${binding.pipelineName} on ${binding.clusterName} (${binding.host})`;
		const message = binding.mask(isMetricsReadError(err) ? err.message : errorText(err));
		if (isMetricsReadError(err) && err.kind === 'refused') {
			this.refusedMessage = message;
			this.failures = 0;
			this.panelState = { kind: 'refused', cluster: binding.clusterName, message };
			this.options.log(`Pipeline metrics: ${where}: ${message}; not read again until its metrics access is set again.`);
			return;
		}
		if (isMetricsReadError(err) && err.kind === 'notServed' && !err.noSeries) {
			this.notServed = { reason: `${message}.`, cause: 'answer' };
			this.panelState = { kind: 'notServed', ...this.notServed };
			this.options.log(`Pipeline metrics: ${where}: ${message}.`);
			return;
		}
		const noSeries = isMetricsReadError(err) && err.noSeries === true;
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
			this.options.log(`Pipeline metrics: ${where}: ${message}.`);
		}
		if (count < limit) {
			return;
		}
		if (noSeries) {
			this.notServed = { reason: `${message}. ${CLOUD_NO_SERIES_HINT}`, cause: 'noSeries' };
			this.panelState = { kind: 'notServed', ...this.notServed };
		} else {
			this.panelState = { kind: 'unreachable', message };
		}
	}

	private failed(err: unknown, port: number): void {
		const name = path.basename(this.uri.fsPath);
		if (isMetricsReadError(err) && err.kind === 'notServed' && !err.noSeries) {
			this.notServed = { reason: `${err.message}.`, cause: 'answer' };
			this.panelState = { kind: 'notServed', ...this.notServed };
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
			this.notServed = { reason: `${message}.`, cause: 'noSeries' };
			this.panelState = { kind: 'notServed', ...this.notServed };
		} else {
			this.panelState = { kind: 'unreachable', message };
		}
	}

	/** Ticket 7.6: the session's window changed: the figures over it, at once, with no read. */
	windowChanged(): void {
		if (this.readings.length === 0) {
			return;
		}
		this.last = figures(this.readings, this.feeds.windowMs);
		this.emit();
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
	/** Ticket 7.5: how a Cloud pipeline is read (the test seam shortens it; AD-25's in production). */
	cloudTiming: CloudTiming = CLOUD_TIMING;
	/** Ticket 7.5: when the last Cloud read of each cluster began (the floor is per cluster: each read is the whole cluster's). */
	private readonly cloudReads = new Map<string, number>();
	/** Ticket 7.6: the window the figures are over, for the session (the tab's choice; none written anywhere). */
	private window: MetricsWindowMinutes = DEFAULT_WINDOW_MINUTES;

	get windowMinutes(): MetricsWindowMinutes {
		return this.window;
	}

	get windowMs(): number {
		return this.window * 60_000;
	}

	/** Ticket 7.6: the tab chose a window: every feed's figures over it, at once (no read). */
	setWindowMinutes(minutes: MetricsWindowMinutes): void {
		if (minutes === this.window) {
			return;
		}
		this.window = minutes;
		this.feeds.forEach((f) => f.windowChanged());
	}

	/** Ticket 7.5: when the last Cloud read of `clusterId` began, if any. */
	lastCloudReadOf(clusterId: string): number | undefined {
		return this.cloudReads.get(clusterId);
	}

	/** Ticket 7.5: a Cloud read of `clusterId` begins now. */
	cloudReadStarted(clusterId: string): void {
		this.cloudReads.set(clusterId, Date.now());
	}

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

	/** The config of `uri`, or `undefined` (logged) when it cannot be read; none for a Cloud pipeline with no file. */
	configOf(uri: vscode.Uri): MetricsConfig | undefined {
		if (uri.scheme === CLOUD_METRICS_SCHEME) {
			return undefined;
		}
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
