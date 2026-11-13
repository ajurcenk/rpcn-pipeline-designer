import * as assert from 'assert';
import type { CloudCall, CloudCluster } from '../../../adapters/cloud/controlPlane';
import type { CloudPipeline } from '../../../adapters/cloud/dataPlane';
import { CloudError } from '../../../adapters/cloud/errors';
import type { FetchLike } from '../../../adapters/cloud/http';
import {
	mappedPipeline, mappingGoneText, MAX_POLL_FAILURES, pollPipeline, type PollHow, stillText,
} from '../../../adapters/vscode/cloudShared';

/** A `GET` answer: a pipeline in `state`, or an error status. */
type Answer = { readonly state: string } | { readonly status: number };

/** A call answering each request with the next of `answers` (the last one repeated); the steps it saw. */
function scripted(answers: Answer[], steps: string[]): CloudCall {
	let at = 0;
	const fetch: FetchLike = async (url, init) => {
		steps.push(`${init.method} ${url}`);
		const a = answers[Math.min(at++, answers.length - 1)];
		if ('status' in a) {
			return { status: a.status, ok: false, text: async () => JSON.stringify({ code: 'X', message: `status ${a.status}`, details: [] }) };
		}
		return { status: 200, ok: true, text: async () => JSON.stringify({ pipeline: { id: 'p1', display_name: 'orders', state: a.state } }) };
	};
	return { http: { fetch }, token: async () => 'tok' };
}

const URL = 'https://dp.example/v1/redpanda-connect/pipelines/p1';

/** A `PollHow` over `answers` that records every step (reads, reports, logs) in `steps`. */
function how(answers: Answer[], steps: string[], over: Partial<PollHow<string>>): PollHow<string> {
	const call = scripted(answers, steps);
	return {
		call: () => call, dp: 'https://dp.example', id: () => 'p1', name: 'orders', timeoutMs: 10_000, pollMs: 1,
		log: (line) => steps.push(`log ${line}`), report: (m) => steps.push(`report ${m}`),
		deadline: 'beforeRead', read: (p: CloudPipeline) => steps.push(`read ${p.state}`), progress: () => 'waiting',
		notFound: 'failed', failed: (error) => `failed: ${error.message}`, timedOut: () => 'timedOut',
		...over,
	};
}

