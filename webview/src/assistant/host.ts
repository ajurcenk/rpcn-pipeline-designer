// The assistant webview's only channel to the host (AD-3, AD-5, story 8.1): it posts `ready` each time
// it loads, and gets the whole state then. It keeps no view state of its own.

import type { AssistantWebviewMessage } from '../../../src/shared/assistantProtocol';

interface VsCodeApi {
	postMessage(message: AssistantWebviewMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

/** Posts a message to the extension host. */
export function post(message: AssistantWebviewMessage): void {
	(api ??= acquireVsCodeApi()).postMessage(message);
}
