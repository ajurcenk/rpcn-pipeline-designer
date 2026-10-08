// Lays the model out with ELK (main thread, AD-4) and draws it with @xyflow/react, left to right:
// input -> processors -> output. A click on a node reports `onActivate(nodeId)`.

import { Background, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import { useEffect, useState } from 'react';
import type { PipelineModel, PipelineNode } from '../../src/shared/protocol';

const NODE_WIDTH = 180;
const NODE_HEIGHT = 48;

const elk = new ELK();

type ComponentData = { readonly node: PipelineNode };
type ComponentNode = Node<ComponentData, 'component'>;

function ComponentView({ data }: NodeProps<ComponentNode>) {
	const { node } = data;
	return (
		<div className={`rpcn-node rpcn-node-${node.kind}`} title={`${node.kind}: ${node.name}`}>
			{node.kind !== 'input' && <Handle type="target" position={Position.Left} isConnectable={false} />}
			<div className="rpcn-node-kind">{node.kind}</div>
			<div className="rpcn-node-name">{node.name}</div>
			{node.kind !== 'output' && <Handle type="source" position={Position.Right} isConnectable={false} />}
		</div>
	);
}

const nodeTypes = { component: ComponentView };

interface Layout {
	readonly nodes: ComponentNode[];
	readonly edges: Edge[];
}

async function layout(model: PipelineModel): Promise<Layout> {
	const graph = await elk.layout({
		id: 'root',
		layoutOptions: {
			'elk.algorithm': 'layered',
			'elk.direction': 'RIGHT',
			'elk.spacing.nodeNode': '24',
			'elk.layered.spacing.nodeNodeBetweenLayers': '48',
		},
		children: model.nodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
		edges: model.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
	});
	const positions = new Map((graph.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
	return {
		nodes: model.nodes.map((n) => ({
			id: n.id,
			type: 'component',
			position: positions.get(n.id) ?? { x: 0, y: 0 },
			data: { node: n },
			draggable: false,
			connectable: false,
			width: NODE_WIDTH,
			height: NODE_HEIGHT,
		})),
		edges: model.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, focusable: false })),
	};
}

export function Graph({ model, onActivate }: { readonly model: PipelineModel; readonly onActivate: (nodeId: string) => void }) {
	const [laidOut, setLaidOut] = useState<Layout | undefined>(undefined);
	useEffect(() => {
		let current = true;
		layout(model).then((l) => current && setLaidOut(l), (error: unknown) => {
			console.error('Graph layout failed:', error);
			if (current) {
				setLaidOut({ nodes: [], edges: [] });
			}
		});
		return () => {
			current = false;
		};
	}, [model]);
	if (!laidOut) {
		return null;
	}
	return (
		<ReactFlow
			nodes={laidOut.nodes}
			edges={laidOut.edges}
			nodeTypes={nodeTypes}
			onNodeClick={(_, node) => onActivate(node.id)}
			nodesDraggable={false}
			nodesConnectable={false}
			edgesFocusable={false}
			elementsSelectable={false}
			fitView
			proOptions={{ hideAttribution: true }}
		>
			<Background />
		</ReactFlow>
	);
}
