// @vitest-environment happy-dom
// The Bloblang test panel's view (ticket 4.2) in happy-dom: it posts `ready`, shows the snapshot,
// posts `run {content, meta: {}}` when the user types (after the pause) or presses Run, and shows each result.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BloblangHostMessage, BloblangWebviewMessage } from '../../../src/shared/bloblangProtocol';
import { DELETED_TEXT, EMPTY_TEXT, ERROR_TEXT, FAILED_TEXT, RUN_DEBOUNCE_MS, TestPanel } from './TestPanel';

let host: HTMLDivElement;
let root: Root;
let posted: BloblangWebviewMessage[];
let saved: string[];

const send = async (message: BloblangHostMessage | Record<string, unknown>) => {
	await act(async () => {
		window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(JSON.stringify(message)) }));
	});
};

async function render(initialInput = ''): Promise<void> {
	await act(async () => {
		root.render(<TestPanel post={(m) => posted.push(m)} initialInput={initialInput} saveInput={(i) => saved.push(i)} />);
	});
}

async function type(text: string): Promise<void> {
	const box = host.querySelector('textarea')!;
	await act(async () => {
		// React tracks the value through the native setter.
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
		box.dispatchEvent(new Event('input', { bubbles: true }));
	});
}

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

describe('Bloblang test panel (4.2)', () => {
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

	it('posts ready, then shows the snapshot\'s title, kind and Bloblang', async () => {
		await render();
		expect(posted).toEqual([{ type: 'ready' }]);
		await send(SNAPSHOT);
		expect(host.querySelector('h1')?.textContent).toBe('Bloblang: first');
		expect(host.querySelector('.rpcn-bl-kind')?.textContent).toBe('mapping');
		expect(host.querySelector('.rpcn-bl-source')?.textContent).toBe('root.b = this.a + 1');
		expect(runs()).toEqual([]);
	});

	it('RUN_OK: typing runs the input after the pause, once; the output, duration and binary show', async () => {
		vi.useFakeTimers();
		await render();
		await send(SNAPSHOT);
		await type('{"a"');
		await type('{"a":1}');
		expect(saved).toEqual(['{"a"', '{"a":1}']);
		expect(runs()).toEqual([]);
		await act(async () => {
			vi.advanceTimersByTime(RUN_DEBOUNCE_MS);
		});
		expect(runs()).toEqual([{ type: 'run', content: '{"a":1}', meta: {} }]);
		expect(host.textContent).toContain('Running…');
		await send({ type: 'result', result: OK_B2, durationMs: 212.4, binary: 'rpk connect 4.112.0' });
		expect(host.querySelector('.rpcn-bl-output')?.textContent).toBe('{"b":2}');
		expect(host.querySelector('.rpcn-bl-meta')?.textContent).toBe('212 ms · rpk connect 4.112.0');
		expect(host.textContent).not.toContain('Running…');
	});

	it('an empty input runs nothing and shows the empty state; a late result is dropped', async () => {
		vi.useFakeTimers();
		await render();
		await send(SNAPSHOT);
		await type('{"a":1}');
		await act(async () => {
			vi.advanceTimersByTime(RUN_DEBOUNCE_MS);
		});
		await send({ type: 'result', result: OK_B2, durationMs: 1, binary: null });
		await type('{"a":2}');
		await type('');
		await act(async () => {
			vi.advanceTimersByTime(RUN_DEBOUNCE_MS * 2);
		});
		expect(runs()).toEqual([{ type: 'run', content: '{"a":1}', meta: {} }]);
		expect(host.querySelector('.rpcn-bl-output')).toBeNull();
		expect(host.textContent).toContain(EMPTY_TEXT);
		expect(host.querySelector<HTMLButtonElement>('.rpcn-bl-run')!.disabled).toBe(true);
		await send({ type: 'result', result: { kind: 'failed', message: 'late' }, durationMs: 1, binary: null });
		expect(host.textContent).toContain(EMPTY_TEXT);
		expect(host.textContent).not.toContain('late');
	});

	it('a later snapshot (after an edit) replaces the shown Bloblang', async () => {
		await render();
		await send(SNAPSHOT);
		await send({ ...SNAPSHOT, source: 'root = deleted()' });
		expect(host.querySelector('.rpcn-bl-source')?.textContent).toBe('root = deleted()');
	});

	it('the Run button runs at once', async () => {
		await render('{"a":1}');
		await act(async () => host.querySelector<HTMLButtonElement>('.rpcn-bl-run')!.click());
		expect(runs()).toEqual([{ type: 'run', content: '{"a":1}', meta: {} }]);
	});

	it('a restored input runs once on the first snapshot', async () => {
		await render('{"a":2}');
		await send(SNAPSHOT);
		await send(SNAPSHOT);
		expect(runs()).toEqual([{ type: 'run', content: '{"a":2}', meta: {} }]);
		expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('{"a":2}');
	});

	it('RUN_FAILED, DELETED, RUN_ERROR: each result shows its own way; malformed messages are ignored', async () => {
		await render('{"a":1}');
		await send(SNAPSHOT);
		await send({ type: 'result', result: { kind: 'failed', message: 'failed assignment (line 1): x' }, durationMs: 1, binary: 'b' });
		expect(host.textContent).toContain(FAILED_TEXT);
		expect(host.querySelector('.rpcn-bl-message')?.textContent).toBe('failed assignment (line 1): x');
		await send({ type: 'result', result: { kind: 'deleted' }, durationMs: 1, binary: 'b' });
		expect(host.textContent).toContain(DELETED_TEXT);
		await send({ type: 'result', result: { kind: 'error', message: 'No Redpanda Connect binary.' }, durationMs: 0, binary: null });
		expect(host.textContent).toContain(ERROR_TEXT);
		expect(host.querySelector('.rpcn-bl-message')?.textContent).toBe('No Redpanda Connect binary.');
		expect(host.querySelector('.rpcn-bl-meta')?.textContent).toBe('0 ms');
		await send({ type: 'result', result: { kind: 'ok' }, durationMs: 1, binary: null });
		expect(host.textContent).toContain(ERROR_TEXT);
	});

	it('until 4.8: a parse error and an invalid input show in the could-not-run block; samples and binary messages change nothing', async () => {
		await render('{"a":1}');
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

	it.each(FIXTURE_NAMES)('FIXTURES: %s renders after a snapshot as the panel shows it today', async (name) => {
		const message = fixture(name);
		await render('{"a":1}');
		await send(SNAPSHOT);
		const before = host.innerHTML;
		await send(message);
		const result = message.result as { kind: string; content?: string; message?: string } | undefined;
		if (message.type !== 'result' || !result) {
			// snapshot replaces the header; samples and binary change nothing yet.
			if (message.type === 'snapshot') {
				expect(host.querySelector('h1')?.textContent).toBe(message.title);
				expect(host.querySelector('.rpcn-bl-source')?.textContent).toBe(message.source);
			} else {
				expect(host.innerHTML).toBe(before);
			}
			return;
		}
		switch (result.kind) {
			case 'ok':
				expect(host.querySelector('.rpcn-bl-output')?.textContent).toBe(result.content);
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
