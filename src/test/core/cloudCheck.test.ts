import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { bloblangCalls, documentBloblangCalls } from '../../core/bloblang';
import { componentCatalogue, formatSlot, slotsOf, type ComponentCatalog } from '../../core/catalogue';
import { checkAgainstCluster, clusterComponents, findingMessage, lineOf, versionsDiffer, type ClusterComponents } from '../../core/cloudCheck';
import { componentUses } from '../../core/graph';
import { parseYaml } from '../../core/yamlPath';
import { REPO_ROOT } from '../helpers/fakeBinary';
import { PINNED_VERSIONS, schemaDocs, servedSchema, type PinnedVersion } from '../helpers/schemas';

const LOCAL = componentCatalogue(servedSchema('4.112.0'));

/** The `json-full` lists of `version` under the components answer's names (as the cluster sends them). */
function answerOf(version: PinnedVersion, missing: Readonly<Record<string, readonly string[]>> = {}): unknown {
	const docs = schemaDocs(version) as Record<string, unknown>;
	const keys: Record<string, string> = {
		inputs: 'inputs', outputs: 'outputs', processors: 'processors', caches: 'caches', 'rate-limits': 'rate_limits', buffers: 'buffers',
		metrics: 'metrics', tracers: 'tracers', scanners: 'scanners', 'bloblang-functions': 'bloblang_functions', 'bloblang-methods': 'bloblang_methods',
	};
	const components: Record<string, unknown> = { version: '4.115.0' };
	for (const [from, to] of Object.entries(keys)) {
		const left = new Set(missing[to] ?? []);
		components[to] = (docs[from] as { name: string }[]).filter((e) => !left.has(e.name));
	}
	return { components };
}

const uses = (text: string, catalogue: ComponentCatalog = LOCAL) => componentUses(parseYaml(text), text, catalogue)
	.map((u) => `${lineOf(text, u.offset)}:${u.category}:${u.name}:${text.slice(u.offset, u.offset + u.name.length)}`);

const check = (text: string, cluster: ClusterComponents, catalogue: ComponentCatalog = LOCAL) => {
	const parsed = parseYaml(text);
	return checkAgainstCluster(text, componentUses(parsed, text, catalogue), documentBloblangCalls(parsed, text), cluster, 'rpc-vilnius').map(findingMessage);
};

const NESTED = [
	'input:',
	'  file:',
	'    paths: [a.txt]',
	'    scanner:',
	'      decompress:',
	'        algorithm: gzip',
	'        into:',
	'          lines: {}',
	'  processors:',
	'    - log: {}',
	'buffer:',
	'  memory: {}',
	'pipeline:',
	'  processors:',
	'    - switch:',
	'        - check: this.a == 1',
	'          processors:',
	'            - label: inner',
	'              sleep: { duration: 1s }',
	'output:',
	'  stdout: {}',
	'cache_resources:',
	'  - label: c',
	'    memory: {}',
	'rate_limit_resources:',
	'  - label: r',
	'    local: {}',
	'metrics:',
	'  mapping: root = this',
	'  prometheus: {}',
	'tracer:',
	'  none: {}',
	'',
].join('\n');

