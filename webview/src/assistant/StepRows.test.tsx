// @vitest-environment happy-dom
// Story 8.12 (manual checks 1 and 2): the step rows: each with its mark, label, detail and short result;
// repeats grouped (and opened); while running the last 6 rows; once ended one summary line, which opens.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantOutcome, AssistantStepView } from '../../../src/shared/assistantProtocol';
import { SKILL_READ_LABEL } from '../../../src/shared/assistantProtocol';
import { CopyContext } from './CopyButton';
import { COPY_COMMAND_LABEL, foldedText, StepRows, stepRows } from './StepRows';

let host: HTMLDivElement;
let root: Root;
let copied: string[];
const STEPS: AssistantStepView[] = [
	{ id: 'p1', label: 'Started (claude-opus-5-5)', mark: 'info', result: '' },
	{ id: 's1', label: 'Checking with rpcn_check lint', mark: 'ok', result: '0 errors · 1 fixed' },
	{ id: 's2', label: 'Ran a shell command', detail: 'ls -la', mark: 'failed', result: '', approval: 'deny', approvalDetail: 'ls -la' },
	{ id: 's3', label: 'Reading a.yaml', mark: 'running', result: '' },
];
const render = async (steps: readonly AssistantStepView[], outcome: AssistantOutcome) => {
	await act(async () => {
		root.render(<CopyContext.Provider value={(t) => copied.push(t)}><StepRows steps={steps} outcome={outcome} /></CopyContext.Provider>);
	});
};
const click = async (el: Element) => {
	await act(async () => (el as HTMLElement).click());
};

