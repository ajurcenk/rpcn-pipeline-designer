// The assistant webview's entry (story 8.1): renders `AssistantView` wired to the host channel. Its own
// bundle (`dist/assistant.js`, `dist/assistant.css`).

import './assistant.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { post } from './host';
import { AssistantView } from './AssistantView';

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(<StrictMode><AssistantView post={post} /></StrictMode>);
}
