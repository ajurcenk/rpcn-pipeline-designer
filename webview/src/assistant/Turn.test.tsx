// @vitest-environment happy-dom
// Story 8.12: one turn in option A's order: the user's message with its command highlighted, the rpcn
// header with the skill, the steps, the reply, the file rows, Keep, Undo and Open note, the chips (a
// disabled /build with its hint); Undone after Undo; the stopped line.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	KEEP_LABEL, OPEN_NOTE_LABEL, UNDO_LABEL, UNDONE_TEXT, type AssistantCommand, type AssistantTurnView, type AssistantWebviewMessage,
} from '../../../src/shared/assistantProtocol';
import { CopyContext } from './CopyButton';
import { COPY_REPLY_LABEL, SETTLE_ARM_MS, splitCommand, Turn } from './Turn';

let host: HTMLDivElement;
let root: Root;
let posted: AssistantWebviewMessage[];
let inserted: AssistantCommand[];

const DONE_TURN: AssistantTurnView = {
	id: 't1', command: 'design', text: '/design orders to an API', skill: 'rpcn-design',
	steps: [{ id: 's1', label: 'Running the rpcn-design skill', mark: 'ok', result: '' }],
	reply: 'The note is **ready**.',
	files: [{ path: 'orders.design.md', added: 12, removed: 0, created: true, tooLarge: false }],
	review: 'pending', note: { file: 'orders.design.md', status: 'ready' },
	actions: [{ id: 'openNote', label: OPEN_NOTE_LABEL, enabled: true, hint: null }],
	chips: [
		{ label: '/build', command: 'build', enabled: false, hint: 'Arrives with the Author stage' },
		{ label: '/test', command: 'test', enabled: false, hint: 'Arrives with the Test hand-off' },
	],
	outcome: 'done', notice: null, elapsedMs: 65_000, waitingMs: 500,
};
const render = async (turn: AssistantTurnView, latest = true) => {
	await act(async () => {
		root.render(
			<CopyContext.Provider value={(text) => posted.push({ type: 'copyText', text })}>
				<Turn turn={turn} latest={latest} error={null} post={(m) => posted.push(m)} insert={(c) => inserted.push(c)} />
			</CopyContext.Provider>,
		);
	});
};
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
const click = async (el: Element) => {
	await act(async () => (el as HTMLElement).click());
};

