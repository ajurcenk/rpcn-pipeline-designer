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
	/** Ticket 7.7: its share of the pipeline's time over the window, 0–1 (`null` for the input, or no rates yet). */
	readonly share: number | null;
	/** Ticket 7.7: the slowest component (the largest share among the leaves). */
	readonly slowest: boolean;
	/** Ticket 7.7: it had errors over the window. */
	readonly hasErrors: boolean;
}

/**
 * Ticket 7.7: the tab's summary line (board 1), computed by the host: the slowest component, the
 * input's and the output's rates and their gap (input − output per second, and its share of the
 * input's; `null`: none named), and the components with errors over the window.
 */
export interface MetricsSummary {
	readonly slowest: { readonly name: string; readonly path: string; readonly share: number; readonly p50: number | null } | null;
	readonly inputRate: number | null;
	readonly outputRate: number | null;
	readonly gap: { readonly rate: number; readonly share: number | null } | null;
	readonly errors: readonly { readonly name: string; readonly rate: number }[];
}

export type MetricsColumn = 'name' | 'path' | 'in' | 'out' | 'batchesIn' | 'batchesOut' | 'errors' | 'errorShare' | 'p50' | 'p90' | 'p99' | 'mean' | 'share';

/** The sortable columns in their order (ticket 7.6 decision; 7.7: Share after Mean); the trend column follows them, not sortable. */
export const METRICS_COLUMNS: readonly MetricsColumn[] = [
	'name', 'path', 'in', 'out', 'batchesIn', 'batchesOut', 'errors', 'errorShare', 'p50', 'p90', 'p99', 'mean', 'share',
];

export const COLUMN_LABELS: Readonly<Record<MetricsColumn, string>> = {
	name: 'Component', path: 'Path', in: 'In/s', out: 'Out/s', batchesIn: 'Batches in/s', batchesOut: 'Batches out/s',
	errors: 'Errors/s', errorShare: 'Error %', p50: 'P50', p90: 'P90', p99: 'P99', mean: 'Mean', share: 'Share',
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
	share: 'The share of the pipeline\'s time spent in this component over the window (the top-level processors and the output make 100%)',
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
 * Ticket 8 (board 5): why a run or an endpoint serves no metrics: `type` (the config's own `metrics`
 * section is not `prometheus`), `answer` (the endpoint answered a 404, or not Prometheus text),
 * `noSeries` (5 answers in a row held no component series: "No figures yet").
 */
export type NotServedCause = 'type' | 'answer' | 'noSeries';

export const NOT_SERVED_CAUSES: readonly NotServedCause[] = ['type', 'answer', 'noSeries'];

/**
 * The tab's state: `none` (no file chosen yet), `notRunning` (the file has no run), `waiting` (running,
 * no reading yet), `live`, `stopped` (the run ended; its last figures stay), `notServed` (the run
 * serves no metrics, `reason` says why, `cause` how), `unreachable` (reads keep failing; tried again at the interval).
 * Ticket 7.5, a Cloud pipeline: `noAccess` (its cluster has no metrics access set; nothing is read),
 * `refused` (the endpoint refused the user or password; not read again until the access is set again).
 */
export type MetricsPanelState =
	| { readonly kind: 'none' }
	| { readonly kind: 'notRunning' }
	| { readonly kind: 'waiting' }
	| { readonly kind: 'live' }
	| { readonly kind: 'stopped' }
	| { readonly kind: 'notServed'; readonly reason: string; readonly cause: NotServedCause }
	| { readonly kind: 'unreachable'; readonly message: string }
	| { readonly kind: 'noAccess'; readonly cluster: string }
	| { readonly kind: 'refused'; readonly cluster: string; readonly message: string };

/** Ticket 8: the Cloud pipeline a not-running file is deployed to (its `.cloud.json`), as its button names it. */
export interface MetricsMappedPipeline {
	readonly pipeline: string;
	readonly cluster: string;
}

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
	/** Ticket 7.7: the summary line; absent or `null` while there are no rates (not shown). */
	readonly summary?: MetricsSummary | null;
	/** Ticket 8: when the next read is due (ms since the epoch) while unreachable; absent or `null`: none set (one in flight). */
	readonly retryAt?: number | null;
	/** Ticket 8: when the figures shown were read (ms since the epoch); absent or `null`: none shown. */
	readonly lastReadingAt?: number | null;
	/** Ticket 8: a Set up metrics access… of the bound cluster runs (its buttons are disabled). */
	readonly settingUp?: boolean;
	/** Ticket 8: a not-running file's mapped Cloud pipeline; absent or `null`: none. */
	readonly mapped?: MetricsMappedPipeline | null;
};

