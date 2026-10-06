import * as assert from 'assert';
import { describeVersionResult } from '../adapters/redpandaConnect/version';

// Output-channel lines for the plan's I/O matrix rows NO_BINARY and BAD_OUTPUT.
suite('describeVersionResult (output channel lines)', () => {
	test('HAPPY_PATH: version and path', () => {
		assert.strictEqual(
			describeVersionResult({ kind: 'ok', path: '/bin/redpanda-connect', version: '4.112.0', source: 'path' }),
			'Redpanda Connect 4.112.0 (/bin/redpanda-connect)',
		);
	});

	test('NO_BINARY: setting empty and nothing on PATH', () => {
		const line = describeVersionResult({ kind: 'notFound', requested: 'redpanda-connect', source: 'path' });
		assert.match(line, /^No Redpanda Connect binary found/);
		assert.match(line, /"redpanda-connect" is not on PATH/);
	});

	test('NO_BINARY: configured path missing', () => {
		const line = describeVersionResult({ kind: 'notFound', requested: '/nope/redpanda-connect', source: 'setting' });
		assert.match(line, /^No Redpanda Connect binary found at redpandaConnect\.binaryPath "\/nope\/redpanda-connect"/);
	});

	test('BAD_OUTPUT: non-zero exit shows exit code and first stderr line', () => {
		const line = describeVersionResult({
			kind: 'failed', path: '/bin/rc', source: 'setting', exitCode: 3,
			stderrFirstLine: 'boom', reason: 'nonZeroExit',
		});
		assert.strictEqual(line, 'Redpanda Connect version check failed (/bin/rc): non-zero exit, exit code 3: boom');
	});

	test('BAD_OUTPUT: exit 0 without a Version line', () => {
		const line = describeVersionResult({
			kind: 'failed', path: '/bin/rc', source: 'path', exitCode: 0,
			stderrFirstLine: '', reason: 'noVersionLine',
		});
		assert.strictEqual(line, 'Redpanda Connect version check failed (/bin/rc): no "Version:" line in output, exit code 0');
	});
});