beforeEach(() => {
	copied = [];
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
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-mark')?.textContent)).toEqual(['·', '✓', '!', '']);
		// Manual check (8.3): the running mark is the spinning codicon.
		expect(rows[3].querySelector('.rpcn-assistant-step-mark .codicon-loading.codicon-modifier-spin')).not.toBeNull();
		expect(host.querySelector('ol.rpcn-assistant-steps')).not.toBeNull();
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-label')?.textContent)).toEqual(STEPS.map((s) => s.label));
		expect(rows[2].querySelector('.rpcn-assistant-step-detail')?.textContent).toBe('ls -la');
		expect(rows[2].querySelector('.rpcn-assistant-step-detail')?.getAttribute('title')).toBe('ls -la');
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-result')?.textContent ?? '')).toEqual(['', '0 errors · 1 fixed', 'you denied', '']);
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
		expect(line.textContent).toBe('▸ 3 steps · 1 warning · 0s');
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
		const shells = [1, 2, 3].map((i): AssistantStepView => ({ id: `b${i}`, label: 'Ran a shell command', detail: `cmd ${i}`, mark: i === 2 ? 'failed' : 'ok', result: i === 2 ? '' : `r${i}`, ...(i === 2 ? { approval: 'deny' as const, approvalDetail: 'cmd 2 --all' } : {}) }));
		await render([...shells, { id: 'w', label: 'Writing a.design.md', mark: 'ok', result: 'written' }], 'error');
		const toggle = host.querySelector('.rpcn-assistant-step-toggle') as HTMLButtonElement;
		expect(toggle.querySelector('.rpcn-assistant-step-label')?.textContent).toBe('Ran a shell command ×3');
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(host.querySelector('.rpcn-assistant-step-members')).toBeNull();
		await click(toggle);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		const members = [...host.querySelectorAll('.rpcn-assistant-step-members > li')];
		expect(members.map((m) => [m.querySelector('.rpcn-assistant-step-detail')?.textContent, m.querySelector('.rpcn-assistant-step-mark')?.textContent, m.querySelector('.rpcn-assistant-step-result')?.textContent])).toEqual([
			['cmd 1', '✓', 'r1'], ['cmd 2', '✗', 'you denied'], ['cmd 3', '✓', 'r3'],
		]);
		// Manual check (8.3): the group shows "asked you" when a member was asked; the member its own, with what it asked about.
		expect(toggle.querySelector('.rpcn-assistant-step-asked')?.textContent).toBe('asked you');
		expect(members.map((m) => (m.querySelector('.rpcn-assistant-step-asked') as HTMLElement | null)?.title ?? null)).toEqual([null, 'cmd 2 --all', null]);
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

	it('manual check 3: an opened group shows each command as selectable text outside the toggle, with Copy command', async () => {
		const shells = [1, 2].map((i): AssistantStepView => ({ id: `b${i}`, label: 'Ran a shell command', detail: `rpk connect list ${i}`, mark: 'ok', result: '' }));
		await render(shells, 'error');
		await click(host.querySelector('.rpcn-assistant-step-toggle')!);
		const commands = [...host.querySelectorAll('.rpcn-assistant-step-members .rpcn-assistant-step-detail')];
		expect(commands.map((c) => c.textContent)).toEqual(['rpk connect list 1', 'rpk connect list 2']);
		expect(commands.every((c) => c.closest('button') === null)).toBe(true);
		const buttons = [...host.querySelectorAll(`.rpcn-assistant-step-members button[aria-label="${COPY_COMMAND_LABEL}"]`)];
		expect(buttons).toHaveLength(2);
		await click(buttons[1]);
		expect(copied).toEqual(['rpk connect list 2']);
		expect(buttons[1].getAttribute('aria-label')).toBe('Copied');
		// A single step with a command: the same, in its row.
		await render([shells[0]], 'error');
		await click(host.querySelector(`button[aria-label="${COPY_COMMAND_LABEL}"]`)!);
		expect(copied.at(-1)).toBe('rpk connect list 1');
	});

	it('manual check (8.3): approval outcomes: the four texts (with the step\'s own result after); "asked you" only where a card was decided, its tooltip what was asked', async () => {
		const asked: AssistantStepView[] = [
			{ id: 'a', label: 'Writing a.yaml', mark: 'ok', result: 'written', approval: 'once', approvalDetail: '/w/a.yaml', durationMs: 2_000 },
			{ id: 'b', label: 'Ran a shell command', detail: 'rpk connect list', mark: 'ok', result: '', approval: 'session' },
			{ id: 'c', label: 'Writing b.yaml', mark: 'failed', result: '', approval: 'deny', approvalDetail: '/w/b.yaml' },
			{ id: 'd', label: 'Reading c.yaml', mark: 'ok', result: '3 lines', approval: 'remembered' },
			{ id: 'e', label: 'Reading d.yaml', mark: 'ok', result: '2 lines' },
		];
		await render(asked, 'error');
		const rows = [...host.querySelectorAll('.rpcn-assistant-steps > li')];
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-result')?.textContent)).toEqual([
			'you allowed once · written', 'you allowed for this session', 'you denied', 'allowed by this session\'s approval · 3 lines', '2 lines',
		]);
		expect(rows.map((r) => (r.querySelector('.rpcn-assistant-step-asked') as HTMLElement | null)?.title ?? null)).toEqual(['/w/a.yaml', 'rpk connect list', '/w/b.yaml', null, null]);
		expect(rows[0].querySelector('.rpcn-assistant-step-time')?.textContent).toBe('2s');
		// A denied step keeps its failed mark (a warning when the run went on and did not end in error).
		expect(rows[2].querySelector('.rpcn-assistant-step-mark')?.getAttribute('aria-label')).toBe('failed');
		expect(stepRows(asked, 'done')[2].mark).toBe('warning');
	});

	it('manual check (8.3): every row keeps the short command, selectable, with no toggle and no auto-expansion (asked rows too); Copy command has it all', async () => {
		const full = 'python3 -I -c "\nimport json\nprint(1)\n"';
		const clipped = 'python3 -I -c " import json…';
		await render([
			{ id: 'b1', label: 'Ran a shell command', detail: clipped, fullDetail: full, mark: 'ok', result: '' },
			{ id: 'b2', label: 'Ran a shell command', detail: clipped, fullDetail: full, mark: 'ok', result: '', approval: 'once', approvalDetail: full },
		], 'error');
		await click(host.querySelector('.rpcn-assistant-step-toggle')!);
		const lines = [...host.querySelectorAll('.rpcn-assistant-step-members .rpcn-assistant-step-detail')] as HTMLElement[];
		expect(lines.map((l) => l.textContent)).toEqual([clipped, clipped]);
		expect(lines.every((l) => l.getAttribute('role') === null && l.closest('button') === null && l.title === full)).toBe(true);
		expect(host.querySelector('pre')).toBeNull();
		await click(lines[0]);
		expect(host.querySelector('pre')).toBeNull();
		await click(host.querySelectorAll(`.rpcn-assistant-step-members button[aria-label="${COPY_COMMAND_LABEL}"]`)[1]);
		expect(copied).toEqual([full]);
	});

	it('manual check (8.3): a question round: collapsed to its summary; it opens (click, Enter) to each question and the answer: kept, changed, Other, multi-select', async () => {
		const qa = [
			{ header: 'Ordering', question: 'How should records be ordered?', pick: 'No ordering (My pick)', answer: 'No ordering (My pick)', kept: true },
			{ header: 'Duplicates', question: 'Dedupe?', pick: 'No dedupe (My pick)', answer: 'Dedupe on order id', kept: false },
			{ header: 'Target', question: 'Which topic?', pick: 'orders (My pick)', answer: 'orders.v2 typed by me', kept: false },
			{ header: 'Outputs', question: 'Which outputs?', pick: 'HTTP (My pick)', answer: 'HTTP (My pick), Kafka', kept: false },
			{ header: '', question: 'Anything else?', pick: null, answer: 'no', kept: false },
		];
		await render([{ id: 'q1', label: 'Asked 5 questions · you kept 1 pick, answered 4', mark: 'ok', result: '', qa }], 'error');
		const toggle = host.querySelector('.rpcn-assistant-qa-toggle') as HTMLElement;
		expect(toggle.textContent).toBe('Asked 5 questions · you kept 1 pick, answered 4');
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(host.querySelector('.rpcn-assistant-qa')).toBeNull();
		await click(toggle);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		const items = [...host.querySelectorAll('.rpcn-assistant-qa-item')];
		expect(items.map((i) => i.querySelector('.rpcn-assistant-qa-question')?.textContent)).toEqual([
			'Ordering: How should records be ordered?', 'Duplicates: Dedupe?', 'Target: Which topic?', 'Outputs: Which outputs?', 'Anything else?',
		]);
		expect(items.map((i) => i.querySelector('.rpcn-assistant-qa-answer')?.textContent)).toEqual([
			'You: No ordering (my pick)', 'You: Dedupe on order id (my pick was: No dedupe)', 'You: orders.v2 typed by me (my pick was: orders)',
			'You: HTTP, Kafka (my pick was: HTTP)', 'You: no',
		]);
		await click(toggle);
		expect(host.querySelector('.rpcn-assistant-qa')).toBeNull();
		await act(async () => toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
		expect(host.querySelectorAll('.rpcn-assistant-qa-item')).toHaveLength(5);
	});

	it('manual check (8.3): a long multi-line command: the line stays clipped; the tooltip and Copy command have it all (no full field: the line)', async () => {
		const full = `python3 -I -c "\nimport json\nwith open('~/x/${'a'.repeat(300)}.json') as f:\n    print(json.load(f))\n"`;
		const clipped = `${full.replace(/\s+/g, ' ').slice(0, 199)}…`;
		await render([{ id: 'b1', label: 'Ran a shell command', detail: clipped, fullDetail: full, mark: 'ok', result: '' }], 'error');
		const code = host.querySelector('.rpcn-assistant-step-detail') as HTMLElement;
		expect(code.textContent).toBe(clipped);
		expect(code.title).toBe(full);
		await click(host.querySelector(`button[aria-label="${COPY_COMMAND_LABEL}"]`)!);
		expect(copied).toEqual([full]);
		await render([{ id: 'b2', label: 'Ran a shell command', detail: 'ls -la', mark: 'ok', result: '' }], 'error');
		await click(host.querySelector(`button[aria-label="${COPY_COMMAND_LABEL}"]`)!);
		expect(copied.at(-1)).toBe('ls -la');
	});

	it('manual check 4: a step\'s duration when 1s or more, muted at its end; a group shows its total', async () => {
		const timed: AssistantStepView[] = [
			{ id: 'a', label: 'Ran a shell command', detail: 'one', mark: 'ok', result: '', durationMs: 2_500 },
			{ id: 'b', label: 'Ran a shell command', detail: 'two', mark: 'ok', result: '', durationMs: 1_700 },
			{ id: 'c', label: 'Reading a.yaml', mark: 'ok', result: '3 lines', durationMs: 400 },
			{ id: 'd', label: 'Checking with rpcn_check lint', mark: 'ok', result: '0 errors', durationMs: 4_200 },
		];
		await render(timed, 'error');
		const rows = [...host.querySelectorAll('.rpcn-assistant-steps > li')];
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-step-time')?.textContent ?? '')).toEqual(['4s', '', '4s']);
		expect(rows[2].querySelector('.rpcn-assistant-step-result')?.textContent).toBe('0 errors');
		await click(host.querySelector('.rpcn-assistant-step-toggle')!);
		expect([...host.querySelectorAll('.rpcn-assistant-step-members .rpcn-assistant-step-time')].map((t) => t.textContent)).toEqual(['2s', '1s']);
	});
});
