import * as assert from 'assert';
import { compileFilter, Counter, INSTANCE_FIELD, levelOf, matches, sameFilter, SlotCounter } from '../../../adapters/logs/filter';
import { DAY_MS, HOUR_MS, MINUTE_MS, filterActive, MAX_MATCH_CHARS, NO_FILTER, parseLogFilter, searchError, searchPattern, slotBounds, SLOW_PATTERN_ERROR, slowPattern, type LogFilter, type LogRow } from '../../../shared/logsProtocol';

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

	// Bug 54: two repeats whose characters meet, with nothing required between them that neither can
	// match, are refused too; repeats of characters that cannot meet are not.
	const OVERLAP = ['.*.*.*x', '\\w+\\w+x', '.*\\d+x', '\\s*.*', 'a*a*x', '.*a*x', '.*a.*a.*b', 'error.*timeout.*retry', '.{1,100}.{1,100}.{1,100}x',
		'(?<n>.*)\\k<n>x', '(a).*\\1+', 'x*x*x*y', 'a+a+$', '(.*)?.*x', '(a*){5}x', '\\d*\\d{0,9}x', '.*(?=x).*', '(ab)+.*', '[a-z]+[^0-9]+x',
		// Case folding, lookarounds, escapes, non-ASCII, and chains of `?` and small ranges.
		'a*A*x', 'A+a+x', '(?=.*.*x)', '(?!\\w+\\w+x)', '\\w+(?=.*x)', '\\x61*a*x', '\\cJ*\\n*x', '[\\d-z]+1+x', '\\S+[^\\x00-\\x7f]+x', '[^é]+ü+x',
		'.*a?a?a?a?a?a?b', `${'a?'.repeat(18)}${'a'.repeat(18)}b`, `${'a{1,2}'.repeat(16)}b`, `${'(a|a)?'.repeat(18)}b`];
	const ACCEPTED_64 = ['fail(ed)?', 'a+b*', '(ab)+', '(a+)?', '[(a+)+]', '\\(a+\\)+', 'x{2}', '(?:error) .*', '(a|b)'];
	const ACCEPTED = ['^error$', '^Input .* active$', '[a-z]', '[^x]+', '\\d+', 'colou?r', '\\d{1,3}', '.{1000}', 'error.*timeout', '\\w+\\s+\\w+', '\\S+\\s+\\S+',
		'\\d+\\s*ms', '[A-Z]+\\s+[0-9]+', '\\d+\\.\\d+', '\\d+[a-z]+', '\\d{1,3}\\.\\d{1,3}', '(\\w+)\\s\\1', 'https?://\\S+', '[\\w.-]+@\\w+',
		'[^a-z]+[a-z]+', '[^a]+a+x', '\\d+\\1'];

	test('SLOW (bug 54): repeats that can meet are refused, at the box and on the host, with the same message; plain text never', () => {
		for (const p of OVERLAP) {
			assert.strictEqual(slowPattern(p), true, p);
			assert.strictEqual(searchError({ text: p, matchCase: false, regex: true }), SLOW_PATTERN_ERROR, p);
			assert.strictEqual(searchError({ text: p, matchCase: true, regex: true }), SLOW_PATTERN_ERROR, `${p} with Match case`);
			assert.strictEqual(compileFilter({ ...NO_FILTER, text: p, regex: true }), undefined, p);
			assert.strictEqual(parseLogFilter({ ...NO_FILTER, text: p, regex: true }), undefined, `${p}: the host refuses it`);
			assert.strictEqual(searchError({ text: p, matchCase: false, regex: false }), undefined, `${p} as plain text`);
		}
		for (const p of [...ACCEPTED_64, ...ACCEPTED]) {
			assert.strictEqual(slowPattern(p), false, p);
			assert.strictEqual(searchError({ text: p, matchCase: false, regex: true }), undefined, p);
			assert.ok(compileFilter({ ...NO_FILTER, text: p, regex: true }), p);
			assert.ok(parseLogFilter({ ...NO_FILTER, text: p, regex: true }), `${p}: the host takes it`);
		}
		assert.strictEqual(keeps({ text: '.*.*x' }, row({ message: 'a .*.*x b' })), true, 'plain text: searched literally');
		assert.strictEqual(keeps({ text: '.*.*x' }, row({ message: 'abx' })), false, 'plain text: no pattern');
		assert.strictEqual(keeps({ text: '\\w+\\s+\\w+', regex: true }), true, 'an accepted pattern matches as before');
		assert.strictEqual(keeps({ text: '\\d+\\s*ms', regex: true }, row({ message: 'took 12 ms' })), true);
	});

	test('SLOW (bug 54): every accepted pattern runs in under a second on 10,000-character worst-case values', function () {
		this.timeout(120_000);
		const literals = (p: string) => p.replace(/\\[dDwWsSbBk]|[\\^$.|?*+()[\]{}<>]/g, '') || 'a';
		for (const p of [...ACCEPTED_64, ...ACCEPTED]) {
			const values = ['a', ' ', '1', 'x', 'ab', 'aA1 _-.', 'é', literals(p)].map((unit) => unit.repeat(Math.ceil(MAX_MATCH_CHARS / unit.length)).slice(0, MAX_MATCH_CHARS));
			const compiled = compileFilter({ ...NO_FILTER, text: p, regex: true })!;
			for (const value of values) {
				const started = Date.now();
				matches(row({ message: value, level: '', instance: '', fields: [] }), compiled);
				const took = Date.now() - started;
				assert.ok(took < 1000, `${p} on ${JSON.stringify(value.slice(0, 7))}…: ${took} ms`);
			}
		}
	});

	test('SLOW (bug 54): a deeply nested pattern is checked fast; too deep, malformed or unclosed input does not throw', () => {
		for (const p of [`${'('.repeat(250)}a${')?'.repeat(250)}`, `${'(?:'.repeat(166)}a${'){2}'.repeat(166)}`]) {
			const started = Date.now();
			slowPattern(p);
			assert.ok(Date.now() - started < 100, `${p.length} characters: ${Date.now() - started} ms`);
		}
		for (const p of ['[a', 'a)', 'a\\', '(', '(?<n', '\\k<', `${'('.repeat(50_000)}a${')'.repeat(50_000)}`]) {
			assert.doesNotThrow(() => searchPattern(p, false, true), p.slice(0, 20));
		}
		assert.match(searchError({ text: '[a', matchCase: false, regex: true }) ?? '', /Invalid regular expression/);
		assert.match(searchError({ text: 'a)', matchCase: false, regex: true }) ?? '', /Invalid regular expression/);
		assert.match(searchError({ text: 'a\\', matchCase: false, regex: true }) ?? '', /\\ at end of pattern|Invalid regular expression/);
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

	test('SlotCounter (ticket 6.7): per slot every record, its errors and warnings, those matching; slotted again for a wider span; empty slots stay', () => {
		const t0 = Date.UTC(2026, 10, 5, 0, 0);
		const c = new SlotCounter();
		c.add(t0 + 5 * MINUTE_MS, 'info', true);
		c.add(t0 + 29 * MINUTE_MS + 59_999, 'error', false);
		c.add(t0 + 30 * MINUTE_MS, 'warn', true);
		c.add(t0 + 23 * HOUR_MS, 'debug', false);
		const day = c.strip(t0, t0 + DAY_MS);
		assert.strictEqual(day.size, 30 * MINUTE_MS);
		assert.strictEqual(day.total.length, 48);
		assert.deepStrictEqual([day.total[0], day.errors[0], day.warns[0], day.matched[0]], [2, 1, 0, 1]);
		assert.deepStrictEqual([day.total[1], day.errors[1], day.warns[1], day.matched[1]], [1, 0, 1, 1]);
		assert.strictEqual(day.total[46], 1);
		assert.strictEqual(day.total.filter((n) => n === 0).length, 45, 'EMPTY_SLOTS: still slots');
		assert.strictEqual(day.total.reduce((a, b) => a + b, 0), 4);
		// LOAD_OLDER: the span grows to 7 days; re-slotted per 4 hours, none lost.
		c.add(t0 - 6 * DAY_MS, 'info', true);
		const week = c.strip(t0 - 6 * DAY_MS, t0 + DAY_MS);
		assert.deepStrictEqual([week.size, week.total.length], [4 * HOUR_MS, 42]);
		assert.strictEqual(week.total.reduce((a, b) => a + b, 0), 5);
		assert.strictEqual(week.total[0], 1);
		assert.strictEqual(week.total[36], 3, 'the first 4 hours of t0');
		// Bug 53 STRIP_OUTSIDE: a record outside the span is in no bar (not clamped into an edge one).
		const hour = c.strip(t0, t0 + HOUR_MS);
		assert.strictEqual(hour.total.reduce((a, b) => a + b, 0), 3, 'the record 6 days before and the one 23 hours after are left out');
		assert.strictEqual(hour.total[0], 0, 'not the record 6 days before');
		assert.strictEqual(hour.total[5], 1);
		assert.strictEqual(hour.total[29], 1);
		assert.strictEqual(hour.total[30], 1);
		assert.strictEqual(hour.total[59], 0, 'not the record 23 hours after');
	});

	test('SlotCounter (bug 53): the minute the span ends in is in the last bar (it ends at the span\'s end); a minute after it is in none', () => {
		const t0 = Date.UTC(2026, 10, 5, 0, 0);
		const c = new SlotCounter();
		c.add(t0 + 10 * MINUTE_MS + 10_000, 'info', true);
		c.add(t0 + 11 * MINUTE_MS, 'info', true);
		// From mid-minute: 10 one-minute slots from t0 to t0+10m; the span ends at t0+10m30s.
		const s = c.strip(t0 + 30_000, t0 + 10 * MINUTE_MS + 30_000);
		assert.strictEqual(s.total.length, 10);
		assert.strictEqual(s.total[9], 1, 'the record at t0+10m10s, within the span');
		assert.strictEqual(s.total.reduce((a, b) => a + b, 0), 1, 'the record at t0+11m, after the span, in no bar');
	});

	test('SlotCounter (bug 53): the strip on whole minutes, its bars as for the span given; a record before `from` in its first minute and one after `end` in its last are counted, each inside its bar\'s times', () => {
		const t0 = Date.UTC(2026, 10, 5, 10, 0);
		const c = new SlotCounter();
		const before = t0 + 10_000;
		const after = t0 + 20 * MINUTE_MS + 50_000;
		c.add(before, 'info', true);
		c.add(after, 'info', true);
		const s = c.strip(t0 + 30_000, t0 + 20 * MINUTE_MS + 10_000);
		assert.deepStrictEqual([s.start, s.from, s.end], [t0, t0, t0 + 21 * MINUTE_MS - 1], 'from its first minute\'s start to its last minute\'s last millisecond');
		assert.strictEqual(s.total.length, 20, 'the bars of the span given, none added');
		assert.strictEqual(s.total.reduce((a, b) => a + b, 0), 2);
		for (const [t, i] of [[before, 0], [after, 19]] as const) {
			assert.strictEqual(s.total[i], 1, `${t} in bar ${i}`);
			const b = slotBounds(s, s.total.length, i);
			assert.ok(b.from <= t && t <= b.to, `${t} inside bar ${i}: ${b.from}–${b.to}`);
		}
		const day = c.strip(t0 + 30_000, t0 + DAY_MS + 30_000);
		assert.strictEqual(day.total.length, 48, 'Last 24 hours keeps its 48 bars');
	});
});
