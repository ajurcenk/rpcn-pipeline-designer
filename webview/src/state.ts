// What the graph view shows (tickets 3.6, 3.7, AD-6, AD-8): the latest valid model it was sent, the
// current parse error, if any, and the node the host last said is under the cursor. A `parseError`
// keeps the last valid model (the banner shows over it) and the highlight; the next `model` clears
// the banner. A `selection` replaces the highlight; the host sends one after a model whenever the
// node under the cursor changed, so a model keeps it. Node status (ticket 3.8, AD-17): a
// `nodeStatus` replaces it; a model and a parse error keep it (the host sends a new one after a
// model when it changed, and none while the YAML does not parse). Host status (ticket 3.9, AD-9,
// AD-20): a `hostStatus` replaces it; one without a schema also drops the model and the banner,
// since the host sends neither until a schema arrives (it then sends the model, or the parse
// error, again). A `snapshot` replaces all five: it is the host's complete state. `emptyStateOf`
// picks the empty state the view shows from these alone (the webview does no binary work, AD-3).
// The polite live region (ticket 3.11, LIVE): `reduceLive` adds what to announce to each change:
// the banner text once per appearance (F4: when it appears in a webview that has seen the file
// parse, never while it stays up, whatever its message), and "New error: …" for each node a
// `nodeStatus` newly gives an error. A snapshot announces nothing and is the baseline of both (a
// recreated webview repeats nothing); the host sends one when the schema returns while the YAML
// does not parse, so a schema drop and return repeats nothing either.
// Pure: no DOM, no React (vitest runs it in plain Node).

import type { HostMessage, HostStatus, NodeStatusById, ParseError, PipelineModel, WebviewMessage } from '../../src/shared/protocol';
import { errorKeys, newErrorAnnouncements } from './layout';

export interface ViewModel {
	/** The model to draw; `null` until a valid one arrives (a first open on a broken file). */
	readonly model: PipelineModel | null;
	/** Set while the YAML does not parse: the banner shows. */
	readonly parseError: ParseError | null;
	/** The node under the cursor in the driving editor, as the host computed it (`null`: none). */
	readonly selection: string | null;
	/** The error and warning markers by node id, as the host mapped them (the webview maps no ranges). */
	readonly nodeStatus: NodeStatusById;
	/** The binary and schema status, as the host reported it. */
	readonly hostStatus: HostStatus;
}

export const INITIAL_VIEW: ViewModel = {
	model: null, parseError: null, selection: null, nodeStatus: {}, hostStatus: { binary: 'unresolved', schema: 'none' },
};

/** The graph container's accessible name (EXPERIENCE Accessibility Floor). */
export const GRAPH_NAME = 'Pipeline graph, read-only';

/** The banner's text (EXPERIENCE, invalid-YAML banner). */
export const BANNER_TEXT = 'YAML has errors — showing last valid graph.';

/** The no-binary empty state's text (EXPERIENCE, graph empty state). */
export const NO_BINARY_TEXT = 'No Redpanda Connect binary. The graph needs it to read the schema.';

/** The no-binary empty state's buttons, in order, and the intent each posts (the host runs the binary warning's actions). */
export const NO_BINARY_ACTIONS = [
	{ label: 'Install guide', message: { type: 'installGuideRequested' } },
	{ label: 'Set path', message: { type: 'setPathRequested' } },
	{ label: 'Retry', message: { type: 'retryRequested' } },
] as const satisfies readonly { readonly label: string; readonly message: WebviewMessage }[];

/** The nothing-to-draw empty state's text, before and after its code (EXPERIENCE, graph empty state). */
export const NOTHING_TO_DRAW_TEXT = ['Nothing to draw yet. Add an ', 'input', ', ', 'pipeline', ' or ', 'output', ' section.'] as const;

/** Which empty state the view shows; `null`: none (the graph, or a canvas with no text). */
export type EmptyState = 'noBinary' | 'nothingToDraw' | null;

/**
 * The empty state of `view`: `noBinary` while the binary is `missing` or `invalid`;
 * `nothingToDraw` for a model with no nodes, a schema and no parse error (the banner wins);
 * otherwise none. An `unresolved` binary or a loading schema shows an empty canvas with no text
 * (VS Code's own progress covers it), and so does an `ok` binary whose schema could not be
 * produced (the schema warning reports that; the no-binary copy would be wrong).
 */
