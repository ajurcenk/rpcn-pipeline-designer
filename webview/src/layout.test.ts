// The graph view's layout core (ticket 3.4) on every fixture model: ELK hierarchy, collapse,
// resources and the xyflow props. Plain Node (webview/vitest.config.mts); ELK runs for real.

import { readdirSync, readFileSync } from 'node:fs';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { describe, expect, it } from 'vitest';
import type { PipelineModel } from '../../src/shared/protocol';
import {
	collapsedSummary, highlightDrawn, isContainer, layout, MAX_TITLE_MESSAGES, markerClass, markerIcon, markerOf, markSelected, markStatus,
	motionDuration, nodeTitle, pruneCollapsed,
	toElkGraph, toggleCollapsed, visibleAncestor,
} from './layout';

const FIXTURES = new URL('../../src/test/fixtures/models/', import.meta.url);

function fixture(name: string): PipelineModel {
	return JSON.parse(readFileSync(new URL(`${name}.model.json`, FIXTURES), 'utf8')) as PipelineModel;
}

const NAMES = readdirSync(FIXTURES).filter((f) => f.endsWith('.model.json')).map((f) => f.slice(0, -'.model.json'.length)).sort();

/** Every ELK node by id with its ELK parent (`undefined` for the root's children), and every edge id. */
function walk(graph: ElkNode): { parents: Map<string, string | undefined>; nodes: Map<string, ElkNode>; edges: string[] } {
	const parents = new Map<string, string | undefined>();
	const nodes = new Map<string, ElkNode>();
	const edges: string[] = [];
	const visit = (node: ElkNode, parent: string | undefined) => {
		edges.push(...(node.edges ?? []).map((e) => e.id));
		for (const child of node.children ?? []) {
			parents.set(child.id, parent);
			nodes.set(child.id, child);
			visit(child, child.id);
		}
	};
	visit(graph, undefined);
	return { parents, nodes, edges };
}

const BRANCH = 'path:pipeline.processors[0]';

describe('FIXTURES: the ELK graph mirrors the model', () => {
	it('has all sixteen fixtures', () => {
		expect(NAMES).toHaveLength(16);
	});
	for (const name of NAMES) {
		it(name, () => {
			const model = fixture(name);
			const graph = toElkGraph(model);
			expect(graph.layoutOptions?.['elk.hierarchyHandling']).toBe('INCLUDE_CHILDREN');
			const { parents, nodes, edges } = walk(graph);
			expect(new Map(model.nodes.map((n) => [n.id, n.parent]))).toEqual(parents);
			expect(edges.sort()).toEqual(model.edges.map((e) => e.id).sort());
			for (const node of model.nodes) {
				const hasChildren = model.nodes.some((n) => n.parent === node.id);
				if (isContainer(node) && hasChildren) {
					expect(nodes.get(node.id)?.children?.length, node.id).toBeGreaterThan(0);
					expect(nodes.get(node.id)?.layoutOptions?.['elk.padding'], node.id).toBeDefined();
				}
			}
		});
	}
});

describe('SWITCH', () => {
	it('draws one group with a captioned route per case, each case chained inside it', async () => {
		const model = fixture('switch-processor');
		const { nodes, edges } = await layout(model);
		const groups = nodes.filter((n) => n.type === 'groupBox');
		expect(groups.map((g) => g.id)).toEqual([BRANCH]);
		const routes = nodes.filter((n) => n.type === 'route');
		expect(routes.length).toBe(2);
		for (const route of routes) {
			expect(route.parentId).toBe(BRANCH);
			expect(route.data.node.caption).toBeTruthy();
		}
		const [first] = routes;
		const inFirst = nodes.filter((n) => n.parentId === first.id).map((n) => n.id);
		expect(inFirst.length).toBe(2);
		expect(edges.map((e) => [e.source, e.target])).toContainEqual(inFirst);
		expect(groups[0].width).toBeGreaterThan(routes[0].width!);
	});
});

