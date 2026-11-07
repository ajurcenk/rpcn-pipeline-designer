import * as assert from 'assert';
import { atLogStart, durationText, mergeOlder, olderWindowMs, rangeFor, RECENT_MS, RETENTION_UNKNOWN, retentionText, stripSpan } from '../../../adapters/logs/history';
import {
	DAY_MS, HOUR_MS, MINUTE_MS, slotBounds, slotLabel, slotOf, slotSize, slotSizeText, slotTimeText, SLOT_SIZES_MS, stripLayout,
} from '../../../shared/logsProtocol';

// The history rules of the Pipeline Logs panel (ticket 6.3): the times each range reads, the Load
// older window, how older rows join the kept ones under the cap, the log's start, the retention line.

const NOW = Date.UTC(2026, 10, 5, 18, 0);

suite('Pipeline logs history rules (ticket 6.3)', () => {
	test('rangeFor: the live ranges go on (to null); the last hour, 24 hours, 7 days end now; Since the last deploy needs its time', () => {
		assert.deepStrictEqual(rangeFor({ kind: 'live' }, NOW), { kind: 'live', from: NOW, to: null });
		assert.deepStrictEqual(rangeFor({ kind: 'recent' }, NOW), { kind: 'recent', from: NOW - 15 * MINUTE_MS, to: null });
		assert.deepStrictEqual(rangeFor({ kind: 'hour' }, NOW), { kind: 'hour', from: NOW - HOUR_MS, to: NOW });
		assert.deepStrictEqual(rangeFor({ kind: 'day' }, NOW), { kind: 'day', from: NOW - DAY_MS, to: NOW });
		assert.deepStrictEqual(rangeFor({ kind: 'week' }, NOW), { kind: 'week', from: NOW - 7 * DAY_MS, to: NOW });
		assert.deepStrictEqual(rangeFor({ kind: 'deploy' }, NOW, NOW - 3 * HOUR_MS), { kind: 'deploy', from: NOW - 3 * HOUR_MS, to: null });
		assert.strictEqual(rangeFor({ kind: 'deploy' }, NOW), undefined);
		assert.deepStrictEqual(rangeFor({ kind: 'recent' }, NOW, undefined, 5_000), { kind: 'recent', from: NOW - 5_000, to: null }, 'the test seam\'s look back');
	});

	test('rangeFor custom: From to To; To before From, or From in the future, is refused', () => {
		assert.deepStrictEqual(rangeFor({ kind: 'custom', from: NOW - DAY_MS, to: NOW - HOUR_MS }, NOW), { kind: 'custom', from: NOW - DAY_MS, to: NOW - HOUR_MS });
		assert.strictEqual(rangeFor({ kind: 'custom', from: NOW - HOUR_MS, to: NOW - DAY_MS }, NOW), undefined);
		assert.strictEqual(rangeFor({ kind: 'custom', from: NOW + 1, to: NOW + HOUR_MS }, NOW), undefined);
		assert.strictEqual(rangeFor({ kind: 'custom', from: NOW - HOUR_MS }, NOW), undefined);
		assert.deepStrictEqual(rangeFor({ kind: 'custom', from: NOW - HOUR_MS, to: NOW + HOUR_MS }, NOW)?.to, NOW + HOUR_MS, 'To may be later than now');
	});

	test('olderWindowMs: the range\'s length, 15 minutes for the live ones, never shorter', () => {
		assert.strictEqual(olderWindowMs({ kind: 'recent', from: NOW - RECENT_MS, to: null }, NOW), RECENT_MS);
		assert.strictEqual(olderWindowMs({ kind: 'live', from: NOW, to: null }, NOW), RECENT_MS);
		assert.strictEqual(olderWindowMs({ kind: 'day', from: NOW - DAY_MS, to: NOW }, NOW), DAY_MS);
		assert.strictEqual(olderWindowMs({ kind: 'deploy', from: NOW - 2 * HOUR_MS, to: null }, NOW), 2 * HOUR_MS);
		assert.strictEqual(olderWindowMs({ kind: 'custom', from: NOW - MINUTE_MS, to: NOW }, NOW), RECENT_MS);
	});

	test('mergeOlder: older rows before the kept; over the cap the newest of the older ones are taken, then the newest of the whole dropped', () => {
		assert.deepStrictEqual(mergeOlder([1, 2], [3, 4], 10), { rows: [1, 2, 3, 4], leftOut: 0, newerDropped: 0 });
		assert.deepStrictEqual(mergeOlder([1, 2, 3], [4, 5], 4), { rows: [1, 2, 3, 4], leftOut: 0, newerDropped: 1 });
		assert.deepStrictEqual(mergeOlder([1, 2, 3, 4, 5], [6, 7], 3), { rows: [3, 4, 5], leftOut: 2, newerDropped: 2 });
		assert.deepStrictEqual(mergeOlder([], [1], 3), { rows: [1], leftOut: 0, newerDropped: 0 });
	});

	test('atLogStart: every partition started at (or below) its first offset', () => {
		assert.strictEqual(atLogStart(new Map([[0, 10], [1, 4]]), new Map([[0, 10], [1, 4]])), true);
		assert.strictEqual(atLogStart(new Map([[0, 10], [1, 5]]), new Map([[0, 10], [1, 4]])), false);
		assert.strictEqual(atLogStart(new Map([[0, 10]]), new Map([[0, 10], [1, 4]])), false, 'a partition not read');
	});

	test('retentionText: from retention.ms; refused or unreadable: within the topic\'s retention; -1: no limit', () => {
		assert.strictEqual(retentionText(604_800_000), 'Records older than 7 days are gone (the topic\'s retention).');
		assert.strictEqual(retentionText(6 * HOUR_MS), 'Records older than 6 hours are gone (the topic\'s retention).');
		assert.strictEqual(retentionText(undefined), RETENTION_UNKNOWN);
		assert.match(RETENTION_UNKNOWN, /within the topic's retention/);
		assert.strictEqual(retentionText(-1), 'The topic keeps its records with no time limit.');
		assert.strictEqual(durationText(DAY_MS), '1 day');
		assert.strictEqual(durationText(36 * HOUR_MS), '36 hours');
		assert.strictEqual(durationText(90 * MINUTE_MS), '1.5 hours');
		assert.strictEqual(durationText(45 * MINUTE_MS), '45 minutes');
	});

	// --- ticket 6.7: the records-per-time strip ---

	test('slotSize: the smallest of the fixed list giving at most 60 slots; past 60 days, whole days', () => {
		assert.deepStrictEqual(SLOT_SIZES_MS.map((m) => m / MINUTE_MS), [1, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440]);
		assert.strictEqual(slotSize(HOUR_MS), MINUTE_MS, 'SHORT_LONG: Last hour, 60 per minute');
		assert.strictEqual(slotSize(DAY_MS), 30 * MINUTE_MS, 'SLOTS: Last 24 hours, 48 per 30 minutes');
		assert.strictEqual(slotSize(7 * DAY_MS), 4 * HOUR_MS, 'SHORT_LONG: Last 7 days, 42 per 4 hours');
		assert.strictEqual(slotSize(10 * MINUTE_MS), MINUTE_MS);
		assert.strictEqual(slotSize(HOUR_MS + 1), 5 * MINUTE_MS);
		assert.strictEqual(slotSize(5 * HOUR_MS), 5 * MINUTE_MS);
		assert.strictEqual(slotSize(14 * DAY_MS), 6 * HOUR_MS, 'Load older doubled a week: re-slotted');
		assert.strictEqual(slotSize(30 * DAY_MS), 12 * HOUR_MS);
		assert.strictEqual(slotSize(60 * DAY_MS), DAY_MS);
		assert.strictEqual(slotSize(61 * DAY_MS), 2 * DAY_MS);
		assert.strictEqual(slotSize(0), MINUTE_MS);
	});

	test('stripLayout, slotOf and slotBounds: the start on a minute, one slot per size of the span; the last runs to the end', () => {
		const from = NOW - DAY_MS + 17_345;
		const day = stripLayout(from, NOW + 17_345);
		assert.deepStrictEqual(day, { start: NOW - DAY_MS, from, size: 30 * MINUTE_MS, count: 48, end: NOW + 17_345 });
		assert.strictEqual(stripLayout(NOW - HOUR_MS + 59_999, NOW + 59_999).count, 60);
		assert.strictEqual(stripLayout(NOW - 7 * DAY_MS, NOW).count, 42);
		assert.strictEqual(stripLayout(NOW, NOW).count, 1, 'an empty span: one slot');
		assert.strictEqual(slotOf(NOW - DAY_MS, day.start, day.size), 0);
		assert.strictEqual(slotOf(NOW - DAY_MS + 30 * MINUTE_MS, day.start, day.size), 1);
		assert.strictEqual(slotOf(NOW - DAY_MS - 1, day.start, day.size), -1);
		assert.deepStrictEqual(slotBounds(day, day.count, 0), { from, to: NOW - DAY_MS + 30 * MINUTE_MS - 1 }, 'the first from the range\'s start, not the minute before it');
		assert.deepStrictEqual(slotBounds(day, day.count, 47), { from: NOW - 30 * MINUTE_MS, to: NOW + 17_345 }, 'the last to the strip\'s end');
		// CLICK: a slot read as a range is slotted again: 30 minutes, 30 per minute.
		const slot = slotBounds(day, day.count, 10);
		assert.deepStrictEqual(stripLayout(slot.from, slot.to), { start: slot.from, from: slot.from, size: MINUTE_MS, count: 30, end: slot.to });
		// 10:00–16:01: 37 slots of 10 minutes; the last one is 16:00–16:01, not past what was read.
		const ten = new Date(2026, 10, 5, 10, 0).getTime();
		const odd = stripLayout(ten, ten + 6 * HOUR_MS + MINUTE_MS);
		assert.deepStrictEqual([odd.size, odd.count], [10 * MINUTE_MS, 37]);
		const last = slotBounds(odd, odd.count, 36);
		assert.deepStrictEqual(last, { from: ten + 6 * HOUR_MS, to: ten + 6 * HOUR_MS + MINUTE_MS });
		assert.strictEqual(slotLabel(last.from, last.to + 1, { total: 2, errors: 0, warns: 0, matched: 2 }, false), 'Nov 5 16:00–16:01: 2 records');
		assert.deepStrictEqual(slotBounds(odd, odd.count, 35), { from: ten + 5 * HOUR_MS + 50 * MINUTE_MS, to: ten + 6 * HOUR_MS - 1 });
		// Since the last deploy: the strip ends at the newest record; its last slot never runs into the future.
		const chosen = NOW - 2 * HOUR_MS;
		const deploy = stripSpan({ kind: 'deploy', from: NOW - 3 * HOUR_MS - 7_000, to: null }, chosen, undefined, undefined, NOW - 7 * MINUTE_MS)!;
		const live = stripLayout(deploy.from, deploy.end);
		const tail = slotBounds(live, live.count, live.count - 1);
		assert.strictEqual(tail.to, NOW - 7 * MINUTE_MS, 'to the newest record, not the slot\'s nominal end');
		assert.ok(slotBounds(live, live.count, 0).from === deploy.from, 'from the deploy');
		assert.ok(Array.from({ length: live.count }, (_, i) => slotBounds(live, live.count, i)).every((b) => b.from <= b.to && b.to <= deploy.end));
	});

	test('slotSizeText and the accessible name: the slot, its records, errors and warnings (when some), how many match with a filter', () => {
		assert.strictEqual(slotSizeText(MINUTE_MS), 'per minute');
		assert.strictEqual(slotSizeText(30 * MINUTE_MS), 'per 30 minutes');
		assert.strictEqual(slotSizeText(HOUR_MS), 'per hour');
		assert.strictEqual(slotSizeText(4 * HOUR_MS), 'per 4 hours');
		assert.strictEqual(slotSizeText(2 * DAY_MS), 'per 2 days');
		const at = new Date(2026, 10, 5, 14, 0).getTime();
		assert.strictEqual(slotTimeText(at, at + 30 * MINUTE_MS), 'Nov 5 14:00–14:30');
		assert.strictEqual(slotTimeText(at, at + 12 * HOUR_MS), 'Nov 5 14:00–Nov 6 02:00');
		assert.strictEqual(slotLabel(at, at + 30 * MINUTE_MS, { total: 120, errors: 3, warns: 1, matched: 120 }, false), 'Nov 5 14:00–14:30: 120 records, 3 errors, 1 warning');
		assert.strictEqual(slotLabel(at, at + 30 * MINUTE_MS, { total: 1, errors: 0, warns: 0, matched: 1 }, false), 'Nov 5 14:00–14:30: 1 record');
		assert.strictEqual(slotLabel(at, at + 30 * MINUTE_MS, { total: 0, errors: 0, warns: 0, matched: 0 }, true), 'Nov 5 14:00–14:30: no records');
		assert.strictEqual(slotLabel(at, at + 30 * MINUTE_MS, { total: 1_200, errors: 1, warns: 2, matched: 40 }, true), 'Nov 5 14:00–14:30: 1,200 records, 1 error, 2 warnings, 40 match');
	});

	test('stripSpan: none for the live ranges; a bounded range from its start (or Load older\'s oldest window) to its end; Since the last deploy to the newest of now and its records', () => {
		assert.strictEqual(stripSpan({ kind: 'live', from: NOW, to: null }, NOW), undefined);
		assert.strictEqual(stripSpan({ kind: 'recent', from: NOW - RECENT_MS, to: null }, NOW), undefined);
		assert.deepStrictEqual(stripSpan({ kind: 'day', from: NOW - DAY_MS, to: NOW }, NOW), { from: NOW - DAY_MS, end: NOW });
		assert.deepStrictEqual(stripSpan({ kind: 'day', from: NOW - DAY_MS, to: NOW }, NOW, NOW - 2 * DAY_MS), { from: NOW - 2 * DAY_MS, end: NOW }, 'LOAD_OLDER');
		assert.deepStrictEqual(stripSpan({ kind: 'custom', from: NOW - HOUR_MS, to: NOW - MINUTE_MS }, NOW), { from: NOW - HOUR_MS, end: NOW - MINUTE_MS });
		assert.deepStrictEqual(stripSpan({ kind: 'deploy', from: NOW - 3 * HOUR_MS, to: null }, NOW - HOUR_MS, undefined, undefined, NOW), { from: NOW - 3 * HOUR_MS, end: NOW });
		assert.deepStrictEqual(stripSpan({ kind: 'deploy', from: NOW - 3 * HOUR_MS, to: null }, NOW), { from: NOW - 3 * HOUR_MS, end: NOW });
	});
});
