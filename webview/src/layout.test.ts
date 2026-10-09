// The graph view's layout core (ticket 3.4) on every fixture model: ELK hierarchy, collapse,
// resources and the xyflow props. Plain Node (webview/vitest.config.mts); ELK runs for real.

import { readdirSync, readFileSync } from 'node:fs';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { describe, expect, it } from 'vitest';
import type { PipelineModel } from '../../src/shared/protocol';
import { collapsedSummary, isContainer, layout, motionDuration, pruneCollapsed, toElkGraph, toggleCollapsed } from './layout';

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
