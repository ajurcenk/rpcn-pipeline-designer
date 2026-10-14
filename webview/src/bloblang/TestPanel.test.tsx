// @vitest-environment happy-dom
// The Bloblang test panel's view (tickets 4.2, 4.7) in happy-dom: it posts `ready`, shows the
// snapshot's title and kind, posts `run {content, meta}` on Run, or with Run on change after the
// pause, and shows each result: the output content with the changed fields marked, the output
// metadata, the "Changed:" tags and the status pill. The view state survives a reload.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BloblangHostMessage, BloblangWebviewMessage } from '../../../src/shared/bloblangProtocol';
import { DEFAULT_VIEW_STATE, type ViewState } from './host';
import {
	DELETED_TEXT, EMPTY_TEXT, ERROR_TEXT, FAILED_TEXT, RUN_DEBOUNCE_MS, RUNNING_TEXT, TestPanel,
} from './TestPanel';

let host: HTMLDivElement;
let root: Root;
let posted: BloblangWebviewMessage[];
let saved: ViewState[];

const send = async (message: BloblangHostMessage | Record<string, unknown>) => {
	await act(async () => {
		window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(JSON.stringify(message)) }));
	});
};

async function render(state: Partial<ViewState> = {}): Promise<void> {
	await act(async () => {
		root.render(<TestPanel post={(m) => posted.push(m)} initialState={{ ...DEFAULT_VIEW_STATE, ...state }} saveState={(s) => saved.push(s)} />);
	});
}

