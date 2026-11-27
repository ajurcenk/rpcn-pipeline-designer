import * as assert from 'assert';
import * as net from 'net';
import { ANTHROPIC_VERSION, classifyEndpointError, costMark, listModels, modelsOf, modelsUrl } from '../../../adapters/assistant/endpoint';
import { ADP_401, adp403Model, ANTHROPIC_401, FakeMessagesApi } from '../../helpers/fakeMessagesApi';

// Story 8.3: the assistant endpoint's test call (`GET /v1/models`), its error classifier (Anthropic's,
// ADP's and Claude Code's formats) and the cost marks, against a local fake (never a real endpoint).
suite('assistant endpoint (story 8.3)', () => {
	const KEY = 'Qz7wXkLp3mVt9rQs2NbHc8YdFg4JxWe6';

	suite('classifyEndpointError', () => {
		test('keyRefused: a 401 (Anthropic\'s body, ADP\'s body), authentication_error, UNAUTHENTICATED, Claude Code\'s texts', () => {
			assert.strictEqual(classifyEndpointError(401, ANTHROPIC_401.body).kind, 'keyRefused');
			assert.strictEqual(classifyEndpointError(401, ANTHROPIC_401.body).message, 'invalid x-api-key');
			assert.strictEqual(classifyEndpointError(401, ADP_401.body).kind, 'keyRefused');
			assert.strictEqual(classifyEndpointError(401, ADP_401.body).message, 'invalid api key');
			assert.strictEqual(classifyEndpointError(400, { type: 'error', error: { type: 'authentication_error', message: 'x' } }).kind, 'keyRefused');
			assert.strictEqual(classifyEndpointError(400, { code: 3, message: 'no', details: [{ reason: 'UNAUTHENTICATED' }] }).kind, 'keyRefused');
			assert.strictEqual(classifyEndpointError(undefined, undefined, 'Not logged in · Please run /login').kind, 'keyRefused');
			assert.strictEqual(classifyEndpointError(undefined, undefined, 'Invalid API key · Fix external API key').kind, 'keyRefused');
			assert.strictEqual(classifyEndpointError(undefined, undefined, 'The endpoint refused the request (HTTP 401, authentication_failed).').kind, 'keyRefused');
			assert.strictEqual(classifyEndpointError(undefined, undefined, `API Error: 401 ${JSON.stringify(ADP_401.body)}`).kind, 'keyRefused');
		});

		test('modelNotAllowed: a 403 with model_not_allowed or "model … is not allowed"; the model\'s name kept', () => {
			const adp = classifyEndpointError(403, adp403Model('claude-opus-5-5').body);
			assert.deepStrictEqual([adp.kind, adp.model, adp.status], ['modelNotAllowed', 'claude-opus-5-5', 403]);
			const text = classifyEndpointError(undefined, undefined, '403 model "x" is not allowed for provider "p"');
			assert.deepStrictEqual([text.kind, text.model, text.status], ['modelNotAllowed', 'x', 403]);
			const json = classifyEndpointError(undefined, undefined, `API Error: 403 ${JSON.stringify(adp403Model('claude-x-1').body)}`);
			assert.deepStrictEqual([json.kind, json.model], ['modelNotAllowed', 'claude-x-1']);
			assert.deepStrictEqual([classifyEndpointError(403, { error: { type: 'model_not_allowed', message: 'nope' } }).kind, classifyEndpointError(403, { error: { type: 'model_not_allowed', message: 'nope' } }).model], ['modelNotAllowed', null]);
		});

		test('forbidden: another 403, permission_error, PERMISSION_DENIED; with the endpoint\'s message', () => {
			const f = classifyEndpointError(403, { type: 'error', error: { type: 'permission_error', message: 'Your key cannot use this workspace' } });
			assert.deepStrictEqual([f.kind, f.message], ['forbidden', 'Your key cannot use this workspace']);
			assert.strictEqual(classifyEndpointError(403, 'Forbidden').kind, 'forbidden');
			assert.strictEqual(classifyEndpointError(400, { code: 7, message: 'denied' }).kind, 'forbidden');
			assert.strictEqual(classifyEndpointError(undefined, undefined, 'The endpoint refused the request (HTTP 403).').kind, 'forbidden');
		});

		test('unreachable: refused, no such host, TLS, a timeout; other: anything else, its message kept', () => {
			for (const text of ['connect ECONNREFUSED 127.0.0.1:1', 'getaddrinfo ENOTFOUND adp.example', 'self-signed certificate in certificate chain', 'timed out after 15 s',
				'API Error: Connection error.', 'Request timed out.', 'the proxy could not be reached: x']) {
				assert.strictEqual(classifyEndpointError(undefined, undefined, text).kind, 'unreachable', text);
			}
			const other = classifyEndpointError(500, { type: 'error', error: { type: 'api_error', message: 'Internal' } });
			assert.deepStrictEqual([other.kind, other.message, other.status], ['other', 'Internal', 500]);
			assert.strictEqual(classifyEndpointError(undefined, undefined, 'boom').kind, 'other');
			// A status in the text is an answer: a 5xx that mentions a timeout is no unreachable endpoint.
			const gateway = classifyEndpointError(undefined, undefined, 'API Error: 504 upstream request timeout');
			assert.deepStrictEqual([gateway.kind, gateway.status], ['other', 504]);
			assert.strictEqual(classifyEndpointError(undefined, undefined, 'No answer from the assistant for 2 s: the run was stopped.').kind, 'other');
		});
	});

	test('costMark: $$$ opus, $$ sonnet and fable, $ haiku, none otherwise', () => {
		assert.deepStrictEqual(['claude-opus-5-5', 'claude-sonnet-4-6', 'claude-fable-5-2', 'claude-haiku-5-5', 'my-alias'].map(costMark), ['$$$', '$$', '$$', '$', '']);
	});

	test('modelsUrl and modelsOf: the path kept; ids then display names; malformed items dropped', () => {
		assert.strictEqual(modelsUrl('https://adp.example/anthropic/').href, 'https://adp.example/anthropic/v1/models?limit=1000');
		assert.strictEqual(modelsUrl('https://api.anthropic.com').href, 'https://api.anthropic.com/v1/models?limit=1000');
		assert.deepStrictEqual(modelsOf({ data: [{ id: 'a', display_name: 'A' }, { id: 'b' }, { id: 3 }, null, { id: 'a' }] }), [{ id: 'a', displayName: 'A' }, { id: 'b', displayName: null }]);
		assert.deepStrictEqual(modelsOf('x'), []);
	});

	suite('listModels against a fake endpoint', () => {
		let fake: FakeMessagesApi;
		suiteSetup(async () => {
			fake = new FakeMessagesApi();
			await fake.start();
		});
		suiteTeardown(async () => fake.stop());
		setup(() => {
			fake.reset();
			fake.modelsFailure = undefined;
			fake.hang = false;
			fake.models = [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }];
		});

		test('200: the models; one GET with the key as a bearer token (or x-api-key) and anthropic-version; nothing else sent', async () => {
			const r = await listModels({ baseUrl: fake.url, auth: 'bearer', key: KEY });
			assert.ok(r.ok);
			assert.deepStrictEqual(r.models?.map((m) => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
			assert.strictEqual(r.models?.[0].displayName, 'Claude Opus 5.5');
			assert.deepStrictEqual(fake.requests.map((x) => [x.method, x.path]), [['GET', '/v1/models']]);
			assert.strictEqual(fake.requests[0].headers.authorization, `Bearer ${KEY}`);
			assert.strictEqual(fake.requests[0].headers['anthropic-version'], ANTHROPIC_VERSION);
			assert.strictEqual(fake.requests[0].headers['x-api-key'], undefined);
			fake.reset();
			assert.ok((await listModels({ baseUrl: fake.url, auth: 'x-api-key', key: KEY })).ok);
			assert.strictEqual(fake.requests[0].headers['x-api-key'], KEY);
			assert.strictEqual(fake.requests[0].headers.authorization, undefined);
		});

		test('an agentFor that throws (a bad proxy setting): resolves with the proxy\'s message; nothing sent', async () => {
			const r = await listModels({ baseUrl: fake.url, auth: 'bearer', key: KEY, agentFor: () => { throw new Error('the proxy scheme socks5:// is not supported'); } });
			assert.ok(!r.ok && r.failure.message.includes('the proxy scheme socks5:// is not supported'), JSON.stringify(r));
			assert.strictEqual(fake.requests.length, 0);
		});

		test('404: reachable, no model list (no failure); 401 (both formats): keyRefused', async () => {
			fake.modelsFailure = { status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'Not found' } } };
			assert.deepStrictEqual(await listModels({ baseUrl: fake.url, auth: 'bearer', key: KEY }), { ok: true, models: null });
			for (const failure of [ANTHROPIC_401, ADP_401]) {
				fake.modelsFailure = failure;
				const r = await listModels({ baseUrl: fake.url, auth: 'bearer', key: KEY });
				assert.ok(!r.ok && r.failure.kind === 'keyRefused' && r.failure.status === 401, JSON.stringify(r));
			}
		});

		test('a closed port: unreachable; a hung endpoint: unreachable after the timeout', async () => {
			const closed = await new Promise<number>((resolve) => {
				const s = net.createServer().listen(0, '127.0.0.1', () => {
					const port = (s.address() as net.AddressInfo).port;
					s.close(() => resolve(port));
				});
			});
			const r = await listModels({ baseUrl: `http://127.0.0.1:${closed}`, auth: 'bearer', key: KEY });
			assert.ok(!r.ok && r.failure.kind === 'unreachable', JSON.stringify(r));
			fake.hang = true;
			const started = Date.now();
			const hung = await listModels({ baseUrl: fake.url, auth: 'bearer', key: KEY, timeoutMs: 300 });
			assert.ok(!hung.ok && hung.failure.kind === 'unreachable' && /timed out/.test(hung.failure.message), JSON.stringify(hung));
			assert.ok(Date.now() - started < 5_000);
		});
	});
});
