import * as assert from 'assert';
import { bloblangProcessorAt, bloblangProcessorByPath, bloblangProcessors, previousSteps, stepTitle } from '../../core/bloblangProcessors';
import { componentCatalogue } from '../../core/catalogue';
import { buildPipelineModel, nodeAt } from '../../core/graph';
import { parseYaml } from '../../core/yamlPath';
import { positionProblems } from '../helpers/bloblangPositions';
import { servedSchema } from '../helpers/schemas';

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

	test('TRY_CATCH_FIX (4.12): try, catch and for_each are processor lists, at the top and nested', () => {
		const text = [
			'pipeline:',
			'  processors:',
			'    - try:',
			'        - mapping: root.t = 1',
			'        - log:',
			'            message: hi',
			'    - catch:',
			'        - mutation: root.c = 2',
			'    - for_each:',
			'        - label: each',
			'          mapping: root.f = 3',
			'    - branch:',
			'        processors:',
			'          - try:',
			'              - catch:',
			'                  - for_each:',
			'                      - mutation: root.deep = 4',
			'    - workflow:',
			'        branches:',
			'          a:',
			'            processors:',
			'              - for_each:',
			'                  - try:',
			'                      - mapping: root.w = 5',
			'processor_resources:',
			'  - label: res',
			'    catch:',
			'      - mapping: root.r = 6',
			'',
		].join('\n');
		const found = processorsOf(text);
		assert.deepStrictEqual(found.map((p) => [p.path, p.kind, p.label, p.source]), [
			['pipeline.processors[0].try[0]', 'mapping', undefined, 'root.t = 1'],
			['pipeline.processors[1].catch[0]', 'mutation', undefined, 'root.c = 2'],
			['pipeline.processors[2].for_each[0]', 'mapping', 'each', 'root.f = 3'],
			['pipeline.processors[3].branch.processors[0].try[0].catch[0].for_each[0]', 'mutation', undefined, 'root.deep = 4'],
			['pipeline.processors[4].workflow.branches.a.processors[0].for_each[0].try[0]', 'mapping', undefined, 'root.w = 5'],
			['processor_resources[0].catch[0]', 'mapping', undefined, 'root.r = 6'],
		]);
		for (const p of found) {
			assert.strictEqual(text.slice(p.keyRange[0], p.keyRange[1]), p.kind);
		}
		assert.strictEqual(bloblangProcessorAt(found, text.indexOf('root.deep'))?.path, found[3].path);
	});
});

const CATALOGUE = componentCatalogue(servedSchema('4.112.0'));

/** The processors of `text`, each checked to round-trip (every decoded character maps back). */
function roundTripped(text: string) {
	const found = processorsOf(text);
	const problems = found.flatMap((p) => positionProblems(text, p));
	assert.deepStrictEqual(problems, []);
	return found;
}

/** The processors of `text`, with the ids of its PipelineModel; each id is checked against the graph. */
function withModel(text: string) {
	const parsed = parseYaml(text);
	const model = buildPipelineModel(parsed, text, CATALOGUE);
	const found = bloblangProcessors(parsed, model);
	for (const p of found.filter((f) => f.id !== undefined)) {
		assert.strictEqual(model.nodes.find((n) => n.id === p.id)?.component, p.kind, p.path);
		assert.strictEqual(nodeAt(model, p.keyRange[0]), p.id, p.path);
	}
	return found;
}

/** Each processor's position map text. */
function scalarValues(text: string): string[] {
	return processorsOf(text).map((p) => p.positions.text);
}

