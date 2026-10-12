// The webview's only channel to the host (AD-3, AD-5): it posts user intents and nothing else,
// and keeps its view state (collapsed groups, viewport, the focused node) with `setState` so it survives a reload.

import type { WebviewMessage } from '../../src/shared/protocol';
import { parseViewport, type Viewport } from './state';

/** The webview's view state (AD-3): never domain state. */
export interface ViewState {
	/** Ids of the groups the user has collapsed. */
	readonly collapsed?: readonly string[];
	/** The pan and zoom at the end of the last move. */
	readonly viewport?: Viewport;
	/** The node holding the graph's Tab stop, then its ancestors, nearest first (ticket 3.11). */
	readonly focused?: readonly string[];
}

interface VsCodeApi {
	postMessage(message: WebviewMessage): void;
	getState(): unknown;
	setState(state: ViewState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

/** Posts a message to the extension host. */
export function post(message: WebviewMessage): void {
	api.postMessage(message);
}

/** The view state saved by an earlier `saveViewState`, or an empty one. */
export function loadViewState(): ViewState {
	const state = api.getState();
	if (typeof state !== 'object' || state === null) {
		return {};
	}
	const { collapsed, viewport, focused } = state as Record<string, unknown>;
	const saved = parseViewport(viewport);
	const strings = (value: unknown[]) => value.filter((id): id is string => typeof id === 'string');
	return {
		...(Array.isArray(collapsed) ? { collapsed: strings(collapsed) } : {}),
		...(saved ? { viewport: saved } : {}),
		...(Array.isArray(focused) ? { focused: strings(focused) } : {}),
	};
}

/** Saves part of the view state for the next load of this panel; the other parts are kept. */
export function saveViewState(state: ViewState): void {
	api.setState({ ...loadViewState(), ...state });
}
