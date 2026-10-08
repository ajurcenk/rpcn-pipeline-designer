import * as assert from 'assert';
import { bloblangContext } from '../../core/bloblang';
import { fieldSuggestions, knownNames, nameSuggestions, originText } from '../../core/bloblangNames';
import { parseYaml } from '../../core/yamlPath';

/** Known names at `§` in `marked`. */
function at(marked: string) {
	const offset = marked.indexOf('§');
	const text = marked.replace('§', '');
	const parsed = parseYaml(text);
	const context = bloblangContext(parsed, text, offset)!;
	assert.ok(context, `no Bloblang context at § in ${JSON.stringify(marked)}`);
	return { context, names: knownNames(parsed, text, offset, context) };
}
const fields = (marked: string, path: string[] = []) => fieldSuggestions(at(marked).names, path).map((s) => s.name);

const CONFIG = `input:
  generate:
    mapping: |
      root.id = uuid_v4()
      root.user = {"name": "a", "age": 3}
      meta source = "demo"
pipeline:
  processors:
    - mapping: |
        this.test = content().string()
        let h = this.test
        root.copy = this.user.name.uppercase()
        root.k = @kafka_key
        let z = this.§
`;

suite('core/bloblangNames (2.20)', () => {
	test('USER_CASE: this.test assigned on the line above is offered after this.', () => {
		const marked = 'pipeline:\n  processors:\n    - mapping: |\n        this.test = content().string()\n        let h = this.§\n';
		const { context, names } = at(marked);
		assert.deepStrictEqual(context.receiver, { base: 'this', path: [] });
		const [test] = fieldSuggestions(names, []);
		assert.deepStrictEqual([test.name, originText(test)], ['test', 'assigned on line 4']);
	});

	test('same mapping first, then earlier steps; nested paths from object literals', () => {
		const top = fieldSuggestions(at(CONFIG).names, []);
		assert.deepStrictEqual(top.map((s) => [s.name, s.origin]),
			[['copy', 'set'], ['k', 'set'], ['test', 'set'], ['id', 'set-earlier'], ['user', 'set-earlier']]);
		assert.strictEqual(top.find((s) => s.name === 'user')!.hasChildren, true);
		assert.deepStrictEqual(fields(CONFIG, ['user']), ['age', 'name']);
	});

	test('variables after $ and metadata after @', () => {
		const vars = CONFIG.replace('let z = this.§', 'let z = $§');
		assert.deepStrictEqual(nameSuggestions(at(vars).names.variables).map((s) => s.name), ['h']);
		const meta = CONFIG.replace('let z = this.§', 'root.m = @§');
		assert.deepStrictEqual(nameSuggestions(at(meta).names.metadata).map((s) => [s.name, s.origin]),
			[['source', 'set-earlier'], ['kafka_key', 'read']]);
	});

	test('reads count; a method call is not a field; the line being typed is not counted', () => {
		const marked = 'pipeline:\n  processors:\n    - mapping: |\n        root.a = this.order.items.length()\n        root.b = this.order.§\n';
		assert.deepStrictEqual(fields(marked, ['order']), ['items']);
		assert.deepStrictEqual(fields('pipeline:\n  processors:\n    - mapping: |\n        root.x = this.partial.§\n'), [], 'nothing from the current line');
	});

	test('bare paths and nested assignments; keywords, strings and comments are not fields', () => {
		const marked = 'pipeline:\n  processors:\n    - mapping: |\n        foo.bar = 1\n        root.a.b.c = 2\n'
			+ '        root.s = "this.fake = 1"\n        # this.gone = 1\n        if this.flag { root.y = 1 }\n        root.z = this.§\n';
		const names = fieldSuggestions(at(marked).names, []).map((s) => s.name);
		assert.ok(names.includes('foo') && names.includes('a') && names.includes('s') && names.includes('flag'), names.join(','));
		assert.ok(!names.includes('fake') && !names.includes('gone') && !names.includes('if'), names.join(','));
		assert.deepStrictEqual(fields(marked, ['a', 'b']), ['c']);
	});

	test('root. offers the same names; a later step is not seen from an earlier one', () => {
		const marked = 'pipeline:\n  processors:\n    - mapping: |\n        root.a = 1\n        root.b = root.§\n    - mapping: |\n        root.later = 1\n';
		const { context, names } = at(marked);
		assert.strictEqual(context.receiver?.base, 'root');
		assert.deepStrictEqual(fieldSuggestions(names, []).map((s) => s.name), ['a']);
	});

	test('interpolations are read too', () => {
		const marked = 'pipeline:\n  processors:\n    - log:\n        message: "${! this.order.id }"\n    - mapping: |\n        root = this.order.§\n';
		assert.deepStrictEqual(fields(marked, ['order']), ['id']);
	});
});
