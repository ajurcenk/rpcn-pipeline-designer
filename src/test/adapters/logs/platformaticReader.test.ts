import * as assert from 'assert';
import { classifyKafkaError, FETCH_WAIT_MS, loadKafka, PlatformaticReader } from '../../../adapters/logs/platformaticReader';
import { isLogReadError, type LogPositions, type LogRecord, LOGS_TOPIC } from '../../../adapters/logs/logReader';

// The reader on @platformatic/kafka (ticket 6.2, AD-24) against a scripted stand-in of the library's
// Consumer: what it asks for (no group joined, nothing committed) and what it makes of the answers.
// The real client against a real cluster is spike 6.1 and the manual check.

type Kafka = Awaited<ReturnType<typeof loadKafka>>;

interface Call { readonly op: string; readonly args: unknown }

/** A topic of `partitions` partitions; each record `[partition, timestamp, key, value]`, offsets from `base`. */
function fakeKafka(options: {
	partitions?: number; base?: number; records?: [number, number, string, string][]; connectError?: unknown; fetchErrorCode?: number;
	/** The n-th fetch (1-based) answers this Kafka error code on every partition, or throws this error. */
	fetchFailures?: Record<number, number | Error>;
	/** Leaders per metadata read (n-th read, 1-based); default `partition % 2`. */
	leaders?: (read: number) => number[];
	/** Called on each metadata read. */
	onMetadata?: (n: number) => void;
	/** Called on each fetch (it may abort the tail). */
	onFetch?: (n: number) => void;
	/** The first n fetches answer no records (as a tiered-storage read may while it warms up). */
	emptyFetches?: number;
	/** What DescribeConfigs answers for `retention.ms` (a string), or this error. */
	retention?: string | Error;
}) {
	const calls: Call[] = [];
	const base = options.base ?? 100;
	const parts = options.partitions ?? 1;
	const logs = Array.from({ length: parts }, (_, p) => (options.records ?? []).filter((r) => r[0] === p).map((r, i) => ({ offset: base + i, timestamp: r[1], key: r[2], value: r[3] })));
	let fetches = 0;
	let metadataReads = 0;
	let constructed: Record<string, unknown> | undefined;
	class Consumer {
		constructor(o: Record<string, unknown>) {
			constructed = o;
		}
		async metadata(o: unknown) {
			calls.push({ op: 'metadata', args: o });
			metadataReads++;
			options.onMetadata?.(metadataReads);
			if (options.connectError) {
				throw options.connectError;
			}
			const leaders = options.leaders?.(metadataReads) ?? Array.from({ length: parts }, (_, i) => i % 2);
			return { topics: new Map([[LOGS_TOPIC, { id: 'topic-id', partitions: leaders.map((leader) => ({ leader })) }]]) };
		}
		async listOffsetsWithTimestamps(o: { partitions: Record<string, number[]>; timestamp: bigint }) {
			calls.push({ op: 'listOffsets', args: { partitions: o.partitions[LOGS_TOPIC], timestamp: o.timestamp } });
			const m = new Map<number, { offset: bigint; timestamp: bigint }>();
			for (const p of o.partitions[LOGS_TOPIC]) {
				const log = logs[p];
				const end = base + log.length;
				const at = o.timestamp === -1n ? end : o.timestamp === -2n ? base : log.find((r) => r.timestamp >= Number(o.timestamp))?.offset ?? -1;
				m.set(p, { offset: BigInt(at), timestamp: -1n });
			}
			return new Map([[LOGS_TOPIC, m]]);
		}
		async fetch(o: { node: number; maxWaitTime: number; topics: { topicId: string; partitions: { partition: number; fetchOffset: bigint }[] }[] }) {
			calls.push({ op: 'fetch', args: { node: o.node, maxWaitTime: o.maxWaitTime, partitions: o.topics[0].partitions.map((p) => [p.partition, Number(p.fetchOffset)]) } });
			fetches++;
			options.onFetch?.(fetches);
			const failure = options.fetchFailures?.[fetches];
			if (failure instanceof Error) {
				throw failure;
			}
			return {
				responses: [{
					topicId: o.topics[0].topicId,
					partitions: o.topics[0].partitions.map((rp) => {
						const from = Number(rp.fetchOffset);
						const got = fetches <= (options.emptyFetches ?? 0) ? [] : logs[rp.partition].filter((r) => r.offset >= from);
						return {
							partitionIndex: rp.partition,
							errorCode: typeof failure === 'number' ? failure : options.fetchErrorCode ?? 0,
							highWatermark: BigInt(base + logs[rp.partition].length),
							// One batch starting one before the asked offset, as a broker may answer.
							records: got.length === 0 ? [] : [{
								firstOffset: BigInt(got[0].offset - 1), firstTimestamp: BigInt(got[0].timestamp),
								records: [
									{ offsetDelta: 0, timestampDelta: 0n, key: Buffer.from('older'), value: Buffer.from('{}') },
									...got.map((r) => ({ offsetDelta: r.offset - got[0].offset + 1, timestampDelta: BigInt(r.timestamp - got[0].timestamp), key: Buffer.from(r.key), value: Buffer.from(r.value) })),
								],
							}],
						};
					}),
				}],
			};
		}
		async close() {
			calls.push({ op: 'close', args: undefined });
		}
	}
	class Admin {
		constructor(o: Record<string, unknown>) {
			calls.push({ op: 'admin', args: o });
		}
		async describeConfigs(o: { resources: { resourceType: number; resourceName: string; configurationKeys?: string[] }[] }) {
			calls.push({ op: 'describeConfigs', args: o.resources });
			if (options.retention instanceof Error) {
				throw options.retention;
			}
			return o.resources.map((r) => ({ resourceType: r.resourceType, resourceName: r.resourceName, configs: [{ name: 'retention.ms', value: options.retention ?? '604800000' }] }));
		}
		async close() {
			calls.push({ op: 'adminClose', args: undefined });
		}
	}
	const kafka = (async () => ({ Consumer, Admin } as unknown as Kafka));
	return { kafka, calls, options: () => constructed };
}

