import * as assert from 'assert';
import {
	compareVersions, formatVersion, isRpkConnectNotInstalled, meetsMinimum, MIN_VERSION, parseVersion, parseVersionOutput,
} from '../../core/version';

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

suite('core/version parseVersion / formatVersion', () => {
	test('plain, v-prefixed and pre-release versions', () => {
		assert.deepStrictEqual(parseVersion('4.112.0'), { major: 4, minor: 112, patch: 0 });
		assert.deepStrictEqual(parseVersion('v4.100.0'), { major: 4, minor: 100, patch: 0 });
		assert.deepStrictEqual(parseVersion('4.113.0-rc.1'), { major: 4, minor: 113, patch: 0, prerelease: 'rc.1' });
	});

	test('rejects anything else', () => {
		for (const bad of ['', 'dev', '4.112', '4.112.0.1', 'V4.1.0', 'vv4.1.0', '4.112.0-', ' 4.112.0', '4.x.0']) {
			assert.strictEqual(parseVersion(bad), undefined, bad);
		}
	});

	test('formats without the v prefix', () => {
		assert.strictEqual(formatVersion(parseVersion('v4.100.0')!), '4.100.0');
		assert.strictEqual(formatVersion(parseVersion('4.113.0-rc1')!), '4.113.0-rc1');
		assert.strictEqual(formatVersion(MIN_VERSION), '4.100.0');
	});
});

suite('core/version compareVersions / meetsMinimum', () => {
	const v = (s: string) => parseVersion(s)!;

	test('numeric, not lexicographic, ordering', () => {
		assert.ok(compareVersions(v('4.100.0'), v('4.63.0')) > 0);
		assert.ok(compareVersions(v('4.9.0'), v('4.10.0')) < 0);
		assert.ok(compareVersions(v('5.0.0'), v('4.999.999')) > 0);
		assert.strictEqual(compareVersions(v('4.100.0'), v('v4.100.0')), 0);
	});

	test('a pre-release sorts below its release', () => {
		assert.ok(compareVersions(v('4.100.0-rc1'), v('4.100.0')) < 0);
		assert.ok(compareVersions(v('4.100.0'), v('4.100.0-rc1')) > 0);
		assert.ok(compareVersions(v('4.100.1-rc1'), v('4.100.0')) > 0);
	});

	test('pre-releases compare by SemVer identifier rules', () => {
		assert.ok(compareVersions(v('4.1.0-rc.2'), v('4.1.0-rc.10')) < 0);
		assert.ok(compareVersions(v('4.1.0-alpha'), v('4.1.0-beta')) < 0);
		assert.ok(compareVersions(v('4.1.0-1'), v('4.1.0-alpha')) < 0);
		assert.ok(compareVersions(v('4.1.0-rc'), v('4.1.0-rc.1')) < 0);
		assert.strictEqual(compareVersions(v('4.1.0-rc.1'), v('4.1.0-rc.1')), 0);
	});

	test('floor is 4.100.0', () => {
		assert.strictEqual(meetsMinimum(v('4.100.0')), true);
		assert.strictEqual(meetsMinimum(v('v4.100.0')), true);
		assert.strictEqual(meetsMinimum(v('4.112.0')), true);
		assert.strictEqual(meetsMinimum(v('4.63.0')), false);
		assert.strictEqual(meetsMinimum(v('4.99.9')), false);
		assert.strictEqual(meetsMinimum(v('4.100.0-rc1')), false);
	});
});

suite('core/version isRpkConnectNotInstalled', () => {
	test('detects the rpk hint', () => {
		assert.strictEqual(isRpkConnectNotInstalled(
			"cannot get connect version: rpk connect is not installed; run 'rpk connect install'\n\nUsage:\n"), true);
	});

	test('ignores normal version output', () => {
		assert.strictEqual(isRpkConnectNotInstalled('Version: 4.112.0\nDate: 2026-10-02T08:48:17Z\n'), false);
	});
});
