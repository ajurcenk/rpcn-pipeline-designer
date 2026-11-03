import * as assert from 'assert';
import { pipelineFrom, pipelineStateText } from '../../../adapters/cloud/dataPlane';
import {
	asCloudError, CloudError, cloudErrorFrom, CREDENTIAL_MASK, describeCloudError, hintLines, lintHintsOf, maskCredentials, UNAUTHORIZED_MESSAGE,
} from '../../../adapters/cloud/errors';
import { type FetchLike, requestJson } from '../../../adapters/cloud/http';

/** Spike 5.1 capture 26: an unknown component. */
const REJECTED = {
	code: 'INVALID_ARGUMENT',
	message: 'invalid pipeline configuration',
	details: [{
		'@type': 'redpanda.api.common.v1.ExternalError',
		message: 'invalid pipeline configuration',
		details: [
			{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'REASON_CONNECT_INVALID_PIPELINE_CONFIGURATION', domain: 'redpanda.com/dataplane', metadata: {} },
			{ '@type': 'type.googleapis.com/redpanda.api.common.v1.LintHint', line: 2, column: 1, hint: 'unable to infer component type: probe_no_such_input', lint_type: '' },
		],
	}],
};

suite('Cloud errors (ticket 5.2, AD-23)', () => {
	test('an API error keeps its message and LintHints only', () => {
		const err = cloudErrorFrom(400, JSON.stringify(REJECTED));
		assert.strictEqual(err.kind, 'api');
		assert.strictEqual(err.status, 400);
		assert.strictEqual(err.code, 'INVALID_ARGUMENT');
		assert.strictEqual(err.message, 'invalid pipeline configuration');
		assert.deepStrictEqual(err.hints, [{ line: 2, column: 1, hint: 'unable to infer component type: probe_no_such_input' }]);
		assert.deepStrictEqual(hintLines(err.hints), ['line 2, column 1: unable to infer component type: probe_no_such_input']);
		assert.strictEqual(describeCloudError(err), 'invalid pipeline configuration: line 2, column 1: unable to infer component type: probe_no_such_input');
		assert.ok(!describeCloudError(err).includes('REASON_CONNECT'), 'nothing else from the body');
	});

	test('the token endpoint\'s 401 is a wrong ID or secret; other shapes fall back to the status', () => {
		const unauthorized = cloudErrorFrom(401, JSON.stringify({ error: 'access_denied', error_description: 'Unauthorized' }), true);
		assert.strictEqual(unauthorized.kind, 'unauthorized');
		assert.strictEqual(unauthorized.message, UNAUTHORIZED_MESSAGE);
		assert.strictEqual(cloudErrorFrom(500, '<html>oops</html>').message, 'HTTP 500');
		assert.strictEqual(cloudErrorFrom(403, JSON.stringify({ code: 'PERMISSION_DENIED', message: 'you are not authorized to call this endpoint' })).message,
			'you are not authorized to call this endpoint');
		assert.strictEqual(cloudErrorFrom(400, JSON.stringify({ error: 'invalid_request', error_description: 'bad grant' }), true).message, 'bad grant');
		assert.deepStrictEqual(lintHintsOf({ details: 'nope' }), []);
	});

	test('a thrown fetch error becomes a network error with its cause', () => {
		const err = asCloudError(Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND x') }));
		assert.strictEqual(err.kind, 'network');
		assert.strictEqual(err.message, 'fetch failed: getaddrinfo ENOTFOUND x');
		const same = new CloudError('api', 'm');
		assert.strictEqual(asCloudError(same), same);
	});

	test('masking: the given values, Bearer values, Authorization headers and secret form fields', () => {
		const masked = maskCredentials('a sekret-value b; Authorization: Bearer eyJ.abc.def; authorization=xyz123; client_secret=s3cr3t&x=1; "access_token":"tok"', ['sekret-value']);
		assert.ok(!/sekret-value|eyJ\.abc\.def|xyz123|s3cr3t|"tok"/.test(masked), masked);
		assert.ok(masked.includes(`a ${CREDENTIAL_MASK} b`), masked);
		assert.ok(masked.includes(`Bearer ${CREDENTIAL_MASK}`), masked);
		assert.strictEqual(maskCredentials('short ab', ['ab']), 'short ab', 'very short values are not masked');
	});

	test('requestJson masks the secrets in its error messages and log lines and never logs a header or body', async () => {
		const lines: string[] = [];
		const fetch: FetchLike = async () => ({ status: 400, ok: false, text: async () => JSON.stringify({ code: 'INVALID_ARGUMENT', message: 'bad value tok-abc-123 here' }) });
		await assert.rejects(
			requestJson({ fetch, log: (l) => lines.push(l) }, 'POST', 'https://dp.example/v1/x', { token: 'tok-abc-123', json: { a: 'body-text' } }),
			(err: unknown) => err instanceof CloudError && err.message === `bad value ${CREDENTIAL_MASK} here`,
		);
		assert.deepStrictEqual(lines.map((l) => l.replace(/\(\d+ ms\)/, '(n ms)')), ['Redpanda Cloud: POST https://dp.example/v1/x → 400 (n ms)']);
	});

	test('a pipeline answer: state, error status and tags', () => {
		assert.deepStrictEqual(pipelineFrom({ id: 'p1', display_name: 'orders', state: 'STATE_ERROR', status: { error: 'boom' }, tags: { k: 'v', n: 1 } }),
			{ id: 'p1', displayName: 'orders', state: 'STATE_ERROR', error: 'boom', tags: { k: 'v' } });
		assert.deepStrictEqual(pipelineFrom({ id: 'p2', state: 'STATE_ERROR' }), { id: 'p2', displayName: 'p2', state: 'STATE_ERROR', tags: {} });
		assert.strictEqual(pipelineFrom({ display_name: 'no id' }), undefined);
		assert.strictEqual(pipelineStateText('STATE_RUNNING'), 'Running');
		assert.strictEqual(pipelineStateText('STATE_COMPLETED'), 'Completed');
	});
});
