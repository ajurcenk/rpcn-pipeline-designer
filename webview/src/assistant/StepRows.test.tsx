// @vitest-environment happy-dom
// Story 8.12: the step rows: each with its mark, label and short result; folded to one line on an
// earlier turn, which opens on click.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantStepView } from '../../../src/shared/assistantProtocol';
import { foldedText, StepRows } from './StepRows';

let host: HTMLDivElement;
let root: Root;
const STEPS: AssistantStepView[] = [
	{ id: 'p1', label: 'Started (claude-opus-5-5)', mark: 'info', result: '' },
	{ id: 's1', label: 'Checking with rpcn_check lint', mark: 'ok', result: '0 errors · 1 fixed' },
	{ id: 's2', label: 'Running a shell command: ls', mark: 'failed', result: 'The user denied this.' },
	{ id: 's3', label: 'Reading a.yaml', mark: 'running', result: '' },
];
const render = async (folded: boolean) => {
	await act(async () => {
		root.render(<StepRows steps={STEPS} folded={folded} />);
	});
};

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe('StepRows', () => {
	it('each row: its mark (named), its label and its result', async () => {
		await render(false);
		const rows = [...host.querySelectorAll('.rpcn-assistant-step')];
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-mark')?.getAttribute('aria-label') ?? null)).toEqual([null, 'ok', 'failed', 'running']);
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-mark')?.textContent)).toEqual(['·', '✓', '✗', '◌']);
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-label')?.textContent)).toEqual(STEPS.map((s) => s.label));
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-result')?.textContent ?? '')).toEqual(STEPS.map((s) => s.result));
	});

	it('folded: one line, which opens and closes on click', async () => {
		await render(true);
		expect(host.querySelector('.rpcn-assistant-step')).toBeNull();
		const line = host.querySelector('.rpcn-assistant-fold-line') as HTMLButtonElement;
		expect(line.textContent).toBe(`▸ ${foldedText(STEPS)}`);
		expect(foldedText(STEPS)).toBe('3 steps, 1 failed');
		expect(line.getAttribute('aria-expanded')).toBe('false');
		await act(async () => line.click());
		expect(host.querySelectorAll('.rpcn-assistant-step')).toHaveLength(4);
		expect(line.getAttribute('aria-expanded')).toBe('true');
		await act(async () => line.click());
		expect(host.querySelector('.rpcn-assistant-step')).toBeNull();
	});
});
