// @vitest-environment happy-dom
// The graph refits when its container is resized (ticket 4.19), on the real view: App (main.tsx)
// renders the Graph with React Flow in happy-dom. React Flow is wrapped only to spy on the
// instance's `fitView` and to drive its move callbacks with or without an input event (happy-dom
// has no layout, so d3-zoom cannot be driven by real pointer input). The container's size comes
// from the stubbed ResizeObserver (`resizeStub`, test-setup.ts). Every row of the plan's I/O matrix.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostMessage, PipelineModel } from '../../src/shared/protocol';
import { FIT_TO_VIEW } from './Graph';
import { App } from './main';

const flow = vi.hoisted(() => ({
	/** The props the Graph last passed to ReactFlow. */
	props: undefined as undefined | Record<string, unknown>,
	/** Every `fitView` call since the last reset. */
	fits: 0,
	/** Every `setViewport` call (a restore, or a fit's start at the input). */
	viewports: 0,
}));

vi.mock('@xyflow/react', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@xyflow/react')>();
	const ReactFlow = (props: Parameters<typeof actual.ReactFlow>[0]) => {
		flow.props = props as Record<string, unknown>;
		return createElement(actual.ReactFlow, {
			...props,
			onInit: (instance) => {
				const fitView = instance.fitView.bind(instance);
				instance.fitView = (options) => {
					flow.fits++;
					return fitView(options);
				};
				const setViewport = instance.setViewport.bind(instance);
				instance.setViewport = (viewport, options) => {
					flow.viewports++;
					return setViewport(viewport, options);
				};
				props.onInit?.(instance);
			},
		} as Parameters<typeof actual.ReactFlow>[0]);
	};
	return { ...actual, ReactFlow };
});

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../src/test/fixtures/models');
const MODEL = JSON.parse(readFileSync(join(FIXTURES, 'switch-processor.model.json'), 'utf8')) as PipelineModel;
const INPUT = 'path:input';
const SWITCH = 'path:pipeline.processors[0]';

let host: HTMLDivElement;
let root: Root;

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
const fitButton = () => [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === FIT_TO_VIEW);

