import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import { bloblangString, changesOf, GENERATE_RUN_INPUT, MAX_ERROR_LINES, missingVariablesOf, parseRunOutput, RESULT_MAPPING, testConfig, yamlQuoted } from '../../core/bloblangRun';
import { REPO_ROOT } from '../helpers/fakeBinary';

/** Route C's captures (spike 4.1, standalone 4.112.0). */
const CAPTURES = path.join(REPO_ROOT, '_bmad-output', 'initiative-rpcn-vscode-designer', 'epic-bloblang-check-and-test',
	'spike-4-1-findings', 'captures', 'standalone-4.112.0', 'C');

function capture(scenario: string): { exit: number; stdout: string; stderr: string } {
	const read = (ext: string) => fs.readFileSync(path.join(CAPTURES, `${scenario}.${ext}`), 'utf8');
	return { exit: Number(read('exit').trim()), stdout: read('stdout'), stderr: read('stderr') };
}

const NO_INPUT = { content: '', meta: {} };
const NONE = { added: [], changed: [], removed: [] };

/**
 * Reads a Bloblang double-quoted literal as Go's `strconv.Unquote` does, for the escapes JSON
 * produces (the test's stand-in for the binary).
 */
function unquoteGo(literal: string): string {
	assert.ok(literal.startsWith('"') && literal.endsWith('"'));
	assert.ok(!/[\n\r]/.test(literal), 'a Go string literal holds no raw newline');
	return JSON.parse(literal) as string;
}

