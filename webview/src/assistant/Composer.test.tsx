// @vitest-environment happy-dom
// Story 8.12: the composer: Enter sends, Shift+Enter does not; `/` opens the command list (SLASH: ↓ then
// Enter inserts `/build `, and the list closes), Tab picks too, Escape closes it; `/build` cannot be sent,
// with its hint; while busy Send becomes Stop.

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMAND_HINTS, type AssistantWebviewMessage } from '../../../src/shared/assistantProtocol';
import { commandsFor, Composer, MODEL_CHIP_LABEL, SEND_LABEL, sendable, STOP_LABEL } from './Composer';

let host: HTMLDivElement;
let root: Root;
let posted: AssistantWebviewMessage[];

function Harness({ busy, model }: { readonly busy: boolean; readonly model?: string }) {
	const [text, setText] = useState('');
	return <Composer text={text} setText={setText} busy={busy} model={model} post={(m) => posted.push(m)} />;
}
const render = async (busy = false, model?: string) => {
	await act(async () => {
		root.render(<Harness busy={busy} model={model} />);
	});
};
const area = () => host.querySelector('textarea') as HTMLTextAreaElement;
const type = async (text: string) => {
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area(), text);
		area().dispatchEvent(new Event('input', { bubbles: true }));
	});
};
const key = async (k: string, shiftKey = false) => {
	await act(async () => {
		area().dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }));
	});
};
const options = () => [...host.querySelectorAll('[role="option"]')].map((o) => o.querySelector('.rpcn-assistant-command-name')?.textContent);
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;

beforeEach(() => {
	posted = [];
	host = document.createElement('div');
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe('Composer', () => {
	it('Enter sends the message as typed (no command: design); Shift+Enter does not send', async () => {
		await render();
		await type('orders to an API');
		await key('Enter', true);
		expect(posted).toEqual([]);
		await key('Enter');
		expect(posted).toEqual([{ type: 'runRequested', command: 'design', request: 'orders to an API' }]);
		expect(area().value).toBe('');
		await type('/design  clicks ');
		await key('Enter');
		expect(posted.at(-1)).toEqual({ type: 'runRequested', command: 'design', request: '/design  clicks' });
	});

	it('SLASH: / opens the three commands; ↓ then Enter inserts "/build " and closes the list', async () => {
		await render();
		await type('/');
		expect(options()).toEqual(['/design', '/build', '/test']);
		expect(host.querySelector('[aria-selected="true"] .rpcn-assistant-command-name')?.textContent).toBe('/design');
		await key('ArrowDown');
		expect(host.querySelector('[aria-selected="true"] .rpcn-assistant-command-name')?.textContent).toBe('/build');
		await key('Enter');
		expect(area().value).toBe('/build ');
		expect(options()).toEqual([]);
		expect(posted).toEqual([]);
	});

	it('the list narrows as more is typed; Tab picks; Escape closes; ↑ wraps', async () => {
		await render();
		await type('/t');
		expect(options()).toEqual(['/test']);
		await key('Tab');
		expect(area().value).toBe('/test ');
		await type('/');
		await key('ArrowUp');
		expect(host.querySelector('[aria-selected="true"] .rpcn-assistant-command-name')?.textContent).toBe('/test');
		await key('Escape');
		expect(options()).toEqual([]);
		await type('/x');
		expect(options()).toEqual([]);
	});

	it('a disabled /build: its hint shows and nothing is sent', async () => {
		await render();
		await type('/build the pipeline');
		expect(host.querySelector('.rpcn-assistant-hint')?.textContent).toBe(COMMAND_HINTS.build);
		expect(COMMAND_HINTS.build).toBe('Arrives with the Author stage');
		expect(button(SEND_LABEL)?.disabled).toBe(true);
		await key('Enter');
		expect(posted).toEqual([]);
		expect(sendable('/test x')).toEqual({ command: 'test', ok: false, hint: 'Arrives with the Test hand-off' });
		expect(commandsFor('/design x')).toBeUndefined();
	});

	it('busy: the composer stays, Send becomes Stop, Enter sends nothing', async () => {
		await render(true);
		expect(button(SEND_LABEL)).toBeUndefined();
		await type('more');
		await key('Enter');
		expect(posted).toEqual([]);
		await act(async () => button(STOP_LABEL)!.click());
		expect(posted).toEqual([{ type: 'stopRequested' }]);
	});

	it('story 8.3: the model chip: left of the hint, `<model> ▾`; it posts chooseModelRequested, even while busy; none without a model', async () => {
		await render(false, 'claude-opus-5-5');
		await type('/build x');
		const left = host.querySelector('.rpcn-assistant-composer-left')!;
		expect([...left.children].map((c) => c.className)).toEqual(['rpcn-assistant-model-chip', 'rpcn-assistant-hint']);
		const chip = left.querySelector('button')!;
		expect(chip.textContent).toBe('claude-opus-5-5 ▾');
		expect(chip.title).toBe(MODEL_CHIP_LABEL);
		await act(async () => chip.click());
		expect(posted).toEqual([{ type: 'chooseModelRequested' }]);
		await render(true, 'claude-opus-5-5');
		await act(async () => (host.querySelector('.rpcn-assistant-model-chip') as HTMLButtonElement).click());
		expect(posted).toHaveLength(2);
		await render(false);
		expect(host.querySelector('.rpcn-assistant-model-chip')).toBeNull();
	});
});
