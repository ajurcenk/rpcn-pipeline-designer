import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import {
	DRAFT_07, fieldMarkdown, INTERPOLATION_PATTERN, isJsonObject, JsonObject, JsonValue, parseCachedSchema, parseDocs,
	parseRawSchema, SCHEMA_FILE_PATTERN, schemaFileName, schemaHash, toYamlList, transformSchema, TRANSFORM_VERSION,
} from '../../core/schema';
import { SCHEMA_FIXTURES } from '../helpers/fakeBinary';

const VERSIONS = ['4.100.0', '4.112.0'];

const loadRaw = (v: string) => JSON.parse(fs.readFileSync(path.join(SCHEMA_FIXTURES, `jsonschema-${v}.json`), 'utf8')) as JsonObject;
const loadDocs = (v: string) => JSON.parse(
	zlib.gunzipSync(fs.readFileSync(path.join(SCHEMA_FIXTURES, `json-full-${v}.json.gz`))).toString('utf8'),
) as JsonObject;

/** Every schema node reachable through schema keywords, with its JSON path. */
function* nodes(node: JsonValue, at = '#'): Generator<[string, JsonObject]> {
	if (!isJsonObject(node)) {
		return;
	}
	yield [at, node];
	for (const key of ['properties', 'patternProperties', 'definitions']) {
		const map = node[key];
		if (isJsonObject(map)) {
			for (const [name, child] of Object.entries(map)) {
				yield* nodes(child, `${at}/${key}/${name}`);
			}
		}
	}
	for (const key of ['items', 'additionalProperties']) {
		yield* nodes(node[key], `${at}/${key}`);
	}
	for (const key of ['allOf', 'anyOf', 'oneOf']) {
		const list = node[key];
		if (Array.isArray(list)) {
			for (let i = 0; i < list.length; i++) {
				yield* nodes(list[i], `${at}/${key}/${i}`);
			}
		}
	}
}

function component(schema: JsonObject, category: string, name: string): JsonObject {
	const cat = (schema.definitions as JsonObject)[category] as JsonObject;
	const anyOf = ((cat.allOf as JsonValue[])[0] as JsonObject).anyOf as JsonObject[];
	const option = anyOf.find((o) => isJsonObject(o.properties) && name in o.properties);
	assert.ok(option, `${category}.${name} not found`);
	return (option.properties as JsonObject)[name] as JsonObject;
}

const props = (node: JsonObject) => node.properties as JsonObject;

