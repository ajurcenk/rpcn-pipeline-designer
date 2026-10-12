// Test setup for webview/ vitest files (ticket 11). The files that run in plain Node get nothing.
// A file that opts in to happy-dom (`// @vitest-environment happy-dom`) gets a fake VS Code webview
// API (`acquireVsCodeApi`, which host.ts calls on import) that records what the view posts and
// keeps its `setState`, plus stubs of browser APIs React Flow uses that happy-dom lacks. Tests only.

/** What the fake webview API recorded; `globalThis.vscodeStub`. */
export interface VsCodeStub {
	readonly posted: unknown[];
	state: unknown;
}

declare global {
	var vscodeStub: VsCodeStub;
	var IS_REACT_ACT_ENVIRONMENT: boolean;
}

if (typeof window !== 'undefined') {
	const stub: VsCodeStub = { posted: [], state: undefined };
	globalThis.vscodeStub = stub;
	Object.assign(globalThis, {
		acquireVsCodeApi: () => ({
			postMessage: (message: unknown) => stub.posted.push(message),
			getState: () => stub.state,
			setState: (state: unknown) => {
				stub.state = state;
			},
		}),
	});
	// React's act() warns unless the environment says it is a test.
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;

	if (typeof globalThis.ResizeObserver === 'undefined') {
		globalThis.ResizeObserver = class {
			observe(): void { /* no layout in happy-dom */ }
			unobserve(): void { /* nothing observed */ }
			disconnect(): void { /* nothing observed */ }
		};
	}
	if (typeof globalThis.DOMMatrixReadOnly === 'undefined') {
		// React Flow reads only the scale (`m22`) of a CSS transform it parses.
		globalThis.DOMMatrixReadOnly = class {
			readonly m22: number;
			constructor(transform?: string) {
				const scale = /scale\(([\d.]+)/.exec(transform ?? '');
				this.m22 = scale ? Number(scale[1]) : 1;
			}
		} as unknown as typeof DOMMatrixReadOnly;
	}
}
