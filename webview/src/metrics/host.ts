// The Pipeline Metrics webview's only channel to the host (AD-3, AD-5, ticket 7.2): it posts `ready`
// each time it loads, and gets the whole state then. It keeps no view state of its own.

import type { MetricsWebviewMessage } from '../../../src/shared/metricsProtocol';

interface VsCodeApi {
	postMessage(message: MetricsWebviewMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

/** Posts a message to the extension host. */
export function post(message: MetricsWebviewMessage): void {
	(api ??= acquireVsCodeApi()).postMessage(message);
}
