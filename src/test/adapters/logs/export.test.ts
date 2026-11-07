import * as assert from 'assert';
import type { LogRecord } from '../../../adapters/logs/logReader';
import { toLogRow } from '../../../adapters/logs/records';
import { exportedMessage, exportFileName, exportLine, exportText } from '../../../adapters/logs/export';
import { CREDENTIAL_MASK } from '../../../adapters/cloud/errors';

const PIPELINE = 'd3ugjmtpsedhm3e7fp1g';
const SECRET = 'pa"ss\\word-6-8';
const ORG = '7f0c1d2e-3a4b-5c6d-7e8f-9a0b1c2d3e4f';
const record = (value: unknown, extra: Partial<LogRecord> = {}): LogRecord => ({
	partition: 0, offset: 12, timestamp: Date.UTC(2026, 10, 6, 9, 30, 0, 250), key: PIPELINE,
	value: typeof value === 'string' ? value : JSON.stringify(value), ...extra,
});
const mask = (t: string) => t.split(SECRET).join(CREDENTIAL_MASK);

// Export… (ticket 6.8): the line format of the shown records.
suite('Pipeline log export (ticket 6.8)', () => {
	test('a JSON row: its value as shown, on one line, types and field order kept, pipeline_id kept; no partition, offset or timestamp added', () => {
		const value = { instance_id: 'inst-1', level: 'info', message: 'hello', pipeline_id: PIPELINE, time: '2026-11-06T09:29:59.123456789Z', n: 3, ok: true, nested: { a: [1, null] } };
		const line = exportLine(toLogRow(record(value)));
		assert.strictEqual(line, JSON.stringify(value));
		assert.ok(!line.includes('\n'));
		assert.ok(!/partition|offset|"timestamp"/.test(line));
	});

	test('MASKED: a secret value (quoted, escaped) and license_org: the line has the mask, no license_org, no secret, escaped or not', () => {
		const row = toLogRow(record({ level: 'WARN', message: `token ${SECRET}`, license_org: ORG, note: `for ${ORG}`, deep: { said: [SECRET] } }), mask);
		const line = exportLine(row);
		const parsed = JSON.parse(line) as Record<string, unknown>;
		assert.ok(!('license_org' in parsed));
		assert.strictEqual(parsed.message, `token ${CREDENTIAL_MASK}`);
		assert.deepStrictEqual(parsed.deep, { said: [CREDENTIAL_MASK] });
		for (const v of [SECRET, ORG, JSON.stringify(SECRET).slice(1, -1)]) {
			assert.ok(!line.includes(v), v);
		}
	});

	test('RAW: a value that is not a JSON object is {"time","message"} with its record time and its text, masked', () => {
		for (const raw of ['plain text', '[1,2]', '42', '"a string"']) {
			const row = toLogRow(record(`${raw}`), mask);
			assert.strictEqual(exportLine(row), JSON.stringify({ time: '2026-11-06T09:30:00.250Z', message: raw }));
		}
		const masked = exportLine(toLogRow(record(`said ${SECRET}`), mask));
		assert.strictEqual(masked, JSON.stringify({ time: '2026-11-06T09:30:00.250Z', message: `said ${CREDENTIAL_MASK}` }));
		assert.strictEqual(exportLine(toLogRow(record(null, { value: null }))), JSON.stringify({ time: '2026-11-06T09:30:00.250Z', message: '' }));
	});

	test('exportText: a line per row in the order given, each ending in a line break; none for no rows', () => {
		const rows = [toLogRow(record({ message: 'a' }, { offset: 1 })), toLogRow(record('b', { offset: 2 }))];
		assert.strictEqual(exportText(rows), `{"message":"a"}\n{"time":"2026-11-06T09:30:00.250Z","message":"b"}\n`);
		assert.strictEqual(exportText([]), '');
	});

	test('exportFileName: <pipeline>-<yyyymmdd-hhmm>.jsonl in local time; characters a file name may not hold become -', () => {
		const at = new Date(2026, 10, 6, 9, 5, 59).getTime();
		assert.strictEqual(exportFileName('orders', at), 'orders-20261106-0905.jsonl');
		assert.strictEqual(exportFileName('my pipe/line: v2', at), 'my-pipe-line-v2-20261106-0905.jsonl');
		assert.strictEqual(exportFileName('../..', at), 'pipeline-20261106-0905.jsonl');
		assert.strictEqual(exportFileName('', at), 'pipeline-20261106-0905.jsonl');
	});

	test('exportedMessage: the count and the file; the records left out for the cap', () => {
		assert.strictEqual(exportedMessage(120, 'orders.jsonl', 0, 0, 5000), 'Exported 120 records to orders.jsonl.');
		assert.strictEqual(exportedMessage(1, 'o.jsonl', 0, 0, 5000), 'Exported 1 record to o.jsonl.');
		assert.strictEqual(exportedMessage(5000, 'o.jsonl', 1000, 0, 5000),
			'Exported 5,000 records to o.jsonl. 1,000 older records were left out for the 5,000-record limit.');
		assert.strictEqual(exportedMessage(5000, 'o.jsonl', 1, 2, 5000),
			'Exported 5,000 records to o.jsonl. 1 older record was left out for the 5,000-record limit. 2 newer records were dropped for the 5,000-record limit.');
	});
});
