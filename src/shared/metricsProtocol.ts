// The Pipeline Metrics tab's host↔webview contract (ticket 7.2, AD-5, AD-15, AD-25): its rows, its
// states and its messages as discriminated unions on `type`, with hand-written validators as in
// `logsProtocol.ts` (host messages checked and returned unchanged, webview messages copied with only
// their own fields, malformed input `undefined`, never a throw), and the texts both sides show. The
// host computes every figure (rates, latencies, the order); the webview only formats and renders them.
// Imports nothing but types of `protocol.ts` (AD-15).

import type { NodeFigures } from './protocol';

/** What a row stands for: a model node's role, or, for a series with no node, its family's. */
export type MetricKind = 'input' | 'processor' | 'output' | 'resource';

export const METRIC_KINDS: readonly MetricKind[] = ['input', 'processor', 'output', 'resource'];

/**
 * One component's figures (ticket 7.6: over the chosen window). Rates are per second; latencies in
 * nanoseconds; the error share a fraction of the received (0–1); `null`: none ("—").
 */
export interface MetricRow {
	/** Unique among the rows: the node id, else `series:<path>:<label>`. */
	readonly id: string;
	/** The node the series maps to (AD-25); `null` for a series with no node (listed last). */
	readonly nodeId: string | null;
	readonly kind: MetricKind;
	/** The component's label, else its component name (`mapping`), else the series' path. */
	readonly name: string;
	/** The YAML path in AD-7's form (`pipeline.processors[0]`); `''` when not known. */
	readonly path: string;
	/** The nesting depth under its parent components (0 at the top level). */
	readonly depth: number;
	readonly inRate: number | null;
	readonly outRate: number | null;
	/** Ticket 7.6: batches received and sent per second. */
	readonly batchInRate: number | null;
	readonly batchOutRate: number | null;
	readonly errorRate: number | null;
	/** Ticket 7.6: errors as a share of received (processors only), 0–1. */
	readonly errorShare: number | null;
	/** The latest reading's quantiles (the process's own, not over the window). */
	readonly p50: number | null;
	readonly p90: number | null;
	readonly p99: number | null;
	/** Ticket 7.6: the mean latency over the window (Δ`_sum` / Δ`_count`). */
	readonly mean: number | null;
	/** Ticket 7.6: messages out per second, one point per reading interval of the window, oldest first. */
	readonly trend: readonly number[];
}

export type MetricsColumn = 'name' | 'path' | 'in' | 'out' | 'batchesIn' | 'batchesOut' | 'errors' | 'errorShare' | 'p50' | 'p90' | 'p99' | 'mean';

/** The sortable columns in their order (ticket 7.6 decision); the trend column follows them, not sortable. */
export const METRICS_COLUMNS: readonly MetricsColumn[] = [
	'name', 'path', 'in', 'out', 'batchesIn', 'batchesOut', 'errors', 'errorShare', 'p50', 'p90', 'p99', 'mean',
];

export const COLUMN_LABELS: Readonly<Record<MetricsColumn, string>> = {
	name: 'Component', path: 'Path', in: 'In/s', out: 'Out/s', batchesIn: 'Batches in/s', batchesOut: 'Batches out/s',
	errors: 'Errors/s', errorShare: 'Error %', p50: 'P50', p90: 'P90', p99: 'P99', mean: 'Mean',
};

/** The trend column's header (not sortable). */
export const TREND_LABEL = 'Trend';

/** Ticket 7.6: the column headers' tooltips, where a figure needs saying how it is made. */
export const COLUMN_TITLES: Readonly<Partial<Record<MetricsColumn, string>>> = {
	p50: 'From the latest reading: the process\'s own quantile, not over the window',
	p90: 'From the latest reading: the process\'s own quantile, not over the window',
	p99: 'From the latest reading: the process\'s own quantile, not over the window',
	mean: 'Over the window: the latency\'s total over its count',
	errorShare: 'Errors as a share of the messages received, over the window',
};

/** Ticket 7.6: the windows the figures are computed over, in minutes. */
export type MetricsWindowMinutes = 1 | 5 | 15;

export const METRICS_WINDOWS: readonly MetricsWindowMinutes[] = [1, 5, 15];

