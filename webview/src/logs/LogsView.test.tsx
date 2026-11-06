// @vitest-environment happy-dom
// The Pipeline Logs tab's view (tickets 6.2, 6.3) in happy-dom: it posts `ready`, names the pipeline in
// its header, shows each row's local time, level, message with its further fields after it, and
// instance, a non-JSON value as text, appends live rows at the bottom, keeps at most the cap (the oldest
// dropped) with the footer's count, and ignores malformed messages. Ticket 6.3: the time-range menu
// (its choices, Custom range's checks, the retention line asked for once), the Live toggle, Load older
// records (prepended rows, the newest dropped at the cap, "No older records"), the gap notes and an
// empty range's note. Ticket 6.4: the level chips and their counts, the search box (debounced, Match
// case, regular expression, an invalid one refused at the box), highlighted matches, field chips from a
// record's values, "N of M records match", "No records match", and a record's JSON (Copy JSON, Show
// records around this one). Ticket 6.5: the ERROR records highlighted, the record around the error
// scrolled to once and marked, the "No ERROR record in the last 24 hours" note, and a state without
// those fields refused.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	customRangeError, gapsIn, localMinute, NO_COUNTS, NO_FILTER, parseLocalDateTime, parseLogsWebviewMessage, searchError, searchPattern,
	type LogFilter, type LogRow, type LogsHostMessage, type LogsViewState, type LogsWebviewMessage,
} from '../../../src/shared/logsProtocol';
import {
	chipText, footerText, highlightParts, LOADING_OLDER_TEXT, localTime, LogsView, matchText, NO_MATCH_TEXT, NO_OLDER_TEXT, NO_PIPELINE_TITLE, NO_RECORDS_TEXT,
	rangeButtonText, SEARCH_DEBOUNCE_MS,
} from './LogsView';

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
const STATE: LogsViewState = {
	range: { kind: 'recent', from: T0 - 15 * MIN, to: null }, live: true, done: false, older: 'more', olderError: null, olderNote: null, newerDropped: 0, retention: null, deployedAt: null,
	olderBefore: T0 - 15 * MIN, filter: NO_FILTER, counts: NO_COUNTS, highlightErrors: false, focusId: null, note: null,
};
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
		await show([row(10), row(11)], { olderBefore: T0 + 10_000 }, { cap: 3 });
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

