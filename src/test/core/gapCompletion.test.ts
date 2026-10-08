import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { gapContext, gapItems } from '../../core/gapCompletion';
import { JsonObject, transformSchema } from '../../core/schema';
import { insideComponent } from '../../core/schemaFields';
import { parseYaml } from '../../core/yamlPath';
import { SCHEMA_FIXTURES } from '../helpers/fakeBinary';

const SCHEMA = transformSchema(
	JSON.parse(fs.readFileSync(path.join(SCHEMA_FIXTURES, 'jsonschema-4.112.0.json'), 'utf8')) as JsonObject,
	JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SCHEMA_FIXTURES, 'json-full-4.112.0.json.gz'))).toString('utf8')) as JsonObject,
);

/** The gap items at the `|` marker in `text` (the marker is removed). */
function at(marked: string) {
	const offset = marked.indexOf('|');
	const text = marked.replace('|', '');
	const context = gapContext(parseYaml(text), text, offset);
	return { context, items: context ? gapItems(SCHEMA, context) : [] };
}
const labels = (marked: string) => at(marked).items.map((i) => i.label);

suite('core/gapCompletion (ticket 2.16, 4.112.0 schema)', () => {
	test('EMPTY_COMPONENT: an empty socket block offers its 8 fields with docs', () => {
		const { context, items } = at('input:\n  socket:\n    |\noutput:\n  stdout: {}\n');
		assert.deepStrictEqual(context, { kind: 'block', path: ['input', 'socket'] });
		assert.deepStrictEqual(items.map((i) => i.label),
			['address', 'auto_replay_nacks', 'codec', 'max_buffer', 'network', 'open_message_mapping', 'scanner', 'tls']);
		assert.ok(items.every((i) => i.kind === 'field'));
		assert.ok(items.find((i) => i.label === 'network')!.documentation!.includes('Options: `unix`, `tcp`'));
	});

	test('a blank line holding only spaces, or with comment lines between, still counts as empty', () => {
		assert.strictEqual(labels('input:\n  socket:\n    # comment\n\n    |\n').length, 8);
	});

	test('NESTED_EMPTY / PROCESSOR_ITEM / resource item / broker output item', () => {
		assert.ok(labels('input:\n  socket:\n    network: tcp\n    tls:\n      |\n').includes('skip_cert_verify'));
		assert.deepStrictEqual(labels('pipeline:\n  processors:\n    - branch:\n        |\n'), ['processors', 'request_map', 'result_map']);
		assert.ok(labels('cache_resources:\n  - label: c\n    memory:\n      |\n').includes('default_ttl'));
		assert.deepStrictEqual(labels('output:\n  broker:\n    outputs:\n      - stdout:\n          |\n'), ['codec']);
	});

	test('PARTIAL_KEY: a partly typed first key gives the block\'s fields (VS Code filters)', () => {
		assert.strictEqual(labels('input:\n  socket:\n    ad|\n').length, 8);
	});

	test('EMPTY_VALUE / BOOLEAN_VALUE inside a component', () => {
		const { context, items } = at('input:\n  socket_server:\n    network: |\n');
		assert.deepStrictEqual(context, { kind: 'value', path: ['input', 'socket_server'], key: 'network' });
		assert.deepStrictEqual(items.map((i) => [i.label, i.kind]), [['unix', 'value'], ['tcp', 'value'], ['udp', 'value'], ['tls', 'value'], ['unixgram', 'value']]);
		assert.deepStrictEqual(labels('input:\n  socket:\n    auto_replay_nacks: |\n'), ['true', 'false']);
		const codec = at('output:\n  file:\n    path: x\n    codec: |\n').items;
		assert.ok(codec.find((i) => i.label === 'all-bytes')!.documentation!.startsWith('Only applicable to file based outputs.'));
	});

	test('an option YAML would misread is inserted quoted (client_auth: no)', () => {
		const items = at('input:\n  socket_server:\n    network: tcp\n    tls:\n      client_auth: |\n').items;
		assert.deepStrictEqual(items.find((i) => i.label === 'no')?.snippet, '"no"');
		assert.deepStrictEqual(items.find((i) => i.label === 'request')?.snippet, 'request');
	});

	test('SNIPPETS / DEFAULT', () => {
		const items = at('input:\n  socket:\n    |\n').items;
		const snippet = (name: string) => items.find((i) => i.label === name)!.snippet;
		assert.strictEqual(snippet('address'), 'address: $0');
		assert.strictEqual(snippet('tls'), 'tls:\n  $0');
		assert.strictEqual(snippet('max_buffer'), 'max_buffer: ${1:1000000}');
		assert.strictEqual(snippet('auto_replay_nacks'), 'auto_replay_nacks: ${1:true}');
		const tls = at('input:\n  socket:\n    network: tcp\n    tls:\n      |\n').items;
		assert.strictEqual(tls.find((i) => i.label === 'client_certs')!.snippet, 'client_certs:\n  - $0');
		assert.strictEqual(tls.find((i) => i.label === 'root_cas')!.snippet, 'root_cas: $0', 'an empty default gets no placeholder');
	});

	test('SILENT: every position where Red Hat completes gives nothing', () => {
		const silent = [
			'input:\n  stdin: {}\nlogger:\n  |\n', // empty top-level block
			'input:\n  |\n', // component level, top
			'pipeline:\n  processors:\n    - |\n', // empty list item
			'input:\n  socket:\n    network: tcp\n    |\n', // block that already has a field
			'input:\n  socket:\n    network: tcp\n    tls:\n      enabled: true\n      |\n',
			'input:\n  stdin: {}\nlogger:\n  level: |\n', // value outside components
			'input:\n  stdin: {}\nlogger:\n  format: |\n',
			'input:\n  stdin: {}\nlogger:\n  file:\n    |\n', // plain nested block (Red Hat completes it; review sweep)
			'input:\n  stdin: {}\nhttp:\n  cors:\n    |\n',
			'input:\n  stdin: {}\nhttp:\n  basic_auth:\n    |\n',
			'input:\n  stdin: {}\nlogger:\n  file:\n    pa|\n', // partial key outside components
		];
		for (const marked of silent) {
			assert.deepStrictEqual(at(marked).items, [], JSON.stringify(marked));
		}
	});

	test('other non-gaps: after text, a key with a value, a component-level nested block, a scalar value', () => {
		assert.deepStrictEqual(labels('input:\n  socket:\n    |x\n'), []);
		assert.deepStrictEqual(labels('input:\n  socket:\n    network: t|\n'), []);
		assert.deepStrictEqual(labels('input:\n  socket:\n    network: tcp|\n'), []);
		assert.deepStrictEqual(labels('input:\n  socket:\n    scanner:\n      |\n'), [], 'scanner holds a component: Red Hat\'s list');
		assert.deepStrictEqual(labels('input:\n  socket: x\n    |\n'), []);
	});

	test('a tab in the indentation gives nothing (inserted keys would be invalid YAML)', () => {
		assert.deepStrictEqual(labels('input:\n  socket:\n    \t|\n'), []);
		assert.deepStrictEqual(labels('input:\n  socket:\n\t|\n'), []);
	});

	test('deprecated fields are marked', () => {
		const items = at('input:\n  kafka_franz:\n    |\n').items;
		assert.strictEqual(items.find((i) => i.label === 'regexp_topics')?.deprecated, true);
		assert.strictEqual(items.find((i) => i.label === 'topics')?.deprecated, false);
	});

	test('BROKEN: unparseable text gives nothing, never a throw', () => {
		assert.doesNotThrow(() => at('\t: [{\n  |\n'));
		assert.strictEqual(gapContext(undefined, 'x', 0), undefined);
	});

	test('insideComponent', () => {
		assert.strictEqual(insideComponent(SCHEMA, ['input', 'socket']), true);
		assert.strictEqual(insideComponent(SCHEMA, ['input', 'socket', 'tls']), true);
		assert.strictEqual(insideComponent(SCHEMA, ['logger']), false);
		assert.strictEqual(insideComponent(SCHEMA, ['pipeline', 'processors', 0, 'branch']), true);
	});
});
