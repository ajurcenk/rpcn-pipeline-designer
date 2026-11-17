import * as assert from 'assert';
import { parse } from 'yaml';
import { mergeResources, type MergedResources, resourceBlockLines } from '../../core/cloudResources';

const merged = (m: MergedResources) => {
	assert.strictEqual(m.kind, 'merged', m.kind === 'refused' ? m.problems.map((p) => p.message).join('\n') : '');
	return (m as Extract<MergedResources, { kind: 'merged' }>).text;
};
const refused = (m: MergedResources) => {
	assert.strictEqual(m.kind, 'refused');
	return (m as Extract<MergedResources, { kind: 'refused' }>).problems.map((p) => p.message);
};

const CONFIG = [
	'# orders',
	'input:',
	'  generate:',
	'    mapping: \'root = "x"\'',
	'pipeline:',
	'  processors:',
	'    - resource: enrich # from res.yaml',
	'output:',
	'  cache:',
	'    target: store',
	'    key: ${! uuid_v4() }',
	'',
].join('\n');

const RES = [
	'# shared resources',
	'cache_resources:',
	'  - label: store',
	'    memory: {}',
	'processor_resources:',
	'  # the enrichment',
	'  - label: enrich',
	'    mapping: |',
	'      root = this',
	'      root.token = "${TOKEN}"',
	'',
].join('\n');

