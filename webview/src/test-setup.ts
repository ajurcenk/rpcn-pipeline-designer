// Test setup for webview/ vitest files (ticket 3.11). The files that run in plain Node get nothing.
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
	/** Reports a new size of an element to the stubbed `ResizeObserver`s watching it (ticket 4.19). */
	var resizeStub: { trigger(element: Element, size: { readonly width: number; readonly height: number }): void };
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

	{
		// No layout in happy-dom. As a browser does, each observed element is reported once after
		// `observe`, here with a fractional size (INITIAL_SIZE, as at a non-integer zoom); later sizes
		// only when a test calls `resizeStub.trigger`. Always installed, over happy-dom's own (which
		// reports nothing), so tests control it.
		const INITIAL_SIZE = { width: 800.5, height: 600.25 };
		const observers = new Set<StubResizeObserver>();
		const report = (observer: StubResizeObserver, element: Element, { width, height }: { width: number; height: number }) => {
			const entry = { target: element, contentRect: { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height } };
			observer.callback([entry as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver);
		};
		class StubResizeObserver {
			readonly observed = new Set<Element>();
			constructor(readonly callback: ResizeObserverCallback) {}
			observe(element: Element): void {
				this.observed.add(element);
				observers.add(this);
				queueMicrotask(() => {
					if (this.observed.has(element)) {
						report(this, element, INITIAL_SIZE);
					}
				});
			}
			unobserve(element: Element): void {
				this.observed.delete(element);
			}
			disconnect(): void {
				this.observed.clear();
				observers.delete(this);
			}
		}
		globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
		globalThis.resizeStub = {
			trigger(element, size) {
				for (const observer of [...observers].filter((o) => o.observed.has(element))) {
					report(observer, element, size);
				}
			},
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
