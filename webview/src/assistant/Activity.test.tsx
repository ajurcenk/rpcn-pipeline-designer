// @vitest-environment happy-dom
// Manual check (8.3): the running turn's live activity line: each phase's text, the spinner, its own
// timer restarting at each change, no line while cards are open or once the turn ended; the reduced-motion rule.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantTurnView } from '../../../src/shared/assistantProtocol';
import { activityOf, THINKING_TEXT, WAITING_MODEL_TEXT } from './Activity';
import { Turn } from './Turn';

let host: HTMLDivElement;
let root: Root;
const TURN: AssistantTurnView = {
	id: 't1', command: 'design', text: 'orders', skill: 'rpcn-design', model: 'claude-opus-5-5', steps: [], reply: '', files: [], review: 'none', note: null,
	actions: [], chips: [], outcome: 'running', notice: null, elapsedMs: 0, waitingMs: 0, approvals: [],
};
const started = { id: 'p1', label: 'Started (claude-opus-5-5)', mark: 'info' as const, result: '' };
const render = async (turn: AssistantTurnView, live: boolean | null = null) => {
	await act(async () => {
		root.render(<Turn turn={turn} latest error={null} live={live ? <p className="live">cards</p> : null} post={() => undefined} insert={() => undefined} />);
	});
};
const line = () => host.querySelector('.rpcn-assistant-activity');

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
});

describe('the live activity line', () => {
	it('each phase: waiting for the model, a running tool step (its label, not the command), thinking between steps', () => {
		expect(activityOf(TURN, false)?.text).toBe(WAITING_MODEL_TEXT);
		expect(activityOf({ ...TURN, steps: [started] }, false)?.text).toBe(WAITING_MODEL_TEXT);
		const fields = { ...TURN, steps: [started, { id: 's1', label: 'Checking with rpcn_check fields', mark: 'running' as const, result: '' }] };
		expect(activityOf(fields, false)?.text).toBe('Checking with rpcn_check fields…');
		const shell = { ...TURN, steps: [{ id: 's2', label: 'Ran a shell command', detail: 'rpk connect list', mark: 'running' as const, result: '' }] };
		expect(activityOf(shell, false)?.text).toBe('Ran a shell command…');
		const between = { ...TURN, steps: [started, { id: 's1', label: 'Checking with rpcn_check fields', mark: 'ok' as const, result: 'ok' }] };
		expect(activityOf(between, false)?.text).toBe(THINKING_TEXT);
		expect(activityOf({ ...TURN, reply: 'Writing the note.' }, false)?.text).toBe(THINKING_TEXT);
		// Cards open (questions or an approval), or the turn ended: no line.
		expect(activityOf(fields, true)).toBeNull();
		expect(activityOf({ ...fields, approvals: [{ id: 'a', summary: 'run `ls`', detail: 'ls', sessionKey: 'ls', stepId: 's1', write: false }] }, false)).toBeNull();
		expect(activityOf({ ...between, outcome: 'done' }, false)).toBeNull();
	});

	it('in the running turn under the steps: the spinner, the text, its own timer (restarting at each change); gone with cards open and once ended', async () => {
		vi.useFakeTimers();
		await render({ ...TURN, steps: [started] });
		expect(line()?.querySelector('.codicon.codicon-loading.codicon-modifier-spin')).not.toBeNull();
		expect(line()?.querySelector('.rpcn-assistant-activity-text')?.textContent).toBe(WAITING_MODEL_TEXT);
		const time = () => line()?.querySelector('.rpcn-assistant-activity-time')?.textContent;
		expect(time()).toBe('0:00');
		await act(async () => vi.advanceTimersByTime(3_000));
		expect(time()).toBe('0:03');
		// Under the step card, before the live area.
		expect(line()?.previousElementSibling?.className).toMatch(/rpcn-assistant-(steps|fold)/);
		const step = { ...TURN, steps: [started, { id: 's1', label: 'Checking with rpcn_check lint', mark: 'running' as const, result: '' }] };
		await render(step);
		expect(line()?.textContent).toBe('Checking with rpcn_check lint…0:00');
		await act(async () => vi.advanceTimersByTime(2_000));
		// A new post of the same activity keeps its timer.
		await render({ ...step, elapsedMs: 5_000 });
		expect(time()).toBe('0:02');
		// The header's clock is still there.
		expect(host.querySelector('.rpcn-assistant-rpcn-header .rpcn-assistant-clock')).not.toBeNull();
		await render(step, true);
		expect(line()).toBeNull();
		expect(host.querySelector('.live')).not.toBeNull();
		await render({ ...step, outcome: 'done', steps: [started, { ...step.steps[1], mark: 'ok' }] });
		expect(line()).toBeNull();
	});

	it('reduced motion: the spin animation is off (the icon static); the timer is unaffected', () => {
		const css = readFileSync(join(process.cwd(), 'webview', 'src', 'assistant', 'assistant.css'), 'utf8');
		expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.rpcn-assistant \.codicon-modifier-spin \{\s*animation: none;/);
	});
});
