// @vitest-environment happy-dom
// The Pipeline Logs tab's view (tickets 6.2, 6.3) in happy-dom: it posts `ready`, names the pipeline in
// its header, shows each row's local time, level, message with its further fields after it, and
// instance, a non-JSON value as text, appends live rows at the bottom, keeps at most the cap (the oldest
// dropped) with the footer's count, and ignores malformed messages. Ticket 6.3: the time-range menu
// (its choices, Custom range's checks, the retention line asked for once), the Live toggle, Load older
// records (prepended rows, the newest dropped at the cap, "No older records"), the gap notes and an
// empty range's note.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { customRangeError, gapsIn, localMinute, parseLocalDateTime, type LogRow, type LogsHostMessage, type LogsViewState, type LogsWebviewMessage } from '../../../src/shared/logsProtocol';
import { footerText, LOADING_OLDER_TEXT, localTime, LogsView, NO_OLDER_TEXT, NO_PIPELINE_TITLE, NO_RECORDS_TEXT, rangeButtonText } from './LogsView';

let host: HTMLDivElement;
let root: Root;
let posted: LogsWebviewMessage[];

const send = async (message: LogsHostMessage | Record<string, unknown>) => {
	await act(async () => {
		window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(JSON.stringify(message)) }));
	});
};

const T0 = new Date(2026, 10, 5, 9, 4, 5, 7).getTime();
const MIN = 60_000;
const STATE: LogsViewState = { range: { kind: 'recent', from: T0 - 15 * MIN, to: null }, live: true, done: false, older: 'more', olderError: null, newerDropped: 0, retention: null, deployedAt: null };
const state = (extra: Partial<LogsViewState> = {}): LogsViewState => ({ ...STATE, ...extra });
const row = (n: number, extra: Partial<LogRow> = {}): LogRow => ({
	id: `0:${n}`, time: T0 + n * 1000, level: 'INFO', message: `message ${n}`, instance: 'inst-1', fields: [], ...extra,
});

const title = () => host.querySelector('.rpcn-logs-title')?.textContent;
const status = () => host.querySelector('.rpcn-logs-status')?.textContent;
const footer = () => host.querySelector('.rpcn-logs-footer')?.textContent ?? null;
const cells = () => [...host.querySelectorAll('tbody tr[data-id]')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
const gapNotes = () => [...host.querySelectorAll('.rpcn-logs-gap')].map((g) => g.textContent);
const button = (cls: string) => host.querySelector<HTMLButtonElement>(`.${cls}`);
const click = async (el: Element | null) => {
	await act(async () => {
		(el as HTMLElement).click();
	});
};
const type = async (input: HTMLInputElement, value: string) => {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
		setter.call(input, value);
		input.dispatchEvent(new Event('input', { bubbles: true }));
	});
};
const messages = () => cells().map((c) => c[2]);

beforeEach(async () => {
	posted = [];
	host = document.createElement('div');
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root.render(<LogsView post={(m) => posted.push(m)} />);
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
});

