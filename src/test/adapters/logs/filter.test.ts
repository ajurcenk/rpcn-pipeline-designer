import * as assert from 'assert';
import { compileFilter, Counter, INSTANCE_FIELD, levelOf, matches, sameFilter } from '../../../adapters/logs/filter';
import { filterActive, MAX_MATCH_CHARS, NO_FILTER, parseLogFilter, searchError, SLOW_PATTERN_ERROR, slowPattern, type LogFilter, type LogRow } from '../../../shared/logsProtocol';

// The Pipeline Logs panel's filter (ticket 6.4): the level a row counts under, the levels, the search
// (plain or a regular expression, Match case) over the message, the level, the instance and every
// field's name and value, the field chips, all of them together, and the counts.

const row = (extra: Partial<LogRow> = {}): LogRow => ({
	id: '0:1', time: 0, level: 'INFO', message: 'Input type generate is now active', instance: 'd3ugjmtpsedhm3e7c1gjg',
	fields: [['path', '/config/connect.yaml'], ['label', 'gen']], ...extra,
});
const keeps = (filter: Partial<LogFilter>, r: LogRow = row()) => matches(r, compileFilter({ ...NO_FILTER, ...filter })!);

suite('Pipeline logs filter (ticket 6.4)', () => {
	test('levelOf: Error, Warn, Info, Debug, else Other', () => {
		const of = (level: string) => levelOf({ level });
		assert.deepStrictEqual(['ERROR', 'FATAL', 'WARN', 'warning', 'INFO', 'DEBUG', 'TRACE', '', 'NOTICE', '{"a":1}'].map(of),
			['error', 'error', 'warn', 'warn', 'info', 'debug', 'debug', 'other', 'other', 'other']);
	});

	test('LEVELS: a row is kept only when its level is shown; no level shown keeps nothing', () => {
		assert.strictEqual(keeps({}), true);
		assert.strictEqual(keeps({ levels: ['error', 'warn'] }), false);
		assert.strictEqual(keeps({ levels: ['other'] }, row({ level: '', raw: true, fields: [] })), true, 'a raw value is Other');
		assert.strictEqual(keeps({ levels: [] }), false);
	});

	test('SEARCH: plain text, case-insensitive, in the message, the level, the instance, a field\'s name or value', () => {
		assert.strictEqual(keeps({ text: 'GENERATE' }), true, 'the message');
		assert.strictEqual(keeps({ text: 'info' }), true, 'the level');
		assert.strictEqual(keeps({ text: 'c1gjg' }), true, 'the instance');
		assert.strictEqual(keeps({ text: 'label' }), true, 'a field\'s name');
		assert.strictEqual(keeps({ text: 'connect.yaml' }), true, 'a field\'s value');
		assert.strictEqual(keeps({ text: 'secret' }), false);
		assert.strictEqual(keeps({ text: 'type gen' }), true, 'within one text');
		assert.strictEqual(keeps({ text: 'active /config' }), false, 'not across two texts');
		assert.strictEqual(keeps({ text: 'a.e' }), false, 'plain text: the dot is a dot');
	});

	test('CASE_REGEX: Match case; a regular expression; an invalid one is refused', () => {
		assert.strictEqual(keeps({ text: 'input', matchCase: true }), false);
		assert.strictEqual(keeps({ text: 'Input', matchCase: true }), true);
		assert.strictEqual(keeps({ text: 'fail(ed)?', regex: true }, row({ message: 'output FAILED' })), true);
		assert.strictEqual(keeps({ text: 'fail(ed)?', regex: true, matchCase: true }, row({ message: 'output FAILED' })), false);
		assert.strictEqual(keeps({ text: '^Input .* active$', regex: true }), true);
		assert.strictEqual(compileFilter({ ...NO_FILTER, text: '(', regex: true }), undefined);
		assert.ok(compileFilter({ ...NO_FILTER, text: '(' }), 'plain text: "(" is a character');
		assert.strictEqual(parseLogFilter({ ...NO_FILTER, text: '(', regex: true }), undefined, 'the host refuses it too');
	});

	test('SLOW: a quantified group holding a quantifier or an alternation is refused, at the box and on the host; plain text never', () => {
		for (const p of ['(a+)+', '(a*)*', '(a|aa)+', '(?:x{2,})*', '((ab)+c)+', '(a+){2,}', '(?<n>\\w+)*$', '^(\\d+\\s?)+$']) {
			assert.strictEqual(slowPattern(p), true, p);
			assert.strictEqual(searchError({ text: p, matchCase: false, regex: true }), SLOW_PATTERN_ERROR, p);
			assert.strictEqual(compileFilter({ ...NO_FILTER, text: p, regex: true }), undefined, p);
			assert.strictEqual(parseLogFilter({ ...NO_FILTER, text: p, regex: true }), undefined, `${p}: the host refuses it`);
			assert.strictEqual(searchError({ text: p, matchCase: false, regex: false }), undefined, `${p} as plain text`);
		}
		for (const p of ['fail(ed)?', 'a+b*', '(ab)+', '(a+)?', '[(a+)+]', '\\(a+\\)+', 'x{2}', '(?:error) .*', '(a|b)']) {
			assert.strictEqual(slowPattern(p), false, p);
		}
	});

	test('SLOW: at most the first 10,000 characters of each value are searched', () => {
		const long = `${'x'.repeat(MAX_MATCH_CHARS)}needle`;
		assert.strictEqual(keeps({ text: 'needle' }, row({ message: long })), false);
		assert.strictEqual(keeps({ text: 'needle' }, row({ message: `${'x'.repeat(MAX_MATCH_CHARS - 6)}needle` })), true);
		assert.strictEqual(keeps({ text: 'needle' }, row({ fields: [['big', long], ['small', 'needle']] })), true);
	});

	test('FIELD_FILTER: a chip keeps rows whose field holds that value; instance_id is the instance column', () => {
		assert.strictEqual(keeps({ fields: [[INSTANCE_FIELD, 'd3ugjmtpsedhm3e7c1gjg']] }), true);
		assert.strictEqual(keeps({ fields: [[INSTANCE_FIELD, 'another']] }), false);
		assert.strictEqual(keeps({ fields: [['label', 'gen']] }), true);
		assert.strictEqual(keeps({ fields: [['label', 'ge']] }), false, 'the whole value');
		assert.strictEqual(keeps({ fields: [['label', 'gen'], ['path', 'x']] }), false, 'every chip');
	});

	test('COMBINED: levels, search and chips together', () => {
		const warn = row({ level: 'WARN', message: 'secret rotated' });
		assert.strictEqual(keeps({ levels: ['warn'], text: 'secret', fields: [['label', 'gen']] }, warn), true);
		assert.strictEqual(keeps({ levels: ['warn'], text: 'secret', fields: [['label', 'other']] }, warn), false);
		assert.strictEqual(keeps({ levels: ['warn'], text: 'secret', fields: [['label', 'gen']] }, row({ message: 'secret rotated' })), false);
	});

	test('sameFilter and filterActive: Match case and .* count only with a search; the levels\' order does not', () => {
		assert.strictEqual(sameFilter(NO_FILTER, { ...NO_FILTER, matchCase: true, regex: true }), true);
		assert.strictEqual(sameFilter({ ...NO_FILTER, text: 'a' }, { ...NO_FILTER, text: 'a', matchCase: true }), false);
		assert.strictEqual(sameFilter({ ...NO_FILTER, levels: ['warn', 'error'] }, { ...NO_FILTER, levels: ['error', 'warn'] }), true);
		assert.strictEqual(sameFilter(NO_FILTER, { ...NO_FILTER, fields: [['a', 'b']] }), false);
		assert.strictEqual(filterActive(NO_FILTER), false);
		assert.strictEqual(filterActive({ ...NO_FILTER, matchCase: true }), false);
		assert.strictEqual(filterActive({ ...NO_FILTER, levels: ['error'] }), true);
		assert.strictEqual(filterActive({ ...NO_FILTER, text: 'x' }), true);
	});

	test('parseLogFilter: the levels in their order, known and once; strings and booleans; at most 20 chips', () => {
		assert.deepStrictEqual(parseLogFilter({ ...NO_FILTER, levels: ['warn', 'error'] })?.levels, ['error', 'warn']);
		assert.strictEqual(parseLogFilter({ ...NO_FILTER, levels: ['loud'] }), undefined);
		assert.strictEqual(parseLogFilter({ ...NO_FILTER, levels: ['info', 'info'] }), undefined);
		assert.strictEqual(parseLogFilter({ ...NO_FILTER, matchCase: 'yes' }), undefined);
		assert.strictEqual(parseLogFilter({ ...NO_FILTER, fields: [['a', 1]] }), undefined);
		assert.strictEqual(parseLogFilter({ ...NO_FILTER, fields: Array.from({ length: 21 }, (_, i) => ['k', String(i)]) }), undefined);
		assert.strictEqual(parseLogFilter({ ...NO_FILTER, text: 'x'.repeat(1001) }), undefined);
	});

	test('Counter: per level, every record, those matching', () => {
		const c = new Counter();
		c.add(row(), true);
		c.add(row({ level: 'WARN' }), false);
		c.add(row({ level: '' }), false);
		assert.deepStrictEqual(c.counts, { levels: { error: 0, warn: 1, info: 1, debug: 0, other: 1 }, total: 3, matched: 1 });
	});
});
