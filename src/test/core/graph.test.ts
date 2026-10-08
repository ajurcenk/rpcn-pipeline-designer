import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildPipelineModel } from '../../core/graph';
import { parseYaml } from '../../core/yamlPath';
import { EMPTY_MODEL } from '../../shared/protocol';
import { REPO_ROOT } from '../helpers/fakeBinary';

const model = (text: string) => buildPipelineModel(parseYaml(text), text);
const slice = (text: string, range: readonly [number, number]) => text.slice(range[0], range[1]);

suite('core/graph (3.1)', () => {
	test('FLAT: stateful_polling.yaml gives input -> 4 processors -> output, in order', () => {
		const text = fs.readFileSync(path.join(REPO_ROOT, 'test', 'corpus', 'stateful_polling.yaml'), 'utf8');
		const m = model(text);
		assert.deepStrictEqual(m.nodes.map((n) => n.id), [
			'input:generate',
			'processor:0:cache',
			'processor:1:catch',
			'processor:2:sql_select',
			'processor:3:unarchive',
			'output:broker',
		]);
		assert.deepStrictEqual(m.nodes.map((n) => n.kind), ['input', 'processor', 'processor', 'processor', 'processor', 'output']);
		assert.deepStrictEqual(m.edges.map((e) => [e.source, e.target]), [
			['input:generate', 'processor:0:cache'],
			['processor:0:cache', 'processor:1:catch'],
			['processor:1:catch', 'processor:2:sql_select'],
			['processor:2:sql_select', 'processor:3:unarchive'],
			['processor:3:unarchive', 'output:broker'],
		]);
		const [input, , , sql, unarchive, output] = m.nodes;
		assert.ok(slice(text, input.range).startsWith('input:\n  generate:'));
		assert.ok(slice(text, input.range).endsWith("mapping: 'root = {}'"));
		assert.ok(slice(text, sql.range).startsWith('- sql_select:'));
		assert.ok(slice(text, sql.range).endsWith('args_mapping: root = [this.id]'));
		assert.strictEqual(slice(text, unarchive.range), '- unarchive:\n        format: json_array');
		assert.ok(slice(text, output.range).startsWith('output:\n  broker:'));
		assert.ok(slice(text, output.range).endsWith('max_in_flight: 1'));
	});

	test('ranges are UTF-16 offsets', () => {
		const text = 'input:\n  generate:\n    mapping: root = "\u{1F600}"\noutput:\n  stdout: {}\n';
		const out = model(text).nodes[1];
		assert.strictEqual(slice(text, out.range), 'output:\n  stdout: {}');
	});

	test('labels and processors keys are not the component name', () => {
		const text = 'input:\n  label: in\n  stdin: {}\npipeline:\n  processors:\n    - label: m\n      mapping: root = this\n';
		assert.deepStrictEqual(model(text).nodes.map((n) => n.id), ['input:stdin', 'processor:0:mapping']);
	});

	test('merge keys and null or empty keys are not the component name', () => {
		const text = 'base: &b {stdout: {}}\noutput:\n  <<: *b\n  file: {}\ninput:\n  ? \n  "": x\n  stdin: {}\n';
		assert.deepStrictEqual(model(text).nodes.map((n) => n.id), ['input:stdin', 'output:file']);
	});

	test('flow-style component and processors', () => {
		const text = 'input: {stdin: {}}\npipeline:\n  processors: [ {mapping: "root = this"}, {log: {message: x}} ]\n';
		const m = model(text);
		assert.deepStrictEqual(m.nodes.map((n) => n.id), ['input:stdin', 'processor:0:mapping', 'processor:1:log']);
		assert.deepStrictEqual(m.nodes.map((n) => slice(text, n.range)), [
			'input: {stdin: {}}', '{mapping: "root = this"}', '{log: {message: x}}',
		]);
	});

	test('CRLF line endings: ranges do not include the \\r', () => {
		const text = 'input:\r\n  stdin: {}\r\npipeline:\r\n  processors:\r\n    - mapping: root = this\r\noutput:\r\n  stdout: {}\r\n';
		assert.deepStrictEqual(model(text).nodes.map((n) => slice(text, n.range)), [
			'input:\r\n  stdin: {}', '- mapping: root = this', 'output:\r\n  stdout: {}',
		]);
	});

	test('PARTIAL: only the present parts', () => {
		assert.deepStrictEqual(model('input:\n  stdin: {}\n').nodes.map((n) => n.id), ['input:stdin']);
		assert.deepStrictEqual(model('input:\n  stdin: {}\n').edges, []);
		assert.deepStrictEqual(model('input:\n  stdin: {}\noutput:\n  stdout: {}\n').edges.map((e) => e.id), ['input:stdin->output:stdout']);
		assert.deepStrictEqual(model('output:\n  stdout: {}\n').nodes.map((n) => n.id), ['output:stdout']);
		assert.deepStrictEqual(model('pipeline:\n  processors: []\n').nodes, []);
		assert.deepStrictEqual(model('pipeline:\n  processors:\n    - mapping: root = this\n').nodes.map((n) => n.id), ['processor:0:mapping']);
		assert.deepStrictEqual(model('input:\n').nodes, []);
		assert.deepStrictEqual(model('').nodes, []);
		assert.deepStrictEqual(model('- a\n- b\n').nodes, []);
	});

	test('UNPARSEABLE: a YAML parse error gives the empty model, never throws', () => {
		assert.deepStrictEqual(model('input:\n  generate: {\n'), EMPTY_MODEL);
		assert.deepStrictEqual(model('input: [\n  : ]: x\n'), EMPTY_MODEL);
		assert.deepStrictEqual(buildPipelineModel(undefined, ''), EMPTY_MODEL);
	});
});
