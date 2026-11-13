import * as assert from 'assert';
import { ancestorIds, nodesById } from '../../shared/graphModel';
import type { PipelineNode } from '../../shared/protocol';

// Story 55 (story 50 group B): the graph model's one id map and one ancestor walk, which the core
// (`nodeAt`, `nodeStatusOf`) and the webview layout build their own edge rules on.

const node = (id: string, parent?: string, start = 0): PipelineNode => ({
	id,
	role: 'processor',
	range: [start, start + 1],
	...(parent !== undefined ? { parent } : {}),
});

suite('Graph model id map and ancestor walk (story 55)', () => {
	test('nodesById: every node by its id; with a duplicate id the later node wins', () => {
		const a = node('a');
		const b1 = node('b', 'a', 1);
		const b2 = node('b', undefined, 2);
		const byId = nodesById({ nodes: [a, b1, b2] });
		assert.strictEqual(byId.size, 2);
		assert.strictEqual(byId.get('a'), a);
		assert.strictEqual(byId.get('b'), b2);
		assert.strictEqual(nodesById({ nodes: [] }).size, 0);
	});

	test('ancestorIds: strict ancestors, nearest first; none at the top', () => {
		const byId = nodesById({ nodes: [node('root'), node('mid', 'root'), node('leaf', 'mid')] });
		const parentOf = (id: string) => byId.get(id)?.parent;
		assert.deepStrictEqual([...ancestorIds(parentOf, 'leaf')], ['mid', 'root']);
		assert.deepStrictEqual([...ancestorIds(parentOf, 'root')], []);
		assert.deepStrictEqual([...ancestorIds(parentOf, 'missing')], []);
	});

	test('ancestorIds: an unknown parent id is yielded, then the walk stops', () => {
		const byId = nodesById({ nodes: [node('leaf', 'gone')] });
		assert.deepStrictEqual([...ancestorIds((id) => byId.get(id)?.parent, 'leaf')], ['gone']);
	});

	test('ancestorIds: a parent cycle stops at the first repeat; the start is yielded once if it is its own ancestor', () => {
		const byId = nodesById({ nodes: [node('a', 'b'), node('b', 'c'), node('c', 'b')] });
		const parentOf = (id: string) => byId.get(id)?.parent;
		assert.deepStrictEqual([...ancestorIds(parentOf, 'a')], ['b', 'c']);
		assert.deepStrictEqual([...ancestorIds(parentOf, 'b')], ['c', 'b']);
		const self = nodesById({ nodes: [node('s', 's')] });
		assert.deepStrictEqual([...ancestorIds((id) => self.get(id)?.parent, 's')], ['s']);
	});

	test('ancestorIds: takes any parentOf accessor, such as a filtered map', () => {
		const parentOf = new Map<string, string | undefined>([['x', 'y'], ['y', undefined]]);
		assert.deepStrictEqual([...ancestorIds((id) => parentOf.get(id), 'x')], ['y']);
	});
});