suite('Cloud poll and mapping resolver (story 50)', () => {
	test('done ends the poll at a round\'s start: beforeRead reports and waits before each read', async () => {
		const steps: string[] = [];
		let seen = '';
		const end = await pollPipeline(how([{ state: 'STATE_STARTING' }, { state: 'STATE_RUNNING' }], steps, {
			done: () => (seen === 'STATE_RUNNING' ? 'running' : undefined),
			read: (p) => {
				seen = p.state;
				steps.push(`read ${p.state}`);
			},
		}));
		assert.strictEqual(end, 'running');
		assert.deepStrictEqual(steps, ['report waiting', `GET ${URL}`, 'read STATE_STARTING', 'report waiting', `GET ${URL}`, 'read STATE_RUNNING']);
	});

	test('the deadline: beforeRead checks it before any read; afterRead reads once first', async () => {
		const before: string[] = [];
		assert.strictEqual(await pollPipeline(how([{ state: 'STATE_STARTING' }], before, { timeoutMs: 0 })), 'timedOut');
		assert.deepStrictEqual(before, []);
		const after: string[] = [];
		assert.strictEqual(await pollPipeline(how([{ state: 'STATE_STARTING' }], after, { timeoutMs: 0, deadline: 'afterRead' })), 'timedOut');
		assert.deepStrictEqual(after, [`GET ${URL}`, 'read STATE_STARTING']);
	});

	test('afterRead: read, then the progress and the wait, until a 404 that is its own end (not logged)', async () => {
		const steps: string[] = [];
		const end = await pollPipeline(how([{ state: 'STATE_RUNNING' }, { status: 404 }], steps, { deadline: 'afterRead', notFound: () => 'deleted' }));
		assert.strictEqual(end, 'deleted');
		assert.deepStrictEqual(steps, [`GET ${URL}`, 'read STATE_RUNNING', 'report waiting', `GET ${URL}`]);
	});

	test('a 404 that counts as failed ends it at once, logged', async () => {
		const steps: string[] = [];
		assert.strictEqual(await pollPipeline(how([{ status: 404 }], steps, {})), 'failed: status 404');
		assert.deepStrictEqual(steps, ['report waiting', `GET ${URL}`, 'log Redpanda Cloud: could not read the state of orders: status 404']);
	});

	test('failed reads: each logged; a read between starts the count again; the cap ends it', async () => {
		const steps: string[] = [];
		const answers: Answer[] = [{ status: 500 }, { state: 'STATE_STARTING' }, ...Array.from({ length: MAX_POLL_FAILURES }, () => ({ status: 500 }))];
		const end = await pollPipeline(how(answers, steps, { deadline: 'afterRead' }));
		assert.strictEqual(end, 'failed: status 500');
		assert.strictEqual(steps.filter((s) => s.startsWith('GET')).length, MAX_POLL_FAILURES + 2);
		assert.strictEqual(steps.filter((s) => s.startsWith('log')).length, MAX_POLL_FAILURES + 1);
	});

	test('beforeRead: the cap ends it too; failed gets the CloudError and the raw error thrown', async () => {
		const steps: string[] = [];
		let raw: unknown;
		const end = await pollPipeline(how([{ status: 500 }], steps, {
			failed: (error, err) => {
				raw = err;
				return `failed: ${error.message}`;
			},
		}));
		assert.strictEqual(end, 'failed: status 500');
		assert.ok(raw instanceof CloudError && raw.status === 500, String(raw));
		assert.strictEqual(steps.filter((s) => s.startsWith('GET')).length, MAX_POLL_FAILURES);
		assert.strictEqual(steps.filter((s) => s === 'report waiting').length, MAX_POLL_FAILURES, 'a wait before each read');
	});

	test('afterRead: done is checked at each round\'s start, before the read', async () => {
		const steps: string[] = [];
		let reads = 0;
		const end = await pollPipeline(how([{ state: 'STATE_RUNNING' }], steps, {
			deadline: 'afterRead',
			done: () => (reads === 2 ? 'two' : undefined),
			read: () => {
				reads++;
			},
		}));
		assert.strictEqual(end, 'two');
		assert.deepStrictEqual(steps, [`GET ${URL}`, 'report waiting', `GET ${URL}`, 'report waiting']);
	});

	test('stillText: the "still … after N s" pair, and a delete still listed', () => {
		assert.deepStrictEqual(stillText('orders', 'on rpc-vilnius', 1500, { still: 'starting' }), {
			log: 'Redpanda Cloud: pipeline orders on rpc-vilnius is still starting after 2 s.',
			info: 'Pipeline orders is still starting on rpc-vilnius; the Cloud view shows its state.',
		});
		assert.deepStrictEqual(stillText('orders', 'on rpc-vilnius', 600, { listedAfterDelete: true, also: ' Deleted a.cloud.json.' }), {
			log: 'Redpanda Cloud: pipeline orders on rpc-vilnius is still listed 1 s after its delete.',
			info: 'Pipeline orders is being deleted on rpc-vilnius; the Cloud view shows it until it is gone. Deleted a.cloud.json.',
		});
	});

	test('mappedPipeline: found, cluster gone (by its name, the mapping\'s or its id), pipeline gone (removed), failed; the gone texts', async () => {
		const cluster = { id: 'c1', name: 'rpc-vilnius', dataplaneUrl: 'https://dp.example' } as CloudCluster;
		const pipeline = { id: 'p1', displayName: 'orders', state: 'STATE_RUNNING' } as CloudPipeline;
		const removed: string[] = [];
		const ctx = (clusters: CloudCluster[], read: Awaited<ReturnType<Parameters<typeof mappedPipeline>[0]['readPipeline']>>) => ({
			clusterById: (id: string) => clusters.find((c) => c.id === id),
			dataplaneUrlOf: (c: CloudCluster) => c.dataplaneUrl,
			readPipeline: async () => read,
			removePipeline: (clusterId: string, id: string) => removed.push(`${clusterId}/${id}`),
		});
		const m = { clusterId: 'c1', pipelineId: 'p1', clusterName: 'old-name', pipelineName: 'orders' };
		const ok = { kind: 'ok' as const, value: pipeline };
		assert.deepStrictEqual(await mappedPipeline(ctx([cluster], ok), m), { kind: 'found', cluster, dp: 'https://dp.example', pipeline });
		assert.deepStrictEqual(await mappedPipeline(ctx([], ok), m), { kind: 'clusterGone', named: 'old-name' });
		assert.deepStrictEqual(await mappedPipeline(ctx([], ok), { clusterId: 'c1', pipelineId: 'p1' }), { kind: 'clusterGone', named: 'c1' });
		const noApi = { ...cluster, dataplaneUrl: undefined };
		assert.deepStrictEqual(await mappedPipeline(ctx([noApi], ok), m), { kind: 'clusterGone', named: 'rpc-vilnius' });
		assert.deepStrictEqual(await mappedPipeline(ctx([cluster], { kind: 'error', message: 'boom', status: 500 }), m), { kind: 'failed', message: 'boom' });
		assert.deepStrictEqual(removed, []);
		const gone = await mappedPipeline(ctx([cluster], { kind: 'error', message: 'gone', status: 404 }), m);
		assert.deepStrictEqual(gone, { kind: 'pipelineGone', cluster, dp: 'https://dp.example' });
		assert.deepStrictEqual(removed, ['c1/p1']);
		assert.strictEqual(mappingGoneText({ kind: 'clusterGone', named: 'old-name' }, m, 'orders.yaml.cloud.json', 'orders.yaml'),
			'The cluster old-name that orders.yaml.cloud.json maps orders.yaml to is gone or no longer offers the pipeline API.');
		assert.strictEqual(mappingGoneText({ kind: 'pipelineGone', cluster }, m, 'orders.yaml.cloud.json', 'orders.yaml', 'Create a new pipeline?'),
			'Pipeline orders, which orders.yaml.cloud.json maps orders.yaml to, is no longer on rpc-vilnius. Create a new pipeline?');
	});
});