suite('core/schema transformSchema (TRANSFORM_V)', () => {
	for (const version of VERSIONS) {
		suite(version, () => {
			let raw: JsonObject;
			let docs: JsonObject;
			let out: JsonObject;
			let rawText: string;

			suiteSetup(() => {
				raw = loadRaw(version);
				rawText = JSON.stringify(raw);
				docs = loadDocs(version);
				out = transformSchema(raw, docs);
			});

			test('adds $schema draft-07 as the first key', () => {
				assert.strictEqual(out.$schema, DRAFT_07);
				assert.strictEqual(Object.keys(out)[0], '$schema');
				assert.ok(isJsonObject(out.definitions) && isJsonObject(out.properties));
			});

			test('every number / integer / boolean node also accepts a ${VAR} string', () => {
				let rewritten = 0;
				const typedBranches = new Set<string>();
				for (const [at, node] of nodes(out)) {
					if (Array.isArray(node.anyOf) && isJsonObject(node.anyOf[1]) && node.anyOf[1].pattern === INTERPOLATION_PATTERN) {
						typedBranches.add(`${at}/anyOf/0`);
					}
				}
				for (const [at, node] of nodes(out)) {
					if (!typedBranches.has(at)) {
						assert.ok(!['number', 'integer', 'boolean'].includes(node.type as string), `${at} still has a bare type ${node.type}`);
					}
					if (Array.isArray(node.anyOf) && node.anyOf.length === 2 && isJsonObject(node.anyOf[1])
						&& node.anyOf[1].pattern === INTERPOLATION_PATTERN) {
						assert.strictEqual(node.anyOf[1].type, 'string', at);
						assert.ok(['number', 'integer', 'boolean'].includes((node.anyOf[0] as JsonObject).type as string), at);
						rewritten++;
					}
				}
				let expected = 0;
				for (const [, node] of nodes(raw)) {
					if (['number', 'integer', 'boolean'].includes(node.type as string)) {
						expected++;
					}
				}
				assert.ok(expected > 1000, `expected many numeric/boolean fields, got ${expected}`);
				assert.strictEqual(rewritten, expected);
			});

			test('the interpolation pattern accepts ${VAR} forms only', () => {
				const re = new RegExp(INTERPOLATION_PATTERN);
				for (const ok of ['${PORT}', '${PORT:4195}', '${A_B}']) {
					assert.ok(re.test(ok), ok);
				}
				for (const bad of ['4195', '${}', 'x${PORT}', '${PORT}x', '$PORT']) {
					assert.ok(!re.test(bad), bad);
				}
			});

			test('keeps the custom is_* keys', () => {
				const http = props(out).http as JsonObject;
				assert.strictEqual(http.is_advanced, false);
				const enabled = props(http).enabled as JsonObject;
				for (const key of ['is_advanced', 'is_deprecated', 'is_optional', 'is_secret']) {
					assert.strictEqual(typeof enabled[key], 'boolean', key);
				}
				let withIs = 0;
				for (const [, node] of nodes(out)) {
					if ('is_advanced' in node) {
						withIs++;
					}
				}
				let rawWithIs = 0;
				for (const [, node] of nodes(raw)) {
					if ('is_advanced' in node) {
						rawWithIs++;
					}
				}
				assert.strictEqual(withIs, rawWithIs);
			});

			test('keeps every $ref', () => {
				const count = (text: string) => (text.match(/"\$ref":"#\/definitions\/[a-z_]+"/g) ?? []).length;
				assert.strictEqual(count(JSON.stringify(out)), count(rawText));
				assert.strictEqual(count(rawText), 118);
			});

			test('is pure and deterministic', () => {
				assert.strictEqual(JSON.stringify(raw), rawText, 'raw was modified');
				const again = transformSchema(loadRaw(version), loadDocs(version));
				assert.strictEqual(JSON.stringify(again), JSON.stringify(out));
				assert.strictEqual(JSON.stringify(transformSchema(raw)), JSON.stringify(transformSchema(raw)));
			});

			test('DOC_MERGE: kafka_franz.seed_brokers has its description and examples', () => {
				const seed = props(component(out, 'input', 'kafka_franz')).seed_brokers as JsonObject;
				const md = seed.markdownDescription as string;
				assert.ok(md.startsWith('A list of broker addresses to connect to'), md);
				assert.ok(md.includes('```yaml\n- - localhost:9092\n- - foo:9092\n  - bar:9092\n- - "foo:9092,bar:9092"\n```'), md);
			});

			test('DOC_MERGE: defaults land on fields, summaries on components', () => {
				const franz = component(out, 'input', 'kafka_franz');
				assert.ok((franz.markdownDescription as string).startsWith('A Kafka input using'), String(franz.markdownDescription));
				assert.strictEqual((props(franz).client_id as JsonObject).default, 'redpanda-connect');
				// Nested object children.
				const tls = props(franz).tls as JsonObject;
				assert.strictEqual((props(tls).enabled as JsonObject).default, false);
				// Top-level config fields.
				const http = props(out).http as JsonObject;
				assert.strictEqual(http.markdownDescription, 'Configures the service-wide HTTP server.');
				assert.strictEqual((props(http).address as JsonObject).default, '0.0.0.0:4195');
				assert.strictEqual((props(props(out).pipeline as JsonObject).threads as JsonObject).default, -1);
				// A component whose config is an array of objects (processor switch).
				const cases = component(out, 'processor', 'switch');
				const check = props(cases.items as JsonObject).check as JsonObject;
				assert.ok((check.markdownDescription as string).includes('- "this.type == \\"foo\\""'), String(check.markdownDescription));
				assert.strictEqual(check.default, '');
				// Docs on a numeric field sit on the outer node next to the anyOf.
				const threads = props(props(out).pipeline as JsonObject).threads as JsonObject;
				assert.ok(Array.isArray(threads.anyOf));
				assert.ok(typeof threads.markdownDescription === 'string');
			});

			test('DOC_MERGE: most component nodes carry a summary', () => {
				let total = 0;
				let withSummary = 0;
				for (const category of ['input', 'output', 'processor', 'cache']) {
					const cat = (out.definitions as JsonObject)[category] as JsonObject;
					for (const option of ((cat.allOf as JsonValue[])[0] as JsonObject).anyOf as JsonObject[]) {
						for (const node of Object.values(option.properties as JsonObject)) {
							total++;
							if (typeof (node as JsonObject).markdownDescription === 'string') {
								withSummary++;
							}
						}
					}
				}
				assert.ok(withSummary / total > 0.95, `${withSummary}/${total}`);
			});
		});
	}

	test('missing docs are tolerated: no docs, empty docs, unknown components and fields', () => {
		const raw = loadRaw('4.112.0');
		const bare = transformSchema(raw);
		assert.ok(!JSON.stringify(bare).includes('markdownDescription'));
		assert.strictEqual(JSON.stringify(transformSchema(raw, {})), JSON.stringify(bare));
		const odd: JsonObject = {
			config: [{ name: 'nope', description: 'x' }, 'junk', { description: 'no name' }],
			inputs: [{ name: 'not_a_component', summary: 's' }, { name: 'kafka_franz', config: { children: [{ name: 'nope' }] } }],
			outputs: 'not a list',
		};
		const out = transformSchema(raw, odd);
		assert.ok(!('markdownDescription' in component(out, 'input', 'kafka_franz')));
		assert.ok(!JSON.stringify(out).includes('not_a_component'));
	});

	test('a synthetic schema: rewrite keeps enum/minimum inside the typed branch', () => {
		const raw: JsonObject = {
			$schema: 'old',
			properties: { n: { type: 'integer', minimum: 0, is_advanced: true }, s: { type: 'string' }, b: { type: 'boolean' } },
		};
		const out = transformSchema(raw);
		assert.deepStrictEqual(out, {
			$schema: DRAFT_07,
			properties: {
				n: { is_advanced: true, anyOf: [{ type: 'integer', minimum: 0 }, { type: 'string', pattern: INTERPOLATION_PATTERN }] },
				s: { type: 'string' },
				b: { anyOf: [{ type: 'boolean' }, { type: 'string', pattern: INTERPOLATION_PATTERN }] },
			},
		});
	});
});

