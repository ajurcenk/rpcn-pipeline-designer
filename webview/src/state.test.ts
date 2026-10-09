// The view reducer (tickets 3.6, 3.7, AD-6, AD-8): every host message, KEEP (the last valid graph
// stays under the banner while the YAML does not parse) and the highlighted node.

import { describe, expect, it } from 'vitest';
import type { HostMessage, PipelineModel } from '../../src/shared/protocol';
import { BANNER_TEXT, firstView, INITIAL_VIEW, parseViewport, reduce, type ViewModel } from './state';

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
		expect(INITIAL_VIEW).toEqual({ model: null, parseError: null, selection: null });
		expect(BANNER_TEXT).toBe('YAML has errors — showing last valid graph.');
	});

	it('snapshot: the host\'s complete state replaces the view', () => {
		expect(reduce(INITIAL_VIEW, snapshot(A))).toEqual({ model: A, parseError: null, selection: null });
		expect(reduce({ model: A, parseError: ERROR, selection: null }, snapshot(B))).toEqual({ model: B, parseError: null, selection: null });
		// FIRST_BROKEN: the banner over an empty canvas.
		expect(reduce(INITIAL_VIEW, snapshot(null, ERROR))).toEqual({ model: null, parseError: ERROR, selection: null });
		// RECREATED: the last valid model and the banner.
		expect(reduce(INITIAL_VIEW, snapshot(A, ERROR))).toEqual({ model: A, parseError: ERROR, selection: null });
	});

	it('EDIT: a model replaces the last one', () => {
		expect(fold([snapshot(A), { type: 'model', model: B }])).toEqual({ model: B, parseError: null, selection: null });
	});

	it('KEEP: a parseError keeps the last valid model and shows the banner, however often it comes', () => {
		const broken = fold([snapshot(A), { type: 'model', model: B }, { type: 'parseError', ...ERROR }]);
		expect(broken).toEqual({ model: B, parseError: ERROR, selection: null });
		const later = { message: 'Implicit keys need to be on a single line at line 2, column 6', range: [20, 20] as const };
		expect(reduce(broken, { type: 'parseError', ...later })).toEqual({ model: B, parseError: later, selection: null });
		// Only the error's own fields are kept (no `type`).
		expect(Object.keys(broken.parseError!)).toEqual(['message', 'range']);
	});

	it('HEAL: the next model clears the banner', () => {
		const healed = fold([snapshot(A), { type: 'parseError', ...ERROR }, { type: 'model', model: A }]);
		expect(healed).toEqual({ model: A, parseError: null, selection: null });
		// After a first open on a broken file too.
		expect(fold([snapshot(null, ERROR), { type: 'model', model: B }])).toEqual({ model: B, parseError: null, selection: null });
	});

	it('SELECTION: a selection replaces the highlight; null clears it; the same one changes nothing', () => {
		const view = fold([snapshot(A), { type: 'selection', nodeId: 'path:input' }]);
		expect(view).toEqual({ model: A, parseError: null, selection: 'path:input' });
		expect(reduce(view, { type: 'selection', nodeId: 'path:input' })).toBe(view);
		expect(reduce(view, { type: 'selection', nodeId: null })).toEqual({ model: A, parseError: null, selection: null });
	});

	it('SELECTION: a model and a parse error keep the highlight; a snapshot carries its own', () => {
		const view = fold([snapshot(A), { type: 'selection', nodeId: 'path:input' }]);
		expect(reduce(view, { type: 'model', model: B }).selection).toBe('path:input');
		expect(reduce(view, { type: 'parseError', ...ERROR }).selection).toBe('path:input');
		// SNAPSHOT: a recreated webview shows the host's current selection.
		expect(reduce(view, snapshot(B, undefined, 'path:output'))).toEqual({ model: B, parseError: null, selection: 'path:output' });
		expect(reduce(view, snapshot(B)).selection).toBeNull();
	});

	it('other messages leave the view as it is', () => {
		const view: ViewModel = { model: A, parseError: ERROR, selection: null };
		const others: HostMessage[] = [
			{ type: 'nodeStatus', byId: {} },
			{ type: 'hostStatus', ...HOST_STATUS },
		];
		for (const message of others) {
			expect(reduce(view, message)).toBe(view);
		}
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