/** The window until one is chosen (ticket 7.6 decision). */
export const DEFAULT_WINDOW_MINUTES: MetricsWindowMinutes = 5;

export const isWindowMinutes = (v: unknown): v is MetricsWindowMinutes => (METRICS_WINDOWS as readonly unknown[]).includes(v);

export interface MetricsSort {
	readonly column: MetricsColumn;
	readonly dir: 'asc' | 'desc';
}

/**
 * The tab's state: `none` (no file chosen yet), `notRunning` (the file has no run), `waiting` (running,
 * no reading yet), `live`, `stopped` (the run ended; its last figures stay), `notServed` (the run
 * serves no metrics, `reason` says why), `unreachable` (reads keep failing; tried again at the interval).
 * Ticket 7.5, a Cloud pipeline: `noAccess` (its cluster has no metrics access set; nothing is read),
 * `refused` (the endpoint refused the user or password; not read again until the access is set again).
 */
export type MetricsPanelState =
	| { readonly kind: 'none' }
	| { readonly kind: 'notRunning' }
	| { readonly kind: 'waiting' }
	| { readonly kind: 'live' }
	| { readonly kind: 'stopped' }
	| { readonly kind: 'notServed'; readonly reason: string }
	| { readonly kind: 'unreachable'; readonly message: string }
	| { readonly kind: 'noAccess'; readonly cluster: string }
	| { readonly kind: 'refused'; readonly cluster: string; readonly message: string };

/** Ticket 7.5: where a Cloud pipeline's figures are read (the header's address line). */
export interface MetricsCloudAddress {
	/** The cluster's Prometheus endpoint host (no path, query or credentials). */
	readonly host: string;
}

export type MetricsHostMessage = {
	readonly type: 'show';
	/** "Local run · <file>" or (ticket 7.5) "Cloud · <cluster> · <pipeline>"; `null` before the first Show Pipeline Metrics. */
	readonly source: string | null;
	/** The file's name (a Cloud pipeline's mapped file; `null` when it is not mapped to one). */
	readonly file: string | null;
	/** Ticket 7.5: a Cloud pipeline's endpoint; absent or `null` for a local run. */
	readonly cloud?: MetricsCloudAddress | null;
	/** The run's metrics port on 127.0.0.1; `null` while it has none. */
	readonly port: number | null;
	readonly state: MetricsPanelState;
	readonly rows: readonly MetricRow[];
	readonly intervalMs: number;
	/** The order the rows come in: `null` is config order. */
	readonly sort: MetricsSort | null;
	/** Ticket 7.6: the window the figures are over. */
	readonly windowMinutes: MetricsWindowMinutes;
};

export type MetricsWebviewMessage =
	| { readonly type: 'ready' }
	/** A column header was clicked: the host orders the rows (`null`: config order). */
	| { readonly type: 'sort'; readonly sort: MetricsSort | null }
	/** Ticket 7.6: a window was chosen: the host computes the figures over it. */
	| { readonly type: 'window'; readonly minutes: MetricsWindowMinutes };

// ---------------------------------------------------------------------------------------------
// Texts.
// ---------------------------------------------------------------------------------------------

export const NO_FILE_TEXT = 'Run a Redpanda Connect config, then use Show Pipeline Metrics on it.';
export const NOT_RUNNING_TEXT = 'Run this file to see its metrics.';
export const STOPPED_TEXT = 'The run stopped. The figures are from its last reading.';
/** Ticket 7.6 (board 1): the footer, "Figures over the last <n> minutes · readings kept only while this tab is open". */
export function keptText(minutes: MetricsWindowMinutes): string {
	return `Figures over the last ${minutes} minute${minutes === 1 ? '' : 's'} · readings kept only while this tab is open`;
}

/** Ticket 7.6: a window button's text ("5 min"). */
export function windowLabel(minutes: MetricsWindowMinutes): string {
	return `${minutes} min`;
}
export const NO_ROWS_TEXT = 'No components yet.';

/** "Local run · <file>". */
export function localSourceLabel(file: string): string {
	return `Local run · ${file}`;
}

/** "read every <n> s". */
function everyText(intervalMs: number): string {
	return `read every ${Math.round(intervalMs / 100) / 10} s`;
}

/** "127.0.0.1:<port> · read every <n> s". */
export function addressText(port: number, intervalMs: number): string {
	return `127.0.0.1:${port} · ${everyText(intervalMs)}`;
}

