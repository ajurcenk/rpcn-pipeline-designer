// @vitest-environment happy-dom
// The Pipeline Metrics tab's view (ticket 7.2, board 1) in happy-dom: it posts `ready`, names the source
// and its address, shows the state lines, renders one row per component with its kind, name (indented
// by depth), path and figures as the host sent them (rates with one decimal, ns as µs/ms/s, "—" for
// none), asks the host to sort on a header's click (ascending, descending, config order), and ignores
// malformed messages. The formatters and validators are checked here too.
// Ticket 7.6: the window control (1 / 5 / 15 min, `aria-pressed`, asks the host), the new columns
// (batches, error %, P90, mean), the trend line (inline SVG with its min and max as its text), the footer.
// Ticket 7.7: the summary line, the Share column, the slowest and errors row marks, the pinned column.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	addressText, cloudAddressText, cloudSourceLabel, errorsText, flowText, formatNs, formatRate, formatShare, keptText, nextSort, NO_FILE_TEXT, noMetricsAccessText,
	NOT_MAPPED_TEXT, parseMetricsHostMessage, parseMetricsWebviewMessage, refusedText, slowestBandText, slowestText, stateText, STOPPED_TEXT, summaryParts, trendText,
	type MetricRow, type MetricsHostMessage, type MetricsSummary, type MetricsWebviewMessage,
} from '../../../src/shared/metricsProtocol';
import { INDENT_EM, MetricsView, NO_SOURCE_TITLE, TREND_HEIGHT, trendPoints } from './MetricsView';

let host: HTMLDivElement;
let root: Root;
let posted: MetricsWebviewMessage[];

const send = async (message: MetricsHostMessage | Record<string, unknown>) => {
	await act(async () => {
		window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(JSON.stringify(message)) }));
	});
};

const row = (id: string, extra: Partial<MetricRow> = {}): MetricRow => ({
	id, nodeId: id, kind: 'processor', name: id, path: `pipeline.processors[0]`, depth: 0,
	inRate: null, outRate: null, batchInRate: null, batchOutRate: null, errorRate: null, errorShare: null, p50: null, p90: null, p99: null, mean: null, trend: [],
	share: null, slowest: false, hasErrors: false,
	...extra,
});

const SHOW: MetricsHostMessage = {
	type: 'show', source: 'Local run · a.yaml', file: 'a.yaml', port: 41873, state: { kind: 'live' }, intervalMs: 2000, sort: null, windowMinutes: 5,
	rows: [
		row('path:input', { kind: 'input', name: 'generate', path: 'input', outRate: 200 }),
		row('label:fast', {
			name: 'fast', inRate: 200, outRate: 199.84, batchInRate: 20, batchOutRate: 19.9, errorRate: 0, errorShare: 0.025, p50: 7700, p90: 15_000, p99: 21_000,
			mean: 8100, trend: [190, 200, 210],
		}),
		row('path:pipeline.processors[1].branch.processors[0]', { name: 'mapping', path: 'pipeline.processors[1].branch.processors[0]', depth: 1, p50: 5_170_000, p99: 1.5e9 }),
		row('path:output', { kind: 'output', name: 'drop', path: 'output', outRate: 199.8, errorRate: 0, p50: 87, p99: 4061 }),
		row('series:root.x:', { nodeId: null, name: 'x', path: 'x' }),
	],
};

const texts = (selector: string) => [...host.querySelectorAll(selector)].map((e) => e.textContent);

