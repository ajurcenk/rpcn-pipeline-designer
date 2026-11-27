// @vitest-environment happy-dom
// Story 8.12: the transcript: the access panel before any turn; the turns, the latest unfolded with what
// its run needs now; two turns: the first folds to one line, which opens on click.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantStateMessage, AssistantTurnView } from '../../../src/shared/assistantProtocol';
import { EMPTY_TEXT, Transcript } from './Transcript';

let host: HTMLDivElement;
let root: Root;
const TURN: AssistantTurnView = {
	id: 't1', command: 'design', text: 'orders', skill: 'rpcn-design', model: 'claude-sonnet-4-6',
	steps: [{ id: 's1', label: 'Running the rpcn-design skill', mark: 'ok', result: '' }, { id: 's2', label: 'Reading a.yaml', mark: 'ok', result: '3 lines' }],
	reply: 'Done.', files: [], review: 'none', note: null, actions: [], chips: [], outcome: 'done', notice: null, elapsedMs: 72_000, waitingMs: 38_000, approvals: [],
};
const STATE: AssistantStateMessage = {
	type: 'state', access: 'ready', platform: null, runtime: { pinned: '1', installed: null, error: null }, skills: 'bundled', skillsProblem: null,
	status: 'idle', turns: [], folder: 'ws', designReady: false, questions: null, error: null,
	model: 'claude-opus-5-5', modelNotAllowed: null, host: 'api.anthropic.com', accessMessage: null, accessOrigin: null,
};
const render = async (state: AssistantStateMessage) => {
	await act(async () => {
		root.render(<Transcript state={state} panel={<p className="panel">panel</p>} live={<p className="live">live</p>} post={() => undefined} insert={() => undefined} />);
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

describe('Transcript', () => {
	it('before any turn: the panel, and the empty line when ready', async () => {
		await render(STATE);
		expect(host.querySelector('.panel')).not.toBeNull();
		expect(host.querySelector('.rpcn-assistant-empty')?.textContent).toBe(EMPTY_TEXT);
		await render({ ...STATE, access: 'noAccess' });
		expect(host.querySelector('.rpcn-assistant-empty')).toBeNull();
	});

	it('the live part goes in the running latest turn only', async () => {
		await render({ ...STATE, status: 'question', turns: [TURN, { ...TURN, id: 't2', outcome: 'running' }] });
		const turns = [...host.querySelectorAll('.rpcn-assistant-turn')];
		expect(turns[0].querySelector('.live')).toBeNull();
		expect(turns[1].querySelector('.live')).not.toBeNull();
	});

	it('ended turns fold their steps to one line, which opens on click; a running latest turn shows them', async () => {
		await render({ ...STATE, turns: [TURN, { ...TURN, id: 't2' }] });
		const [first, second] = [...host.querySelectorAll('.rpcn-assistant-turn')];
		expect(first.querySelector('.rpcn-assistant-step')).toBeNull();
		expect(second.querySelector('.rpcn-assistant-step')).toBeNull();
		const line = first.querySelector('.rpcn-assistant-fold-line') as HTMLButtonElement;
		expect(line.textContent).toBe('▸ 2 steps · 1m 12s (38s waiting on you)');
		await act(async () => line.click());
		expect(first.querySelectorAll('.rpcn-assistant-step')).toHaveLength(2);
		await render({ ...STATE, status: 'running', turns: [TURN, { ...TURN, id: 't2', outcome: 'running' }] });
		expect(host.querySelectorAll('.rpcn-assistant-turn')[1].querySelectorAll('.rpcn-assistant-step')).toHaveLength(2);
	});

	it('an error with no failed turn to hold it stands alone', async () => {
		await render({ ...STATE, status: 'error', error: 'boom', turns: [TURN] });
		expect(host.querySelector('.rpcn-assistant-transcript > [role="alert"]')?.textContent).toBe('boom');
		await render({ ...STATE, status: 'error', error: 'boom', turns: [{ ...TURN, outcome: 'error' }] });
		expect(host.querySelector('.rpcn-assistant-transcript > [role="alert"]')).toBeNull();
		expect(host.querySelector('.rpcn-assistant-turn [role="alert"]')?.textContent).toBe('boom');
	});
});