suite('core/schema helpers', () => {
	test('parseRawSchema / parseDocs / parseCachedSchema', () => {
		assert.ok(parseRawSchema('{"definitions":{},"properties":{}}'));
		assert.strictEqual(parseRawSchema('not json'), undefined);
		assert.strictEqual(parseRawSchema('[1]'), undefined);
		assert.strictEqual(parseRawSchema('{"a":1}'), undefined);
		assert.ok(parseDocs('{}'));
		assert.strictEqual(parseDocs('{'), undefined);
		assert.ok(parseCachedSchema(JSON.stringify({ $schema: DRAFT_07 })));
		assert.strictEqual(parseCachedSchema('{"definitions":{}}'), undefined);
		assert.strictEqual(parseCachedSchema('{"$schema":'), undefined);
	});

	test('schemaHash depends on path, version and transform version', () => {
		const h = schemaHash('/bin/rc', '4.112.0');
		assert.match(h, /^[0-9a-f]{16}$/);
		assert.strictEqual(schemaHash('/bin/rc', '4.112.0'), h);
		assert.notStrictEqual(schemaHash('/bin/rc', '4.100.0'), h);
		assert.notStrictEqual(schemaHash('/usr/bin/rc', '4.112.0'), h);
		assert.notStrictEqual(schemaHash('/bin/rc', '4.112.0', TRANSFORM_VERSION + 1), h);
		assert.strictEqual(schemaFileName('/bin/rc', '4.112.0'), `schema-${h}.json`);
		assert.ok(SCHEMA_FILE_PATTERN.test(schemaFileName('/bin/rc', '4.112.0')));
		for (const other of ['schema-notes.json', 'schema-0123456789abcdeF.json', 'schema-0123456789abcde.json', 'schema-0123456789abcdef.json.tmp']) {
			assert.ok(!SCHEMA_FILE_PATTERN.test(other), other);
		}
	});

	test('fieldMarkdown: description, examples, both, neither', () => {
		assert.strictEqual(fieldMarkdown({ description: ' Hi. ' }), 'Hi.');
		assert.strictEqual(fieldMarkdown({ examples: ['a'] }), 'Examples:\n\n```yaml\n- a\n```');
		assert.strictEqual(fieldMarkdown({ description: 'D', examples: [1, true] }), 'D\n\nExamples:\n\n```yaml\n- 1\n- true\n```');
		assert.strictEqual(fieldMarkdown({ description: '', examples: [] }), undefined);
	});

	test('toYamlList quotes doubtful scalars and renders block literals and nesting', () => {
		assert.strictEqual(toYamlList(['plain', 'a: b', 'true', '123', '', '${X}', '#c', null]),
			'- plain\n- "a: b"\n- "true"\n- "123"\n- ""\n- "${X}"\n- "#c"\n- null');
		assert.strictEqual(toYamlList(['root = this\nroot.x = 1']), '- |-\n  root = this\n  root.x = 1');
		assert.strictEqual(toYamlList(['a\nb\n']), '- |\n  a\n  b');
		assert.strictEqual(toYamlList([{ a: 1, b: { c: ['x', 'z'] }, d: [] }]), '- a: 1\n  b:\n    c:\n      - x\n      - z\n  d: []');
		assert.strictEqual(toYamlList(['a #b', 'a#b']), '- "a #b"\n- a#b');
		assert.strictEqual(toYamlList(['y', 'no', 'Off']), '- "y"\n- "no"\n- "Off"');
		assert.strictEqual(toYamlList([[], {}]), '- []\n- {}');
		assert.strictEqual(toYamlList([{ mapping: 'root = this\nroot.y = 2' }]), '- mapping: |-\n    root = this\n    root.y = 2');
	});
});

