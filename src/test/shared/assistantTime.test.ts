import * as assert from 'assert';
import { formatClock, formatDuration, turnTimeText } from '../../shared/assistantProtocol';

// Manual check 4 of story 8.12: how the assistant says a turn's and a step's time.
suite('assistant time formatting (story 8.12, manual check 4)', () => {
	test('under a minute "42s"; under an hour "1m 12s"; else "1h 3m"; whole seconds, rounded down', () => {
		assert.strictEqual(formatDuration(0), '0s');
		assert.strictEqual(formatDuration(999), '0s');
		assert.strictEqual(formatDuration(42_900), '42s');
		assert.strictEqual(formatDuration(60_000), '1m 0s');
		assert.strictEqual(formatDuration(72_000), '1m 12s');
		assert.strictEqual(formatDuration(3_599_999), '59m 59s');
		assert.strictEqual(formatDuration(3_780_000), '1h 3m');
		assert.strictEqual(formatDuration(-5), '0s');
	});

	test('the waiting part only from 1s; the running clock m:ss, then h:mm:ss', () => {
		assert.strictEqual(turnTimeText(72_000, 38_000), '1m 12s (38s waiting on you)');
		assert.strictEqual(turnTimeText(72_000, 999), '1m 12s');
		assert.strictEqual(formatClock(42_000), '0:42');
		assert.strictEqual(formatClock(725_000), '12:05');
		assert.strictEqual(formatClock(3_789_000), '1:03:09');
	});
});
