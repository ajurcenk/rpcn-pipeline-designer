// The Bloblang test panel's only channel to the host (AD-3, AD-5, ticket 4.2): it posts the user's
// intents and keeps its view state (the typed input) with `setState`, so that it survives a reload.

import type { BloblangWebviewMessage } from '../../../src/shared/bloblangProtocol';

interface VsCodeApi {
	postMessage(message: BloblangWebviewMessage): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

/** Posts a message to the extension host. */
export function post(message: BloblangWebviewMessage): void {
	api.postMessage(message);
}

/** The input saved by `saveInput`, or `''`. */
export function loadInput(): string {
	const state = api.getState();
	const input = typeof state === 'object' && state !== null ? (state as Record<string, unknown>).input : undefined;
	return typeof input === 'string' ? input : '';
}

/** Saves the typed input for the next load of this panel. */
export function saveInput(input: string): void {
	api.setState({ input });
}
