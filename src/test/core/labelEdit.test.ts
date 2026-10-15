import * as assert from 'assert';
import { bloblangProcessorByPath, bloblangProcessors } from '../../core/bloblangProcessors';
import {
	documentLabels, isLabelName, LABEL_IN_SAMPLES_ERROR, LABEL_RULE_ERROR, LABEL_TAKEN_ERROR, labelError, labelInsertion, suggestLabel,
} from '../../core/labelEdit';
import { parseYaml } from '../../core/yamlPath';

const CONFIG = [
	'input:',
	'  label: in',
	'  stdin: {}',
	'pipeline:',
	'  processors:',
	'    - label: first',
	'      mapping: root = this',
	'    - mutation: root.b = 1',
	'    - switch:',
	'        - check: this.a > 0',
	'          processors:',
	'            - mapping: |',
	'                root.c = 2',
	'              # trailing',
	'    - {mapping: "root = 3"}',
	'output:',
	'  stdout: {}',
	'',
].join('\n');

const processor = (text: string, path: string) => {
	const found = bloblangProcessorByPath(bloblangProcessors(parseYaml(text)), path);
	assert.ok(found, path);
	return found;
};

/** `text` with `label: <name>` inserted into the processor at `path`, which must succeed. */
function inserted(text: string, path: string, name: string): string {
	const insertion = labelInsertion(text, processor(text, path), name);
	assert.ok(insertion, `${path} takes ${name}`);
	return `${text.slice(0, insertion.offset)}${insertion.text}${text.slice(insertion.offset)}`;
}

suite('core/labelEdit (4.16)', () => {
	test('RULE: the binary\'s rule, then unique in the document, then not a label entry of the samples file', () => {
		for (const ok of ['mapping_1', 'a', '0', 'a-b_c', '-x']) {
			assert.ok(isLabelName(ok), ok);
		}
		for (const bad of ['', 'Bad', '_x', 'a b', 'a.b', 'é', 'a:b']) {
			assert.ok(!isLabelName(bad), bad);
			assert.strictEqual(labelError(bad, new Set(), new Set()), LABEL_RULE_ERROR, bad);
		}
		assert.strictEqual(LABEL_RULE_ERROR, 'Use lowercase letters, digits, `_` and `-`, not starting with `_`');
		assert.strictEqual(labelError('first', new Set(['first']), new Set(['first'])), LABEL_TAKEN_ERROR);
		assert.strictEqual(labelError('used', new Set(['first']), new Set(['used'])), LABEL_IN_SAMPLES_ERROR);
		assert.strictEqual(labelError('free', new Set(['first']), new Set(['used'])), undefined);
	});

	test('SUGGEST: <kind>_<N>, the first N from 1 free among the labels', () => {
		assert.strictEqual(suggestLabel('mutation', new Set()), 'mutation_1');
		assert.strictEqual(suggestLabel('mapping', new Set(['mapping_1', 'mapping_3'])), 'mapping_2');
	});

	test('DOCUMENT_LABELS: every component label at any depth and in every document', () => {
		const labels = documentLabels(parseYaml(`${CONFIG}---\npipeline:\n  processors:\n    - label: second\n      mapping: root = 1\n`));
		assert.deepStrictEqual([...labels].sort(), ['first', 'in', 'second']);
		assert.deepStrictEqual([...documentLabels(undefined)], []);
	});

	test('INSERT: the first key at the key column; the old first key moves to the next line, same column', () => {
		const text = inserted(CONFIG, 'pipeline.processors[1]', 'mutation_1');
		assert.ok(text.includes('    - label: mutation_1\n      mutation: root.b = 1\n'), text);
		assert.strictEqual(processor(text, 'pipeline.processors[1]').label, 'mutation_1');

		const nested = inserted(CONFIG, 'pipeline.processors[2].switch[0].processors[0]', 'deep');
		assert.ok(nested.includes('            - label: deep\n              mapping: |\n                root.c = 2\n'), nested);
		assert.strictEqual(processor(nested, 'pipeline.processors[2].switch[0].processors[0]').source, 'root.c = 2\n');
	});

	test('INSERT: a flow map, CRLF, a name YAML would not read as a string; refused when labelled', () => {
		const flow = inserted(CONFIG, 'pipeline.processors[3]', 'flow');
		assert.ok(flow.includes('    - {label: flow, mapping: "root = 3"}'), flow);

		const crlf = CONFIG.replace(/\n/g, '\r\n');
		assert.ok(inserted(crlf, 'pipeline.processors[1]', 'm').includes('    - label: m\r\n      mutation: root.b = 1\r\n'));

		const numeric = inserted(CONFIG, 'pipeline.processors[1]', '123');
		assert.ok(numeric.includes('    - label: "123"\n'), numeric);
		assert.strictEqual(processor(numeric, 'pipeline.processors[1]').label, '123');

		assert.strictEqual(labelInsertion(CONFIG, processor(CONFIG, 'pipeline.processors[0]'), 'x'), undefined);
	});
});
