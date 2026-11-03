import * as assert from 'assert';
import * as path from 'path';
import type { CloudCall } from '../../../adapters/cloud/controlPlane';
import {
	isRunning, pipelineFrom, resourcesOf, resourcesText, sameResources, sizeChoices, unitsOf, updatePipeline,
} from '../../../adapters/cloud/dataPlane';
import { CloudError } from '../../../adapters/cloud/errors';
import type { FetchLike } from '../../../adapters/cloud/http';
import { parseMapping, serializeMapping, sidecarPath } from '../../../adapters/cloud/sidecar';

suite('Cloud update, resources and the deploy mapping (ticket 5.3, AD-23)', () => {
	test('the mapping file sits beside the config as <stem>.cloud.json', () => {
		assert.strictEqual(sidecarPath(path.join('/w', 'pipes', 'orders.yaml')), path.join('/w', 'pipes', 'orders.cloud.json'));
		assert.strictEqual(sidecarPath(path.join('/w', 'orders.rpcn.yml')), path.join('/w', 'orders.rpcn.cloud.json'));
		assert.strictEqual(sidecarPath(path.join('/w', 'orders')), path.join('/w', 'orders.cloud.json'));
		assert.strictEqual(sidecarPath(path.join('/w', '.hidden')), path.join('/w', '.hidden.cloud.json'));
	});

	test('the mapping parses strictly and round-trips as 2-space JSON with a trailing newline', () => {
		const m = { clusterId: 'c1', pipelineId: 'p1', clusterName: 'rpc-vilnius', pipelineName: 'orders' };
		const text = serializeMapping(m);
		assert.strictEqual(text, '{\n  "clusterId": "c1",\n  "pipelineId": "p1",\n  "clusterName": "rpc-vilnius",\n  "pipelineName": "orders"\n}\n');
		assert.deepStrictEqual(parseMapping(text), { kind: 'ok', mapping: m });
		assert.deepStrictEqual(parseMapping('{"clusterId":"c1","pipelineId":"p1"}'), { kind: 'ok', mapping: { clusterId: 'c1', pipelineId: 'p1' } });
		assert.strictEqual(parseMapping('not json').kind, 'bad');
		assert.strictEqual(parseMapping('[]').kind, 'bad');
		assert.deepStrictEqual(parseMapping('{"clusterId":"c1"}'), { kind: 'bad', reason: 'it has no pipelineId' });
		assert.deepStrictEqual(parseMapping('{"clusterId":1,"pipelineId":""}'), { kind: 'bad', reason: 'it has no clusterId or pipelineId' });
	});

	test('compute units: 0.1 CPU and 400 MB each', () => {
		assert.deepStrictEqual(resourcesOf(1), { cpu_shares: '100m', memory_shares: '400M' });
		assert.deepStrictEqual(resourcesOf(15), { cpu_shares: '1500m', memory_shares: '6000M' });
		assert.strictEqual(unitsOf(resourcesOf(3)), 3);
		assert.strictEqual(unitsOf({ cpu_shares: '100m', memory_shares: '800M' }), undefined);
		assert.strictEqual(unitsOf({ cpu_shares: '0.5', memory_shares: '2Gi' }), undefined);
		assert.strictEqual(resourcesText(resourcesOf(1)), '1 compute unit (0.1 CPU, 400 MB)');
		assert.strictEqual(resourcesText(resourcesOf(2)), '2 compute units (0.2 CPU, 800 MB)');
		assert.strictEqual(resourcesText({ cpu_shares: '0.5', memory_shares: '2Gi' }), 'CPU 0.5, memory 2Gi');
		assert.ok(sameResources(resourcesOf(2), { cpu_shares: '200m', memory_shares: '800M' }));
		assert.ok(!sameResources(resourcesOf(2), resourcesOf(1)));
		assert.ok(!sameResources(resourcesOf(1), undefined));
		assert.ok(isRunning('STATE_RUNNING') && isRunning('STATE_STARTING') && !isRunning('STATE_STOPPED') && !isRunning('STATE_ERROR'));
	});

	test('a pipeline answer keeps its description, config and resources', () => {
		const p = pipelineFrom({
			id: 'p1', display_name: 'orders', description: 'd', config_yaml: 'input: {}\n',
			resources: { cpu_shares: '100m', memory_shares: '400M' }, state: 'STATE_RUNNING', tags: { a: 'b' },
		});
		assert.strictEqual(p?.description, 'd');
		assert.strictEqual(p?.configYaml, 'input: {}\n');
		assert.deepStrictEqual(p?.resources, { cpu_shares: '100m', memory_shares: '400M' });
	});

	test('updatePipeline sends PUT /{id} with every field', async () => {
		const sent: { method: string; url: string; body?: string }[] = [];
		const fetch: FetchLike = async (url, init) => {
			sent.push({ method: init.method, url, ...(init.body !== undefined ? { body: init.body } : {}) });
			return { status: 200, ok: true, text: async () => JSON.stringify({ pipeline: { id: 'p/1', display_name: 'orders', state: 'STATE_RUNNING' } }) };
		};
		const call: CloudCall = { http: { fetch }, token: async () => 'tok' };
		const got = await updatePipeline(call, 'https://dp.example', 'p/1', {
			displayName: 'orders', description: 'kept', configYaml: 'x: 1\n', resources: resourcesOf(2), tags: { other: 'v', 'rpcn-vscode/config': 'orders.yaml' },
		});
		assert.strictEqual(got.id, 'p/1');
		assert.strictEqual(sent.length, 1);
		assert.strictEqual(sent[0].method, 'PUT');
		assert.strictEqual(sent[0].url, 'https://dp.example/v1/redpanda-connect/pipelines/p%2F1');
		assert.deepStrictEqual(JSON.parse(sent[0].body!), {
			display_name: 'orders', description: 'kept', config_yaml: 'x: 1\n',
			resources: { cpu_shares: '200m', memory_shares: '800M' }, tags: { other: 'v', 'rpcn-vscode/config': 'orders.yaml' },
		});
	});

	test('a rejected update is a CloudError with its hints', async () => {
		const fetch: FetchLike = async () => ({
			status: 400, ok: false, text: async () => JSON.stringify({
				code: 'INVALID_ARGUMENT', message: 'invalid pipeline configuration',
				details: [{ details: [{ '@type': 'type.googleapis.com/redpanda.api.common.v1.LintHint', line: 3, column: 1, hint: 'nope' }] }],
			}),
		});
		await assert.rejects(
			updatePipeline({ http: { fetch }, token: async () => 'tok' }, 'https://dp.example', 'p1', {
				displayName: 'o', description: '', configYaml: 'x', resources: resourcesOf(1), tags: {},
			}),
			(err: unknown) => err instanceof CloudError && err.status === 400 && err.hints.length === 1,
		);
	});

	test('sizeChoices: 1–15 units with CPU and memory; pre-set to 1 for a new pipeline, else the current size, marked current; another size first', () => {
		const fresh = sizeChoices(undefined);
		assert.strictEqual(fresh.items.length, 15);
		assert.deepStrictEqual(fresh.items.map((i) => i.label), Array.from({ length: 15 }, (_, i) => String(i + 1)));
		assert.strictEqual(fresh.items[1].description, '2 compute units (0.2 CPU, 800 MB)');
		assert.strictEqual(fresh.preset, 0);
		assert.deepStrictEqual(fresh.items[fresh.preset].resources, resourcesOf(1));
		assert.ok(fresh.items.every((i) => !i.description.includes('current')));

		const three = sizeChoices({ cpu_shares: '300m', memory_shares: '1200M' });
		assert.strictEqual(three.items.length, 15);
		assert.strictEqual(three.preset, 2);
		assert.strictEqual(three.items[2].description, '3 compute units (0.3 CPU, 1200 MB) · current');
		assert.strictEqual(three.items.filter((i) => i.description.endsWith('· current')).length, 1);

		for (const odd of [{ cpu_shares: '150m', memory_shares: '400M' }, resourcesOf(20)]) {
			const other = sizeChoices(odd);
			assert.strictEqual(other.items.length, 16, JSON.stringify(odd));
			assert.strictEqual(other.items[0].label, 'Current size');
			assert.deepStrictEqual(other.items[0].resources, odd);
			assert.strictEqual(other.preset, 0, 'the current size is pre-set');
		}
	});
});