export type MetricsWebviewMessage =
	| { readonly type: 'ready' }
	/** A column header was clicked: the host orders the rows (`null`: config order). */
	| { readonly type: 'sort'; readonly sort: MetricsSort | null }
	/** Ticket 7.6: a window was chosen: the host computes the figures over it. */
	| { readonly type: 'window'; readonly minutes: MetricsWindowMinutes }
	/**
	 * Ticket 8 (board 5): a state's button. No field: the host acts on the tab's current binding only, and
	 * only when the state shows the button (`metricsStateActions`).
	 */
	| { readonly type: MetricsActionType };

/** Ticket 8: the state buttons' messages. */
export type MetricsActionType =
	| 'runRequested'
	| 'showMappedRequested'
	| 'metricsSectionRequested'
	| 'readAgainRequested'
	| 'setUpAccessRequested'
	| 'forgetAccessRequested'
	| 'retryRequested'
	| 'outputRequested';

export const METRICS_ACTION_TYPES: readonly MetricsActionType[] = [
	'runRequested', 'showMappedRequested', 'metricsSectionRequested', 'readAgainRequested', 'setUpAccessRequested', 'forgetAccessRequested',
	'retryRequested', 'outputRequested',
];

/** Ticket 8: what a state's buttons depend on besides the state, as the host knows it and the show message carries it. */
export interface MetricsActionContext {
	/** The local file's name (a Cloud pipeline's mapped file; `null`: none). */
	readonly file: string | null;
	/** Whether a Cloud pipeline is shown. */
	readonly cloud: boolean;
	/** A not-running file's mapped Cloud pipeline. */
	readonly mapped: MetricsMappedPipeline | null;
}

export interface MetricsStateAction {
	readonly label: string;
	readonly type: MetricsActionType;
	readonly primary?: true;
}

/** Ticket 8 (board 5): the state's buttons, in order (the first, when primary, is the button style). */
export function metricsStateActions(state: MetricsPanelState, ctx: MetricsActionContext): readonly MetricsStateAction[] {
	const local = !ctx.cloud && ctx.file !== null;
	switch (state.kind) {
		case 'notRunning':
			return local ? [
				{ label: `Run ${ctx.file}`, type: 'runRequested', primary: true },
				...(ctx.mapped ? [{ label: `Show ${ctx.mapped.pipeline} on ${ctx.mapped.cluster}`, type: 'showMappedRequested' } as const] : []),
			] : [];
		case 'stopped':
			return local ? [{ label: `Run ${ctx.file}`, type: 'runRequested', primary: true }] : [];
		case 'notServed':
			return [
				...(local && state.cause !== 'noSeries' ? [{ label: 'Open the metrics section', type: 'metricsSectionRequested', primary: true } as const] : []),
				...(state.cause !== 'type' ? [{ label: 'Read again', type: 'readAgainRequested' } as const] : []),
			];
		case 'noAccess':
			return ctx.cloud ? [{ label: 'Set up metrics access…', type: 'setUpAccessRequested', primary: true }] : [];
		case 'refused':
			return ctx.cloud ? [
				{ label: 'Set up metrics access…', type: 'setUpAccessRequested', primary: true },
				{ label: 'Forget metrics access', type: 'forgetAccessRequested' },
			] : [];
		case 'unreachable':
			return [{ label: 'Retry now', type: 'retryRequested', primary: true }, { label: 'Show output', type: 'outputRequested' }];
		case 'none':
		case 'waiting':
		case 'live':
			return [];
	}
}

/** Ticket 8: the buttons a Set up metrics access… in progress disables. */
export function isSetUpAction(type: MetricsActionType): boolean {
	return type === 'setUpAccessRequested' || type === 'forgetAccessRequested';
}