beforeEach(async () => {
	posted = [];
	host = document.createElement('div');
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root.render(<MetricsView post={(m) => posted.push(m)} />);
	});
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe('MetricsView', () => {
	it('posts ready and shows the no-file state before the host answers', () => {
		expect(posted).toEqual([{ type: 'ready' }]);
		expect(host.querySelector('h1')?.textContent).toBe(NO_SOURCE_TITLE);
		expect(host.querySelector('.rpcn-metrics-state')?.textContent).toBe(NO_FILE_TEXT);
		expect(host.querySelector('table')).toBeNull();
	});

	it('names the source and its address and renders the rows as sent', async () => {
		await send(SHOW);
		expect(host.querySelector('h1')?.textContent).toBe('Local run · a.yaml');
		expect(host.querySelector('.rpcn-metrics-address')?.textContent).toBe('127.0.0.1:41873 · read every 2 s');
		expect(host.querySelector('.rpcn-metrics-state')).toBeNull();
		expect(texts('thead th')).toEqual([
			'Component', 'Path', 'In/s', 'Out/s', 'Batches in/s', 'Batches out/s', 'Errors/s', 'Error %', 'P50', 'P90', 'P99', 'Mean', 'Share', 'Trend',
		]);
		const cells = [...host.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td:not([data-column="trend"])')].map((td) => td.textContent));
		expect(cells).toEqual([
			['inputgenerate', 'input', '—', '200.0', '—', '—', '—', '—', '—', '—', '—', '—', '—'],
			['processorfast', 'pipeline.processors[0]', '200.0', '199.8', '20.0', '19.9', '0.0', '2.5%', '7.70 µs', '15.0 µs', '21.0 µs', '8.10 µs', '—'],
			['processormapping', 'pipeline.processors[1].branch.processors[0]', '—', '—', '—', '—', '—', '—', '5.17 ms', '—', '1.50 s', '—', '—'],
			['outputdrop', 'output', '—', '199.8', '—', '—', '0.0', '—', '87 ns', '—', '4.06 µs', '—', '—'],
			['processorx', 'x', '—', '—', '—', '—', '—', '—', '—', '—', '—', '—', '—'],
		]);
		// The latency columns say how they are made.
		expect(host.querySelectorAll<HTMLButtonElement>('thead button')[8].title).toContain('latest reading');
		expect(host.querySelectorAll<HTMLButtonElement>('thead button')[11].title).toContain('Over the window');
		// The trend: an SVG line with its min and max as its text; none yet: "—".
		const trend = host.querySelector('[data-row="label:fast"] [data-column="trend"] svg');
		expect(trend?.getAttribute('role')).toBe('img');
		expect(trend?.getAttribute('aria-label')).toBe('Out/s over the window: from 190.0 to 210.0');
		expect(trend?.querySelector('polyline')?.getAttribute('points')).toBe(trendPoints([190, 200, 210]));
		expect(host.querySelector('[data-row="path:input"] [data-column="trend"]')?.textContent).toBe('—');
		expect(host.querySelector('[data-row="path:input"] [data-column="trend"] svg')).toBeNull();
		const nested = host.querySelector<HTMLElement>('[data-row="path:pipeline.processors[1].branch.processors[0]"] .rpcn-metrics-component');
		expect(nested?.style.paddingLeft).toBe(`${INDENT_EM}em`);
		expect(host.querySelector('[data-row="series:root.x:"]')?.className).toBe('rpcn-metrics-unmatched');
	});

	it('ticket 7.7: the summary line, the Share column, the slowest and errors marks (board 1)', async () => {
		const summary: MetricsSummary = {
			slowest: { name: 'sleep', path: 'pipeline.processors[2]', share: 0.996, p50: 5_170_000 },
			inputRate: 200, outputRate: 199.8, gap: null, errors: [],
		};
		const marked: MetricsHostMessage = {
			...SHOW, summary,
			rows: [
				row('path:input', { kind: 'input', name: 'generate', path: 'input', outRate: 200 }),
				row('label:fast', { name: 'fast', share: 0.004, errorRate: 2, hasErrors: true }),
				row('path:pipeline.processors[2]', { name: 'sleep', path: 'pipeline.processors[2]', share: 0.996, slowest: true, p50: 5_170_000 }),
			],
		};
		await send(marked);
		expect(texts('.rpcn-metrics-summary-part')).toEqual([
			'Slowest: sleep pipeline.processors[2] · 99.6% of the pipeline\'s time · p50 5.17 ms',
			'Input 200.0/s → Output 199.8/s · no gap',
			'Errors: none',
		]);
		expect(host.querySelector('.rpcn-metrics-summary')?.textContent).toBe(
			'Slowest: sleep pipeline.processors[2] · 99.6% of the pipeline\'s time · p50 5.17 ms · Input 200.0/s → Output 199.8/s · no gap · Errors: none');
		// It comes after the state line (none while live) and before the table; it is never announced.
		expect(host.querySelector('.rpcn-metrics-summary')?.getAttribute('role')).toBeNull();
		expect(host.querySelector('.rpcn-metrics-summary')?.nextElementSibling?.className).toBe('rpcn-metrics-scroll');
		expect(host.querySelector('[data-row="path:pipeline.processors[2]"] [data-column="share"]')?.textContent).toBe('99.6%');
		expect(host.querySelector('[data-row="path:input"] [data-column="share"]')?.textContent).toBe('—');
		const slow = host.querySelector('[data-row="path:pipeline.processors[2]"]')!;
		expect(slow.className).toBe('rpcn-metrics-slowest');
		expect(slow.querySelector('.rpcn-metrics-tag-slowest')?.textContent).toBe('slowest');
		const errs = host.querySelector('[data-row="label:fast"]')!;
		expect(errs.className).toBe('rpcn-metrics-errors');
		expect(errs.querySelector('.rpcn-metrics-tag-errors')?.textContent).toBe('errors');
		expect(host.querySelector('[data-row="path:input"]')?.className).toBe('');
		expect(host.querySelectorAll('.rpcn-metrics-tag')).toHaveLength(2);
		// The Component column is pinned: its header and every first cell.
		expect(host.querySelector('thead th')?.className).toBe('rpcn-metrics-pinned');
		expect([...host.querySelectorAll('tbody tr')].every((tr) => tr.querySelector('td')?.className === 'rpcn-metrics-pinned')).toBe(true);
		expect(host.querySelectorAll('.rpcn-metrics-pinned')).toHaveLength(4);
		// Errors, a gap, no slowest; no rates: no summary line.
		await send({ ...marked, summary: { slowest: null, inputRate: 200, outputRate: 150, gap: { rate: 50, share: 0.25 }, errors: [{ name: 'fast', rate: 2 }] } });
		expect(texts('.rpcn-metrics-summary-part')).toEqual(['Input 200.0/s → Output 150.0/s · gap 50.0/s (25%)', 'Errors: fast 2.0/s']);
		expect(host.querySelector('.rpcn-metrics-summary-errors')?.textContent).toBe('Errors: fast 2.0/s');
		expect(host.querySelector('[data-part="flow"]')?.className).toBe('rpcn-metrics-summary-part');
		await send({ ...marked, summary: null });
		expect(host.querySelector('.rpcn-metrics-summary')).toBeNull();
		await send({ ...marked, summary: undefined });
		expect(host.querySelector('.rpcn-metrics-summary')).toBeNull();
		// Sorting by Share asks the host.
		const shareButton = [...host.querySelectorAll<HTMLButtonElement>('thead button')].find((b) => b.textContent === 'Share')!;
		expect(shareButton.title).toContain('pipeline\'s time');
		await act(async () => shareButton.click());
		expect(posted.at(-1)).toEqual({ type: 'sort', sort: { column: 'share', dir: 'asc' } });
	});

	it('shows the state lines', async () => {
		await send({ ...SHOW, port: null, rows: [], state: { kind: 'notRunning' } });
		expect(host.querySelector('.rpcn-metrics-state')?.textContent).toBe('a.yaml is not running. Run this file to see its metrics.');
		expect(host.querySelector('.rpcn-metrics-address')).toBeNull();
		await send({ ...SHOW, port: null, state: { kind: 'stopped' } });
		expect(host.querySelector('.rpcn-metrics-state')?.textContent).toBe(STOPPED_TEXT);
		expect(host.querySelectorAll('tbody tr')).toHaveLength(5);
		await send({ ...SHOW, rows: [], state: { kind: 'notServed', reason: "this config's `metrics` section is `none`." } });
		expect(host.querySelector('.rpcn-metrics-state')?.textContent).toBe("No metrics served: this config's `metrics` section is `none`.");
		expect(host.querySelector('.rpcn-metrics-state')?.getAttribute('role')).toBe('alert');
		await send({ ...SHOW, rows: [], state: { kind: 'waiting' } });
		expect(host.querySelector('.rpcn-metrics-state')?.textContent).toBe('Waiting for the first reading of 127.0.0.1:41873…');
		await send({ ...SHOW, state: { kind: 'unreachable', message: '127.0.0.1:41873: connection refused' } });
		expect(host.querySelector('.rpcn-metrics-state')?.textContent).toBe("Can't read the metrics: 127.0.0.1:41873: connection refused. Trying again.");
	});

	it('ticket 7.5: a Cloud pipeline\'s header (board 3): the source, the endpoint host, the mapped file and the interval', async () => {
		const cloud: MetricsHostMessage = {
			...SHOW, source: 'Cloud · rpc-vilnius · orders', file: 'orders.yaml', port: null, intervalMs: 10_000, cloud: { host: 'prom.example.cloud:443' },
		};
		await send(cloud);
		expect(host.querySelector('h1')?.textContent).toBe('Cloud · rpc-vilnius · orders');
		expect(host.querySelector('.rpcn-metrics-address')?.textContent).toBe('prom.example.cloud:443 · mapped to orders.yaml · read every 10 s');
		expect(host.querySelectorAll('tbody tr')).toHaveLength(5);
		await send({ ...cloud, file: null });
		expect(host.querySelector('.rpcn-metrics-address')?.textContent).toBe(`prom.example.cloud:443 · ${NOT_MAPPED_TEXT} · read every 10 s`);
		await send({ ...cloud, rows: [], state: { kind: 'waiting' } });
		expect(host.querySelector('.rpcn-metrics-state')?.textContent).toBe('Waiting for the first reading of prom.example.cloud:443…');
	});

	it('ticket 7.5: the no-access and refused states name the cluster and say what to do', async () => {
		const cloud = { ...SHOW, source: 'Cloud · rpc-vilnius · orders', port: null, rows: [], cloud: { host: 'prom.example.cloud' } };
		await send({ ...cloud, state: { kind: 'noAccess', cluster: 'rpc-vilnius' } });
		const state = () => host.querySelector('.rpcn-metrics-state');
		expect(state()?.textContent).toBe(noMetricsAccessText('rpc-vilnius'));
		expect(noMetricsAccessText('rpc-vilnius')).toBe('No metrics access is held for rpc-vilnius. Connect to Redpanda Cloud, or use Set up metrics access… on its row in the Cloud view; the figures are read once it is set.');
		expect(state()?.textContent).toContain('Set up metrics access…');
		expect(state()?.className).toContain('rpcn-metrics-state-noAccess');
		expect(state()?.getAttribute('role')).toBe('status');
		const message = 'prom.example.cloud refused: the user or password is wrong (HTTP 401)';
		await send({ ...cloud, state: { kind: 'refused', cluster: 'rpc-vilnius', message } });
		expect(state()?.textContent).toBe(refusedText('rpc-vilnius', message));
		expect(state()?.textContent).toContain('the user or password is wrong');
		expect(state()?.className).toContain('rpcn-metrics-state-refused');
		expect(state()?.getAttribute('role')).toBe('alert');
		expect(host.querySelector('.rpcn-metrics-dot-refused')).not.toBeNull();
	});

	it('asks the host to sort on a header click and marks the sorted column', async () => {
		await send(SHOW);
		const p50 = () => [...host.querySelectorAll<HTMLButtonElement>('thead button')][8];
		await act(async () => p50().click());
		expect(posted.at(-1)).toEqual({ type: 'sort', sort: { column: 'p50', dir: 'asc' } });
		await send({ ...SHOW, sort: { column: 'p50', dir: 'asc' } });
		expect(host.querySelectorAll('thead th')[8].getAttribute('aria-sort')).toBe('ascending');
		await act(async () => p50().click());
		expect(posted.at(-1)).toEqual({ type: 'sort', sort: { column: 'p50', dir: 'desc' } });
		await send({ ...SHOW, sort: { column: 'p50', dir: 'desc' } });
		await act(async () => p50().click());
		expect(posted.at(-1)).toEqual({ type: 'sort', sort: null });
	});

	it('ticket 7.6: the window control asks the host for a window and shows the chosen one; the footer names it', async () => {
		await send(SHOW);
		const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('.rpcn-metrics-window button')];
		expect(buttons().map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['1 min', 'false'], ['5 min', 'true'], ['15 min', 'false']]);
		expect(host.querySelector('footer')?.textContent).toBe('Figures over the last 5 minutes · readings kept only while this tab is open');
		await act(async () => buttons()[0].click());
		expect(posted.at(-1)).toEqual({ type: 'window', minutes: 1 });
		await send({ ...SHOW, windowMinutes: 1 });
		expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
		expect(host.querySelector('footer')?.textContent).toBe(keptText(1));
		expect(keptText(1)).toBe('Figures over the last 1 minute · readings kept only while this tab is open');
		await act(async () => buttons()[2].click());
		expect(posted.at(-1)).toEqual({ type: 'window', minutes: 15 });
	});

	it('ignores malformed messages', async () => {
		await send(SHOW);
		await send({ ...SHOW, rows: [{ id: 'x' }] });
		await send({ ...SHOW, state: { kind: 'odd' } });
		await send({ type: 'other' });
		await send({ ...SHOW, windowMinutes: 2 });
		await send({ ...SHOW, rows: [row('a', { trend: [1, NaN] })] });
		expect(host.querySelectorAll('tbody tr')).toHaveLength(5);
	});
});

