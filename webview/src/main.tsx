// The graph webview's entry (ticket 3.1): posts `ready`, renders every `snapshot` it is sent.
// It holds no domain state and parses no YAML (AD-2, AD-3).

import '@xyflow/react/dist/style.css';
import './graph.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HostMessage, PipelineModel } from '../../src/shared/protocol';
import { Graph } from './Graph';
import { post } from './host';

function App() {
	const [model, setModel] = useState<PipelineModel | undefined>(undefined);
	useEffect(() => {
		const onMessage = (event: MessageEvent<HostMessage>) => {
			const message = event.data;
			if (message?.type === 'snapshot') {
				setModel(message.model);
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
