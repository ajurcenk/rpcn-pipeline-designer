import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { JsonObject, transformSchema } from '../../core/schema';
import { candidateFields, fieldsAt, validFieldsAt } from '../../core/schemaFields';
import { closestNames, editDistance, hasClearWinner, maxDistance, rankNames } from '../../core/suggest';
import { findKeyOnLine, parseYaml } from '../../core/yamlPath';
import { SCHEMA_FIXTURES } from '../helpers/fakeBinary';

const RAW = JSON.parse(fs.readFileSync(path.join(SCHEMA_FIXTURES, 'jsonschema-4.112.0.json'), 'utf8')) as JsonObject;
const DOCS = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SCHEMA_FIXTURES, 'json-full-4.112.0.json.gz'))).toString('utf8')) as JsonObject;
/** The schema production serves (AD-10 transform with merged docs). */
const SCHEMA = transformSchema(RAW, DOCS);

const find = (text: string, line: number, key: string) => findKeyOnLine(parseYaml(text), line, key);

/** The suggestions for `key` on 1-based `line` of `text`. */
function suggest(text: string, line: number, key: string): string[] | undefined {
	const loc = find(text, line, key);
	const fields = loc && candidateFields(SCHEMA, loc.path, loc.siblings);
	return loc && fields ? closestNames(key, fields, loc.siblings) : undefined;
}

suite('core/suggest', () => {
	test('optimal string alignment distance', () => {
		assert.strictEqual(editDistance('topci', 'topic'), 1);
		assert.strictEqual(editDistance('mappin', 'mapping'), 1);
		assert.strictEqual(editDistance('', 'abc'), 3);
		assert.strictEqual(editDistance('kitten', 'sitting'), 3);
		assert.strictEqual(editDistance('same', 'same'), 0);
	});

	test('limit min(3, max(1, ⌊len/3⌋))', () => {
		assert.deepStrictEqual([1, 2, 5, 6, 8, 9, 12, 30].map(maxDistance), [1, 1, 1, 2, 2, 3, 3, 3]);
	});

	test('the limit edge: a candidate at maxDistance is kept, one beyond is dropped', () => {
		assert.deepStrictEqual(closestNames('abcdef', ['abcxyf', 'abxyzf']), ['abcxyf']); // limit 2: distances 2 and 3
		assert.deepStrictEqual(closestNames('abcd', ['abce', 'abef']), ['abce']); // limit 1: distances 1 and 2
	});

	test('short keys are not replaced wholesale', () => {
		assert.deepStrictEqual(closestNames('id', ['jq', 'git', 'xml']), []);
		assert.deepStrictEqual(closestNames('ss', ['jq', 'sql', 'csv']), []);
		assert.deepStrictEqual(closestNames('bogus', ['log']), []);
	});

	test('at most 3, ties by name, excludes and the word itself', () => {
		assert.deepStrictEqual(closestNames('abc', ['abd', 'abe', 'abc', 'zzz', 'aba', 'abf']), ['aba', 'abd', 'abe']);
		assert.deepStrictEqual(closestNames('lable', ['label', 'table'], ['label']), ['table']);
	});

	test('a clear winner is strictly closer than the second', () => {
		assert.strictEqual(hasClearWinner(rankNames('topci', ['topic', 'topics'])), true);
		assert.strictEqual(hasClearWinner(rankNames('abc', ['abd', 'abe'])), false);
		assert.strictEqual(hasClearWinner(rankNames('topci', ['topic'])), true);
		assert.strictEqual(hasClearWinner([]), false);
	});
});

