import * as assert from 'assert';
import { parseVersionOutput } from '../../core/version';

suite('core/version parseVersionOutput', () => {
	test('parses 4.112.0 output', () => {
		assert.strictEqual(parseVersionOutput('Version: 4.112.0\nDate: 2026-10-02T08:48:17Z\n'), '4.112.0');
	});

	test('parses a v-prefixed version as printed', () => {
		assert.strictEqual(parseVersionOutput('Version: v4.100.0\nDate: 2026-07-15T14:30:13Z\n'), 'v4.100.0');
	});

	test('handles CRLF line endings', () => {
		assert.strictEqual(parseVersionOutput('Version: 4.100.0\r\nDate: x\r\n'), '4.100.0');
	});

	test('finds the Version line after other lines', () => {
		assert.strictEqual(parseVersionOutput('some banner\nVersion: 4.112.0\n'), '4.112.0');
	});

	test('returns undefined without a Version line', () => {
		assert.strictEqual(parseVersionOutput(''), undefined);
		assert.strictEqual(parseVersionOutput('Date: 2026-10-02T08:48:17Z\n'), undefined);
		assert.strictEqual(parseVersionOutput('  Version: 4.112.0'), undefined);
		assert.strictEqual(parseVersionOutput('Version: 4.112.0 extra'), undefined);
		assert.strictEqual(parseVersionOutput('Version:'), undefined);
	});
});
