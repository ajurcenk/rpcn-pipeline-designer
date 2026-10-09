// What the graph view shows (ticket 3.6, AD-6): the latest valid model it was sent and the current
// parse error, if any. A `parseError` keeps the last valid model (the banner shows over it); the
// next `model` clears the banner. A `snapshot` replaces both: it is the host's complete state.
// Pure: no DOM, no React (vitest runs it in plain Node).

import type { HostMessage, ParseError, PipelineModel } from '../../src/shared/protocol';

export interface ViewModel {
	/** The model to draw; `null` until a valid one arrives (a first open on a broken file). */
	readonly model: PipelineModel | null;
	/** Set while the YAML does not parse: the banner shows. */
	readonly parseError: ParseError | null;
}

export const INITIAL_VIEW: ViewModel = { model: null, parseError: null };

/** The banner's text (EXPERIENCE, invalid-YAML banner). */
export const BANNER_TEXT = 'YAML has errors — showing last valid graph.';

/** The view after `message`; unchanged (the same object) for messages that don't concern it. */
export function reduce(state: ViewModel, message: HostMessage): ViewModel {
	switch (message.type) {
		case 'snapshot':
			return { model: message.model, parseError: message.parseError ?? null };
		case 'model':
			return { model: message.model, parseError: null };
		case 'parseError':
			return { model: state.model, parseError: { message: message.message, range: message.range } };
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
