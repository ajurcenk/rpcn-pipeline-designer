// The webview's only channel to the host (AD-3, AD-5): it posts user intents and nothing else.

import type { WebviewMessage } from '../../src/shared/protocol';

interface VsCodeApi {
	postMessage(message: WebviewMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

/** Posts a message to the extension host. */
export function post(message: WebviewMessage): void {
	api.postMessage(message);
}