describe('Pipeline Logs filter and search (ticket 6.4)', () => {
	const counts = (levels: Partial<LogsViewState['counts']['levels']>, total: number, matched: number): LogsViewState['counts'] =>
		({ levels: { ...NO_COUNTS.levels, ...levels }, total, matched });
	const show = async (rows: LogRow[], extra: Partial<LogsViewState> = {}) =>
		send({ type: 'show', title: 'orders · rpc-vilnius', rows, dropped: 0, cap: 5000, status: '', state: state(extra) });
	const chips = () => [...host.querySelectorAll('.rpcn-logs-level-chip')].map((c) => [c.getAttribute('data-level'), c.textContent, c.getAttribute('aria-pressed')]);
	const filters = () => posted.filter((m): m is Extract<LogsWebviewMessage, { type: 'filterChanged' }> => m.type === 'filterChanged').map((m) => m.filter);
	const box = () => host.querySelector<HTMLInputElement>('.rpcn-logs-search-input')!;
	const marks = () => [...host.querySelectorAll('mark')].map((m) => m.textContent);

	it('LEVELS: a chip per level with its count; turning one off posts the filter at once; "N of M records match"; all off: "No records match"', async () => {
		await show([row(1)], { counts: counts({ error: 2, warn: 3, info: 19_960, other: 1 }, 19_966, 19_966) });
		expect(chips()).toEqual([
			['error', 'Error 2', 'true'], ['warn', 'Warn 3', 'true'], ['info', 'Info 19,960', 'true'], ['debug', 'Debug 0', 'true'], ['other', 'Other 1', 'true'],
		]);
		expect(host.querySelector('.rpcn-logs-match-count')).toBeNull();
		await click(host.querySelector('[data-level="info"]'));
		expect(filters().at(-1)).toEqual({ ...NO_FILTER, levels: ['error', 'warn', 'debug', 'other'] });
		await send({ type: 'show', title: 'orders · rpc-vilnius', rows: [], dropped: 0, cap: 5000, status: '', state: state({ filter: filters().at(-1)!, counts: counts({ error: 2, warn: 3, info: 19_960, other: 1 }, 19_966, 6) }) });
		expect(chips()[2]).toEqual(['info', 'Info 19,960', 'false']);
		expect(host.querySelector('.rpcn-logs-match-count')?.textContent).toBe('6 of 19,966 records match');
		expect(matchText(40, 20_000)).toBe('40 of 20,000 records match');
		await send({ type: 'show', title: 'orders · rpc-vilnius', rows: [], dropped: 0, cap: 5000, status: '', state: state({ filter: { ...NO_FILTER, levels: [] }, counts: counts({ info: 4 }, 4, 0), done: true }) });
		expect(host.querySelector('.rpcn-logs-empty')?.textContent).toBe(NO_MATCH_TEXT);
	});

	it('SEARCH: posted once typing pauses; the applied search\'s matches highlighted in the message, the level, the instance and fields (case-insensitive)', async () => {
		vi.useFakeTimers();
		try {
			await show([row(1, { message: 'a Secret here', fields: [['note', 'top secret']] }), row(2)]);
			await type(box(), 's');
			await type(box(), 'secret');
			expect(filters()).toEqual([]);
			await act(async () => {
				vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
			});
			expect(filters()).toEqual([{ ...NO_FILTER, text: 'secret' }]);
			await send({ type: 'state', state: state({ filter: { ...NO_FILTER, text: 'secret' } }) });
			expect(marks()).toEqual(['Secret', 'secret']);
			expect(messages()[0]).toBe('a Secret here note=top secret');
			expect(box().value).toBe('secret');
		} finally {
			vi.useRealTimers();
		}
	});

	it('CASE_REGEX: Match case and .* post at once; an invalid regular expression is refused at the box with its error and nothing is posted', async () => {
		await show([row(1, { message: 'job failed' }), row(2, { message: 'will fail' })]);
		await type(box(), 'fail(ed)?');
		await click(button('rpcn-logs-regex'));
		expect(filters().at(-1)).toEqual({ ...NO_FILTER, text: 'fail(ed)?', regex: true });
		await click(button('rpcn-logs-match-case'));
		expect(filters().at(-1)).toEqual({ ...NO_FILTER, text: 'fail(ed)?', regex: true, matchCase: true });
		await send({ type: 'state', state: state({ filter: filters().at(-1)! }) });
		expect(marks()).toEqual(['failed', 'fail']);
		const count = filters().length;
		await type(box(), '(');
		await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 50));
		expect(host.querySelector('.rpcn-logs-search-error')?.textContent).toBe(searchError({ text: '(', matchCase: true, regex: true }));
		expect(box().getAttribute('aria-invalid')).toBe('true');
		await click(host.querySelector('[data-level="debug"]'));
		expect(filters().length, 'nothing posted while the search is refused').toBe(count);
		expect(parseLogsWebviewMessage({ type: 'filterChanged', filter: { ...NO_FILTER, text: '(', regex: true } })).toBeUndefined();
	});

	it('FIELD_FILTER: clicking an instance or a field\'s value makes a chip ("instance …c1gjg"); × removes it', async () => {
		await show([row(1, { instance: 'd3ugjmtpsedhm3e7c1gjg', fields: [['path', '/config/connect.yaml']] })]);
		await click(host.querySelector('.rpcn-logs-instance .rpcn-logs-value'));
		expect(filters().at(-1)).toEqual({ ...NO_FILTER, fields: [['instance_id', 'd3ugjmtpsedhm3e7c1gjg']] });
		expect(host.querySelector('.rpcn-logs-field-chip')?.textContent).toBe('instance …c1gjg×');
		await click(host.querySelector('.rpcn-logs-message .rpcn-logs-value'));
		expect(filters().at(-1)?.fields).toEqual([['instance_id', 'd3ugjmtpsedhm3e7c1gjg'], ['path', '/config/connect.yaml']]);
		await click(host.querySelector('.rpcn-logs-message .rpcn-logs-value'));
		expect(filters().at(-1)?.fields, 'a chip once').toHaveLength(2);
		await click(host.querySelector('.rpcn-logs-chip-remove'));
		expect(filters().at(-1)?.fields).toEqual([['path', '/config/connect.yaml']]);
		expect(chipText('path', 'x'.repeat(30))).toBe(`path=${'x'.repeat(23)}…`);
		expect(chipText('instance_id', 'inst-1')).toBe('instance inst-1');
	});

	it('SWITCH: a show with another filter than the one posted (cleared by the host) replaces the box and the chips', async () => {
		const filter: LogFilter = { ...NO_FILTER, text: 'x', fields: [['path', 'p']] };
		await show([row(1)], { filter });
		expect(box().value).toBe('x');
		expect(host.querySelectorAll('.rpcn-logs-field-chip')).toHaveLength(1);
		await show([row(9)]);
		expect(box().value).toBe('');
		expect(host.querySelectorAll('.rpcn-logs-field-chip')).toHaveLength(0);
	});

	it('SWITCH: a search still waiting on its timer is dropped when another pipeline is shown, never posted to it', async () => {
		vi.useFakeTimers();
		try {
			await show([row(1)]);
			await type(box(), 'pending');
			await send({ type: 'show', title: 'clicks · rpc-vilnius', rows: [], dropped: 0, cap: 5000, status: '', state: STATE });
			await act(async () => {
				vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
			});
			expect(filters()).toEqual([]);
			expect(box().value).toBe('');
		} finally {
			vi.useRealTimers();
		}
	});

	it('LEVELS: the chip\'s name is its own element (a hidden level strikes it through, not the count); LOAD_OLDER: how far a filtered Load older searched', async () => {
		await show([row(1)], { filter: { ...NO_FILTER, levels: ['error'] }, olderNote: 'No matches back to 2026-11-04 09:00; Load older to search further' });
		const info = host.querySelector('[data-level="info"]')!;
		expect(info.querySelector('.rpcn-logs-level-label')?.textContent).toBe('Info');
		expect(info.querySelector('.rpcn-logs-count')?.textContent).toBe('0');
		expect(host.querySelector('.rpcn-logs-older-note')?.textContent).toBe('No matches back to 2026-11-04 09:00; Load older to search further');
	});

	it('JSON: ▸ expands a record in place with its whole JSON; Copy JSON writes it to the clipboard, else asks the host; Show records around this one posts its id', async () => {
		const json = JSON.stringify({ level: 'INFO', message: 'message 1', n: 7 }, null, 2);
		await show([row(1, { json }), row(2, { raw: true, level: '', message: 'plain' })]);
		const expand = host.querySelector<HTMLButtonElement>('tbody tr[data-id="0:1"] .rpcn-logs-expand')!;
		expect(expand.getAttribute('aria-expanded')).toBe('false');
		await click(expand);
		expect(host.querySelector('.rpcn-logs-json')?.textContent).toBe(json);
		expect(cells()[0][0], 'the time cell keeps its text').toBe('2026-11-05 09:04:06.007');
		const written: string[] = [];
		const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => { written.push(t); } } });
		try {
			await click(button('rpcn-logs-copy'));
			expect(written).toEqual([json]);
			expect(host.querySelector('.rpcn-logs-copied')?.textContent).toBe('Copied.');
			Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
			await click(button('rpcn-logs-copy'));
			expect(posted.at(-1)).toEqual({ type: 'copyRequested', id: '0:1' });
		} finally {
			if (clipboard) {
				Object.defineProperty(navigator, 'clipboard', clipboard);
			} else {
				delete (navigator as { clipboard?: unknown }).clipboard;
			}
		}
		await click(button('rpcn-logs-around'));
		expect(posted.at(-1)).toEqual({ type: 'aroundRequested', id: '0:1' });
		expect(host.querySelector('.rpcn-logs-json')).toBeNull();
		await click(host.querySelector('tbody tr[data-id="0:2"] .rpcn-logs-expand'));
		expect(host.querySelector('.rpcn-logs-json')?.textContent, 'a non-JSON value: its text').toBe('plain');
	});

	it('highlightParts and searchPattern: plain text escaped, case-insensitive unless Match case; empty matches skipped', () => {
		const re = searchPattern('a.b', false, false, true) as RegExp;
		expect(highlightParts('xA.Bya.bz aXb', re)).toEqual([{ text: 'x', match: false }, { text: 'A.B', match: true }, { text: 'y', match: false }, { text: 'a.b', match: true }, { text: 'z aXb', match: false }]);
		expect(highlightParts('abc', searchPattern('.*', true, true, true) as RegExp)).toEqual([{ text: 'abc', match: true }]);
		expect(highlightParts('abc', searchPattern('x*', true, true, true) as RegExp)).toEqual([{ text: 'abc', match: false }]);
		expect(searchPattern('', false, false)).toBeUndefined();
		expect(searchError({ text: '(', matchCase: false, regex: false })).toBeUndefined();
		expect(searchError({ text: '(', matchCase: false, regex: true })).toMatch(/Invalid regular expression/);
	});
});

