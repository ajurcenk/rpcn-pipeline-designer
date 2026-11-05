import * as assert from 'assert';
import type { CloudCall } from '../../../adapters/cloud/controlPlane';
import { createSecret, listSecretNames } from '../../../adapters/cloud/dataPlane';
import { CloudError } from '../../../adapters/cloud/errors';
import type { FetchLike } from '../../../adapters/cloud/http';

type Answer = { status: number; body: unknown };

/** A fetch answering `answers` in order, recording each request. */
function recording(answers: Answer[]) {
	const sent: { method: string; url: string; body?: string }[] = [];
	const lines: string[] = [];
	const fetch: FetchLike = async (url, init) => {
		sent.push({ method: init.method, url, ...(init.body !== undefined ? { body: init.body } : {}) });
		const answer = answers.shift() ?? { status: 500, body: { code: 'UNKNOWN', message: 'no answer left' } };
		return { status: answer.status, ok: answer.status >= 200 && answer.status < 300, text: async () => JSON.stringify(answer.body) };
	};
	const call: CloudCall = { http: { fetch, log: (line) => lines.push(line) }, token: async () => 'tok-secrets-test' };
	return { call, sent, lines };
}

// Ticket 5.7: the cluster's secrets (AD-23, spike 5.1 §4).
suite('Cloud secrets (ticket 5.7, AD-23)', () => {
	test('listSecretNames follows next_page_token and keeps the ids', async () => {
		const { call, sent } = recording([
			{ status: 200, body: { secrets: [{ id: 'A', labels: {}, scopes: ['SCOPE_REDPANDA_CONNECT'] }, { id: 'B' }, { nope: 1 }, null], next_page_token: 'p 2' } },
			{ status: 200, body: { secrets: [{ id: 'C' }], next_page_token: '' } },
		]);
		const names = await listSecretNames(call, 'https://dp.example/');
		assert.deepStrictEqual([...names], ['A', 'B', 'C']);
		assert.deepStrictEqual(sent.map((s) => `${s.method} ${s.url}`), [
			'GET https://dp.example/v1/secrets?page_size=100',
			'GET https://dp.example/v1/secrets?page_size=100&page_token=p%202',
		]);
	});

	test('listSecretNames: at the page cap with a page token left, one log line says more exist', async () => {
		const answers = Array.from({ length: 20 }, (_, i) => ({ status: 200, body: { secrets: [{ id: `S${i}` }], next_page_token: `p${i + 1}` } }));
		const { call, sent, lines } = recording(answers);
		assert.strictEqual((await listSecretNames(call, 'https://dp.example', 'rpc-vilnius')).size, 20);
		assert.strictEqual(sent.length, 20);
		assert.deepStrictEqual(lines.filter((l) => !l.includes(' → ')), ['Redpanda Cloud: read the first 20 secrets of rpc-vilnius; more exist.']);
		const short = recording([{ status: 200, body: { secrets: [{ id: 'A' }], next_page_token: '' } }]);
		await listSecretNames(short.call, 'https://dp.example', 'rpc-vilnius');
		assert.ok(short.lines.every((l) => !l.includes('more exist')));
	});

	test('listSecretNames: an empty answer is no secret; an error is a CloudError', async () => {
		assert.deepStrictEqual([...await listSecretNames(recording([{ status: 200, body: {} }]).call, 'https://dp.example')], []);
		await assert.rejects(listSecretNames(recording([{ status: 403, body: { code: 'PERMISSION_DENIED', message: 'not allowed' } }]).call, 'https://dp.example'),
			(err: unknown) => err instanceof CloudError && err.status === 403 && /not allowed/.test(err.message));
	});

	test('createSecret sends the id, the Connect scope and the value base64-encoded; 201 is created', async () => {
		const { call, sent, lines } = recording([{ status: 201, body: { secret: { id: 'BROKER', labels: {}, scopes: ['SCOPE_REDPANDA_CONNECT'] } } }]);
		assert.strictEqual(await createSecret(call, 'https://dp.example', 'BROKER', 'brökér:9092"\\'), 'created');
		assert.strictEqual(sent.length, 1);
		assert.strictEqual(sent[0].method, 'POST');
		assert.strictEqual(sent[0].url, 'https://dp.example/v1/secrets');
		const body = JSON.parse(sent[0].body!);
		assert.deepStrictEqual(body, { id: 'BROKER', scopes: ['SCOPE_REDPANDA_CONNECT'], secret_data: Buffer.from('brökér:9092"\\', 'utf8').toString('base64') });
		assert.strictEqual(Buffer.from(body.secret_data, 'base64').toString('utf8'), 'brökér:9092"\\');
		assert.ok(lines.every((l) => !l.includes('brökér') && !l.includes(body.secret_data)), lines.join('\n'));
	});

	test('createSecret: 409 (created meanwhile) is exists; another error is thrown', async () => {
		assert.strictEqual(await createSecret(recording([{ status: 409, body: { code: 'ALREADY_EXISTS', message: 'secret already exists' } }]).call, 'https://dp.example', 'X', 'v'), 'exists');
		await assert.rejects(createSecret(recording([{ status: 400, body: { code: 'INVALID_ARGUMENT', message: 'bad id' } }]).call, 'https://dp.example', 'X', 'v'),
			(err: unknown) => err instanceof CloudError && err.status === 400 && /bad id/.test(err.message));
	});
});
