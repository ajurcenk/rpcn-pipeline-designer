// The Pipeline Logs webview's only channel to the host (AD-3, AD-5, ticket 6.2): it posts `ready`
// each time it loads, and gets the whole state then. It keeps no view state of its own.

import type { LogsWebviewMessage } from '../../../src/shared/logsProtocol';

interface VsCodeApi {
	postMessage(message: LogsWebviewMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

/** Posts a message to the extension host. */
export function post(message: LogsWebviewMessage): void {
	(api ??= acquireVsCodeApi()).postMessage(message);
}
