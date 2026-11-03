import * as assert from 'assert';
import type { CloudCall } from '../../../adapters/cloud/controlPlane';
import {
	canStart, canStop, deletePipeline, isKnownState, pipelineStateText, startPipeline, stateKey, stopPipeline,
} from '../../../adapters/cloud/dataPlane';
import { CloudError } from '../../../adapters/cloud/errors';
import type { FetchLike } from '../../../adapters/cloud/http';
import { taggedSidecars } from '../../../adapters/cloud/sidecar';
import * as path from 'path';

interface Sent { method: string; url: string; body?: string }

function fake(status: number, answer: unknown, sent: Sent[]): CloudCall {
	const fetch: FetchLike = async (url, init) => {
		sent.push({ method: init.method, url, ...(init.body !== undefined ? { body: init.body } : {}) });
		return { status, ok: status >= 200 && status < 300, text: async () => (answer === undefined ? '' : JSON.stringify(answer)) };
	};
	return { http: { fetch }, token: async () => 'tok' };
}

suite('Cloud start, stop and delete (ticket 5.4, AD-23)', () => {
	test('startPipeline and stopPipeline send PUT /{id}/start and /{id}/stop with no body and keep the answer\'s pipeline', async () => {
		const sent: Sent[] = [];
		const started = await startPipeline(fake(200, { pipeline: { id: 'p/1', display_name: 'orders', state: 'STATE_STARTING' } }, sent), 'https://dp.example/', 'p/1');
		assert.strictEqual(started.state, 'STATE_STARTING');
		const stopped = await stopPipeline(fake(200, { pipeline: { id: 'p/1', display_name: 'orders', state: 'STATE_STOPPING' } }, sent), 'https://dp.example', 'p/1');
		assert.strictEqual(stopped.state, 'STATE_STOPPING');
		assert.deepStrictEqual(sent, [
			{ method: 'PUT', url: 'https://dp.example/v1/redpanda-connect/pipelines/p%2F1/start' },
			{ method: 'PUT', url: 'https://dp.example/v1/redpanda-connect/pipelines/p%2F1/stop' },
		]);
	});

	test('an answer without a pipeline is an error', async () => {
		await assert.rejects(startPipeline(fake(200, {}, []), 'https://dp.example', 'p1'), /without the pipeline/);
	});

	test('deletePipeline sends DELETE /{id}; `{}` and an empty body both succeed; a 404 is a CloudError with its status', async () => {
		const sent: Sent[] = [];
		await deletePipeline(fake(200, {}, sent), 'https://dp.example', 'p1');
		await deletePipeline(fake(200, undefined, sent), 'https://dp.example', 'p1');
		assert.deepStrictEqual(sent.map((s) => `${s.method} ${s.url}`), [
			'DELETE https://dp.example/v1/redpanda-connect/pipelines/p1',
			'DELETE https://dp.example/v1/redpanda-connect/pipelines/p1',
		]);
		await assert.rejects(
			deletePipeline(fake(404, { code: 'NOT_FOUND', message: 'pipeline not found', details: [] }, []), 'https://dp.example', 'p1'),
			(err: unknown) => err instanceof CloudError && err.status === 404 && err.message === 'pipeline not found',
		);
	});

	test('the states: which offer Start and Stop, their context keys and texts; an unknown state by its raw name', () => {
		assert.deepStrictEqual(['STATE_STOPPED', 'STATE_ERROR', 'STATE_COMPLETED', 'STATE_RUNNING', 'STATE_STARTING', 'STATE_STOPPING', 'STATE_PAUSED'].map(canStart),
			[true, true, true, false, false, false, false]);
		assert.deepStrictEqual(['STATE_STOPPED', 'STATE_ERROR', 'STATE_COMPLETED', 'STATE_RUNNING', 'STATE_STARTING', 'STATE_STOPPING', 'STATE_PAUSED'].map(canStop),
			[false, false, false, true, true, false, false]);
		assert.strictEqual(stateKey('STATE_STOPPING'), 'stopping');
		assert.strictEqual(stateKey('STATE_PAUSED'), 'unknown');
		assert.strictEqual(stateKey(undefined), 'unknown');
		assert.ok(isKnownState('STATE_COMPLETED') && !isKnownState('STATE_UNSPECIFIED'));
		assert.strictEqual(pipelineStateText('STATE_STOPPING'), 'Stopping');
		assert.strictEqual(pipelineStateText('STATE_PAUSED'), 'STATE_PAUSED');
	});

	test('taggedSidecars: the tag resolved in each workspace folder, only inside one; an absolute path outside or a `..` climbing out gives none', () => {
		const w = path.resolve('/w');
		const v = path.resolve('/v');
		assert.deepStrictEqual(taggedSidecars('pipes/orders.yaml', [w, v]), [path.join(w, 'pipes', 'orders.cloud.json'), path.join(v, 'pipes', 'orders.cloud.json')]);
		assert.deepStrictEqual(taggedSidecars(path.join(w, 'orders.yaml'), [w, v]), [path.join(w, 'orders.cloud.json')]);
		assert.deepStrictEqual(taggedSidecars(path.resolve('/etc/orders.yaml'), [w]), []);
		assert.deepStrictEqual(taggedSidecars('../outside/orders.yaml', [w]), []);
		assert.deepStrictEqual(taggedSidecars('pipes/../../orders.yaml', [w]), []);
		assert.deepStrictEqual(taggedSidecars('..orders.yaml', [w]), [path.join(w, '..orders.cloud.json')]);
		assert.deepStrictEqual(taggedSidecars('orders.yaml', []), []);
		assert.deepStrictEqual(taggedSidecars(undefined, [w]), []);
	});
});
