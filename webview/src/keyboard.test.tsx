// @vitest-environment happy-dom
// The keyboard and screen-reader model (ticket 3.11), on the real view: App (main.tsx) renders the
// Graph with React Flow in happy-dom, fed host messages as the webview would get them, over the
// switch-processor fixture with node status. Every row of the plan's I/O matrix. ELK runs for real.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostMessage, NodeStatusById, PipelineModel } from '../../src/shared/protocol';
import { App } from './main';
import { BANNER_TEXT, GRAPH_NAME } from './state';

// A path, not a URL: happy-dom replaces the global URL with its own, which node:fs does not take.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../src/test/fixtures/models');
const MODEL = JSON.parse(readFileSync(join(FIXTURES, 'switch-processor.model.json'), 'utf8')) as PipelineModel;

const INPUT = 'path:input';
const SWITCH = 'path:pipeline.processors[0]';
const CASE0 = `${SWITCH}.switch[0]`;
const CASE1 = `${SWITCH}.switch[1]`;
const MAPPING = `${CASE0}.processors[0]`;
const LOG = `${CASE0}.processors[1]`;
const OUTPUT = 'path:output';

const STATUS: NodeStatusById = {
	[MAPPING]: { severity: 'error', messages: ['field nope not recognised'] },
	[CASE0]: { severity: 'error', messages: ['field nope not recognised'] },
	[SWITCH]: { severity: 'error', messages: ['field nope not recognised'] },
};

let host: HTMLDivElement;
let root: Root;

/** Waits (real timers: ELK and React Flow) until `check` holds. */
async function until(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (check()) {
			return;
		}
		await act(() => new Promise((r) => setTimeout(r, 10)));
	}
	throw new Error(`timed out: ${what}`);
}

const send = async (message: HostMessage) => {
	await act(async () => {
		window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(JSON.stringify(message)) }));
	});
};

const container = () => host.querySelector<HTMLElement>('.rpcn-graph')!;
const nodes = () => [...host.querySelectorAll<HTMLElement>('.react-flow__node')];
const node = (id: string) => nodes().find((n) => n.dataset.id === id);
const label = (id: string) => node(id)?.getAttribute('aria-label');
const focusedId = () => (document.activeElement as HTMLElement | null)?.dataset.id;
const live = () => host.querySelector('[aria-live]')!;
const regions = () => [...host.querySelectorAll('[aria-label]')].filter((el) => el.getAttribute('aria-label') === GRAPH_NAME);

/** Presses `key` on the focused element, as a keyboard would (the event bubbles to React's root). */
async function press(key: string): Promise<void> {
	const target = document.activeElement ?? document.body;
	await act(async () => {
		target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
	});
}

/** Every element in the graph the Tab key would stop at. */
function tabStops(): Element[] {
	return [...container().querySelectorAll('[tabindex], button, a[href], input, select, textarea')]
		.filter((el) => (el as HTMLElement).tabIndex >= 0 && !(el as HTMLButtonElement).disabled);
}

async function showGraph(model: PipelineModel = MODEL, nodeStatus: NodeStatusById = STATUS): Promise<void> {
	await send({ type: 'snapshot', model, nodeStatus, selection: null, hostStatus: { binary: 'ok', schema: 'ok' } });
	await until(() => nodes().length === model.nodes.length, 'the graph draws');
}

