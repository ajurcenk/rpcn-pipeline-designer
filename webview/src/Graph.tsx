// Draws the laid-out model with @xyflow/react (ticket 3.4): groups as boxes holding their children,
// routes as captioned sub-boxes, resources standalone. The layout itself is in layout.ts. The view
// holds only view state (AD-3): which groups are collapsed, kept across models and in `setState`.
// A click on a node reports `onActivate(nodeId)`; the chevron of a group toggles its collapse.
// The node the host says is under the cursor (`selection`, ticket 3.7) is highlighted, or the
// collapsed group hiding it; a selection change restyles the drawing without laying it out again.
// Each new model (ticket 3.6) is laid out again and replaces the drawing in place. The view is
// placed once per mount, on the first laid-out model with nodes (`firstView`): the viewport saved
// in `setState` at the end of every move is restored (a recreated webview), else the graph fits.
// Later models keep the user's pan and zoom. Node status (ticket 3.8): each drawn box gets its
// error or warning marker from the host's `nodeStatus` (`markStatus`: a leaf and a collapsed group
// by the roll-up, an expanded group or route by its own severity); the webview maps no ranges.
// Keyboard and screen reader (ticket 3.11): the graph container ("Pipeline graph, read-only") holds
// one roving Tab stop, the last focused drawn node (else the first); the arrows move it
// (`nextFocus`), Enter activates the node (`via: 'keyboard'`), Space toggles a group, Esc on a node
// focuses the container and Esc on the container asks the host to focus the YAML editor. Each node
// is named by `nodeAnnouncement`. React Flow's own keyboard handling is off. The focused node is
// view state, kept with the collapse state; a node that goes passes focus to its nearest visible
// ancestor (`focusTarget`). A host `selection` never moves focus.
// Resize (ticket 4.19): when the container's size settles after a change (a test panel opened
// below, a divider dragged), the graph fits again with the first fit's rule, unless the user has
// panned or zoomed since the last fit (a move started by pointer, wheel or touch; a fit, a restore
// or a keyboard reveal is not one). That mark is saved with the viewport. The Fit to view button,
// after the graph region in the Tab order, fits the graph and clears the mark.

import { Background, ReactFlow, type AriaLabelConfig, type Edge, type ReactFlowInstance } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MutableRefObject } from 'react';
import type { ActivationVia, NodeStatusById, PipelineModel } from '../../src/shared/protocol';
import { loadViewState, saveViewState } from './host';
import {
	focusChain, focusTarget, highlightDrawn, layout, markStatus, motionDuration, nextFocus, nodeAnnouncement, pruneCollapsed,
	toggleCollapsed, type ArrowKey, type Collapsed, type Drawn, type ViewNode,
} from './layout';
import { ActivateContext, nodeTypes, ToggleContext } from './nodes';
import { firstView, GRAPH_NAME } from './state';

/**
 * React Flow's node and edge descriptions, blanked: they describe moving, selecting and deleting,
 * which this read-only graph does not do (and 12.12.0 swaps the two node texts).
 */
const NO_DESCRIPTIONS: Partial<AriaLabelConfig> = {
	'node.a11yDescription.default': '',
	'node.a11yDescription.keyboardDisabled': '',
	'edge.a11yDescription.default': '',
};

const ARROWS: readonly string[] = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'] satisfies readonly ArrowKey[];

/** The drawn node element for `id` inside `container`. */
function nodeElement(container: HTMLElement | null, id: string): HTMLElement | undefined {
	return [...container?.querySelectorAll<HTMLElement>('.react-flow__node') ?? []].find((el) => el.dataset.id === id);
}

/** The drawn node id of the element an event came from, if it is (inside) a node of `container`. */
function nodeIdOf(container: HTMLElement | null, target: EventTarget | null): string | undefined {
	const el = target instanceof Element ? target.closest<HTMLElement>('.react-flow__node') : null;
	return el && container?.contains(el) ? el.dataset.id : undefined;
}

