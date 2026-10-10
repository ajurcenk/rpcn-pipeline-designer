// The pure core of the graph view (ticket 3.4): model + collapse state -> ELK compound graph ->
// @xyflow/react nodes and edges. No DOM, no host API, so vitest runs it in Node. ELK runs on the
// main thread from elk.bundled.js, with no worker (AD-4).

import type { Edge, Node } from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import type {
	NodeSeverity, NodeStatus, NodeStatusById, PipelineEdge, PipelineModel, PipelineNode,
} from '../../src/shared/protocol';

export const NODE_HEIGHT = 48;
/** Readable sizes (mockup key-editor-and-graph.html: nodes about 100-210 px wide at 100%). */
const MIN_NODE_WIDTH = 110;
const MAX_NODE_WIDTH = 220;
const CHAR_WIDTH = 8; // the editor font at its default size, roughly
const NODE_PADDING = 24;
/** DESIGN `{spacing.3}`: a group box indents its children by this much. */
const GROUP_PADDING = 12;
/** The group header row (chevron, component, label). */
export const GROUP_HEADER = 32;
/** A route's caption row; an uncaptioned route has none. */
export const ROUTE_CAPTION = 26;
/** Chevron codicon plus the gaps around it in a group header. */
const CHEVRON_WIDTH = 24;

/** Group ids the user has collapsed (webview view state, AD-3). */
export type Collapsed = ReadonlySet<string>;

/** xyflow node types; never xyflow's built-ins (`default`, `input`, `output`, `group`), which bring their own styles. */
export type NodeKind = 'component' | 'groupBox' | 'route';

export interface ViewData extends Record<string, unknown> {
	readonly node: PipelineNode;
	/** A collapsed group: drawn as one node-sized box. */
	readonly collapsed?: boolean;
	/** For a collapsed group, what it hides ("3 cases", "4 processors"). */
	readonly summary?: string;
	/** The node under the cursor in the driving editor, or the collapsed group hiding it (3.7). */
	readonly selected?: boolean;
	/** The error or warning marker drawn on this box (3.8), from the host's node status. */
	readonly marker?: Marker;
}

/** What a box shows of its node status (DESIGN pipeline-node-error / -warning): a border plus an icon, and the messages on hover. */
export interface Marker {
	readonly severity: NodeSeverity;
	readonly messages: readonly string[];
}

export type ViewNode = Node<ViewData, NodeKind>;

export interface Layout {
	readonly nodes: ViewNode[];
	readonly edges: Edge[];
}

/** A node drawn as a box holding others: a component group or a route. */
export function isContainer(node: PipelineNode): boolean {
	return node.group === true || node.role === 'route';
}

/** The first line of a node: its role, plus its label when it has one. */
export function nodeKind(node: PipelineNode): string {
	return node.label === undefined ? node.role : `${node.role} · ${node.label}`;
}

/** The second label line: the component name (a route has none; it shows its caption). */
export function nodeName(node: PipelineNode): string {
	return node.component ?? node.caption ?? '';
}

function clampWidth(chars: number, extra = 0): number {
	return Math.min(MAX_NODE_WIDTH + extra, Math.max(MIN_NODE_WIDTH, chars * CHAR_WIDTH + NODE_PADDING + extra));
}

/** A node's width from its longest label line. */
export function nodeWidth(node: PipelineNode): number {
	return clampWidth(Math.max(nodeName(node).length, nodeKind(node).length));
}

/** The header text of a group: its component, then its label. */
function headerChars(node: PipelineNode): number {
	return (node.component ?? '').length + (node.label === undefined ? 0 : node.label.length + 1);
}

/** The width of a collapsed group's box, or the minimum width of an expanded group or route. */
function boxWidth(node: PipelineNode, summary?: string): number {
	if (node.role === 'route') {
		return clampWidth((node.caption ?? '').length);
	}
	return clampWidth(Math.max(headerChars(node), (summary ?? '').length), CHEVRON_WIDTH);
}

function plural(count: number, noun: string, nouns: string): string {
	return `${count} ${count === 1 ? noun : nouns}`;
}

const ROUTE_NOUNS: Readonly<Record<string, readonly [string, string]>> = {
	switch: ['case', 'cases'],
	workflow: ['branch', 'branches'],
};

/**
 * What a collapsed group hides: its cases or branches for a `switch` or `workflow`, otherwise the
 * components it holds directly or through its routes ("4 processors", "2 outputs", "3 components").
 */