describe('COLLAPSE', () => {
	it('draws a collapsed branch as one leaf box with its count, keeping its edges', async () => {
		const model = fixture('nested');
		const collapsed = new Set([BRANCH]);
		const graph = toElkGraph(model, collapsed);
		const { nodes: elkNodes } = walk(graph);
		expect(elkNodes.get(BRANCH)?.children ?? []).toEqual([]);
		const { nodes, edges } = await layout(model, collapsed);
		expect(nodes.map((n) => n.id)).toEqual(['path:input', BRANCH, 'path:output']);
		const branch = nodes.find((n) => n.id === BRANCH)!;
		expect(branch.data.collapsed).toBe(true);
		expect(branch.data.summary).toBe('1 processor');
		expect(branch.height).toBe(48);
		expect(edges.map((e) => e.id).sort()).toEqual([`path:input->${BRANCH}`, `${BRANCH}->path:output`].sort());
	});
	it('drops the edges inside a collapsed group', async () => {
		const model = fixture('switch-processor');
		const { edges: open } = await layout(model);
		const { edges } = await layout(model, new Set([BRANCH]));
		expect(open.length).toBeGreaterThan(edges.length);
		expect(edges.every((e) => !e.source.startsWith(`${BRANCH}.`) && !e.target.startsWith(`${BRANCH}.`))).toBe(true);
	});
	it('counts cases, branches or components', () => {
		const count = (name: string) => collapsedSummary(fixture(name), fixture(name).nodes.find((n) => n.id === BRANCH)!);
		expect(count('switch-processor')).toBe('2 cases');
		expect(count('workflow')).toBe('3 branches');
		expect(count('branch')).toMatch(/^\d+ processors?$/);
		const broker = fixture('broker-output');
		const group = broker.nodes.find((n) => n.group === true)!;
		expect(collapsedSummary(broker, group)).toMatch(/^\d+ outputs?$/);
	});
	it('toggles', () => {
		expect([...toggleCollapsed(new Set(), 'a')]).toEqual(['a']);
		expect([...toggleCollapsed(new Set(['a']), 'a')]).toEqual([]);
	});
});

describe('COLLAPSE_KEPT / COLLAPSE_GONE', () => {
	it('keeps the state of a group still in the new model', () => {
		const collapsed = new Set([BRANCH]);
		expect([...pruneCollapsed(collapsed, fixture('nested'))]).toEqual([BRANCH]);
	});
	it('drops the state of a group the new model no longer has', () => {
		const collapsed = new Set([BRANCH, 'path:gone']);
		expect([...pruneCollapsed(collapsed, fixture('flat'))]).toEqual([]);
		expect([...pruneCollapsed(collapsed, fixture('nested'))]).toEqual([BRANCH]);
	});
});

describe('RESOURCES', () => {
	it('draws resources as standalone nodes with no edges', async () => {
		const { nodes, edges } = await layout(fixture('resources'));
		const resources = nodes.filter((n) => n.data.node.role === 'resource');
		expect(resources.map((n) => n.id).sort()).toEqual(['res:cache:seen', 'res:processor:normalise']);
		for (const resource of resources) {
			expect(resource.type).toBe('component');
			expect(resource.parentId).toBeUndefined();
			expect(edges.some((e) => e.source === resource.id || e.target === resource.id)).toBe(false);
		}
	});
	it('puts every top-level resource below every other top-level node', async () => {
		const { nodes } = await layout(fixture('resources'));
		const top = nodes.filter((n) => n.parentId === undefined);
		const flow = top.filter((n) => n.data.node.role !== 'resource');
		const resources = top.filter((n) => n.data.node.role === 'resource');
		const flowBottom = Math.max(...flow.map((n) => n.position.y + n.height!));
		for (const resource of resources) {
			expect(resource.position.y, resource.id).toBeGreaterThanOrEqual(flowBottom);
		}
		const flowLeft = Math.min(...flow.map((n) => n.position.x));
		expect(flowLeft).toBeLessThanOrEqual(12);
	});
});