suite('core/bloblangRun (4.2, AD-21)', () => {
	test('the config: no HTTP, warn logs, one generated message, the code with its kind, the result step, stdout lines', () => {
		for (const kind of ['mapping', 'mutation'] as const) {
			const config = parse(testConfig(kind, 'root.b = this.a + 1', '{"a":1}', {}));
			assert.deepStrictEqual(config, {
				http: { enabled: false },
				logger: { level: 'warn' },
				input: { generate: { count: 1, interval: '', mapping: 'root = "{\\"a\\":1}"' } },
				pipeline: { processors: [{ [kind]: 'root.b = this.a + 1' }, { mapping: RESULT_MAPPING }] },
				output: { stdout: { codec: 'lines' } },
			});
		}
		assert.strictEqual(
			RESULT_MAPPING,
			'root = if errored() { {"error": error()} } else { {"content": content().string(), "meta": @} }',
		);
	});

	test('GENERATE (ticket 16): a generate mapping runs as a mapping processor on one empty message; content and meta are ignored; ${VAR} kept', () => {
		const source = 'root.id = uuid_v4()\nmeta k = "${FOO}"';
		const text = testConfig('generate', source, '{"ignored":true}', { ignored: 'yes' });
		assert.strictEqual(GENERATE_RUN_INPUT, 'root = ""');
		assert.deepStrictEqual(parse(text), {
			http: { enabled: false },
			logger: { level: 'warn' },
			input: { generate: { count: 1, interval: '', mapping: 'root = ""' } },
			pipeline: { processors: [{ mapping: source }, { mapping: RESULT_MAPPING }] },
			output: { stdout: { codec: 'lines' } },
		});
		assert.ok(!text.includes('- generate:'), 'no generate processor');
		assert.ok(text.includes('${FOO}'), 'the source keeps its ${VAR} for the binary');
	});

	test('CONTENT_ESCAPE: quotes, backslashes, newlines, controls and non-ASCII reach the mapping unchanged', () => {
		const contents = [
			'q"uo\\te',
			'line 1\nline 2\r\n\ttab',
			'ü 日本 😀   \u0085 \u007f \u0001 \u0000',
			'${HOME} $${X} ${! this } $',
			'"""triple"""',
			'',
		];
		for (const content of contents) {
			const text = testConfig('mapping', 'root = content()', content, {});
			// Only printable ASCII in the config, and no `${` the binary could substitute.
			assert.ok(/^[\x20-\x7e\n]*$/.test(text), JSON.stringify(text));
			assert.ok(!text.split('\n')[8].includes('$'), 'the content line has no raw $');
			const mapping = (parse(text) as { input: { generate: { mapping: string } } }).input.generate.mapping;
			assert.ok(mapping.startsWith('root = '));
			assert.strictEqual(unquoteGo(mapping.slice('root = '.length)), content);
		}
	});

	test('META_IN: one meta line per entry after root, keys and values as Bloblang literals', () => {
		const text = testConfig('mapping', 'root.k = @k', '{"a":1}', { k: 'v', other: 'w' });
		const mapping = (parse(text) as { input: { generate: { mapping: string } } }).input.generate.mapping;
		assert.strictEqual(mapping, 'root = "{\\"a\\":1}"\nmeta "k" = "v"\nmeta "other" = "w"');
		assert.strictEqual(
			(parse(testConfig('mapping', 'root = this', '{}', {})) as { input: { generate: { mapping: string } } }).input.generate.mapping,
			'root = "{}"',
		);
	});

	test('ODD_KEYS: a key with a space, a quote and a non-ASCII character, a value with ${HOME}, stay exact', () => {
		const key = 'a "b" é';
		const value = '${HOME} \\ \n end';
		const text = testConfig('mapping', 'root = this', '{}', { [key]: value });
		assert.ok(/^[\x20-\x7e\n]*$/.test(text), JSON.stringify(text));
		assert.ok(!text.split('\n')[8].includes('$'), 'the generate line has no raw $');
		const mapping = (parse(text) as { input: { generate: { mapping: string } } }).input.generate.mapping;
		const [, metaLine] = mapping.split('\n');
		const m = /^meta ("(?:[^"\\]|\\.)*") = ("(?:[^"\\]|\\.)*")$/.exec(metaLine);
		assert.ok(m, metaLine);
		assert.strictEqual(unquoteGo(m[1]), key);
		assert.strictEqual(unquoteGo(m[2]), value);
	});

	test('the code under test keeps its ${VAR}s for the binary to substitute, as Run does', () => {
		const text = testConfig('mapping', 'root.a = "${FOO}"', '{}', {});
		assert.ok(text.includes('- mapping: "root.a = \\"${FOO}\\""'));
		assert.strictEqual((parse(text) as { pipeline: { processors: { mapping: string }[] } }).pipeline.processors[0].mapping, 'root.a = "${FOO}"');
	});

	test('a lone surrogate becomes U+FFFD; YAML escapes', () => {
		assert.strictEqual(bloblangString('a\uD800b'), '"a�b"');
		assert.strictEqual(bloblangString('\uDC00'), '"�"');
		assert.strictEqual(bloblangString('😀'), '"😀"');
		assert.strictEqual(yamlQuoted('a"b\\c$', false), '"a\\"b\\\\c$"');
		assert.strictEqual(yamlQuoted('$\né日😀', true), '"\\x24\\x0A\\xE9\\u65E5\\U0001F600"');
		assert.strictEqual(parse(yamlQuoted('$\né日😀\u0085', true)), '$\né日😀\u0085');
	});

	test('RUN_OK: exit 0 with a JSON line gives its content, its metadata and what changed', () => {
		assert.deepStrictEqual(parseRunOutput(0, '{"content":"{\\"a\\":1,\\"b\\":2}","meta":{}}\n', '', { content: '{"a":1}', meta: {} }), {
			kind: 'ok',
			content: '{"a":1,"b":2}',
			meta: {},
			changes: { fields: { added: ['b'], changed: [], removed: [] }, meta: { added: [], changed: [], removed: [] } },
		});
		assert.deepStrictEqual(parseRunOutput(0, '{"content":"","meta":{}}\n', '', NO_INPUT), {
			kind: 'ok', content: '', meta: {}, changes: { fields: null, meta: NONE },
		});
		assert.deepStrictEqual(
			parseRunOutput(0, '{"content":"x","meta":{"k":"x","n":2,"o":{"p":[1]},"":"dropped"}}\n', '', { content: 'x', meta: { k: 'x', gone: 'y' } }),
			{
				kind: 'ok',
				content: 'x',
				meta: { k: 'x', n: 2, o: { p: [1] } },
				changes: { fields: null, meta: { added: ['n', 'o'], changed: [], removed: ['gone'] } },
			},
		);
		// No `meta` in the line: none.
		assert.deepStrictEqual(parseRunOutput(0, '{"content":"x"}\n', '', NO_INPUT), { kind: 'ok', content: 'x', meta: {}, changes: { fields: null, meta: NONE } });
	});

	test('CHANGES: top-level keys added, changed and removed, of the fields and the metadata', () => {
		assert.deepStrictEqual(changesOf('{"a":1,"b":2}', '{"a":1,"b":3,"c":4}', { k: 'x' }, { k: 'x', j: 'y' }), {
			fields: { added: ['c'], changed: ['b'], removed: [] },
			meta: { added: ['j'], changed: [], removed: [] },
		});
		assert.deepStrictEqual(changesOf('{"a":{"x":1,"y":[1,2]},"b":1,"d":0}', '{"b":"1","a":{"y":[1,2],"x":1}}', { k: 'x', m: '1' }, { k: 'z', m: 1 }), {
			fields: { added: [], changed: ['b'], removed: ['d'] },
			meta: { added: [], changed: ['k', 'm'], removed: [] },
		});
		assert.deepStrictEqual(changesOf('{"a":[1]}', '{"a":[1,2]}', {}, {}).fields, { added: [], changed: ['a'], removed: [] });
		// Not both JSON objects: no field changes.
		for (const [input, output] of [['not json', '{"a":1}'], ['{"a":1}', 'nope'], ['[1]', '{"a":1}'], ['{"a":1}', '1'], ['{"a":1}', 'null'], ['', '']]) {
			assert.strictEqual(changesOf(input, output, {}, {}).fields, null, `${input} -> ${output}`);
		}
	});

	test('RUN_FAILED: exit 0 with an error line gives the mapping\'s message and line; stderr logs are ignored', () => {
		assert.deepStrictEqual(
			parseRunOutput(0, '{"error":"failed assignment (line 1): expected number value"}\n', 'level=error msg="processor failed"\n', NO_INPUT),
			{ kind: 'failed', message: 'failed assignment (line 1): expected number value', mappingLine: 1 },
		);
	});

	test('FAILED (4.8): the spike\'s map-error capture is failed on mapping line 2, the message verbatim', () => {
		const { exit, stdout, stderr } = capture('map-error');
		assert.strictEqual(exit, 0);
		assert.deepStrictEqual(parseRunOutput(exit, stdout, stderr, { content: '{}', meta: {} }), {
			kind: 'failed',
			message: 'failed assignment (line 2): expected number value, got null from field `this.nope`',
			mappingLine: 2,
		});
	});

	test('FAILED_NO_LINE (4.8): an error without `failed assignment (line N)` has no line', () => {
		assert.deepStrictEqual(parseRunOutput(0, '{"error":"something went wrong"}\n', '', NO_INPUT), { kind: 'failed', message: 'something went wrong' });
		assert.deepStrictEqual(parseRunOutput(0, '{"error":"x failed assignment (line 3): y"}\n', '', NO_INPUT), { kind: 'failed', message: 'x failed assignment (line 3): y' });
		assert.deepStrictEqual(parseRunOutput(0, '{"error":"failed assignment (line 0): y"}\n', '', NO_INPUT), { kind: 'failed', message: 'failed assignment (line 0): y' });
	});

	test('INVALID (4.8): the spike\'s bad-input capture is invalidInput with the binary\'s message', () => {
		const { exit, stdout, stderr } = capture('bad-input');
		assert.deepStrictEqual(parseRunOutput(exit, stdout, stderr, { content: 'not json', meta: {} }), {
			kind: 'invalidInput',
			message: 'failed assignment (line 1): unable to reference message as structured (with \'this\'): parse as json: invalid character \'o\' in literal null (expecting \'u\')',
		});
	});

	test('LINT (4.8): an exit 1 with `Config lint error` is a lint stop for the adapter, the stderr lines verbatim', () => {
		const { exit, stdout, stderr } = capture('parse-error');
		assert.strictEqual(exit, 1);
		const outcome = parseRunOutput(exit, stdout, stderr, NO_INPUT);
		assert.strictEqual(outcome.kind, 'lint');
		assert.strictEqual(outcome.kind === 'lint' && outcome.message, stderr.split('\n').filter((l) => l.trim() !== '').join('\n'));
		// Another exit code, or exit 1 without the marker, stays an error.
		assert.strictEqual(parseRunOutput(2, '', stderr, NO_INPUT).kind, 'error');
		assert.strictEqual(parseRunOutput(1, '', 'level=error msg="boom"\n', NO_INPUT).kind, 'error');
	});

	test('DELETED: exit 0 with no line', () => {
		assert.deepStrictEqual(parseRunOutput(0, '', '', NO_INPUT), { kind: 'deleted' });
		assert.deepStrictEqual(parseRunOutput(0, '\n', 'level=warn x\n', NO_INPUT), { kind: 'deleted' });
	});

	test('RUN_ERROR: any other exit gives the first stderr lines verbatim (a lint stop too)', () => {
		const stderr = 'time="t" level=error msg="Config lint error" lint="(1,1) required environment variables were not set: [X]"\n\nsecond\n';
		assert.deepStrictEqual(parseRunOutput(1, '', stderr, NO_INPUT), {
			kind: 'lint',
			message: 'time="t" level=error msg="Config lint error" lint="(1,1) required environment variables were not set: [X]"\nsecond',
		});
		const many = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
		assert.strictEqual((parseRunOutput(2, '', many, NO_INPUT) as { message: string }).message.split('\n').length, MAX_ERROR_LINES);
		assert.deepStrictEqual(parseRunOutput(3, '', '', NO_INPUT), { kind: 'error', message: 'Redpanda Connect exited with code 3.' });
		assert.deepStrictEqual(parseRunOutput(null, '', '', NO_INPUT), { kind: 'error', message: 'Redpanda Connect was stopped by a signal.' });
	});

	test('output that is not the result step\'s is an error', () => {
		assert.deepStrictEqual(parseRunOutput(0, 'hello\n', '', NO_INPUT), { kind: 'error', message: 'Unexpected output: hello' });
		assert.deepStrictEqual(parseRunOutput(0, '[1]\n', '', NO_INPUT), { kind: 'error', message: 'Unexpected output: [1]' });
	});
	test('MISSING_VARIABLES (ticket 32): the names of the unset-variables message, valid ones only, once each', () => {
		const lint = (names: string) => `level=error msg="Config lint error" lint="(1,1) required environment variables were not set: [${names}]"`;
		assert.deepStrictEqual(missingVariablesOf(lint('REGION ZONE')), ['REGION', 'ZONE']);
		assert.deepStrictEqual(missingVariablesOf(lint('X')), ['X']);
		// BAD_NAME: a token that is not a name gets nothing; the rest of the message is not read.
		assert.deepStrictEqual(missingVariablesOf(lint('REGION bad-name 1X  _ok')), ['REGION', '_ok']);
		assert.deepStrictEqual(missingVariablesOf(lint('')), []);
		assert.deepStrictEqual(missingVariablesOf(`${lint('A B')}\n${lint('B C')}`), ['A', 'B', 'C']);
		assert.deepStrictEqual(missingVariablesOf('level=error msg="Config lint error" lint="(3,5) field foo not recognised"'), []);
		assert.deepStrictEqual(missingVariablesOf('required environment variables were not set: REGION'), []);
		assert.deepStrictEqual(missingVariablesOf('No Redpanda Connect binary.'), []);
	});
});