export function collapsedSummary(model: PipelineModel, group: PipelineNode): string {
	const children = model.nodes.filter((n) => n.parent === group.id);
	const routes = children.filter((n) => n.role === 'route');
	const nouns = group.component === undefined ? undefined : ROUTE_NOUNS[group.component];
	if (nouns && routes.length > 0 && routes.length === children.length) {
		return plural(routes.length, nouns[0], nouns[1]);
	}
	const routeIds = new Set(routes.map((r) => r.id));
	const held = model.nodes.filter((n) => n.role !== 'route'
		&& n.parent !== undefined && (n.parent === group.id || routeIds.has(n.parent)));
	const roles = new Set(held.map((n) => n.role));
	const role = roles.size === 1 ? [...roles][0] : undefined;
	return role === undefined ? plural(held.length, 'component', 'components') : plural(held.length, role, `${role}s`);
}

/** The collapse state kept for a new model: only ids of groups it still has (COLLAPSE_GONE). */
export function pruneCollapsed(collapsed: Collapsed, model: PipelineModel): Collapsed {
	const groups = new Set(model.nodes.filter((n) => n.group === true).map((n) => n.id));
	const kept = [...collapsed].filter((id) => groups.has(id));
	return kept.length === collapsed.size ? collapsed : new Set(kept);
}

/** The collapse state with `id` toggled. */
export function toggleCollapsed(collapsed: Collapsed, id: string): Collapsed {
	const next = new Set(collapsed);
	if (!next.delete(id)) {
		next.add(id);
	}
	return next;
}

/**
 * The node drawn for `id` (VIEW_HIGHLIGHT): the node itself, or, when a collapsed group hides it,
 * the outermost collapsed group above it, which is its nearest visible ancestor (a group inside a
 * collapsed group is hidden too). `undefined` for `null` or an id the model does not have.
 */
export function visibleAncestor(model: PipelineModel, collapsed: Collapsed, id: string | null): string | undefined {
	if (id === null) {
		return undefined;
	}
	const byId = new Map(model.nodes.map((n) => [n.id, n]));
	const node = byId.get(id);
	if (!node) {
		return undefined;
	}
	let shown = node.id;
	const seen = new Set<string>([node.id]);
	for (let p = node.parent; p !== undefined && !seen.has(p); p = byId.get(p)?.parent) {
		seen.add(p);
		if (collapsed.has(p)) {
			shown = p;
		}
	}
	return shown;
}

/** The nodes with `id` marked as the selected one (`data.selected`), the others as they are. */
export function markSelected(nodes: readonly ViewNode[], id: string | undefined): ViewNode[] {
	return nodes.map((n) => {
		const selected = n.id === id;
		if (selected === (n.data.selected === true)) {
			return n;
		}
		return { ...n, data: { ...n.data, selected } };
	});
}

/** A layout result with the model and collapse state it was laid out from. */
export interface Drawn extends Layout {
	readonly model: PipelineModel;
	readonly collapsed: Collapsed;
}

/**
 * The drawn nodes with the selection highlighted, resolved against the model and collapse state
 * the drawing was made from (not newer ones still being laid out), so a lagging drawing never
 * highlights the wrong box.
 */
export function highlightDrawn(drawn: Drawn, selection: string | null, nodes: readonly ViewNode[] = drawn.nodes): ViewNode[] {
	return markSelected(nodes, visibleAncestor(drawn.model, drawn.collapsed, selection));
}

/**
 * The marker of a drawn node (VIEW_MARKERS): a leaf by its rolled-up `severity`; an expanded group
 * or a route by its `own` severity and `ownMessages` only (`messages` when an older host sent
 * none), since its children carry their own markers; a collapsed group by `severity` and all
 * `messages`, the roll-up of what it hides. `undefined`: no marker. The messages are the host's,
 * verbatim.
 */
export function markerOf(node: PipelineNode, collapsed: boolean, status: NodeStatus | undefined): Marker | undefined {
	if (!status) {
		return undefined;
	}
	if (!isContainer(node) || (node.group === true && collapsed)) {
		return { severity: status.severity, messages: status.messages };
	}
	return status.own === undefined ? undefined : { severity: status.own, messages: status.ownMessages ?? status.messages };
}

/** The marker's box class (DESIGN pipeline-node-error / pipeline-node-warning); `undefined`: none. */
export function markerClass(marker: Marker | undefined): 'pipeline-node-error' | 'pipeline-node-warning' | undefined {
	return marker === undefined ? undefined : marker.severity === 'error' ? 'pipeline-node-error' : 'pipeline-node-warning';
}

/** The marker's codicon, each severity its own (never colour alone); `undefined`: none. */
export function markerIcon(marker: Marker | undefined): 'codicon-error' | 'codicon-warning' | undefined {
	return marker === undefined ? undefined : marker.severity === 'error' ? 'codicon-error' : 'codicon-warning';
}

const sameMarker = (a: Marker | undefined, b: Marker | undefined): boolean => a === b
	|| (a !== undefined && b !== undefined && a.severity === b.severity
		&& a.messages.length === b.messages.length && a.messages.every((m, i) => m === b.messages[i]));