suite('core/schema transformSchema completion fixes (ticket 2.13)', () => {
	const fileOutput = (schema: JsonObject) => {
		const output = (schema.definitions as JsonObject).output as JsonObject;
		const branch = ((output.allOf as JsonObject[])[0].anyOf as JsonObject[]).find((b) => isJsonObject(b.properties) && 'file' in b.properties)!;
		return (branch.properties as JsonObject).file as JsonObject;
	};

	test('VERSION: the transform version is 5 (2.19)', () => {
		assert.strictEqual(TRANSFORM_VERSION, 5);
	});

	test('TRANSFORM (2.17): required lists move to x-rpcn-required (socket: network, address)', () => {
		const out = transformSchema(loadRaw('4.112.0'), loadDocs('4.112.0'));
		const input = (out.definitions as JsonObject).input as JsonObject;
		const branch = ((input.allOf as JsonObject[])[0].anyOf as JsonObject[]).find((b) => isJsonObject(b.properties) && 'socket' in b.properties)!;
		const socket = (branch.properties as JsonObject).socket as JsonObject;
		assert.deepStrictEqual(socket['x-rpcn-required'], ['network', 'address']);
		assert.strictEqual(socket.required, undefined);
		const raw = loadRaw('4.112.0');
		const rawCount = [...nodes(raw)].filter(([, n]) => Array.isArray(n.required) && n.required.length > 0).length;
		assert.strictEqual([...nodes(out)].filter(([, n]) => Array.isArray(n['x-rpcn-required'])).length, rawCount);
	});

	for (const v of VERSIONS) {
		test(`NO_REQUIRED: no node keeps \`required\` (${v}); the raw schema had some`, () => {
			const raw = loadRaw(v);
			assert.ok([...nodes(raw)].some(([, n]) => n.required !== undefined), 'fixture has required');
			const out = transformSchema(raw, loadDocs(v));
			const left = [...nodes(out)].filter(([, n]) => n.required !== undefined).map(([at]) => at);
			assert.deepStrictEqual(left, []);
		});
	}

	test('VALUE_OPTIONS: file.codec suggests its annotated options with descriptions, still any string', () => {
		const codec = (fileOutput(transformSchema(loadRaw('4.112.0'), loadDocs('4.112.0'))).properties as JsonObject).codec as JsonObject;
		assert.strictEqual(codec.type, 'string', 'type kept');
		assert.strictEqual(codec.default, 'lines', 'default kept');
		const [suggestion, any] = codec.anyOf as JsonObject[];
		assert.deepStrictEqual(suggestion.enum, ['all-bytes', 'append', 'delim:x', 'lines']);
		const descriptions = suggestion.markdownEnumDescriptions as string[];
		assert.strictEqual(descriptions.length, 4);
		assert.ok(descriptions[0].startsWith('Only applicable to file based outputs.'), descriptions[0]);
		assert.deepStrictEqual(any, { type: 'string' });
	});

	test('the raw input is not modified', () => {
		const raw = loadRaw('4.112.0');
		const before = JSON.stringify(raw);
		transformSchema(raw, loadDocs('4.112.0'));
		assert.strictEqual(JSON.stringify(raw), before);
	});

	/** A one-component schema with field `f` of `node`, documented by `doc`. */
	const tiny = (node: JsonObject, doc: JsonObject) => {
		const raw: JsonObject = {
			definitions: { output: { allOf: [{ anyOf: [{ properties: { c: { properties: { f: node }, type: 'object' } }, type: 'object' }] }] } },
			properties: { output: { $ref: '#/definitions/output' } },
		};
		const docs: JsonObject = { outputs: [{ name: 'c', config: { kind: 'scalar', children: [{ name: 'f', ...doc }] } }] };
		const out = transformSchema(raw, docs);
		const c = ((((out.definitions as JsonObject).output as JsonObject).allOf as JsonObject[])[0].anyOf as JsonObject[])[0];
		return ((c.properties as JsonObject).c as JsonObject).properties as JsonObject;
	};

	test('PLAIN_OPTIONS: options without descriptions give an enum without markdownEnumDescriptions', () => {
		const f = tiny({ type: 'string' }, { kind: 'scalar', type: 'string', options: ['a', 'b', 'a', '', 3] }).f as JsonObject;
		assert.deepStrictEqual(f.anyOf, [{ type: 'string', enum: ['a', 'b'] }, { type: 'string' }]);
	});

	test('annotated_options without a usable pair fall back to options', () => {
		const f = tiny({ type: 'string' }, { kind: 'scalar', type: 'string', annotated_options: [[1, 'x'], 'bad'], options: ['a'] }).f as JsonObject;
		assert.deepStrictEqual(f.anyOf, [{ type: 'string', enum: ['a'] }, { type: 'string' }]);
	});

	test('annotated options with some descriptions missing get "" for those', () => {
		const f = tiny({ type: 'string' }, { kind: 'scalar', type: 'string', annotated_options: [['a', 'Alpha'], ['b', ''], ['c']] }).f as JsonObject;
		assert.deepStrictEqual((f.anyOf as JsonObject[])[0], { type: 'string', enum: ['a', 'b', 'c'], markdownEnumDescriptions: ['Alpha', '', ''] });
	});

	test('ARRAY_OPTIONS: an array of strings gets the suggestions on its items', () => {
		const f = tiny({ type: 'array', items: { type: 'string' } }, { kind: 'array', type: 'string', options: ['x', 'y'] }).f as JsonObject;
		assert.deepStrictEqual((f.items as JsonObject).anyOf, [{ type: 'string', enum: ['x', 'y'] }, { type: 'string' }]);
		assert.strictEqual(f.anyOf, undefined);
	});

	test('SKIP: non-string nodes and nodes with anyOf or enum are left alone', () => {
		const num = tiny({ type: 'number' }, { kind: 'scalar', type: 'int', options: ['1', '2'] }).f as JsonObject;
		assert.deepStrictEqual((num.anyOf as JsonObject[]).map((m) => m.type), ['number', 'string'], 'only the ${VAR} interpolation');
		const withEnum = tiny({ type: 'string', enum: ['q'] }, { kind: 'scalar', type: 'string', options: ['a'] }).f as JsonObject;
		assert.deepStrictEqual(withEnum, { type: 'string', enum: ['q'], markdownDescription: 'Options: `a`' }, 'enum untouched; hover line from the docs (2.15)');
		const map = tiny({ type: 'object', properties: {} }, { kind: 'map', type: 'string', options: ['a'] }).f as JsonObject;
		assert.strictEqual(map.anyOf, undefined);
	});
});

