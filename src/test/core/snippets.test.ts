import * as assert from 'assert';
import { slotAt } from '../../core/gapCompletion';
import { PIPELINE_SNIPPETS, renderSnippet, snippetSlotOf, snippetsFor } from '../../core/snippets';
import { parseYaml, topLevelKeys } from '../../core/yamlPath';

const slot = (marked: string) => {
	const offset = marked.indexOf('§');
	const text = marked.replace('§', '');
	return snippetSlotOf(slotAt(parseYaml(text), text, offset));
};

suite('core/snippets (2.10)', () => {
	test('slots: top level, input / output, any processor list item', () => {
		assert.strictEqual(slot('§'), 'root');
		assert.strictEqual(slot('input:\n  stdin: {}\n§'), 'root');
		assert.strictEqual(slot('input:\n  §\n'), 'input');
		assert.strictEqual(slot('input:\n  ge§\n'), 'input');
		assert.strictEqual(slot('output:\n  §\n'), 'output');
		assert.strictEqual(slot('pipeline:\n  processors:\n    - §\n'), 'processor');
		assert.strictEqual(slot('pipeline:\n  processors:\n    - switch:\n        - check: a\n          processors:\n            - §\n'), 'processor');
		assert.strictEqual(slot('output:\n  redpanda:\n    batching:\n      processors:\n        - §\n'), 'processor');
	});

	test('no snippets inside a component, under other keys, or on non-processor lists', () => {
		assert.strictEqual(slot('input:\n  socket:\n    §\n'), undefined);
		assert.strictEqual(slot('logger:\n  §\n'), undefined);
		assert.strictEqual(slot('input:\n  redpanda:\n    topics:\n      - §\n'), undefined);
		assert.strictEqual(slot('output:\n  broker:\n    outputs:\n      - §\n'), undefined);
	});

	test('root snippets only for sections the file lacks', () => {
		const labels = (keys: string[]) => snippetsFor('root', keys).map((s) => s.label);
		assert.deepStrictEqual(labels([]), ['Redpanda Connect pipeline', 'input section', 'pipeline section', 'output section']);
		assert.deepStrictEqual(labels(['input']), ['pipeline section', 'output section']);
		assert.deepStrictEqual(labels(['input', 'pipeline', 'output']), []);
		assert.deepStrictEqual(topLevelKeys(parseYaml('input:\n  stdin: {}\noutput:\n  drop: {}\n')), ['input', 'output']);
	});

	test('the ticket\'s components are all there (redpanda in place of the deprecated kafka_franz input)', () => {
		const by = (slotName: string) => PIPELINE_SNIPPETS.filter((s) => s.slot === slotName).map((s) => s.prefix);
		assert.deepStrictEqual(by('input'), ['generate', 'redpanda']);
		assert.deepStrictEqual(by('output'), ['redpanda', 'stdout']);
		assert.deepStrictEqual(by('processor'), ['mapping', 'switch', 'branch', 'log']);
	});

	test('renderSnippet: placeholder defaults (with { and escaped }), $0 removed', () => {
		assert.strictEqual(renderSnippet('a: ${1:1s}\nb: ${2:{"x": 1\\}}$0'), 'a: 1s\nb: {"x": 1}');
		assert.strictEqual(renderSnippet('m: ${2:\\${! content() \\}}'), 'm: ${! content() }');
	});
});