async function setValue(el: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
	await act(async () => {
		// React tracks the value through the native setter.
		const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text);
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
}

const type = (text: string) => setValue(host.querySelector('textarea')!, text);
const click = async (el: Element | null) => {
	expect(el).not.toBeNull();
	await act(async () => (el as HTMLElement).click());
};
const tab = (column: 'in' | 'out', which: 'content' | 'meta') => host.querySelector(`#rpcn-bl-${column}-tab-${which}`);
const badge = (column: 'in' | 'out') => tab(column, 'meta')?.querySelector('.rpcn-bl-badge')?.textContent;
const pill = () => host.querySelector('.rpcn-bl-pill')?.textContent;
const tags = () => [...host.querySelectorAll('.rpcn-bl-out .rpcn-bl-tag')].map((t) => t.textContent);
const footer = () => host.querySelector('.rpcn-bl-out .rpcn-bl-foot')?.textContent;
const outputText = () => host.querySelector('.rpcn-bl-output')?.textContent;
const markedText = () => [...host.querySelectorAll('.rpcn-bl-output .rpcn-bl-mark')].map((l) => l.textContent);
const wait = (ms = RUN_DEBOUNCE_MS) => act(async () => {
	vi.advanceTimersByTime(ms);
});

const OK_B2 = {
	kind: 'ok', content: '{"b":2}', meta: {},
	changes: { fields: { added: ['b'], changed: [], removed: ['a'] }, meta: { added: [], changed: [], removed: [] } },
} as const;

// happy-dom's import.meta.url is not a file URL: the fixtures resolve from the vitest root (the repository).
const FIXTURES = resolve(process.cwd(), 'src/test/fixtures/bloblang');
const FIXTURE_NAMES = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;

const runs = () => posted.filter((m) => m.type === 'run');
const SNAPSHOT: BloblangHostMessage = {
	type: 'snapshot', title: 'Bloblang: first', kind: 'mapping', source: 'root.b = this.a + 1', binary: 'ok', samples: [], selected: null,
};

describe('Bloblang test panel (4.2, 4.7)', () => {
	beforeEach(() => {
		posted = [];
		saved = [];
		host = document.createElement('div');
		document.body.appendChild(host);
		root = createRoot(host);
	});
	afterEach(async () => {
		vi.useRealTimers();
		await act(async () => root.unmount());
		host.remove();
	});

	it('posts ready, then shows the snapshot\'s title and kind; no Bloblang block; the layout\'s labels', async () => {
		await render();
		expect(posted).toEqual([{ type: 'ready' }]);
		await send(SNAPSHOT);
		expect(host.querySelector('h1')?.textContent).toBe('Bloblang: first');
		expect(host.querySelector('.rpcn-bl-kind')?.textContent).toBe('mapping');
		expect(host.querySelector('.rpcn-bl-source')).toBeNull();
		expect([...host.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Input', 'Output']);
		expect(tab('in', 'content')?.textContent).toBe('Content');
		expect(tab('in', 'meta')?.textContent).toBe('Metadata0');
		expect(badge('out')).toBe('–');
		expect(host.querySelector('.rpcn-bl-check')?.textContent).toBe('Run on change');
		expect(host.querySelector<HTMLInputElement>('.rpcn-bl-auto')!.checked).toBe(true);
		expect(host.querySelector('.rpcn-bl-run')?.textContent).toBe('Run');
		expect(host.textContent).toContain(EMPTY_TEXT);
		expect(pill()).toBeUndefined();
		expect(runs()).toEqual([]);
	});

	it('RUN_ON_CHANGE (content): typing runs once after the pause; the output, its tags and the status pill show', async () => {
		vi.useFakeTimers();
		await render();
		await send(SNAPSHOT);
		await type('{"a"');
		await type('{"a":1}');
		expect(saved[saved.length - 1].content).toBe('{"a":1}');
		await wait(RUN_DEBOUNCE_MS - 1);
		expect(runs()).toEqual([]);
		await wait(1);
		expect(runs()).toEqual([{ type: 'run', content: '{"a":1}', meta: {} }]);
		expect(pill()).toBe(RUNNING_TEXT);
		await send({ type: 'result', result: OK_B2, durationMs: 212.4, binary: 'rpk connect 4.112.0' });
		expect(outputText()).toBe('{\n  "b": 2\n}');
		expect(markedText()).toEqual(['  "b": 2']);
		expect(pill()).toBe('✓ Ran in 212 ms · rpk connect 4.112.0');
		expect(footer()).toBe('Changed:+b−a');
		expect(tags()).toEqual(['+b', '−a']);
		expect(badge('out')).toBe('0');
	});

	it('RUN_ON_CHANGE (mapping, metadata): a snapshot with another source runs once after the pause; the same source does not', async () => {
		vi.useFakeTimers();
		await render({ content: '{"a":1}' });
		await send(SNAPSHOT);
		expect(runs()).toHaveLength(1);
		await send(SNAPSHOT);
		await wait(RUN_DEBOUNCE_MS * 2);
		expect(runs()).toHaveLength(1);
		await send({ ...SNAPSHOT, source: 'root.b = 2' });
		await send({ ...SNAPSHOT, source: 'root.b = 3' });
		expect(runs()).toHaveLength(1);
		await wait();
		expect(runs()).toHaveLength(2);
		// Only the kind changed (mapping → mutation): it runs too.
		await send({ ...SNAPSHOT, source: 'root.b = 3', kind: 'mutation' });
		await wait();
		expect(runs()).toHaveLength(3);
		// A metadata edit runs too.
		await click(tab('in', 'meta'));
		await click(host.querySelector('.rpcn-bl-meta-add'));
		await setValue(host.querySelector<HTMLInputElement>('.rpcn-bl-meta-key')!, 'k');
		await setValue(host.querySelector<HTMLInputElement>('.rpcn-bl-meta-value')!, 'v');
		await wait();
		expect(runs()).toEqual([
			{ type: 'run', content: '{"a":1}', meta: {} },
			{ type: 'run', content: '{"a":1}', meta: {} },
			{ type: 'run', content: '{"a":1}', meta: {} },
			{ type: 'run', content: '{"a":1}', meta: { k: 'v' } },
		]);
	});

	it('RUN_OFF: with Run on change off, edits to the content, the metadata and the mapping run nothing until Run', async () => {
		vi.useFakeTimers();
		await render({ content: '{"a":1}' });
		await click(host.querySelector('.rpcn-bl-auto'));
		expect(host.querySelector<HTMLInputElement>('.rpcn-bl-auto')!.checked).toBe(false);
		await send(SNAPSHOT);
		await type('{"a":2}');
		await send({ ...SNAPSHOT, source: 'root.b = 2' });
		await click(tab('in', 'meta'));
		await click(host.querySelector('.rpcn-bl-meta-add'));
		await setValue(host.querySelector<HTMLInputElement>('.rpcn-bl-meta-key')!, 'k');
		await wait(RUN_DEBOUNCE_MS * 3);
		expect(runs()).toEqual([]);
		await click(host.querySelector('.rpcn-bl-run'));
		expect(runs()).toEqual([{ type: 'run', content: '{"a":2}', meta: { k: '' } }]);
		expect(saved[saved.length - 1].runOnChange).toBe(false);
	});

	it('turning Run on change off cancels a pending run', async () => {
		vi.useFakeTimers();
		await render();
		await send(SNAPSHOT);
		await type('{"a":1}');
		await click(host.querySelector('.rpcn-bl-auto'));
		await wait(RUN_DEBOUNCE_MS * 2);
		expect(runs()).toEqual([]);
	});

	it('an empty content runs nothing and shows the empty state; Run is disabled; a late result is dropped', async () => {
		vi.useFakeTimers();
		await render();
		await send(SNAPSHOT);
		await type('{"a":1}');
		await wait();
		await send({ type: 'result', result: OK_B2, durationMs: 1, binary: null });
		await type('{"a":2}');
		await type('');
		await wait(RUN_DEBOUNCE_MS * 2);
		expect(runs()).toEqual([{ type: 'run', content: '{"a":1}', meta: {} }]);
		expect(host.querySelector('.rpcn-bl-output')).toBeNull();
		expect(host.textContent).toContain(EMPTY_TEXT);
		expect(host.querySelector<HTMLButtonElement>('.rpcn-bl-run')!.disabled).toBe(true);
		await send({ type: 'result', result: { kind: 'failed', message: 'late' }, durationMs: 1, binary: null });
		expect(host.textContent).toContain(EMPTY_TEXT);
		expect(host.textContent).not.toContain('late');
	});

	it('EMPTY_KEY: the input Metadata tab adds and removes rows; an empty key is not sent or counted', async () => {
		await render({ content: '{"a":1}', runOnChange: false });
		await send(SNAPSHOT);
		await click(tab('in', 'meta'));
		expect(tab('in', 'meta')?.getAttribute('aria-selected')).toBe('true');
		expect(host.querySelector('.rpcn-bl-in thead')?.textContent).toContain('KeyValue');
		for (let i = 0; i < 3; i++) {
			await click(host.querySelector('.rpcn-bl-meta-add'));
		}
		expect(host.querySelector('.rpcn-bl-meta-add')?.textContent).toBe('+ Add metadata');
		const keys = () => [...host.querySelectorAll<HTMLInputElement>('.rpcn-bl-meta-key')];
		const values = () => [...host.querySelectorAll<HTMLInputElement>('.rpcn-bl-meta-value')];
		expect(document.activeElement).toBe(keys()[2]);
		// A tab round trip does not pull focus back to the added row.
		await click(tab('in', 'content'));
		(tab('in', 'meta') as HTMLElement).focus();
		await click(tab('in', 'meta'));
		expect(document.activeElement).toBe(tab('in', 'meta'));
		await setValue(keys()[0], 'k');
		await setValue(values()[0], 'v');
		await setValue(values()[1], 'no key');
		await setValue(keys()[2], 'k');
		await setValue(values()[2], 'last');
		expect(badge('in')).toBe('2');
		await click(host.querySelector('.rpcn-bl-run'));
		expect(runs()[0]).toEqual({ type: 'run', content: '{"a":1}', meta: { k: 'last' } });
		await click(host.querySelectorAll('.rpcn-bl-meta-remove')[2]);
		expect(keys().map((k) => k.value)).toEqual(['k', '']);
		expect(badge('in')).toBe('1');
		await click(host.querySelector('.rpcn-bl-run'));
		expect(runs()[1]).toEqual({ type: 'run', content: '{"a":1}', meta: { k: 'v' } });
		expect(saved[saved.length - 1].meta).toEqual([{ key: 'k', value: 'v' }, { key: '', value: 'no key' }]);
		expect(saved[saved.length - 1].inputTab).toBe('meta');
	});

	it('RESTORE: the content, metadata rows, tabs and the toggle come back; with the toggle on it runs once', async () => {
		const state: ViewState = {
			content: '{"a":2}', meta: [{ key: 'k', value: 'v' }, { key: '', value: 'x' }], inputTab: 'meta', outputTab: 'meta', runOnChange: true,
		};
		await render(state);
		await send(SNAPSHOT);
		await send(SNAPSHOT);
		expect(runs()).toEqual([{ type: 'run', content: '{"a":2}', meta: { k: 'v' } }]);
		expect(tab('in', 'meta')?.getAttribute('aria-selected')).toBe('true');
		expect(tab('out', 'meta')?.getAttribute('aria-selected')).toBe('true');
		expect([...host.querySelectorAll<HTMLInputElement>('.rpcn-bl-meta-key')].map((k) => k.value)).toEqual(['k', '']);
		expect(host.querySelector<HTMLInputElement>('.rpcn-bl-auto')!.checked).toBe(true);
		expect(saved[saved.length - 1]).toEqual(state);
		await click(tab('in', 'content'));
		expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('{"a":2}');
	});

	it('RESTORE with the toggle off: nothing runs', async () => {
		await render({ content: '{"a":2}', runOnChange: false });
		await send(SNAPSHOT);
		expect(runs()).toEqual([]);
		expect(host.querySelector<HTMLInputElement>('.rpcn-bl-auto')!.checked).toBe(false);
	});

	it('FIELDS + metadata: changed and added fields marked, the metadata table marks added keys, tags list both', async () => {
		await render({ content: '{"a":1,"b":2}' });
		await send(SNAPSHOT);
		await send(fixture('result-ok.json'));
		expect(outputText()).toBe('{\n  "a": 1,\n  "b": 3,\n  "c": 4\n}');
		expect(markedText()).toEqual(['  "b": 3,', '  "c": 4']);
		expect(tags()).toEqual(['+c', '~b', '+@kafka_partition', '+@tags', '+@source', '−@trace']);
		expect(badge('out')).toBe('4');
		await click(tab('out', 'meta'));
		const rows = [...host.querySelectorAll('.rpcn-bl-out tbody tr')];
		expect(rows.map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent))).toEqual([
			['kafka_key', 'order-17'], ['kafka_partition', '3'], ['tags', '["new","eu"]'], ['source', '{"region":"eu-west-1"}'],
		]);
		expect(rows.map((r) => r.classList.contains('rpcn-bl-mark'))).toEqual([false, true, true, true]);
		expect(host.querySelector('.rpcn-bl-out input')).toBeNull();
	});

	it('META_OUT: a key the mapping set is marked in the output metadata and tagged +@out', async () => {
		await render({ content: '{"a":1}' });
		await send(SNAPSHOT);
		await send({
			type: 'result', durationMs: 5, binary: 'redpanda-connect 4.112.0',
			result: {
				kind: 'ok', content: '{"a":1}', meta: { k: 'v', out: 'x' },
				changes: { fields: { added: [], changed: [], removed: [] }, meta: { added: ['out'], changed: [], removed: [] } },
			},
		});
		expect(markedText()).toEqual([]);
		expect(tags()).toEqual(['+@out']);
		await click(tab('out', 'meta'));
		const marked = [...host.querySelectorAll('.rpcn-bl-out tbody tr.rpcn-bl-mark')].map((r) => r.textContent);
		expect(marked).toEqual(['outx']);
		expect(pill()).toBe('✓ Ran in 5 ms · redpanda-connect 4.112.0');
	});

	it('NOT_JSON: the output shows verbatim with no field tags; no changes reads "No changes"', async () => {
		await render({ content: 'hi' });
		await send(SNAPSHOT);
		await send({
			type: 'result', durationMs: 1, binary: null,
			result: { kind: 'ok', content: 'hello', meta: {}, changes: { fields: null, meta: { added: [], changed: [], removed: [] } } },
		});
		expect(outputText()).toBe('hello');
		expect(tags()).toEqual([]);
		expect(footer()).toBe('No changes');
		expect(pill()).toBe('✓ Ran in 1 ms');
	});

	it('RUN_FAILED, DELETED, RUN_ERROR: each result shows 4.2\'s text, and the pill 4.2\'s duration; malformed messages are ignored', async () => {
		await render({ content: '{"a":1}' });
		await send(SNAPSHOT);
		await send({ type: 'result', result: { kind: 'failed', message: 'failed assignment (line 1): x' }, durationMs: 1, binary: 'b' });
		expect(host.textContent).toContain(FAILED_TEXT);
		expect(host.querySelector('.rpcn-bl-message')?.textContent).toBe('failed assignment (line 1): x');
		expect(pill()).toBe('1 ms · b');
		expect(badge('out')).toBe('–');
		expect(footer()).toBeUndefined();
		await send({ type: 'result', result: { kind: 'deleted' }, durationMs: 1, binary: 'b' });
		expect(host.textContent).toContain(DELETED_TEXT);
		await send({ type: 'result', result: { kind: 'error', message: 'No Redpanda Connect binary.' }, durationMs: 0, binary: null });
		expect(host.textContent).toContain(ERROR_TEXT);
		expect(host.querySelector('.rpcn-bl-message')?.textContent).toBe('No Redpanda Connect binary.');
		expect(pill()).toBe('0 ms');
		await send({ type: 'result', result: { kind: 'ok' }, durationMs: 1, binary: null });
		expect(host.textContent).toContain(ERROR_TEXT);
	});

	it('until 4.8: a parse error and an invalid input show in the could-not-run block; samples and binary messages change nothing', async () => {
		await render({ content: '{"a":1}' });
		await send(SNAPSHOT);
		await send({ type: 'result', result: { kind: 'parseError', message: 'expected end of input', excerpt: 'root = (', mappingLine: 1, mappingChar: 8, fileLine: 7, fileChar: 20 }, durationMs: 1, binary: null });
		expect(host.querySelector('.rpcn-bl-problem-title')?.textContent).toBe(ERROR_TEXT);
		expect(host.querySelector('.rpcn-bl-message')?.textContent).toBe('expected end of input');
		await send({ type: 'result', result: { kind: 'invalidInput', message: 'The input is not valid JSON.' }, durationMs: 1, binary: null });
		expect(host.querySelector('.rpcn-bl-problem-title')?.textContent).toBe(ERROR_TEXT);
		expect(host.querySelector('.rpcn-bl-message')?.textContent).toBe('The input is not valid JSON.');
		const before = host.innerHTML;
		const postedBefore = posted.length;
		await send({ type: 'samples', samples: [{ name: 's', content: '{"x":1}', meta: { k: 'v' } }], selected: 's' });
		await send({ type: 'binary', status: 'missing' });
		expect(host.innerHTML).toBe(before);
		expect(posted.length).toBe(postedBefore);
	});

	it.each(FIXTURE_NAMES)('FIXTURES: %s renders after a snapshot in the 4.7 layout', async (name) => {
		const message = fixture(name);
		await render({ content: '{"a":1}', runOnChange: false });
		await send(SNAPSHOT);
		const before = host.innerHTML;
		await send(message);
		const result = message.result as { kind: string; content?: string; message?: string } | undefined;
		if (message.type !== 'result' || !result) {
			// snapshot replaces the header; samples and binary change nothing yet.
			if (message.type === 'snapshot') {
				expect(host.querySelector('h1')?.textContent).toBe(message.title);
				expect(host.querySelector('.rpcn-bl-kind')?.textContent).toBe(message.kind);
			} else {
				expect(host.innerHTML).toBe(before);
			}
			return;
		}
		switch (result.kind) {
			case 'ok':
				expect(outputText()).toBe(JSON.stringify(JSON.parse(result.content!), null, 2));
				expect(pill()).toMatch(/^✓ Ran in \d+ ms/);
				expect(footer()).toMatch(/^Changed:/);
				break;
			case 'deleted':
				expect(host.textContent).toContain(DELETED_TEXT);
				break;
			case 'failed':
				expect(host.querySelector('.rpcn-bl-problem-title')?.textContent).toBe(FAILED_TEXT);
				expect(host.querySelector('.rpcn-bl-message')?.textContent).toBe(result.message);
				break;
			default:
				expect(host.querySelector('.rpcn-bl-problem-title')?.textContent).toBe(ERROR_TEXT);
				expect(host.querySelector('.rpcn-bl-message')?.textContent).toBe(result.message);
		}
	});
});
