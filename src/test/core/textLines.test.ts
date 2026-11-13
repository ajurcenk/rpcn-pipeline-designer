import * as assert from 'assert';
import { lineCounter, lineOf } from '../../core/textLines';

// Story 50: one line helper for the Cloud check, the Bloblang names and the Cloud translation.
suite('core/textLines', () => {
	const text = 'a\nbc\n\nd\r\ne';

	test('lineOf: the 1-based line of an offset; a newline counts on its own line; past the end: the last line', () => {
		assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((o) => lineOf(text, o)), [1, 1, 2, 2, 2, 3, 4, 4, 4, 5, 5]);
		assert.strictEqual(lineOf(text, 99), 5);
		assert.strictEqual(lineOf('', 0), 1);
		assert.strictEqual(lineOf('no newline', 5), 1);
	});

	test('lineCounter: the same lines as lineOf for offsets in increasing order, repeats included', () => {
		const offsets = [0, 0, 2, 4, 5, 6, 6, 9, 10, 99];
		const at = lineCounter(text);
		assert.deepStrictEqual(offsets.map(at), offsets.map((o) => lineOf(text, o)));
	});
});
