// The webview's only channel to the host (AD-3, AD-5): it posts user intents and nothing else,
// and keeps its view state (collapsed groups) with `setState` so it survives a reload.

import type { WebviewMessage } from '../../src/shared/protocol';

/** The webview's view state (AD-3): never domain state. */
export interface ViewState {
	/** Ids of the groups the user has collapsed. */
	readonly collapsed?: readonly string[];
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
	if (typeof state === 'object' && state !== null && Array.isArray((state as ViewState).collapsed)) {
		return { collapsed: (state as ViewState).collapsed!.filter((id): id is string => typeof id === 'string') };
	}
	return {};
}

/** Saves the view state for the next load of this panel. */
export function saveViewState(state: ViewState): void {
	api.setState(state);
}
