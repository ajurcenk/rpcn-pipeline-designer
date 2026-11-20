// The Pipeline Metrics tab's view (ticket 7.2, design board 1, AD-25): the source line names the file's
// local run and its address ("Local run · <file>", "127.0.0.1:<port> · read every 2 s"), then the
// state line when there is one (not running, waiting, stopped, no metrics served, can't read), then
// the table: one row per component (its kind and name, indented under its parent, its YAML path,
// In/s, Out/s, Errors/s, P50, P99). A header's click asks the host for that order (ascending, then
// descending, then config order). Every figure comes from the host; the view formats them (rates
// with one decimal, nanoseconds as ns, µs, ms or s, "—" for none). Theme colours only.
// Ticket 7.5 (design board 3): a Cloud pipeline's header names it ("Cloud · <cluster> · <pipeline>") and
// its address line the endpoint's host, the mapped file (or "not mapped to a file") and the interval;
// no metrics access and a refused read are states of their own.
// Ticket 7.6 (board 1): a 1 / 5 / 15 min control in the header (`aria-pressed` buttons) asks the host for
// that window; the columns are In/s, Out/s, Batches in/s, Batches out/s, Errors/s, Error %, P50, P90,
// P99, Mean (each sortable) and Trend, an inline SVG line of the host's out-rate points scaled to its
// own min and max (flat when constant), with its min and max as its accessible text. The footer names
// the window. The table scrolls sideways when the tab is narrow.

import { useEffect, useState } from 'react';
import {
	addressText, cloudAddressText, COLUMN_LABELS, COLUMN_TITLES, DEFAULT_WINDOW_MINUTES, formatNs, formatRate, formatShare, keptText, METRICS_COLUMNS,
	METRICS_WINDOWS, nextSort, NO_ROWS_TEXT, parseMetricsHostMessage, stateText, TREND_LABEL, trendText, windowLabel,
	type MetricRow, type MetricsColumn, type MetricsHostMessage, type MetricsWebviewMessage,
} from '../../../src/shared/metricsProtocol';

export const NO_SOURCE_TITLE = 'Pipeline Metrics';
/** How far each nesting level is indented. */
export const INDENT_EM = 1.25;

/** The figure columns, after the component and its path. */
const FIGURE_COLUMNS = METRICS_COLUMNS.filter((c) => c !== 'name' && c !== 'path');
const NUMERIC: ReadonlySet<MetricsColumn> = new Set(FIGURE_COLUMNS);
/** The trend line's size in px. */
export const TREND_WIDTH = 80;
export const TREND_HEIGHT = 16;

/** A cell's text. */
export function cellText(row: MetricRow, column: MetricsColumn): string {
	switch (column) {
		case 'name': return row.name;
		case 'path': return row.path === '' ? '—' : row.path;
		case 'in': return formatRate(row.inRate);
		case 'out': return formatRate(row.outRate);
		case 'batchesIn': return formatRate(row.batchInRate);
		case 'batchesOut': return formatRate(row.batchOutRate);
		case 'errors': return formatRate(row.errorRate);
		case 'errorShare': return formatShare(row.errorShare);
		case 'p50': return formatNs(row.p50);
		case 'p90': return formatNs(row.p90);
		case 'p99': return formatNs(row.p99);
		case 'mean': return formatNs(row.mean);
	}
}

/**
 * The trend's polyline points in a `TREND_WIDTH` × `TREND_HEIGHT` box, scaled to its own min and max
 * (flat in the middle when constant; one point is drawn as a flat line); `''` with none.
 */
export function trendPoints(points: readonly number[]): string {
	if (points.length === 0) {
		return '';
	}
	const values = points.length === 1 ? [points[0], points[0]] : points;
	const min = Math.min(...values);
	const max = Math.max(...values);
	const pad = 1;
	const h = TREND_HEIGHT - 2 * pad;
	const step = TREND_WIDTH / (values.length - 1);
	return values.map((v, i) => {
		const y = max === min ? TREND_HEIGHT / 2 : pad + h - ((v - min) / (max - min)) * h;
		return `${Math.round(i * step * 10) / 10},${Math.round(y * 10) / 10}`;
	}).join(' ');
}

