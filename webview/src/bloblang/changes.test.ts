// The test panel's pure helpers (ticket 4.7): the shown content and its field line spans, the
// "Changed:" tags, the input metadata, and the saved view state.

import { describe, expect, it } from 'vitest';
import { changeTags, inputMeta, markedLines, metaRowCount, metaValueText, shownContent } from './changes';
import { DEFAULT_VIEW_STATE, readViewState } from './host';

describe('Bloblang panel helpers (4.7)', () => {
	it('FIELDS: pretty JSON with each top-level key\'s line span, nested values included', () => {
		const shown = shownContent('{"a":1,"b":{"x":[1,2]},"c":4}');
		expect(shown.lines).toEqual([
			'{',
			'  "a": 1,',
			'  "b": {',
			'    "x": [',
			'      1,',
			'      2',
			'    ]',
			'  },',
			'  "c": 4',
			'}',
		]);
		expect([...shown.spans]).toEqual([['a', [1, 1]], ['b', [2, 7]], ['c', [8, 8]]]);
		expect([...markedLines(shown, ['b', 'c', 'gone'])].sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 6, 7, 8]);
	});

	it('NOT_JSON: verbatim, no spans; a JSON non-object is pretty but has no spans', () => {
		expect(shownContent('hello\nworld')).toEqual({ lines: ['hello', 'world'], spans: new Map() });
		expect(shownContent('[1,2]')).toEqual({ lines: ['[', '  1,', '  2', ']'], spans: new Map() });
		expect(shownContent('{}')).toEqual({ lines: ['{}'], spans: new Map() });
	});

	it('a lossy round trip shows verbatim; a compact Go-style object is pretty with spans', () => {
		for (const content of ['{"id":12345678901234567890}', '{"a":1.0}', '{"a":1e2}', '{"a":1,"a":2}', '{"a":"\\u00e9"}']) {
			expect(shownContent(content)).toEqual({ lines: [content], spans: new Map() });
		}
		const shown = shownContent('{"a":1,"b":"x"}');
		expect(shown.lines).toEqual(['{', '  "a": 1,', '  "b": "x"', '}']);
		expect([...shown.spans]).toEqual([['a', [1, 1]], ['b', [2, 2]]]);
	});

	it('tags: fields then metadata (@), added +, changed ~, removed −; null fields give none', () => {
		expect(changeTags({
			fields: { added: ['c'], changed: ['b'], removed: ['a'] },
			meta: { added: ['out'], changed: ['k'], removed: ['gone'] },
		}).map((t) => t.text)).toEqual(['+c', '~b', '−a', '+@out', '~@k', '−@gone']);
		expect(changeTags({ fields: null, meta: { added: ['out'], changed: [], removed: [] } }).map((t) => t.text)).toEqual(['+@out']);
		expect(changeTags({ fields: { added: [], changed: [], removed: [] }, meta: { added: [], changed: [], removed: [] } })).toEqual([]);
	});

	it('EMPTY_KEY: rows with an empty key are not sent or counted; the last of a repeated key wins', () => {
		const rows = [{ key: 'k', value: '1' }, { key: '', value: 'x' }, { key: 'j', value: '2' }, { key: 'k', value: '3' }, { key: '__proto__', value: 'p' }];
		const meta = inputMeta(rows);
		expect(Object.keys(meta)).toEqual(['j', 'k', '__proto__']);
		expect(meta).toEqual(Object.fromEntries([['j', '2'], ['k', '3'], ['__proto__', 'p']]));
		expect(metaRowCount(rows)).toBe(4);
	});

	it('metadata values: strings raw, others as JSON', () => {
		expect(metaValueText('a "b"')).toBe('a "b"');
		expect(metaValueText(3)).toBe('3');
		expect(metaValueText(['new', 'eu'])).toBe('["new","eu"]');
		expect(metaValueText(null)).toBe('null');
	});

	it('view state: defaults; 4.2\'s {input} is the content; malformed parts take their defaults', () => {
		expect(readViewState(undefined)).toEqual(DEFAULT_VIEW_STATE);
		expect(readViewState({ input: '{"a":1}' })).toEqual({ ...DEFAULT_VIEW_STATE, content: '{"a":1}' });
		expect(readViewState({
			content: 'x', meta: [{ key: 'k', value: 'v' }, { key: 1 }], inputTab: 'meta', outputTab: 'nope', runOnChange: false,
		})).toEqual({ content: 'x', meta: [{ key: 'k', value: 'v' }], inputTab: 'meta', outputTab: 'content', runOnChange: false });
	});
});