// Ticket 8: the pre-deploy check's pure parts.
suite('core/cloudCheck (ticket 8)', () => {
	test('bloblangCalls: functions and methods with their offsets; strings, comments and keywords skipped', () => {
		const source = 'root.a = now()\nroot.b = this.name.uppercase().trim( )\n# foo()\nroot.c = "bar()" + if (this.x) { 1 } else { 2 }\nroot.d = this.list\n  .map_each(x -> x.number())\nlet v = $v.length()';
		assert.deepStrictEqual(bloblangCalls(source).map((c) => `${c.kind}:${c.name}:${source.slice(c.offset, c.offset + c.name.length)}`), [
			'function:now:now', 'method:uppercase:uppercase', 'method:trim:trim', 'method:map_each:map_each', 'method:number:number', 'method:length:length',
		]);
	});

	test('documentBloblangCalls: block, quoted and interpolated Bloblang at document offsets, each once', () => {
		const text = [
			'pipeline:',
			'  processors:',
			'    - mapping: |',
			'        root = this.foo()',
			'    - mutation: "root.x = uuid_v4() + \\"a()\\""',
			'output:',
			'  file:',
			'    path: ${! timestamp_unix() }',
			'',
		].join('\n');
		const calls = documentBloblangCalls(parseYaml(text), text);
		assert.deepStrictEqual(calls.map((c) => `${lineOf(text, c.offset)}:${c.kind}:${text.slice(c.offset, c.offset + c.name.length)}`), [
			'4:method:foo', '5:function:uuid_v4', '8:function:timestamp_unix',
		]);
	});

	test('documentBloblangCalls: a ${! } in a YAML comment, or in a later document, is not a call of the config', () => {
		const text = [
			'output:',
			'  file:',
			'    # path: ${! old_fn() }',
			'    path: ${! timestamp_unix() } # ${! trailing_fn() }',
			'---',
			'input:',
			'  generate:',
			'    mapping: root = later_fn()',
			'',
		].join('\n');
		const calls = documentBloblangCalls(parseYaml(text), text);
		assert.deepStrictEqual(calls.map((c) => `${lineOf(text, c.offset)}:${c.kind}:${text.slice(c.offset, c.offset + c.name.length)}`), [
			'4:function:timestamp_unix',
		]);
	});

	test('componentUses: inputs, processors (nested, an input\'s own), outputs, resources, buffer, metrics, tracer, scanners (nested)', () => {
		assert.deepStrictEqual(uses(NESTED), [
			'2:input:file:file',
			'5:scanner:decompress:decompress',
			'8:scanner:lines:lines',
			'10:processor:log:log',
			'12:buffer:memory:memory',
			'15:processor:switch:switch',
			'19:processor:sleep:sleep',
			'21:output:stdout:stdout',
			'24:cache:memory:memory',
			'27:rate_limit:local:local',
			'30:metrics:prometheus:prometheus',
			'32:tracer:none:none',
		]);
		// A YAML error, or no catalogue: none (the model is empty too).
		assert.deepStrictEqual(componentUses(parseYaml('input: [\n'), 'input: [\n', LOCAL), []);
		assert.deepStrictEqual(componentUses(parseYaml(NESTED), NESTED, undefined), []);
	});

	test('clusterComponents: version, names per category, Bloblang lists; a catalogue with the local slots', () => {
		const cluster = clusterComponents(answerOf('4.112.0'))!;
		assert.strictEqual(cluster.version, '4.115.0');
		assert.ok(cluster.names.get('input')!.has('stdin'));
		assert.ok(cluster.names.get('rate_limit')!.has('local'));
		assert.ok(cluster.functions!.has('now') && cluster.methods!.has('uppercase'));
		const slot = (c: ComponentCatalog, cat: string, name: string) => slotsOf(c, cat, name).map((s) => `${formatSlot(s)} (${s.kind}) -> ${s.category}`).sort();
		for (const [cat, name] of [['processor', 'switch'], ['output', 'switch'], ['output', 'broker'], ['processor', 'workflow'], ['processor', 'try'], ['output', 'reject_errored'], ['processor', 'branch']]) {
			assert.deepStrictEqual(slot(cluster.catalogue, cat, name), slot(LOCAL, cat, name), `${cat} ${name}`);
		}
		// The cluster's catalogue finds the same uses (no local schema: no binary).
		assert.deepStrictEqual(uses(NESTED, cluster.catalogue), uses(NESTED));
		assert.strictEqual(clusterComponents({}), undefined);
		assert.strictEqual(clusterComponents('nope'), undefined);
		const partial = clusterComponents({ components: { version: '4.1.0', inputs: [{ name: 'kafka' }, { nope: 1 }] } })!;
		assert.deepStrictEqual([...partial.names.keys()], ['input']);
		assert.strictEqual(partial.functions, undefined);
	});

	test('MISSING: a component (nested in a switch case, a resource, a scanner) and functions and methods the cluster lacks, by line', () => {
		const cluster = clusterComponents(answerOf('4.112.0', {
			inputs: ['file'], processors: ['sleep'], caches: ['memory'], scanners: ['lines'], bloblang_functions: ['uuid_v4'], bloblang_methods: ['uppercase'],
		}))!;
		const text = `${NESTED}# appended\n`.replace('  mapping: root = this', '  mapping: root = this.uppercase() + uuid_v4()');
		assert.deepStrictEqual(check(text, cluster), [
			'line 2: input `file` is not available on rpc-vilnius (Redpanda Connect 4.115.0)',
			'line 8: scanner `lines` is not available on rpc-vilnius (Redpanda Connect 4.115.0)',
			'line 19: processor `sleep` is not available on rpc-vilnius (Redpanda Connect 4.115.0)',
			'line 24: cache `memory` is not available on rpc-vilnius (Redpanda Connect 4.115.0)',
			'line 29: Bloblang method `.uppercase()` is not available on rpc-vilnius',
			'line 29: Bloblang function `uuid_v4()` is not available on rpc-vilnius',
		]);
		// Ranges cover the name.
		const parsed = parseYaml(NESTED);
		const [first] = checkAgainstCluster(NESTED, componentUses(parsed, NESTED, LOCAL), [], cluster, 'rpc-vilnius');
		assert.strictEqual(NESTED.slice(first.start, first.end), 'file');
		// No version: none named; a category the answer has no list for is not checked.
		const bare = clusterComponents({ components: { inputs: [{ name: 'kafka' }] } })!;
		assert.deepStrictEqual(check('input:\n  stdin: {}\noutput:\n  nope: {}\n', bare), ['line 2: input `stdin` is not available on rpc-vilnius']);
	});

	test('CORPUS: every corpus config against a list built from the local schema: no finding', () => {
		const dir = path.join(REPO_ROOT, 'test', 'corpus');
		const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
		assert.ok(files.length > 10);
		for (const version of PINNED_VERSIONS) {
			const local = componentCatalogue(servedSchema(version));
			const docs = schemaDocs(version) as Record<string, { name: string }[]>;
			const fromSchema: ClusterComponents = {
				version,
				names: new Map([...local.categories].map(([category, c]) => [category, c.names])),
				functions: new Set(docs['bloblang-functions'].map((e) => e.name)),
				methods: new Set(docs['bloblang-methods'].map((e) => e.name)),
				catalogue: local,
			};
			for (const file of files) {
				const text = fs.readFileSync(path.join(dir, file), 'utf8');
				assert.deepStrictEqual(check(text, fromSchema, local), [], `${file} on ${version}`);
			}
		}
	});

	test('versionsDiffer: both known and different; v-prefix ignored', () => {
		assert.strictEqual(versionsDiffer('4.115.0', '4.120.0'), true);
		assert.strictEqual(versionsDiffer('4.115.0', 'v4.115.0'), false);
		assert.strictEqual(versionsDiffer(undefined, '4.120.0'), false);
		assert.strictEqual(versionsDiffer('4.115.0', undefined), false);
	});
});
