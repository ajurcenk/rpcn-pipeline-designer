// The Pipeline Logs webview's entry (ticket 6.2): renders `LogsView` wired to the host channel. A third
// bundle (`dist/logs.js`, `dist/logs.css`) beside the graph's and the Bloblang panel's.

import './logs.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { post } from './host';
import { LogsView } from './LogsView';

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(<StrictMode><LogsView post={post} /></StrictMode>);
}