beforeEach(() => {
	vscodeStub.posted.length = 0;
	vscodeStub.state = undefined;
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
	act(() => root.render(<App />));
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe('TAB_IN', () => {
	it('the first node (the input) is the one Tab stop, with the container out of the Tab order', async () => {
		await showGraph();
		expect(tabStops().map((el) => (el as HTMLElement).dataset.id)).toEqual([INPUT]);
		expect(container().tabIndex).toBe(-1);
		node(INPUT)!.focus();
		expect(focusedId()).toBe(INPUT);
	});
	it('no nodes: the container keeps focus, is the one named region, and is described by the empty text', async () => {
		await send({ type: 'snapshot', model: { nodes: [], edges: [] }, nodeStatus: {}, selection: null, hostStatus: { binary: 'ok', schema: 'ok' } });
		await until(() => host.querySelector('.rpcn-graph') !== null, 'the container');
		expect(container().tabIndex).toBe(0);
		container().focus();
		expect(document.activeElement).toBe(container());
		expect(regions()).toEqual([container()]);
		const describedBy = container().getAttribute('aria-describedby');
		expect(describedBy).toBeTruthy();
		expect(document.getElementById(describedBy!)?.textContent).toBe('Nothing to draw yet. Add an input, pipeline or output section.');
	});
	it('no binary: the empty state is the one named region', async () => {
		await send({ type: 'snapshot', model: null, nodeStatus: {}, selection: null, hostStatus: { binary: 'missing', schema: 'none' } });
		await until(() => host.querySelector('.rpcn-empty') !== null, 'the empty state');
		expect(host.querySelector('.rpcn-graph')).toBeNull();
		expect(regions()).toEqual([host.querySelector('.rpcn-empty')]);
	});
	it('edges and the pane are never focusable; React Flow\'s keyboard descriptions are blank', async () => {
		await showGraph();
		// happy-dom has no layout, so React Flow draws no edges here (it needs measured handles);
		// layout.test.ts checks the props that hide them from assistive tech (EDGES_HIDDEN).
		expect([...host.querySelectorAll('.react-flow__edge')].every((e) => e.getAttribute('tabindex') === null)).toBe(true);
		expect(host.querySelector('.react-flow__pane')?.getAttribute('tabindex') ?? null).toBeNull();
		expect(nodes().every((n) => n.getAttribute('aria-describedby') === null)).toBe(true);
		for (const desc of host.querySelectorAll('[id^="react-flow__node-desc"], [id^="react-flow__edge-desc"]')) {
			expect(desc.textContent).toBe('');
		}
	});
});

describe('ARROWS', () => {
	it('Right / Left siblings, Down into a group or route, Up to the parent; at an end nothing moves', async () => {
		await showGraph();
		node(INPUT)!.focus();
		const walk: [string, string][] = [
			['ArrowLeft', INPUT], // an end
			['ArrowRight', SWITCH],
			['ArrowDown', CASE0],
			['ArrowDown', MAPPING],
			['ArrowRight', LOG],
			['ArrowRight', LOG], // an end
			['ArrowDown', LOG], // a leaf
			['ArrowUp', CASE0],
			['ArrowRight', CASE1],
			['ArrowUp', SWITCH],
			['ArrowRight', OUTPUT],
			['ArrowUp', OUTPUT], // the top level
			['ArrowLeft', SWITCH],
		];
		for (const [key, expected] of walk) {
			await press(key);
			expect(focusedId(), `${key} -> ${expected}`).toBe(expected);
			expect(tabStops().map((el) => (el as HTMLElement).dataset.id)).toEqual([expected]);
		}
	});
});

describe('COLLAPSED / SPACE', () => {
	it('Down on a collapsed group does not move; Space expands it, then Down enters', async () => {
		await showGraph();
		node(INPUT)!.focus();
		await press('ArrowRight');
		await press(' ');
		await until(() => node(CASE0) === undefined, 'the switch collapses');
		expect(focusedId()).toBe(SWITCH);
		expect(label(SWITCH)).toBe('Processor switch, 2 cases, collapsed, has error: field nope not recognised');
		await press('ArrowDown');
		expect(focusedId()).toBe(SWITCH);
		await press(' ');
		await until(() => node(CASE0) !== undefined, 'the switch expands');
		expect(label(SWITCH)).toContain('expanded');
		await press('ArrowDown');
		expect(focusedId()).toBe(CASE0);
	});
	it('Space on a leaf does nothing', async () => {
		await showGraph();
		node(INPUT)!.focus();
		await press(' ');
		await new Promise((r) => setTimeout(r, 50));
		expect(nodes()).toHaveLength(MODEL.nodes.length);
		expect(focusedId()).toBe(INPUT);
		expect(vscodeStub.posted.filter((m) => (m as { type: string }).type !== 'ready')).toEqual([]);
	});
});

describe('ENTER', () => {
	it('posts nodeActivated via keyboard for the focused node', async () => {
		await showGraph();
		node(INPUT)!.focus();
		for (const key of ['ArrowRight', 'ArrowDown', 'ArrowDown', 'Enter']) {
			await press(key);
		}
		expect(vscodeStub.posted.at(-1)).toEqual({ type: 'nodeActivated', nodeId: MAPPING, via: 'keyboard' });
	});
	it('a click still posts via click', async () => {
		await showGraph();
		await act(async () => {
			node(INPUT)!.querySelector('.rpcn-node')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		});
		expect(vscodeStub.posted.at(-1)).toEqual({ type: 'nodeActivated', nodeId: INPUT, via: 'click' });
	});
});

describe('BUTTON', () => {
	it('Enter and Space on the chevron (focused by a click) are left to the button', async () => {
		await showGraph();
		const chevron = node(SWITCH)!.querySelector<HTMLButtonElement>('.rpcn-group-toggle')!;
		chevron.focus();
		expect(document.activeElement).toBe(chevron);
		await press('Enter');
		await press(' ');
		await new Promise((r) => setTimeout(r, 50));
		expect(vscodeStub.posted.filter((m) => (m as { type: string }).type === 'nodeActivated')).toEqual([]);
		expect(node(CASE0)).toBeDefined();
	});
});

describe('ESC', () => {
	it('Esc on a node focuses the container; Esc on the container posts focusEditorRequested', async () => {
		await showGraph();
		node(INPUT)!.focus();
		await press('ArrowRight');
		await press('Escape');
		expect(document.activeElement).toBe(container());
		expect(vscodeStub.posted.some((m) => (m as { type: string }).type === 'focusEditorRequested')).toBe(false);
		await press('Escape');
		expect(vscodeStub.posted.at(-1)).toEqual({ type: 'focusEditorRequested' });
		// The Tab stop is still the node last focused.
		expect(tabStops().map((el) => (el as HTMLElement).dataset.id)).toEqual([SWITCH]);
	});
});

describe('NAMES', () => {
	it('the container, a node with an error, a group, a route, a leaf', async () => {
		await showGraph();
		expect(container().getAttribute('aria-label')).toBe(GRAPH_NAME);
		expect(GRAPH_NAME).toBe('Pipeline graph, read-only');
		expect(label(MAPPING)).toBe('Processor mapping, has error: field nope not recognised');
		expect(label(SWITCH)).toBe('Processor switch, 2 cases, expanded');
		expect(label(CASE0)).toBe('Case this.kind == "a"');
		expect(label(CASE1)).toBe('Case 1');
		expect(label(INPUT)).toBe('Input stdin');
	});
});

describe('LIVE', () => {
	it('announces the banner, then each node that newly gets an error, and nothing for the same status again', async () => {
		await showGraph();
		expect(live().textContent).toBe('');
		expect(live().getAttribute('aria-live')).toBe('polite');
		await send({ type: 'parseError', message: 'bad indentation', range: [0, 1] });
		expect(live().textContent).toBe(BANNER_TEXT);
		await send({ type: 'model', model: MODEL });
		const withLog: NodeStatusById = { ...STATUS, [LOG]: { severity: 'error', messages: ['field x is required'] } };
		await send({ type: 'nodeStatus', byId: withLog });
		expect(live().textContent).toBe('New error: Processor log');
		const spoken = live().firstElementChild;
		await send({ type: 'nodeStatus', byId: withLog });
		expect(live().firstElementChild).toBe(spoken);
		expect(live().textContent).toBe('New error: Processor log');
	});
	it('the snapshot\'s errors are the baseline (a recreated webview repeats nothing)', async () => {
		await showGraph();
		expect(live().textContent).toBe('');
	});
});

describe('MODEL_CHANGE', () => {
	it('the focused node gone: its nearest visible ancestor, else the first node; a selection never moves focus', async () => {
		await showGraph();
		node(INPUT)!.focus();
		for (const key of ['ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowRight']) {
			await press(key);
		}
		expect(focusedId()).toBe(LOG);
		await send({ type: 'selection', nodeId: OUTPUT });
		expect(focusedId()).toBe(LOG);

		const withoutLog: PipelineModel = {
			nodes: MODEL.nodes.filter((n) => n.id !== LOG),
			edges: MODEL.edges.filter((e) => e.source !== LOG && e.target !== LOG),
		};
		await send({ type: 'model', model: withoutLog });
		await until(() => focusedId() === CASE0, 'focus on the case');

		const flat: PipelineModel = {
			nodes: MODEL.nodes.filter((n) => n.id === INPUT || n.id === OUTPUT),
			edges: [{ id: 'e', source: INPUT, target: OUTPUT }],
		};
		await send({ type: 'model', model: flat });
		await until(() => focusedId() === INPUT, 'focus on the first node');
	});
	it('the focused node is view state: a recreated view starts at it', async () => {
		await showGraph();
		node(INPUT)!.focus();
		await press('ArrowRight');
		expect(vscodeStub.state).toMatchObject({ focused: [SWITCH] });
		act(() => root.unmount());
		root = createRoot(host);
		act(() => root.render(<App />));
		await showGraph();
		expect(tabStops().map((el) => (el as HTMLElement).dataset.id)).toEqual([SWITCH]);
	});
});

// Graph interaction fixes across tickets (the E3 retro, F3, F5, F8): the combined sequences.
describe('F3_ESC: a way out in every state', () => {
	const OK = { binary: 'ok', schema: 'ok' } as const;
	/** The one named region takes focus, and Esc on it posts focusEditorRequested. */
	async function escapes(what: string): Promise<void> {
		expect(regions(), `${what}: one named region`).toHaveLength(1);
		const region = regions()[0] as HTMLElement;
		expect(region.tabIndex, `${what}: in the Tab order`).toBe(0);
		region.focus();
		expect(document.activeElement, `${what}: focusable`).toBe(region);
		vscodeStub.posted.length = 0;
		await press('Escape');
		expect(vscodeStub.posted, what).toEqual([{ type: 'focusEditorRequested' }]);
	}
	it('before any message, and the loading or no-schema canvas', async () => {
		await escapes('before the first snapshot');
		await send({ type: 'snapshot', model: null, nodeStatus: {}, selection: null, hostStatus: { binary: 'ok', schema: 'loading' } });
		await escapes('loading');
		await send({ type: 'hostStatus', binary: 'ok', schema: 'none' });
		await escapes('no schema');
	});
	it('before the first layout', async () => {
		await send({ type: 'snapshot', model: MODEL, nodeStatus: STATUS, selection: null, hostStatus: OK });
		expect(nodes(), 'not laid out yet').toHaveLength(0);
		expect(container()).not.toBeNull();
		await escapes('before the first layout');
	});
	it('the no-binary and nothing-to-draw states', async () => {
		await send({ type: 'snapshot', model: null, nodeStatus: {}, selection: null, hostStatus: { binary: 'missing', schema: 'none' } });
		await until(() => host.querySelector('.rpcn-empty') !== null, 'the empty state');
		await escapes('no binary');
		// Esc from one of its buttons too.
		host.querySelector<HTMLButtonElement>('.rpcn-empty-action')!.focus();
		vscodeStub.posted.length = 0;
		await press('Escape');
		expect(vscodeStub.posted).toEqual([{ type: 'focusEditorRequested' }]);
		await send({ type: 'snapshot', model: { nodes: [], edges: [] }, nodeStatus: {}, selection: null, hostStatus: OK });
		await until(() => host.querySelector('.rpcn-graph') !== null, 'the container');
		await escapes('nothing to draw');
	});
	it('a first open on broken YAML: the banner over a named canvas', async () => {
		await send({ type: 'snapshot', model: null, parseError: { message: 'bad indentation', range: [0, 1] }, nodeStatus: {}, selection: null, hostStatus: OK });
		expect(host.querySelector('.rpcn-banner')).not.toBeNull();
		await escapes('first open on broken YAML');
		// The graph drawn later replaces it: still one region.
		await send({ type: 'model', model: MODEL });
		await until(() => nodes().length === MODEL.nodes.length, 'the graph draws');
		expect(regions()).toEqual([container()]);
	});
});

describe('F5_FOCUS: focus comes back after a remount', () => {
	it('focus on a node → hostStatus none → ok + model: focus is on the graph\'s Tab stop again', async () => {
		await showGraph();
		node(INPUT)!.focus();
		await press('ArrowRight');
		expect(focusedId()).toBe(SWITCH);
		await send({ type: 'hostStatus', binary: 'ok', schema: 'none' });
		expect(nodes()).toHaveLength(0);
		await send({ type: 'hostStatus', binary: 'ok', schema: 'ok' });
		await send({ type: 'model', model: MODEL });
		await until(() => focusedId() === SWITCH, 'focus back on the switch');
	});
	it('the same through the no-binary state', async () => {
		await showGraph();
		node(INPUT)!.focus();
		await send({ type: 'hostStatus', binary: 'missing', schema: 'none' });
		await until(() => host.querySelector('.rpcn-empty') !== null, 'the empty state');
		await send({ type: 'hostStatus', binary: 'ok', schema: 'ok' });
		await send({ type: 'model', model: MODEL });
		await until(() => focusedId() === INPUT, 'focus back on the input');
	});
	it('focus elsewhere meanwhile is left alone; focus never in the graph is not pulled in', async () => {
		const outside = document.createElement('button');
		document.body.append(outside);
		try {
			await showGraph();
			node(INPUT)!.focus();
			await send({ type: 'hostStatus', binary: 'ok', schema: 'none' });
			outside.focus();
			await send({ type: 'hostStatus', binary: 'ok', schema: 'ok' });
			await send({ type: 'model', model: MODEL });
			await until(() => nodes().length === MODEL.nodes.length, 'the graph draws');
			await new Promise((r) => setTimeout(r, 50));
			expect(document.activeElement).toBe(outside);

			// Never focused: a schema drop and return leaves focus where it is (on the body).
			outside.blur();
			await send({ type: 'hostStatus', binary: 'ok', schema: 'none' });
			await send({ type: 'hostStatus', binary: 'ok', schema: 'ok' });
			await send({ type: 'model', model: MODEL });
			await until(() => nodes().length === MODEL.nodes.length, 'the graph draws again');
			await new Promise((r) => setTimeout(r, 50));
			expect(focusedId()).toBeUndefined();
		} finally {
			outside.remove();
		}
	});
});

describe('F8_BROKEN: the names say navigation is unavailable while the YAML has errors', () => {
	it('each node\'s name ends with the note under the banner; the visible text does not change; the next model drops it', async () => {
		await showGraph();
		const text = nodes().map((n) => n.textContent);
		await send({ type: 'parseError', message: 'bad indentation', range: [0, 1] });
		await until(() => label(INPUT)?.endsWith(', navigation unavailable while the YAML has errors') === true, 'the note');
		for (const n of nodes()) {
			expect(n.getAttribute('aria-label')).toMatch(/, navigation unavailable while the YAML has errors$/);
		}
		expect(label(MAPPING)).toBe('Processor mapping, has error: field nope not recognised, navigation unavailable while the YAML has errors');
		expect(nodes().map((n) => n.textContent)).toEqual(text);
		await send({ type: 'model', model: MODEL });
		await until(() => label(INPUT) === 'Input stdin', 'the note goes');
	});
});

describe('F3_ESC / F5_FOCUS / LIVE follow-ups', () => {
	const OK = { binary: 'ok', schema: 'ok' } as const;
	const ERROR = { message: 'bad indentation at line 3, column 1', range: [0, 1] as const };
	const COLUMN = { message: 'bad indentation at line 3, column 2', range: [1, 2] as const };
	const banner = () => host.querySelector<HTMLButtonElement>('.rpcn-banner-button');
	it('Esc on the banner\'s button posts focusEditorRequested, over the graph and over the empty canvas', async () => {
		await showGraph();
		await send({ type: 'parseError', ...ERROR });
		banner()!.focus();
		vscodeStub.posted.length = 0;
		await press('Escape');
		expect(vscodeStub.posted).toEqual([{ type: 'focusEditorRequested' }]);
		await send({ type: 'snapshot', model: null, parseError: ERROR, nodeStatus: {}, selection: null, hostStatus: OK });
		banner()!.focus();
		vscodeStub.posted.length = 0;
		await press('Escape');
		expect(vscodeStub.posted).toEqual([{ type: 'focusEditorRequested' }]);
	});
	it('the empty canvas is busy only while the binary is unresolved or the schema loads; it is not the graph container', async () => {
		const region = () => regions()[0] as HTMLElement;
		expect(region().getAttribute('aria-busy')).toBe('true');
		expect(host.querySelector('.rpcn-graph')).toBeNull();
		await send({ type: 'snapshot', model: null, nodeStatus: {}, selection: null, hostStatus: { binary: 'ok', schema: 'loading' } });
		expect(region().getAttribute('aria-busy')).toBe('true');
		await send({ type: 'hostStatus', binary: 'ok', schema: 'none' });
		expect(region().getAttribute('aria-busy')).toBeNull();
		await send({ type: 'snapshot', model: null, parseError: ERROR, nodeStatus: {}, selection: null, hostStatus: OK });
		expect(region().getAttribute('aria-busy')).toBeNull();
	});
	it('focus in the no-binary state returns to the graph when it draws', async () => {
		await send({ type: 'snapshot', model: null, nodeStatus: {}, selection: null, hostStatus: { binary: 'missing', schema: 'none' } });
		await until(() => host.querySelector('.rpcn-empty-action') !== null, 'the empty state');
		host.querySelector<HTMLButtonElement>('.rpcn-empty-action')!.focus();
		await send({ type: 'hostStatus', ...OK });
		await send({ type: 'model', model: MODEL });
		await until(() => focusedId() === INPUT, 'focus on the graph\'s Tab stop');
	});
	it('focus that left the graph for the banner is not pulled back when the graph draws again', async () => {
		await showGraph();
		node(INPUT)!.focus();
		await send({ type: 'hostStatus', binary: 'ok', schema: 'none' });
		await send({ type: 'snapshot', model: null, parseError: ERROR, nodeStatus: {}, selection: null, hostStatus: OK });
		banner()!.focus();
		// The file heals: the banner goes (and its focus with it), the graph draws.
		await send({ type: 'model', model: MODEL });
		await until(() => nodes().length === MODEL.nodes.length, 'the graph draws');
		await new Promise((r) => setTimeout(r, 50));
		expect(focusedId()).toBeUndefined();
	});
	it('LIVE: once per appearance; a schema drop and return while broken (a snapshot) says nothing; heal then break says it once', async () => {
		await showGraph();
		await send({ type: 'parseError', ...ERROR });
		expect(live().textContent).toBe(BANNER_TEXT);
		const spoken = live().firstElementChild;
		await send({ type: 'parseError', ...COLUMN });
		expect(live().firstElementChild).toBe(spoken);
		await send({ type: 'hostStatus', binary: 'ok', schema: 'none' });
		await send({ type: 'hostStatus', ...OK });
		await send({ type: 'snapshot', model: MODEL, parseError: COLUMN, nodeStatus: STATUS, selection: null, hostStatus: OK });
		await send({ type: 'parseError', ...ERROR });
		expect(live().firstElementChild).toBe(spoken);
		await send({ type: 'model', model: MODEL });
		await send({ type: 'parseError', ...ERROR });
		expect(live().textContent).toBe(BANNER_TEXT);
		expect(live().firstElementChild).not.toBe(spoken);
	});
});