describe('PROPS', () => {
	for (const name of NAMES) {
		it(name, async () => {
			const model = fixture(name);
			const { nodes, edges } = await layout(model);
			expect(nodes.map((n) => n.id).sort()).toEqual(model.nodes.map((n) => n.id).sort());
			expect(edges.length).toBe(model.edges.length);
			const index = new Map(nodes.map((n, i) => [n.id, i]));
			for (const [i, node] of nodes.entries()) {
				expect(node.draggable).toBe(false);
				expect(node.connectable).toBe(false);
				const parent = model.nodes.find((n) => n.id === node.id)!.parent;
				expect(node.parentId).toBe(parent);
				if (parent !== undefined) {
					expect(index.get(parent)!).toBeLessThan(i);
					expect(node.extent).toBe('parent');
				}
			}
		});
	}
});

describe('NODE_TYPES', () => {
	it("never uses one of xyflow's built-in node types", async () => {
		const builtIn = new Set(['default', 'input', 'output', 'group']);
		for (const name of NAMES) {
			const { nodes } = await layout(fixture(name));
			expect(nodes.filter((n) => builtIn.has(n.type ?? 'default')).map((n) => n.id), name).toEqual([]);
		}
	});
});

describe('REDUCED_MOTION', () => {
	it('fit view and zoom use duration 0 under prefers-reduced-motion', () => {
		expect(motionDuration(true)).toBe(0);
		expect(motionDuration(false)).toBeGreaterThan(0);
	});
});

describe('STABLE (ticket 3.6): the layout is deterministic, so an edit that keeps the model moves nothing', () => {
	const positions = (l: Awaited<ReturnType<typeof layout>>) =>
		l.nodes.map((n) => ({ id: n.id, parentId: n.parentId, position: n.position, width: n.width, height: n.height }));
	for (const name of NAMES) {
		it(name, async () => {
			const model = fixture(name);
			const first = positions(await layout(model));
			// The same model sent twice.
			expect(positions(await layout(fixture(name)))).toEqual(first);
			// A whitespace-only edit above the config: the same model with every range shifted.
			const shifted: PipelineModel = {
				...model,
				nodes: model.nodes.map((n) => ({ ...n, range: [n.range[0] + 3, n.range[1] + 3] as const })),
			};
			expect(positions(await layout(shifted))).toEqual(first);
			// And with a group collapsed, both ways.
			const group = model.nodes.find((n) => n.group === true);
			if (group) {
				const collapsed = new Set([group.id]);
				expect(positions(await layout(shifted, collapsed))).toEqual(positions(await layout(model, collapsed)));
			}
		});
	}
});

describe('VIEW_HIGHLIGHT (ticket 3.7): the selected node, or the collapsed group hiding it', () => {
	const model = fixture('switch-processor');
	const inner = `${BRANCH}.switch[0].processors[1]`;
	it('is the node itself while nothing above it is collapsed', () => {
		expect(visibleAncestor(model, new Set(), inner)).toBe(inner);
		expect(visibleAncestor(model, new Set(), 'path:input')).toBe('path:input');
		expect(visibleAncestor(model, new Set(), BRANCH)).toBe(BRANCH);
	});
	it('is the collapsed group\'s box for a node inside it', () => {
		expect(visibleAncestor(model, new Set([BRANCH]), inner)).toBe(BRANCH);
		expect(visibleAncestor(model, new Set([BRANCH]), `${BRANCH}.switch[1]`)).toBe(BRANCH);
		// The collapsed group itself.
		expect(visibleAncestor(model, new Set([BRANCH]), BRANCH)).toBe(BRANCH);
	});
	it('is the outermost collapsed group when groups nest', () => {
		const nested: PipelineModel = {
			nodes: [
				{ id: 'outer', role: 'processor', component: 'switch', group: true, range: [0, 100] },
				{ id: 'case', role: 'route', parent: 'outer', range: [10, 90] },
				{ id: 'middle', role: 'processor', component: 'try', group: true, parent: 'case', range: [20, 80] },
				{ id: 'leaf', role: 'processor', component: 'mapping', parent: 'middle', range: [30, 40] },
			],
			edges: [],
		};
		expect(visibleAncestor(nested, new Set(['middle']), 'leaf')).toBe('middle');
		expect(visibleAncestor(nested, new Set(['outer', 'middle']), 'leaf')).toBe('outer');
		expect(visibleAncestor(nested, new Set(['outer']), 'leaf')).toBe('outer');
	});
	it('is nothing for null or an id the model does not have', () => {
		expect(visibleAncestor(model, new Set(), null)).toBeUndefined();
		expect(visibleAncestor(model, new Set(), 'path:gone')).toBeUndefined();
	});
	it('marks only that drawn node selected, and null clears it', async () => {
		const { nodes } = await layout(model, new Set([BRANCH]));
		const marked = markSelected(nodes, visibleAncestor(model, new Set([BRANCH]), inner));
		expect(marked.filter((n) => n.data.selected === true).map((n) => n.id)).toEqual([BRANCH]);
		// Unchanged nodes keep their identity, so xyflow redraws only the changed ones.
		expect(marked.filter((n, i) => n !== nodes[i]).map((n) => n.id)).toEqual([BRANCH]);
		const cleared = markSelected(marked, visibleAncestor(model, new Set([BRANCH]), null));
		expect(cleared.some((n) => n.data.selected === true)).toBe(false);
	});
});

