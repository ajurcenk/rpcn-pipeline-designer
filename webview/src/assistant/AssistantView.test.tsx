// @vitest-environment happy-dom
// The RPCN AI Assistant's view (story 8.1; story 8.12: the chat) in happy-dom: it posts `ready`; the
// header, New conversation and the stage strip; the states a request cannot start in, as a panel in the
// transcript (no access with its set-up button, no binary, no folder, the runtime's, the skills path's);
// the composer posts the message and stays while a run goes, with Stop; the question cards in the current
// turn (the pick first and chosen, an Other text answer, Send answers posting each card's answer by
// question); story 8.5: the approval cards in the turn (Allow once, Allow for this session with its key,
// Deny; "This command always asks."; focus; Escape is Deny; one card per approval; a withdrawn one goes);
// the stopped and error lines in the turn; malformed messages ignored. The protocol's parsers too.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	INSTALL_RUNTIME_LABEL, RETRY_LABEL, RUNTIME_INSTALLING_TEXT, RUNTIME_MISSING_TEXT, runtimeFailedText, runtimeOutdatedText, UPDATE_RUNTIME_LABEL,
	BAD_BASE_URL_TEXT, BAD_SKILLS_PATH_TEXT, BAD_SKILLS_PATH_TEXTS, BASE_URL_CHANGED_TEXT, LOCAL_SKILLS_TEXT, unavailableText, NO_UV_TEXT, OPEN_SETTINGS_LABEL,
	NO_ACCESS_TEXT, NO_BINARY_TEXT, NO_WORKSPACE_TEXT, orderOptions, stoppedText, parseAssistantHostMessage, parseAssistantWebviewMessage, SET_UP_ACCESS_LABEL, STOPPED_TEXT,
	NEW_CONVERSATION_LABEL, ALLOW_ONCE_LABEL, allowSessionLabel, ALWAYS_ASKS_TEXT, COPY_COMMAND_LABEL, COPY_PATH_LABEL, DENY_LABEL, type AssistantApprovalView, type AssistantStateMessage, type AssistantTurnView, type AssistantWebviewMessage,
} from '../../../src/shared/assistantProtocol';
import { AssistantView, HEADER_TITLE, SEND_ANSWERS_LABEL } from './AssistantView';
import { approvalLead } from './ApprovalCard';
import { SEND_LABEL as RUN_LABEL, STOP_LABEL } from './Composer';

let host: HTMLDivElement;
let root: Root;
let posted: AssistantWebviewMessage[];

const IDLE: AssistantStateMessage = {
	type: 'state', access: 'ready', platform: null, runtime: { pinned: '0.3.329', installed: null, error: null }, skills: 'bundled', skillsProblem: null, status: 'idle',
	turns: [], folder: 'ws', designReady: false, questions: null, error: null,
};
const TURN: AssistantTurnView = {
	id: 't1', command: 'design', text: 'orders to an API', skill: 'rpcn-design',
	steps: [{ id: 's1', label: 'Running the rpcn-design skill', mark: 'ok', result: '' }, { id: 's2', label: 'Checking with rpcn_check binary', mark: 'running', result: '' }],
	reply: '', files: [], review: 'none', note: null, actions: [], chips: [], outcome: 'running', notice: null, elapsedMs: 0, waitingMs: 0, approvals: [],
};
const QUESTIONS: AssistantStateMessage = {
	...IDLE, status: 'question', turns: [TURN],
	questions: {
		id: 'q1',
		questions: [
			{ question: 'Ordering?', header: 'Ordering', multiSelect: false, options: orderOptions([{ label: 'Per customer_id', description: 'Per key' }, { label: 'No ordering (My pick)', description: 'Fastest' }]) },
			{ question: 'Duplicates?', header: 'Duplicates', multiSelect: false, options: orderOptions([{ label: 'No dedupe (My pick)', description: '' }, { label: 'Dedupe on order id', description: '' }]) },
		],
	},
};

