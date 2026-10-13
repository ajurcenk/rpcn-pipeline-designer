// The Bloblang test panel webview's entry (ticket 4.2): renders `TestPanel` wired to the host
// channel. A second bundle (`dist/bloblang.js`, `dist/bloblang.css`) beside the graph's.

import './bloblang.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadInput, post, saveInput } from './host';
import { TestPanel } from './TestPanel';

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(<StrictMode><TestPanel post={post} initialInput={loadInput()} saveInput={saveInput} /></StrictMode>);
}