beforeEach(() => {
	posted = [];
	inserted = [];
	host = document.createElement('div');
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe('Turn', () => {
	it('HAPPY_DESIGN: the parts in order; "You" with its avatar; the command highlighted; the header\'s badge names the skill', async () => {
		await render(DONE_TURN);
		expect(host.querySelector('.rpcn-assistant-who')?.textContent).toBe('YouYou');
		expect(host.querySelector('.rpcn-assistant-avatar')?.getAttribute('aria-hidden')).toBe('true');
		expect(host.querySelector('.rpcn-assistant-command')?.textContent).toBe('/design');
		expect(host.querySelector('.rpcn-assistant-user')?.textContent).toBe('/design orders to an API');
		expect(host.querySelector('.rpcn-assistant-rpcn-header .rpcn-assistant-badge svg')).not.toBeNull();
		expect(host.querySelector('.rpcn-assistant-rpcn-header')?.textContent).toBe('rpcn· rpcn-design');
		// The note's file row shows its status badge.
		expect(host.querySelector('.rpcn-assistant-file .rpcn-assistant-status-ready')?.textContent).toBe('ready');
		const order = ['.rpcn-assistant-fold', '.rpcn-assistant-reply', '.rpcn-assistant-files', '.rpcn-assistant-actions', '.rpcn-assistant-chips']
			.map((sel) => host.querySelector(sel)!);
		for (let i = 1; i < order.length; i++) {
			expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		}
		expect(host.querySelector('.rpcn-assistant-reply strong')?.textContent).toBe('ready');
	});

	it('Keep, Undo, Open note and the file row post their messages; a disabled chip shows its hint', async () => {
		vi.useFakeTimers();
		try {
			await render(DONE_TURN);
			await act(async () => vi.advanceTimersByTime(SETTLE_ARM_MS));
		} finally {
			vi.useRealTimers();
		}
		await click(button(KEEP_LABEL)!);
		await click(button(UNDO_LABEL)!);
		await click(button(OPEN_NOTE_LABEL)!);
		await click(host.querySelector('.rpcn-assistant-file-open')!);
		expect(posted).toEqual([
			{ type: 'keepTurn', turn: 't1' }, { type: 'undoTurn', turn: 't1' }, { type: 'turnAction', turn: 't1', action: 'openNote' },
			{ type: 'openFileDiff', turn: 't1', path: 'orders.design.md' },
		]);
		const chip = button('/build')!;
		expect(chip.disabled).toBe(true);
		expect(chip.title).toBe('Arrives with the Author stage');
		await render({ ...DONE_TURN, chips: [{ ...DONE_TURN.chips[0], enabled: true }] });
		await click(button('/build')!);
		expect(inserted).toEqual(['build']);
	});

	it('KEEP: no buttons, the rows as text; UNDO: "Undone"; while running: no Keep, Undo or chips', async () => {
		await render({ ...DONE_TURN, review: 'kept' });
		expect(button(KEEP_LABEL)).toBeUndefined();
		expect(host.querySelector('.rpcn-assistant-file-open')).toBeNull();
		expect(host.querySelector('.rpcn-assistant-file-text')).not.toBeNull();
		await render({ ...DONE_TURN, review: 'undone', actions: [], chips: [] });
		expect(host.querySelector('.rpcn-assistant-undone')?.textContent).toBe(UNDONE_TEXT);
		expect(button(UNDO_LABEL)).toBeUndefined();
		await render({ ...DONE_TURN, outcome: 'running', review: 'none' });
		expect(button(KEEP_LABEL)).toBeUndefined();
		expect(button('/build')).toBeUndefined();
	});

	it('stopped: the muted line; an undo error: an alert; a reply link posts openLink', async () => {
		await render({ ...DONE_TURN, outcome: 'stopped', reply: 'See [docs](https://x.example)', notice: 'Could not undo a.yaml (EACCES).' });
		expect(host.querySelector('.rpcn-assistant-stopped')?.textContent).toBe('Stopped after 1m 5s. Nothing more was written.');
		expect(host.querySelector('[role="alert"]')?.textContent).toBe('Could not undo a.yaml (EACCES).');
		await click(host.querySelector('.rpcn-assistant-link')!);
		expect(posted.at(-1)).toEqual({ type: 'openLink', href: 'https://x.example' });
	});

	it('manual check 1: Keep and Undo take no click until they have shown for a moment (no stray settle as the run ends)', async () => {
		vi.useFakeTimers();
		try {
			await render({ ...DONE_TURN, outcome: 'running', review: 'none' });
			await render(DONE_TURN);
			await click(button(KEEP_LABEL)!);
			await click(button(UNDO_LABEL)!);
			expect(posted).toEqual([]);
			expect(button(KEEP_LABEL)!.getAttribute('aria-disabled')).toBe('true');
			await act(async () => vi.advanceTimersByTime(SETTLE_ARM_MS));
			expect(button(KEEP_LABEL)!.getAttribute('aria-disabled')).toBeNull();
			await click(button(KEEP_LABEL)!);
			expect(posted).toEqual([{ type: 'keepTurn', turn: 't1' }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('manual check 3: Copy reply copies the reply\'s Markdown source, then says Copied for a moment', async () => {
		vi.useFakeTimers();
		try {
			await render(DONE_TURN);
			const copy = host.querySelector(`button[aria-label="${COPY_REPLY_LABEL}"]`) as HTMLButtonElement;
			expect(copy.title).toBe(COPY_REPLY_LABEL);
			await click(copy);
			expect(posted).toEqual([{ type: 'copyText', text: 'The note is **ready**.' }]);
			expect(copy.getAttribute('aria-label')).toBe('Copied');
			expect(copy.textContent).toBe('Copied');
			await act(async () => vi.advanceTimersByTime(2000));
			expect(copy.getAttribute('aria-label')).toBe(COPY_REPLY_LABEL);
		} finally {
			vi.useRealTimers();
		}
	});

	it('manual check 4: a running turn\'s header clock ticks each second from the posted time; an ended one shows the total in its summary', async () => {
		vi.useFakeTimers();
		try {
			await render({ ...DONE_TURN, outcome: 'running', review: 'none', elapsedMs: 41_500 });
			const clock = () => host.querySelector('.rpcn-assistant-rpcn-header .rpcn-assistant-clock')?.textContent;
			expect(clock()).toBe('· 0:41');
			await act(async () => vi.advanceTimersByTime(1000));
			expect(clock()).toBe('· 0:42');
			await act(async () => vi.advanceTimersByTime(60_000));
			expect(clock()).toBe('· 1:42');
			// A new post resets the base.
			await render({ ...DONE_TURN, outcome: 'running', review: 'none', elapsedMs: 5_000 });
			expect(clock()).toBe('· 0:05');
		} finally {
			vi.useRealTimers();
		}
		await render(DONE_TURN);
		expect(host.querySelector('.rpcn-assistant-clock')).toBeNull();
		expect(host.querySelector('.rpcn-assistant-fold-line')?.textContent).toBe('▸ 1 step · 1m 5s');
		await render({ ...DONE_TURN, outcome: 'error' });
		expect(host.querySelector('.rpcn-assistant-time')?.textContent).toBe('Failed after 1m 5s.');
	});

	it('PLAIN: a message with no command shows as typed, nothing highlighted', async () => {
		await render({ ...DONE_TURN, text: 'orders to an API' });
		expect(host.querySelector('.rpcn-assistant-command')).toBeNull();
		expect(host.querySelector('.rpcn-assistant-user')?.textContent).toBe('orders to an API');
		expect(splitCommand('/designer x')).toEqual({ command: null, rest: '/designer x' });
	});
});