function Trend({ points }: { readonly points: readonly number[] }) {
	const label = trendText(points);
	if (points.length === 0) {
		return <span className="rpcn-metrics-trend-none" title={label} aria-label={label}>—</span>;
	}
	return (
		<svg className="rpcn-metrics-trend" width={TREND_WIDTH} height={TREND_HEIGHT} viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`} role="img" aria-label={label}>
			<title>{label}</title>
			<polyline points={trendPoints(points)} fill="none" />
		</svg>
	);
}

export function MetricsView({ post }: { readonly post: (message: MetricsWebviewMessage) => void }) {
	const [shown, setShown] = useState<MetricsHostMessage | undefined>(undefined);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const m = parseMetricsHostMessage(event.data);
			if (m) {
				setShown(m);
			}
		};
		window.addEventListener('message', onMessage);
		post({ type: 'ready' });
		return () => window.removeEventListener('message', onMessage);
	}, [post]);

	const state = shown?.state ?? { kind: 'none' as const };
	const cloud = shown?.cloud ?? null;
	const line = stateText(state, shown?.file ?? null, shown?.port ?? null, cloud?.host ?? null);
	const address = !shown ? undefined : cloud ? cloudAddressText(cloud.host, shown.file, shown.intervalMs)
		: shown.port !== null ? addressText(shown.port, shown.intervalMs) : undefined;
	const rows = shown?.rows ?? [];
	const sort = shown?.sort ?? null;
	const windowMinutes = shown?.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
	const showTable = rows.length > 0;

	return (
		<div className="rpcn-metrics">
			<header className="rpcn-metrics-header">
				<h1 className="rpcn-metrics-title">
					<span className={`rpcn-metrics-dot rpcn-metrics-dot-${state.kind}`} aria-hidden="true" />
					{shown?.source ?? NO_SOURCE_TITLE}
				</h1>
				{address && <span className="rpcn-metrics-address">{address}</span>}
				<div className="rpcn-metrics-window" role="group" aria-label="Window">
					{METRICS_WINDOWS.map((minutes) => (
						<button
							key={minutes}
							type="button"
							className="rpcn-metrics-window-button"
							aria-pressed={minutes === windowMinutes}
							onClick={() => post({ type: 'window', minutes })}
						>
							{windowLabel(minutes)}
						</button>
					))}
				</div>
			</header>
			{line && (
				<p className={`rpcn-metrics-state rpcn-metrics-state-${state.kind}`} role={state.kind === 'unreachable' || state.kind === 'notServed' || state.kind === 'refused' ? 'alert' : 'status'}>
					{line}
				</p>
			)}
			<div className="rpcn-metrics-scroll">
				{showTable ? (
					<table className="rpcn-metrics-table">
						<thead>
							<tr>
								{METRICS_COLUMNS.map((column) => {
									const active = sort?.column === column ? sort.dir : undefined;
									return (
										<th
											key={column}
											className={NUMERIC.has(column) ? 'rpcn-metrics-num' : undefined}
											aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'}
										>
											<button type="button" className="rpcn-metrics-sort" title={COLUMN_TITLES[column]} onClick={() => post({ type: 'sort', sort: nextSort(sort, column) })}>
												{COLUMN_LABELS[column]}
												{active && <span aria-hidden="true">{active === 'asc' ? ' ▴' : ' ▾'}</span>}
											</button>
										</th>
									);
								})}
								<th className="rpcn-metrics-trend-head">{TREND_LABEL}</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.id} data-row={row.id} className={row.nodeId === null ? 'rpcn-metrics-unmatched' : undefined}>
									<td>
										<span className="rpcn-metrics-component" style={{ paddingLeft: `${row.depth * INDENT_EM}em` }}>
											<span className="rpcn-metrics-kind">{row.kind}</span>
											<span className="rpcn-metrics-name">{row.name}</span>
										</span>
									</td>
									<td className="rpcn-metrics-path">{cellText(row, 'path')}</td>
									{FIGURE_COLUMNS.map((column) => (
										<td key={column} className="rpcn-metrics-num" data-column={column}>{cellText(row, column)}</td>
									))}
									<td className="rpcn-metrics-trend-cell" data-column="trend"><Trend points={row.trend} /></td>
								</tr>
							))}
						</tbody>
					</table>
				) : (
					state.kind === 'live' && <p className="rpcn-metrics-empty">{NO_ROWS_TEXT}</p>
				)}
			</div>
			<footer className="rpcn-metrics-footer">{keptText(windowMinutes)}</footer>
		</div>
	);
}