suite('core/bloblangProcessors positions and ids (4.3)', () => {
	const BLOCK = [
		'pipeline:',
		'  processors:',
		'    - mapping: |',
		'        root.a = 1',
		'        root.bc = this.x',
		'    - mapping: |-',
		'        root = 1',
		'    - mapping: |+',
		'        root = 2',
		'',
		'    - mapping: |2',
		'          root = 3',
		'        root.b = 4',
		'',
	].join('\n');

	test('BLOCK: literal with clip, strip, keep and an indentation indicator', () => {
		const [clip, strip, keep, indented] = roundTripped(BLOCK);
		assert.deepStrictEqual(scalarValues(BLOCK), ['root.a = 1\nroot.bc = this.x\n', 'root = 1', 'root = 2\n\n', '  root = 3\nroot.b = 4\n']);
		assert.deepStrictEqual([clip, strip, keep, indented].map((p) => p.positions.text), [clip, strip, keep, indented].map((p) => p.source));
		// (2,5): the 5th character of the 2nd content line.
		assert.strictEqual(clip.positions.offsetAt(2, 5), BLOCK.indexOf('root.bc') + 4);
		assert.strictEqual(clip.positions.lineStart(2), BLOCK.indexOf('root.bc'));
		assert.strictEqual(strip.positions.offsetAt(1, 1), BLOCK.indexOf('root = 1'));
		assert.strictEqual(keep.positions.offsetAt(1, 6), BLOCK.indexOf('= 2'));
		// The indicator's extra indentation is kept, and maps to its spaces.
		assert.strictEqual(indented.positions.offsetAt(1, 1), BLOCK.indexOf('  root = 3'));
		assert.strictEqual(indented.positions.offsetAt(1, 3), BLOCK.indexOf('root = 3'));
		assert.strictEqual(indented.positions.lineStart(2), BLOCK.indexOf('root.b = 4'));
	});

	test('FOLDED: a folded break\'s space maps to the line break', () => {
		const text = [
			'pipeline:',
			'  processors:',
			'    - mapping: >',
			'        root = this.a +',
			'        this.b',
			'',
			'        root.c = [',
			'          1',
			'        ]',
			'',
		].join('\n');
		const [folded] = roundTripped(text);
		assert.strictEqual(folded.positions.text, 'root = this.a + this.b\nroot.c = [\n  1\n]\n');
		assert.strictEqual(folded.positions.offsetAt(1, 16), text.indexOf('+\n') + 1);
		assert.strictEqual(folded.positions.offsetAt(1, 17), text.indexOf('this.b'));
		assert.strictEqual(folded.positions.lineStart(3), text.indexOf('  1'));
	});

	test('PLAIN: one line, and a multi-line plain scalar whose fold maps to the break', () => {
		const text = 'pipeline:\n  processors:\n    - mapping: root = this\n    - mapping: root = this.a\n        + this.b\n';
		const [one, multi] = roundTripped(text);
		assert.deepStrictEqual([one.positions.text, multi.positions.text], ['root = this', 'root = this.a + this.b']);
		assert.strictEqual(one.positions.offsetAt(1, 8), text.indexOf('this\n'));
		assert.strictEqual(multi.positions.offsetAt(1, 14), text.indexOf('this.a\n') + 6);
		assert.strictEqual(multi.positions.offsetAt(1, 15), text.indexOf('+ this.b'));
	});

	test('SINGLE: \'\' decodes to \' and maps to the first \'; a fold maps to the break', () => {
		const text = "pipeline:\n  processors:\n    - mapping: 'root = ''b'' + \"c\"'\n    - mapping: 'root =\n        1'\n";
		const [single, folded] = roundTripped(text);
		assert.deepStrictEqual([single.positions.text, folded.positions.text], ['root = \'b\' + "c"', 'root = 1']);
		assert.strictEqual(single.positions.offsetAt(1, 8), text.indexOf("''b"));
		assert.strictEqual(single.positions.offsetAt(1, 9), text.indexOf("b''"));
		assert.strictEqual(single.positions.offsetAt(1, 10), text.indexOf("'' +"));
		assert.strictEqual(single.positions.offsetAt(1, 12), text.indexOf('+ "c"'));
		assert.strictEqual(folded.positions.offsetAt(1, 7), text.indexOf('=\n') + 1);
	});

	test('DOUBLE: each escape\'s result maps to its \; a \\ continuation and a fold', () => {
		const text = [
			'pipeline:',
			'  processors:',
			'    - mapping: "root = \\"b\\"\\nroot.x = 1 \\',
			'        + 2\\u00e9"',
			'    - mapping: "root =',
			'        this"',
			'',
		].join('\n');
		const [escaped, folded] = roundTripped(text);
		assert.deepStrictEqual([escaped.positions.text, folded.positions.text], ['root = "b"\nroot.x = 1 + 2é', 'root = this']);
		assert.strictEqual(escaped.positions.offsetAt(1, 8), text.indexOf('\\"b'));
		assert.strictEqual(escaped.positions.offsetAt(1, 9), text.indexOf('b\\"'));
		// Past line 1's end: its line break, the `\n` escape.
		assert.strictEqual(escaped.positions.offsetAt(1, 11), text.indexOf('\\nroot'));
		assert.strictEqual(escaped.positions.lineStart(2), text.indexOf('root.x'));
		assert.strictEqual(escaped.positions.offsetAt(2, 12), text.indexOf('+ 2'));
		assert.strictEqual(escaped.positions.offsetAt(2, 15), text.indexOf('\\u00e9'));
		assert.strictEqual(folded.positions.offsetAt(1, 7), text.indexOf('=\n        this') + 1);
	});

	test('CODE_POINTS: char counts code points, the offset is UTF-16 (an emoji is 2 units)', () => {
		const text = 'pipeline:\n  processors:\n    - mapping: root = "é日本😀" + x\n';
		const [p] = roundTripped(text);
		const emoji = text.indexOf('😀');
		assert.strictEqual(p.positions.offsetAt(1, 9), text.indexOf('é'));
		assert.strictEqual(p.positions.offsetAt(1, 11), text.indexOf('本'));
		assert.strictEqual(p.positions.offsetAt(1, 12), emoji);
		assert.strictEqual(p.positions.offsetAt(1, 13), emoji + 2);
		assert.strictEqual(p.positions.offsetAt(1, 15), emoji + 4);
	});

	test('CLAMP: a char past its line gives the line end, a line past the last the mapping end; never throws', () => {
		const [clip, strip] = processorsOf(BLOCK);
		const firstEnd = BLOCK.indexOf('root.a = 1') + 'root.a = 1'.length;
		assert.strictEqual(clip.positions.offsetAt(1, 99), firstEnd);
		const mappingEnd = BLOCK.indexOf('this.x') + 'this.x'.length;
		assert.strictEqual(clip.positions.offsetAt(3, 1), mappingEnd);
		assert.strictEqual(clip.positions.offsetAt(9, 4), mappingEnd);
		assert.strictEqual(clip.positions.lineStart(9), mappingEnd);
		assert.strictEqual(strip.positions.offsetAt(2, 1), BLOCK.indexOf('root = 1') + 'root = 1'.length);
		// Below 1, or not a number: the first character.
		for (const [line, char] of [[0, 0], [-3, -2], [NaN, NaN], [1.7, 1.2]]) {
			assert.strictEqual(clip.positions.offsetAt(line, char), BLOCK.indexOf('root.a'));
		}
	});

	test('ID: the PipelineModel node\'s id through nodeAt: labelled, unlabelled, duplicate-labelled and in processor_resources', () => {
		const text = [
			'input:',
			'  label: dup',
			'  generate:',
			'    mapping: root = 1',
			'  processors:',
			'    - label: in_map',
			'      mutation: root.a = 1',
			'pipeline:',
			'  processors:',
			'    - label: dup',
			'      mapping: root = 2',
			'    - mapping: root = 3',
			'    - label: in_map',
			'      branch:',
			'        processors:',
			'          - label: deep',
			'            mapping: root = 4',
			'processor_resources:',
			'  - label: dup',
			'    mapping: root = 5',
			'output:',
			'  label: deep',
			'  drop: {}',
			'',
		].join('\n');
		assert.deepStrictEqual(withModel(text).map((p) => [p.path, p.id]), [
			['input.processors[0]', 'label:in_map'],
			['pipeline.processors[0]', 'path:pipeline.processors[0]'],
			['pipeline.processors[1]', 'path:pipeline.processors[1]'],
			['pipeline.processors[2].branch.processors[0]', 'label:deep'],
			['processor_resources[0]', 'res:processor:dup'],
		]);
		assert.deepStrictEqual(withModel(CONFIG).map((p) => p.id), [
			'path:input.processors[0]',
			'label:first',
			'path:pipeline.processors[1].switch[0].processors[0]',
			'path:pipeline.processors[3]',
			'res:processor:shared',
		]);
		// A resource item with no component is no node, so it takes no label.
		assert.deepStrictEqual(withModel('processor_resources:\n  - label: q\n  - label: q\n    mapping: root = 1\n').map((p) => p.id),
			['res:processor:q']);
		// An input with no component is no node either: its label is free, its processors have no node.
		assert.deepStrictEqual(withModel('input:\n  label: a\n  processors:\n    - mapping: root = 1\n'
			+ 'pipeline:\n  processors:\n    - label: a\n      mapping: root = 2\n').map((p) => [p.path, p.id]),
		[['input.processors[0]', undefined], ['pipeline.processors[0]', 'label:a']]);
		// No model, or a second document (the graph is the first's): no id.
		assert.deepStrictEqual(processorsOf(CONFIG).map((p) => p.id), [undefined, undefined, undefined, undefined, undefined]);
		assert.deepStrictEqual(withModel('pipeline:\n  processors:\n    - label: a\n      mapping: root = 1\n---\n'
			+ 'processor_resources:\n  - label: a\n    mapping: root = 2\n').map((p) => p.id), ['label:a', undefined]);
	});

	test('NOT_SCALAR: a list or an empty value gives no text, and every position clamps to the key', () => {
		const text = 'pipeline:\n  processors:\n    - mapping: [1, 2]\n    - mutation:\n    - mapping: ""\n';
		const found = processorsOf(text);
		assert.deepStrictEqual(found.map((p) => p.positions.text), ['', '', '']);
		for (const p of found) {
			assert.deepStrictEqual([p.positions.offsetAt(1, 1), p.positions.offsetAt(3, 9), p.positions.lineStart(2)],
				[p.keyRange[0], p.keyRange[0], p.keyRange[0]]);
		}
	});

	test('a scalar whose decoding differs from its value maps every position to the value\'s start', () => {
		// `1.0` resolves to the number 1: the source `1` is not the scalar's text.
		const text = 'pipeline:\n  processors:\n    - mapping: 1.0\n';
		const [p] = processorsOf(text);
		assert.strictEqual(p.positions.text, p.source);
		assert.deepStrictEqual([p.positions.offsetAt(1, 1), p.positions.offsetAt(4, 4)], [text.indexOf('1.0'), text.indexOf('1.0')]);
	});

	test('PREVIOUS_STEPS (4.18): the mappings / mutations just before, nearest first, in the same list only', () => {
		const text = [
			'pipeline:',
			'  processors:',
			'    - label: a',
			'      mapping: root = 1',
			'    - mutation: root.b = 2',
			'    - label: c',
			'      mapping: root.c = 3',
			'    - log:',
			'        message: hi',
			'    - mapping: root = this',
			'    - try:',
			'        - mapping: root.t = 1',
			'        - mapping: root.u = 2',
			'    - switch:',
			'        - processors:',
			'            - mapping: root.s = 1',
			'            - mapping: root.s = 2',
			'processor_resources:',
			'  - label: r1',
			'    mapping: root = 1',
			'  - label: r2',
			'    mapping: root = 2',
			'---',
			'pipeline:',
			'  processors:',
			'    - mapping: root = 1',
			'    - mapping: root = 2',
			'',
		].join('\n');
		const found = processorsOf(text);
		const steps = (path: string) => previousSteps(found, path).map((p) => p.path);
		// SEED + CHAIN: nearest first, up to the start of the list.
		assert.deepStrictEqual(steps('pipeline.processors[2]'), ['pipeline.processors[1]', 'pipeline.processors[0]']);
		assert.deepStrictEqual(steps('pipeline.processors[1]'), ['pipeline.processors[0]']);
		// NO_PREVIOUS: the first item, a previous item of another kind, a resource.
		assert.deepStrictEqual(steps('pipeline.processors[0]'), []);
		assert.deepStrictEqual(steps('pipeline.processors[4]'), []);
		assert.deepStrictEqual(steps('processor_resources[1]'), []);
		// NESTED: a try: list and a switch case's processors, never the outer list.
		assert.deepStrictEqual(steps('pipeline.processors[5].try[1]'), ['pipeline.processors[5].try[0]']);
		assert.deepStrictEqual(steps('pipeline.processors[5].try[0]'), []);
		assert.deepStrictEqual(steps('pipeline.processors[6].switch[0].processors[1]'), ['pipeline.processors[6].switch[0].processors[0]']);
		// A later document's list.
		assert.deepStrictEqual(steps('documents[1].pipeline.processors[1]'), ['documents[1].pipeline.processors[0]']);
		// A path that names no list item.
		assert.deepStrictEqual(steps('pipeline'), []);
		// The title: the label, else the path.
		assert.deepStrictEqual(previousSteps(found, 'pipeline.processors[2]').map(stepTitle), ['pipeline.processors[1]', 'a']);
	});
});
