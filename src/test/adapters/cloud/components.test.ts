import * as assert from 'assert';
import type { CloudCall } from '../../../adapters/cloud/controlPlane';
import { getComponents } from '../../../adapters/cloud/dataPlane';
import { CloudError } from '../../../adapters/cloud/errors';
import type { FetchLike } from '../../../adapters/cloud/http';

type Answer = { status: number; body: unknown };

function recording(answers: Answer[]) {
	const sent: { method: string; url: string }[] = [];
	const fetch: FetchLike = async (url, init) => {
		sent.push({ method: init.method, url });
		const answer = answers.shift() ?? { status: 500, body: { code: 'UNKNOWN', message: 'no answer left' } };
		return { status: answer.status, ok: answer.status >= 200 && answer.status < 300, text: async () => JSON.stringify(answer.body) };
	};
	const call: CloudCall = { http: { fetch, log: () => undefined }, token: async () => 'tok-components-test' };
	return { call, sent };
}

// Ticket 8: what the cluster runs (AD-23 "Components", spike 5.1 capture 18).
suite('Cloud components (ticket 8, AD-23)', () => {
	test('getComponents: one GET; the version, the names per category and the Bloblang lists', async () => {
		const { call, sent } = recording([{ status: 200, body: { components: {
			version: '4.115.0',
			inputs: [{ name: 'kafka', type: 'input', status: 'COMPONENT_STATUS_STABLE', config: { name: '', type: 'object', kind: 'scalar', children: [] } }],
			processors: [{ name: 'switch', config: { name: '', type: 'object', kind: 'array', children: [{ name: 'processors', type: 'processor', kind: 'array', children: [] }] } }],
			rate_limits: [{ name: 'local' }],
			bloblang_functions: [{ name: 'now' }],
			bloblang_methods: [{ name: 'uppercase' }],
		} } }]);
		const c = await getComponents(call, 'https://dp.example/');
		assert.deepStrictEqual(sent, [{ method: 'GET', url: 'https://dp.example/v1/redpanda-connect/components' }]);
		assert.strictEqual(c.version, '4.115.0');
		assert.deepStrictEqual([...c.names].map(([k, v]) => [k, [...v]]), [['input', ['kafka']], ['processor', ['switch']], ['rate_limit', ['local']]]);
		assert.deepStrictEqual([...c.functions!], ['now']);
		assert.deepStrictEqual([...c.methods!], ['uppercase']);
		assert.strictEqual(c.catalogue.categories.get('processor')!.slots.get('switch')![0].kind, 'list');
	});

	test('getComponents: an answer without components is an error; an API error is a CloudError', async () => {
		await assert.rejects(getComponents(recording([{ status: 200, body: {} }]).call, 'https://dp.example'), /without its components/);
		await assert.rejects(getComponents(recording([{ status: 403, body: { code: 'PERMISSION_DENIED', message: 'not allowed' } }]).call, 'https://dp.example'),
			(err: unknown) => err instanceof CloudError && err.status === 403 && /not allowed/.test(err.message));
	});
});
