// What the graph view shows (tickets 3.6, 3.7, AD-6, AD-8): the latest valid model it was sent, the
// current parse error, if any, and the node the host last said is under the cursor. A `parseError`
// keeps the last valid model (the banner shows over it) and the highlight; the next `model` clears
// the banner. A `selection` replaces the highlight; the host sends one after a model whenever the
// node under the cursor changed, so a model keeps it. Node status (ticket 3.8, AD-17): a
// `nodeStatus` replaces it; a model and a parse error keep it (the host sends a new one after a
// model when it changed, and none while the YAML does not parse). A `snapshot` replaces all four:
// it is the host's complete state.
// Pure: no DOM, no React (vitest runs it in plain Node).

import type { HostMessage, NodeStatusById, ParseError, PipelineModel } from '../../src/shared/protocol';

export interface ViewModel {
	/** The model to draw; `null` until a valid one arrives (a first open on a broken file). */
	readonly model: PipelineModel | null;
	/** Set while the YAML does not parse: the banner shows. */
	readonly parseError: ParseError | null;
	/** The node under the cursor in the driving editor, as the host computed it (`null`: none). */
	readonly selection: string | null;
	/** The error and warning markers by node id, as the host mapped them (the webview maps no ranges). */
	readonly nodeStatus: NodeStatusById;
}

export const INITIAL_VIEW: ViewModel = { model: null, parseError: null, selection: null, nodeStatus: {} };

/** The banner's text (EXPERIENCE, invalid-YAML banner). */
export const BANNER_TEXT = 'YAML has errors — showing last valid graph.';

/** The view after `message`; unchanged (the same object) for messages that don't concern it. */
export function reduce(state: ViewModel, message: HostMessage): ViewModel {
	switch (message.type) {
		case 'snapshot':
			return {
				model: message.model,
				parseError: message.parseError ?? null,
				selection: message.selection,
				nodeStatus: message.nodeStatus,
			};
		case 'model':
			return { ...state, model: message.model, parseError: null };
		case 'parseError':
			return { ...state, parseError: { message: message.message, range: message.range } };
		case 'nodeStatus':
			return { ...state, nodeStatus: message.byId };
		case 'selection':
			return message.nodeId === state.selection ? state : { ...state, selection: message.nodeId };
		default:
			return state;
	}
}

/** The graph's pan and zoom (AD-3 view state), as @xyflow/react reports it. */
export interface Viewport {
	readonly x: number;
	readonly y: number;
	readonly zoom: number;
}

/** A saved viewport, or `undefined` when `value` is not one (old or foreign state). */
export function parseViewport(value: unknown): Viewport | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const { x, y, zoom } = value as Record<string, unknown>;
	const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
	return finite(x) && finite(y) && finite(zoom) && zoom > 0 ? { x, y, zoom } : undefined;
}

/**
 * What the view does with a newly laid-out model: nothing once the view has been placed (later
 * models keep the user's pan and zoom) or while the model has no nodes (a fit would place nothing;
 * the real graph that arrives later gets it); otherwise restore the panel's saved viewport (a
 * recreated webview), else fit to view. Happens once per mount.
 */
export function firstView(placed: boolean, nodeCount: number, saved: Viewport | undefined): 'none' | 'restore' | 'fit' {
	if (placed || nodeCount === 0) {
		return 'none';
	}
	return saved ? 'restore' : 'fit';
}
