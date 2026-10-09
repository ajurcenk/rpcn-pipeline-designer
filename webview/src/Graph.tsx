// Draws the laid-out model with @xyflow/react (ticket 3.4): groups as boxes holding their children,
// routes as captioned sub-boxes, resources standalone. The layout itself is in layout.ts. The view
// holds only view state (AD-3): which groups are collapsed, kept across models and in `setState`.
// A click on a node reports `onActivate(nodeId)`; the chevron of a group toggles its collapse.

import { Background, ReactFlow, type Edge, type ReactFlowInstance } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PipelineModel } from '../../src/shared/protocol';
import { loadViewState, saveViewState } from './host';
import { layout, pruneCollapsed, toggleCollapsed, type Collapsed, type Layout, type ViewNode } from './layout';
import { nodeTypes, ToggleContext } from './nodes';

/** Fit to view never shrinks the graph below this, so labels stay readable; pan for the rest. */
const MIN_FIT_ZOOM = 0.75;
const VIEW_MARGIN = 16;

/**
 * Fits the graph into the view between MIN_FIT_ZOOM and 100%, at once (no animation); a graph
 * still too wide starts at its input.
 */
function fitReadable(instance: ReactFlowInstance<ViewNode, Edge>, width: number): void {
	void instance.fitView({ minZoom: MIN_FIT_ZOOM, maxZoom: 1, padding: 0.1 }).then(() => {
		const { y, zoom } = instance.getViewport();
		const bounds = instance.getNodesBounds(instance.getNodes().filter((n) => n.parentId === undefined));
		if (bounds.width * zoom + 2 * VIEW_MARGIN > width) {
			void instance.setViewport({ x: VIEW_MARGIN - bounds.x * zoom, y, zoom });
		}
	});
}

export function Graph({ model, onActivate }: { readonly model: PipelineModel; readonly onActivate: (nodeId: string) => void }) {
	const [collapsedState, setCollapsedState] = useState<Collapsed>(() => new Set(loadViewState().collapsed ?? []));
	// Only groups the current model still has (COLLAPSE_KEPT / COLLAPSE_GONE).
	const collapsed = useMemo(() => pruneCollapsed(collapsedState, model), [collapsedState, model]);
	useEffect(() => {
		saveViewState({ collapsed: [...collapsed] });
	}, [collapsed]);
	const toggle = useCallback((id: string) => setCollapsedState((current) => toggleCollapsed(pruneCollapsed(current, model), id)), [model]);

	const [laidOut, setLaidOut] = useState<Layout | undefined>(undefined);
	useEffect(() => {
		let current = true;
		layout(model, collapsed).then((l) => current && setLaidOut(l), (error: unknown) => {
			console.error('Graph layout failed:', error);
			if (current) {
				setLaidOut({ nodes: [], edges: [] });
			}
		});
		return () => {
			current = false;
		};
	}, [model, collapsed]);
	if (!laidOut) {
		return null;
	}
	return (
		<ToggleContext.Provider value={toggle}>
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
		</ToggleContext.Provider>
	);
}
