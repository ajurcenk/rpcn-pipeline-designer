// The view reducer (tickets 3.6, 3.7, AD-6, AD-8): every host message, KEEP (the last valid graph
// stays under the banner while the YAML does not parse) and the highlighted node.

import { describe, expect, it } from 'vitest';
import type { HostMessage, PipelineModel } from '../../src/shared/protocol';
import {
	BANNER_TEXT, emptyStateOf, firstView, INITIAL_VIEW, NO_BINARY_ACTIONS, NO_BINARY_TEXT, NOTHING_TO_DRAW_TEXT, parseViewport, reduce, type ViewModel,
} from './state';

const A: PipelineModel = { nodes: [{ id: 'path:input', role: 'input', component: 'stdin', range: [0, 16] }], edges: [] };
const B: PipelineModel = {
	nodes: [...A.nodes, { id: 'path:output', role: 'output', component: 'stdout', range: [17, 35] }],
	edges: [{ id: 'path:input->path:output', source: 'path:input', target: 'path:output' }],
};
const ERROR = { message: 'All mapping items must start at the same column at line 3, column 1', range: [17, 18] as const };
const HOST_STATUS = { binary: 'unresolved', schema: 'none' } as const;
const snapshot = (model: PipelineModel | null, parseError?: typeof ERROR, selection: string | null = null): HostMessage => ({
	type: 'snapshot', model, ...(parseError ? { parseError } : {}), nodeStatus: {}, selection, hostStatus: HOST_STATUS,
});
const fold = (messages: readonly HostMessage[], from: ViewModel = INITIAL_VIEW) => messages.reduce(reduce, from);

