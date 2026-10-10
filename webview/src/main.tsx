// The graph webview's entry (tickets 3.1, 3.4, 3.6, 3.7): posts `ready`, then folds every host message
// into the view (state.ts): the latest valid model, plus the invalid-YAML banner while a
// `parseError` stands, the highlighted node from `selection` (3.7) and the markers from `nodeStatus` (3.8). A click on the banner posts `bannerClicked`. Anything that fails
// `parseHostMessage` is ignored. It holds no domain state and parses no YAML (AD-2, AD-3). The empty
// states (3.9) come from `emptyStateOf`: no binary, with Install guide, Set path and Retry, which
// post the intents the host runs as the binary warning's actions; and nothing to draw.

import '@vscode/codicons/dist/codicon.css';
import '@xyflow/react/dist/style.css';
import './graph.css';
import { StrictMode, useEffect, useReducer } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHostMessage, type ParseError } from '../../src/shared/protocol';
import { Graph } from './Graph';
import { post } from './host';
import { BANNER_TEXT, emptyStateOf, INITIAL_VIEW, NO_BINARY_ACTIONS, NO_BINARY_TEXT, NOTHING_TO_DRAW_TEXT, reduce, type EmptyState } from './state';

/** DESIGN invalid-yaml-banner: full width over the top of the canvas, clickable, not dismissible, a polite live region. */
function Banner({ error }: { readonly error: ParseError }) {
	return (
		<div className="rpcn-banner" role="status">
			<button type="button" className="rpcn-banner-button" onClick={() => post({ type: 'bannerClicked' })}>
				<span className="codicon codicon-warning rpcn-banner-icon" aria-hidden="true" />
				<span className="rpcn-banner-text">{BANNER_TEXT}</span>
				<span className="rpcn-banner-detail">{error.message}</span>
			</button>
		</div>
	);
}

/** DESIGN graph-empty-state: fills the panel, muted text, link-styled real buttons. */
function EmptyStateView({ state }: { readonly state: Exclude<EmptyState, null> }) {
	return (
		<div className="rpcn-empty" role="region" aria-label="Pipeline graph, read-only">
			{state === 'noBinary' ? (
				<>
					<p className="rpcn-empty-text">{NO_BINARY_TEXT}</p>
					<div className="rpcn-empty-actions">
						{NO_BINARY_ACTIONS.map(({ label, message }) => (
							<button key={label} type="button" className="rpcn-empty-action" onClick={() => post(message)}>{label}</button>
						))}
					</div>
				</>
			) : (
				<p className="rpcn-empty-text">
					{NOTHING_TO_DRAW_TEXT.map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))}
				</p>
			)}
		</div>
	);
}

function App() {
	const [view, dispatch] = useReducer(reduce, INITIAL_VIEW);
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
	return (
		<div className="rpcn-canvas">
			{view.model && empty !== 'noBinary' && (
				<Graph
					model={view.model}
					selection={view.selection}
					nodeStatus={view.nodeStatus}
					onActivate={(nodeId) => post({ type: 'nodeActivated', nodeId, via: 'click' })}
				/>
			)}
			{empty && <EmptyStateView state={empty} />}
			{view.parseError && <Banner error={view.parseError} />}
		</div>
	);
}

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(<StrictMode><App /></StrictMode>);
}
