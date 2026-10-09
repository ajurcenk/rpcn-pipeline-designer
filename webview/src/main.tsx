// The graph webview's entry (tickets 3.1, 3.4): posts `ready`, renders the model of every `snapshot`
// (or `model`) it is sent; anything that fails `parseHostMessage` is ignored.
// It holds no domain state and parses no YAML (AD-2, AD-3).

import '@vscode/codicons/dist/codicon.css';
import '@xyflow/react/dist/style.css';
import './graph.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHostMessage, type PipelineModel } from '../../src/shared/protocol';
import { Graph } from './Graph';
import { post } from './host';

function App() {
	const [model, setModel] = useState<PipelineModel | undefined>(undefined);
	useEffect(() => {
		const onMessage = (event: MessageEvent<unknown>) => {
			const message = parseHostMessage(event.data);
			if (message?.type === 'snapshot' || message?.type === 'model') {
				setModel(message.model ?? undefined);
			}
		};
		window.addEventListener('message', onMessage);
		post({ type: 'ready' });
		return () => window.removeEventListener('message', onMessage);
	}, []);
	return model ? <Graph model={model} onActivate={(nodeId) => post({ type: 'nodeActivated', nodeId, via: 'click' })} /> : null;
}

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(<StrictMode><App /></StrictMode>);
}
