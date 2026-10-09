import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { componentCatalogue } from '../../core/catalogue';
import { buildPipelineModel } from '../../core/graph';
import { parseYaml } from '../../core/yamlPath';
import { EMPTY_MODEL } from '../../shared/protocol';
import { REPO_ROOT } from '../helpers/fakeBinary';
import { fixture, FIXTURE_NAMES } from '../helpers/fixtureModels';
import { PINNED_VERSIONS, rawSchema, servedSchema } from '../helpers/schemas';

const CATALOGUE = componentCatalogue(servedSchema('4.112.0'));
const model = (text: string) => buildPipelineModel(parseYaml(text), text, CATALOGUE);
const slice = (text: string, range: readonly [number, number]) => text.slice(range[0], range[1]);

suite('core/graph (3.3, nested over the catalogue)', () => {
	test('NESTED: stateful_polling.yaml: the catch group holds its mapping, the broker its outputs, plus the cache resources', () => {
		const text = fs.readFileSync(path.join(REPO_ROOT, 'test', 'corpus', 'stateful_polling.yaml'), 'utf8');
		const m = model(text);
		assert.deepStrictEqual(m.nodes.map((n) => [n.id, n.role, n.component ?? n.caption, n.parent, n.group]), [
			['path:input', 'input', 'generate', undefined, undefined],
			['path:pipeline.processors[0]', 'processor', 'cache', undefined, undefined],
			['path:pipeline.processors[1]', 'processor', 'catch', undefined, true],
			['path:pipeline.processors[1].catch', 'route', undefined, 'path:pipeline.processors[1]', undefined],
			['path:pipeline.processors[1].catch[0]', 'processor', 'mapping', 'path:pipeline.processors[1].catch', undefined],
			['path:pipeline.processors[2]', 'processor', 'sql_select', undefined, undefined],
			['path:pipeline.processors[3]', 'processor', 'unarchive', undefined, undefined],
			['path:output', 'output', 'broker', undefined, true],
			['path:output.broker.outputs', 'route', 'fan_out_sequential', 'path:output', undefined],
			['path:output.broker.outputs[0]', 'output', 'stdout', 'path:output.broker.outputs', undefined],
			// A nested output's own processors (before its component key) make it a group.
			['path:output.broker.outputs[1]', 'output', 'cache', 'path:output.broker.outputs', true],
			['path:output.broker.outputs[1].processors[0]', 'processor', 'mapping', 'path:output.broker.outputs[1]', undefined],
			['res:cache:cached_pgstate', 'resource', 'multilevel', undefined, undefined],
			['res:cache:inmem', 'resource', 'memory', undefined, undefined],
			['res:cache:pgstate', 'resource', 'sql', undefined, undefined],
		]);
		assert.ok(m.edges.every((e) => e.id === `${e.source}->${e.target}` && e.label === undefined));
		assert.deepStrictEqual(m.edges.map((e) => [e.source, e.target]), [
			['path:input', 'path:pipeline.processors[0]'],
			['path:pipeline.processors[0]', 'path:pipeline.processors[1]'],
			['path:pipeline.processors[1]', 'path:pipeline.processors[2]'],
			['path:pipeline.processors[2]', 'path:pipeline.processors[3]'],
			['path:pipeline.processors[3]', 'path:output'],
		]);
		const byId = new Map(m.nodes.map((n) => [n.id, n]));
		const at = (id: string) => slice(text, byId.get(id)!.range);
		assert.ok(at('path:input').startsWith('input:\n  generate:'));
		assert.ok(at('path:input').endsWith("mapping: 'root = {}'"));
		assert.ok(at('path:pipeline.processors[2]').startsWith('- sql_select:'));
		assert.ok(at('path:pipeline.processors[2]').endsWith('args_mapping: root = [this.id]'));
		assert.strictEqual(at('path:pipeline.processors[3]'), '- unarchive:\n        format: json_array');
		assert.strictEqual(at('path:pipeline.processors[1].catch'), "catch:\n        - mapping: 'root.id = -1'");
		assert.ok(at('path:output').startsWith('output:\n  broker:'));
		assert.ok(at('path:output').endsWith('max_in_flight: 1'));
		assert.ok(at('path:output.broker.outputs').startsWith('outputs:\n'));
		assert.ok(at('path:output.broker.outputs[1]').startsWith('- processors:'));
	});

	test('FIXTURES: the builder reproduces every fixture model exactly, on the 4.100.0 and 4.112.0 schemas', () => {
		for (const version of PINNED_VERSIONS) {
			const catalogue = componentCatalogue(servedSchema(version));
			for (const { name, yaml, model: expected } of FIXTURE_NAMES.map(fixture)) {
				assert.deepStrictEqual(buildPipelineModel(parseYaml(yaml), yaml, catalogue), expected, `${name} on ${version}`);
			}
		}
	});

	test('NO_SCHEMA: no catalogue gives the empty model', () => {
		const text = 'input:\n  stdin: {}\noutput:\n  stdout: {}\n';
		assert.deepStrictEqual(buildPipelineModel(parseYaml(text), text, undefined), EMPTY_MODEL);
	});

	test('UNKNOWN: a component the schema does not list is a node with no children; never throws', () => {
		const text = [
			'pipeline:', '  processors:',
			'    - not_a_component:', '        processors:', '          - mapping: root = this',
			'    - label: x', '      plugin_thing: {}',
			'output:', '  label: out', '  my_plugin_output:', '    outputs:', '      - stdout: {}', '',
		].join('\n');
		const m = model(text);
		assert.deepStrictEqual(m.nodes.map((n) => [n.id, n.component, n.group]), [
			['path:pipeline.processors[0]', 'not_a_component', undefined],
			['label:x', 'plugin_thing', undefined],
			['label:out', 'my_plugin_output', undefined],
		]);
		assert.deepStrictEqual(m.edges.map((e) => e.id), ['path:pipeline.processors[0]->label:x', 'label:x->label:out']);
	});

	test('COMPONENT_KEY: the component is a catalogue name, not label; a processor named processors is a component', () => {
		const text = [
			'pipeline:', '  processors:',
			'    - label: first', '      mapping: root = this',
			'    - processors:', '        - log: {message: a}', '        - mapping: root = this',
			'output:', '  processors:', '    - mapping: root = this', '  label: sink', '  drop: {}', '',
		].join('\n');
		const m = model(text);
		assert.deepStrictEqual(m.nodes.map((n) => [n.id, n.role, n.component ?? null, n.parent ?? null]), [
			['label:first', 'processor', 'mapping', null],
			['path:pipeline.processors[1]', 'processor', 'processors', null],
			['path:pipeline.processors[1].processors', 'route', null, 'path:pipeline.processors[1]'],
			['path:pipeline.processors[1].processors[0]', 'processor', 'log', 'path:pipeline.processors[1].processors'],
			['path:pipeline.processors[1].processors[1]', 'processor', 'mapping', 'path:pipeline.processors[1].processors'],
			['label:sink', 'output', 'drop', null],
			['path:output.processors[0]', 'processor', 'mapping', null],
		]);
		assert.deepStrictEqual(m.edges.map((e) => e.id), [
			'label:first->path:pipeline.processors[1]',
			'path:pipeline.processors[1]->path:output.processors[0]',
			'path:output.processors[0]->label:sink',
			'path:pipeline.processors[1].processors[0]->path:pipeline.processors[1].processors[1]',
		]);
	});

	test('RESOURCE_GROUP: a processor_resources switch is a res: group with its routes and children', () => {
		const text = [
			'processor_resources:',
			'  - label: route_it',
			'    switch:',
			'      - check: this.a',
			'        processors:',
			'          - label: inner',
			'            mapping: root.a = true',
			'          - log: {message: a}',
			'      - processors:',
			'          - mapping: root.b = true',
			'  - mapping: root = this',
			'  - label: route_it',
			'    log: {message: dup}',
			'',
		].join('\n');
		const m = model(text);
		assert.deepStrictEqual(m.nodes.map((n) => [n.id, n.role, n.component ?? n.caption, n.parent ?? null, n.group ?? false]), [
			['res:processor:route_it', 'resource', 'switch', null, true],
			['path:processor_resources[0].switch[0]', 'route', 'this.a', 'res:processor:route_it', false],
			['label:inner', 'processor', 'mapping', 'path:processor_resources[0].switch[0]', false],
			['path:processor_resources[0].switch[0].processors[1]', 'processor', 'log', 'path:processor_resources[0].switch[0]', false],
			['path:processor_resources[0].switch[1]', 'route', 'case 1', 'res:processor:route_it', false],
			['path:processor_resources[0].switch[1].processors[0]', 'processor', 'mapping', 'path:processor_resources[0].switch[1]', false],
			['path:processor_resources[1]', 'resource', 'mapping', null, false],
			['path:processor_resources[2]', 'resource', 'log', null, false],
		]);
		assert.strictEqual(m.nodes[7].duplicateLabel, true);
		assert.deepStrictEqual(m.edges.map((e) => e.id), ['label:inner->path:processor_resources[0].switch[0].processors[1]']);
	});

	test('ESCAPED_KEY: a workflow branch named a.b gets ["a.b"] in its route id', () => {
		const text = [
			'pipeline:', '  processors:', '    - workflow:',
			'        order: [ [ "a.b" ], [ plain ] ]',
			'        branches:',
			'          a.b:', '            processors:', '              - mapping: root = this',
			'          plain:', '            processors:', '              - mapping: root = this',
			'',
		].join('\n');
		const m = model(text);
		assert.deepStrictEqual(m.nodes.map((n) => n.id), [
			'path:pipeline.processors[0]',
			'path:pipeline.processors[0].workflow.branches["a.b"]',
			'path:pipeline.processors[0].workflow.branches["a.b"].processors[0]',
			'path:pipeline.processors[0].workflow.branches.plain',
			'path:pipeline.processors[0].workflow.branches.plain.processors[0]',
		]);
		assert.deepStrictEqual(m.nodes.map((n) => n.caption).filter(Boolean), ['a.b', 'plain']);
		assert.deepStrictEqual(m.edges.map((e) => e.id), [
			'path:pipeline.processors[0].workflow.branches["a.b"]->path:pipeline.processors[0].workflow.branches.plain',
		]);
	});

	test('NEWER_BINARY: a component only a newer schema lists gets its children with no code change', () => {
		const raw = rawSchema('4.112.0');
		const definitions = raw.definitions as Record<string, { allOf: Array<{ anyOf: unknown[] }> }>;
		definitions.processor.allOf[0].anyOf.push({
			type: 'object',
			properties: { rpcn_test_guard: { type: 'object', properties: { then: { type: 'array', items: { $ref: '#/definitions/processor' } } } } },
		});
		const text = 'pipeline:\n  processors:\n    - rpcn_test_guard:\n        then:\n          - mapping: root = this\n';
		const ids = (catalogue: ReturnType<typeof componentCatalogue>) => buildPipelineModel(parseYaml(text), text, catalogue).nodes.map((n) => n.id);
		assert.deepStrictEqual(ids(CATALOGUE), ['path:pipeline.processors[0]']);
		assert.deepStrictEqual(ids(componentCatalogue(raw)), ['path:pipeline.processors[0]', 'path:pipeline.processors[0].rpcn_test_guard.then[0]']);
	});

	test('more group kinds: reject_errored, dynamic, read_until, sequence, try_catch, group_by', () => {
		const text = [
			'input:', '  read_until:', '    check: false', '    input:', '      sequence:', '        inputs:', '          - stdin: {}', '          - generate: {mapping: root = 1}',
			'pipeline:', '  processors:',
			'    - try_catch:', '        processors:', '          - mapping: root = 1', '        catch:', '          - log: {message: x}',
			'    - group_by:', '        - check: this.a', '          processors:', '            - mapping: root = 2', '        - processors: []',
			'output:', '  reject_errored:', '    dynamic:', '      outputs:', '        first:', '          stdout: {}',
			'',
		].join('\n');
		const m = model(text);
		assert.deepStrictEqual(m.nodes.map((n) => [n.id, n.component ?? `(${n.caption ?? ''})`, n.parent ?? null]), [
			['path:input', 'read_until', null],
			['path:input.read_until.input', 'sequence', 'path:input'],
			['path:input.read_until.input.sequence.inputs[0]', 'stdin', 'path:input.read_until.input'],
			['path:input.read_until.input.sequence.inputs[1]', 'generate', 'path:input.read_until.input'],
			['path:pipeline.processors[0]', 'try_catch', null],
			['path:pipeline.processors[0].try_catch.processors[0]', 'mapping', 'path:pipeline.processors[0]'],
			['path:pipeline.processors[0].try_catch.catch[0]', 'log', 'path:pipeline.processors[0]'],
			['path:pipeline.processors[1]', 'group_by', null],
			['path:pipeline.processors[1].group_by[0]', '()', 'path:pipeline.processors[1]'],
			['path:pipeline.processors[1].group_by[0].processors[0]', 'mapping', 'path:pipeline.processors[1].group_by[0]'],
			['path:pipeline.processors[1].group_by[1]', '()', 'path:pipeline.processors[1]'],
			['path:output', 'reject_errored', null],
			['path:output.reject_errored', 'dynamic', 'path:output'],
			['path:output.reject_errored.dynamic.outputs.first', 'stdout', 'path:output.reject_errored'],
		]);
		assert.deepStrictEqual(m.nodes.filter((n) => n.group).map((n) => n.id), [
			'path:input', 'path:input.read_until.input', 'path:pipeline.processors[0]', 'path:pipeline.processors[1]',
			'path:output', 'path:output.reject_errored',
		]);
		// Inputs in a list are not chained.
		assert.deepStrictEqual(m.edges.map((e) => e.id), [
			'path:input->path:pipeline.processors[0]',
			'path:pipeline.processors[0]->path:pipeline.processors[1]',
			'path:pipeline.processors[1]->path:output',
		]);
	});

	test('REJECT_ERRORED: its child\'s range is the child\'s own component pair', () => {
		const text = 'output:\n  reject_errored:\n    label: inner\n    stdout:\n      codec: lines\n';
		const child = model(text).nodes.find((n) => n.id === 'label:inner')!;
		assert.strictEqual(child.parent, 'path:output');
		assert.strictEqual(slice(text, child.range), 'stdout:\n      codec: lines');
	});

	test('CASE_CAPTION: whitespace collapsed, cut by code points to 31 plus …, blank falls back to case <i>', () => {
		const captions = (checks: string[]) => {
			const text = ['pipeline:', '  processors:', '    - switch:',
				...checks.flatMap((c) => [`        - check: ${c}`, '          processors: []']), ''].join('\n');
			return model(text).nodes.filter((n) => n.role === 'route').map((n) => n.caption);
		};
		const exactly32 = 'a'.repeat(32);
		const over32 = 'b'.repeat(33);
		assert.deepStrictEqual(captions([exactly32, over32]), [exactly32, `${'b'.repeat(31)}…`]);
		// A surrogate pair is one character and is never split.
		const emoji = `"${'\u{1F600}'.repeat(40)}"`;
		assert.deepStrictEqual(captions([emoji]), [`${'\u{1F600}'.repeat(31)}…`]);
		assert.deepStrictEqual(captions(['"  "', "''"]), ['case 0', 'case 1']);
		const multi = ['pipeline:', '  processors:', '    - switch:',
			'        - check: |', '            this.a == 1 &&', '              this.b   == 2', '          processors: []', ''].join('\n');
		assert.deepStrictEqual(model(multi).nodes.filter((n) => n.role === 'route').map((n) => n.caption), ['this.a == 1 && this.b == 2']);
	});

	test('WORKFLOW_ORDER: a branch in consecutive stages gets no self-loop', () => {
		const text = ['pipeline:', '  processors:', '    - workflow:',
			'        order: [ [ a ], [ a, b ] ]', '        branches:',
			'          a: {processors: [ {mapping: root = this} ]}', '          b: {processors: [ {mapping: root = this} ]}', ''].join('\n');
		assert.deepStrictEqual(model(text).edges.map((e) => e.id), [
			'path:pipeline.processors[0].workflow.branches.a->path:pipeline.processors[0].workflow.branches.b',
		]);
	});

	test('odd shapes are skipped: a scalar case, a null body, an alias', () => {
		const text = [
			'pipeline:', '  processors:',
			'    - switch:', '        - just text', '        - check: x', '    - try:', '    - branch:', '        processors: nope',
			'    - &m {mapping: root = this}', '    - *m',
			'',
		].join('\n');
		const m = model(text);
		assert.deepStrictEqual(m.nodes.map((n) => [n.id, n.group ?? false]), [
			['path:pipeline.processors[0]', true],
			['path:pipeline.processors[0].switch[1]', false],
			['path:pipeline.processors[1]', false],
			['path:pipeline.processors[2]', false],
			['path:pipeline.processors[3]', false],
		]);
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
		// Nodes are in document order; the chain still runs input -> output.
		assert.deepStrictEqual(model(text).nodes.map((n) => n.id), ['path:output', 'path:input']);
		assert.deepStrictEqual(model(text).edges.map((e) => e.id), ['path:input->path:output']);
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
		assert.deepStrictEqual(buildPipelineModel(undefined, '', CATALOGUE), EMPTY_MODEL);
	});
});
