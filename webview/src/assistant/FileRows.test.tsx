// @vitest-environment happy-dom
// Story 8.12: the file rows: the path with +N/−N, a click opening the diff while the turn's copies are
// kept; as text after Keep or Undo; "too large to undo" with no diff.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOO_LARGE_TEXT, type AssistantFileView } from '../../../src/shared/assistantProtocol';
import { FileRows } from './FileRows';

let host: HTMLDivElement;
let root: Root;
let opened: string[];
const FILES: AssistantFileView[] = [
	{ path: 'orders.design.md', added: 42, removed: 0, created: true, tooLarge: false },
	{ path: 'sub/a.yaml', added: 3, removed: 1, created: false, tooLarge: false },
	{ path: 'big.json', added: 0, removed: 0, created: false, tooLarge: true },
];
const render = async (clickable: boolean) => {
	await act(async () => {
		root.render(<FileRows files={FILES} clickable={clickable} open={(p) => opened.push(p)} />);
	});
};

beforeEach(() => {
	opened = [];
	host = document.createElement('div');
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe('FileRows', () => {
	it('each row: its path and counts; a click opens its diff; the large one is text', async () => {
		await render(true);
		const rows = [...host.querySelectorAll('.rpcn-assistant-file')];
		expect(rows.map((r) => r.querySelector('.rpcn-assistant-file-path')?.textContent)).toEqual(['orders.design.md', 'sub/a.yaml', 'big.json']);
		expect(rows[0].querySelector('.rpcn-assistant-added')?.textContent).toBe('+42');
		expect(rows[1].querySelector('.rpcn-assistant-removed')?.textContent).toBe('−1');
		expect(rows[0].querySelector('.rpcn-assistant-file-new')).not.toBeNull();
		expect(rows[2].querySelector('button')).toBeNull();
		expect(rows[2].querySelector('.rpcn-assistant-file-large')?.textContent).toBe(TOO_LARGE_TEXT);
		await act(async () => (rows[1].querySelector('button') as HTMLButtonElement).click());
		expect(opened).toEqual(['sub/a.yaml']);
	});

	it('not clickable (kept or undone): the rows stay, as text', async () => {
		await render(false);
		expect(host.querySelectorAll('.rpcn-assistant-file')).toHaveLength(3);
		expect(host.querySelector('button')).toBeNull();
	});
});
