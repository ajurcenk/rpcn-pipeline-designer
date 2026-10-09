import * as assert from 'assert';
import { errorSelection, parseErrorOf, UNPARSED_MESSAGE } from '../../core/parseError';
import { parseYaml } from '../../core/yamlPath';

suite('core/parseErrorOf (3.6, AD-6)', () => {
	test('PARSE_ERROR_OF: valid text has no error', () => {
		assert.strictEqual(parseErrorOf(parseYaml('input:\n  stdin: {}\noutput:\n  stdout: {}\n')), undefined);
		assert.strictEqual(parseErrorOf(parseYaml('')), undefined);
		assert.strictEqual(parseErrorOf(parseYaml('# only a comment\n')), undefined);
	});

	test('PARSE_ERROR_OF: a bad indent gives the error at its offset', () => {
		const text = 'input:\n  stdin: {}\n bad: 1\n';
		const error = parseErrorOf(parseYaml(text));
		assert.ok(error, 'an error');
		assert.strictEqual(error.message, 'All mapping items must start at the same column at line 3, column 1');
		assert.strictEqual(error.range[0], text.indexOf(' bad'));
		assert.ok(error.range[1] >= error.range[0] && error.range[1] <= text.length);
	});

	test('PARSE_ERROR_OF: an unclosed flow map gives its error, inside the text', () => {
		const text = 'input:\n  generate: {\n';
		const error = parseErrorOf(parseYaml(text));
		assert.ok(error, 'an error');
		assert.ok(error.message.startsWith('Flow map in block collection must be sufficiently indented'), error.message);
		assert.ok(!error.message.includes('\n'), 'only the first line of the message');
		assert.ok(error.range[0] <= error.range[1] && error.range[1] <= text.length, `${error.range}`);
	});

	test('PARSE_ERROR_OF: only the first document is read', () => {
		assert.strictEqual(parseErrorOf(parseYaml('a: 1\n---\nb: [\n')), undefined);
		assert.ok(parseErrorOf(parseYaml('b: [\n---\na: 1\n')));
	});

	test('PARSE_ERROR_OF: the first of several errors; never throws', () => {
		const text = 'input:\n  a: 1\n    b: 2\n';
		const error = parseErrorOf(parseYaml(text));
		assert.ok(error);
		assert.ok(error.message.startsWith('Nested mappings are not allowed'), error.message);
		assert.deepStrictEqual(parseErrorOf(undefined), { message: UNPARSED_MESSAGE, range: [0, 0] });
		const weird = { docs: [{ errors: [{ pos: [-5, 1e9], message: undefined }] }], length: 10 } as never;
		assert.deepStrictEqual(parseErrorOf(weird), { message: UNPARSED_MESSAGE, range: [0, 10] });
		const hostile = { get docs(): never { throw new Error('boom'); }, length: 1 } as never;
		assert.deepStrictEqual(parseErrorOf(hostile), { message: UNPARSED_MESSAGE, range: [0, 0] });
	});

	test('ERROR_SELECTION: a position runs to its line end; never into the next line', () => {
		const text = 'input:\n  stdin: {}\n bad: 1\noutput:\n';
		const bad = text.indexOf(' bad');
		const sel = (range: readonly [number, number]) => text.slice(...errorSelection(text, range));
		// A one-character mark, or an empty range: to the end of the line.
		assert.strictEqual(sel([bad, bad + 1]), ' bad: 1');
		assert.strictEqual(sel([bad, bad]), ' bad: 1');
		// A real range is kept.
		assert.deepStrictEqual(errorSelection(text, [bad, bad + 4]), [bad, bad + 4]);
		// On the line's \n (or at its end): the whole line, not the next one.
		const nl = text.indexOf('\n', bad);
		assert.strictEqual(sel([nl, nl + 1]), ' bad: 1');
		assert.strictEqual(sel([nl, nl]), ' bad: 1');
		// CRLF: the \r and \n stay out.
		const crlf = 'a: 1\r\nb: [\r\n';
		assert.strictEqual(crlf.slice(...errorSelection(crlf, [crlf.indexOf('\r'), crlf.indexOf('\r') + 1])), 'a: 1');
		// At the end of the text after a final newline (an empty line): just the position.
		assert.deepStrictEqual(errorSelection(text, [text.length, text.length]), [text.length, text.length]);
		// At the end of a text without one: that last line.
		assert.strictEqual('a: "abc\nb: 1'.slice(...errorSelection('a: "abc\nb: 1', [12, 12])), 'b: 1');
		assert.deepStrictEqual(errorSelection('', [0, 0]), [0, 0]);
	});
});