describe('Pipeline Logs view (ticket 6.2)', () => {
	it('posts ready; before a pipeline is chosen: no pipeline, the host\'s hint, no table and no footer', async () => {
		expect(posted).toEqual([{ type: 'ready' }]);
		expect(title()).toBe(NO_PIPELINE_TITLE);
		await send({ type: 'show', title: null, rows: [], dropped: 0, cap: 5000, status: 'Use Show logs on a pipeline in the Cloud view.', state: STATE });
		expect(status()).toBe('Use Show logs on a pipeline in the Cloud view.');
		expect(host.querySelector('table')).toBeNull();
		expect(footer()).toBeNull();
	});

	it('SHOW: the header names "<pipeline> · <cluster>"; the rows oldest first: local time, level, message, instance', async () => {
		await send({ type: 'show', title: 'orders · rpc-vilnius', rows: [], dropped: 0, cap: 5000, status: 'Reading the last 15 minutes…', state: STATE });
		expect(title()).toBe('orders · rpc-vilnius');
		expect(host.textContent).toContain(NO_RECORDS_TEXT);
		await send({ type: 'show', title: 'orders · rpc-vilnius', rows: [row(1), row(2, { level: 'WARN' })], dropped: 0, cap: 5000, status: 'Following new records.', state: STATE });
		expect(cells()).toEqual([
			['2026-11-05 09:04:06.007', 'INFO', 'message 1', 'inst-1'],
			['2026-11-05 09:04:07.007', 'WARN', 'message 2', 'inst-1'],
		]);
		expect(host.querySelectorAll('th')[0].textContent).toBe('Time');
		expect(host.querySelector('tbody tr td:nth-child(2)')?.className).toBe('rpcn-logs-level');
		expect(host.querySelector('tbody tr:nth-child(2) td:nth-child(2)')?.className).toContain('rpcn-logs-warn');
		expect(status()).toBe('Following new records.');
		expect(footer()).toBe('2 records kept.');
	});

	it('RECORD: further fields after the message as key=value; a non-JSON value as its text', async () => {
		await send({
			type: 'show', title: 'orders · rpc-vilnius', dropped: 0, cap: 5000, status: '', state: STATE,
			rows: [row(1, { fields: [['path', '/config/connect.yaml'], ['probe_n', '7']] }), row(2, { level: '', instance: '', message: 'plain text', raw: true })],
		});
		expect(messages()).toEqual(['message 1 path=/config/connect.yaml probe_n=7', 'plain text']);
		expect([...host.querySelectorAll('.rpcn-logs-key')].map((k) => k.textContent)).toEqual(['path', 'probe_n']);
		expect(host.querySelector('tbody tr:nth-child(2) .rpcn-logs-message')?.className).toContain('rpcn-logs-raw');
	});

	it('live: appended rows go at the bottom; CAP: at most the cap, the oldest dropped, the footer says how many are kept and dropped', async () => {
		await send({ type: 'show', title: 'orders · rpc-vilnius', rows: [row(1), row(2)], dropped: 0, cap: 3, status: '', state: STATE });
		await send({ type: 'append', rows: [row(3)], dropped: 0 });
		expect(messages()).toEqual(['message 1', 'message 2', 'message 3']);
		await send({ type: 'append', rows: [row(4), row(5)], dropped: 2 });
		expect(messages()).toEqual(['message 3', 'message 4', 'message 5']);
		expect(footer()).toBe('3 records kept (at most 3); 2 older records left out; Load older to page back.');
		expect(footerText(5000, 1, 5000)).toBe('5,000 records kept (at most 5,000); 1 older record left out; Load older to page back.');
		expect(footerText(5000, 0, 5000, 12)).toBe('5,000 records kept (at most 5,000); 12 newer records dropped.');
		expect(footerText(1, 0, 5000)).toBe('1 record kept.');
	});

	it('SWITCH: a new show replaces the rows and the header; malformed messages are ignored', async () => {
		await send({ type: 'show', title: 'orders · rpc-vilnius', rows: [row(1)], dropped: 0, cap: 5000, status: '', state: STATE });
		await send({ type: 'show', title: 'clicks · rpc-vilnius', rows: [row(9)], dropped: 0, cap: 5000, status: '', state: STATE });
		expect(title()).toBe('clicks · rpc-vilnius');
		expect(messages()).toEqual(['message 9']);
		await send({ type: 'append', rows: [{ id: 1 }], dropped: 0 });
		await send({ type: 'nonsense' });
		expect(messages()).toEqual(['message 9']);
	});

	it('localTime is the viewer\'s local time, to the millisecond', () => {
		expect(localTime(new Date(2026, 0, 2, 3, 4, 5, 60).getTime())).toBe('2026-01-02 03:04:05.060');
	});
});

