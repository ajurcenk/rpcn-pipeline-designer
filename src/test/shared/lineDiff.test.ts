import * as assert from 'assert';
import { lineDiff, linesOf, MAX_EDIT } from '../../shared/lineDiff';

// Story 8.12: the +N/−N of the assistant's file rows.
suite('shared/lineDiff (assistant file rows, story 8.12)', () => {
	test('lines: none for an empty text; a final newline ends the last line', () => {
		assert.deepStrictEqual(linesOf(''), []);
		assert.deepStrictEqual(linesOf('a\nb\n'), ['a', 'b']);
		assert.deepStrictEqual(linesOf('a\r\nb'), ['a', 'b']);
		assert.deepStrictEqual(linesOf('\n'), ['']);
	});

	test('a new file adds every line; a deleted one removes every line; the same text changes none', () => {
		assert.deepStrictEqual(lineDiff(null, 'a\nb\nc\n'), { added: 3, removed: 0 });
		assert.deepStrictEqual(lineDiff('a\nb\n', null), { added: 0, removed: 2 });
		assert.deepStrictEqual(lineDiff('a\nb\n', 'a\nb\n'), { added: 0, removed: 0 });
	});

	test('a changed line is one removed and one added; insertions and deletions in the middle', () => {
		assert.deepStrictEqual(lineDiff('a\nb\nc\n', 'a\nB\nc\n'), { added: 1, removed: 1 });
		assert.deepStrictEqual(lineDiff('a\nc\n', 'a\nb\nc\n'), { added: 1, removed: 0 });
		assert.deepStrictEqual(lineDiff('a\nb\nc\nd\n', 'a\nd\n'), { added: 0, removed: 2 });
		assert.deepStrictEqual(lineDiff('x\na\nb\nc\ny\n', 'x\nc\nb\na\ny\n'), { added: 2, removed: 2 });
		assert.deepStrictEqual(lineDiff('a\nb\nc\nd\ne\n', 'b\nc\nX\ne\nf\n'), { added: 2, removed: 2 });
	});

	test('very different long texts fall back to the multiset estimate', () => {
		const a = Array.from({ length: MAX_EDIT + 10 }, (_, i) => `a${i}`).join('\n');
		const b = Array.from({ length: MAX_EDIT + 10 }, (_, i) => `b${i}`).join('\n');
		assert.deepStrictEqual(lineDiff(a, b), { added: MAX_EDIT + 10, removed: MAX_EDIT + 10 });
	});
});
