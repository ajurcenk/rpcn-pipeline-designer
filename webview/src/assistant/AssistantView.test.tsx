// @vitest-environment happy-dom
// The RPCN AI Assistant's plain view (story 8.1) in happy-dom: it posts `ready`; the states a request
// cannot start in (no access with its set-up button, no binary, no folder); the request box posts the
// request and is disabled while a run goes, with Stop; the progress lines; the question cards (the pick
// first and chosen, an Other text answer, Send answers posting each card's answer by question); the note
// with its status; the stopped and error lines; malformed messages ignored. The protocol's parsers too.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	INSTALL_RUNTIME_LABEL, RETRY_LABEL, RUNTIME_INSTALLING_TEXT, RUNTIME_MISSING_TEXT, runtimeFailedText, runtimeOutdatedText, UPDATE_RUNTIME_LABEL,
	BAD_BASE_URL_TEXT, BAD_SKILLS_PATH_TEXT, BAD_SKILLS_PATH_TEXTS, BASE_URL_CHANGED_TEXT, LOCAL_SKILLS_TEXT, unavailableText, NO_UV_TEXT, OPEN_SETTINGS_LABEL,
	NO_ACCESS_TEXT, NO_BINARY_TEXT, NO_WORKSPACE_TEXT, orderOptions, parseAssistantHostMessage, parseAssistantWebviewMessage, SET_UP_ACCESS_LABEL, STOPPED_TEXT,
	type AssistantStateMessage, type AssistantWebviewMessage,
} from '../../../src/shared/assistantProtocol';
import { AssistantView, RUN_LABEL, SEND_ANSWERS_LABEL, STOP_LABEL } from './AssistantView';

let host: HTMLDivElement;
let root: Root;
let posted: AssistantWebviewMessage[];

const IDLE: AssistantStateMessage = { type: 'state', access: 'ready', platform: null, runtime: { pinned: '0.3.329', installed: null, error: null }, skills: 'bundled', skillsProblem: null, status: 'idle', request: null, progress: [], questions: null, note: null, error: null };
const QUESTIONS: AssistantStateMessage = {
	...IDLE, status: 'question', request: 'orders to an API', progress: ['Running the rpcn-design skill', 'Checking with rpcn_check binary'],
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
const button = (text: string) => buttons().find((b) => b.textContent === text) as HTMLButtonElement | undefined;
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
		expect(host.querySelector('h1')?.textContent).toBe('RPCN AI Assistant');
		expect(host.querySelector('textarea')).toBeNull();
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

	it('the request box posts the trimmed request; Design is off while empty or while a run goes, with Stop', async () => {
		await send(IDLE);
		expect(button(RUN_LABEL)?.disabled).toBe(true);
		await type(host.querySelector('textarea')!, '  orders to an API  ');
		expect(button(RUN_LABEL)?.disabled).toBe(false);
		await click(button(RUN_LABEL)!);
		expect(posted.at(-1)).toEqual({ type: 'runRequested', request: 'orders to an API' });
		await send({ ...IDLE, status: 'running', request: 'orders to an API', progress: ['Started (claude-opus-5-5)'] });
		expect(button(RUN_LABEL)?.disabled).toBe(true);
		expect(host.querySelector('textarea')?.disabled).toBe(true);
		expect([...host.querySelectorAll('.rpcn-assistant-progress li')].map((l) => l.textContent)).toEqual(['Started (claude-opus-5-5)']);
		expect(host.querySelector('.rpcn-assistant-asked')?.textContent).toBe('orders to an API');
		await click(button(STOP_LABEL)!);
		expect(posted.at(-1)).toEqual({ type: 'stopRequested' });
	});

	it('question cards: the pick first and chosen; Send answers posts each card\'s answer by question', async () => {
		await send(QUESTIONS);
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

	it('the note with its status; the stopped line; the error line', async () => {
		await send({ ...IDLE, status: 'done', note: { file: 'orders_to_api.design.md', status: 'ready' } });
		expect(host.querySelector('.rpcn-assistant-note-file')?.textContent).toBe('orders_to_api.design.md');
		expect(host.querySelector('.rpcn-assistant-note-status')?.textContent).toBe('ready');
		expect(host.querySelector('.rpcn-assistant-status-ready')).not.toBeNull();
		await send({ ...IDLE, status: 'stopped' });
		expect(host.querySelector('.rpcn-assistant-stopped')?.textContent).toBe(STOPPED_TEXT);
		await send({ ...IDLE, status: 'error', error: 'API Error: 401 •••••' });
		expect(host.querySelector('[role="alert"]')?.textContent).toBe('API Error: 401 •••••');
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
		await send({ ...IDLE, status: 'question', access: 'noAccess', questions: QUESTIONS.questions });
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
		expect(parseAssistantWebviewMessage({ type: 'runRequested', request: 'x' })).toEqual({ type: 'runRequested', request: 'x' });
		expect(parseAssistantWebviewMessage({ type: 'runRequested', request: '  ' })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'runRequested', request: 'x'.repeat(8001) })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'answered', id: 'q', answers: ['b', 'c'] })).toEqual({ type: 'answered', id: 'q', answers: ['b', 'c'] });
		expect(parseAssistantWebviewMessage({ type: 'answered', id: 'q', answers: ['b', 1] })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'answered', id: 'q', answers: { a: 'b' } })).toBeUndefined();
		expect(parseAssistantWebviewMessage({ type: 'openSettingsRequested' })).toEqual({ type: 'openSettingsRequested' });
		expect(parseAssistantWebviewMessage({ type: 'nope' })).toBeUndefined();
		expect(parseAssistantWebviewMessage(null)).toBeUndefined();
	});

	it('parses host messages field by field', () => {
		expect(parseAssistantHostMessage({ ...QUESTIONS, extra: true })).toEqual(QUESTIONS);
		expect(parseAssistantHostMessage({ ...IDLE, progress: [1] })).toBeUndefined();
		expect(parseAssistantHostMessage({ ...IDLE, note: { file: 'a' } })).toBeUndefined();
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
