import * as assert from 'assert';
import { componentCatalogue } from '../../core/catalogue';
import { buildPipelineModel, nodeAt } from '../../core/graph';
import { parseYaml } from '../../core/yamlPath';
import { EMPTY_MODEL, type PipelineModel } from '../../shared/protocol';
import { fixture, FIXTURE_NAMES } from '../helpers/fixtureModels';
import { PINNED_VERSIONS, servedSchema } from '../helpers/schemas';

suite('core/nodeAt (3.5, AD-16)', () => {
	test('NODEAT_INNERMOST: an offset inside a processor inside a switch case gives that processor', () => {
		const { yaml, model } = fixture('switch-processor');
		const inner = yaml.indexOf("root.a = true");
		assert.strictEqual(nodeAt(model, inner), 'path:pipeline.processors[0].switch[0].processors[0]');
		assert.strictEqual(nodeAt(model, yaml.indexOf('message: an a')), 'path:pipeline.processors[0].switch[0].processors[1]');
		// On the case's own `check`, the case; on the `switch:` key, the switch.
		assert.strictEqual(nodeAt(model, yaml.indexOf('check:')), 'path:pipeline.processors[0].switch[0]');
		assert.strictEqual(nodeAt(model, yaml.indexOf('switch:')), 'path:pipeline.processors[0]');
		// The last processor ends where its case and the switch end; the deepest still wins.
		const last = model.nodes.find((n) => n.id === 'path:pipeline.processors[0].switch[1].processors[0]')!;
		assert.strictEqual(nodeAt(model, last.range[1] - 1), last.id);
	});

	test('NODEAT_INNERMOST: depth decides, not the order of the nodes', () => {
		const shuffled: PipelineModel = {
			nodes: [
				{ id: 'c', role: 'processor', component: 'mapping', range: [4, 6], parent: 'b' },
				{ id: 'a', role: 'processor', component: 'switch', range: [0, 10], group: true },
				{ id: 'b', role: 'route', range: [2, 8], parent: 'a' },
			],
			edges: [],
		};
		assert.strictEqual(nodeAt(shuffled, 5), 'c');
		assert.strictEqual(nodeAt(shuffled, 3), 'b');
		assert.strictEqual(nodeAt(shuffled, 9), 'a');
	});

	test('NODEAT_BOUNDS: [start, end): the end belongs to the next containing node, or to none', () => {
		const { yaml, model } = fixture('switch-processor');
		const byId = new Map(model.nodes.map((n) => [n.id, n]));
		const first = byId.get('path:pipeline.processors[0].switch[0].processors[0]')!;
		assert.strictEqual(nodeAt(model, first.range[0]), first.id);
		assert.strictEqual(nodeAt(model, first.range[1]), 'path:pipeline.processors[0].switch[0]');
		const input = byId.get('path:input')!;
		assert.strictEqual(nodeAt(model, input.range[1]), undefined);
		const output = byId.get('path:output')!;
		assert.strictEqual(nodeAt(model, output.range[1]), undefined);
		assert.strictEqual(nodeAt(model, yaml.length), undefined);
		assert.strictEqual(nodeAt(model, -1), undefined);
		assert.strictEqual(nodeAt(model, model.nodes[0].range[0] - 1), undefined);
	});

	test('NODEAT_BOUNDS: no node, an empty model or a malformed one never throws', () => {
		assert.strictEqual(nodeAt(EMPTY_MODEL, 0), undefined);
		assert.strictEqual(nodeAt(null, 0), undefined);
		assert.strictEqual(nodeAt(undefined, 0), undefined);
		assert.strictEqual(nodeAt({ nodes: [{ id: 'x', role: 'input', range: [0, 0] }], edges: [] }, 0), undefined);
		assert.strictEqual(nodeAt({ nodes: [{ id: 'x', role: 'input', range: [0, 5] }], edges: [] }, Number.NaN), undefined);
		const cycle: PipelineModel = {
			nodes: [
				{ id: 'a', role: 'route', range: [0, 10], parent: 'b' },
				{ id: 'b', role: 'route', range: [2, 8], parent: 'a' },
			],
			edges: [],
		};
		assert.doesNotThrow(() => nodeAt(cycle, 5));
		assert.strictEqual(nodeAt({ nodes: [{ id: 'x', role: 'input', range: [0, 5], parent: 'gone' }], edges: [] }, 1), 'x');
		assert.strictEqual(nodeAt({} as unknown as PipelineModel, 1), undefined);
	});

	test('NODEAT_FIXTURES: every node of every fixture model owns its start offset', () => {
		for (const { name, model } of FIXTURE_NAMES.map(fixture)) {
			for (const node of model.nodes) {
				assert.strictEqual(nodeAt(model, node.range[0]), node.id, `${name}: ${node.id}`);
			}
		}
	});

	test('NODEAT_FIXTURES: the round trip holds on the models built with each pinned schema', () => {
		for (const version of PINNED_VERSIONS) {
			const catalogue = componentCatalogue(servedSchema(version));
			for (const { name, yaml } of FIXTURE_NAMES.map(fixture)) {
				const model = buildPipelineModel(parseYaml(yaml), yaml, catalogue);
				assert.ok(model.nodes.length > 0, `${name} on ${version} has nodes`);
				for (const node of model.nodes) {
					assert.strictEqual(nodeAt(model, node.range[0]), node.id, `${name} on ${version}: ${node.id}`);
				}
			}
		}
	});
});
