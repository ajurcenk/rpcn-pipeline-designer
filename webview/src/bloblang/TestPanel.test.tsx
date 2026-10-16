// @vitest-environment happy-dom
// The Bloblang test panel's view (tickets 4.2, 4.7, 4.8) in happy-dom: it posts `ready`, shows the
// snapshot's title and kind, posts `run {content, meta}` on Run, or with Run on change after the
// pause, and shows each result: the output content with the changed fields marked, the output
// metadata, the "Changed:" tags and the status pill; every other result's card and pill, Go to
// line, and the last successful output dimmed under an error. The view state survives a reload.
// Ticket 4.15: the no-binary state, its buttons, and the run that follows recovery.
// Ticket 4.9: the sample controls (picker, New sample, Rename with its validation, Delete), switching
// runs, `inputEdited` after the pause, outside edits, the unreadable file's disabled state, and with
// 4.15 (AI-7): no binary, a switch runs nothing and recovery runs the selected sample.
// Ticket 4.16: the unlabelled processor's note and Add label.
// Ticket 4.10: the removed processor's notice, and the run when it comes back.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BloblangHostMessage, BloblangSample, BloblangWebviewMessage } from '../../../src/shared/bloblangProtocol';
import { DEFAULT_VIEW_STATE, readViewState, type ViewState } from './host';
import {
	DELETED_FOOTER, DELETED_TITLE, DIMMED_FOOTER, ERROR_TITLE, FAILED_NO_LINE_TITLE, INVALID_INPUT_TITLE, LAST_OK_LABEL,
	PARSE_ERROR_FOOTER, PARSE_ERROR_TITLE,
} from './OutputView';
import {
	DELETE_LABEL, NAME_EXISTS_ERROR, NAME_LENGTH_ERROR, NEW_SAMPLE_LABEL, nextSampleName, RENAME_LABEL, SAMPLE_LABEL, UNSAVED_INPUT,
} from './SamplePicker';
import {
	ADD_LABEL_LABEL, EMPTY_TEXT, NO_BINARY_TEXT, NO_BINARY_TITLE, NO_LABEL_AFTER, NO_LABEL_BEFORE, REMOVED_TITLE, removedText, RUN_DEBOUNCE_MS,
	RUNNING_TEXT, SAMPLES_ERROR_PREFIX, TestPanel,
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

async function render(state: Partial<ViewState> = {}, fileName?: string, samplesFile?: string): Promise<void> {
	await act(async () => {
		root.render(
			<TestPanel
				post={(m) => posted.push(m)} initialState={{ ...DEFAULT_VIEW_STATE, ...state }} saveState={(s) => saved.push(s)}
				fileName={fileName} samplesFile={samplesFile}
			/>,
		);
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
const card = () => host.querySelector('.rpcn-bl-card');
const cardTitle = () => card()?.querySelector('.rpcn-bl-card-title')?.textContent;
const cardSub = () => card()?.querySelector('.rpcn-bl-card-sub')?.textContent;
const cardMessage = () => card()?.querySelector('.rpcn-bl-message')?.textContent;
const goTo = () => host.querySelector('.rpcn-bl-goto');
const stale = () => host.querySelector('.rpcn-bl-stale');
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

describe('Bloblang test panel (4.2, 4.7)', () => {
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

	const OK_META = {
		kind: 'ok', content: '{"b":2}', meta: { k: 'v' },
		changes: { fields: { added: ['b'], changed: [], removed: [] }, meta: { added: ['k'], changed: [], removed: [] } },
	} as const;
	const PARSE = {
		kind: 'parseError', message: 'required: expected comma or closing bracket', excerpt: '  |\n2 | root.c = = 3\n  |          ^---',
		mappingLine: 2, mappingChar: 10, fileLine: 14, fileChar: 18,
	} as const;
	const goToLines = () => posted.flatMap((m) => (m.type === 'goToLine' ? [m.line] : []));

	it('PARSE: the syntax-error pill and card (mapping and file position, message and excerpt), Go to line, its footer', async () => {
		await render({ content: '{"a":1}' }, 'orders.yaml');
		await send(SNAPSHOT);
		await send({ type: 'result', result: PARSE, durationMs: 400, binary: 'b' });
		expect(pill()).toBe('✕ Syntax error · not run');
		expect(host.querySelector('.rpcn-bl-pill')?.classList.contains('rpcn-bl-pill-err')).toBe(true);
		expect(card()?.getAttribute('role')).toBe('alert');
		expect(cardTitle()).toBe(PARSE_ERROR_TITLE);
		expect(cardTitle()).toBe("Mapping doesn't parse");
		expect(cardSub()).toBe('mapping line 2, char 10 · orders.yaml line 14');
		expect(cardMessage()).toBe('required: expected comma or closing bracket\n  |\n2 | root.c = = 3\n  |          ^---');
		expect(goTo()?.textContent).toBe('Go to line 14');
		await click(goTo());
		expect(goToLines()).toEqual([14]);
		expect(footer()).toBe(PARSE_ERROR_FOOTER);
		expect(footer()).toBe('Fix the mapping to run it again.');
		expect(stale()).toBeNull();
		expect(badge('out')).toBe('–');
	});

	it('PARSE fixed (AI-7): the next ok replaces the card with the output', async () => {
		await render({ content: '{"a":1}' });
		await send(SNAPSHOT);
		await send({ type: 'result', result: PARSE, durationMs: 1, binary: null });
		expect(cardSub()).toBe('mapping line 2, char 10 · YAML line 14');
		await send({ type: 'result', result: OK_B2, durationMs: 2, binary: null });
		expect(card()).toBeNull();
		expect(outputText()).toBe('{\n  "b": 2\n}');
		expect(pill()).toBe('✓ Ran in 2 ms');
	});

	it('FAILED: the card with the mapping and file line and Go to line; the last ok output dimmed, unmarked and labelled', async () => {
		await render({ content: '{"a":1}' }, 'orders.yaml');
		await send(SNAPSHOT);
		await send({ type: 'result', result: OK_META, durationMs: 3, binary: null });
		await send({ type: 'result', result: { kind: 'failed', message: 'failed assignment (line 2): boom', mappingLine: 2, fileLine: 12 }, durationMs: 1, binary: 'b' });
		expect(pill()).toBe('✕ Mapping failed on this input');
		expect(card()?.getAttribute('role')).toBe('alert');
		expect(cardTitle()).toBe('Failed on mapping line 2');
		expect(cardSub()).toBe('orders.yaml line 12');
		expect(cardMessage()).toBe('failed assignment (line 2): boom');
		expect(goTo()?.textContent).toBe('Go to line 12');
		await click(goTo());
		expect(goToLines()).toEqual([12]);
		expect(stale()?.getAttribute('aria-label')).toBe(LAST_OK_LABEL);
		expect(stale()?.textContent).toContain('Last successful output');
		expect(host.querySelector('.rpcn-bl-stale .rpcn-bl-output')?.textContent).toBe('{\n  "b": 2\n}');
		expect(markedText()).toEqual([]);
		expect(footer()).toBe(DIMMED_FOOTER);
		expect(footer()).toBe('Showing the last successful output, dimmed.');
		expect(tags()).toEqual([]);
		// The metadata tab dims the last ok metadata, unmarked.
		await click(tab('out', 'meta'));
		const rows = [...host.querySelectorAll('.rpcn-bl-stale tbody tr')];
		expect(rows.map((r) => r.textContent)).toEqual(['kv']);
		expect(rows.some((r) => r.classList.contains('rpcn-bl-mark'))).toBe(false);
	});

	it('RESTORE_DIMMED: the last ok result is saved; a recreated panel whose restored run fails still dims it', async () => {
		await render({ content: '{"a":1}', runOnChange: false });
		await send(SNAPSHOT);
		await send({ type: 'result', result: OK_META, durationMs: 3, binary: null });
		const state = saved[saved.length - 1];
		expect(state.lastOk).toEqual(OK_META);
		// A hidden-then-shown panel: the webview is recreated from the saved state, and its restored run fails.
		await act(async () => root.unmount());
		root = createRoot(host);
		posted = [];
		await render(readViewState(JSON.parse(JSON.stringify({ ...state, runOnChange: true }))));
		await send(SNAPSHOT);
		expect(runs()).toEqual([{ type: 'run', content: '{"a":1}', meta: {} }]);
		await send({ type: 'result', result: { kind: 'failed', message: 'failed assignment (line 2): boom', mappingLine: 2, fileLine: 12 }, durationMs: 1, binary: null });
		expect(stale()?.getAttribute('aria-label')).toBe(LAST_OK_LABEL);
		expect(host.querySelector('.rpcn-bl-stale .rpcn-bl-output')?.textContent).toBe('{\n  "b": 2\n}');
		expect(footer()).toBe(DIMMED_FOOTER);
	});

	it('readViewState keeps a well-formed lastOk only', () => {
		expect(readViewState({ lastOk: OK_META }).lastOk).toEqual(OK_META);
		expect(readViewState({ lastOk: { kind: 'failed', message: 'x' } }).lastOk).toBeUndefined();
		expect(readViewState({ lastOk: { kind: 'ok', content: 1 } }).lastOk).toBeUndefined();
		expect(readViewState({}).lastOk).toBeUndefined();
	});

	it('FAILED_NO_LINE + NO_OK_YET: no line, no button, no dimmed block, no footer', async () => {
		await render({ content: '{"a":1}' });
		await send(SNAPSHOT);
		await send({ type: 'result', result: { kind: 'failed', message: 'boom' }, durationMs: 1, binary: null });
		expect(cardTitle()).toBe(FAILED_NO_LINE_TITLE);
		expect(cardSub()).toBeUndefined();
		expect(cardMessage()).toBe('boom');
		expect(goTo()).toBeNull();
		expect(stale()).toBeNull();
		expect(footer()).toBeUndefined();
	});

	it('INVALID: the input card with the binary\'s message and the hint, no button', async () => {
		await render({ content: 'not json' });
		await send(SNAPSHOT);
		await send({ type: 'result', result: { kind: 'invalidInput', message: 'unable to reference message as structured' }, durationMs: 1, binary: null });
		expect(pill()).toBe('✕ Input not valid for this mapping');
		expect(card()?.getAttribute('role')).toBe('alert');
		expect(cardTitle()).toBe(INVALID_INPUT_TITLE);
		expect(cardTitle()).toBe("This input can't be read by the mapping");
		expect(cardMessage()).toBe('unable to reference message as structured');
		expect(card()?.querySelector('.rpcn-bl-card-hint')?.textContent).toBe("The mapping reads the message as JSON (this); check the input's Content.");
		expect(card()?.querySelector('.rpcn-bl-card-hint code')?.textContent).toBe('this');
		expect(goTo()).toBeNull();
	});

	it('DELETED: the warning pill, the dashed info card, its footer; nothing dimmed after an ok', async () => {
		await render({ content: '{"a":1}' });
		await send(SNAPSHOT);
		await send({ type: 'result', result: OK_B2, durationMs: 1, binary: null });
		await send({ type: 'result', result: { kind: 'deleted' }, durationMs: 38.2, binary: 'b' });
		expect(pill()).toBe('⊘ Message deleted · 38 ms');
		expect(host.querySelector('.rpcn-bl-pill')?.classList.contains('rpcn-bl-pill-warn')).toBe(true);
		expect(card()?.classList.contains('rpcn-bl-card-info')).toBe(true);
		expect(card()?.getAttribute('role')).toBeNull();
		expect(cardTitle()).toBe(DELETED_TITLE);
		expect(card()?.textContent).toBe('The mapping deleted this message');
		expect(footer()).toBe(DELETED_FOOTER);
		expect(footer()).toBe('No output and no metadata.');
		expect(stale()).toBeNull();
		expect(goTo()).toBeNull();
	});

	it('ERROR: the could-not-run card with the message verbatim, the last ok dimmed; malformed messages are ignored', async () => {
		await render({ content: '{"a":1}' });
		await send(SNAPSHOT);
		await send({ type: 'result', result: OK_B2, durationMs: 1, binary: null });
		await send({ type: 'result', result: { kind: 'error', message: 'No Redpanda Connect binary.' }, durationMs: 0, binary: null });
		expect(pill()).toBe('✕ Not run');
		expect(card()?.getAttribute('role')).toBe('alert');
		expect(cardTitle()).toBe(ERROR_TITLE);
		expect(cardTitle()).toBe('The test could not run');
		expect(cardMessage()).toBe('No Redpanda Connect binary.');
		expect(stale()).not.toBeNull();
		expect(footer()).toBe(DIMMED_FOOTER);
		await send({ type: 'result', result: { kind: 'ok' }, durationMs: 1, binary: null });
		expect(cardTitle()).toBe(ERROR_TITLE);
	});

	it('UNTITLED (4.9): with no samples file there are no sample controls, and samples messages change nothing', async () => {
		await render({ content: '{"a":1}' });
		await send(SNAPSHOT);
		await send({ type: 'result', result: { kind: 'error', message: 'x' }, durationMs: 1, binary: null });
		const before = host.innerHTML;
		const postedBefore = posted.length;
		await send({ type: 'samples', samples: [{ name: 's', content: '{"x":1}', meta: { k: 'v' } }], selected: 's' });
		expect(host.innerHTML).toBe(before);
		expect(posted.length).toBe(postedBefore);
		expect(host.querySelector('.rpcn-bl-samples')).toBeNull();
		expect(host.textContent).not.toContain(NEW_SAMPLE_LABEL);
	});
});

describe('Bloblang test panel: no binary (4.15)', () => {
	const MISSING = { ...SNAPSHOT, binary: 'missing' } as const;
	const region = () => host.querySelector(`[role="region"][aria-label="${NO_BINARY_TITLE}"]`);
	const live = () => host.querySelector('.rpcn-bl-sr[aria-live="polite"]')?.textContent;
	const buttons = () => [...(region()?.querySelectorAll('button') ?? [])];

	it('OPEN_MISSING: the header stays; the state replaces the pill, the toolbar and the columns; announced; no run', async () => {
		vi.useFakeTimers();
		await render({ content: '{"a":1}' });
		await send(MISSING);
		await wait();
		expect(host.querySelector('h1')?.textContent).toBe('Bloblang: first');
		expect(host.querySelector('.rpcn-bl-kind')?.textContent).toBe('mapping');
		expect(region()).not.toBeNull();
		expect(region()?.querySelector('.rpcn-bl-nobin-title')?.textContent).toBe('No Redpanda Connect binary');
		expect(region()?.querySelector('.rpcn-bl-nobin-text')?.textContent).toBe(
			'The test panel runs mappings with your own binary, so results match the version you deploy.',
		);
		expect(buttons().map((b) => b.textContent)).toEqual(['Install guide', 'Set path', 'Retry']);
		expect(buttons().every((b) => b.type === 'button')).toBe(true);
		expect(host.querySelector('.rpcn-bl-pill')).toBeNull();
		expect(host.querySelector('.rpcn-bl-toolbar')).toBeNull();
		expect(host.querySelector('.rpcn-bl-io')).toBeNull();
		expect(live()).toBe(`${NO_BINARY_TITLE}. ${NO_BINARY_TEXT}`);
		expect(runs()).toEqual([]);
	});

	it('GUIDE / SET_PATH / RETRY: each button posts its intent once', async () => {
		await render();
		await send(MISSING);
		for (const button of buttons()) {
			await click(button);
		}
		expect(posted.slice(1)).toEqual([{ type: 'installGuideRequested' }, { type: 'setPathRequested' }, { type: 'retryRequested' }]);
	});

	it.each([true, false])('RECOVER (Run on change %s): binary ok leaves the state and runs the current input once', async (runOnChange) => {
		vi.useFakeTimers();
		await render({ content: '{"a":1}', meta: [{ key: 'k', value: 'v' }], runOnChange });
		await send(MISSING);
		await send({ type: 'binary', status: 'ok' });
		expect(region()).toBeNull();
		expect(host.querySelector('.rpcn-bl-io')).not.toBeNull();
		expect(host.querySelector<HTMLInputElement>('.rpcn-bl-auto')!.checked).toBe(runOnChange);
		expect(live()).toBe('');
		expect(runs()).toEqual([{ type: 'run', content: '{"a":1}', meta: { k: 'v' } }]);
		expect(pill()).toBe(RUNNING_TEXT);
		await send({ type: 'result', result: OK_B2, durationMs: 5, binary: 'redpanda-connect 4.112.0' });
		expect(outputText()).toBe('{\n  "b": 2\n}');
		await wait(RUN_DEBOUNCE_MS * 2);
		expect(runs().length).toBe(1);
	});

	it('RECOVER (empty content): nothing runs; the empty state shows', async () => {
		await render();
		await send(MISSING);
		await send({ type: 'binary', status: 'ok' });
		expect(runs()).toEqual([]);
		expect(host.textContent).toContain(EMPTY_TEXT);
	});

	it('LOST: ok to missing hides the result and the pill; recovery runs once and brings a result back', async () => {
		await render({ content: '{"a":1}' });
		await send(SNAPSHOT);
		expect(runs().length).toBe(1);
		await send({ type: 'result', result: OK_B2, durationMs: 1, binary: null });
		expect(outputText()).toBe('{\n  "b": 2\n}');
		await send({ type: 'binary', status: 'missing' });
		expect(region()).not.toBeNull();
		expect(host.querySelector('.rpcn-bl-output')).toBeNull();
		expect(host.querySelector('.rpcn-bl-pill')).toBeNull();
		// A result racing the loss (the host's no-binary guard) is not shown either.
		await send({ type: 'result', result: { kind: 'error', message: 'No Redpanda Connect binary.' }, durationMs: 0, binary: null });
		expect(card()).toBeNull();
		await send({ type: 'binary', status: 'ok' });
		expect(runs().length).toBe(2);
		// No result until the recovery run's.
		expect(host.querySelector('.rpcn-bl-output')).toBeNull();
		expect(pill()).toBe(RUNNING_TEXT);
		await send({ type: 'result', result: OK_B2, durationMs: 1, binary: null });
		expect(outputText()).toBe('{\n  "b": 2\n}');
	});

	it('UNCHANGED: ok to ok, and not ok to not ok, run nothing and change nothing', async () => {
		await render({ content: '{"a":1}', runOnChange: false });
		await send(SNAPSHOT);
		await send({ type: 'binary', status: 'ok' });
		expect(runs()).toEqual([]);
		await send({ type: 'binary', status: 'missing' });
		const before = host.innerHTML;
		await send({ type: 'binary', status: 'invalid' });
		await send({ type: 'binary', status: 'unresolved' });
		expect(host.innerHTML).toBe(before);
		expect(runs()).toEqual([]);
	});

	it('EDIT_WHILE_MISSING: a new source runs nothing; the input, its metadata, the tabs and the toggle come back unchanged', async () => {
		vi.useFakeTimers();
		await render({ content: '{"a":1}' });
		await send(SNAPSHOT);
		await click(tab('in', 'meta'));
		await click(host.querySelector('.rpcn-bl-meta-add'));
		const [key, value] = [...host.querySelectorAll<HTMLInputElement>('.rpcn-bl-meta input')];
		await setValue(key, 'k');
		await setValue(value, 'v');
		await wait();
		const before = runs().length;
		await send({ type: 'binary', status: 'missing' });
		await send({ ...MISSING, source: 'root.c = 1' });
		await wait(RUN_DEBOUNCE_MS * 2);
		expect(runs().length).toBe(before);
		await send({ type: 'binary', status: 'ok' });
		expect(tab('in', 'meta')?.getAttribute('aria-selected')).toBe('true');
		expect(badge('in')).toBe('1');
		expect(host.querySelector<HTMLInputElement>('.rpcn-bl-auto')!.checked).toBe(true);
		expect(runs().at(-1)).toEqual({ type: 'run', content: '{"a":1}', meta: { k: 'v' } });
		expect(runs().length).toBe(before + 1);
		expect(saved.at(-1)).toMatchObject({ content: '{"a":1}', meta: [{ key: 'k', value: 'v' }], inputTab: 'meta', runOnChange: true });
	});

	it('FOCUS: focus in the input moves to the region on entry; from a button in the region back to the input on exit', async () => {
		await render({ content: '{"a":1}', runOnChange: false });
		await send(SNAPSHOT);
		host.querySelector<HTMLTextAreaElement>('#rpcn-bl-input')!.focus();
		await send({ type: 'binary', status: 'missing' });
		expect(document.activeElement).toBe(region());
		expect(region()?.getAttribute('tabindex')).toBe('0');
		buttons()[2].focus();
		await send({ type: 'binary', status: 'ok' });
		expect(document.activeElement).toBe(host.querySelector('#rpcn-bl-input'));
	});

	it('FOCUS (Metadata tab): exit focuses Run; focus outside the panel is not moved', async () => {
		await render({ content: '{"a":1}', runOnChange: false, inputTab: 'meta' });
		await send(MISSING);
		expect(document.activeElement).not.toBe(region());
		(region() as HTMLElement).focus();
		await send({ type: 'binary', status: 'ok' });
		expect(document.activeElement).toBe(host.querySelector('.rpcn-bl-run'));
		const outside = document.createElement('button');
		document.body.appendChild(outside);
		outside.focus();
		await send({ type: 'binary', status: 'missing' });
		expect(document.activeElement).toBe(outside);
		await send({ type: 'binary', status: 'ok' });
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});

	it('a reopened panel with no binary does not run its restored input; recovery does', async () => {
		await render({ content: '{"a":1}', runOnChange: true });
		await send(MISSING);
		expect(runs()).toEqual([]);
		await send({ ...SNAPSHOT });
		expect(runs()).toEqual([{ type: 'run', content: '{"a":1}', meta: {} }]);
	});
});

describe('Bloblang test panel fixtures', () => {
	it.each(FIXTURE_NAMES)('FIXTURES: %s renders after a snapshot in the 4.8 layout', async (name) => {
		const message = fixture(name);
		await render({ content: '{"a":1}', runOnChange: false });
		await send(SNAPSHOT);
		const before = host.innerHTML;
		await send(message);
		const result = message.result as { kind: string; content?: string; message?: string; excerpt?: string; fileLine?: number; mappingLine?: number } | undefined;
		if (message.type !== 'result' || !result) {
			// snapshot replaces the header; a binary not ok shows the no-binary state (4.15); samples change nothing yet.
			if (message.type === 'snapshot') {
				expect(host.querySelector('h1')?.textContent).toBe(message.title);
				expect(host.querySelector('.rpcn-bl-kind')?.textContent).toBe(message.kind);
			} else if (message.type === 'binary') {
				expect(host.querySelector(`[role="region"][aria-label="${NO_BINARY_TITLE}"]`) !== null).toBe(message.status !== 'ok');
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
				expect(cardTitle()).toBe(DELETED_TITLE);
				expect(pill()).toMatch(/^⊘ Message deleted · \d+ ms$/);
				break;
			case 'failed':
				expect(cardTitle()).toBe(`Failed on mapping line ${result.mappingLine}`);
				expect(goTo()?.textContent).toBe(`Go to line ${result.fileLine}`);
				expect(cardMessage()).toBe(result.message);
				break;
			case 'parseError':
				expect(cardTitle()).toBe(PARSE_ERROR_TITLE);
				expect(goTo()?.textContent).toBe(`Go to line ${result.fileLine}`);
				expect(cardMessage()).toBe(`${result.message}\n${result.excerpt}`);
				break;
			case 'invalidInput':
				expect(cardTitle()).toBe(INVALID_INPUT_TITLE);
				expect(cardMessage()).toBe(result.message);
				break;
			default:
				expect(cardTitle()).toBe(ERROR_TITLE);
				expect(cardMessage()).toBe(result.message);
		}
	});
});

describe('Bloblang test panel: saved samples (4.9)', () => {
	const FILE = 'orders.samples.json';
	const A: BloblangSample = { name: 'a', content: '{"a":1}', meta: { k: 'v' } };
	const B: BloblangSample = { name: 'b', content: '{"a":2}', meta: {} };
	const C: BloblangSample = { name: 'c', content: '{"a":3}', meta: { z: '1' } };
	const picker = () => host.querySelector<HTMLSelectElement>('#rpcn-bl-sample');
	const options = () => [...(picker()?.querySelectorAll('option') ?? [])].map((o) => o.textContent);
	const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.rpcn-bl-samples button')].find((b) => b.textContent === label)!;
	const nameField = () => host.querySelector<HTMLInputElement>('#rpcn-bl-sample-name');
	const savedLine = () => host.querySelector('.rpcn-bl-saved')?.textContent;
	const input = () => host.querySelector<HTMLTextAreaElement>('textarea')?.value;
	const intents = () => posted.filter((m) => m.type !== 'ready' && m.type !== 'run');
	const withSamples = (samples: readonly BloblangSample[], selected: string | null) => ({ ...SNAPSHOT, samples, selected });
	const pick = async (name: string) => {
		await act(async () => {
			const el = picker()!;
			Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, name);
			el.dispatchEvent(new Event('change', { bubbles: true }));
		});
	};
	const key = async (el: Element, k: string) => {
		await act(async () => {
			el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
		});
	};

	it('CONTROLS: the label, the picker, New sample, Rename and Delete; with no samples only New sample is enabled', async () => {
		await render({}, 'orders.yaml', FILE);
		await send(SNAPSHOT);
		expect(host.querySelector('.rpcn-bl-samples-label')?.textContent).toBe(SAMPLE_LABEL);
		expect(options()).toEqual([UNSAVED_INPUT]);
		expect(picker()!.disabled).toBe(true);
		expect([...host.querySelectorAll('.rpcn-bl-samples button')].map((b) => [b.textContent, (b as HTMLButtonElement).disabled]))
			.toEqual([[NEW_SAMPLE_LABEL, false], [RENAME_LABEL, true], [DELETE_LABEL, true]]);
		expect(savedLine()).toBeUndefined();
		// The toolbar's order: the sample controls, then Run on change and Run.
		const toolbar = host.querySelector('.rpcn-bl-toolbar')!;
		expect([...toolbar.children].map((c) => c.className)).toEqual(['rpcn-bl-samples', 'rpcn-bl-spacer', 'rpcn-bl-check', 'rpcn-bl-run']);
	});

	it('nextSampleName: the first free sample N', () => {
		expect(nextSampleName([])).toBe('sample 1');
		expect(nextSampleName([{ name: 'sample 1' }, { name: 'sample 3' }])).toBe('sample 2');
	});

	it('FIRST_SAMPLE: New sample saves the input as "sample 1", selected; "Saved in" shows; nothing runs', async () => {
		vi.useFakeTimers();
		await render({ content: '{"a":1}', meta: [{ key: 'k', value: 'v' }], runOnChange: false }, 'orders.yaml', FILE);
		await send(SNAPSHOT);
		await click(button(NEW_SAMPLE_LABEL));
		expect(intents()).toEqual([
			{ type: 'sampleAdded', name: 'sample 1' },
			{ type: 'inputEdited', content: '{"a":1}', meta: { k: 'v' } },
		]);
		expect(options()).toEqual(['sample 1']);
		expect(picker()!.value).toBe('sample 1');
		expect(savedLine()).toBe(`Saved in ${FILE}`);
		expect(input()).toBe('{"a":1}');
		expect(runs()).toEqual([]);
	});

	it('NEW: with samples, New sample adds an empty "sample N", selects it and runs nothing', async () => {
		vi.useFakeTimers();
		await render({}, 'orders.yaml', FILE);
		await send(withSamples([A, { ...B, name: 'sample 1' }], 'a'));
		const before = runs().length;
		await click(button(NEW_SAMPLE_LABEL));
		expect(intents()).toEqual([{ type: 'sampleAdded', name: 'sample 2' }]);
		expect(options()).toEqual(['a', 'sample 1', 'sample 2']);
		expect(picker()!.value).toBe('sample 2');
		expect(input()).toBe('');
		expect(host.textContent).toContain(EMPTY_TEXT);
		await wait(RUN_DEBOUNCE_MS * 2);
		expect(runs().length).toBe(before);
	});

	it('RELOAD: the snapshot\'s selected sample becomes the input, mirrored into the view state, and runs once', async () => {
		await render({ content: 'stale' }, 'orders.yaml', FILE);
		await send(withSamples([A, B], 'a'));
		expect(input()).toBe('{"a":1}');
		expect(badge('in')).toBe('1');
		expect(runs()).toEqual([{ type: 'run', content: '{"a":1}', meta: { k: 'v' } }]);
		expect(saved.at(-1)).toMatchObject({ content: '{"a":1}', meta: [{ key: 'k', value: 'v' }] });
		expect(options()).toEqual(['a', 'b']);
		expect(savedLine()).toBe(`Saved in ${FILE}`);
		expect(intents()).toEqual([]);
	});

	it('SWITCH: another sample becomes the input, runs once (Run on change off too), and the choice is posted', async () => {
		vi.useFakeTimers();
		await render({ runOnChange: false }, 'orders.yaml', FILE);
		await send(withSamples([A, B], 'a'));
		expect(runs()).toEqual([]);
		await pick('b');
		expect(intents()).toEqual([{ type: 'sampleSwitched', name: 'b' }]);
		expect(input()).toBe('{"a":2}');
		expect(badge('in')).toBe('0');
		expect(runs()).toEqual([{ type: 'run', content: '{"a":2}', meta: {} }]);
		await wait(RUN_DEBOUNCE_MS * 2);
		expect(runs().length).toBe(1);
	});

	it('EDIT_SAVED: content and metadata edits post inputEdited once after the pause, Run on change off too; a switch flushes first', async () => {
		vi.useFakeTimers();
		await render({ runOnChange: false }, 'orders.yaml', FILE);
		await send(withSamples([A, B], 'a'));
		await type('{"a":10}');
		await type('{"a":11}');
		await wait(RUN_DEBOUNCE_MS - 1);
		expect(intents()).toEqual([]);
		await wait(1);
		expect(intents()).toEqual([{ type: 'inputEdited', content: '{"a":11}', meta: { k: 'v' } }]);
		await click(tab('in', 'meta'));
		await setValue(host.querySelector<HTMLInputElement>('.rpcn-bl-meta-value')!, 'w');
		await wait();
		expect(intents().at(-1)).toEqual({ type: 'inputEdited', content: '{"a":11}', meta: { k: 'w' } });
		expect(runs()).toEqual([]);
		// An edit, then a switch before the pause: the edit is saved first; switching back shows it.
		await click(tab('in', 'content'));
		await type('{"a":12}');
		await pick('b');
		expect(intents().slice(-2)).toEqual([
			{ type: 'inputEdited', content: '{"a":12}', meta: { k: 'w' } },
			{ type: 'sampleSwitched', name: 'b' },
		]);
		await pick('a');
		expect(input()).toBe('{"a":12}');
		await wait(RUN_DEBOUNCE_MS * 2);
		expect(intents().filter((m) => m.type === 'inputEdited').length).toBe(3);
	});

	it('UNSAVED: with no sample selected, edits post no inputEdited', async () => {
		vi.useFakeTimers();
		await render({}, 'orders.yaml', FILE);
		await send(withSamples([A], null));
		expect(options()).toEqual([UNSAVED_INPUT, 'a']);
		expect(picker()!.disabled).toBe(false);
		await type('{"x":1}');
		await wait(RUN_DEBOUNCE_MS * 2);
		expect(intents()).toEqual([]);
		expect(runs()).toEqual([{ type: 'run', content: '{"x":1}', meta: {} }]);
	});

	it('RENAME / DUP: the picker becomes a field; Enter saves a trimmed, unique name; errors stay inline; Esc and blur cancel', async () => {
		await render({}, 'orders.yaml', FILE);
		await send(withSamples([A, B], 'a'));
		await click(button(RENAME_LABEL));
		expect(picker()).toBeNull();
		expect(nameField()?.value).toBe('a');
		expect(document.activeElement).toBe(nameField());
		await setValue(nameField()!, 'b');
		await key(nameField()!, 'Enter');
		expect(host.querySelector('.rpcn-bl-rename-error')?.textContent).toBe(NAME_EXISTS_ERROR);
		expect(nameField()?.getAttribute('aria-invalid')).toBe('true');
		await setValue(nameField()!, '   ');
		await key(nameField()!, 'Enter');
		expect(host.querySelector('.rpcn-bl-rename-error')?.textContent).toBe(NAME_LENGTH_ERROR);
		await setValue(nameField()!, 'x'.repeat(101));
		await key(nameField()!, 'Enter');
		expect(host.querySelector('.rpcn-bl-rename-error')?.textContent).toBe(NAME_LENGTH_ERROR);
		expect(nameField()).not.toBeNull();
		expect(intents()).toEqual([]);
		await key(nameField()!, 'Escape');
		expect(nameField()).toBeNull();
		expect(document.activeElement).toBe(picker());
		expect(options()).toEqual(['a', 'b']);
		// Blur cancels.
		await click(button(RENAME_LABEL));
		await setValue(nameField()!, 'gone');
		await act(async () => nameField()!.blur());
		expect(nameField()).toBeNull();
		expect(intents()).toEqual([]);
		// Enter saves.
		await click(button(RENAME_LABEL));
		await setValue(nameField()!, '  order  ');
		await key(nameField()!, 'Enter');
		expect(intents()).toEqual([{ type: 'sampleRenamed', from: 'a', to: 'order' }]);
		expect(options()).toEqual(['order', 'b']);
		expect(picker()!.value).toBe('order');
		// The same name: nothing posted.
		await click(button(RENAME_LABEL));
		await key(nameField()!, 'Enter');
		expect(intents().length).toBe(1);
	});

	it('RENAME + outside samples: another selection or an unreadable file cancels the rename; it never comes back stale', async () => {
		await render({}, 'orders.yaml', FILE);
		await send(withSamples([A, B], 'a'));
		await click(button(RENAME_LABEL));
		await setValue(nameField()!, 'typed');
		// Another sample selected under the field.
		await send({ type: 'samples', samples: [A, B], selected: 'b' });
		expect(nameField()).toBeNull();
		expect(picker()!.value).toBe('b');
		await click(button(RENAME_LABEL));
		expect(nameField()?.value).toBe('b');
		await key(nameField()!, 'Escape');
		// The file becomes unreadable mid-rename, then reads again.
		await click(button(RENAME_LABEL));
		await setValue(nameField()!, 'stale');
		await send({ type: 'samples', samples: [], selected: null, samplesError: 'boom' });
		expect(nameField()).toBeNull();
		await send({ type: 'samples', samples: [A, B], selected: 'b' });
		expect(nameField()).toBeNull();
		expect(picker()).not.toBeNull();
		expect(intents()).toEqual([]);
	});

	it('DELETE: posts sampleDeleted; the host\'s samples select the neighbour (input and run); with none left the input stays', async () => {
		await render({ runOnChange: false }, 'orders.yaml', FILE);
		await send(withSamples([A, B], 'a'));
		await click(button(DELETE_LABEL));
		expect(intents()).toEqual([{ type: 'sampleDeleted', name: 'a' }]);
		// Cancelled: the host posts nothing, nothing changes.
		expect(options()).toEqual(['a', 'b']);
		// Confirmed: the neighbour.
		await send({ type: 'samples', samples: [B], selected: 'b' });
		expect(input()).toBe('{"a":2}');
		expect(runs()).toEqual([{ type: 'run', content: '{"a":2}', meta: {} }]);
		await send({ type: 'samples', samples: [], selected: null });
		expect(input()).toBe('{"a":2}');
		expect(options()).toEqual([UNSAVED_INPUT]);
		expect(savedLine()).toBeUndefined();
		expect(runs().length).toBe(1);
	});

	it('OUTSIDE_EDIT: a changed selected sample replaces the input and runs with Run on change; a pending edit wins', async () => {
		vi.useFakeTimers();
		await render({ runOnChange: true }, 'orders.yaml', FILE);
		await send(withSamples([A, B], 'a'));
		expect(runs().length).toBe(1);
		// Unchanged: nothing.
		await send({ type: 'samples', samples: [A, B, C], selected: 'a' });
		expect(runs().length).toBe(1);
		expect(options()).toEqual(['a', 'b', 'c']);
		await send({ type: 'samples', samples: [{ ...A, content: '{"a":100}' }, B], selected: 'a' });
		expect(input()).toBe('{"a":100}');
		expect(runs().at(-1)).toEqual({ type: 'run', content: '{"a":100}', meta: { k: 'v' } });
		// With Run on change off: replaced, not run.
		await click(host.querySelector('.rpcn-bl-auto'));
		await send({ type: 'samples', samples: [{ ...A, meta: {} }, B], selected: 'a' });
		expect(badge('in')).toBe('0');
		expect(runs().length).toBe(2);
		// Another selected sample: its input, and it runs.
		await send({ type: 'samples', samples: [A, C], selected: 'c' });
		expect(input()).toBe('{"a":3}');
		expect(runs().length).toBe(3);
		// The user is editing: their pending edit is kept and saved.
		await type('{"mine":1}');
		await send({ type: 'samples', samples: [A, { ...C, content: '{"theirs":1}' }], selected: 'c' });
		expect(input()).toBe('{"mine":1}');
		await wait();
		expect(intents().at(-1)).toEqual({ type: 'inputEdited', content: '{"mine":1}', meta: { z: '1' } });
	});

	it('UNREADABLE: the message shows, every control is disabled, edits post nothing; a readable file enables them', async () => {
		vi.useFakeTimers();
		await render({ content: '{"a":1}' }, 'orders.yaml', FILE);
		await send({ ...SNAPSHOT, samplesError: 'Unexpected end of JSON input' });
		expect(host.querySelector('.rpcn-bl-samples-error')?.textContent).toBe(`${SAMPLES_ERROR_PREFIX}Unexpected end of JSON input`);
		expect(host.querySelector('.rpcn-bl-samples-error')?.getAttribute('role')).toBe('alert');
		expect(SAMPLES_ERROR_PREFIX).toBe('The samples file can\'t be read: ');
		expect(picker()!.disabled).toBe(true);
		expect([...host.querySelectorAll<HTMLButtonElement>('.rpcn-bl-samples button')].every((b) => b.disabled)).toBe(true);
		await type('{"a":2}');
		await wait(RUN_DEBOUNCE_MS * 2);
		expect(intents()).toEqual([]);
		expect(input()).toBe('{"a":2}');
		await send({ type: 'samples', samples: [A], selected: 'a' });
		expect(host.querySelector('.rpcn-bl-samples-error')).toBeNull();
		expect(picker()!.disabled).toBe(false);
		expect(button(NEW_SAMPLE_LABEL).disabled).toBe(false);
		expect(input()).toBe('{"a":1}');
	});

	it('AI-7 with 4.15: with no binary a switch runs nothing; recovery runs the selected sample once', async () => {
		vi.useFakeTimers();
		await render({ runOnChange: true }, 'orders.yaml', FILE);
		await send({ ...withSamples([A, B], 'a'), binary: 'missing' });
		expect(host.querySelector('.rpcn-bl-samples')).toBeNull();
		await send({ type: 'samples', samples: [A, B], selected: 'b' });
		await wait(RUN_DEBOUNCE_MS * 2);
		expect(runs()).toEqual([]);
		await send({ type: 'binary', status: 'ok' });
		expect(runs()).toEqual([{ type: 'run', content: '{"a":2}', meta: {} }]);
		expect(picker()!.value).toBe('b');
	});
});

describe('Bloblang test panel: Add label (4.16)', () => {
	const FILE = 'orders.samples.json';
	const PATH = 'pipeline.processors[2]';
	const UNLABELLED = { ...SNAPSHOT, title: `Bloblang: ${PATH}`, unlabelledPath: PATH };
	const note = () => host.querySelector('.rpcn-bl-labelnote');
	const addLabel = () => note()?.querySelector<HTMLButtonElement>('button');

	it('OFFER: under the toolbar, the note with the path and Add label, which posts addLabelRequested; none on a labelled processor', async () => {
		await render({}, 'orders.yaml', FILE);
		await send(SNAPSHOT);
		expect(note()).toBeNull();
		await send(UNLABELLED);
		expect(note()?.getAttribute('role')).toBe('note');
		expect(note()?.querySelector('p')?.textContent)
			.toBe(`No label: samples are linked to this processor's position (${PATH}) and are lost if it moves.`);
		expect(`${NO_LABEL_BEFORE}${PATH}${NO_LABEL_AFTER}`).toBe(note()?.querySelector('p')?.textContent);
		expect(note()?.querySelector('code')?.textContent).toBe(PATH);
		expect(note()?.previousElementSibling?.className).toBe('rpcn-bl-toolbar');
		expect(addLabel()?.textContent).toBe(ADD_LABEL_LABEL);
		await click(addLabel()!);
		expect(posted.filter((m) => m.type === 'addLabelRequested')).toEqual([{ type: 'addLabelRequested' }]);
		expect(runs()).toEqual([]);
	});

	it('ACCEPT: the host\'s next snapshot has the label\'s title and no unlabelled path: the note goes', async () => {
		await render({}, 'orders.yaml', FILE);
		await send(UNLABELLED);
		expect(note()).not.toBeNull();
		await send({ ...SNAPSHOT, title: 'Bloblang: mapping_1' });
		expect(host.querySelector('h1')?.textContent).toBe('Bloblang: mapping_1');
		expect(note()).toBeNull();
	});

	it('UNTITLED and no binary: no note', async () => {
		await render();
		await send(UNLABELLED);
		expect(note()).toBeNull();
		await act(async () => root.unmount());
		root = createRoot(host);
		await render({}, 'orders.yaml', FILE);
		await send({ ...UNLABELLED, binary: 'missing' });
		expect(note()).toBeNull();
	});
});

describe('Bloblang test panel: removed processor (4.10)', () => {
	const REMOVED = { ...SNAPSHOT, removed: true } as const;
	const region = () => host.querySelector(`[role="region"][aria-label="${REMOVED_TITLE}"]`);
	const live = () => host.querySelector('.rpcn-bl-sr[aria-live="polite"]')?.textContent;
	const SAMPLE: BloblangSample = { name: 'one', content: '{"a":1}', meta: {} };

	it('REMOVED: the header stays; the notice replaces the toolbar and the columns; announced; nothing runs', async () => {
		vi.useFakeTimers();
		await render({ content: '{"a":1}' }, 'orders.yaml', 'orders.samples.json');
		await send(SNAPSHOT);
		expect(runs().length).toBe(1);
		await send({ type: 'result', result: OK_B2, durationMs: 1, binary: null });
		await send(REMOVED);
		expect(host.querySelector('h1')?.textContent).toBe('Bloblang: first');
		expect(host.querySelector('.rpcn-bl-kind')?.textContent).toBe('mapping');
		expect(region()?.textContent).toBe('This processor was removed from orders.yaml. Undo the change to bring it back.');
		expect(removedText('orders.yaml')).toBe(region()?.textContent);
		expect(host.querySelector('.rpcn-bl-toolbar')).toBeNull();
		expect(host.querySelector('.rpcn-bl-io')).toBeNull();
		expect(host.querySelector('.rpcn-bl-pill')).toBeNull();
		expect(live()).toBe(removedText('orders.yaml'));
		// A new source while removed runs nothing; a result arriving meanwhile is dropped.
		await send({ ...REMOVED, source: 'root = 2' });
		await send({ type: 'result', result: { kind: 'error', message: 'There is no mapping' }, durationMs: 0, binary: null });
		await wait(RUN_DEBOUNCE_MS * 3);
		expect(runs().length).toBe(1);
	});

	it('REMOVED while a run is pending: the run is cancelled', async () => {
		vi.useFakeTimers();
		await render({ content: '{"a":1}' });
		await send(SNAPSHOT);
		const before = runs().length;
		await type('{"a":2}');
		await send(REMOVED);
		await wait(RUN_DEBOUNCE_MS * 3);
		expect(runs().length).toBe(before);
	});

	it.each([true, false])('UNDO (Run on change %s): back to normal; the input and samples stay; it runs once with Run on change', async (runOnChange) => {
		vi.useFakeTimers();
		await render({ content: '{"a":1}', runOnChange }, 'orders.yaml', 'orders.samples.json');
		await send({ ...SNAPSHOT, samples: [SAMPLE], selected: 'one' });
		const before = runs().length;
		await send({ ...REMOVED, samples: [SAMPLE], selected: 'one' });
		await send({ ...SNAPSHOT, samples: [SAMPLE], selected: 'one' });
		expect(region()).toBeNull();
		expect(host.querySelector('.rpcn-bl-io')).not.toBeNull();
		expect(host.querySelector('textarea')?.value).toBe('{"a":1}');
		expect(host.querySelector('#rpcn-bl-sample')).not.toBeNull();
		expect(live()).toBe('');
		await wait(RUN_DEBOUNCE_MS * 3);
		expect(runs().length - before).toBe(runOnChange ? 1 : 0);
	});

	it('REMOVED with no binary: the notice, not the no-binary state; back with no binary: the no-binary state', async () => {
		await render({ content: '{"a":1}' });
		await send({ ...REMOVED, binary: 'missing' });
		expect(region()).not.toBeNull();
		expect(host.querySelector('.rpcn-bl-nobin')).toBeNull();
		await send({ ...SNAPSHOT, binary: 'missing' });
		expect(region()).toBeNull();
		expect(host.querySelector('.rpcn-bl-nobin')).not.toBeNull();
		expect(runs()).toEqual([]);
	});

	it('REMOVED_BACK_OFF: removed, then back with Run on change off: the last result is gone, nothing stale shows', async () => {
		vi.useFakeTimers();
		await render({ content: '{"a":1}', runOnChange: false });
		await send(SNAPSHOT);
		await act(async () => host.querySelector<HTMLButtonElement>('.rpcn-bl-run')!.click());
		await send({ type: 'result', result: OK_B2, durationMs: 1, binary: null });
		expect(host.querySelector('.rpcn-bl-output')).not.toBeNull();
		await send(REMOVED);
		await send(SNAPSHOT);
		await wait(RUN_DEBOUNCE_MS * 3);
		expect(host.querySelector('.rpcn-bl-output')).toBeNull();
		expect(runs().length).toBe(1);
	});

	it('a recreated panel whose processor is removed does not run its restored input; it runs once it is back', async () => {
		vi.useFakeTimers();
		await render({ content: '{"a":1}' });
		await send(REMOVED);
		expect(runs()).toEqual([]);
		await send(SNAPSHOT);
		expect(runs()).toEqual([{ type: 'run', content: '{"a":1}', meta: {} }]);
	});
});

describe('Bloblang test panel: renamed config (4.17)', () => {
	const SAMPLE: BloblangSample = { name: 'one', content: '{"a":1}', meta: {} };

	it('RENAME: the snapshot\'s file and samples file names win over the page\'s', async () => {
		await render({ content: '{"a":1}' }, 'a.yaml', 'a.samples.json');
		await send({ ...SNAPSHOT, samples: [SAMPLE], selected: 'one' });
		expect(host.querySelector('.rpcn-bl-saved')?.textContent).toBe('Saved in a.samples.json');
		await send({ ...SNAPSHOT, samples: [SAMPLE], selected: 'one', fileName: 'b.yaml', samplesFile: 'b.samples.json' });
		expect(host.querySelector('.rpcn-bl-saved')?.textContent).toBe('Saved in b.samples.json');
		await send({ ...SNAPSHOT, samples: [SAMPLE], selected: 'one', fileName: 'b.yaml', samplesFile: 'b.samples.json', removed: true });
		expect(host.querySelector('[role="region"]')?.textContent).toBe(removedText('b.yaml'));
	});

	it('a snapshot without the names keeps the page\'s', async () => {
		await render({ content: '{"a":1}' }, 'a.yaml', 'a.samples.json');
		await send({ ...SNAPSHOT, samples: [SAMPLE], selected: 'one', removed: true });
		expect(host.querySelector('[role="region"]')?.textContent).toBe(removedText('a.yaml'));
	});
});
