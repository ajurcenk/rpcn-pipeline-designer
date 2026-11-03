import * as assert from 'assert';
import { CloudError, UNAUTHORIZED_MESSAGE } from '../../../adapters/cloud/errors';
import type { FetchLike } from '../../../adapters/cloud/http';
import { authorizedJson, TOKEN_REFUSED_MESSAGE } from '../../../adapters/cloud/controlPlane';
import { CLIENT_NAME_CLAIM, jwtClaims, TOKEN_AUDIENCE, TokenCache } from '../../../adapters/cloud/token';

const ACCOUNT = { clientId: 'client-a', clientSecret: 'secret-of-a-5-2' };

function jwt(claims: Record<string, unknown>): string {
	const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
	return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

interface Sent {
	readonly url: string;
	readonly body?: string;
	readonly headers: Record<string, string>;
}

function fakeFetch(answer: (n: number) => { status: number; body: unknown }): { fetch: FetchLike; sent: Sent[] } {
	const sent: Sent[] = [];
	const fetch: FetchLike = async (url, init) => {
		sent.push({ url, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
		const a = answer(sent.length);
		return { status: a.status, ok: a.status < 300, text: async () => JSON.stringify(a.body) };
	};
	return { fetch, sent };
}

suite('Cloud token cache (ticket 5.2, AD-23)', () => {
	test('requests a token with the client credentials form, once while it is valid', async () => {
		const token = jwt({ [CLIENT_NAME_CLAIM]: 'deploy-bot' });
		const { fetch, sent } = fakeFetch(() => ({ status: 200, body: { access_token: token, expires_in: 86400, token_type: 'Bearer' } }));
		let now = 1_000_000;
		const cache = new TokenCache({ fetch, authUrl: () => 'https://auth.example/', now: () => now });
		const first = await cache.get(ACCOUNT);
		assert.strictEqual(first.accessToken, token);
		assert.strictEqual(first.clientName, 'deploy-bot');
		assert.strictEqual(sent.length, 1);
		assert.strictEqual(sent[0].url, 'https://auth.example/oauth/token');
		assert.strictEqual(sent[0].headers['content-type'], 'application/x-www-form-urlencoded');
		const form = new URLSearchParams(sent[0].body);
		assert.deepStrictEqual(Object.fromEntries(form), {
			grant_type: 'client_credentials', client_id: ACCOUNT.clientId, client_secret: ACCOUNT.clientSecret, audience: TOKEN_AUDIENCE,
		});
		now += 60 * 60_000;
		await cache.get(ACCOUNT);
		await Promise.all([cache.get(ACCOUNT), cache.get(ACCOUNT)]);
		assert.strictEqual(sent.length, 1, 'cached for its lifetime');
		assert.strictEqual(cache.requests, 1);
	});

	test('a new token after expires_in less the margin; concurrent callers share one request', async () => {
		const { fetch, sent } = fakeFetch((n) => ({ status: 200, body: { access_token: `tok-${n}-xyz`, expires_in: 3600 } }));
		let now = 0;
		const cache = new TokenCache({ fetch, authUrl: () => 'https://auth.example', now: () => now, marginMs: 60_000 });
		await cache.get(ACCOUNT);
		now = 3600_000 - 60_000 - 1;
		assert.strictEqual((await cache.get(ACCOUNT)).accessToken, 'tok-1-xyz');
		now = 3600_000 - 60_000;
		const [a, b] = await Promise.all([cache.get(ACCOUNT), cache.get(ACCOUNT)]);
		assert.strictEqual(a.accessToken, 'tok-2-xyz');
		assert.strictEqual(b.accessToken, 'tok-2-xyz');
		assert.strictEqual(sent.length, 2);
	});

	test('one token per service account; clear drops it', async () => {
		const { fetch, sent } = fakeFetch((n) => ({ status: 200, body: { access_token: `tok-${n}-xyz`, expires_in: 86400 } }));
		const cache = new TokenCache({ fetch, authUrl: () => 'https://auth.example' });
		await cache.get(ACCOUNT);
		await cache.get({ clientId: 'client-b', clientSecret: 'secret-of-b' });
		await cache.get(ACCOUNT);
		assert.strictEqual(sent.length, 2);
		cache.clear(ACCOUNT.clientId);
		await cache.get(ACCOUNT);
		assert.strictEqual(sent.length, 3);
		cache.clear();
		assert.deepStrictEqual(cache.values(), []);
	});

	test('a 401 is "the client ID or secret is wrong", nothing cached, the secret in no message or log line', async () => {
		const { fetch, sent } = fakeFetch(() => ({ status: 401, body: { error: 'access_denied', error_description: 'Unauthorized' } }));
		const lines: string[] = [];
		const cache = new TokenCache({ fetch, authUrl: () => 'https://auth.example', log: (l) => lines.push(l) });
		await assert.rejects(cache.get(ACCOUNT), (err: unknown) => err instanceof CloudError && err.kind === 'unauthorized' && err.message === UNAUTHORIZED_MESSAGE);
		await assert.rejects(cache.get(ACCOUNT));
		assert.strictEqual(sent.length, 2, 'a failure is not cached');
		assert.ok(lines.length > 0);
		assert.ok(!lines.some((l) => l.includes(ACCOUNT.clientSecret)), lines.join('\n'));
	});

	test('a network failure is a network error, without the secret', async () => {
		const fetch: FetchLike = async () => {
			throw new TypeError(`fetch failed for client_secret=${ACCOUNT.clientSecret}`);
		};
		const cache = new TokenCache({ fetch, authUrl: () => 'https://auth.example' });
		await assert.rejects(cache.get(ACCOUNT), (err: unknown) => err instanceof CloudError && err.kind === 'network'
			&& !err.message.includes(ACCOUNT.clientSecret) && err.message.includes('auth.example'));
	});

	test('fresh: a new token replaces the cached one only when granted; invalidate drops a refused one', async () => {
		let n = 0;
		let refuse = false;
		const fetch: FetchLike = async () => {
			n++;
			return refuse
				? { status: 401, ok: false, text: async () => JSON.stringify({ error: 'access_denied' }) }
				: { status: 200, ok: true, text: async () => JSON.stringify({ access_token: `tok-${n}-xyz`, expires_in: 86400 }) };
		};
		const cache = new TokenCache({ fetch, authUrl: () => 'https://auth.example' });
		await cache.get(ACCOUNT);
		refuse = true;
		await assert.rejects(cache.get(ACCOUNT, { fresh: true }));
		assert.deepStrictEqual(cache.values(), ['tok-1-xyz'], 'kept after a refused secret');
		refuse = false;
		assert.strictEqual((await cache.get(ACCOUNT, { fresh: true })).accessToken, 'tok-3-xyz');
		assert.deepStrictEqual(cache.values(), ['tok-3-xyz']);
		cache.invalidate('tok-1-xyz');
		assert.deepStrictEqual(cache.values(), ['tok-3-xyz'], 'an older token does not drop the newer one');
		cache.invalidate('tok-3-xyz');
		assert.deepStrictEqual(cache.values(), []);
	});

	test('authorizedJson: a 401 retries once with a new token; a second 401 suggests connecting again', async () => {
		const tokens = ['t-old-1', 't-new-2', 't-new-3'];
		const sentWith: string[] = [];
		const invalidated: string[] = [];
		let accept = 't-new-2';
		const fetch: FetchLike = async (_url, init) => {
			sentWith.push(init.headers.authorization);
			const ok = init.headers.authorization === `Bearer ${accept}`;
			return { status: ok ? 200 : 401, ok, text: async () => JSON.stringify(ok ? { a: 1 } : { code: 'UNAUTHENTICATED', message: 'expired' }) };
		};
		let i = 0;
		const call = { http: { fetch }, token: async () => tokens[Math.min(i, tokens.length - 1)], invalidate: (t: string) => { invalidated.push(t); i++; } };
		assert.deepStrictEqual(await authorizedJson(call, 'GET', 'https://api.example/x'), { a: 1 });
		assert.deepStrictEqual(sentWith, ['Bearer t-old-1', 'Bearer t-new-2']);
		assert.deepStrictEqual(invalidated, ['t-old-1']);
		accept = 'none';
		await assert.rejects(authorizedJson(call, 'GET', 'https://api.example/x'),
			(err: unknown) => err instanceof CloudError && err.kind === 'unauthorized' && err.message.startsWith(TOKEN_REFUSED_MESSAGE));
		assert.strictEqual(sentWith.length, 4, 'one retry only');
	});

	test('jwtClaims reads a JWT payload and nothing else', () => {
		assert.deepStrictEqual(jwtClaims(jwt({ a: 1 })), { a: 1 });
		assert.strictEqual(jwtClaims('not-a-jwt'), undefined);
		assert.strictEqual(jwtClaims('a.!!!.c'), undefined);
	});
});