const TARGET = { brokers: ['seed-0.example:9092'], access: { username: 'logs-reader', password: 'pw-6-2-Kq8', mechanism: 'SCRAM-SHA-256' as const } };

suite('Pipeline logs reader on @platformatic/kafka (ticket 6.2, AD-24)', () => {
	test('the client: the seed brokers, TLS, SCRAM with the user\'s mechanism, a group id that is never joined', async () => {
		const f = fakeKafka({});
		await new PlatformaticReader(TARGET, f.kafka).test();
		const o = f.options()!;
		assert.deepStrictEqual(o.bootstrapBrokers, ['seed-0.example:9092']);
		assert.deepStrictEqual(o.tls, {});
		assert.deepStrictEqual(o.sasl, { mechanism: 'SCRAM-SHA-256', username: 'logs-reader', password: 'pw-6-2-Kq8' });
		assert.strictEqual(o.autocreateTopics, false);
		assert.ok(!f.calls.some((c) => /join|commit|consume/i.test(c.op)));
	});

	test('test(): the topic\'s metadata, then one fetch at the end of a partition; closed afterwards', async () => {
		const f = fakeKafka({ records: [[0, 1_000, 'p1', '{}']] });
		await new PlatformaticReader(TARGET, f.kafka).test();
		assert.deepStrictEqual(f.calls.map((c) => c.op), ['metadata', 'listOffsets', 'fetch', 'close']);
		assert.deepStrictEqual(f.calls[1].args, { partitions: [0], timestamp: -1n });
		assert.deepStrictEqual(f.calls[2].args, { node: 0, maxWaitTime: 0, partitions: [[0, 101]] });
	});

	test('errors: SASL_AUTHENTICATION_FAILED nested in the aggregate is a refused sign-in; 29 a refused read; the rest a connection error', async () => {
		// Spike 6.1 capture 21's shape.
		const refused = Object.assign(new AggregateError([Object.assign(new Error('Connection to broker-1:9092 failed.'), {
			code: 'PLT_KFK_NETWORK',
			cause: Object.assign(new Error('SASL authentication failed.'), {
				code: 'PLT_KFK_AUTHENTICATION',
				cause: Object.assign(new AggregateError([Object.assign(new Error('SASL authentication failed.'), { apiCode: 58, apiId: 'SASL_AUTHENTICATION_FAILED' })], 'Received response with error'), { code: 'PLT_KFK_RESPONSE' }),
			}),
		})], 'Cannot connect to any broker.'), { code: 'PLT_KFK_MULTIPLE' });
		assert.strictEqual(classifyKafkaError(refused), 'signIn');
		assert.strictEqual(classifyKafkaError(new AggregateError([Object.assign(new Error('x'), { apiCode: 29, apiId: 'TOPIC_AUTHORIZATION_FAILED' })], 'y')), 'notAllowed');
		assert.strictEqual(classifyKafkaError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), 'connection');
		const f = fakeKafka({ connectError: refused });
		const err = await new PlatformaticReader(TARGET, f.kafka).test().then(() => undefined, (e: unknown) => e);
		assert.ok(isLogReadError(err), String(err));
		assert.strictEqual(err.kind, 'signIn');
		assert.match(err.message, /^Cannot connect to any broker: Connection to broker-1:9092 failed: SASL authentication failed: Received response with error$/);
		assert.deepStrictEqual(f.calls.map((c) => c.op), ['metadata', 'close'], 'closed after a failure too');
		const denied = await new PlatformaticReader(TARGET, fakeKafka({ fetchErrorCode: 29 }).kafka).test().then(() => undefined, (e: unknown) => e);
		assert.ok(isLogReadError(denied) && denied.kind === 'notAllowed', String(denied));
	});

	test('tail(): every partition from ListOffsets(fromTime), each leader fetched with a 2 s wait; every key delivered from the asked offset on, with the positions; closed on abort', async () => {
		const abort = new AbortController();
		const f = fakeKafka({
			partitions: 2,
			records: [[0, 1_000, 'old', '{}'], [0, 5_000, 'p1', '{"n":1}'], [0, 6_000, 'p2', '{"n":2}'], [1, 7_000, 'p1', '{"n":3}']],
			onFetch: (n) => (n === 4 ? abort.abort() : undefined),
		});
		const got: { records: readonly LogRecord[]; next: LogPositions }[] = [];
		await new PlatformaticReader(TARGET, f.kafka).tail('p1', 4_000, (records, next) => got.push({ records, next }), abort.signal);
		assert.deepStrictEqual(f.calls[1].args, { partitions: [0, 1], timestamp: 4_000n });
		const fetches = f.calls.filter((c) => c.op === 'fetch').map((c) => c.args as { node: number; maxWaitTime: number; partitions: [number, number][] });
		assert.deepStrictEqual(fetches.slice(0, 2).map((x) => [x.node, x.maxWaitTime, x.partitions]), [[0, FETCH_WAIT_MS, [[0, 101]]], [1, FETCH_WAIT_MS, [[1, 100]]]]);
		assert.deepStrictEqual(got[0].records.map((r) => [r.partition, r.offset, r.key, r.timestamp]), [[0, 101, 'p1', 5_000], [0, 102, 'p2', 6_000], [1, 100, 'p1', 7_000]]);
		assert.deepStrictEqual([...got[0].next], [[0, 103], [1, 101]]);
		assert.deepStrictEqual(fetches[2].partitions, [[0, 103]], 'the next fetch from the new position');
		assert.strictEqual(f.calls.at(-1)?.op, 'close');
	});

	test('tail(): resumeAt is where a stopped tail goes on (no ListOffsets for it); nothing after fromTime starts at the end', async () => {
		const abort = new AbortController();
		const f = fakeKafka({ records: [[0, 1_000, 'p1', '{}'], [0, 2_000, 'p1', '{}']], onFetch: () => abort.abort() });
		await new PlatformaticReader(TARGET, f.kafka).tail('p1', 0, () => undefined, abort.signal, new Map([[0, 101]]));
		assert.ok(!f.calls.some((c) => c.op === 'listOffsets'));
		assert.deepStrictEqual((f.calls.find((c) => c.op === 'fetch')!.args as { partitions: unknown }).partitions, [[0, 101]]);
		const abort2 = new AbortController();
		const g = fakeKafka({ records: [[0, 1_000, 'p1', '{}']], onFetch: () => abort2.abort() });
		await new PlatformaticReader(TARGET, g.kafka).tail('p1', 9_000, () => undefined, abort2.signal);
		assert.deepStrictEqual(g.calls.filter((c) => c.op === 'listOffsets').map((c) => c.args), [{ partitions: [0], timestamp: 9_000n }, { partitions: [0], timestamp: -1n }]);
		assert.deepStrictEqual((g.calls.find((c) => c.op === 'fetch')!.args as { partitions: unknown }).partitions, [[0, 101]]);
	});

	test('tail(): an aborted signal before the start reads nothing', async () => {
		const abort = new AbortController();
		abort.abort();
		const f = fakeKafka({});
		await new PlatformaticReader(TARGET, f.kafka).tail('p1', 0, () => undefined, abort.signal);
		assert.deepStrictEqual(f.calls, []);
	});

	test('tail(): NOT_LEADER_OR_FOLLOWER, LEADER_NOT_AVAILABLE or a reset connection: the leaders read again, the fetch retried at the new leader', async () => {
		const abort = new AbortController();
		const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
		const f = fakeKafka({
			records: [[0, 1_000, 'p1', '{}']],
			// The 1st fetch: the leader moved (6); the 2nd: none elected yet (5); the 3rd: the connection reset; the 4th reads.
			fetchFailures: { 1: 6, 2: 5, 3: reset },
			leaders: (read) => [read === 1 ? 0 : 3],
			onFetch: (n) => (n === 5 ? abort.abort() : undefined),
		});
		const got: LogRecord[] = [];
		await new PlatformaticReader(TARGET, f.kafka, { retryDelayMs: 0 }).tail('p1', 0, (records) => got.push(...records), abort.signal);
		const ops = f.calls.map((c) => c.op);
		assert.deepStrictEqual(ops, ['metadata', 'listOffsets', 'fetch', 'metadata', 'fetch', 'metadata', 'fetch', 'metadata', 'fetch', 'fetch', 'close']);
		assert.deepStrictEqual(f.calls.filter((c) => c.op === 'fetch').map((c) => (c.args as { node: number }).node), [0, 3, 3, 3, 3], 'the new leader');
		assert.deepStrictEqual(got.map((r) => r.offset), [100]);
	});

	test('tail(): a fetch that keeps failing is retried a few times, then the tail fails as a connection error', async () => {
		const abort = new AbortController();
		const f = fakeKafka({ fetchFailures: { 1: 6, 2: 6, 3: 6, 4: 6, 5: 6 } });
		const err = await new PlatformaticReader(TARGET, f.kafka, { retryDelayMs: 0, fetchRetries: 3 }).tail('p1', 0, () => undefined, abort.signal).then(() => undefined, (e: unknown) => e);
		assert.ok(isLogReadError(err) && err.kind === 'connection', String(err));
		assert.strictEqual(f.calls.filter((c) => c.op === 'fetch').length, 4, 'the first try and 3 retries');
		assert.strictEqual(f.calls.at(-1)?.op, 'close');
		const denied = fakeKafka({ fetchFailures: { 1: 29 } });
		const e2 = await new PlatformaticReader(TARGET, denied.kafka, { retryDelayMs: 0 }).tail('p1', 0, () => undefined, abort.signal).then(() => undefined, (e: unknown) => e);
		assert.ok(isLogReadError(e2) && e2.kind === 'notAllowed', String(e2));
		assert.strictEqual(denied.calls.filter((c) => c.op === 'fetch').length, 1, 'a refused read is not retried');
	});

	test('tail(): an abort while the client loads or the metadata is read sends nothing further; the client is closed', async () => {
		const abort = new AbortController();
		const f = fakeKafka({});
		const slow = async () => {
			const lib = await f.kafka();
			abort.abort();
			return lib;
		};
		await new PlatformaticReader(TARGET, slow).tail('p1', 0, () => undefined, abort.signal);
		assert.deepStrictEqual(f.calls.map((c) => c.op), ['close'], 'no metadata, no ListOffsets');
		const abort2 = new AbortController();
		const g = fakeKafka({ onMetadata: () => abort2.abort() });
		await new PlatformaticReader(TARGET, g.kafka).tail('p1', 0, () => undefined, abort2.signal);
		assert.ok(!g.calls.some((c) => c.op === 'listOffsets' || c.op === 'fetch'), JSON.stringify(g.calls.map((c) => c.op)));
		assert.strictEqual(g.calls.at(-1)?.op, 'close');
	});

	test('range(): every partition from ListOffsets(from) to ListOffsets(to + 1); fetches that do not wait; records past the stop not delivered; the positions after it', async () => {
		const abort = new AbortController();
		const f = fakeKafka({
			partitions: 2,
			records: [[0, 1_000, 'p1', '{"n":0}'], [0, 5_000, 'p1', '{"n":1}'], [0, 6_000, 'p2', '{"n":2}'], [0, 9_000, 'p1', '{"n":3}'], [1, 7_000, 'p1', '{"n":4}'], [1, 8_000, 'p1', '{"n":5}']],
		});
		const got: LogRecord[] = [];
		const end = await new PlatformaticReader(TARGET, f.kafka).range('p1', 4_000, 7_000, (records) => got.push(...records), abort.signal);
		const offsets = f.calls.filter((c) => c.op === 'listOffsets').map((c) => c.args);
		assert.deepStrictEqual(offsets, [{ partitions: [0, 1], timestamp: 4_000n }, { partitions: [0, 1], timestamp: -1n }, { partitions: [0, 1], timestamp: 7_001n }]);
		assert.deepStrictEqual(got.map((r) => [r.partition, r.offset, r.timestamp]), [[0, 101, 5_000], [0, 102, 6_000], [1, 100, 7_000]], 'from the start, up to the first record after to');
		assert.deepStrictEqual(f.calls.filter((c) => c.op === 'fetch').map((c) => (c.args as { maxWaitTime: number }).maxWaitTime), [0, 0]);
		assert.deepStrictEqual([...end.start], [[0, 101], [1, 100]]);
		assert.deepStrictEqual([...end.next], [[0, 103], [1, 101]]);
		assert.ok(!f.calls.some((c) => c.op === 'close'), 'the client stays open for the next call');
		abort.abort();
		await new Promise((r) => setImmediate(r));
		assert.strictEqual(f.calls.at(-1)?.op, 'close', 'closed once the signal aborts');
	});

	test('range(): an empty window is told by its offsets alone (no fetch); range and logStart share one client; logStart is ListOffsets earliest', async () => {
		const abort = new AbortController();
		const f = fakeKafka({ records: [[0, 1_000, 'p1', '{}'], [0, 9_000, 'p1', '{}']] });
		const reader = new PlatformaticReader(TARGET, f.kafka);
		const first = await reader.logStart(abort.signal);
		assert.deepStrictEqual([...first], [[0, 100]]);
		const end = await reader.range('p1', 2_000, 8_000, () => assert.fail('no records'), abort.signal);
		assert.deepStrictEqual([...end.start], [[0, 101]]);
		assert.deepStrictEqual([...end.next], [[0, 101]]);
		assert.ok(!f.calls.some((c) => c.op === 'fetch'));
		const before = await reader.range('p1', 0, 1_500, () => undefined, abort.signal);
		assert.deepStrictEqual([...before.start], [[0, 100]], 'a read from before the oldest record starts at the log\'s first offset');
		assert.strictEqual(f.calls.filter((c) => c.op === 'metadata').length, 3, 'one client, its metadata read per call');
		assert.ok(!f.calls.some((c) => c.op === 'close'));
		abort.abort();
	});

	test('range(): a failure closes the client and is a LogReadError; an aborted signal reads nothing', async () => {
		const f = fakeKafka({ records: [[0, 1_000, 'p1', '{}']], fetchFailures: { 1: 29 } });
		const err = await new PlatformaticReader(TARGET, f.kafka).range('p1', 0, 5_000, () => undefined, new AbortController().signal).then(() => undefined, (e: unknown) => e);
		assert.ok(isLogReadError(err) && err.kind === 'notAllowed', String(err));
		assert.strictEqual(f.calls.at(-1)?.op, 'close');
		const aborted = new AbortController();
		aborted.abort();
		const g = fakeKafka({});
		await new PlatformaticReader(TARGET, g.kafka).range('p1', 0, 5_000, () => undefined, aborted.signal);
		assert.deepStrictEqual(g.calls, []);
	});

	test('retentionMs(): DescribeConfigs of the topic\'s retention.ms through an Admin, closed afterwards; refused: undefined', async () => {
		const f = fakeKafka({});
		assert.strictEqual(await new PlatformaticReader(TARGET, f.kafka).retentionMs(new AbortController().signal), 604_800_000);
		assert.deepStrictEqual(f.calls.find((c) => c.op === 'describeConfigs')?.args, [{ resourceType: 2, resourceName: LOGS_TOPIC, configurationKeys: ['retention.ms'] }]);
		assert.deepStrictEqual((f.calls.find((c) => c.op === 'admin')?.args as { sasl: unknown }).sasl, TARGET.access && { mechanism: 'SCRAM-SHA-256', username: 'logs-reader', password: 'pw-6-2-Kq8' });
		assert.strictEqual(f.calls.at(-1)?.op, 'adminClose');
		const refused = fakeKafka({ retention: Object.assign(new Error('Cluster authorization failed.'), { apiCode: 31 }) });
		assert.strictEqual(await new PlatformaticReader(TARGET, refused.kafka).retentionMs(new AbortController().signal), undefined);
		assert.strictEqual(refused.calls.at(-1)?.op, 'adminClose');
		assert.strictEqual(await new PlatformaticReader(TARGET, fakeKafka({ retention: '-1' }).kafka).retentionMs(new AbortController().signal), -1);
	});

	test('range(): fetches that answer no records below the stop are tried again with a wait until records come; a partition silent for the time limit is given up and named', async () => {
		const abort = new AbortController();
		const f = fakeKafka({ records: [[0, 1_000, 'p1', '{}'], [0, 2_000, 'p1', '{}']], emptyFetches: 4 });
		const got: LogRecord[] = [];
		const end = await new PlatformaticReader(TARGET, f.kafka, { emptyWaitMs: 500 }).range('p1', 0, 5_000, (records) => got.push(...records), abort.signal);
		assert.deepStrictEqual(got.map((r) => r.offset), [100, 101], 'every record, after 4 empty answers');
		assert.deepStrictEqual(f.calls.filter((c) => c.op === 'fetch').map((c) => (c.args as { maxWaitTime: number }).maxWaitTime), [0, 500, 500, 500, 500]);
		assert.strictEqual(end.stalled, undefined);
		abort.abort();
		const g = fakeKafka({ records: [[0, 1_000, 'p1', '{}']], emptyFetches: 100 });
		const stalled = await new PlatformaticReader(TARGET, g.kafka, { emptyWaitMs: 0, stallMs: 0 }).range('p1', 0, 5_000, () => undefined, new AbortController().signal);
		assert.deepStrictEqual(stalled.stalled, [0]);
		assert.deepStrictEqual([...stalled.next], [[0, 100]], 'where it stopped');
		assert.strictEqual(g.calls.filter((c) => c.op === 'fetch').length, 2);
	});

	test('timeBefore(): a week of silence with one record before it: the record just before the start (not below the log\'s start), one fetch', async () => {
		const abort = new AbortController();
		const week = 7 * 24 * 3_600_000;
		const now = 10 * week;
		const f = fakeKafka({ partitions: 2, records: [[0, now - week - 60_000, 'p1', '{}'], [0, now - 60_000, 'p1', '{}'], [1, now - 2 * week, 'p2', '{}']] });
		const reader = new PlatformaticReader(TARGET, f.kafka);
		// An empty window in the silence: it starts at the record after it on each partition.
		const end = await reader.range('p1', now - 3_600_000, now - 1_800_000, () => assert.fail('no records'), abort.signal);
		assert.deepStrictEqual([...end.start], [[0, 101], [1, 101]]);
		assert.strictEqual(await reader.timeBefore(end.start, abort.signal), now - week - 60_000, 'the newest record before it');
		assert.deepStrictEqual(f.calls.filter((c) => c.op === 'fetch').map((c) => (c.args as { partitions: unknown }).partitions), [[[0, 100]], [[1, 100]]]);
		assert.strictEqual(await reader.timeBefore(new Map([[0, 100], [1, 100]]), abort.signal), undefined, 'none below the log\'s start');
		abort.abort();
	});
});