/** Ticket 7.5 (design board 3): "Cloud · <cluster> · <pipeline>". */
export function cloudSourceLabel(cluster: string, pipeline: string): string {
	return `Cloud · ${cluster} · ${pipeline}`;
}

/** Ticket 7.5: what a Cloud pipeline's header says when no local file is mapped to it. */
export const NOT_MAPPED_TEXT = 'not mapped to a file';

/** Ticket 7.5 (design board 3): "<host> · mapped to <file> · read every <n> s" (or "not mapped to a file"). */
export function cloudAddressText(host: string, file: string | null, intervalMs: number): string {
	return `${host} · ${file ? `mapped to ${file}` : NOT_MAPPED_TEXT} · ${everyText(intervalMs)}`;
}

/** Ticket 7.5: the no-access state's text, naming the cluster and what to do. */
export function noMetricsAccessText(cluster: string): string {
	return `No metrics access is held for ${cluster}. Connect to Redpanda Cloud, or use Set up metrics access… on its row in the Cloud view; the figures are read once it is set.`;
}

/** Ticket 7.5: the refused state's text (`message`: the read's, "… refused: the user or password is wrong (HTTP 401)"). */
export function refusedText(cluster: string, message: string): string {
	return `${message}. Nothing more is read. Use Set up metrics access… on ${cluster}'s row in the Cloud view to enter them again.`;
}

/** The state line under the source, or `undefined` when live (`host`: a Cloud pipeline's endpoint). */
export function stateText(state: MetricsPanelState, file: string | null, port: number | null, host: string | null = null): string | undefined {
	switch (state.kind) {
		case 'none':
			return NO_FILE_TEXT;
		case 'notRunning':
			return file ? `${file} is not running. ${NOT_RUNNING_TEXT}` : NOT_RUNNING_TEXT;
		case 'waiting':
			return host !== null ? `Waiting for the first reading of ${host}…`
				: port === null ? 'Waiting for the first reading…' : `Waiting for the first reading of 127.0.0.1:${port}…`;
		case 'live':
			return undefined;
		case 'stopped':
			return STOPPED_TEXT;
		case 'notServed':
			return `No metrics served: ${state.reason}`;
		case 'unreachable':
			return `Can't read the metrics: ${state.message}. Trying again.`;
		case 'noAccess':
			return noMetricsAccessText(state.cluster);
		case 'refused':
			return refusedText(state.cluster, state.message);
	}
}

/** A rate per second: one decimal ("200.0"), `—` for none. */
export function formatRate(value: number | null): string {
	if (value === null || !Number.isFinite(value)) {
		return '—';
	}
	return value >= 10_000 ? Math.round(value).toLocaleString('en-US') : value.toFixed(1);
}

/** Nanoseconds as ns, µs, ms or s with three significant digits ("7.70 µs", "5.17 ms"), `—` for none. */
export function formatNs(value: number | null): string {
	if (value === null || !Number.isFinite(value) || value < 0) {
		return '—';
	}
	const [scaled, unit] = value < 1_000 ? [value, 'ns'] : value < 1_000_000 ? [value / 1_000, 'µs']
		: value < 1_000_000_000 ? [value / 1_000_000, 'ms'] : [value / 1_000_000_000, 's'];
	const digits = unit === 'ns' ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
	return `${scaled.toFixed(digits)} ${unit}`;
}

/** Ticket 7.6: a share as a percentage with one decimal ("2.5%"), `—` for none. */
export function formatShare(value: number | null): string {
	if (value === null || !Number.isFinite(value) || value < 0) {
		return '—';
	}
	return `${(value * 100).toFixed(1)}%`;
}

/** Ticket 7.6: a trend's accessible text, "Out/s over the window: from <min> to <max>" (or "no trend yet"). */
export function trendText(points: readonly number[]): string {
	if (points.length === 0) {
		return 'Out/s over the window: no trend yet';
	}
	return `Out/s over the window: from ${formatRate(Math.min(...points))} to ${formatRate(Math.max(...points))}`;
}

/** A rate on a node's figures line: "200.0/s", `—` for none. */
function rateText(value: number | null): string {
	const text = formatRate(value);
	return text === '—' ? text : `${text}/s`;
}

