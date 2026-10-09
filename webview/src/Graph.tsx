// Draws the laid-out model with @xyflow/react (ticket 3.4): groups as boxes holding their children,
// routes as captioned sub-boxes, resources standalone. The layout itself is in layout.ts. The view
// holds only view state (AD-3): which groups are collapsed, kept across models and in `setState`.
// A click on a node reports `onActivate(nodeId)`; the chevron of a group toggles its collapse.
// The node the host says is under the cursor (`selection`, ticket 3.7) is highlighted, or the
// collapsed group hiding it; a selection change restyles the drawing without laying it out again.
// Each new model (ticket 3.6) is laid out again and replaces the drawing in place. The view is
// placed once per mount, on the first laid-out model with nodes (`firstView`): the viewport saved
// in `setState` at the end of every move is restored (a recreated webview), else the graph fits.
// Later models keep the user's pan and zoom.

import { Background, ReactFlow, type Edge, type ReactFlowInstance } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PipelineModel } from '../../src/shared/protocol';
import { loadViewState, saveViewState } from './host';
import {
	highlightDrawn, layout, pruneCollapsed, toggleCollapsed, type Collapsed, type Drawn, type ViewNode,
} from './layout';
import { ActivateContext, nodeTypes, ToggleContext } from './nodes';
import { firstView } from './state';

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

export function Graph({ model, selection, onActivate }: {
	readonly model: PipelineModel;
	/** The node under the cursor in the driving editor (`null`: none). */
	readonly selection: string | null;
	readonly onActivate: (nodeId: string) => void;
}) {
	const [collapsedState, setCollapsedState] = useState<Collapsed>(() => new Set(loadViewState().collapsed ?? []));
	// Only groups the current model still has (COLLAPSE_KEPT / COLLAPSE_GONE).
	const collapsed = useMemo(() => pruneCollapsed(collapsedState, model), [collapsedState, model]);
	useEffect(() => {
		saveViewState({ collapsed: [...collapsed] });
	}, [collapsed]);
	const toggle = useCallback((id: string) => setCollapsedState((current) => toggleCollapsed(pruneCollapsed(current, model), id)), [model]);

	const [laidOut, setLaidOut] = useState<Drawn | undefined>(undefined);
	useEffect(() => {
		let current = true;
		layout(model, collapsed).then((l) => current && setLaidOut({ ...l, model, collapsed }), (error: unknown) => {
			console.error('Graph layout failed:', error);
			if (current) {
				setLaidOut({ nodes: [], edges: [], model, collapsed });
			}
		});
		return () => {
			current = false;
		};
	}, [model, collapsed]);

	const [instance, setInstance] = useState<ReactFlowInstance<ViewNode, Edge> | undefined>(undefined);
	const [savedViewport] = useState(() => loadViewState().viewport);
	const placed = useRef(false);
	useEffect(() => {
		if (!instance || !laidOut) {
			return;
		}
		const action = firstView(placed.current, laidOut.nodes.length, savedViewport);
		if (action === 'none') {
			return;
		}
		placed.current = true;
		if (action === 'restore' && savedViewport) {
			void instance.setViewport(savedViewport);
		} else {
			fitReadable(instance, window.innerWidth);
		}
	}, [instance, laidOut, savedViewport]);
	// The drawn node to highlight (VIEW_HIGHLIGHT), against the model and collapse state drawn.
	const highlighted = useMemo(() => (laidOut ? highlightDrawn(laidOut, selection) : []), [laidOut, selection]);
	if (!laidOut) {
		return null;
	}
	return (
		<ToggleContext.Provider value={toggle}>
			<ActivateContext.Provider value={onActivate}>
				<ReactFlow
					nodes={highlighted}
					edges={laidOut.edges}
					nodeTypes={nodeTypes}
					onNodeClick={(_, node) => onActivate(node.id)}
					nodesDraggable={false}
					nodesConnectable={false}
					edgesFocusable={false}
					elementsSelectable={false}
					minZoom={0.25}
					maxZoom={2}
					onInit={setInstance}
					onMoveEnd={(_, { x, y, zoom }) => saveViewState({ viewport: { x, y, zoom } })}
					proOptions={{ hideAttribution: true }}
				>
					<Background />
				</ReactFlow>
			</ActivateContext.Provider>
		</ToggleContext.Provider>
	);
}
