// @vitest-environment happy-dom
// Story 8.12: the step rows: each with its mark, label and short result; folded to one line on an
// earlier turn, which opens on click.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantStepView } from '../../../src/shared/assistantProtocol';
import { SKILL_READ_LABEL } from '../../../src/shared/assistantProtocol';
import { foldedText, StepRows, stepRows } from './StepRows';

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
		root.render(<StepRows steps={STEPS} folded={folded} outcome="running" />);
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
		// The failure the run went on past is a warning (!), not an error.
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-mark')?.getAttribute('aria-label') ?? null)).toEqual([null, 'ok', 'failed, the run went on', 'running']);
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-mark')?.textContent)).toEqual(['·', '✓', '!', '◌']);
		expect(host.querySelector('ol.rpcn-assistant-steps')).not.toBeNull();
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-label')?.textContent)).toEqual(STEPS.map((s) => s.label));
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-result')?.textContent ?? '')).toEqual(STEPS.map((s) => s.result));
	});

	it('folded: one line, which opens and closes on click', async () => {
		await render(true);
		expect(host.querySelector('.rpcn-assistant-step')).toBeNull();
		const line = host.querySelector('.rpcn-assistant-fold-line') as HTMLButtonElement;
		expect(line.textContent).toBe(`▸ ${foldedText(stepRows(STEPS, 'running'))}`);
		expect(foldedText(stepRows(STEPS, 'running'))).toBe('3 steps');
		expect(line.getAttribute('aria-expanded')).toBe('false');
		await act(async () => line.click());
		expect(host.querySelectorAll('.rpcn-assistant-step')).toHaveLength(4);
		expect(line.getAttribute('aria-expanded')).toBe('true');
		await act(async () => line.click());
		expect(host.querySelector('.rpcn-assistant-step')).toBeNull();
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