/**
 * The drawn nodes with their markers (`data.marker`), resolved against the model and collapse
 * state the drawing was made from; unchanged nodes keep their identity.
 */
export function markStatus(drawn: Drawn, status: NodeStatusById): ViewNode[] {
	return drawn.nodes.map((n) => {
		const marker = markerOf(n.data.node, drawn.collapsed.has(n.id), status[n.id]);
		if (sameMarker(marker, n.data.marker)) {
			return n;
		}
		return { ...n, data: { ...n.data, marker } };
	});
}

/** The most messages a hover lists; the rest are counted on one last line. */
export const MAX_TITLE_MESSAGES = 20;

/**
 * A box's hover text: its description, then each of its marker's messages, verbatim, one per
 * line, at most MAX_TITLE_MESSAGES of them, then `…and N more`.
 */
export function nodeTitle(base: string | undefined, marker: Marker | undefined): string | undefined {
	if (!marker || marker.messages.length === 0) {
		return base;
	}
	const shown = marker.messages.slice(0, MAX_TITLE_MESSAGES);
	const more = marker.messages.length - shown.length;
	return [
		...(base === undefined || base === '' ? [] : [base]),
		...shown,
		...(more > 0 ? [`…and ${more} more`] : []),
	].join('\n');
}

/** Fit view and zoom animate, except under `prefers-reduced-motion: reduce` (REDUCED_MOTION). */
export function motionDuration(prefersReducedMotion: boolean): number {
	return prefersReducedMotion ? 0 : 200;
}

/** The nodes that are drawn: every node with no collapsed group above it. */
function visibleNodes(model: PipelineModel, collapsed: Collapsed): PipelineNode[] {
	const byId = new Map(model.nodes.map((n) => [n.id, n]));
	const hidden = (node: PipelineNode): boolean => {
		const seen = new Set<string>();
		for (let p = node.parent; p !== undefined && !seen.has(p); p = byId.get(p)?.parent) {
			seen.add(p);
			if (collapsed.has(p)) {
				return true;
			}
		}
		return false;
	};
	return model.nodes.filter((n) => !hidden(n));
}

function padding(top: number): string {
	return `[top=${top},left=${GROUP_PADDING},bottom=${GROUP_PADDING},right=${GROUP_PADDING}]`;
}

/** The ancestors of a node, nearest first, ending with the root (`undefined`). */
function ancestors(id: string, parentOf: ReadonlyMap<string, string | undefined>): (string | undefined)[] {
	const chain: (string | undefined)[] = [];
	const seen = new Set<string>();
	for (let p = parentOf.get(id); p !== undefined && !seen.has(p); p = parentOf.get(p)) {
		seen.add(p);
		chain.push(p);
	}
	chain.push(undefined);
	return chain;
}

const ROOT_ID = 'root';

/**
 * The ELK input: a compound graph whose hierarchy is the model's `parent` tree, laid out in one
 * pass (`INCLUDE_CHILDREN`). Groups and routes are compound nodes with room for their header;
 * a collapsed group is a node-sized leaf, and its descendants and their edges are left out.
 * Each edge sits in the deepest node that contains both its ends.
 */
export function toElkGraph(model: PipelineModel, collapsed: Collapsed = new Set()): ElkNode {
	const nodes = visibleNodes(model, collapsed);
	const ids = new Set(nodes.map((n) => n.id));
	const parentOf = new Map(nodes.map((n) => [n.id, n.parent !== undefined && ids.has(n.parent) ? n.parent : undefined]));
	const root: ElkNode = {
		id: ROOT_ID,
		layoutOptions: {
			'elk.algorithm': 'layered',
			'elk.direction': 'RIGHT',
			'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
			'elk.spacing.nodeNode': '24',
			'elk.layered.spacing.nodeNodeBetweenLayers': '40',
			'elk.separateConnectedComponents': 'true',
		},
		children: [],
		edges: [],
	};
	const elkById = new Map<string | undefined, ElkNode>([[undefined, root]]);
	const hasChildren = new Set(nodes.flatMap((n) => {
		const p = parentOf.get(n.id);
		return p === undefined ? [] : [p];
	}));
	for (const node of nodes) {
		let elkNode: ElkNode;
		if (collapsed.has(node.id) && node.group === true) {
			elkNode = { id: node.id, width: boxWidth(node, collapsedSummary(model, node)), height: NODE_HEIGHT };
		} else if (isContainer(node)) {
			const top = node.role === 'route' ? (node.caption === undefined ? GROUP_PADDING : ROUTE_CAPTION) : GROUP_HEADER;
			const minWidth = boxWidth(node);
			const minHeight = top + GROUP_PADDING + (hasChildren.has(node.id) ? 0 : GROUP_PADDING);
			elkNode = {
				id: node.id,
				layoutOptions: {
					'elk.padding': padding(top),
					'elk.nodeSize.constraints': 'MINIMUM_SIZE',
					'elk.nodeSize.minimum': `(${minWidth}, ${minHeight})`,
				},
				children: [],
				edges: [],
			};
			if (!hasChildren.has(node.id)) {
				elkNode.width = minWidth;
				elkNode.height = minHeight;
			}
		} else {
			elkNode = { id: node.id, width: nodeWidth(node), height: NODE_HEIGHT };
		}
		elkById.set(node.id, elkNode);
		const parent = elkById.get(parentOf.get(node.id)) ?? root;
		parent.children!.push(elkNode);
	}
	for (const edge of visibleEdges(model, ids)) {
		const sourceUp = ancestors(edge.source, parentOf);
		const targetUp = new Set(ancestors(edge.target, parentOf));
		const container = sourceUp.find((a) => targetUp.has(a));
		const holder = elkById.get(container) ?? root;
		const elkEdge: ElkExtendedEdge = { id: edge.id, sources: [edge.source], targets: [edge.target] };
		(holder.edges ??= []).push(elkEdge);
	}
	return root;
}

