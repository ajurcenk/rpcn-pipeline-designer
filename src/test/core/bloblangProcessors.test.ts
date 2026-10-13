import * as assert from 'assert';
import { bloblangProcessorAt, bloblangProcessorByPath, bloblangProcessors } from '../../core/bloblangProcessors';
import { parseYaml } from '../../core/yamlPath';

const CONFIG = [
	'input:',
	'  generate:',
	'    mapping: root = "not a processor"',
	'  processors:',
	'    - mutation: root.in = true',
	'pipeline:',
	'  processors:',
	'    - label: first',
	'      mapping: |',
	'        root.b = this.a + 1',
	'        root.c = "x"',
	'    - switch:',
	'        - check: this.a > 0',
	'          processors:',
	"            - mutation: 'root.d = \"it''s\"'",
	'    - log:',
	'        message: hi',
	'    - mapping: "root = \\"q\\""',
	'processor_resources:',
	'  - label: shared',
	'    mapping: root = this',
	'output:',
	'  stdout: {}',
	'',
].join('\n');

const processorsOf = (text: string) => bloblangProcessors(parseYaml(text));

suite('core/bloblangProcessors (4.2)', () => {
	test('LENS: every mapping and mutation processor of a processors list, at any depth, resources included', () => {
		const found = processorsOf(CONFIG);
		assert.deepStrictEqual(found.map((p) => [p.path, p.kind, p.label, p.source]), [
			['input.processors[0]', 'mutation', undefined, 'root.in = true'],
			['pipeline.processors[0]', 'mapping', 'first', 'root.b = this.a + 1\nroot.c = "x"\n'],
			['pipeline.processors[1].switch[0].processors[0]', 'mutation', undefined, 'root.d = "it\'s"'],
			['pipeline.processors[3]', 'mapping', undefined, 'root = "q"'],
			['processor_resources[0]', 'mapping', 'shared', 'root = this'],
		]);
		// The generate input's own `mapping` field is not a processor.
		assert.ok(!found.some((p) => p.source.includes('not a processor')));
	});

	test('the key range is the mapping / mutation key token', () => {
		for (const p of processorsOf(CONFIG)) {
			assert.strictEqual(CONFIG.slice(p.keyRange[0], p.keyRange[1]), p.kind);
		}
	});

	test('the processor at an offset: anywhere in its map; none outside every processor', () => {
		const found = processorsOf(CONFIG);
		const at = (needle: string) => bloblangProcessorAt(found, CONFIG.indexOf(needle))?.path;
		assert.strictEqual(at('label: first'), 'pipeline.processors[0]');
		assert.strictEqual(at('root.c'), 'pipeline.processors[0]');
		assert.strictEqual(at('root.d'), 'pipeline.processors[1].switch[0].processors[0]');
		assert.strictEqual(at('root = this'), 'processor_resources[0]');
		assert.strictEqual(at('message: hi'), undefined);
		assert.strictEqual(at('stdout'), undefined);
		assert.strictEqual(bloblangProcessorByPath(found, 'pipeline.processors[3]')?.source, 'root = "q"');
		assert.strictEqual(bloblangProcessorByPath(found, 'pipeline.processors[2]'), undefined);
	});

	test('an empty mapping is still a processor, with no source; a second document is prefixed', () => {
		const found = processorsOf('pipeline:\n  processors:\n    - mapping:\n---\npipeline:\n  processors:\n    - mutation: root = 1\n');
		assert.deepStrictEqual(found.map((p) => [p.path, p.kind, p.source]), [
			['pipeline.processors[0]', 'mapping', ''],
			['documents[1].pipeline.processors[0]', 'mutation', 'root = 1'],
		]);
	});

	test('nothing for no parse, no processors, or a mapping field outside a processors list', () => {
		assert.deepStrictEqual(bloblangProcessors(undefined), []);
		assert.deepStrictEqual(processorsOf(''), []);
		assert.deepStrictEqual(processorsOf('input:\n  generate:\n    mapping: root = 1\n'), []);
		assert.deepStrictEqual(processorsOf('pipeline:\n  processors:\n    - bloblang: root = 1\n'), []);
	});
});
