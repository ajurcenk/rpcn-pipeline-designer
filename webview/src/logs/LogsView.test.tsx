// @vitest-environment happy-dom
// The Pipeline Logs tab's view (ticket 6.2) in happy-dom: it posts `ready`, names the pipeline in its
// header, shows each row's local time, level, message with its further fields after it, and instance,
// a non-JSON value as text, appends live rows at the bottom, keeps at most the cap (the oldest dropped)
// with the footer's count, and ignores malformed messages.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogRow, LogsHostMessage, LogsWebviewMessage } from '../../../src/shared/logsProtocol';
import { footerText, localTime, LogsView, NO_PIPELINE_TITLE, NO_RECORDS_TEXT } from './LogsView';

let host: HTMLDivElement;
let root: Root;
let posted: LogsWebviewMessage[];

const send = async (message: LogsHostMessage | Record<string, unknown>) => {
	await act(async () => {
		window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(JSON.stringify(message)) }));
	});
};

const T0 = new Date(2026, 10, 5, 9, 4, 5, 7).getTime();
const row = (n: number, extra: Partial<LogRow> = {}): LogRow => ({
	id: `0:${n}`, time: T0 + n * 1000, level: 'INFO', message: `message ${n}`, instance: 'inst-1', fields: [], ...extra,
});

const title = () => host.querySelector('.rpcn-logs-title')?.textContent;
const status = () => host.querySelector('.rpcn-logs-status')?.textContent;
const footer = () => host.querySelector('.rpcn-logs-footer')?.textContent ?? null;
const cells = () => [...host.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
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
		await send({ type: 'show', title: null, rows: [], dropped: 0, cap: 5000, status: 'Use Show logs on a pipeline in the Cloud view.' });
		expect(status()).toBe('Use Show logs on a pipeline in the Cloud view.');
		expect(host.querySelector('table')).toBeNull();
		expect(footer()).toBeNull();
	});

	it('SHOW: the header names "<pipeline> · <cluster>"; the rows oldest first: local time, level, message, instance', async () => {
		await send({ type: 'show', title: 'orders · rpc-vilnius', rows: [], dropped: 0, cap: 5000, status: 'Reading the last 15 minutes…' });
		expect(title()).toBe('orders · rpc-vilnius');
		expect(host.textContent).toContain(NO_RECORDS_TEXT);
		await send({ type: 'show', title: 'orders · rpc-vilnius', rows: [row(1), row(2, { level: 'WARN' })], dropped: 0, cap: 5000, status: 'Following new records.' });
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
			type: 'show', title: 'orders · rpc-vilnius', dropped: 0, cap: 5000, status: '',
			rows: [row(1, { fields: [['path', '/config/connect.yaml'], ['probe_n', '7']] }), row(2, { level: '', instance: '', message: 'plain text', raw: true })],
		});
		expect(messages()).toEqual(['message 1 path=/config/connect.yaml probe_n=7', 'plain text']);
		expect([...host.querySelectorAll('.rpcn-logs-key')].map((k) => k.textContent)).toEqual(['path', 'probe_n']);
		expect(host.querySelector('tbody tr:nth-child(2) .rpcn-logs-message')?.className).toContain('rpcn-logs-raw');
	});

	it('live: appended rows go at the bottom; CAP: at most the cap, the oldest dropped, the footer says how many are kept and dropped', async () => {
		await send({ type: 'show', title: 'orders · rpc-vilnius', rows: [row(1), row(2)], dropped: 0, cap: 3, status: '' });
		await send({ type: 'append', rows: [row(3)], dropped: 0 });
		expect(messages()).toEqual(['message 1', 'message 2', 'message 3']);
		await send({ type: 'append', rows: [row(4), row(5)], dropped: 2 });
		expect(messages()).toEqual(['message 3', 'message 4', 'message 5']);
		expect(footer()).toBe('3 records kept (at most 3); 2 older ones dropped.');
		expect(footerText(5000, 1, 5000)).toBe('5,000 records kept (at most 5,000); 1 older one dropped.');
		expect(footerText(1, 0, 5000)).toBe('1 record kept.');
	});

	it('SWITCH: a new show replaces the rows and the header; malformed messages are ignored', async () => {
		await send({ type: 'show', title: 'orders · rpc-vilnius', rows: [row(1)], dropped: 0, cap: 5000, status: '' });
		await send({ type: 'show', title: 'clicks · rpc-vilnius', rows: [row(9)], dropped: 0, cap: 5000, status: '' });
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
