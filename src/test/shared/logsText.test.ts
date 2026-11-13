import * as assert from 'assert';
import { countText, fileStamp, localMinute, localTime, matchCountText, pad, shortTime } from '../../shared/logsText';
import { leftOutHereText, slotLabel, slotSizeText, soFarText } from '../../shared/logsProtocol';

// Story 56 (story 50 group C): the Pipeline Logs panel's shared texts, each written once in
// `src/shared/logsText.ts`, pinned as the panel wrote them before, with the protocol's texts built on them
// (the adapters' and the panel's are pinned beside those modules' own tests).

/** A local time (the helpers read the local clock's fields). */
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo, d, h, mi, s, ms).getTime();

suite('Pipeline logs shared texts (story 56)', () => {
	test('countText: the en-US count and the noun, "one" only for exactly 1', () => {
		assert.strictEqual(countText(0, 'record'), '0 records');
		assert.strictEqual(countText(1, 'record'), '1 record');
		assert.strictEqual(countText(2140, 'record'), '2,140 records');
		assert.strictEqual(countText(1.5, 'day'), '1.5 days');
		assert.strictEqual(countText(1, 'record was', 'records were'), '1 record was');
		assert.strictEqual(countText(1_000, 'record was', 'records were'), '1,000 records were');
		assert.strictEqual(matchCountText(1), '1 matches');
		assert.strictEqual(matchCountText(3), '3 match');
		assert.strictEqual(matchCountText(1200), '1,200 match');
	});

	test('pad: leading zeros to the width (2 by default)', () => {
		assert.strictEqual(pad(5), '05');
		assert.strictEqual(pad(12), '12');
		assert.strictEqual(pad(60, 3), '060');
		assert.strictEqual(pad(510, 3), '510');
	});

	test('the local times: the minute, the millisecond, the short form, the file stamp', () => {
		const t = local(2026, 0, 2, 3, 4, 5, 60);
		assert.strictEqual(localMinute(t), '2026-01-02 03:04');
		assert.strictEqual(localTime(t), '2026-01-02 03:04:05.060');
		assert.strictEqual(shortTime(t), 'Jan 2 03:04');
		assert.strictEqual(fileStamp(t), '20260102-0304');
		const u = local(2026, 10, 15, 16, 49, 15, 510);
		assert.strictEqual(localMinute(u), '2026-11-15 16:49');
		assert.strictEqual(localTime(u), '2026-11-15 16:49:15.510');
		assert.strictEqual(shortTime(u), 'Nov 15 16:49');
		assert.strictEqual(fileStamp(u), '20261115-1649');
	});

	test('the protocol\'s texts built on them read as before', () => {
		assert.strictEqual(soFarText(1), '1 record so far');
		assert.strictEqual(soFarText(2140), '2,140 records so far');
		assert.strictEqual(leftOutHereText(1), '1 record left out here');
		assert.strictEqual(leftOutHereText(1200), '1,200 records left out here');
		assert.strictEqual(slotSizeText(60_000), 'per minute');
		assert.strictEqual(slotSizeText(30 * 60_000), 'per 30 minutes');
		assert.strictEqual(slotSizeText(60 * 60_000), 'per hour');
		assert.strictEqual(slotSizeText(4 * 60 * 60_000), 'per 4 hours');
		assert.strictEqual(slotSizeText(24 * 60 * 60_000), 'per day');
		assert.strictEqual(slotSizeText(2 * 24 * 60 * 60_000), 'per 2 days');
		const from = local(2026, 10, 5, 14, 0);
		assert.strictEqual(slotLabel(from, from + 30 * 60_000, { total: 1200, errors: 1, warns: 2, matched: 1 }, true), 'Nov 5 14:00–14:30: 1,200 records, 1 error, 2 warnings, 1 matches');
		assert.strictEqual(slotLabel(from, from + 30 * 60_000, { total: 1, errors: 0, warns: 0, matched: 3 }, true), 'Nov 5 14:00–14:30: 1 record, 3 match');
	});
});
