// The Bloblang test panel's only channel to the host (AD-3, AD-5, tickets 4.2, 4.7): it posts the
// user's intents and keeps its view state (the input content and metadata rows, the selected tabs
// and Run on change) with `setState`, so that it survives a reload.

import type { BloblangWebviewMessage } from '../../../src/shared/bloblangProtocol';
import type { MetaRow } from './changes';

interface VsCodeApi {
	postMessage(message: BloblangWebviewMessage): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Which tab of a column shows. */
export type PanelTab = 'content' | 'meta';

/** The panel's view state. */
export interface ViewState {
	readonly content: string;
	readonly meta: readonly MetaRow[];
	readonly inputTab: PanelTab;
	readonly outputTab: PanelTab;
	readonly runOnChange: boolean;
}

export const DEFAULT_VIEW_STATE: ViewState = { content: '', meta: [], inputTab: 'content', outputTab: 'content', runOnChange: true };

const isTab = (v: unknown): v is PanelTab => v === 'content' || v === 'meta';
const isRow = (v: unknown): v is MetaRow =>
	typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).key === 'string' && typeof (v as Record<string, unknown>).value === 'string';

/**
 * Reads saved view state; anything missing or malformed takes its default. 4.2's `{input}` is read
 * as the content.
 */
export function readViewState(state: unknown): ViewState {
	if (typeof state !== 'object' || state === null) {
		return DEFAULT_VIEW_STATE;
	}
	const s = state as Record<string, unknown>;
	const content = typeof s.content === 'string' ? s.content : typeof s.input === 'string' ? s.input : '';
	return {
		content,
		meta: Array.isArray(s.meta) ? s.meta.filter(isRow).map((r) => ({ key: r.key, value: r.value })) : [],
		inputTab: isTab(s.inputTab) ? s.inputTab : 'content',
		outputTab: isTab(s.outputTab) ? s.outputTab : 'content',
		runOnChange: typeof s.runOnChange === 'boolean' ? s.runOnChange : true,
	};
}

let api: VsCodeApi | undefined;
const vscode = (): VsCodeApi => (api ??= acquireVsCodeApi());

/** Posts a message to the extension host. */
export function post(message: BloblangWebviewMessage): void {
	vscode().postMessage(message);
}

/** The view state saved by `saveViewState`, or the defaults. */
export function loadViewState(): ViewState {
	return readViewState(vscode().getState());
}

/** Saves the view state for the next load of this panel. */
export function saveViewState(state: ViewState): void {
	vscode().setState(state);
}