describe('state reducer', () => {
	it('starts with nothing to draw and no banner', () => {
		expect(INITIAL_VIEW).toEqual({ model: null, parseError: null, selection: null, nodeStatus: {}, hostStatus: HOST_STATUS });
		expect(BANNER_TEXT).toBe('YAML has errors — showing last valid graph.');
	});

	it('snapshot: the host\'s complete state replaces the view', () => {
		expect(reduce(INITIAL_VIEW, snapshot(A))).toEqual({ model: A, parseError: null, selection: null, nodeStatus: {}, hostStatus: HOST_STATUS });
		expect(reduce({ model: A, parseError: ERROR, selection: null, nodeStatus: {}, hostStatus: HOST_STATUS }, snapshot(B))).toEqual({ model: B, parseError: null, selection: null, nodeStatus: {}, hostStatus: HOST_STATUS });
		// FIRST_BROKEN: the banner over an empty canvas.
		expect(reduce(INITIAL_VIEW, snapshot(null, ERROR))).toEqual({ model: null, parseError: ERROR, selection: null, nodeStatus: {}, hostStatus: HOST_STATUS });
		// RECREATED: the last valid model and the banner.
		expect(reduce(INITIAL_VIEW, snapshot(A, ERROR))).toEqual({ model: A, parseError: ERROR, selection: null, nodeStatus: {}, hostStatus: HOST_STATUS });
	});

	it('EDIT: a model replaces the last one', () => {
		expect(fold([snapshot(A), { type: 'model', model: B }])).toEqual({ model: B, parseError: null, selection: null, nodeStatus: {}, hostStatus: HOST_STATUS });
	});

	it('KEEP: a parseError keeps the last valid model and shows the banner, however often it comes', () => {
		const broken = fold([snapshot(A), { type: 'model', model: B }, { type: 'parseError', ...ERROR }]);
		expect(broken).toEqual({ model: B, parseError: ERROR, selection: null, nodeStatus: {}, hostStatus: HOST_STATUS });
		const later = { message: 'Implicit keys need to be on a single line at line 2, column 6', range: [20, 20] as const };
		expect(reduce(broken, { type: 'parseError', ...later })).toEqual({ model: B, parseError: later, selection: null, nodeStatus: {}, hostStatus: HOST_STATUS });
		// Only the error's own fields are kept (no `type`).
		expect(Object.keys(broken.parseError!)).toEqual(['message', 'range']);
	});

	it('HEAL: the next model clears the banner', () => {
		const healed = fold([snapshot(A), { type: 'parseError', ...ERROR }, { type: 'model', model: A }]);
		expect(healed).toEqual({ model: A, parseError: null, selection: null, nodeStatus: {}, hostStatus: HOST_STATUS });
		// After a first open on a broken file too.
		expect(fold([snapshot(null, ERROR), { type: 'model', model: B }])).toEqual({ model: B, parseError: null, selection: null, nodeStatus: {}, hostStatus: HOST_STATUS });
	});

	it('SELECTION: a selection replaces the highlight; null clears it; the same one changes nothing', () => {
		const view = fold([snapshot(A), { type: 'selection', nodeId: 'path:input' }]);
		expect(view).toEqual({ model: A, parseError: null, selection: 'path:input', nodeStatus: {}, hostStatus: HOST_STATUS });
		expect(reduce(view, { type: 'selection', nodeId: 'path:input' })).toBe(view);
		expect(reduce(view, { type: 'selection', nodeId: null })).toEqual({ model: A, parseError: null, selection: null, nodeStatus: {}, hostStatus: HOST_STATUS });
	});

	it('SELECTION: a model and a parse error keep the highlight; a snapshot carries its own', () => {
		const view = fold([snapshot(A), { type: 'selection', nodeId: 'path:input' }]);
		expect(reduce(view, { type: 'model', model: B }).selection).toBe('path:input');
		expect(reduce(view, { type: 'parseError', ...ERROR }).selection).toBe('path:input');
		// SNAPSHOT: a recreated webview shows the host's current selection.
		expect(reduce(view, snapshot(B, undefined, 'path:output'))).toEqual({ model: B, parseError: null, selection: 'path:output', nodeStatus: {}, hostStatus: HOST_STATUS });
		expect(reduce(view, snapshot(B)).selection).toBeNull();
	});

	it('NODE_STATUS (3.8): a nodeStatus replaces the markers; a model and a parse error keep them; a snapshot carries its own', () => {
		const status = { 'path:input': { severity: 'error', own: 'error', messages: ['field nope not recognised'] } } as const;
		const view = fold([snapshot(A), { type: 'nodeStatus', byId: status }]);
		expect(view).toEqual({ model: A, parseError: null, selection: null, nodeStatus: status, hostStatus: HOST_STATUS });
		expect(reduce(view, { type: 'model', model: B }).nodeStatus).toBe(status);
		// FROZEN: the host sends none while broken, and the view keeps the last one.
		expect(reduce(view, { type: 'parseError', ...ERROR }).nodeStatus).toBe(status);
		expect(reduce(view, { type: 'nodeStatus', byId: {} }).nodeStatus).toEqual({});
		const frozen = { 'path:output': { severity: 'warning', messages: ['field codec is deprecated'] } } as const;
		expect(reduce(view, { ...snapshot(B, ERROR), nodeStatus: frozen } as HostMessage).nodeStatus).toBe(frozen);
		expect(reduce(view, snapshot(B)).nodeStatus).toEqual({});
	});

	it('HOST_STATUS (3.9): a hostStatus replaces it; the same one changes nothing; a snapshot carries its own', () => {
		const view = fold([snapshot(A), { type: 'hostStatus', binary: 'ok', schema: 'ok' }]);
		expect(view).toEqual({ model: A, parseError: null, selection: null, nodeStatus: {}, hostStatus: { binary: 'ok', schema: 'ok' } });
		expect(reduce(view, { type: 'hostStatus', binary: 'ok', schema: 'ok' })).toBe(view);
		// Only the status's own fields are kept (no `type`).
		expect(Object.keys(view.hostStatus)).toEqual(['binary', 'schema']);
		expect(reduce(view, { ...snapshot(B), hostStatus: { binary: 'missing', schema: 'none' } } as HostMessage).hostStatus)
			.toEqual({ binary: 'missing', schema: 'none' });
	});

	it('LOST (3.9): a hostStatus without a schema drops the model and the banner; the selection and markers stay', () => {
		const status = { 'path:input': { severity: 'error', messages: ['x'] } } as const;
		const view = fold([snapshot(A, ERROR, 'path:input'), { type: 'nodeStatus', byId: status }]);
		for (const host of [{ binary: 'missing', schema: 'none' }, { binary: 'ok', schema: 'loading' }, { binary: 'ok', schema: 'none' }] as const) {
			expect(reduce(view, { type: 'hostStatus', ...host })).toEqual({
				model: null, parseError: null, selection: 'path:input', nodeStatus: status, hostStatus: host,
			});
		}
		// SET_PATH: the schema arrives, then the model.
		const lost = reduce(view, { type: 'hostStatus', binary: 'missing', schema: 'none' });
		const back = fold([{ type: 'hostStatus', binary: 'ok', schema: 'ok' }, { type: 'model', model: B }], lost);
		expect(back.model).toBe(B);
		expect(emptyStateOf(back)).toBeNull();
	});
});

