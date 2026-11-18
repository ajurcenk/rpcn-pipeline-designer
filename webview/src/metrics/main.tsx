// The Pipeline Metrics webview's entry (ticket 7.2): renders `MetricsView` wired to the host channel. A
// fourth bundle (`dist/metrics.js`, `dist/metrics.css`) beside the graph's, the Bloblang panel's and
// the logs tab's.

import './metrics.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { post } from './host';
import { MetricsView } from './MetricsView';

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(<StrictMode><MetricsView post={post} /></StrictMode>);
}
