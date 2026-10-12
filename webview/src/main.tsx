// The graph webview's entry (tickets 3.1, 3.4, 3.6, 3.7): posts `ready`, then folds every host message
// into the view (state.ts): the latest valid model, plus the invalid-YAML banner while a
// `parseError` stands, the highlighted node from `selection` (3.7) and the markers from `nodeStatus` (3.8). A click on the banner posts `bannerClicked`. Anything that fails
// `parseHostMessage` is ignored. It holds no domain state and parses no YAML (AD-2, AD-3). The empty
// states (3.9) come from `emptyStateOf`: no binary, with Install guide, Set path and Retry, which
// post the intents the host runs as the binary warning's actions; and nothing to draw.
// Screen readers (ticket 3.11): one always-mounted polite live region says the banner text when it
// appears and each node that newly gets an error (`reduceLive`); the banner itself is not a live
// region, so nothing is said twice. Esc on the graph container posts `focusEditorRequested`. In every
// view state exactly one focusable region is named "Pipeline graph, read-only" and handles that Esc
// (F3): the graph container, the no-binary empty state, or, with no model to draw (loading, no
// schema, a first open on broken YAML), an empty canvas region.

import '@vscode/codicons/dist/codicon.css';
import '@xyflow/react/dist/style.css';
import './graph.css';
import { StrictMode, useEffect, useReducer, useRef, type KeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHostMessage, type ParseError } from '../../src/shared/protocol';
import { Graph } from './Graph';
import { post } from './host';
import {
	BANNER_TEXT, emptyStateOf, GRAPH_NAME, INITIAL_LIVE_VIEW, NO_BINARY_ACTIONS, NO_BINARY_TEXT, NOTHING_TO_DRAW_TEXT, reduceLive,
	type EmptyState, type LiveMessage,
} from './state';

/** DESIGN invalid-yaml-banner: full width over the top of the canvas, clickable, not dismissible; `LiveRegion` announces it. */
function Banner({ error }: { readonly error: ParseError }) {
	return (
		// Esc on the banner's button goes to the editor too (F3_ESC: a way out in every state).
		<div className="rpcn-banner" onKeyDown={escToEditor}>
			<button type="button" className="rpcn-banner-button" onClick={() => post({ type: 'bannerClicked' })}>
				<span className="codicon codicon-warning rpcn-banner-icon" aria-hidden="true" />
				<span className="rpcn-banner-text">{BANNER_TEXT}</span>
				<span className="rpcn-banner-detail">{error.message}</span>
			</button>
		</div>
	);
}

/** Esc (with no modifier) on a region with no graph: the host focuses the YAML editor (F3_ESC). */
function escToEditor(event: KeyboardEvent<HTMLElement>): void {
	if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey) {
		event.preventDefault();
		post({ type: 'focusEditorRequested' });
	}
}

/**
 * The named region while there is no model to draw (loading, no schema, a first open on broken
 * YAML; F3): focusable, Esc goes to the editor; busy while the binary or the schema is still
 * being resolved.
 */
function CanvasRegion({ busy }: { readonly busy: boolean }) {
	return (
		<div
			className="rpcn-canvas-region"
			role="region"
			aria-label={GRAPH_NAME}
			aria-busy={busy ? 'true' : undefined}
			tabIndex={0}
			onKeyDown={escToEditor}
		/>
	);
}

/** Whether `target` is inside the named graph region (whichever element is it now). */
function inGraphRegion(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest(`[role="region"][aria-label="${GRAPH_NAME}"]`) !== null;
}

/** The nothing-to-draw text's id: the graph container, shown with it, is described by it. */
const NOTHING_TO_DRAW_ID = 'rpcn-nothing-to-draw';

/**
 * DESIGN graph-empty-state: fills the panel, muted text, link-styled real buttons. With no binary
 * (no graph is drawn) it is the named region itself; nothing to draw describes the graph
 * container, the one region with that name.
 */
function EmptyStateView({ state }: { readonly state: Exclude<EmptyState, null> }) {
	if (state === 'nothingToDraw') {
		return (
			<div className="rpcn-empty">
				<p className="rpcn-empty-text" id={NOTHING_TO_DRAW_ID}>
					{NOTHING_TO_DRAW_TEXT.map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))}
				</p>
			</div>
		);
	}
	return (
		<div className="rpcn-empty" role="region" aria-label={GRAPH_NAME} tabIndex={0} onKeyDown={escToEditor}>
			<p className="rpcn-empty-text">{NO_BINARY_TEXT}</p>
			<div className="rpcn-empty-actions">
				{NO_BINARY_ACTIONS.map(({ label, message }) => (
					<button key={label} type="button" className="rpcn-empty-action" onClick={() => post(message)}>{label}</button>
				))}
			</div>
		</div>
	);
}

/** The polite live region (LIVE): always mounted, visually hidden; each announcement replaces the last. */
function LiveRegion({ live }: { readonly live: LiveMessage }) {
	return (
		<div className="rpcn-sr-only" role="status" aria-live="polite" aria-atomic="true">
			{live.lines.map((line, i) => <p key={`${live.id}:${i}`}>{line}</p>)}
		</div>
	);
}

export function App() {
	const [{ view, live }, dispatch] = useReducer(reduceLive, INITIAL_LIVE_VIEW);
	// Whether keyboard focus was in the graph when it unmounted, so it returns when it draws again (F5).
	const graphFocus = useRef(false);
	useEffect(() => {
		const onMessage = (event: MessageEvent<unknown>) => {
			const message = parseHostMessage(event.data);
			if (message) {
				dispatch(message);
			}
		};
		window.addEventListener('message', onMessage);
		post({ type: 'ready' });
		return () => window.removeEventListener('message', onMessage);
	}, []);
	// Fixed slots, so the banner coming and going never remounts the graph (its viewport stays);
	// the banner overlays the top of the canvas, so the canvas never resizes either.
	const empty = emptyStateOf(view);
	const drawn = view.model !== null && empty !== 'noBinary';
	const busy = view.hostStatus.schema === 'loading' || view.hostStatus.binary === 'unresolved';
	return (
		// Focus moving anywhere in the view records whether it is in the graph region (the no-binary
		// state and the empty canvas included), so it returns when the graph draws again (F5).
		<div
			className="rpcn-canvas"
			onFocus={(event) => {
				graphFocus.current = inGraphRegion(event.target);
			}}
		>
			{!drawn && empty !== 'noBinary' && <CanvasRegion busy={busy} />}
			{view.model && drawn && (
				<Graph
					model={view.model}
					selection={view.selection}
					nodeStatus={view.nodeStatus}
					onActivate={(nodeId, via) => post({ type: 'nodeActivated', nodeId, via })}
					onFocusEditor={() => post({ type: 'focusEditorRequested' })}
					broken={view.parseError !== null}
					focusReturn={graphFocus}
					{...(empty === 'nothingToDraw' ? { describedBy: NOTHING_TO_DRAW_ID } : {})}
				/>
			)}
			{empty && <EmptyStateView state={empty} />}
			{view.parseError && <Banner error={view.parseError} />}
			<LiveRegion live={live} />
		</div>
	);
}

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(<StrictMode><App /></StrictMode>);
}