function visibleEdges(model: PipelineModel, ids: ReadonlySet<string>): PipelineEdge[] {
	return model.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
}

/**
 * The xyflow nodes and edges from ELK's result: every node in pre-order (a parent before its
 * children), children with `parentId` and positions relative to it, as ELK returns them.
 * Nothing is draggable or connectable.
 */
export function toFlow(model: PipelineModel, laidOut: ElkNode, collapsed: Collapsed = new Set()): Layout {
	const byId = new Map(model.nodes.map((n) => [n.id, n]));
	const nodes: ViewNode[] = [];
	const ids = new Set<string>();
	const walk = (elkNode: ElkNode, parentId: string | undefined): void => {
		for (const child of elkNode.children ?? []) {
			const node = byId.get(child.id);
			if (!node) {
				continue;
			}
			const isCollapsed = node.group === true && collapsed.has(node.id);
			const kind: NodeKind = node.role === 'route' ? 'route' : node.group === true ? 'groupBox' : 'component';
			const data: ViewData = isCollapsed
				? { node, collapsed: true, summary: collapsedSummary(model, node) }
				: { node };
			nodes.push({
				id: node.id,
				type: kind,
				position: { x: child.x ?? 0, y: child.y ?? 0 },
				data,
				draggable: false,
				connectable: false,
				selectable: false,
				width: child.width ?? nodeWidth(node),
				height: child.height ?? NODE_HEIGHT,
				...(parentId === undefined ? {} : { parentId, extent: 'parent' as const }),
			});
			ids.add(node.id);
			walk(child, node.id);
		}
	};
	walk(laidOut, undefined);
	const edges: Edge[] = visibleEdges(model, ids).map((e) => ({
		id: e.id,
		source: e.source,
		target: e.target,
		focusable: false,
		...(e.label === undefined ? {} : { label: e.label }),
	}));
	return { nodes, edges };
}

const elk = new ELK();
/** Spacing between resource boxes in their row, and between the main flow and that row. */
const RESOURCE_SPACING = 24;
const RESOURCE_ROW_GAP = 40;

/**
 * Lays the model out with ELK and maps the result to xyflow nodes and edges. The main flow is laid
 * out without the top-level resources, which then sit in one row below it (DESIGN: "a separate
 * area outside the main flow").
 */
export async function layout(model: PipelineModel, collapsed: Collapsed = new Set()): Promise<Layout> {
	const graph = toElkGraph(model, collapsed);
	const roles = new Map(model.nodes.map((n) => [n.id, n.role]));
	const isResource = (id: string) => roles.get(id) === 'resource';
	const resources = (graph.children ?? []).filter((c) => isResource(c.id));
	const main: ElkNode = {
		...graph,
		children: (graph.children ?? []).filter((c) => !isResource(c.id)),
		edges: (graph.edges ?? []).filter((e) => !e.sources.some(isResource) && !e.targets.some(isResource)),
	};
	const laidMain = await elk.layout(main);
	const laidResources = resources.length === 0
		? []
		: (await elk.layout({ id: 'resources', layoutOptions: graph.layoutOptions, children: resources })).children ?? [];
	const top = (laidMain.children ?? []).length === 0 ? GROUP_PADDING : (laidMain.height ?? 0) + RESOURCE_ROW_GAP - GROUP_PADDING;
	let x = GROUP_PADDING;
	for (const resource of laidResources) {
		resource.x = x;
		resource.y = top;
		x += (resource.width ?? 0) + RESOURCE_SPACING;
	}
	return toFlow(model, { ...laidMain, children: [...(laidMain.children ?? []), ...laidResources] }, collapsed);
}