/**
 * A graph node's figures line (ticket 7.3, design board 2): `<out>/s · <p50> / <p99> · <errors>/s
 * errors` for a processor or an output, `<out>/s` only for the input (its latency is end-to-end).
 */
export function figuresLine(f: NodeFigures): string {
	if (f.kind === 'input') {
		return rateText(f.outRate);
	}
	return `${rateText(f.outRate)} · ${formatNs(f.p50)} / ${formatNs(f.p99)} · ${rateText(f.errorRate)} errors`;
}

/** The sort a click on `column` gives after `current`: ascending, then descending, then config order. */
export function nextSort(current: MetricsSort | null, column: MetricsColumn): MetricsSort | null {
	if (!current || current.column !== column) {
		return { column, dir: 'asc' };
	}
	return current.dir === 'asc' ? { column, dir: 'desc' } : null;
}

// ---------------------------------------------------------------------------------------------
// Validators.
// ---------------------------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFigure = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));
const isPort = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 65_536;

function isRow(v: unknown): v is MetricRow {
	return isObject(v) && typeof v.id === 'string' && (v.nodeId === null || typeof v.nodeId === 'string')
		&& typeof v.kind === 'string' && (METRIC_KINDS as readonly string[]).includes(v.kind)
		&& typeof v.name === 'string' && typeof v.path === 'string'
		&& typeof v.depth === 'number' && Number.isInteger(v.depth) && v.depth >= 0
		&& isFigure(v.inRate) && isFigure(v.outRate) && isFigure(v.batchInRate) && isFigure(v.batchOutRate)
		&& isFigure(v.errorRate) && isFigure(v.errorShare) && isFigure(v.p50) && isFigure(v.p90) && isFigure(v.p99) && isFigure(v.mean)
		&& Array.isArray(v.trend) && v.trend.every((p) => typeof p === 'number' && Number.isFinite(p));
}

function isSort(v: unknown): v is MetricsSort {
	return isObject(v) && typeof v.column === 'string' && (METRICS_COLUMNS as readonly string[]).includes(v.column)
		&& (v.dir === 'asc' || v.dir === 'desc');
}

function isState(v: unknown): v is MetricsPanelState {
	if (!isObject(v)) {
		return false;
	}
	switch (v.kind) {
		case 'none':
		case 'notRunning':
		case 'waiting':
		case 'live':
		case 'stopped':
			return true;
		case 'notServed':
			return typeof v.reason === 'string';
		case 'unreachable':
			return typeof v.message === 'string';
		case 'noAccess':
			return typeof v.cluster === 'string';
		case 'refused':
			return typeof v.cluster === 'string' && typeof v.message === 'string';
		default:
			return false;
	}
}

/** A host message, or `undefined` for anything malformed. */
export function parseMetricsHostMessage(v: unknown): MetricsHostMessage | undefined {
	if (!isObject(v) || v.type !== 'show') {
		return undefined;
	}
	return (v.source === null || typeof v.source === 'string') && (v.file === null || typeof v.file === 'string')
		&& (v.port === null || isPort(v.port)) && isState(v.state) && Array.isArray(v.rows) && v.rows.every(isRow)
		&& typeof v.intervalMs === 'number' && Number.isFinite(v.intervalMs) && v.intervalMs > 0
		&& (v.sort === null || isSort(v.sort)) && isWindowMinutes(v.windowMinutes)
		&& (v.cloud === undefined || v.cloud === null || (isObject(v.cloud) && typeof v.cloud.host === 'string' && v.cloud.host !== ''))
		? v as MetricsHostMessage : undefined;
}

/** A webview message, copied with only its own fields, or `undefined` for anything malformed. */
export function parseMetricsWebviewMessage(v: unknown): MetricsWebviewMessage | undefined {
	if (!isObject(v)) {
		return undefined;
	}
	switch (v.type) {
		case 'ready':
			return { type: 'ready' };
		case 'sort':
			return v.sort === null ? { type: 'sort', sort: null }
				: isSort(v.sort) ? { type: 'sort', sort: { column: v.sort.column, dir: v.sort.dir } } : undefined;
		case 'window':
			return isWindowMinutes(v.minutes) ? { type: 'window', minutes: v.minutes } : undefined;
		default:
			return undefined;
	}
}