describe('metricsProtocol texts and validators', () => {
	it('formats rates and nanoseconds', () => {
		expect(formatRate(null)).toBe('—');
		expect(formatRate(0)).toBe('0.0');
		expect(formatRate(12.345)).toBe('12.3');
		expect(formatRate(123_456.7)).toBe('123,457');
		expect(formatNs(null)).toBe('—');
		expect(formatNs(360)).toBe('360 ns');
		expect(formatNs(4_700)).toBe('4.70 µs');
		expect(formatNs(10_700)).toBe('10.7 µs');
		expect(formatNs(5_150_000)).toBe('5.15 ms');
		expect(formatNs(250_000_000)).toBe('250 ms');
		expect(formatNs(2.5e9)).toBe('2.50 s');
		expect(formatShare(null)).toBe('—');
		expect(formatShare(0)).toBe('0.0%');
		expect(formatShare(0.12345)).toBe('12.3%');
		expect(trendText([])).toBe('Out/s over the window: no trend yet');
		expect(trendText([3, 1, 2])).toBe('Out/s over the window: from 1.0 to 3.0');
		expect(addressText(1234, 10_000)).toBe('127.0.0.1:1234 · read every 10 s');
		expect(cloudSourceLabel('rpc-vilnius', 'orders')).toBe('Cloud · rpc-vilnius · orders');
		expect(cloudAddressText('h:443', 'a.yaml', 10_000)).toBe('h:443 · mapped to a.yaml · read every 10 s');
		expect(cloudAddressText('h:443', null, 10_000)).toBe('h:443 · not mapped to a file · read every 10 s');
		expect(stateText({ kind: 'waiting' }, null, null, 'h:443')).toBe('Waiting for the first reading of h:443…');
		expect(stateText({ kind: 'waiting' }, null, 41873)).toBe('Waiting for the first reading of 127.0.0.1:41873…');
	});

	it('ticket 7.6: the trend is scaled to its own min and max, flat when constant', () => {
		expect(trendPoints([])).toBe('');
		const ys = (points: string) => points.split(' ').map((p) => Number(p.split(',')[1]));
		expect(ys(trendPoints([5, 5, 5]))).toEqual([TREND_HEIGHT / 2, TREND_HEIGHT / 2, TREND_HEIGHT / 2]);
		expect(ys(trendPoints([7]))).toEqual([TREND_HEIGHT / 2, TREND_HEIGHT / 2]);
		const [low, high] = ys(trendPoints([0, 10]));
		expect(low).toBeGreaterThan(high);
		expect(low).toBe(TREND_HEIGHT - 1);
		expect(high).toBe(1);
	});

	it('cycles the sort', () => {
		expect(nextSort(null, 'in')).toEqual({ column: 'in', dir: 'asc' });
		expect(nextSort({ column: 'in', dir: 'asc' }, 'in')).toEqual({ column: 'in', dir: 'desc' });
		expect(nextSort({ column: 'in', dir: 'desc' }, 'in')).toBeNull();
		expect(nextSort({ column: 'in', dir: 'desc' }, 'p99')).toEqual({ column: 'p99', dir: 'asc' });
	});

	it('ticket 7.7: the summary texts and the band', () => {
		const base: MetricsSummary = { slowest: null, inputRate: 200, outputRate: 200, gap: null, errors: [] };
		expect(slowestText({ name: 'sleep', path: 'pipeline.processors[2]', share: 0.996, p50: 5_170_000 }))
			.toBe('Slowest: sleep pipeline.processors[2] · 99.6% of the pipeline\'s time · p50 5.17 ms');
		expect(slowestText({ name: 'x', path: '', share: 0.5, p50: null })).toBe('Slowest: x · 50.0% of the pipeline\'s time · p50 —');
		expect(flowText(base)).toBe('Input 200.0/s → Output 200.0/s · no gap');
		expect(flowText({ ...base, outputRate: 150, gap: { rate: 50, share: 0.25 } })).toBe('Input 200.0/s → Output 150.0/s · gap 50.0/s (25%)');
		expect(flowText({ ...base, outputRate: 250, gap: { rate: -50, share: -0.25 } })).toBe('Input 200.0/s → Output 250.0/s · gap 50.0/s (25%)');
		expect(flowText({ ...base, inputRate: 0, outputRate: 5, gap: { rate: -5, share: null } })).toBe('Input 0.0/s → Output 5.0/s · gap 5.0/s');
		expect(flowText({ ...base, outputRate: null })).toBe('Input 200.0/s');
		expect(flowText({ ...base, inputRate: null })).toBeUndefined();
		expect(errorsText(base)).toBe('Errors: none');
		expect(errorsText({ ...base, errors: [{ name: 'a', rate: 1 }, { name: 'b', rate: 0.5 }] })).toBe('Errors: a 1.0/s, b 0.5/s');
		expect(summaryParts({ ...base, inputRate: null })).toEqual(['Errors: none']);
		expect(summaryParts({ ...base, outputRate: null })).toEqual(['Input 200.0/s', 'Errors: none']);
		expect(slowestBandText(0.996)).toBe('SLOWEST · 99.6% of the time');
	});

	it('checks host messages and copies webview messages', () => {
		expect(parseMetricsHostMessage(SHOW)).toBe(SHOW);
		expect(parseMetricsHostMessage({ ...SHOW, port: 70_000 })).toBeUndefined();
		expect(parseMetricsHostMessage({ ...SHOW, intervalMs: 0 })).toBeUndefined();
		expect(parseMetricsHostMessage({ ...SHOW, rows: [row('a', { inRate: Infinity })] })).toBeUndefined();
		expect(parseMetricsHostMessage({ ...SHOW, sort: { column: 'odd', dir: 'asc' } })).toBeUndefined();
		// Ticket 7.5: the Cloud address and the new states.
		const cloud = { ...SHOW, port: null, cloud: { host: 'h' } };
		expect(parseMetricsHostMessage(cloud)).toBe(cloud);
		expect(parseMetricsHostMessage({ ...SHOW, cloud: null })).toBeDefined();
		expect(parseMetricsHostMessage({ ...SHOW, cloud: { host: '' } })).toBeUndefined();
		expect(parseMetricsHostMessage({ ...SHOW, cloud: 'h' })).toBeUndefined();
		expect(parseMetricsHostMessage({ ...SHOW, state: { kind: 'noAccess', cluster: 'c' } })).toBeDefined();
		expect(parseMetricsHostMessage({ ...SHOW, state: { kind: 'noAccess' } })).toBeUndefined();
		expect(parseMetricsHostMessage({ ...SHOW, state: { kind: 'refused', cluster: 'c', message: 'm' } })).toBeDefined();
		expect(parseMetricsHostMessage({ ...SHOW, state: { kind: 'refused', cluster: 'c' } })).toBeUndefined();
		expect(parseMetricsWebviewMessage({ type: 'ready', extra: 1 })).toEqual({ type: 'ready' });
		expect(parseMetricsWebviewMessage({ type: 'sort', sort: { column: 'p50', dir: 'desc', x: 1 } })).toEqual({ type: 'sort', sort: { column: 'p50', dir: 'desc' } });
		expect(parseMetricsWebviewMessage({ type: 'sort', sort: null })).toEqual({ type: 'sort', sort: null });
		expect(parseMetricsWebviewMessage({ type: 'sort', sort: { column: 'p50', dir: 'up' } })).toBeUndefined();
		expect(parseMetricsWebviewMessage('ready')).toBeUndefined();
		// Ticket 7.6: the window message and the show's window.
		expect(parseMetricsWebviewMessage({ type: 'window', minutes: 15, x: 1 })).toEqual({ type: 'window', minutes: 15 });
		expect(parseMetricsWebviewMessage({ type: 'window', minutes: 3 })).toBeUndefined();
		expect(parseMetricsWebviewMessage({ type: 'window', minutes: '5' })).toBeUndefined();
		expect(parseMetricsHostMessage({ ...SHOW, windowMinutes: undefined })).toBeUndefined();
		expect(parseMetricsWebviewMessage({ type: 'sort', sort: { column: 'mean', dir: 'asc' } })).toEqual({ type: 'sort', sort: { column: 'mean', dir: 'asc' } });
		// Ticket 7.7: the row marks, the Share sort and the summary.
		expect(parseMetricsWebviewMessage({ type: 'sort', sort: { column: 'share', dir: 'desc' } })).toEqual({ type: 'sort', sort: { column: 'share', dir: 'desc' } });
		expect(parseMetricsHostMessage({ ...SHOW, rows: [row('a', { share: 0.5, slowest: true, hasErrors: true })] })).toBeDefined();
		expect(parseMetricsHostMessage({ ...SHOW, rows: [{ ...row('a'), slowest: undefined }] })).toBeUndefined();
		expect(parseMetricsHostMessage({ ...SHOW, rows: [row('a', { share: NaN })] })).toBeUndefined();
		const summary: MetricsSummary = { slowest: { name: 's', path: 'p', share: 1, p50: null }, inputRate: 1, outputRate: null, gap: null, errors: [{ name: 'e', rate: 1 }] };
		expect(parseMetricsHostMessage({ ...SHOW, summary })).toBeDefined();
		expect(parseMetricsHostMessage({ ...SHOW, summary: null })).toBeDefined();
		expect(parseMetricsHostMessage({ ...SHOW, summary: { ...summary, errors: [{ name: 'e' }] } })).toBeUndefined();
		expect(parseMetricsHostMessage({ ...SHOW, summary: { ...summary, slowest: { name: 's' } } })).toBeUndefined();
		expect(parseMetricsHostMessage({ ...SHOW, summary: { ...summary, gap: { rate: 'x', share: null } } })).toBeUndefined();
		expect(parseMetricsHostMessage({ ...SHOW, summary: 'x' })).toBeUndefined();
	});
});