describe('Pipeline Logs entry points (ticket 6.5)', () => {
	const show = async (rows: LogRow[], extra: Partial<LogsViewState> = {}) =>
		send({ type: 'show', title: 'orders · rpc-vilnius', rows, dropped: 0, cap: 5000, status: '', state: state(extra) });
	const rowEl = (id: string) => host.querySelector<HTMLTableRowElement>(`tbody tr[data-id="${id}"]`)!;
	const rows = () => [row(1), row(2, { level: 'ERROR' }), row(3, { level: 'fatal' }), row(4, { level: 'WARN' })];

	it('HIGHLIGHT: with highlightErrors the ERROR-level rows are highlighted (ERROR, FATAL…), others not; without it none', async () => {
		await show(rows(), { highlightErrors: true });
		expect(['0:1', '0:2', '0:3', '0:4'].map((id) => rowEl(id).classList.contains('rpcn-logs-error-row'))).toEqual([false, true, true, false]);
		await show(rows());
		expect(host.querySelectorAll('.rpcn-logs-error-row').length).toBe(0);
	});

	it('AROUND: the focused row is marked and scrolled to once (when it arrives); a later batch does not scroll again', async () => {
		const scrolled: string[] = [];
		const original = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = function (this: Element) {
			scrolled.push((this as HTMLElement).dataset.id ?? '');
		};
		try {
			// The range is read: the focused row arrives in a later batch.
			await show([row(1)], { highlightErrors: true, focusId: '0:3', range: { kind: 'custom', from: T0 - 5 * MIN, to: T0 + 5 * MIN } });
			expect(scrolled).toEqual([]);
			await send({ type: 'append', rows: [row(2), row(3, { level: 'ERROR' })], dropped: 0 });
			expect(scrolled).toEqual(['0:3']);
			expect(rowEl('0:3').classList.contains('rpcn-logs-focus')).toBe(true);
			expect(rowEl('0:3').getAttribute('aria-current')).toBe('true');
			expect(rowEl('0:3').classList.contains('rpcn-logs-error-row')).toBe(true);
			expect(rowEl('0:2').classList.contains('rpcn-logs-focus')).toBe(false);
			await send({ type: 'append', rows: [row(4)], dropped: 0 });
			expect(scrolled, 'once').toEqual(['0:3']);
			// Another range: no mark.
			await show([row(3)], { focusId: null });
			expect(host.querySelectorAll('.rpcn-logs-focus').length).toBe(0);
		} finally {
			Element.prototype.scrollIntoView = original;
		}
	});

	it('NO_ERROR: the note above the records', async () => {
		await show([row(1)], { note: 'No ERROR record in the last 24 hours', highlightErrors: true });
		expect(host.querySelector('.rpcn-logs-note')?.textContent).toBe('No ERROR record in the last 24 hours');
		await show([row(1)]);
		expect(host.querySelector('.rpcn-logs-note')).toBeNull();
	});

	it('a state without highlightErrors, focusId or note is refused', async () => {
		const { highlightErrors: _h, ...without } = state();
		await send({ type: 'show', title: 'refused', rows: [], dropped: 0, cap: 5000, status: '', state: without });
		expect(title()).toBe(NO_PIPELINE_TITLE);
		await send({ type: 'show', title: 'refused', rows: [], dropped: 0, cap: 5000, status: '', state: { ...state(), focusId: 3 } });
		expect(title()).toBe(NO_PIPELINE_TITLE);
	});
});