suite('core/schema hover lists options (ticket 2.15)', () => {
	test('ANNOTATED: file.codec shows its options between description and examples', () => {
		const out = transformSchema(loadRaw('4.112.0'), loadDocs('4.112.0'));
		const output = (out.definitions as JsonObject).output as JsonObject;
		const branch = ((output.allOf as JsonObject[])[0].anyOf as JsonObject[]).find((b) => isJsonObject(b.properties) && 'file' in b.properties)!;
		const codec = (((branch.properties as JsonObject).file as JsonObject).properties as JsonObject).codec as JsonObject;
		const md = codec.markdownDescription as string;
		const options = md.indexOf('Options: `all-bytes`, `append`, `delim:x`, `lines`');
		assert.ok(options > 0, md);
		assert.ok(md.indexOf('Examples:') > options, 'examples come after the options');
	});

	test('HOVER_NETWORK data: socket_server.network lists its five options', () => {
		const out = transformSchema(loadRaw('4.112.0'), loadDocs('4.112.0'));
		const input = (out.definitions as JsonObject).input as JsonObject;
		const branch = ((input.allOf as JsonObject[])[0].anyOf as JsonObject[]).find((b) => isJsonObject(b.properties) && 'socket_server' in b.properties)!;
		const network = (((branch.properties as JsonObject).socket_server as JsonObject).properties as JsonObject).network as JsonObject;
		assert.ok((network.markdownDescription as string).includes('Options: `unix`, `tcp`, `udp`, `tls`, `unixgram`'));
	});

	test('NO_OPTIONS / ONLY_OPTIONS / BACKTICK', () => {
		assert.strictEqual(fieldMarkdown({ description: 'D' }), 'D');
		assert.strictEqual(fieldMarkdown({ options: ['a', 'b'] }), 'Options: `a`, `b`');
		assert.strictEqual(fieldMarkdown({ annotated_options: [['x', 'X!']], description: 'D', examples: ['x'] }),
			'D\n\nOptions: `x`\n\nExamples:\n\n```yaml\n- x\n```');
		assert.strictEqual(fieldMarkdown({ options: ['a`b'] }), 'Options: `` a`b ``');
	});
});