describe('emptyStateOf (3.9, VIEW)', () => {
	const EMPTY: PipelineModel = { nodes: [], edges: [] };
	const RESOURCES: PipelineModel = { nodes: [{ id: 'res:cache:inmem', role: 'resource', component: 'memory', range: [0, 10] }], edges: [] };
	const view = (hostStatus: ViewModel['hostStatus'], model: PipelineModel | null, parseError: ViewModel['parseError'] = null): ViewModel =>
		({ model, parseError, selection: null, nodeStatus: {}, hostStatus });

	it('the copy', () => {
		expect(NO_BINARY_TEXT).toBe('No Redpanda Connect binary. The graph needs it to read the schema.');
		expect(NOTHING_TO_DRAW_TEXT.join('')).toBe('Nothing to draw yet. Add an input, pipeline or output section.');
	});
	it('the no-binary buttons post the binary warning\'s intents, in order', () => {
		expect(NO_BINARY_ACTIONS.map(({ label, message }) => [label, message])).toEqual([
			['Install guide', { type: 'installGuideRequested' }],
			['Set path', { type: 'setPathRequested' }],
			['Retry', { type: 'retryRequested' }],
		]);
	});
	it('MISSING / INVALID: the no-binary state, whatever the rest says', () => {
		for (const binary of ['missing', 'invalid'] as const) {
			expect(emptyStateOf(view({ binary, schema: 'none' }, null))).toBe('noBinary');
			expect(emptyStateOf(view({ binary, schema: 'none' }, A, ERROR))).toBe('noBinary');
		}
		expect(emptyStateOf(INITIAL_VIEW)).toBeNull();
	});
	it('unresolved, loading or no schema with an ok binary: an empty canvas, no text', () => {
		expect(emptyStateOf(view({ binary: 'unresolved', schema: 'none' }, null))).toBeNull();
		expect(emptyStateOf(view({ binary: 'ok', schema: 'loading' }, null))).toBeNull();
		expect(emptyStateOf(view({ binary: 'ok', schema: 'none' }, null))).toBeNull();
		expect(emptyStateOf(view({ binary: 'ok', schema: 'none' }, EMPTY))).toBeNull();
	});
	it('NOTHING: a schema and a model with no nodes; not while the banner is up', () => {
		expect(emptyStateOf(view({ binary: 'ok', schema: 'ok' }, EMPTY))).toBe('nothingToDraw');
		expect(emptyStateOf(view({ binary: 'ok', schema: 'ok' }, EMPTY, ERROR))).toBeNull();
		expect(emptyStateOf(view({ binary: 'ok', schema: 'ok' }, null, ERROR))).toBeNull();
		expect(emptyStateOf(view({ binary: 'ok', schema: 'ok' }, null))).toBeNull();
	});
	it('a graph with nodes, resources only included: no empty state', () => {
		expect(emptyStateOf(view({ binary: 'ok', schema: 'ok' }, A))).toBeNull();
		expect(emptyStateOf(view({ binary: 'ok', schema: 'ok' }, RESOURCES))).toBeNull();
	});
});

describe('firstView: the view is placed once, on the first laid-out model with nodes', () => {
	const saved = { x: 10, y: -20, zoom: 0.8 };
	it('fits the first model with nodes when no viewport is saved', () => {
		expect(firstView(false, 5, undefined)).toBe('fit');
	});
	it('waits while the model is empty (a new file, no schema yet), then fits the real graph', () => {
		expect(firstView(false, 0, undefined)).toBe('none');
		expect(firstView(false, 0, saved)).toBe('none');
		expect(firstView(false, 3, undefined)).toBe('fit');
	});
	it('restores a saved viewport instead of fitting (a recreated webview)', () => {
		expect(firstView(false, 5, saved)).toBe('restore');
	});
	it('never again once placed: later models keep the pan and zoom', () => {
		expect(firstView(true, 5, undefined)).toBe('none');
		expect(firstView(true, 5, saved)).toBe('none');
	});
});

describe('parseViewport', () => {
	it('accepts a finite x, y and a positive zoom, and copies only those', () => {
		expect(parseViewport({ x: 1, y: 2, zoom: 1.5, extra: true })).toEqual({ x: 1, y: 2, zoom: 1.5 });
	});
	it('rejects anything else', () => {
		for (const bad of [undefined, null, 3, 'x', [], {}, { x: 1, y: 2 }, { x: 1, y: 2, zoom: 0 }, { x: Number.NaN, y: 0, zoom: 1 }, { x: '1', y: 0, zoom: 1 }]) {
			expect(parseViewport(bad)).toBeUndefined();
		}
	});
});
