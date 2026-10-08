// Lays the model out with ELK (main thread, AD-4) and draws it with @xyflow/react, left to right:
// input -> processors -> output. A click on a node reports `onActivate(nodeId)`.

import { Background, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import { useEffect, useState } from 'react';
import type { PipelineModel, PipelineNode } from '../../src/shared/protocol';

const NODE_HEIGHT = 48;
/** Readable sizes (mockup key-editor-and-graph.html: nodes about 100-210 px wide at 100%). */
const MIN_NODE_WIDTH = 110;
const MAX_NODE_WIDTH = 220;
const CHAR_WIDTH = 8; // the editor font at its default size, roughly
const NODE_PADDING = 24;
/** Fit to view never shrinks the graph below this, so labels stay readable; pan for the rest. */
const MIN_FIT_ZOOM = 0.75;
const VIEW_MARGIN = 16;

/** A node's width from its longest label line. */
export function nodeWidth(node: PipelineNode): number {
	const chars = Math.max(node.name.length, node.kind.length);
	return Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, chars * CHAR_WIDTH + NODE_PADDING));
}

/** Fits the graph into the view between MIN_FIT_ZOOM and 100%; a graph still too wide starts at its input. */
function fitReadable(instance: ReactFlowInstance<ComponentNode, Edge>, width: number): void {
	void instance.fitView({ minZoom: MIN_FIT_ZOOM, maxZoom: 1, padding: 0.1 }).then(() => {
		const { y, zoom } = instance.getViewport();
		const bounds = instance.getNodesBounds(instance.getNodes());
		if (bounds.width * zoom + 2 * VIEW_MARGIN > width) {
			void instance.setViewport({ x: VIEW_MARGIN - bounds.x * zoom, y, zoom });
		}
	});
}

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
			'elk.layered.spacing.nodeNodeBetweenLayers': '40',
		},
		children: model.nodes.map((n) => ({ id: n.id, width: nodeWidth(n), height: NODE_HEIGHT })),
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
			width: nodeWidth(n),
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
			minZoom={0.25}
			maxZoom={2}
			onInit={(instance) => fitReadable(instance, window.innerWidth)}
			proOptions={{ hideAttribution: true }}
		>
			<Background />
		</ReactFlow>
	);
}
