import * as assert from 'assert';
import { atLogStart, durationText, mergeOlder, olderWindowMs, rangeFor, RECENT_MS, RETENTION_UNKNOWN, retentionText } from '../../../adapters/logs/history';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../../../shared/logsProtocol';

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
});