describe('VIEW_HIGHLIGHT: a lagging drawing is highlighted against what it was drawn from', () => {
	it('resolves against the laid-out model and collapse state, not the newer ones', async () => {
		// Drawn: the leaf inside a collapsed group. Newer model (still being laid out): the leaf at the top.
		const drawnModel: PipelineModel = {
			nodes: [
				{ id: 'group', role: 'processor', component: 'branch', group: true, range: [0, 50] },
				{ id: 'leaf', role: 'processor', component: 'mapping', parent: 'group', range: [10, 20] },
			],
			edges: [],
		};
		const collapsed = new Set(['group']);
		const drawn = { ...(await layout(drawnModel, collapsed)), model: drawnModel, collapsed };
		expect(drawn.nodes.map((n) => n.id)).toEqual(['group']);
		expect(highlightDrawn(drawn, 'leaf').filter((n) => n.data.selected === true).map((n) => n.id)).toEqual(['group']);
		expect(highlightDrawn(drawn, null).some((n) => n.data.selected === true)).toBe(false);
	});
});

describe('VIEW_MARKERS (ticket 3.8): border and icon per node status', () => {
	const model = fixture('switch-processor');
	const CASE0 = `${BRANCH}.switch[0]`;
	const LEAF = `${CASE0}.processors[1]`;
	const byId = new Map(model.nodes.map((n) => [n.id, n]));
	const status = {
		[BRANCH]: { severity: 'error', own: 'warning', messages: ['deprecated here', 'not recognised'], ownMessages: ['deprecated here'] },
		[CASE0]: { severity: 'error', messages: ['not recognised'] },
		[LEAF]: { severity: 'error', own: 'error', messages: ['not recognised'] },
		'path:input': { severity: 'warning', own: 'warning', messages: ['old'] },
	} as const;

	it('a leaf by its severity; an expanded group or route by its own only; a collapsed group by its roll-up', () => {
		expect(markerOf(byId.get(LEAF)!, false, status[LEAF])).toEqual({ severity: 'error', messages: ['not recognised'] });
		expect(markerOf(byId.get('path:input')!, false, status['path:input'])).toEqual({ severity: 'warning', messages: ['old'] });
		// An expanded group: its own warning and its own messages, not its child's error.
		expect(markerOf(byId.get(BRANCH)!, false, status[BRANCH])).toEqual({ severity: 'warning', messages: ['deprecated here'] });
		// An older host with no ownMessages: all messages.
		expect(markerOf(byId.get(BRANCH)!, false, { severity: 'error', own: 'warning', messages: ['a', 'b'] }))
			.toEqual({ severity: 'warning', messages: ['a', 'b'] });
		// A route with no own: no marker (its children carry theirs).
		expect(markerOf(byId.get(CASE0)!, false, status[CASE0])).toBeUndefined();
		// A collapsed group: the roll-up of what it hides.
		expect(markerOf(byId.get(BRANCH)!, true, status[BRANCH])).toEqual({ severity: 'error', messages: ['deprecated here', 'not recognised'] });
		expect(markerOf(byId.get(BRANCH)!, true, { severity: 'error', messages: ['x'] })?.severity).toBe('error');
		expect(markerOf(byId.get(BRANCH)!, false, { severity: 'error', messages: ['x'] })).toBeUndefined();
		expect(markerOf(byId.get(LEAF)!, false, undefined)).toBeUndefined();
	});

	it('marks the drawn boxes, expanded and collapsed, and keeps unchanged nodes as they are', async () => {
		const expanded = { ...(await layout(model)), model, collapsed: new Set<string>() };
		const marked = markStatus(expanded, status);
		const markers = Object.fromEntries(marked.filter((n) => n.data.marker).map((n) => [n.id, n.data.marker!.severity]));
		expect(markers).toEqual({ 'path:input': 'warning', [BRANCH]: 'warning', [LEAF]: 'error' });
		expect(marked.filter((n, i) => n !== expanded.nodes[i]).map((n) => n.id).sort()).toEqual(['path:input', BRANCH, LEAF].sort());
		// The same status again changes no node.
		const again = markStatus({ ...expanded, nodes: marked }, { ...status });
		expect(again.every((n, i) => n === marked[i])).toBe(true);
		// Cleared: no markers left.
		expect(markStatus({ ...expanded, nodes: marked }, {}).some((n) => n.data.marker !== undefined)).toBe(false);

		const collapsed = new Set([BRANCH]);
		const drawn = { ...(await layout(model, collapsed)), model, collapsed };
		const box = markStatus(drawn, status).find((n) => n.id === BRANCH)!;
		expect(box.data.marker).toEqual({ severity: 'error', messages: ['deprecated here', 'not recognised'] });
		// Markers and the highlight combine.
		const both = highlightDrawn(drawn, LEAF, markStatus(drawn, status)).find((n) => n.id === BRANCH)!;
		expect(both.data.selected).toBe(true);
		expect(both.data.marker?.severity).toBe('error');
	});

	it('the hover text lists the messages verbatim, one per line, after the description', () => {
		expect(nodeTitle('processor: log', { severity: 'error', messages: ['field nope not recognised', 'b  c'] }))
			.toBe('processor: log\nfield nope not recognised\nb  c');
		expect(nodeTitle(undefined, { severity: 'warning', messages: ['old'] })).toBe('old');
		expect(nodeTitle('input: stdin', undefined)).toBe('input: stdin');
	});

	it('the hover lists at most MAX_TITLE_MESSAGES messages, then counts the rest', () => {
		expect(MAX_TITLE_MESSAGES).toBe(20);
		const messages = Array.from({ length: 23 }, (_, i) => `m${i}`);
		const lines = nodeTitle('processor: log', { severity: 'error', messages })!.split('\n');
		expect(lines).toEqual(['processor: log', ...messages.slice(0, 20), '…and 3 more']);
		const twenty = messages.slice(0, 20);
		expect(nodeTitle(undefined, { severity: 'error', messages: twenty })!.split('\n')).toEqual(twenty);
	});

	it('each severity has its own box class and codicon', () => {
		expect(markerClass({ severity: 'error', messages: [] })).toBe('pipeline-node-error');
		expect(markerClass({ severity: 'warning', messages: [] })).toBe('pipeline-node-warning');
		expect(markerClass(undefined)).toBeUndefined();
		expect(markerIcon({ severity: 'error', messages: [] })).toBe('codicon-error');
		expect(markerIcon({ severity: 'warning', messages: [] })).toBe('codicon-warning');
		expect(markerIcon(undefined)).toBeUndefined();
	});
});
