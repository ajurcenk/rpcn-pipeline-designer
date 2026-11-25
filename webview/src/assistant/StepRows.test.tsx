// @vitest-environment happy-dom
// Story 8.12 (manual checks 1 and 2): the step rows: each with its mark, label, detail and short result;
// repeats grouped (and opened); while running the last 6 rows; once ended one summary line, which opens.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantOutcome, AssistantStepView } from '../../../src/shared/assistantProtocol';
import { SKILL_READ_LABEL } from '../../../src/shared/assistantProtocol';
import { foldedText, StepRows, stepRows } from './StepRows';

let host: HTMLDivElement;
let root: Root;
const STEPS: AssistantStepView[] = [
	{ id: 'p1', label: 'Started (claude-opus-5-5)', mark: 'info', result: '' },
	{ id: 's1', label: 'Checking with rpcn_check lint', mark: 'ok', result: '0 errors · 1 fixed' },
	{ id: 's2', label: 'Ran a shell command', detail: 'ls -la', mark: 'failed', result: 'denied' },
	{ id: 's3', label: 'Reading a.yaml', mark: 'running', result: '' },
];
const render = async (steps: readonly AssistantStepView[], outcome: AssistantOutcome) => {
	await act(async () => {
		root.render(<StepRows steps={steps} outcome={outcome} />);
	});
};
const click = async (el: Element) => {
	await act(async () => (el as HTMLElement).click());
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
	it('running: each row with its mark (named), its label, its detail (a shell command) and its result, in the card', async () => {
		await render(STEPS, 'running');
		const rows = [...host.querySelectorAll('.rpcn-assistant-step')];
		// The failure the run went on past is a warning (!), not an error.
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-mark')?.getAttribute('aria-label') ?? null)).toEqual([null, 'ok', 'failed, the run went on', 'running']);
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-mark')?.textContent)).toEqual(['·', '✓', '!', '◌']);
		expect(host.querySelector('ol.rpcn-assistant-steps')).not.toBeNull();
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-label')?.textContent)).toEqual(STEPS.map((s) => s.label));
		expect(rows[2].querySelector('.rpcn-assistant-step-detail')?.textContent).toBe('ls -la');
		expect(rows[2].querySelector('.rpcn-assistant-step-detail')?.getAttribute('title')).toBe('ls -la');
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-result')?.textContent ?? '')).toEqual(STEPS.map((s) => s.result));
	});

	it('running: at most the last 6 rows, under "… N earlier steps", which opens the rest', async () => {
		const many = Array.from({ length: 9 }, (_, i): AssistantStepView => ({ id: `s${i}`, label: `Reading f${i}.yaml`, mark: 'ok', result: '' }));
		await render(many, 'running');
		expect([...host.querySelectorAll('.rpcn-assistant-step-label')].map((l) => l.textContent)).toEqual(many.slice(3).map((s) => s.label));
		const line = host.querySelector('.rpcn-assistant-fold-line') as HTMLButtonElement;
		expect(line.textContent).toBe('… 3 earlier steps');
		await click(line);
		expect(host.querySelectorAll('.rpcn-assistant-step')).toHaveLength(9);
		expect(host.querySelector('.rpcn-assistant-fold-line')).toBeNull();
	});

	it('ended: one summary line (steps, warnings), which opens and closes on click; an error turn stays open', async () => {
		await render(STEPS, 'done');
		expect(host.querySelector('.rpcn-assistant-step')).toBeNull();
		const line = host.querySelector('.rpcn-assistant-fold-line') as HTMLButtonElement;
		expect(line.textContent).toBe('▸ 3 steps · 1 warning');
		expect(line.getAttribute('aria-expanded')).toBe('false');
		await click(line);
		expect(host.querySelectorAll('.rpcn-assistant-step')).toHaveLength(4);
		expect(line.getAttribute('aria-expanded')).toBe('true');
		await click(line);
		expect(host.querySelector('.rpcn-assistant-step')).toBeNull();
		await render(STEPS, 'error');
		expect(host.querySelector('.rpcn-assistant-fold-line')).toBeNull();
		expect(host.querySelectorAll('.rpcn-assistant-step')).toHaveLength(4);
		expect(foldedText(stepRows(STEPS, 'error'))).toBe('3 steps · 1 failed');
	});

	it('consecutive shell steps are one row "Ran a shell command ×N", which opens to each command with its mark and result', async () => {
		const shells = [1, 2, 3].map((i): AssistantStepView => ({ id: `b${i}`, label: 'Ran a shell command', detail: `cmd ${i}`, mark: i === 2 ? 'failed' : 'ok', result: i === 2 ? 'denied' : `r${i}` }));
		await render([...shells, { id: 'w', label: 'Writing a.design.md', mark: 'ok', result: 'written' }], 'error');
		const toggle = host.querySelector('.rpcn-assistant-step-toggle') as HTMLButtonElement;
		expect(toggle.querySelector('.rpcn-assistant-step-label')?.textContent).toBe('Ran a shell command ×3');
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(host.querySelector('.rpcn-assistant-step-members')).toBeNull();
		await click(toggle);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		const members = [...host.querySelectorAll('.rpcn-assistant-step-members > li')];
		expect(members.map((m) => [m.querySelector('.rpcn-assistant-step-label')?.textContent, m.querySelector('.rpcn-assistant-step-mark')?.textContent, m.querySelector('.rpcn-assistant-step-result')?.textContent])).toEqual([
			['cmd 1', '✓', 'r1'], ['cmd 2', '✗', 'denied'], ['cmd 3', '✓', 'r3'],
		]);
		expect(stepRows(shells, 'done')[0].mark).toBe('warning');
		expect(stepRows([...shells, shells[0]].map((s, i) => ({ ...s, id: `x${i}` })), 'done')[0].members.map((m) => m.mark)).toEqual(['ok', 'warning', 'ok', 'ok']);
	});

	const step = (id: string, label: string, mark: AssistantStepView['mark'] = 'ok', result = ''): AssistantStepView => ({ id, label, mark, result });

	it('consecutive steps with the same label are one row with a count: the worst mark (running > failed > ok), the last result', () => {
		const rows = stepRows([
			step('a', 'Checking with rpcn_check fields', 'ok', 'r1'), step('b', 'Checking with rpcn_check fields', 'failed', 'r2'), step('c', 'Checking with rpcn_check fields', 'ok', 'r3'),
			step('d', 'Checking with rpcn_check list'), step('e', 'Checking with rpcn_check list', 'running'),
			step('f', 'Checking with rpcn_check fields'),
		], 'running');
		expect(rows.map((r) => [r.label, r.mark, r.result, r.count])).toEqual([
			['Checking with rpcn_check fields ×3', 'warning', 'r3', 3],
			['Checking with rpcn_check list ×2', 'running', '', 2],
			['Checking with rpcn_check fields', 'ok', '', 1],
		]);
	});

	it('every skill read is one row "Read N skill references", where the first was', () => {
		const rows = stepRows([
			step('s', 'Running the rpcn-design skill'), step('r1', SKILL_READ_LABEL), step('c', 'Checking with rpcn_check binary'),
			step('r2', SKILL_READ_LABEL), step('r3', SKILL_READ_LABEL), step('c2', 'Checking with rpcn_check binary'),
		], 'done');
		expect(rows.map((r) => r.label)).toEqual(['Running the rpcn-design skill', 'Read 3 skill references', 'Checking with rpcn_check binary ×2']);
		expect(stepRows([step('r', SKILL_READ_LABEL)], 'done')[0].label).toBe('Read 1 skill reference');
	});

	it('a failed step keeps the error mark as the last step, or in a turn that ended in error; else a warning', () => {
		const steps = [step('h', 'Checking with rpcn_check hash', 'failed', 'Exit code 2'), step('w', 'Writing a.design.md')];
		expect(stepRows(steps, 'done').map((r) => r.mark)).toEqual(['warning', 'ok']);
		expect(stepRows(steps, 'error').map((r) => r.mark)).toEqual(['failed', 'ok']);
		expect(stepRows([steps[1], steps[0], step('i', 'Allowed', 'info')], 'done').map((r) => r.mark)).toEqual(['ok', 'failed', 'info']);
	});
});
