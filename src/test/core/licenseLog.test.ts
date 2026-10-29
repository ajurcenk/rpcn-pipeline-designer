import * as assert from 'assert';
import { licenseExpiryDate, parseLogfmt, readLicenseLog } from '../../core/licenseLog';

// Ticket 38: the license line of a `run`'s startup log (probed 2026-10-29 on 4.100.0 and 4.112.0).
const LOADED = 'time="2026-10-29T18:59:26-04:00" level=info msg="Successfully loaded Redpanda license" @service=redpanda-connect expires_at="2027-03-09T15:18:26-05:00" license_org=acme-org license_type=enterprise';
const FAILED_STRING = 'time="2026-10-29T18:59:26-04:00" level=error msg="Failed to read Redpanda License" @service=redpanda-connect error="validating license: failed to split license contents by delimiter"';
const FAILED_FILE = 'time="2026-10-29T18:59:27-04:00" level=error msg="Failed to read Redpanda License" @service=redpanda-connect error="reading license file: open /nope: no such file or directory"';
const OTHER = [
	'time="2026-10-29T18:59:26-04:00" level=info msg="Running main config from specified file" @service=redpanda-connect benthos_version=v4.100.0 path=lic.yaml',
	'time="2026-10-29T18:59:26-04:00" level=info msg="Pipeline has terminated. Shutting down the service" @service=redpanda-connect',
];

suite('core/licenseLog', () => {
	test('logfmt: bare and quoted values, escapes, a key without a value', () => {
		const f = parseLogfmt('a=1 b="two words" c="q \\"x\\" \\\\ y" flag d=');
		assert.deepStrictEqual([...f], [['a', '1'], ['b', 'two words'], ['c', 'q "x" \\ y'], ['flag', ''], ['d', '']]);
	});

	test('LOADED: the type and expiry; the organisation is not read', () => {
		const read = readLicenseLog([OTHER[0], LOADED, OTHER[1]].join('\n'));
		assert.deepStrictEqual(read, { kind: 'loaded', licenseType: 'enterprise', expiresAt: '2027-03-09T15:18:26-05:00' });
		assert.ok(!JSON.stringify(read).includes('acme-org'));
	});

	test('FAILED: the binary\'s reason, for a bad string and a missing file', () => {
		assert.deepStrictEqual(readLicenseLog([OTHER[0], FAILED_STRING].join('\r\n')), {
			kind: 'failed', reason: 'validating license: failed to split license contents by delimiter',
		});
		assert.deepStrictEqual(readLicenseLog(FAILED_FILE), { kind: 'failed', reason: 'reading license file: open /nope: no such file or directory' });
	});

	test('NO_LINE: none for a log without a license line, an empty log, or a message that only mentions it', () => {
		assert.deepStrictEqual(readLicenseLog(OTHER.join('\n')), { kind: 'none' });
		assert.deepStrictEqual(readLicenseLog(''), { kind: 'none' });
		assert.deepStrictEqual(readLicenseLog('level=info msg="processing: Successfully loaded Redpanda license twice"'), { kind: 'none' });
	});

	test('the expiry as a date', () => {
		assert.strictEqual(licenseExpiryDate('2027-03-09T15:18:26-05:00'), '2027-03-09');
		assert.strictEqual(licenseExpiryDate('never'), 'never');
		assert.strictEqual(licenseExpiryDate(''), '');
	});
});
