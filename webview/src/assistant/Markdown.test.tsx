// @vitest-environment happy-dom
// Story 8.12: the reply's Markdown renderer in happy-dom: the blocks and inline marks it knows, links
// posting their href, and MD_HOSTILE: HTML is text, no element or handler is made, a javascript: link is inert.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkable, Markdown } from './Markdown';

let host: HTMLDivElement;
let root: Root;
let opened: string[];

const render = async (text: string) => {
	await act(async () => {
		root.render(<Markdown text={text} openLink={(href) => opened.push(href)} />);
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

describe('Markdown', () => {
	it('paragraphs, headings, bold, italic, inline code, fenced code, lists and tables', async () => {
		await render([
			'# Design', '', 'The **note** is *ready*, see `orders.design.md` and _this_.', 'Same paragraph.', '',
			'```yaml', 'input:', '  kafka: {}', '```', '', '- one', '- **two**', '', '1. first', '2. second', '',
			'| Field | Value |', '|---|---|', '| topic | `orders` |', '| dlq | yes |',
		].join('\n'));
		expect(host.querySelector('h3')?.textContent).toBe('Design');
		const p = host.querySelector('p')!;
		expect(p.textContent).toBe('The note is ready, see orders.design.md and this. Same paragraph.');
		expect(p.querySelector('strong')?.textContent).toBe('note');
		expect([...p.querySelectorAll('em')].map((e) => e.textContent)).toEqual(['ready', 'this']);
		expect(p.querySelector('code')?.textContent).toBe('orders.design.md');
		expect(host.querySelector('pre code')?.textContent).toBe('input:\n  kafka: {}');
		expect([...host.querySelectorAll('ul li')].map((l) => l.textContent)).toEqual(['one', 'two']);
		expect(host.querySelector('ul li strong')?.textContent).toBe('two');
		expect([...host.querySelectorAll('ol li')].map((l) => l.textContent)).toEqual(['first', 'second']);
		expect([...host.querySelectorAll('th')].map((c) => c.textContent)).toEqual(['Field', 'Value']);
		expect([...host.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent))).toEqual([['topic', 'orders'], ['dlq', 'yes']]);
	});

	it('a link is a focusable element without href; click and Enter post its href', async () => {
		await render('See [the docs](https://docs.redpanda.com/connect) and [the note](orders.design.md).');
		const links = [...host.querySelectorAll('a')];
		expect(links.map((a) => a.textContent)).toEqual(['the docs', 'the note']);
		expect(links.every((a) => !a.hasAttribute('href') && a.getAttribute('tabindex') === '0')).toBe(true);
		await act(async () => links[0].click());
		await act(async () => {
			links[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		});
		expect(opened).toEqual(['https://docs.redpanda.com/connect', 'orders.design.md']);
	});

	it('MD_HOSTILE: <script>, <img onerror> and a javascript: link render as text; nothing is created', async () => {
		await render('<script>window.pwned = 1</script>\n\n<img src=x onerror="window.pwned = 2">\n\n[x](javascript:alert(1)) and [y](data:text/html,hi)');
		expect(host.querySelector('script')).toBeNull();
		expect(host.querySelector('img')).toBeNull();
		expect(host.querySelector('a')).toBeNull();
		expect(host.textContent).toContain('<script>window.pwned = 1</script>');
		expect(host.textContent).toContain('<img src=x onerror="window.pwned = 2">');
		expect(host.textContent).toContain('x and y');
		expect([...host.querySelectorAll('*')].some((el) => [...el.attributes].some((a) => a.name.startsWith('on')))).toBe(false);
		expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
		expect(opened).toEqual([]);
	});

	it('only http(s) links and plain paths are linkable', () => {
		expect(linkable('https://x')).toBe(true);
		expect(linkable('a/b.yaml')).toBe(true);
		for (const bad of ['javascript:alert(1)', 'JavaScript:x', 'vbscript:x', 'file:///etc', 'command:x', '//evil', '']) {
			expect(linkable(bad), bad).toBe(false);
		}
	});
});