// Story 42: the config and the resources of its resource files, as the one config Redpanda Cloud is sent.
suite('core/cloudResources', () => {
	test('NONE: no resource files: the config text itself, byte for byte (even one that does not parse)', () => {
		assert.strictEqual(merged(mergeResources(CONFIG, [])), CONFIG);
		assert.strictEqual(merged(mergeResources('a: [\n', [])), 'a: [\n');
	});

	test('MERGED: the config\'s bytes kept, each file block appended after a blank line, its comments too', () => {
		const text = merged(mergeResources(CONFIG, [{ path: 'res.yaml', text: RES }], 'orders.yaml'));
		assert.ok(text.startsWith(CONFIG), 'the config first, as written');
		assert.strictEqual(text, `${CONFIG}\ncache_resources:\n  - label: store\n    memory: {}\n\nprocessor_resources:\n  # the enrichment\n  - label: enrich\n    mapping: |\n      root = this\n      root.token = "\${TOKEN}"\n`);
		const value = parse(text) as Record<string, { label: string }[]>;
		assert.deepStrictEqual(value.cache_resources.map((r) => r.label), ['store']);
		assert.deepStrictEqual(value.processor_resources.map((r) => r.label), ['enrich']);
	});

	test('MERGED: a config without a final line break, and a file without one', () => {
		const text = merged(mergeResources('input:\n  stdin: {}', [{ path: 'r.yaml', text: 'cache_resources:\n  - label: a\n    memory: {}' }]));
		assert.strictEqual(text, 'input:\n  stdin: {}\n\ncache_resources:\n  - label: a\n    memory: {}\n');
	});

	test('JOINED: the file\'s items join the config\'s own block list, re-indented to it, before its trailing comment', () => {
		const config = 'input:\n  stdin: {}\ncache_resources:\n- label: mine # kept\n  memory: {}\n# after\noutput:\n  drop: {}\n';
		const file = 'cache_resources:\n    - label: theirs\n      redis:\n        url: ${REDIS}\n';
		const text = merged(mergeResources(config, [{ path: 'res.yaml', text: file }]));
		assert.strictEqual(text, 'input:\n  stdin: {}\ncache_resources:\n- label: mine # kept\n  memory: {}\n- label: theirs\n  redis:\n    url: ${REDIS}\n# after\noutput:\n  drop: {}\n');
		const value = parse(text) as Record<string, { label: string }[]>;
		assert.deepStrictEqual(value.cache_resources.map((r) => r.label), ['mine', 'theirs']);
	});

	test('JOINED: two files of one kind (none in the config): the second joins the first\'s appended block', () => {
		const text = merged(mergeResources('input:\n  stdin: {}\n', [
			{ path: 'a.yaml', text: 'cache_resources:\n  - label: a\n    memory: {}\n' },
			{ path: 'b.yaml', text: 'cache_resources:\n- label: b\n  memory: {}\nrate_limit_resources:\n  - label: r\n    local: {}\n' },
		]));
		const value = parse(text) as Record<string, { label: string }[]>;
		assert.deepStrictEqual(value.cache_resources.map((r) => r.label), ['a', 'b']);
		assert.deepStrictEqual(value.rate_limit_resources.map((r) => r.label), ['r']);
	});

	test('JOINED refused: a flow list in the config or in a file, a value that is not a list; the key and the file named', () => {
		const file = { path: 'res.yaml', text: 'cache_resources:\n  - label: b\n    memory: {}\n' };
		assert.deepStrictEqual(refused(mergeResources('cache_resources: [{label: a, memory: {}}]\n', [file], 'orders.yaml')), [
			'cache_resources in orders.yaml is a flow list ([…]), so the cache resources of res.yaml can\'t be added to it; write it as a block list (- …)',
		]);
		assert.deepStrictEqual(refused(mergeResources('cache_resources:\n  - label: a\n    memory: {}\n', [{ path: 'res.yaml', text: 'cache_resources: [{label: b, memory: {}}]\n' }], 'orders.yaml')), [
			'cache_resources in res.yaml is a flow list ([…]), so its cache resources can\'t be added to the list in orders.yaml; write it as a block list (- …)',
		]);
		assert.deepStrictEqual(refused(mergeResources('cache_resources: nope\n', [file], 'orders.yaml')), [
			'cache_resources in orders.yaml is not a list, so the cache resources of res.yaml can\'t be added to it; write it as a block list (- …)',
		]);
		assert.deepStrictEqual(refused(mergeResources('input: {}\n', [{ path: 'res.yaml', text: 'cache_resources:\n  label: a\n' }], 'orders.yaml')), [
			'cache_resources in res.yaml is not a list',
		]);
	});

	test('JOINED: a flow list in a file is appended as written when the config has no list of that kind', () => {
		const text = merged(mergeResources('input: {}\n', [{ path: 'res.yaml', text: 'cache_resources: [{label: b, memory: {}}]\n' }]));
		assert.strictEqual(text, 'input: {}\n\ncache_resources: [{label: b, memory: {}}]\n');
	});

	test('DUP_LABEL: a label in the config and a file, in two files, twice in one file: refused with both places', () => {
		const config = 'cache_resources:\n  - label: store\n    memory: {}\n';
		assert.deepStrictEqual(refused(mergeResources(config, [{ path: 'res.yaml', text: '# c\ncache_resources:\n  - label: store\n    memory: {}\n' }], 'orders.yaml')), [
			'the cache resource "store" is defined in orders.yaml (line 2) and in res.yaml (line 3)',
		]);
		assert.deepStrictEqual(refused(mergeResources('input: {}\n', [
			{ path: 'a.yaml', text: 'processor_resources:\n  - label: p\n    noop: {}\n' },
			{ path: 'b.yaml', text: 'processor_resources:\n  - label: p\n    noop: {}\n' },
		])), ['the processor resource "p" is defined in a.yaml (line 2) and in b.yaml (line 2)']);
		assert.deepStrictEqual(refused(mergeResources('input: {}\n', [
			{ path: 'a.yaml', text: 'rate_limit_resources:\n  - label: r\n    local: {}\n  - label: r\n    local: {}\n' },
		])), ['the rate limit resource "r" is defined in a.yaml (line 2) and in a.yaml (line 4)']);
	});

	test('DUP_LABEL: one label in two kinds is not a duplicate', () => {
		const text = merged(mergeResources('cache_resources:\n  - label: x\n    memory: {}\n', [{ path: 'r.yaml', text: 'processor_resources:\n  - label: x\n    noop: {}\n' }]));
		assert.ok(text.includes('processor_resources:'));
	});

	test('UNREADABLE: not valid YAML, more than one document, not a map: the file named and why', () => {
		const config = 'input: {}\n';
		assert.match(refused(mergeResources(config, [{ path: 'res.yaml', text: 'cache_resources:\n  - [\n' }]))[0], /^res\.yaml is not valid YAML \(line \d+: /);
		assert.deepStrictEqual(refused(mergeResources(config, [{ path: 'res.yaml', text: 'cache_resources: []\n---\nrate_limit_resources: []\n' }])), [
			'res.yaml holds more than one YAML document',
		]);
		assert.deepStrictEqual(refused(mergeResources(config, [{ path: 'res.yaml', text: '- a\n- b\n' }])), ['res.yaml is not a YAML map']);
		assert.deepStrictEqual(refused(mergeResources('- a\n', [{ path: 'res.yaml', text: 'cache_resources: []\n' }], 'orders.yaml')), ['orders.yaml is not a YAML map']);
	});

	test('an empty resource file, or one with comments only, or other keys only, adds nothing', () => {
		const config = 'input: {}\n';
		assert.strictEqual(merged(mergeResources(config, [{ path: 'a.yaml', text: '' }, { path: 'b.yaml', text: '# nothing\n' }, { path: 'c.yaml', text: 'cache_resources:\nlogger:\n  level: INFO\n' }])), config);
	});

	test('CHANGED: a keep-chomped block scalar at the config\'s end, an anchor capturing a config alias: refused naming the file', () => {
		const file = { path: 'res.yaml', text: 'cache_resources:\n  - label: b\n    memory: &x {}\n' };
		assert.deepStrictEqual(refused(mergeResources('input:\n  generate:\n    mapping: |+\n      root = 1\n', [file], 'orders.yaml')), [
			'res.yaml\'s resources could not be added to orders.yaml without changing it: input would read differently',
		]);
		const config = 'input: &x\n  stdin: {}\ncache_resources:\n  - label: a\n    memory: {}\noutput:\n  foo: *x\n';
		assert.deepStrictEqual(refused(mergeResources(config, [file], 'orders.yaml')), [
			'res.yaml\'s resources could not be added to orders.yaml without changing it: output would read differently',
		]);
	});

	test('CHANGED: a file alias without its anchor in that file is refused naming the file, not bound to the config\'s anchor', () => {
		const problems = refused(mergeResources('input: &x\n  stdin: {}\n', [{ path: 'res.yaml', text: 'cache_resources:\n  - label: b\n    memory: *x\n' }], 'orders.yaml'));
		assert.strictEqual(problems.length, 1);
		assert.match(problems[0], /^res\.yaml (could not be read|is not valid YAML)/);
	});

	test('a whitespace-only line in a joined block scalar is re-indented with it; a leading BOM is not copied', () => {
		const config = 'cache_resources:\n- label: a\n  memory: {}\n';
		const file = '﻿cache_resources:\n    - label: b\n      redis:\n        url: |\n          x\n            \n          y\n';
		const text = merged(mergeResources(config, [{ path: 'res.yaml', text: file }]));
		assert.ok(!text.includes('﻿'));
		const value = parse(text) as { cache_resources: { label: string; redis?: { url: string } }[] };
		assert.strictEqual(value.cache_resources[1].redis!.url, 'x\n  \ny\n');
		assert.strictEqual(merged(mergeResources('input: {}\n', [{ path: 'r.yaml', text: '﻿cache_resources:\n  - label: c\n    memory: {}\n' }])),
			'input: {}\n\ncache_resources:\n  - label: c\n    memory: {}\n');
	});

	test('NO_VALUE: a config key with no value, ~ or [] gets the file\'s items as its value', () => {
		const file = { path: 'res.yaml', text: 'cache_resources:\n    - label: b\n      memory: {}\n' };
		for (const config of ['cache_resources:\ninput: {}\n', 'cache_resources: ~ # none\ninput: {}\n', 'cache_resources: []\ninput: {}\n', 'input: {}\ncache_resources:']) {
			const text = merged(mergeResources(config, [file]));
			const value = parse(text) as { cache_resources: { label: string }[]; input: unknown };
			assert.deepStrictEqual(value.cache_resources.map((c) => c.label), ['b'], text);
			assert.deepStrictEqual(value.input, {}, text);
		}
		assert.strictEqual(merged(mergeResources('cache_resources:\ninput: {}\n', [file])), 'cache_resources:\n  - label: b\n    memory: {}\ninput: {}\n');
		assert.strictEqual(merged(mergeResources('input: {}\n', [{ path: 'r.yaml', text: 'cache_resources: []\n' }])), 'input: {}\n', 'an empty list in a file adds nothing');
	});

	test('DOCUMENT_END: a config ending in a ... line gets the blocks before it', () => {
		const text = merged(mergeResources('input: {}\n...\n# end\n', [{ path: 'r.yaml', text: 'cache_resources:\n  - label: c\n    memory: {}\n' }]));
		assert.strictEqual(text, 'input: {}\n\ncache_resources:\n  - label: c\n    memory: {}\n...\n# end\n');
	});

	test('CRLF: the added text is written with the config\'s line ending', () => {
		const config = 'input: {}\r\ncache_resources:\r\n  - label: a\r\n    memory: {}\r\n';
		const text = merged(mergeResources(config, [{ path: 'r.yaml', text: 'cache_resources:\n  - label: b\n    memory: {}\nrate_limit_resources:\n  - label: r\n    local: {}\n' }]));
		assert.ok(text.startsWith(config.slice(0, -2)));
		assert.ok(!/[^\r]\n/.test(text), JSON.stringify(text));
		assert.deepStrictEqual((parse(text) as { cache_resources: { label: string }[] }).cache_resources.map((c) => c.label), ['a', 'b']);
	});

	test('NO_LABEL: a resource without a label, or not a map, is refused naming the file, the kind and its line', () => {
		assert.deepStrictEqual(refused(mergeResources('input: {}\n', [{ path: 'res.yaml', text: 'cache_resources:\n  - memory: {}\n  - just\n' }])), [
			'res.yaml: the cache resource at line 2 has no label',
			'res.yaml: the cache resource at line 3 is not a map',
		]);
	});

	test('resourceBlockLines: each *_resources block\'s lines, from its key to its value\'s end; none for invalid YAML', () => {
		assert.deepStrictEqual(resourceBlockLines('logger:\n  level: ${bad}\ncache_resources:\n  - label: a\n    memory: {}\ntests: []\n'), [{ start: 3, end: 5 }]);
		assert.strictEqual(resourceBlockLines('a: [\n'), undefined);
	});
});