// ---------------------------------------------------------------------------------------------
// Texts.
// ---------------------------------------------------------------------------------------------

export const NO_FILE_TEXT = 'Run a Redpanda Connect config, then use Show Pipeline Metrics on it.';
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

/** Ticket 8: "10:42:05", a reading's time of day (local time, 24 hours). */
export function clockText(ms: number): string {
	const d = new Date(ms);
	const two = (n: number) => String(n).padStart(2, '0');
	return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** Ticket 8: "Retrying in 15 s", "Retrying…" (`null`: a read now). */
export function retryingText(seconds: number | null): string {
	return seconds === null ? 'Retrying…' : `Retrying in ${seconds} s`;
}

/** What a state's texts depend on besides the state. */
export interface MetricsTextContext {
	readonly file: string | null;
	readonly port: number | null;
	/** A Cloud pipeline's endpoint host; `null`: a local run. */
	readonly host: string | null;
	readonly mapped?: MetricsMappedPipeline | null;
	/** The seconds until the next retry (`null`: a read now); unreachable only. */
	readonly retrySeconds?: number | null;
	/** When the figures shown were read; `null`: none shown. */
	readonly lastReadingAt?: number | null;
}

/** Ticket 8 (board 5): the state panel's title and body (what happened, what to do); `undefined` when live. */
export function metricsStateTexts(state: MetricsPanelState, ctx: MetricsTextContext): { readonly title: string; readonly body: string } | undefined {
	const cloud = ctx.host !== null;
	switch (state.kind) {
		case 'none':
			return { title: 'No pipeline chosen', body: NO_FILE_TEXT };
		case 'notRunning': {
			const mapped = ctx.mapped ? ` It is deployed to ${ctx.mapped.pipeline} on ${ctx.mapped.cluster}: show that pipeline's metrics instead.` : '';
			return {
				title: 'Not running',
				body: ctx.file ? `${ctx.file} is not running. Run it to see its metrics, read from its run every few seconds.${mapped}` : 'This file is not running. Run it to see its metrics.',
			};
		}
		case 'waiting':
			return {
				title: 'Waiting for the first reading',
				body: cloud ? `Reading ${ctx.host}…` : ctx.port === null ? 'Reading the run\'s metrics…' : `Reading 127.0.0.1:${ctx.port}…`,
			};
		case 'live':
			return undefined;
		case 'stopped':
			return { title: 'Stopped', body: `${STOPPED_TEXT}${ctx.file ? ` Run ${ctx.file} again to read its new run.` : ''}` };
		case 'notServed':
			if (state.cause === 'noSeries') {
				return {
					title: 'No figures yet',
					body: `${state.reason}${cloud ? '' : ' It may still be starting: read again once it has processed messages.'}`,
				};
			}
			if (state.cause === 'type') {
				return {
					title: 'No metrics served',
					body: `The run serves no Prometheus metrics: ${state.reason} Set it to \`prometheus\` (or remove it) and run the file again.`,
				};
			}
			return {
				title: 'No metrics served',
				body: cloud ? `The endpoint serves no metrics for this pipeline: ${state.reason} Read again once it serves them.`
					: `The run serves no Prometheus metrics: ${state.reason} Check the config's \`metrics\` section, then read again.`,
			};
		case 'unreachable': {
			const at = ctx.lastReadingAt ?? null;
			const retry = retryingText(ctx.retrySeconds ?? null);
			// "Retrying…" ends the sentence itself: no full stop after the ellipsis.
			const last = at !== null ? `; the figures shown are from ${clockText(at)}.` : retry.endsWith('…') ? '' : '.';
			return {
				title: 'Can\'t read the metrics',
				body: `The last read failed (${state.message}). ${retry}${last}`,
			};
		}
		case 'noAccess':
			return {
				title: 'No metrics access',
				body: `${state.cluster} has no metrics access set. Set it up with the Prometheus user and password from the cluster's Overview › Prometheus in the Cloud UI; the figures are read once it is set.`,
			};
		case 'refused':
			return {
				title: 'Password refused',
				body: `${state.message}. Copy it again from ${state.cluster}'s Overview › Prometheus in the Cloud UI and set up metrics access again; nothing is read until then.`,
			};
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

/** Ticket 7.7: "Slowest: <name> <path> · N% of the pipeline's time · p50 …". */
export function slowestText(s: NonNullable<MetricsSummary['slowest']>): string {
	return `Slowest: ${s.name}${s.path !== '' ? ` ${s.path}` : ''} · ${formatShare(s.share)} of the pipeline's time · p50 ${formatNs(s.p50)}`;
}

/**
 * Ticket 7.7: "Input X/s → Output Y/s · no gap" or "… · gap 50.0/s (25%)"; "Input X/s" alone when the
 * output's rate is unknown (an output `broker` has no `root.output` series), so no gap is named;
 * `undefined` when the input's is unknown.
 */
export function flowText(summary: MetricsSummary): string | undefined {
	if (summary.inputRate === null) {
		return undefined;
	}
	if (summary.outputRate === null) {
		return `Input ${formatRate(summary.inputRate)}/s`;
	}
	const rates = `Input ${formatRate(summary.inputRate)}/s → Output ${formatRate(summary.outputRate)}/s`;
	const gap = summary.gap;
	if (!gap) {
		return `${rates} · no gap`;
	}
	const share = gap.share === null ? '' : ` (${Math.round(Math.abs(gap.share) * 100)}%)`;
	return `${rates} · gap ${formatRate(Math.abs(gap.rate))}/s${share}`;
}

/** Ticket 7.7: "Errors: none" or "Errors: <name> <rate>/s, …". */
export function errorsText(summary: MetricsSummary): string {
	return summary.errors.length === 0 ? 'Errors: none'
		: `Errors: ${summary.errors.map((e) => `${e.name} ${formatRate(e.rate)}/s`).join(', ')}`;
}

/** Ticket 7.7: the summary line's parts, in board 1's order. */
export function summaryParts(summary: MetricsSummary): string[] {
	const flow = flowText(summary);
	return [...(summary.slowest ? [slowestText(summary.slowest)] : []), ...(flow !== undefined ? [flow] : []), errorsText(summary)];
}

/** Ticket 7.7 (board 2): the slowest node's band, "SLOWEST · N% of the time". */
export function slowestBandText(share: number | null): string {
	return `SLOWEST · ${formatShare(share)} of the time`;
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
		&& Array.isArray(v.trend) && v.trend.every((p) => typeof p === 'number' && Number.isFinite(p))
		&& isFigure(v.share) && typeof v.slowest === 'boolean' && typeof v.hasErrors === 'boolean';
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isSummary(v: unknown): v is MetricsSummary {
	if (!isObject(v)) {
		return false;
	}
	const s = v.slowest;
	const gap = v.gap;
	return (s === null || (isObject(s) && typeof s.name === 'string' && typeof s.path === 'string' && isNumber(s.share) && isFigure(s.p50)))
		&& isFigure(v.inputRate) && isFigure(v.outputRate)
		&& (gap === null || (isObject(gap) && isNumber(gap.rate) && isFigure(gap.share)))
		&& Array.isArray(v.errors) && v.errors.every((e) => isObject(e) && typeof e.name === 'string' && isNumber(e.rate));
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
			return typeof v.reason === 'string' && typeof v.cause === 'string' && (NOT_SERVED_CAUSES as readonly string[]).includes(v.cause);
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
		&& (v.summary === undefined || v.summary === null || isSummary(v.summary))
		&& (v.retryAt === undefined || v.retryAt === null || isNumber(v.retryAt))
		&& (v.lastReadingAt === undefined || v.lastReadingAt === null || isNumber(v.lastReadingAt))
		&& (v.settingUp === undefined || typeof v.settingUp === 'boolean')
		&& (v.mapped === undefined || v.mapped === null || (isObject(v.mapped) && typeof v.mapped.pipeline === 'string' && typeof v.mapped.cluster === 'string'))
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
			return typeof v.type === 'string' && (METRICS_ACTION_TYPES as readonly string[]).includes(v.type) ? { type: v.type as MetricsActionType } : undefined;
	}
}