async function showGraph(model: PipelineModel = MODEL): Promise<void> {
	await send({ type: 'snapshot', model, nodeStatus: {}, selection: null, hostStatus: { binary: 'ok', schema: 'ok' } });
	await until(() => nodes().length === model.nodes.length, 'the graph draws');
	// React Flow reports its instance once the nodes are measured: wait for the first placement (a
	// fit or a restore), then count only what follows.
	await until(() => flow.fits + flow.viewports > 0, 'the first placement');
	await act(async () => undefined);
	flow.fits = 0;
	flow.viewports = 0;
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

/** Reports a new container size, as the browser would. */
async function resize(width: number, height: number): Promise<void> {
	await act(async () => resizeStub.trigger(container(), { width, height }));
}

async function wait(ms: number): Promise<void> {
	await act(async () => {
		vi.advanceTimersByTime(ms);
	});
}

type Move = (event: unknown, viewport: { x: number; y: number; zoom: number }) => void;
const callback = (name: 'onMoveStart' | 'onMove' | 'onMoveEnd') => flow.props![name] as Move;

/** A pan or zoom started by user input: React Flow passes the pointer or wheel event. */
async function userMove(): Promise<void> {
	const event = new MouseEvent('mousemove');
	const viewport = { x: 40, y: -20, zoom: 1 };
	await act(async () => {
		callback('onMoveStart')(event, viewport);
		callback('onMove')(event, viewport);
		callback('onMoveEnd')(event, viewport);
	});
}

function mount(): void {
	flow.props = undefined;
	flow.fits = 0;
	flow.viewports = 0;
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
	act(() => root.render(<App />));
}

function unmount(): void {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
}

beforeEach(() => {
	vscodeStub.posted.length = 0;
	vscodeStub.state = undefined;
	mount();
});

afterEach(() => {
	unmount();
});

describe('SPLIT', () => {
	it('a fitted graph whose container halves in height fits once again after the size settles', async () => {
		await showGraph();
		await resize(800, 300);
		await wait(149);
		expect(flow.fits).toBe(0);
		await wait(1);
		expect(flow.fits).toBe(1);
		expect(vscodeStub.state).toMatchObject({ userMoved: false });
	});
	it('a report of the same size again is no change', async () => {
		await showGraph();
		await resize(800, 300);
		await wait(150);
		await resize(800, 300);
		await wait(300);
		expect(flow.fits).toBe(1);
	});
});

describe('USER_MOVED', () => {
	it('after a pan or zoom by user input, a resize leaves the viewport alone', async () => {
		await showGraph();
		await userMove();
		expect(vscodeStub.state).toMatchObject({ viewport: { x: 40, y: -20, zoom: 1 }, userMoved: true });
		await resize(800, 300);
		await wait(300);
		expect(flow.fits).toBe(0);
	});
	it('a wheel zoom reported only through onMove counts too', async () => {
		await showGraph();
		await act(async () => callback('onMove')(new WheelEvent('wheel'), { x: 0, y: 0, zoom: 1.2 }));
		await resize(800, 300);
		await wait(300);
		expect(flow.fits).toBe(0);
	});
});

describe('REVEAL', () => {
	it('a move with no input event (a fit, a restore, a keyboard reveal) is not the user\'s: the resize refits', async () => {
		await showGraph();
		await act(async () => {
			callback('onMoveStart')(null, { x: 10, y: 10, zoom: 1 });
			callback('onMove')(null, { x: 10, y: 10, zoom: 1 });
			callback('onMoveEnd')(null, { x: 10, y: 10, zoom: 1 });
		});
		expect(vscodeStub.state).toMatchObject({ userMoved: false });
		await resize(800, 300);
		await wait(150);
		expect(flow.fits).toBe(1);
	});
	it('arrowing to a node (a reveal) leaves the view untouched', async () => {
		await showGraph();
		nodes().find((n) => n.dataset.id === INPUT)!.focus();
		await act(async () => {
			document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
		});
		expect((document.activeElement as HTMLElement).dataset.id).toBe(SWITCH);
		await resize(800, 300);
		await wait(150);
		expect(flow.fits).toBe(1);
	});
});

describe('FIT_RESET', () => {
	it('after a user move, Fit to view fits and marks the view untouched: the next resize refits', async () => {
		await showGraph();
		await userMove();
		await resize(800, 300);
		await wait(300);
		expect(flow.fits).toBe(0);
		await act(async () => fitButton()!.click());
		expect(flow.fits).toBe(1);
		expect(vscodeStub.state).toMatchObject({ userMoved: false });
		await resize(800, 600);
		await wait(150);
		expect(flow.fits).toBe(2);
	});
});

describe('FIT_TO_VIEW', () => {
	it('a button named and titled "Fit to view", after the graph region and outside it, that fits the graph', async () => {
		await showGraph();
		const button = fitButton()!;
		expect(button).toBeDefined();
		expect(button.title).toBe(FIT_TO_VIEW);
		expect(button.type).toBe('button');
		expect(container().contains(button)).toBe(false);
		expect(container().compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		button.focus();
		expect(document.activeElement).toBe(button);
		await act(async () => button.click());
		expect(flow.fits).toBe(1);
	});
	it('no button before there is a graph to fit', async () => {
		await send({ type: 'snapshot', model: { nodes: [], edges: [] }, nodeStatus: {}, selection: null, hostStatus: { binary: 'ok', schema: 'ok' } });
		await until(() => host.querySelector('.rpcn-graph .react-flow') !== null, 'the empty canvas');
		expect(fitButton()).toBeUndefined();
	});
});

describe('BEFORE_FIRST', () => {
	it('a resize before any laid-out model with nodes does nothing; the first model still fits', async () => {
		await send({ type: 'snapshot', model: { nodes: [], edges: [] }, nodeStatus: {}, selection: null, hostStatus: { binary: 'ok', schema: 'ok' } });
		await until(() => host.querySelector('.rpcn-graph .react-flow') !== null, 'the empty canvas');
		await act(async () => undefined);
		await resize(800, 300);
		await act(() => new Promise((r) => setTimeout(r, 200)));
		expect(flow.fits).toBe(0);
		await send({ type: 'model', model: MODEL });
		await until(() => nodes().length === MODEL.nodes.length, 'the graph draws');
		await until(() => flow.fits === 1, 'the first fit');
	});
});

describe('DRAG', () => {
	it('ten size changes in 100 ms give one refit, after the last', async () => {
		await showGraph();
		for (let i = 0; i < 10; i++) {
			await resize(800, 600 - i * 30);
			await wait(10);
		}
		// 10 ms since the last change.
		expect(flow.fits).toBe(0);
		await wait(139);
		expect(flow.fits).toBe(0);
		await wait(1);
		expect(flow.fits).toBe(1);
		await wait(1000);
		expect(flow.fits).toBe(1);
	});
});

describe('RECREATED', () => {
	it('the mark is saved with the viewport: a recreated webview keeps the user\'s view on resize', async () => {
		await showGraph();
		await userMove();
		unmount();
		mount();
		await showGraph();
		await resize(800, 300);
		await wait(300);
		expect(flow.fits).toBe(0);
	});
	it('a restored viewport is not refitted after mount (the observer\'s first report is the baseline)', async () => {
		vscodeStub.state = { viewport: { x: 5, y: 5, zoom: 1 }, userMoved: false };
		unmount();
		mount();
		await showGraph();
		expect(flow.fits).toBe(0);
		vi.useRealTimers();
		await act(() => new Promise((r) => setTimeout(r, 250)));
		expect(flow.fits).toBe(0);
	});
	it('a viewport saved without the mark counts as untouched', async () => {
		vscodeStub.state = { viewport: { x: 5, y: 5, zoom: 1 } };
		unmount();
		mount();
		await showGraph();
		await resize(800, 300);
		await wait(150);
		expect(flow.fits).toBe(1);
	});
});
