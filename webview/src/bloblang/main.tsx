// The Bloblang test panel webview's entry (tickets 4.2, 4.7): renders `TestPanel` wired to the host
// channel and its saved view state. A second bundle (`dist/bloblang.js`, `dist/bloblang.css`) beside the graph's.

import './bloblang.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadViewState, post, saveViewState } from './host';
import { TestPanel } from './TestPanel';

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(<StrictMode><TestPanel post={post} initialState={loadViewState()} saveState={saveViewState} /></StrictMode>);
}
