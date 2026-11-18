// The Pipeline Metrics tab's host↔webview contract (ticket 7.2, AD-5, AD-15, AD-25): its rows, its
// states and its messages as discriminated unions on `type`, with hand-written validators as in
// `logsProtocol.ts` (host messages checked and returned unchanged, webview messages copied with only
// their own fields, malformed input `undefined`, never a throw), and the texts both sides show. The
// host computes every figure (rates, latencies, the order); the webview only formats and renders them.
// Imports nothing (AD-15).

/** What a row stands for: a model node's role, or, for a series with no node, its family's. */
export type MetricKind = 'input' | 'processor' | 'output' | 'resource';

export const METRIC_KINDS: readonly MetricKind[] = ['input', 'processor', 'output', 'resource'];

/** One component's figures. Rates are per second; latencies in nanoseconds; `null`: none ("—"). */
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
	readonly errorRate: number | null;
	readonly p50: number | null;
	readonly p99: number | null;
}

export type MetricsColumn = 'name' | 'path' | 'in' | 'out' | 'errors' | 'p50' | 'p99';

export const METRICS_COLUMNS: readonly MetricsColumn[] = ['name', 'path', 'in', 'out', 'errors', 'p50', 'p99'];

export const COLUMN_LABELS: Readonly<Record<MetricsColumn, string>> = {
	name: 'Component', path: 'Path', in: 'In/s', out: 'Out/s', errors: 'Errors/s', p50: 'P50', p99: 'P99',
};

export interface MetricsSort {
	readonly column: MetricsColumn;
	readonly dir: 'asc' | 'desc';
}

/**
 * The tab's state: `none` (no file chosen yet), `notRunning` (the file has no run), `waiting` (running,
 * no reading yet), `live`, `stopped` (the run ended; its last figures stay), `notServed` (the run
 * serves no metrics, `reason` says why), `unreachable` (reads keep failing; tried again at the interval).
 */
export type MetricsPanelState =
	| { readonly kind: 'none' }
	| { readonly kind: 'notRunning' }
	| { readonly kind: 'waiting' }
	| { readonly kind: 'live' }
	| { readonly kind: 'stopped' }
	| { readonly kind: 'notServed'; readonly reason: string }
	| { readonly kind: 'unreachable'; readonly message: string };

export type MetricsHostMessage = {
	readonly type: 'show';
	/** "Local run · <file>"; `null` before the first Show Pipeline Metrics. */
	readonly source: string | null;
	/** The file's name. */
	readonly file: string | null;
	/** The run's metrics port on 127.0.0.1; `null` while it has none. */
	readonly port: number | null;
	readonly state: MetricsPanelState;
	readonly rows: readonly MetricRow[];
	readonly intervalMs: number;
	/** The order the rows come in: `null` is config order. */
	readonly sort: MetricsSort | null;
};

export type MetricsWebviewMessage =
	| { readonly type: 'ready' }
	/** A column header was clicked: the host orders the rows (`null`: config order). */
	| { readonly type: 'sort'; readonly sort: MetricsSort | null };

// ---------------------------------------------------------------------------------------------
// Texts.
// ---------------------------------------------------------------------------------------------

export const NO_FILE_TEXT = 'Run a Redpanda Connect config, then use Show Pipeline Metrics on it.';
export const NOT_RUNNING_TEXT = 'Run this file to see its metrics.';
export const STOPPED_TEXT = 'The run stopped. The figures are from its last reading.';
export const KEPT_TEXT = 'Readings are kept only while this tab is open.';
export const NO_ROWS_TEXT = 'No components yet.';

/** "Local run · <file>". */
export function localSourceLabel(file: string): string {
	return `Local run · ${file}`;
}

/** "127.0.0.1:<port> · read every <n> s". */
export function addressText(port: number, intervalMs: number): string {
	return `127.0.0.1:${port} · read every ${Math.round(intervalMs / 100) / 10} s`;
}

/** The state line under the source, or `undefined` when live. */
export function stateText(state: MetricsPanelState, file: string | null, port: number | null): string | undefined {
	switch (state.kind) {
		case 'none':
			return NO_FILE_TEXT;
		case 'notRunning':
			return file ? `${file} is not running. ${NOT_RUNNING_TEXT}` : NOT_RUNNING_TEXT;
		case 'waiting':
			return port === null ? 'Waiting for the first reading…' : `Waiting for the first reading of 127.0.0.1:${port}…`;
		case 'live':
			return undefined;
		case 'stopped':
			return STOPPED_TEXT;
		case 'notServed':
			return `No metrics served: ${state.reason}`;
		case 'unreachable':
			return `Can't read the metrics: ${state.message}. Trying again.`;
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
		&& isFigure(v.inRate) && isFigure(v.outRate) && isFigure(v.errorRate) && isFigure(v.p50) && isFigure(v.p99);
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
		&& (v.sort === null || isSort(v.sort))
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
		default:
			return undefined;
	}
}
