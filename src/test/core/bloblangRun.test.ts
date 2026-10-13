import * as assert from 'assert';
import { parse } from 'yaml';
import { bloblangString, MAX_ERROR_LINES, parseRunOutput, RESULT_MAPPING, testConfig, yamlQuoted } from '../../core/bloblangRun';

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
			const config = parse(testConfig(kind, 'root.b = this.a + 1', '{"a":1}'));
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
			const text = testConfig('mapping', 'root = content()', content);
			// Only printable ASCII in the config, and no `${` the binary could substitute.
			assert.ok(/^[\x20-\x7e\n]*$/.test(text), JSON.stringify(text));
			assert.ok(!text.split('\n')[8].includes('$'), 'the content line has no raw $');
			const mapping = (parse(text) as { input: { generate: { mapping: string } } }).input.generate.mapping;
			assert.ok(mapping.startsWith('root = '));
			assert.strictEqual(unquoteGo(mapping.slice('root = '.length)), content);
		}
	});

	test('the code under test keeps its ${VAR}s for the binary to substitute, as Run does', () => {
		const text = testConfig('mapping', 'root.a = "${FOO}"', '{}');
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

	test('RUN_OK: exit 0 with a JSON line gives its content', () => {
		assert.deepStrictEqual(parseRunOutput(0, '{"content":"{\\"a\\":1,\\"b\\":2}","meta":{}}\n', ''), { kind: 'ok', content: '{"a":1,"b":2}' });
		assert.deepStrictEqual(parseRunOutput(0, '{"content":"","meta":{}}\n', ''), { kind: 'ok', content: '' });
	});

	test('RUN_FAILED: exit 0 with an error line gives the mapping\'s message; stderr logs are ignored', () => {
		assert.deepStrictEqual(
			parseRunOutput(0, '{"error":"failed assignment (line 1): expected number value"}\n', 'level=error msg="processor failed"\n'),
			{ kind: 'failed', message: 'failed assignment (line 1): expected number value' },
		);
	});

	test('DELETED: exit 0 with no line', () => {
		assert.deepStrictEqual(parseRunOutput(0, '', ''), { kind: 'deleted' });
		assert.deepStrictEqual(parseRunOutput(0, '\n', 'level=warn x\n'), { kind: 'deleted' });
	});

	test('RUN_ERROR: any other exit gives the first stderr lines verbatim', () => {
		const stderr = 'time="t" level=error msg="Config lint error" lint="(1,1) required environment variables were not set: [X]"\n\nsecond\n';
		assert.deepStrictEqual(parseRunOutput(1, '', stderr), {
			kind: 'error',
			message: 'time="t" level=error msg="Config lint error" lint="(1,1) required environment variables were not set: [X]"\nsecond',
		});
		const many = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
		assert.strictEqual((parseRunOutput(2, '', many) as { message: string }).message.split('\n').length, MAX_ERROR_LINES);
		assert.deepStrictEqual(parseRunOutput(3, '', ''), { kind: 'error', message: 'Redpanda Connect exited with code 3.' });
		assert.deepStrictEqual(parseRunOutput(null, '', ''), { kind: 'error', message: 'Redpanda Connect was stopped by a signal.' });
	});

	test('output that is not the result step\'s is an error', () => {
		assert.deepStrictEqual(parseRunOutput(0, 'hello\n', ''), { kind: 'error', message: 'Unexpected output: hello' });
		assert.deepStrictEqual(parseRunOutput(0, '[1]\n', ''), { kind: 'error', message: 'Unexpected output: [1]' });
	});
});