describe('Pipeline Logs history (ticket 6.3)', () => {
	const show = async (rows: LogRow[], extra: Partial<LogsViewState> = {}, more: Partial<{ dropped: number; cap: number }> = {}) =>
		send({ type: 'show', title: 'orders · rpc-vilnius', rows, dropped: more.dropped ?? 0, cap: more.cap ?? 5000, status: '', state: state(extra) });
	const options = () => [...host.querySelectorAll('[role="option"]')].map((o) => o.textContent);

	it('RANGE menu: the choices of board 5; choosing one posts it and closes the menu; the button names the range', async () => {
		await show([], { deployedAt: new Date(2026, 10, 5, 16, 28).getTime() });
		expect(button('rpcn-logs-range-button')?.textContent).toBe('Last 15 minutes, then live ▾');
		await click(button('rpcn-logs-range-button'));
		expect(options()).toEqual(['Live (from now on)', 'Last 15 minutes, then live', 'Last hour', 'Last 24 hours', 'Last 7 days', 'Since the last deploy (2026-11-05 16:28)', 'Custom range…']);
		expect(host.querySelector('[data-kind="recent"]')?.getAttribute('aria-selected')).toBe('true');
		await click(host.querySelector('[data-kind="day"]'));
		expect(posted.at(-1)).toEqual({ type: 'rangeChosen', range: { kind: 'day' } });
		expect(host.querySelector('.rpcn-logs-menu')).toBeNull();
		expect(rangeButtonText(state({ range: { kind: 'day', from: 0, to: 1 } }))).toBe('Last 24 hours');
		expect(rangeButtonText(state({ range: { kind: 'deploy', from: new Date(2026, 10, 5, 16, 28).getTime(), to: null } }))).toBe('Since the last deploy (2026-11-05 16:28)');
	});

	it('RETENTION: opening the menu asks for the retention once; its line is the host\'s text', async () => {
		await show([]);
		await click(button('rpcn-logs-range-button'));
		expect(posted.filter((m) => m.type === 'retentionRequested')).toHaveLength(1);
		await send({ type: 'state', state: state({ retention: 'Records older than 7 days are gone (the topic\'s retention).' }) });
		expect(host.querySelector('.rpcn-logs-retention')?.textContent).toBe('Records older than 7 days are gone (the topic\'s retention).');
		await click(button('rpcn-logs-range-button'));
		await click(button('rpcn-logs-range-button'));
		expect(posted.filter((m) => m.type === 'retentionRequested')).toHaveLength(1);
	});

	it('CUSTOM: From and To in local time; To before From, From in the future, or not a date is refused in the menu; a good range is posted', async () => {
		await show([]);
		await click(button('rpcn-logs-range-button'));
		await click(host.querySelector('[data-kind="custom"]'));
		const [from, to] = [...host.querySelectorAll<HTMLInputElement>('.rpcn-logs-custom input')];
		const submit = host.querySelector('.rpcn-logs-custom button')!;
		const count = posted.length;
		await type(from, '2026-11-04 09:00');
		await type(to, '2026-11-03 09:00');
		await click(submit);
		expect(host.querySelector('[role="alert"]')?.textContent).toBe('To is before From.');
		await type(to, 'yesterday');
		await click(submit);
		expect(host.querySelector('[role="alert"]')?.textContent).toBe('To is not a date and time (YYYY-MM-DD HH:MM).');
		await type(from, '2999-01-01 00:00');
		await type(to, '2999-01-02 00:00');
		await click(submit);
		expect(host.querySelector('[role="alert"]')?.textContent).toBe('From is in the future.');
		expect(posted.length).toBe(count);
		await type(from, '2026-11-04 09:00');
		await type(to, '2026-11-05 18:00');
		await click(submit);
		expect(posted.at(-1)).toEqual({ type: 'rangeChosen', range: { kind: 'custom', from: new Date(2026, 10, 4, 9, 0).getTime(), to: new Date(2026, 10, 5, 18, 0).getTime() } });
		expect(rangeButtonText(state({ range: { kind: 'custom', from: new Date(2026, 10, 4, 9, 0).getTime(), to: new Date(2026, 10, 5, 18, 0).getTime() } }))).toBe('2026-11-04 09:00 – 2026-11-05 18:00');
	});

	it('the Live toggle shows the state and posts the other one', async () => {
		await show([]);
		expect(button('rpcn-logs-live')?.getAttribute('aria-pressed')).toBe('true');
		await click(button('rpcn-logs-live'));
		expect(posted.at(-1)).toEqual({ type: 'liveToggled', live: false });
		await send({ type: 'state', state: state({ live: false }) });
		expect(button('rpcn-logs-live')?.getAttribute('aria-pressed')).toBe('false');
		await click(button('rpcn-logs-live'));
		expect(posted.at(-1)).toEqual({ type: 'liveToggled', live: true });
	});

	it('LOAD_OLDER: the button at the top posts the request; while reading it is disabled; older rows go before the shown ones, at most the cap (the newest dropped); then "No older records"', async () => {
		await show([row(10), row(11)], {}, { cap: 3 });
		expect(button('rpcn-logs-older-button')?.textContent).toBe(`Load older records (before ${localMinute(T0 + 10_000)})`);
		await click(button('rpcn-logs-older-button'));
		expect(posted.at(-1)).toEqual({ type: 'olderRequested' });
		await send({ type: 'state', state: state({ older: 'reading' }) });
		expect(button('rpcn-logs-older-button')?.textContent).toBe(LOADING_OLDER_TEXT);
		expect(button('rpcn-logs-older-button')?.disabled).toBe(true);
		await send({ type: 'prepend', rows: [row(8), row(9)], dropped: 0 });
		expect(messages()).toEqual(['message 8', 'message 9', 'message 10']);
		await send({ type: 'state', state: state({ older: 'none', newerDropped: 1 }) });
		expect(button('rpcn-logs-older-button')).toBeNull();
		expect(host.querySelector('.rpcn-logs-no-older')?.textContent).toBe(NO_OLDER_TEXT);
		expect(footer()).toBe('3 records kept (at most 3); 1 newer record dropped.');
	});

	it('LOAD_OLDER: disabled while a bounded range is still read; a failure shown in its row', async () => {
		const range = { kind: 'day' as const, from: T0 - 24 * 60 * MIN, to: T0 };
		await show([row(1)], { range, live: false, done: false });
		expect(button('rpcn-logs-older-button')?.disabled).toBe(true);
		await send({ type: 'state', state: state({ range, live: false, done: true, olderError: 'Could not load older records: connect ETIMEDOUT' }) });
		expect(button('rpcn-logs-older-button')?.disabled).toBe(false);
		expect(host.querySelector('.rpcn-logs-older-error')?.textContent).toBe('Could not load older records: connect ETIMEDOUT');
	});

	it('GAP: a note between two shown records 30 minutes or more apart; none closer; an empty read range says so in the list', async () => {
		const at = (n: number, minutes: number) => row(n, { time: T0 + minutes * MIN });
		await show([at(1, 0), at(2, 29), at(3, 59), at(4, 60)]);
		expect(gapNotes()).toEqual([`No records ${localMinute(T0 + 29 * MIN)} – ${localMinute(T0 + 59 * MIN)}`]);
		expect(gapsIn([{ time: 0 }, { time: 30 * MIN }, { time: 30 * MIN + 1 }])).toEqual([{ before: 1, from: 0, to: 30 * MIN }]);
		const range = { kind: 'custom' as const, from: T0 - 60 * MIN, to: T0 };
		await show([], { range, live: false, done: false });
		expect(host.textContent).toContain(NO_RECORDS_TEXT);
		await show([], { range, live: false, done: true });
		expect(gapNotes()).toEqual([`No records ${localMinute(T0 - 60 * MIN)} – ${localMinute(T0)}`]);
	});

	it('parseLocalDateTime and customRangeError: local YYYY-MM-DD HH:MM[:SS] or a date; a day that does not exist is refused', () => {
		expect(parseLocalDateTime('2026-11-04 09:30')).toBe(new Date(2026, 10, 4, 9, 30).getTime());
		expect(parseLocalDateTime('2026-11-04T09:30:15')).toBe(new Date(2026, 10, 4, 9, 30, 15).getTime());
		expect(parseLocalDateTime('2026-11-04')).toBe(new Date(2026, 10, 4).getTime());
		expect(parseLocalDateTime('2026-02-30 10:00')).toBeUndefined();
		expect(parseLocalDateTime('4 Nov')).toBeUndefined();
		const now = new Date(2026, 10, 5, 12, 0).getTime();
		expect(customRangeError('2026-11-05 13:00', '2026-11-05 14:00', now)).toBe('From is in the future.');
		expect(customRangeError('2026-11-05 10:00', '2026-11-05 14:00', now)).toBeUndefined();
		expect(customRangeError('x', '2026-11-05 14:00', now)).toBe('From is not a date and time (YYYY-MM-DD HH:MM).');
	});
});