function prefersReducedMotion(): boolean {
	return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Fit to view never shrinks the graph below this, so labels stay readable; pan for the rest. */
const MIN_FIT_ZOOM = 0.75;
const VIEW_MARGIN = 16;
/** How long the container's size must stay the same before the graph fits again (ticket 4.19). */
const REFIT_DELAY = 150;
/** The Fit to view button's name and tooltip (ticket 4.19). */
export const FIT_TO_VIEW = 'Fit to view';

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

export function Graph({ model, selection, nodeStatus, onActivate, onFocusEditor, describedBy, broken = false, focusReturn }: {
	readonly model: PipelineModel;
	/** The node under the cursor in the driving editor (`null`: none). */
	readonly selection: string | null;
	/** The error and warning markers by node id (3.8). */
	readonly nodeStatus: NodeStatusById;
	readonly onActivate: (nodeId: string, via: ActivationVia) => void;
	/** Esc on the graph container (ticket 3.11): the host focuses the YAML editor. */
	readonly onFocusEditor: () => void;
	/** The id of an element describing the container (the nothing-to-draw text). */
	readonly describedBy?: string;
	/** The YAML does not parse (the banner shows): each node's name says a click does nothing (F8). */
	readonly broken?: boolean;
	/**
	 * Whether keyboard focus was in the graph when it last unmounted (the view mounts it again when
	 * it draws again): it is set on unmount and read on mount, so focus comes back (F5_FOCUS).
	 */
	readonly focusReturn?: MutableRefObject<boolean>;
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
	/** Whether the user has panned or zoomed since the last fit; a restored viewport keeps its mark. */
	const userMoved = useRef(savedViewport !== undefined && loadViewState().userMoved === true);
	/** Fits the graph (`fitReadable`) and marks the view untouched. */
	const fit = useCallback((target: ReactFlowInstance<ViewNode, Edge>, width: number) => {
		userMoved.current = false;
		saveViewState({ userMoved: false });
		fitReadable(target, width);
	}, []);
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
			fit(instance, window.innerWidth);
		}
	}, [instance, laidOut, savedViewport, fit]);
	// The drawn node to highlight (VIEW_HIGHLIGHT), against the model and collapse state drawn.
	// The markers (VIEW_MARKERS), against the same drawing.
	const marked = useMemo(() => (laidOut ? markStatus(laidOut, nodeStatus) : []), [laidOut, nodeStatus]);
	const highlighted = useMemo(() => (laidOut ? highlightDrawn(laidOut, selection, marked) : []), [laidOut, selection, marked]);

	// Keyboard focus (ticket 3.11): the last focused node and its ancestors, nearest first.
	const container = useRef<HTMLDivElement>(null);

	// Resize (ticket 4.19): one refit after the container's size settles, into its new width. Before
	// the first placement, after a user move, or while the container has no size, nothing.
	const lastSize = useRef<{ readonly width: number; readonly height: number } | undefined>(undefined);
	useEffect(() => {
		const el = container.current;
		if (!el || !instance) {
			return undefined;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const observer = new ResizeObserver((entries) => {
			const entry = entries.at(-1);
			if (!entry) {
				return;
			}
			const { width, height } = entry.contentRect;
			// The first report (a browser sends one on `observe`) is the baseline, never a change.
			const last = lastSize.current;
			lastSize.current = { width, height };
			if (!last || (width === last.width && height === last.height)) {
				return;
			}
			clearTimeout(timer);
			timer = setTimeout(() => {
				if (placed.current && !userMoved.current && width > 0 && height > 0) {
					fit(instance, width);
				}
			}, REFIT_DELAY);
		});
		observer.observe(el);
		return () => {
			observer.disconnect();
			clearTimeout(timer);
		};
	}, [instance, fit]);
	/** A move started by pointer, wheel or touch (a non-null event) is the user's; a fit's or a reveal's is not. */
	const markMoved = useCallback((event: MouseEvent | TouchEvent | null) => {
		if (event) {
			userMoved.current = true;
		}
	}, []);
	const [focused, setFocused] = useState<readonly string[] | undefined>(() => loadViewState().focused);
	useEffect(() => {
		if (focused) {
			saveViewState({ focused: [...focused] });
		}
	}, [focused]);
	/**
	 * Whether keyboard focus is in the graph, so a focused node that goes passes focus on; at mount,
	 * whether it was when the graph last unmounted (F5_FOCUS).
	 */
	const hasFocus = useRef(focusReturn?.current ?? false);
	useEffect(() => {
		if (!focusReturn) {
			return undefined;
		}
		focusReturn.current = false;
		const focus = hasFocus;
		return () => {
			focusReturn.current = focus.current;
		};
	}, [focusReturn]);
	/** The drawn node holding the Tab stop (TAB_IN, MODEL_CHANGE). */
	const roving = useMemo(() => (laidOut ? focusTarget(laidOut.model, laidOut.collapsed, focused) : undefined), [laidOut, focused]);
	const named = useMemo(() => highlighted.map((n): ViewNode => ({
		...n,
		ariaLabel: nodeAnnouncement(laidOut!.model, n.data.node, n.data.collapsed === true, n.data.marker, broken),
		domAttributes: { tabIndex: n.id === roving ? 0 : -1 },
	})), [highlighted, laidOut, roving, broken]);

	/** Keeps the node in view, at the current zoom, when focus lands on it off screen. */
	const reveal = useCallback((id: string) => {
		const internal = instance?.getInternalNode(id);
		const box = container.current?.getBoundingClientRect();
		if (!instance || !internal || !box) {
			return;
		}
		const { x, y } = internal.internals.positionAbsolute;
		const width = internal.measured.width ?? internal.width ?? 0;
		const height = internal.measured.height ?? internal.height ?? 0;
		const view = instance.getViewport();
		const left = x * view.zoom + view.x;
		const top = y * view.zoom + view.y;
		if (left < 0 || top < 0 || left + width * view.zoom > box.width || top + height * view.zoom > box.height) {
			void instance.setCenter(x + width / 2, y + height / 2, { zoom: view.zoom, duration: motionDuration(prefersReducedMotion()) });
		}
	}, [instance]);
	const focusNode = useCallback((id: string) => {
		const el = nodeElement(container.current, id);
		if (el) {
			el.focus({ preventScroll: true });
			reveal(id);
		}
	}, [reveal]);

	// MODEL_CHANGE: the focused node went (a new model, or a collapse above it), so focus would be
	// lost; it goes to the node now holding the Tab stop. Only while focus was in the graph.
	useEffect(() => {
		if (!hasFocus.current || roving === undefined || !laidOut) {
			return;
		}
		const drawn = new Set(laidOut.nodes.map((n) => n.id));
		let frame = 0;
		let tries = 0;
		const refocus = () => {
			// Never while the webview is not focused (typing in the YAML must not pull focus here),
			// nor when something else still has focus. A node no longer drawn that React Flow has not
			// removed yet counts as lost.
			const active = document.activeElement;
			const activeNode = nodeIdOf(container.current, active);
			const lost = active === null || active === document.body || (activeNode !== undefined && !drawn.has(activeNode));
			if (!document.hasFocus()) {
				return;
			}
			if (!lost) {
				// Focus moved elsewhere while the graph was not mounted (F5_FOCUS): it is no longer ours.
				if (!(active instanceof Node && container.current?.contains(active))) {
					hasFocus.current = false;
				}
				return;
			}
			if (nodeElement(container.current, roving)) {
				focusNode(roving);
			} else if (++tries < 5) {
				// React Flow draws new nodes a frame after the store gets them.
				frame = requestAnimationFrame(refocus);
			}
		};
		refocus();
		return () => cancelAnimationFrame(frame);
	}, [roving, laidOut, focusNode]);

	const onFocus = (event: FocusEvent<HTMLDivElement>) => {
		hasFocus.current = true;
		const id = nodeIdOf(container.current, event.target);
		if (id !== undefined && laidOut && id !== focused?.[0]) {
			setFocused(focusChain(laidOut.model, id));
		}
	};
	const onBlur = (event: FocusEvent<HTMLDivElement>) => {
		// `null`: the webview lost focus, or the focused node was removed; focus is still ours.
		if (event.relatedTarget instanceof Node && !container.current?.contains(event.relatedTarget)) {
			hasFocus.current = false;
		}
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.altKey || event.ctrlKey || event.metaKey) {
			return;
		}
		if (event.target === container.current) {
			// ESC, second step: the host focuses the driving editor; also before the first layout (F3_ESC).
			if (event.key === 'Escape') {
				event.preventDefault();
				onFocusEditor();
			}
			return;
		}
		if (!laidOut) {
			return;
		}
		// A button (the chevron, focused by a click) keeps its own Enter and Space.
		if (event.target instanceof Element && event.target.closest('button')) {
			return;
		}
		const id = nodeIdOf(container.current, event.target);
		if (id === undefined) {
			return;
		}
		if (ARROWS.includes(event.key)) {
			event.preventDefault();
			const next = nextFocus(laidOut.model, laidOut.collapsed, id, event.key as ArrowKey);
			if (next !== undefined) {
				focusNode(next);
			}
		} else if (event.key === 'Enter') {
			event.preventDefault();
			onActivate(id, 'keyboard');
		} else if (event.key === ' ') {
			event.preventDefault();
			if (laidOut.model.nodes.some((n) => n.id === id && n.group === true)) {
				toggle(id);
			}
		} else if (event.key === 'Escape') {
			event.preventDefault();
			container.current?.focus();
		}
	};

	const fitToView = () => {
		if (instance && placed.current) {
			fit(instance, container.current?.clientWidth ?? window.innerWidth);
		}
	};

	return (
		<>
			<div
				ref={container}
				className="rpcn-graph"
				role="region"
				aria-label={GRAPH_NAME}
				aria-describedby={describedBy}
				// The nodes hold the Tab stop; with none, the container does (TAB_IN). Esc focuses it.
				tabIndex={roving === undefined ? 0 : -1}
				onKeyDown={onKeyDown}
				onFocus={onFocus}
				onBlur={onBlur}
			>
				{laidOut && (
					<ToggleContext.Provider value={toggle}>
						<ActivateContext.Provider value={(id) => onActivate(id, 'click')}>
							<ReactFlow
								nodes={named}
								edges={laidOut.edges}
								nodeTypes={nodeTypes}
								onNodeClick={(_, node) => onActivate(node.id, 'click')}
								nodesDraggable={false}
								nodesConnectable={false}
								nodesFocusable
								edgesFocusable={false}
								elementsSelectable={false}
								disableKeyboardA11y
								panActivationKeyCode={null}
								deleteKeyCode={null}
								selectionKeyCode={null}
								multiSelectionKeyCode={null}
								ariaLabelConfig={NO_DESCRIPTIONS}
								minZoom={0.25}
								maxZoom={2}
								onInit={setInstance}
								onMoveStart={markMoved}
								onMove={markMoved}
								onMoveEnd={(_, { x, y, zoom }) => saveViewState({ viewport: { x, y, zoom }, userMoved: userMoved.current })}
								proOptions={{ hideAttribution: true }}
							>
								<Background />
							</ReactFlow>
						</ActivateContext.Provider>
					</ToggleContext.Provider>
				)}
			</div>
			{/* Outside the graph region, so it never joins the nodes' roving Tab stop: Tab reaches it next. */}
			{instance && laidOut && laidOut.nodes.length > 0 && (
				<button type="button" className="rpcn-fit-view" aria-label={FIT_TO_VIEW} title={FIT_TO_VIEW} onClick={fitToView}>
					<span className="codicon codicon-screen-full" aria-hidden="true" />
				</button>
			)}
		</>
	);
}