suite('core/yamlPath findKeyOnLine', () => {
	test('path, range and siblings of a nested key', () => {
		const text = 'input:\n  generate:\n    mapping: root = {}\n    nope: 1\n';
		const loc = find(text, 4, 'nope');
		assert.deepStrictEqual(loc && { path: loc.path, key: text.slice(loc.start, loc.end), siblings: loc.siblings },
			{ path: ['input', 'generate'], key: 'nope', siblings: ['mapping'] });
	});

	test('sequence indexes and quoted keys (quotes are part of the range)', () => {
		const text = "pipeline:\n  processors:\n    - log: {}\n    - \"mappng\": root = this\n    - 'lgo': {}\n";
		const loc = find(text, 4, 'mappng');
		assert.deepStrictEqual(loc?.path, ['pipeline', 'processors', 1]);
		assert.strictEqual(text.slice(loc!.start, loc!.end), '"mappng"');
		const single = find(text, 5, 'lgo')!;
		assert.strictEqual(text.slice(single.start, single.end), "'lgo'");
	});

	test('MULTI_DOC: the same key in another document on another line is not taken', () => {
		const text = 'output:\n  kafka_franz:\n    topci: a\n---\noutput:\n  kafka_franz:\n    topci: b\n';
		const loc = find(text, 7, 'topci')!;
		assert.deepStrictEqual(loc.path, ['output', 'kafka_franz']);
		assert.strictEqual(text.slice(loc.start - 4, loc.end + 3), '    topci: b');
	});

	test('flow mapping keys are found (user: keep flow-key fixes)', () => {
		const text = 'input:\n  generate: {mapping: x, nope: 2}\n';
		assert.deepStrictEqual(find(text, 2, 'nope')?.path, ['input', 'generate']);
	});

	test('NO_MATCH: another line, another key, a line past the end, a value', () => {
		const text = 'input:\n  nope: 1\nlabel: nope\n';
		assert.strictEqual(find(text, 1, 'nope'), undefined);
		assert.strictEqual(find(text, 2, 'other'), undefined);
		assert.strictEqual(find(text, 9, 'nope'), undefined);
		assert.strictEqual(find(text, 3, 'nope'), undefined);
	});

	test('the same key twice on one line is ambiguous: no match', () => {
		assert.strictEqual(find('input: {nope: {nope: 1}}\n', 1, 'nope'), undefined);
	});

	test('a key written differently from its value (0x1) matches its source', () => {
		assert.deepStrictEqual(find('0x1: a\n', 1, '0x1')?.path, []);
		assert.deepStrictEqual(find('1: a\n', 1, '1')?.path, []);
	});

	test('BROKEN_YAML: an error after the key still fixes; at or before it, none', () => {
		assert.strictEqual(suggest('input:\n  generate:\n    mappin: x\noutput:\n  - : : [\n', 3, 'mappin')?.[0], 'mapping');
		assert.strictEqual(find('input:\n  generate:\n\tmappin: 1\n', 3, 'mappin'), undefined, 'tab indent: recovery would give the root');
		assert.strictEqual(find('\t: [{\n', 1, 'x'), undefined);
		assert.strictEqual(findKeyOnLine(undefined, 1, 'x'), undefined);
	});
});

suite('core/schemaFields (4.112.0 schema, transformed)', () => {
	test('the transformed and the raw schema give the same names', () => {
		for (const p of [[], ['input'], ['input', 'generate'], ['pipeline', 'processors', 0], ['output', 'kafka_franz']]) {
			assert.deepStrictEqual(validFieldsAt(SCHEMA, p), validFieldsAt(RAW, p), JSON.stringify(p));
		}
	});

	test('root: the top-level keys, no components', () => {
		const fields = fieldsAt(SCHEMA, [])!;
		for (const k of ['input', 'pipeline', 'output', 'cache_resources', 'logger']) {
			assert.ok(fields.all.includes(k), k);
		}
		assert.deepStrictEqual(fields.components, []);
	});

	test('component mapping: component names plus shared fields, components marked', () => {
		const fields = fieldsAt(SCHEMA, ['input'])!;
		for (const k of ['generate', 'kafka_franz', 'label', 'processors']) {
			assert.ok(fields.all.includes(k), k);
		}
		assert.ok(fields.components.includes('generate') && !fields.components.includes('label'));
	});

	test('inside a component: its own fields', () => {
		assert.deepStrictEqual(validFieldsAt(SCHEMA, ['input', 'generate']),
			['auto_replay_nacks', 'batch_size', 'count', 'interval', 'mapping']);
	});

	test('candidateFields: once a component is present, only shared fields', () => {
		const shared = candidateFields(SCHEMA, ['pipeline', 'processors', 0], ['mapping'])!;
		assert.ok(shared.includes('label') && !shared.includes('log') && !shared.includes('mapping'));
		assert.ok(candidateFields(SCHEMA, ['pipeline', 'processors', 0], [])!.includes('log'));
		assert.ok(candidateFields(SCHEMA, ['pipeline', 'processors', 0], ['label'])!.includes('log'));
	});

	test('NESTED_ARRAY: through processors and branch', () => {
		const fields = validFieldsAt(SCHEMA, ['pipeline', 'processors', 1, 'branch', 'processors', 0])!;
		assert.ok(fields.includes('mapping') && fields.includes('label'));
		assert.deepStrictEqual(validFieldsAt(SCHEMA, ['pipeline', 'processors', 0, 'branch']), ['processors', 'request_map', 'result_map']);
	});

	test('resources: cache_resources items are caches', () => {
		assert.ok(validFieldsAt(SCHEMA, ['cache_resources', 0])!.includes('memory'));
	});

	test('UNKNOWN_PATH: unknown keys, property-less objects and name-keyed maps give undefined', () => {
		assert.strictEqual(validFieldsAt(SCHEMA, ['input', 'not_a_component']), undefined);
		assert.strictEqual(validFieldsAt(SCHEMA, ['input', 'meta']), undefined);
		assert.strictEqual(validFieldsAt(SCHEMA, ['nope', 'deeper']), undefined);
		assert.strictEqual(validFieldsAt(SCHEMA, ['pipeline', 'processors', 0, 'workflow', 'branches', 'a']), undefined, 'known limit');
	});

	test('a $ref cycle is bounded', () => {
		const cyclic = { definitions: { a: { $ref: '#/definitions/a', properties: { x: {} } } }, properties: { r: { $ref: '#/definitions/a' } } };
		assert.deepStrictEqual(validFieldsAt(cyclic, ['r']), ['x']);
	});
});