export function emptyStateOf(view: ViewModel): EmptyState {
	const { binary, schema } = view.hostStatus;
	if (binary === 'missing' || binary === 'invalid') {
		return 'noBinary';
	}
	if (schema === 'ok' && view.model && view.model.nodes.length === 0 && !view.parseError) {
		return 'nothingToDraw';
	}
	return null;
}

/** The view after `message`; unchanged (the same object) for messages that don't concern it. */
export function reduce(state: ViewModel, message: HostMessage): ViewModel {
	switch (message.type) {
		case 'snapshot':
			return {
				model: message.model,
				parseError: message.parseError ?? null,
				selection: message.selection,
				nodeStatus: message.nodeStatus,
				hostStatus: message.hostStatus,
			};
		case 'model':
			return { ...state, model: message.model, parseError: null };
		case 'parseError':
			return { ...state, parseError: { message: message.message, range: message.range } };
		case 'nodeStatus':
			return { ...state, nodeStatus: message.byId };
		case 'selection':
			return message.nodeId === state.selection ? state : { ...state, selection: message.nodeId };
		case 'hostStatus': {
			const hostStatus: HostStatus = { binary: message.binary, schema: message.schema };
			if (hostStatus.binary === state.hostStatus.binary && hostStatus.schema === state.hostStatus.schema) {
				return state;
			}
			// No schema: the host sends no model and no parse error until one arrives (AD-20).
			return hostStatus.schema === 'ok' ? { ...state, hostStatus } : { ...state, hostStatus, model: null, parseError: null };
		}
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

/** What the polite live region says (LIVE); `id` changes with every announcement, so a repeat is spoken again. */
export interface LiveMessage {
	readonly id: number;
	readonly lines: readonly string[];
}

/** The view plus the live region's latest announcement and its error baseline. */
export interface LiveView {
	readonly view: ViewModel;
	readonly live: LiveMessage;
	/**
	 * The errors, as (type, message) keys, of the last node status that had any (a snapshot's
	 * included); a status with none in between keeps it, so errors that clear on an edit and come
	 * back on save are not announced again.
	 */
	readonly errors: ReadonlySet<string>;
	/**
	 * Set by a snapshot with no model: its node status becomes the error baseline once a model
	 * arrives to map it with (F4).
	 */
	readonly baselinePending: boolean;
	/**
	 * Whether this webview has seen the file parse: a snapshot with a model and no parse error, or
	 * any `model` message (the host sends one only while the file parses).
	 */
	readonly validSeen: boolean;
}

export const INITIAL_LIVE_VIEW: LiveView = {
	view: INITIAL_VIEW, live: { id: 0, lines: [] }, errors: new Set(), baselinePending: false, validSeen: false,
};

/**
 * What `message` announces, from `state` to `next`: the banner text for a `parseError` that makes
 * the banner appear, once the webview has seen the file parse (F4: once per appearance; a new
 * message while the banner stays up says nothing); for a `nodeStatus`, "New error: {name}" for each
 * node with an error not in the baseline. A snapshot announces nothing.
 */
export function liveAnnouncements(state: LiveView, next: ViewModel, message: HostMessage): string[] {
	const lines: string[] = [];
	if (message.type === 'parseError' && !state.view.parseError && state.validSeen) {
		lines.push(BANNER_TEXT);
	}
	if (message.type === 'nodeStatus' && next.model) {
		lines.push(...newErrorAnnouncements(next.model, state.errors, next.nodeStatus));
	}
	return lines;
}

/** `reduce`, plus the announcement the change makes; the live message is kept when it makes none. */
export function reduceLive(state: LiveView, message: HostMessage): LiveView {
	const view = reduce(state.view, message);
	if (view === state.view) {
		return state;
	}
	const lines = liveAnnouncements(state, view, message);
	// The error baseline: a snapshot's or a node status's errors, or, after a snapshot with no
	// model, the snapshot's status mapped with the first model that arrives (F4).
	const sets = message.type === 'nodeStatus' || message.type === 'snapshot' || (message.type === 'model' && state.baselinePending);
	const current = sets && view.model ? errorKeys(view.model, view.nodeStatus) : undefined;
	const errors = current && current.size > 0 ? current : state.errors;
	const baselinePending = message.type === 'snapshot' ? view.model === null : state.baselinePending && !view.model;
	const validSeen = message.type === 'snapshot'
		? state.validSeen || (view.model !== null && !view.parseError)
		: state.validSeen || message.type === 'model';
	return {
		view,
		live: lines.length === 0 ? state.live : { id: state.live.id + 1, lines },
		errors,
		baselinePending,
		validSeen,
	};
}
