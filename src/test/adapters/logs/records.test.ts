import * as assert from 'assert';
import type { LogRecord } from '../../../adapters/logs/logReader';
import { isPipelineRecord, licenseOrgOf, maskOrgs, parseLogTime, toLogRow } from '../../../adapters/logs/records';
import { CREDENTIAL_MASK } from '../../../adapters/cloud/errors';

const PIPELINE = 'd3ugjmtpsedhm3e7fp1g';
const record = (value: unknown, extra: Partial<LogRecord> = {}): LogRecord => ({
	partition: 0, offset: 4703, timestamp: Date.UTC(2026, 10, 5, 16, 49, 16, 511), key: PIPELINE,
	value: typeof value === 'string' ? value : JSON.stringify(value), ...extra,
});

// What the Pipeline Logs tab shows of a record (ticket 6.2, AD-24; the shapes of spike 6.1's captures 32 and 39).
suite('Pipeline log records (ticket 6.2)', () => {
	test('ONLY_THIS: a pipeline\'s records are those keyed by its id', () => {
		assert.strictEqual(isPipelineRecord(record({}), PIPELINE), true);
		assert.strictEqual(isPipelineRecord(record({}, { key: 'another0000000000000' }), PIPELINE), false);
		assert.strictEqual(isPipelineRecord(record({ pipeline_id: PIPELINE }, { key: null }), PIPELINE), false, 'by the key, not the value');
	});

	test('RECORD: time, level, message, instance; the further fields after them in order; pipeline_id left out; the whole value as JSON', () => {
		const value = {
			benthos_version: '4.116.0', instance_id: 'inst-1', level: 'info', message: 'Running main config from specified file',
			path: '/config/connect.yaml', pipeline_id: PIPELINE, time: '2026-11-05T16:49:15.510619696Z', label: 'gen', n: 3, ok: true, nested: { a: [1] },
		};
		const row = toLogRow(record(value));
		assert.deepStrictEqual(row, {
			id: '0:4703',
			time: Date.UTC(2026, 10, 5, 16, 49, 15, 510),
			level: 'INFO',
			message: 'Running main config from specified file',
			instance: 'inst-1',
			fields: [['benthos_version', '4.116.0'], ['path', '/config/connect.yaml'], ['label', 'gen'], ['n', '3'], ['ok', 'true'], ['nested', '{"a":[1]}']],
			json: JSON.stringify(value, null, 2),
		});
	});

	test('RECORD: license_org is never shown, as a field or anywhere else in the record; license_type and expires_at are', () => {
		const org = '7f0c1d2e-3a4b-5c6d-7e8f-9a0b1c2d3e4f';
		const row = toLogRow(record({ level: 'INFO', message: `Successfully loaded Redpanda license for ${org}`, license_org: org, license_type: 'enterprise', expires_at: '2027-01-01T00:00:00Z', note: org }));
		assert.ok(!JSON.stringify(row).includes(org));
		assert.ok(!row.fields.some(([k]) => k === 'license_org'));
		assert.deepStrictEqual(row.fields, [['license_type', 'enterprise'], ['expires_at', '2027-01-01T00:00:00Z'], ['note', CREDENTIAL_MASK]]);
		assert.strictEqual(row.message, `Successfully loaded Redpanda license for ${CREDENTIAL_MASK}`);
		// Ticket 6.4: the whole JSON as shown: license_org left out, its value masked elsewhere, the types kept.
		assert.deepStrictEqual(JSON.parse(row.json!), { level: 'INFO', message: `Successfully loaded Redpanda license for ${CREDENTIAL_MASK}`, license_type: 'enterprise', expires_at: '2027-01-01T00:00:00Z', note: CREDENTIAL_MASK });
	});

	test('JSON: a password and a license_org with `"` and `\\` in them are masked in the JSON too, not only in the escaped text', () => {
		const password = 'pa"ss\\word\n1';
		const org = 'org"with\\slash';
		const mask = (t: string) => t.split(password).join(CREDENTIAL_MASK);
		const row = toLogRow(record({ level: 'INFO', message: `quoting ${password}`, license_org: org, nested: { [password]: [password, `licensed to ${org}`] }, note: org }), mask);
		const escaped = (v: string) => JSON.stringify(v).slice(1, -1);
		for (const secret of [password, org]) {
			assert.ok(!row.json!.includes(secret) && !row.json!.includes(escaped(secret)), `${secret} in ${row.json}`);
			assert.ok(!JSON.stringify(row.fields).includes(escaped(secret)) && !row.fields.some(([k, v]) => k.includes(secret) || v.includes(secret) || v.includes(escaped(secret))), `${secret} in a field's text`);
		}
		assert.deepStrictEqual(row.fields.find(([k]) => k === 'nested'), ['nested', JSON.stringify({ [CREDENTIAL_MASK]: [CREDENTIAL_MASK, `licensed to ${CREDENTIAL_MASK}`] })]);
		assert.deepStrictEqual(JSON.parse(row.json!), {
			level: 'INFO', message: `quoting ${CREDENTIAL_MASK}`, nested: { [CREDENTIAL_MASK]: [CREDENTIAL_MASK, `licensed to ${CREDENTIAL_MASK}`] }, note: CREDENTIAL_MASK,
		});
	});

	test('RECORD: a license_org seen once is masked in every later record that quotes it without the field, and in other text', () => {
		const org = '0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d';
		const orgs = new Set<string>();
		toLogRow(record({ level: 'INFO', message: 'Successfully loaded Redpanda license', license_org: org }), undefined, orgs);
		assert.deepStrictEqual([...orgs], [org]);
		const later = toLogRow(record({ level: 'INFO', message: `licensed to ${org}`, who: org }, { offset: 4704 }), undefined, orgs);
		assert.ok(!JSON.stringify(later).includes(org), JSON.stringify(later));
		assert.strictEqual(later.message, `licensed to ${CREDENTIAL_MASK}`);
		assert.ok(!JSON.stringify(toLogRow(record(`raw ${org}`), undefined, orgs)).includes(org), 'a raw value too');
		assert.strictEqual(maskOrgs(`stopped: ${org}`, orgs), `stopped: ${CREDENTIAL_MASK}`);
		assert.strictEqual(licenseOrgOf(record({ license_org: org })), org);
		assert.strictEqual(licenseOrgOf(record('license_org is not JSON')), undefined);
	});

	test('RECORD: a value that is not a JSON object is shown as text, at the record\'s timestamp', () => {
		for (const value of ['plain text line', '[1,2]', '42']) {
			const row = toLogRow(record(value));
			assert.deepStrictEqual(row, { id: '0:4703', time: Date.UTC(2026, 10, 5, 16, 49, 16, 511), level: '', message: value, instance: '', fields: [], raw: true }, value);
		}
		assert.strictEqual(toLogRow(record('', { value: null })).message, '');
	});

	test('RECORD: no or a bad time falls back to the record\'s timestamp; times with nanoseconds or an offset parse', () => {
		assert.strictEqual(toLogRow(record({ message: 'x' })).time, Date.UTC(2026, 10, 5, 16, 49, 16, 511));
		assert.strictEqual(toLogRow(record({ message: 'x', time: 'yesterday' })).time, Date.UTC(2026, 10, 5, 16, 49, 16, 511));
		assert.strictEqual(parseLogTime('2026-11-05T16:49:15.5Z'), Date.UTC(2026, 10, 5, 16, 49, 15, 500));
		assert.strictEqual(parseLogTime('2026-11-05T18:49:15.123456+02:00'), Date.UTC(2026, 10, 5, 16, 49, 15, 123));
		assert.strictEqual(parseLogTime(12), undefined);
	});

	test('NO_LEAK: every text passes the mask (message, fields, instance, level, a raw value)', () => {
		const mask = (t: string) => t.split('hunter22').join(CREDENTIAL_MASK);
		const row = toLogRow(record({ level: 'hunter22', message: 'pw hunter22', instance_id: 'hunter22', extra: 'hunter22', hunter22: 1 }), mask);
		assert.ok(!JSON.stringify(row).includes('hunter22'), JSON.stringify(row));
		assert.ok(!JSON.stringify(toLogRow(record('raw hunter22'), mask)).includes('hunter22'));
	});
	test('MASK_SHAPES (bug 52): a secret with `"` and `\\` in a value that is a JSON array, string or number, or plain text, is masked in every form', () => {
		const secret = 'pa"ss\\word';
		const digits = '98765432';
		const mask = (t: string) => t.split(secret).join(CREDENTIAL_MASK).split(digits).join(CREDENTIAL_MASK);
		const escaped = JSON.stringify(secret).slice(1, -1);
		const cases: [string, string][] = [
			[JSON.stringify([`array ${secret}`, { k: secret }, Number(digits)]), JSON.stringify([`array ${CREDENTIAL_MASK}`, { k: CREDENTIAL_MASK }, CREDENTIAL_MASK])],
			[JSON.stringify(`string ${secret}`), JSON.stringify(`string ${CREDENTIAL_MASK}`)],
			[digits, CREDENTIAL_MASK],
			[`plain ${secret}`, `plain ${CREDENTIAL_MASK}`],
		];
		for (const [value, message] of cases) {
			const row = toLogRow(record(value), mask);
			assert.strictEqual(row.message, message, value);
			assert.ok(!row.message.includes(secret) && !row.message.includes(escaped) && !row.message.includes(digits), row.message);
		}
		// An object's number field, in its field and its JSON.
		const row = toLogRow(record({ message: 'm', pin: Number(digits), ok: true }), mask);
		assert.deepStrictEqual(row.fields, [['pin', CREDENTIAL_MASK], ['ok', 'true']]);
		assert.deepStrictEqual(JSON.parse(row.json!), { message: 'm', pin: CREDENTIAL_MASK, ok: true });
		// Nothing masked: the text as written.
		assert.strictEqual(toLogRow(record('[1, 2]'), mask).message, '[1, 2]');
		assert.strictEqual(toLogRow(record('"quoted"'), mask).message, '"quoted"');
	});

	test('SHORT_PASSWORD (bug 52): a value under 4 characters is masked where a whole value, key, field or raw text equals it; text that only contains it is shown as is', () => {
		const exact = ['zq'];
		const row = toLogRow(record({ level: 'zq', message: 'zq', token: 'zq', zq: 1, nested: ['zq', 'zqzq', { a: 'zq' }], note: 'the zq', n: 12 }), undefined, new Set(), [...exact, '12']);
		assert.strictEqual(row.level, CREDENTIAL_MASK);
		assert.strictEqual(row.message, CREDENTIAL_MASK);
		assert.deepStrictEqual(row.fields, [
			['token', CREDENTIAL_MASK], [CREDENTIAL_MASK, '1'], ['nested', JSON.stringify([CREDENTIAL_MASK, 'zqzq', { a: CREDENTIAL_MASK }])], ['note', 'the zq'], ['n', CREDENTIAL_MASK],
		]);
		assert.ok(!/"zq"/.test(row.json!), row.json);
		assert.strictEqual(toLogRow(record('zq'), undefined, new Set(), exact).message, CREDENTIAL_MASK, 'a raw message');
		assert.strictEqual(toLogRow(record(JSON.stringify('zq')), undefined, new Set(), exact).message, JSON.stringify(CREDENTIAL_MASK), 'a JSON string');
		assert.strictEqual(toLogRow(record('zq zq'), undefined, new Set(), exact).message, 'zq zq', 'only contains it');
		assert.strictEqual(toLogRow(record('12'), undefined, new Set(), ['12']).message, CREDENTIAL_MASK, 'a JSON number');
	});
	test('LEVEL (bug 52): a level equal to a secret or a license_org is masked before it is upper-cased', () => {
		const mask = (t: string) => t.split('hunter22').join(CREDENTIAL_MASK);
		assert.strictEqual(toLogRow(record({ level: 'hunter22', message: 'm' }), mask).level, CREDENTIAL_MASK);
		const org = '0a1b2c3d-org';
		assert.strictEqual(toLogRow(record({ level: org, message: 'm' }), undefined, new Set([org])).level, CREDENTIAL_MASK);
		assert.strictEqual(toLogRow(record({ level: 'warn', message: 'm' }), mask).level, 'WARN');
	});
});