suite('core quick-fix suggestions end to end (matrix)', () => {
	test('COMPONENT_FIELD: mappin under generate → mapping; nope → none', () => {
		assert.strictEqual(suggest('input:\n  generate:\n    mappin: x\n', 3, 'mappin')?.[0], 'mapping');
		assert.deepStrictEqual(suggest('input:\n  generate:\n    mapping: x\n    nope: 1\n', 4, 'nope'), []);
	});

	test('COMPONENT_LEVEL: mappng as a processor item → mapping first', () => {
		assert.strictEqual(suggest('pipeline:\n  processors:\n    - mappng: root = this\n', 3, 'mappng')?.[0], 'mapping');
	});

	test('AC2: nope under a mapping processor item → no component names (none close enough)', () => {
		assert.deepStrictEqual(suggest('pipeline:\n  processors:\n    - mapping: x\n      nope: 1\n', 4, 'nope'), []);
		assert.deepStrictEqual(suggest('output:\n  stdout: {}\n  fil: x\n', 3, 'fil'), [], 'no second component');
		assert.deepStrictEqual(suggest('input:\n  stdin: {}\n  lable: x\n', 3, 'lable'), ['label']);
	});

	test('OUTPUT_FIELD: topci under output.kafka_franz → topic first', () => {
		assert.strictEqual(suggest('output:\n  kafka_franz:\n    seed_brokers: [x]\n    topci: t\n', 4, 'topci')?.[0], 'topic');
	});

	test('TOP_LEVEL: inptu → input first', () => {
		assert.strictEqual(suggest('inptu:\n  stdin: {}\n', 1, 'inptu')?.[0], 'input');
	});

	test('NESTED_ARRAY end to end: a typo in processors[1].branch.processors[0]', () => {
		const text = 'pipeline:\n  processors:\n    - log: {}\n    - branch:\n        processors:\n          - mappng: root = this\n';
		assert.deepStrictEqual(find(text, 6, 'mappng')?.path, ['pipeline', 'processors', 1, 'branch', 'processors', 0]);
		assert.strictEqual(suggest(text, 6, 'mappng')?.[0], 'mapping');
	});

	test('SIBLINGS: lable next to an existing label does not offer label', () => {
		const result = suggest('input:\n  label: a\n  lable: b\n  stdin: {}\n', 3, 'lable')!;
		assert.ok(!result.includes('label'), result.join(','));
	});

	test('UNKNOWN_PATH: under meta there is no fix', () => {
		assert.strictEqual(suggest('input:\n  meta:\n    foo: 1\n', 3, 'foo'), undefined);
	});
});