const send = async (message: unknown) => {
	await act(async () => {
		window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(JSON.stringify(message)) }));
	});
};
const buttons = () => [...host.querySelectorAll('button')];
const button = (text: string) => buttons().find((b) => b.textContent === text || b.getAttribute('aria-label') === text) as HTMLButtonElement | undefined;
const click = async (el: Element) => {
	await act(async () => {
		(el as HTMLElement).click();
	});
};
const type = async (el: HTMLInputElement | HTMLTextAreaElement, text: string) => {
	await act(async () => {
		const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text);
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
};

beforeEach(async () => {
	posted = [];
	host = document.createElement('div');
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root.render(<AssistantView post={(m) => posted.push(m)} />);
	});
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe('AssistantView', () => {
	it('posts ready and shows nothing but the title before the host answers', () => {
		expect(posted).toEqual([{ type: 'ready' }]);
		expect(host.querySelector('h1')?.textContent).toBe(HEADER_TITLE);
		expect(host.querySelector('textarea')).toBeNull();
	});

	it('story 8.12: the stage strip with the folder; Design ✓ once the note is ready; New conversation once a turn is there', async () => {
		await send(IDLE);
		expect([...host.querySelectorAll('.rpcn-assistant-stage')].map((l) => l.textContent)).toEqual(['Design', 'Author', 'Test']);
		expect(host.querySelector('.rpcn-assistant-folder')?.textContent).toBe('ws');
		expect(button(NEW_CONVERSATION_LABEL)).toBeUndefined();
		await send({ ...IDLE, status: 'done', designReady: true, turns: [{ ...TURN, outcome: 'done' }] });
		expect(host.querySelector('.rpcn-assistant-stage-done')?.textContent).toBe('✓ Design');
		// An icon button (option A's "+"), named by its label and title.
		expect(button(NEW_CONVERSATION_LABEL)?.title).toBe(NEW_CONVERSATION_LABEL);
		expect(button(NEW_CONVERSATION_LABEL)?.querySelector('svg')).not.toBeNull();
		await click(button(NEW_CONVERSATION_LABEL)!);
		expect(posted.at(-1)).toEqual({ type: 'newConversation' });
	});

	it('no access: says so and offers the set-up, which posts its request; no request box', async () => {
		await send({ ...IDLE, access: 'noAccess' });
		expect(host.querySelector('.rpcn-assistant-state-body')?.textContent).toBe(NO_ACCESS_TEXT);
		expect(host.querySelector('textarea')).toBeNull();
		await click(button(SET_UP_ACCESS_LABEL)!);
		expect(posted.at(-1)).toEqual({ type: 'setUpAccessRequested' });
	});

	it('no binary and no folder: their texts, no button', async () => {
		await send({ ...IDLE, access: 'noBinary' });
		expect(host.querySelector('.rpcn-assistant-state-body')?.textContent).toBe(NO_BINARY_TEXT);
		expect(buttons()).toHaveLength(0);
		await send({ ...IDLE, access: 'noWorkspace' });
		expect(host.querySelector('.rpcn-assistant-state-body')?.textContent).toBe(NO_WORKSPACE_TEXT);
	});

	it('the composer posts the trimmed message as design; Send is off while empty; while a run goes Send becomes Stop', async () => {
		await send(IDLE);
		expect(button(RUN_LABEL)?.disabled).toBe(true);
		await type(host.querySelector('textarea')!, '  orders to an API  ');
		expect(button(RUN_LABEL)?.disabled).toBe(false);
		await click(button(RUN_LABEL)!);
		expect(posted.at(-1)).toEqual({ type: 'runRequested', command: 'design', request: 'orders to an API' });
		await send({ ...IDLE, status: 'running', turns: [TURN] });
		expect(button(RUN_LABEL)).toBeUndefined();
		expect(host.querySelector('textarea')).not.toBeNull();
		expect(host.querySelector('.rpcn-assistant-user')?.textContent).toBe('orders to an API');
		expect([...host.querySelectorAll('.rpcn-assistant-step-label')].map((l) => l.textContent)).toEqual(['Running the rpcn-design skill', 'Checking with rpcn_check binary']);
		await click(button(STOP_LABEL)!);
		expect(posted.at(-1)).toEqual({ type: 'stopRequested' });
	});

	it('question cards in the current turn: the pick first and chosen; Send answers posts each card\'s answer by question', async () => {
		await send(QUESTIONS);
		expect(host.querySelector('.rpcn-assistant-turn .rpcn-assistant-questions')).not.toBeNull();
		const cards = [...host.querySelectorAll('.rpcn-assistant-card')];
		expect(cards.map((c) => c.querySelector('legend')?.textContent)).toEqual(['Ordering', 'Duplicates']);
		const labels = (card: Element) => [...card.querySelectorAll('.rpcn-assistant-option-label')].map((l) => l.textContent);
		expect(labels(cards[0])).toEqual(['No ordering (My pick)', 'Per customer_id', 'Other']);
		expect((cards[0].querySelector('input[value="No ordering (My pick)"]') as HTMLInputElement).checked).toBe(true);
		expect(cards[0].querySelector('.rpcn-assistant-pick')).not.toBeNull();
		expect(button(SEND_ANSWERS_LABEL)?.disabled).toBe(false);
		await click(button(SEND_ANSWERS_LABEL)!);
		expect(posted.at(-1)).toEqual({ type: 'answered', id: 'q1', answers: ['No ordering (My pick)', 'No dedupe (My pick)'] });
	});

	it('another option, and Other with its text; Other without text cannot be sent', async () => {
		await send(QUESTIONS);
		const cards = [...host.querySelectorAll('.rpcn-assistant-card')];
		await click(cards[0].querySelector('input[value="Per customer_id"]')!);
		await click(cards[1].querySelector('input[value="Other"]')!);
		expect(button(SEND_ANSWERS_LABEL)?.disabled).toBe(true);
		await type(cards[1].querySelector('.rpcn-assistant-other-text') as HTMLInputElement, 'Dedupe on order id and day');
		expect(button(SEND_ANSWERS_LABEL)?.disabled).toBe(false);
		await click(button(SEND_ANSWERS_LABEL)!);
		expect(posted.at(-1)).toEqual({ type: 'answered', id: 'q1', answers: ['Per customer_id', 'Dedupe on order id and day'] });
	});

	describe('story 8.5: the approval cards', () => {
		const PIPE: AssistantApprovalView = {
			id: 'approval-1', summary: 'run `rpk connect list | python3 -I -c …`', detail: 'rpk connect list --format jsonschema 2>/dev/null | python3 -I -c "…"', sessionKey: 'rpk connect list | python3',
			stepId: null, write: false,
		};
		const CHAINED: AssistantApprovalView = { id: 'approval-2', summary: 'run `uv run x; rm y`', detail: 'uv run x; rm y', sessionKey: null, stepId: null, write: false };
		const cardEls = () => [...host.querySelectorAll('.rpcn-assistant-turn .rpcn-assistant-approval')] as HTMLElement[];
		const within = (el: Element, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === text || b.getAttribute('aria-label') === text) as HTMLButtonElement | undefined;

		it('a card in the turn (after the steps when it has no row): the summary, the full command with Copy command, Allow once, Allow `<key>` for this session, Deny; focus moves to it', async () => {
			await send({ ...IDLE, status: 'approval', turns: [{ ...TURN, approvals: [PIPE] }] });
			const [card] = cardEls();
			expect(card).toBeDefined();
			expect(host.querySelector('.rpcn-assistant-waiting')).toBeNull();
			expect(card.querySelector('.rpcn-assistant-approval-summary')?.textContent).toBe(approvalLead(PIPE.summary));
			expect(card.querySelector('pre')?.textContent).toBe(PIPE.detail);
			expect(within(card, COPY_COMMAND_LABEL)).toBeDefined();
			expect(card.querySelector('.rpcn-assistant-approval-always')).toBeNull();
			const session = within(card, allowSessionLabel('rpk connect list | python3'))!;
			expect(session.textContent).toBe('Allow rpk connect list | python3 for this session');
			expect(session.querySelector('code')?.textContent).toBe('rpk connect list | python3');
			expect(document.activeElement).toBe(card);
			// The steps come first, then the card.
			const turnEl = host.querySelector('.rpcn-assistant-turn')!;
			const steps = turnEl.querySelector('.rpcn-assistant-steps')!;
			expect(steps.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			await click(within(card, ALLOW_ONCE_LABEL)!);
			expect(posted.at(-1)).toEqual({ type: 'approvalDecided', id: PIPE.id, decision: 'once' });
			await click(session);
			expect(posted.at(-1)).toEqual({ type: 'approvalDecided', id: PIPE.id, decision: 'session' });
			await click(within(card, DENY_LABEL)!);
			expect(posted.at(-1)).toEqual({ type: 'approvalDecided', id: PIPE.id, decision: 'deny' });
			await click(within(card, COPY_COMMAND_LABEL)!);
			expect(posted.at(-1)).toEqual({ type: 'copyText', text: PIPE.detail });
		});

		it('under its own step row (s1, not the last row), inside a group under the group row; a card whose row is not shown comes after the rows', async () => {
			const steps = [
				{ id: 's1', label: 'Ran a shell command', mark: 'running' as const, result: '' },
				{ id: 's2', label: 'Writing a.yaml', mark: 'ok' as const, result: 'written' },
			];
			await send({ ...IDLE, status: 'approval', turns: [{ ...TURN, steps, approvals: [{ ...PIPE, stepId: 's1' }] }] });
			const list = host.querySelector('.rpcn-assistant-steps')!;
			const items = [...list.children];
			expect(items.map((li) => li.className.split(' ')[0])).toEqual(['rpcn-assistant-step', 'rpcn-assistant-step-cards', 'rpcn-assistant-step']);
			expect(items[1].querySelector('.rpcn-assistant-approval')?.getAttribute('data-approval')).toBe(PIPE.id);
			// A group: two shell steps are one row; the card goes under the group's row.
			const grouped = [steps[0], { ...steps[0], id: 's3', mark: 'running' as const }];
			await send({ ...IDLE, status: 'approval', turns: [{ ...TURN, steps: grouped, approvals: [{ ...PIPE, stepId: 's3' }] }] });
			const group = host.querySelector('.rpcn-assistant-step-group')!;
			expect(group.querySelector(':scope > .rpcn-assistant-step-cards .rpcn-assistant-approval')).not.toBeNull();
			// No such row: after the rows.
			await send({ ...IDLE, status: 'approval', turns: [{ ...TURN, steps, approvals: [{ ...PIPE, stepId: 'gone' }] }] });
			const after = host.querySelector('.rpcn-assistant-steps + .rpcn-assistant-approvals');
			expect(after?.querySelector('.rpcn-assistant-approval')).not.toBeNull();
		});

		it('focus: taken only when nothing has it; never from the composer or an earlier card', async () => {
			await send(IDLE);
			const composer = host.querySelector('textarea')!;
			composer.focus();
			await send({ ...IDLE, status: 'approval', turns: [{ ...TURN, approvals: [PIPE] }] });
			expect(document.activeElement).toBe(composer);
			composer.blur();
			await send({ ...IDLE, status: 'approval', turns: [{ ...TURN, approvals: [] }] });
			await send({ ...IDLE, status: 'approval', turns: [{ ...TURN, approvals: [PIPE] }] });
			const [first] = cardEls();
			expect(document.activeElement).toBe(first);
			await send({ ...IDLE, status: 'approval', turns: [{ ...TURN, approvals: [PIPE, CHAINED] }] });
			expect(document.activeElement).toBe(first);
		});

		it('a write card copies its path (Copy path)', async () => {
			await send({ ...IDLE, status: 'approval', turns: [{ ...TURN, approvals: [{ id: 'approval-3', summary: 'write /w/a.yaml', detail: '/w/a.yaml', sessionKey: 'Write', stepId: null, write: true }] }] });
			const [card] = cardEls();
			expect(within(card, COPY_COMMAND_LABEL)).toBeUndefined();
			await click(within(card, COPY_PATH_LABEL)!);
			expect(posted.at(-1)).toEqual({ type: 'copyText', text: '/w/a.yaml' });
		});

		it('no key: no session choice, "This command always asks."', async () => {
			await send({ ...IDLE, status: 'approval', turns: [{ ...TURN, approvals: [CHAINED] }] });
			const [card] = cardEls();
			expect(card.querySelector('.rpcn-assistant-approval-always')?.textContent).toBe(ALWAYS_ASKS_TEXT);
			expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['', ALLOW_ONCE_LABEL, DENY_LABEL]);
			expect(card.querySelector('.rpcn-assistant-allow-session')).toBeNull();
		});

		it('Escape on a card is Deny (from the card or one of its buttons)', async () => {
			await send({ ...IDLE, status: 'approval', turns: [{ ...TURN, approvals: [PIPE] }] });
			const [card] = cardEls();
			await act(async () => {
				card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			});
			expect(posted.at(-1)).toEqual({ type: 'approvalDecided', id: PIPE.id, decision: 'deny' });
			posted.length = 0;
			await act(async () => {
				within(card, ALLOW_ONCE_LABEL)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			});
			expect(posted).toEqual([{ type: 'approvalDecided', id: PIPE.id, decision: 'deny' }]);
		});

		it('two open: two cards, each deciding its own; a withdrawn one\'s card goes', async () => {
			await send({ ...IDLE, status: 'approval', turns: [{ ...TURN, approvals: [PIPE, CHAINED] }] });
			expect(cardEls().map((c) => c.dataset.approval)).toEqual([PIPE.id, CHAINED.id]);
			await click(within(cardEls()[1], DENY_LABEL)!);
			expect(posted.at(-1)).toEqual({ type: 'approvalDecided', id: CHAINED.id, decision: 'deny' });
			await send({ ...IDLE, status: 'approval', turns: [{ ...TURN, approvals: [PIPE] }] });
			expect(cardEls().map((c) => c.dataset.approval)).toEqual([PIPE.id]);
			await send({ ...IDLE, status: 'running', turns: [TURN] });
			expect(cardEls()).toEqual([]);
		});
	});

	it('in the turn: the stopped line; the error line (alone without a turn)', async () => {
		await send({ ...IDLE, status: 'stopped', turns: [{ ...TURN, outcome: 'stopped' }] });
		expect(host.querySelector('.rpcn-assistant-turn .rpcn-assistant-stopped')?.textContent).toBe(stoppedText(0));
		expect(STOPPED_TEXT).toBe('Stopped. Nothing more was written.');
		await send({ ...IDLE, status: 'error', error: 'API Error: 401 •••••', turns: [{ ...TURN, outcome: 'error' }] });
		expect(host.querySelector('.rpcn-assistant-turn [role="alert"]')?.textContent).toBe('API Error: 401 •••••');
		await send({ ...IDLE, status: 'error', error: 'boom' });
		expect(host.querySelector('[role="alert"]')?.textContent).toBe('boom');
	});

	it('review 20: two cards with the same text are answered each by its own index', async () => {
		const same = { question: 'Same?', header: 'Same', multiSelect: false, options: orderOptions([{ label: 'a (My pick)', description: '' }, { label: 'b', description: '' }]) };
		await send({ ...QUESTIONS, questions: { id: 'q2', questions: [same, same] } });
		const cards = [...host.querySelectorAll('.rpcn-assistant-card')];
		await click(cards[1].querySelector('input[value="b"]')!);
		expect((cards[0].querySelector('input[value="a (My pick)"]') as HTMLInputElement).checked).toBe(true);
		await click(button(SEND_ANSWERS_LABEL)!);
		expect(posted.at(-1)).toEqual({ type: 'answered', id: 'q2', answers: ['a (My pick)', 'b'] });
	});

	it('review 4: Stop stays while a run goes, whatever the access says', async () => {
		await send({ ...IDLE, status: 'question', access: 'noAccess', turns: [TURN], questions: QUESTIONS.questions });
		expect(host.querySelector('.rpcn-assistant-state-body')?.textContent).toBe(NO_ACCESS_TEXT);
		expect(button(STOP_LABEL)).toBeDefined();
		await click(button(STOP_LABEL)!);
		expect(posted.at(-1)).toEqual({ type: 'stopRequested' });
		await send({ ...IDLE, status: 'stopped', access: 'noAccess' });
		expect(button(STOP_LABEL)).toBeUndefined();
		expect(host.querySelector('textarea')).toBeNull();
	});

	it('review 3, 7, 15: a bad base URL offers Open settings; a changed one the set-up; no uv its text', async () => {
		await send({ ...IDLE, access: 'badBaseUrl' });
		expect(host.querySelector('.rpcn-assistant-state-body')?.textContent).toBe(BAD_BASE_URL_TEXT);
		await click(button(OPEN_SETTINGS_LABEL)!);
		expect(posted.at(-1)).toEqual({ type: 'openSettingsRequested' });
		await send({ ...IDLE, access: 'baseUrlChanged' });
		expect(host.querySelector('.rpcn-assistant-state-body')?.textContent).toBe(BASE_URL_CHANGED_TEXT);
		await click(button(SET_UP_ACCESS_LABEL)!);
		expect(posted.at(-1)).toEqual({ type: 'setUpAccessRequested' });
		await send({ ...IDLE, access: 'noUv' });
		expect(host.querySelector('.rpcn-assistant-state-body')?.textContent).toBe(NO_UV_TEXT);
		expect(buttons()).toHaveLength(0);
	});

	it('story 8.2: unavailable names the platform, with no button and no request box; nothing to start', async () => {
		await send({ ...IDLE, access: 'unavailable', platform: 'win32-arm64' });
		expect(host.querySelector('.rpcn-assistant-state-body')?.textContent).toBe(unavailableText('win32-arm64'));
		expect(host.querySelector('.rpcn-assistant-state-body')?.textContent)
			.toBe('The RPCN AI Assistant isn\'t available for win32-arm64 yet: Anthropic publishes no Claude Code binary package for it.');
		expect(buttons()).toHaveLength(0);
		expect(host.querySelector('textarea')).toBeNull();
		expect(host.querySelector('.rpcn-assistant-skills')).toBeNull();
	});

	it('story 8.2: no runtime: the text and Install assistant runtime…; installing: no button; no request box', async () => {
		await send({ ...IDLE, access: 'runtimeMissing' });
		expect(host.querySelector('.rpcn-assistant-state-body')?.textContent).toBe(RUNTIME_MISSING_TEXT);
		expect(RUNTIME_MISSING_TEXT).toContain('Anthropic\'s Claude Agent SDK');
		expect(host.querySelector('textarea')).toBeNull();
		await click(button(INSTALL_RUNTIME_LABEL)!);
		expect(posted.at(-1)).toEqual({ type: 'installRuntimeRequested' });
		await send({ ...IDLE, access: 'runtimeInstalling' });
		expect(host.querySelector('.rpcn-assistant-state-body')?.textContent).toBe(RUNTIME_INSTALLING_TEXT);
		expect(buttons()).toHaveLength(0);
	});

	it('story 8.2: outdated names both versions with Update; failed shows the reason with Retry', async () => {
		await send({ ...IDLE, access: 'runtimeOutdated', runtime: { pinned: '0.3.330', installed: '0.3.329', error: null } });
		expect(host.querySelector('.rpcn-assistant-state-body')?.textContent).toBe(runtimeOutdatedText('0.3.329', '0.3.330'));
		expect(host.querySelector('.rpcn-assistant-state-body')?.textContent).toContain('0.3.329');
		await click(button(UPDATE_RUNTIME_LABEL)!);
		expect(posted.at(-1)).toEqual({ type: 'updateRuntimeRequested' });
		await send({ ...IDLE, access: 'runtimeFailed', runtime: { pinned: '0.3.329', installed: null, error: 'x didn\'t match the expected integrity; nothing was unpacked' } });
		expect(host.querySelector('.rpcn-assistant-state-body')?.textContent)
			.toBe('The assistant runtime couldn\'t be installed: x didn\'t match the expected integrity; nothing was unpacked.');
		expect(runtimeFailedText(null)).toBe('The assistant runtime couldn\'t be installed: unknown error.');
		await click(button(RETRY_LABEL)!);
		expect(posted.at(-1)).toEqual({ type: 'installRuntimeRequested' });
	});

	it('story 8.2: a bad skills path offers Open settings; a valid one shows "Skills: local copy"', async () => {
		await send({ ...IDLE, access: 'badSkillsPath' });
		expect(host.querySelector('.rpcn-assistant-state-body')?.textContent).toBe(BAD_SKILLS_PATH_TEXT);
		expect(host.querySelector('textarea')).toBeNull();
		await click(button(OPEN_SETTINGS_LABEL)!);
		expect(posted.at(-1)).toEqual({ type: 'openSettingsRequested' });
		await send(IDLE);
		expect(host.querySelector('.rpcn-assistant-skills')).toBeNull();
		await send({ ...IDLE, skills: 'local' });
		expect(host.querySelector('.rpcn-assistant-skills')?.textContent).toBe(LOCAL_SKILLS_TEXT);
		expect(LOCAL_SKILLS_TEXT).toBe('Skills: local copy');
		expect(host.querySelector('textarea')).not.toBeNull();
	});

	it('review 1, 15: each bad skills path reason has its own text; no copy is named', async () => {
		const texts = new Set<string>();
		for (const problem of ['notAbsolute', 'notFound', 'notCheckout', 'inWorkspace'] as const) {
			await send({ ...IDLE, access: 'badSkillsPath', skills: null, skillsProblem: problem });
			const text = host.querySelector('.rpcn-assistant-state-body')?.textContent ?? '';
			expect(text).toBe(BAD_SKILLS_PATH_TEXTS[problem]);
			texts.add(text);
			expect(host.querySelector('.rpcn-assistant-skills')).toBeNull();
			expect(button(OPEN_SETTINGS_LABEL)).toBeDefined();
		}
		expect(texts.size).toBe(4);
		expect(BAD_SKILLS_PATH_TEXTS.inWorkspace).toMatch(/workspace/);
	});

	it('manual check 3: a copy with a selection in the view posts copyText (prevented); none: left alone; in the composer its selection', async () => {
		await send({ ...IDLE, status: 'done', turns: [{ ...TURN, outcome: 'done', reply: 'Hello **world**' }] });
		const copyEvent = () => {
			const e = new Event('copy', { bubbles: true, cancelable: true });
			document.dispatchEvent(e);
			return e;
		};
		window.getSelection()?.removeAllRanges();
		expect(copyEvent().defaultPrevented).toBe(false);
		expect(posted.some((m) => m.type === 'copyText')).toBe(false);
		const range = document.createRange();
		range.selectNodeContents(host.querySelector('.rpcn-assistant-user')!);
		window.getSelection()!.addRange(range);
		expect(copyEvent().defaultPrevented).toBe(true);
		expect(posted.at(-1)).toEqual({ type: 'copyText', text: 'orders to an API' });
		// A selection outside the view is left alone.
		const outside = document.createElement('p');
		outside.textContent = 'elsewhere';
		document.body.appendChild(outside);
		window.getSelection()!.removeAllRanges();
		const r2 = document.createRange();
		r2.selectNodeContents(outside);
		window.getSelection()!.addRange(r2);
		const before = posted.length;
		expect(copyEvent().defaultPrevented).toBe(false);
		expect(posted.length).toBe(before);
		outside.remove();
		window.getSelection()!.removeAllRanges();
		// The composer: its own selection.
		const area = host.querySelector('textarea')!;
		await type(area, 'copy this part');
		area.focus();
		area.setSelectionRange(5, 9);
		expect(copyEvent().defaultPrevented).toBe(true);
		expect(posted.at(-1)).toEqual({ type: 'copyText', text: 'this' });
	});

	it('ignores malformed messages', async () => {
		await send(IDLE);
		await send({ ...IDLE, access: 'nope' });
		await send({ type: 'state' });
		await send({ ...QUESTIONS, questions: { id: 'q', questions: [{ question: 1 }] } });
		expect(host.querySelector('textarea')).not.toBeNull();
		expect(host.querySelector('.rpcn-assistant-card')).toBeNull();
	});
});

describe('assistantProtocol', () => {
	it('orderOptions puts the pick first and marks it', () => {
		expect(orderOptions([{ label: 'a' }, { label: 'b (My pick)' }, { label: 'c' }])).toEqual([
			{ label: 'b (My pick)', pick: true }, { label: 'a', pick: false }, { label: 'c', pick: false },
		]);
	});

	it('parses webview messages field by field', () => {
		expect(parseAssistantWebviewMessage({ type: 'ready', extra: 1 })).toEqual({ type: 'ready' });
		expect(parseAssistantWebviewMessage({ type: 'runRequested', request: 'x' })).toEqual({ type: 'runRequested', command: 'design', request: 'x' });
		expect(parseAssistantWebviewMessage({ type: 'runRequested', command: 'build', request: '/build x' })).toEqual({ type: 'runRequested', command: 'build', request: '/build x' });
		expect(parseAssistantWebviewMessage({ type: 'runRequested', command: 'deploy', request: 'x' })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'openFileDiff', turn: 't1', path: 'a.yaml', extra: 1 })).toEqual({ type: 'openFileDiff', turn: 't1', path: 'a.yaml' });
		expect(parseAssistantWebviewMessage({ type: 'openFileDiff', turn: 't1' })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'keepTurn', turn: 't1' })).toEqual({ type: 'keepTurn', turn: 't1' });
		expect(parseAssistantWebviewMessage({ type: 'undoTurn', turn: 1 })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'turnAction', turn: 't1', action: 'openNote' })).toEqual({ type: 'turnAction', turn: 't1', action: 'openNote' });
		expect(parseAssistantWebviewMessage({ type: 'openLink', href: 'https://x' })).toEqual({ type: 'openLink', href: 'https://x' });
		expect(parseAssistantWebviewMessage({ type: 'newConversation' })).toEqual({ type: 'newConversation' });
		expect(parseAssistantWebviewMessage({ type: 'copyText', text: 'abc', extra: 1 })).toEqual({ type: 'copyText', text: 'abc' });
		expect(parseAssistantWebviewMessage({ type: 'copyText', text: '' })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'copyText', text: 'x'.repeat(100_001) })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'copyText', text: 1 })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'runRequested', request: '  ' })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'runRequested', request: 'x'.repeat(8001) })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'answered', id: 'q', answers: ['b', 'c'] })).toEqual({ type: 'answered', id: 'q', answers: ['b', 'c'] });
		expect(parseAssistantWebviewMessage({ type: 'answered', id: 'q', answers: ['b', 1] })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'answered', id: 'q', answers: { a: 'b' } })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'openSettingsRequested' })).toEqual({ type: 'openSettingsRequested' });
		expect(parseAssistantWebviewMessage({ type: 'approvalDecided', id: 'a', decision: 'session', extra: 1 })).toEqual({ type: 'approvalDecided', id: 'a', decision: 'session' });
		expect(parseAssistantWebviewMessage({ type: 'approvalDecided', id: 'a', decision: 'always' })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'approvalDecided', decision: 'deny' })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'nope' })).toBeUndefined();
		expect(parseAssistantWebviewMessage(null)).toBeUndefined();
	});

	it('parses host messages field by field', () => {
		expect(parseAssistantHostMessage({ ...QUESTIONS, extra: true })).toEqual(QUESTIONS);
		expect(parseAssistantHostMessage({ ...IDLE, turns: [{ ...TURN, steps: [{ id: 's', label: 'x', mark: 'nope', result: '' }] }] })).toBeUndefined();
		expect(parseAssistantHostMessage({ ...IDLE, turns: [{ ...TURN, note: { file: 'a' } }] })).toBeUndefined();
		expect(parseAssistantHostMessage({ ...IDLE, turns: [{ ...TURN, files: [{ path: 'a', added: -1, removed: 0, created: true, tooLarge: false }] }] })).toBeUndefined();
		expect(parseAssistantHostMessage({ ...IDLE, turns: [{ ...TURN, chips: [{ label: '/x', command: 'x', enabled: false, hint: null }] }] })).toBeUndefined();
		expect(parseAssistantHostMessage({ ...IDLE, designReady: 'yes' })).toBeUndefined();
		const card = { id: 'a', summary: 'run `ls`', detail: null, sessionKey: 'ls', stepId: 's1', write: false };
		expect(parseAssistantHostMessage({ ...IDLE, turns: [{ ...TURN, approvals: [{ ...card, extra: 1 }] }] })).toEqual({ ...IDLE, turns: [{ ...TURN, approvals: [card] }] });
		expect(parseAssistantHostMessage({ ...IDLE, turns: [{ ...TURN, approvals: [{ ...card, sessionKey: 1 }] }] })).toBeUndefined();
		const { approvals: _a, ...noApprovals } = TURN;
		expect(parseAssistantHostMessage({ ...IDLE, turns: [noApprovals] })).toBeUndefined();
		expect(parseAssistantHostMessage({ ...IDLE, turns: [TURN] })).toEqual({ ...IDLE, turns: [TURN] });
		const timed = { ...TURN, elapsedMs: 5, waitingMs: 2, steps: [{ ...TURN.steps[0], durationMs: 1200 }] };
		expect(parseAssistantHostMessage({ ...IDLE, turns: [timed] })).toEqual({ ...IDLE, turns: [timed] });
		expect(parseAssistantHostMessage({ ...IDLE, turns: [{ ...TURN, elapsedMs: -1 }] })).toBeUndefined();
		const { waitingMs: _w, ...noWaiting } = TURN;
		expect(parseAssistantHostMessage({ ...IDLE, turns: [noWaiting] })).toBeUndefined();
		expect(parseAssistantHostMessage({ ...IDLE, turns: [{ ...TURN, steps: [{ ...TURN.steps[0], durationMs: 'x' }] }] })).toBeUndefined();
		expect(parseAssistantHostMessage({ ...IDLE, status: 'nope' })).toBeUndefined();
		expect(parseAssistantHostMessage({ ...IDLE, access: 'unavailable', platform: 'darwin-x64' })).toEqual({ ...IDLE, access: 'unavailable', platform: 'darwin-x64' });
		for (const access of ['runtimeMissing', 'runtimeInstalling', 'runtimeOutdated', 'runtimeFailed'] as const) {
			expect(parseAssistantHostMessage({ ...IDLE, access })).toEqual({ ...IDLE, access });
		}
		expect(parseAssistantHostMessage({ ...IDLE, runtime: null })).toBeUndefined();
		expect(parseAssistantHostMessage({ ...IDLE, runtime: { pinned: 1, installed: null, error: null } })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'installRuntimeRequested' })).toEqual({ type: 'installRuntimeRequested' });
		expect(parseAssistantWebviewMessage({ type: 'updateRuntimeRequested', extra: 1 })).toEqual({ type: 'updateRuntimeRequested' });
		expect(parseAssistantHostMessage({ ...IDLE, skills: 'latest' })).toBeUndefined();
		expect(parseAssistantHostMessage({ ...IDLE, platform: 1 })).toBeUndefined();
		expect(parseAssistantHostMessage({ ...IDLE, access: 'badSkillsPath', skills: null, skillsProblem: 'inWorkspace' }))
			.toEqual({ ...IDLE, access: 'badSkillsPath', skills: null, skillsProblem: 'inWorkspace' });
		expect(parseAssistantHostMessage({ ...IDLE, skillsProblem: 'nope' })).toBeUndefined();
		expect(parseAssistantHostMessage({ ...IDLE, skillsProblem: 'toString' })).toBeUndefined();
		const { skills: _skills, ...noSkills } = IDLE;
		expect(parseAssistantHostMessage(noSkills)).toBeUndefined();
	});
});
