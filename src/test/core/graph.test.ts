import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildPipelineModel } from '../../core/graph';
import { parseYaml } from '../../core/yamlPath';
import { EMPTY_MODEL } from '../../shared/protocol';
import { REPO_ROOT } from '../helpers/fakeBinary';

const model = (text: string) => buildPipelineModel(parseYaml(text), text);
const slice = (text: string, range: readonly [number, number]) => text.slice(range[0], range[1]);

suite('core/graph (3.1, 3.2 shape)', () => {
	test('FLAT: stateful_polling.yaml gives input -> 4 processors -> output, in order', () => {
		const text = fs.readFileSync(path.join(REPO_ROOT, 'test', 'corpus', 'stateful_polling.yaml'), 'utf8');
		const m = model(text);
		assert.deepStrictEqual(m.nodes.map((n) => n.id), [
			'path:input',
			'path:pipeline.processors[0]',
			'path:pipeline.processors[1]',
			'path:pipeline.processors[2]',
			'path:pipeline.processors[3]',
			'path:output',
		]);
		assert.deepStrictEqual(m.nodes.map((n) => n.role), ['input', 'processor', 'processor', 'processor', 'processor', 'output']);
		assert.deepStrictEqual(m.nodes.map((n) => n.component), ['generate', 'cache', 'catch', 'sql_select', 'unarchive', 'broker']);
		// The flat chain: no groups, parents, labels or captions yet (3.3).
		assert.ok(m.nodes.every((n) => Object.keys(n).every((k) => ['id', 'role', 'component', 'range'].includes(k))));
		assert.ok(m.edges.every((e) => e.id === `${e.source}->${e.target}` && e.label === undefined));
		assert.deepStrictEqual(m.edges.map((e) => [e.source, e.target]), [
			['path:input', 'path:pipeline.processors[0]'],
			['path:pipeline.processors[0]', 'path:pipeline.processors[1]'],
			['path:pipeline.processors[1]', 'path:pipeline.processors[2]'],
			['path:pipeline.processors[2]', 'path:pipeline.processors[3]'],
			['path:pipeline.processors[3]', 'path:output'],
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

	test('FIXTURES: the flat builder reproduces the flat and labels fixture models exactly', () => {
		for (const name of ['flat', 'labels']) {
			const dir = path.join(REPO_ROOT, 'src', 'test', 'fixtures', 'models');
			const text = fs.readFileSync(path.join(dir, `${name}.yaml`), 'utf8');
			const expected: unknown = JSON.parse(fs.readFileSync(path.join(dir, `${name}.model.json`), 'utf8'));
			assert.deepStrictEqual(model(text), expected, name);
		}
	});

	test('ranges are UTF-16 offsets', () => {
		const text = 'input:\n  generate:\n    mapping: root = "\u{1F600}"\noutput:\n  stdout: {}\n';
		const out = model(text).nodes[1];
		assert.strictEqual(slice(text, out.range), 'output:\n  stdout: {}');
	});

	test('labels and processors keys are not the component name', () => {
		const text = 'input:\n  label: in\n  stdin: {}\npipeline:\n  processors:\n    - label: m\n      mapping: root = this\n';
		const m = model(text);
		assert.deepStrictEqual(m.nodes.map((n) => n.component), ['stdin', 'mapping']);
		assert.deepStrictEqual(m.nodes.map((n) => n.id), ['label:in', 'label:m']);
		assert.deepStrictEqual(m.nodes.map((n) => n.label), ['in', 'm']);
	});

	test('AD7_IDS: a duplicate label keeps the first occurrence\'s label id; later ones get their path id', () => {
		const text = [
			'input:', '  label: a', '  stdin: {}',
			'pipeline:', '  processors:',
			'    - label: a', '      mapping: root = this',
			'    - label: ""', '      log: {message: x}',
			'output:', '  label: a', '  stdout: {}', '',
		].join('\n');
		const m = model(text);
		assert.deepStrictEqual(m.nodes.map((n) => [n.id, n.label, n.duplicateLabel]), [
			['label:a', 'a', undefined],
			['path:pipeline.processors[0]', 'a', true],
			['path:pipeline.processors[1]', undefined, undefined],
			['path:output', 'a', true],
		]);
		assert.deepStrictEqual(m.edges.map((e) => e.id), [
			'label:a->path:pipeline.processors[0]',
			'path:pipeline.processors[0]->path:pipeline.processors[1]',
			'path:pipeline.processors[1]->path:output',
		]);
	});

	test('a number or boolean label is read as its text: label:123, and it joins the duplicate check', () => {
		const text = 'input:\n  label: 123\n  stdin: {}\npipeline:\n  processors:\n    - label: true\n      mapping: root = this\n    - label: "123"\n      log: {message: x}\n';
		assert.deepStrictEqual(model(text).nodes.map((n) => [n.id, n.label, n.duplicateLabel]), [
			['label:123', '123', undefined],
			['label:true', 'true', undefined],
			['path:pipeline.processors[1]', '123', true],
		]);
	});

	test('an input with no component is skipped, the rest still builds', () => {
		assert.deepStrictEqual(model('input:\noutput:\n  stdout: {}\n').nodes.map((n) => n.id), ['path:output']);
	});

	test('merge keys and null or empty keys are not the component name', () => {
		const text = 'base: &b {stdout: {}}\noutput:\n  <<: *b\n  file: {}\ninput:\n  ? \n  "": x\n  stdin: {}\n';
		assert.deepStrictEqual(model(text).nodes.map((n) => n.id), ['path:input', 'path:output']);
	});

	test('flow-style component and processors', () => {
		const text = 'input: {stdin: {}}\npipeline:\n  processors: [ {mapping: "root = this"}, {log: {message: x}} ]\n';
		const m = model(text);
		assert.deepStrictEqual(m.nodes.map((n) => n.id), ['path:input', 'path:pipeline.processors[0]', 'path:pipeline.processors[1]']);
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
		assert.deepStrictEqual(model('input:\n  stdin: {}\n').nodes.map((n) => n.id), ['path:input']);
		assert.deepStrictEqual(model('input:\n  stdin: {}\n').edges, []);
		assert.deepStrictEqual(model('input:\n  stdin: {}\noutput:\n  stdout: {}\n').edges.map((e) => e.id), ['path:input->path:output']);
		assert.deepStrictEqual(model('output:\n  stdout: {}\n').nodes.map((n) => n.id), ['path:output']);
		assert.deepStrictEqual(model('pipeline:\n  processors: []\n').nodes, []);
		assert.deepStrictEqual(model('pipeline:\n  processors:\n    - mapping: root = this\n').nodes.map((n) => n.id), ['path:pipeline.processors[0]']);
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
