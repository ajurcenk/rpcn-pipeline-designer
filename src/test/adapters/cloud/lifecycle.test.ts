import * as assert from 'assert';
import type { CloudCall } from '../../../adapters/cloud/controlPlane';
import { deletePipeline, isKnownState, startPipeline, stopPipeline } from '../../../adapters/cloud/dataPlane';
import { canStart, canStop, pipelineStateText, stateKey } from '../../../adapters/cloud/pipelineText';
import { CloudError } from '../../../adapters/cloud/errors';
import type { FetchLike } from '../../../adapters/cloud/http';
import { configTag, folderLabel, folderOf, tagNames, taggedConfigs } from '../../../adapters/cloud/sidecar';
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

	test('taggedConfigs (ticket 5.5): the config path a tag names inside each workspace folder, in their order; outside them none', () => {
		const w = { name: 'w', path: path.resolve('/w') };
		const v = { name: 'v', path: path.resolve('/v') };
		// Bug 47: in a multi-root workspace a first segment naming no folder is also read as another workspace's folder name.
		assert.deepStrictEqual(taggedConfigs('pipes/orders.yaml', [w, v]),
			[path.join(w.path, 'pipes', 'orders.yaml'), path.join(v.path, 'pipes', 'orders.yaml'), path.join(w.path, 'orders.yaml'), path.join(v.path, 'orders.yaml')]);
		assert.deepStrictEqual(taggedConfigs(path.join(v.path, 'orders.yaml'), [w, v]), [path.join(v.path, 'orders.yaml')]);
		assert.deepStrictEqual(taggedConfigs(path.resolve('/etc/orders.yaml'), [w]), []);
		assert.deepStrictEqual(taggedConfigs('../outside/orders.yaml', [w]), []);
		assert.deepStrictEqual(taggedConfigs('pipes/../../orders.yaml', [w]), []);
		assert.deepStrictEqual(taggedConfigs('..orders.yaml', [w]), [path.join(w.path, '..orders.yaml')]);
		assert.deepStrictEqual(taggedConfigs('.', [w]), [], 'the folder itself is no config');
		assert.deepStrictEqual(taggedConfigs('', [w]), []);
		assert.deepStrictEqual(taggedConfigs('orders.yaml', []), []);
		assert.deepStrictEqual(taggedConfigs(undefined, [w]), []);
	});

	test('MULTI_ROOT (bug 47): a <folder name>/<path> tag names that folder\'s file only; an old tag with no folder is read in every folder', () => {
		const a = { name: 'a', path: path.resolve('/ws/a') };
		const b = { name: 'b', path: path.resolve('/ws/b') };
		assert.deepStrictEqual(taggedConfigs('a/orders.yaml', [a, b]), [path.join(a.path, 'orders.yaml')], 'not also a/a/orders.yaml or b/a/orders.yaml');
		assert.deepStrictEqual(taggedConfigs('b/pipes/orders.yaml', [a, b]), [path.join(b.path, 'pipes', 'orders.yaml')]);
		assert.deepStrictEqual(taggedConfigs('a/../../orders.yaml', [a, b]), [], 'climbing out of the named folder gives none');
		// OLD_TAG_TWO: an old tag with no folder names a file in each folder; the caller does not resolve it alone.
		assert.deepStrictEqual(taggedConfigs('orders.yaml', [a, b]), [path.join(a.path, 'orders.yaml'), path.join(b.path, 'orders.yaml')]);
		// A first segment naming no open folder (named differently here): the old reading, and the rest in every folder.
		assert.deepStrictEqual(taggedConfigs('other/orders.yaml', [a, b]), [
			path.join(a.path, 'other', 'orders.yaml'), path.join(b.path, 'other', 'orders.yaml'), path.join(a.path, 'orders.yaml'), path.join(b.path, 'orders.yaml'),
		]);
		// One folder: the old reading; a tag led by the folder's own name (it was opened in a multi-root workspace) also by the rest.
		assert.deepStrictEqual(taggedConfigs('pipes/orders.yaml', [a]), [path.join(a.path, 'pipes', 'orders.yaml')]);
		assert.deepStrictEqual(taggedConfigs('a/orders.yaml', [a]), [path.join(a.path, 'a', 'orders.yaml'), path.join(a.path, 'orders.yaml')]);
	});

	test('folder names (bug 47): a name holding `/` is matched whole, the longest first; two folders sharing a name get <name>#<n> tags', () => {
		const slashed = { name: 'team/app', path: path.resolve('/ws/app') };
		const team = { name: 'team', path: path.resolve('/ws/team') };
		assert.strictEqual(configTag(path.join(slashed.path, 'orders.yaml'), [team, slashed]), 'team/app/orders.yaml');
		assert.deepStrictEqual(taggedConfigs('team/app/orders.yaml', [team, slashed]), [path.join(slashed.path, 'orders.yaml')]);
		assert.deepStrictEqual(taggedConfigs('team/orders.yaml', [team, slashed]), [path.join(team.path, 'orders.yaml')]);

		const one = { name: 'svc', path: path.resolve('/ws/one/svc') };
		const two = { name: 'svc', path: path.resolve('/ws/two/svc') };
		const folders = [one, two];
		assert.strictEqual(folderLabel(one, folders), 'svc#1');
		assert.strictEqual(folderLabel(two, folders), 'svc#2');
		const first = configTag(path.join(one.path, 'orders.yaml'), folders);
		const second = configTag(path.join(two.path, 'orders.yaml'), folders);
		assert.deepStrictEqual([first, second], ['svc#1/orders.yaml', 'svc#2/orders.yaml'], 'unique');
		assert.deepStrictEqual(taggedConfigs(second, folders), [path.join(two.path, 'orders.yaml')]);
		assert.deepStrictEqual(taggedConfigs('svc/orders.yaml', folders), [path.join(one.path, 'orders.yaml'), path.join(two.path, 'orders.yaml')], 'the bare name names both');
	});

	test('tagNames (bug 47): a file outside every folder is matched by its base name or old absolute path only, never through a workspace file', () => {
		const w = { name: 'w', path: path.resolve('/ws/w') };
		const outside = path.resolve('/elsewhere/orders.yaml');
		assert.ok(tagNames('orders.yaml', outside, [w]));
		assert.ok(tagNames(outside, outside, [w]));
		assert.ok(!tagNames('pipes/orders.yaml', outside, [w]));
		assert.ok(tagNames('orders.yaml', path.join(w.path, 'orders.yaml'), [w]));
		assert.ok(!tagNames('orders.yaml', path.join(w.path, 'pipes', 'orders.yaml'), [w]));
		assert.ok(!tagNames(undefined, outside, [w]));
	});

	test('configTag (bug 47): OUTSIDE the base name, ONE_FOLDER the folder-relative path, MULTI_ROOT <folder name>/<path>; never an absolute path', () => {
		const ws = { name: 'ws', path: path.resolve('/home/someone/ws') };
		const a = { name: 'a', path: path.resolve('/ws/a') };
		const b = { name: 'b-named', path: path.resolve('/ws/b') };
		const outside = path.resolve('/home/someone/elsewhere/orders.yaml');
		assert.strictEqual(configTag(outside, []), 'orders.yaml', 'no folder open');
		assert.strictEqual(configTag(outside, [ws]), 'orders.yaml', 'outside the one folder');
		assert.strictEqual(configTag(outside, [a, b]), 'orders.yaml', 'outside every folder');
		assert.strictEqual(configTag(path.join(ws.path, 'pipes', 'orders.yaml'), [ws]), 'pipes/orders.yaml', 'one folder: as before');
		assert.strictEqual(configTag(path.join(a.path, 'orders.yaml'), [a, b]), 'a/orders.yaml');
		assert.strictEqual(configTag(path.join(b.path, 'pipes', 'orders.yaml'), [a, b]), 'b-named/pipes/orders.yaml', 'the folder\'s name, not its directory');
		// Nested folders: the innermost.
		const inner = { name: 'inner', path: path.join(a.path, 'sub') };
		assert.strictEqual(folderOf(path.join(inner.path, 'orders.yaml'), [a, inner]), inner);
		assert.strictEqual(configTag(path.join(inner.path, 'orders.yaml'), [a, inner]), 'inner/orders.yaml');
		// Each tag resolves back to its own file.
		for (const [file, folders] of [[path.join(a.path, 'orders.yaml'), [a, b]], [path.join(b.path, 'pipes', 'orders.yaml'), [a, b]], [path.join(ws.path, 'pipes', 'orders.yaml'), [ws]]] as const) {
			assert.strictEqual(taggedConfigs(configTag(file, folders), folders)[0], file);
		}
	});
});
