// The webview's only channel to the host (AD-3, AD-5): it posts user intents and nothing else,
// and keeps its view state (collapsed groups, viewport) with `setState` so it survives a reload.

import type { WebviewMessage } from '../../src/shared/protocol';
import { parseViewport, type Viewport } from './state';

/** The webview's view state (AD-3): never domain state. */
export interface ViewState {
	/** Ids of the groups the user has collapsed. */
	readonly collapsed?: readonly string[];
	/** The pan and zoom at the end of the last move. */
	readonly viewport?: Viewport;
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
	const { collapsed, viewport } = state as Record<string, unknown>;
	const saved = parseViewport(viewport);
	return {
		...(Array.isArray(collapsed) ? { collapsed: collapsed.filter((id): id is string => typeof id === 'string') } : {}),
		...(saved ? { viewport: saved } : {}),
	};
}

/** Saves part of the view state for the next load of this panel; the other parts are kept. */
export function saveViewState(state: ViewState): void {
	api.setState({ ...loadViewState(), ...state });
}
