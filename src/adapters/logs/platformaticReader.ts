// The `LogReader` on `@platformatic/kafka` (AD-24, ticket 6.2; spike 6.1's `platformaticClient`):
// a `Consumer` that never joins its group (only `consume()` and `joinGroup()` use the group id, and
// neither is called), so nothing is committed: metadata of the topic, ListOffsets by time, and Fetch
// on each partition's leader. TLS with the system CAs, SASL SCRAM with the user's mechanism; the
// password is handed to the client in memory only. The library is loaded on first use (the bundle
// evaluates it then), so activation does not pay for it. No `vscode` import.
//
// Errors: a refused sign-in is `SASL_AUTHENTICATION_FAILED` (Kafka 58) nested in the client's
// aggregate "Cannot connect to any broker." (spike capture 21); an authorization error (29, 31) is a
// refused read; anything else is a connection error. A fetch that fails as a connection error or with
// NOT_LEADER_OR_FOLLOWER (6) or LEADER_NOT_AVAILABLE (5), as when a partition's leadership moves or a
// connection is reset, reads the topic's metadata (its leaders) again and is retried a few times, with
// a short backoff, before the tail fails. Once the signal aborts (the tab hidden, another pipeline),
// nothing more is sent: the signal is checked after every step of the start, and the client closed.

import { type LogPositions, type LogReader, LogReadError, type LogReadErrorKind, type LogRecord, type LogTarget, LOGS_TOPIC } from './logReader';
import { newerVsCodeMessage, nodeSupported } from './runtime';

type Kafka = typeof import('@platformatic/kafka', { with: { 'resolution-mode': 'import' } });
type Consumer = InstanceType<Kafka['Consumer']>;

let loading: Promise<Kafka> | undefined;

/** The client library, loaded once. */
export function loadKafka(): Promise<Kafka> {
	if (!nodeSupported()) {
		return Promise.reject(new LogReadError('connection', newerVsCodeMessage()));
	}
	loading ??= import('@platformatic/kafka');
	return loading;
}

/** The live fetch's wait (AD-24). */
export const FETCH_WAIT_MS = 2_000;
const FETCH_MAX_BYTES = 4 * 1024 * 1024;
const CLIENT_ID = 'rpcn-vscode-logs';

const KAFKA_SIGN_IN = new Set([58, 33, 34]);
const KAFKA_NOT_ALLOWED = new Set([29, 31]);
const KAFKA_OFFSET_OUT_OF_RANGE = 1;
/** A partition's leader moved or is being elected: read the leaders again and retry. */
const KAFKA_LEADER_MOVED = new Set([5, 6]);

/** A fetch failure worth reading the leaders again for and retrying. */
class RetriableFetchError extends LogReadError {
	constructor(message: string) {
		super('connection', message);
	}
}

export interface PlatformaticReaderOptions {
	/** How many times a failed fetch is retried (after reading the leaders again). */
	readonly fetchRetries?: number;
	/** The backoff before retry n (1-based) is n times this. */
	readonly retryDelayMs?: number;
}

/** Thrown inside the start once the signal aborted: nothing more is sent. */
class Aborted extends Error {}

/** The kind of a client error: its nested errors (`errors`, `cause`) searched for a Kafka code. */
export function classifyKafkaError(err: unknown): LogReadErrorKind {
	let found: LogReadErrorKind = 'connection';
	const walk = (e: unknown, depth: number) => {
		if (depth > 8 || e === null || typeof e !== 'object' || found === 'signIn') {
			return;
		}
		const x = e as { apiCode?: unknown; apiId?: unknown; code?: unknown; errors?: unknown; cause?: unknown };
		const code = typeof x.apiCode === 'number' ? x.apiCode : undefined;
		if ((code !== undefined && KAFKA_SIGN_IN.has(code)) || x.apiId === 'SASL_AUTHENTICATION_FAILED' || x.code === 'PLT_KFK_AUTHENTICATION') {
			found = 'signIn';
			return;
		}
		if ((code !== undefined && KAFKA_NOT_ALLOWED.has(code)) || (typeof x.apiId === 'string' && x.apiId.endsWith('_AUTHORIZATION_FAILED'))) {
			found = 'notAllowed';
		}
		if (Array.isArray(x.errors)) {
			x.errors.forEach((n) => walk(n, depth + 1));
		}
		walk(x.cause, depth + 1);
	};
	walk(err, 0);
	return found;
}

/** The innermost message that says most: the Kafka error's, else the outer one with its first cause. */
function kafkaMessage(err: unknown): string {
	const parts: string[] = [];
	let e: unknown = err;
	for (let depth = 0; depth < 6 && e && typeof e === 'object'; depth++) {
		const x = e as { message?: unknown; errors?: unknown; cause?: unknown };
		const text = typeof x.message === 'string' ? x.message.trim().replace(/\.$/, '') : '';
		if (text && !parts.includes(text)) {
			parts.push(text);
		}
		e = Array.isArray(x.errors) && x.errors.length > 0 ? x.errors[0] : x.cause;
	}
	return parts.length > 0 ? parts.join(': ') : String(err);
}

function asLogReadError(err: unknown): LogReadError {
	if (err instanceof LogReadError) {
		return err;
	}
	return new LogReadError(classifyKafkaError(err), kafkaMessage(err));
}

interface Partitions {
	readonly topicId: string;
	/** Partition index → its leader's node id. */
	readonly leaders: ReadonlyMap<number, number>;
}

export class PlatformaticReader implements LogReader {
	private consumer: Consumer | undefined;

	private readonly fetchRetries: number;
	private readonly retryDelayMs: number;

	constructor(private readonly target: LogTarget, private readonly kafka: () => Promise<Kafka> = loadKafka, options: PlatformaticReaderOptions = {}) {
		this.fetchRetries = options.fetchRetries ?? 3;
		this.retryDelayMs = options.retryDelayMs ?? 500;
	}

	private async open(): Promise<Consumer> {
		const { Consumer } = await this.kafka();
		const { access, brokers } = this.target;
		this.consumer = new Consumer({
			clientId: CLIENT_ID,
			// Never joined: no group, no commit (AD-24).
			groupId: `${CLIENT_ID}-never-joined`,
			bootstrapBrokers: [...brokers],
			tls: {},
			sasl: { mechanism: access.mechanism, username: access.username, password: access.password },
			autocreateTopics: false,
			retries: 1,
			retryDelay: 300,
			connectTimeout: 10_000,
			requestTimeout: 30_000,
		});
		return this.consumer;
	}

	private async close(): Promise<void> {
		const consumer = this.consumer;
		this.consumer = undefined;
		await consumer?.close(true).catch(() => undefined);
	}

	private async partitions(consumer: Consumer): Promise<Partitions> {
		const md = await consumer.metadata({ topics: [LOGS_TOPIC], autocreateTopics: false, forceUpdate: true });
		const topic = md.topics.get(LOGS_TOPIC);
		if (!topic) {
			throw new LogReadError('connection', `the topic ${LOGS_TOPIC} is not on this cluster`);
		}
		return { topicId: topic.id, leaders: new Map(topic.partitions.map((p, i) => [i, p.leader])) };
	}

	/** The first offset at or after `time` on each partition (the end when there is none). */
	private async offsetsAt(consumer: Consumer, partitions: readonly number[], time: bigint): Promise<Map<number, number>> {
		const r = await consumer.listOffsetsWithTimestamps({ topics: [LOGS_TOPIC], partitions: { [LOGS_TOPIC]: [...partitions] }, timestamp: time, isolationLevel: 0 });
		const m = r.get(LOGS_TOPIC);
		const out = new Map<number, number>();
		const missing: number[] = [];
		for (const p of partitions) {
			const offset = m?.get(p)?.offset;
			if (offset !== undefined && offset >= 0n) {
				out.set(p, Number(offset));
			} else {
				missing.push(p);
			}
		}
		if (missing.length > 0 && time !== -1n) {
			for (const [p, o] of await this.offsetsAt(consumer, missing, -1n)) {
				out.set(p, o);
			}
		}
		return out;
	}

	/** One fetch of `at`'s partitions led by `leader`: the records from each position, and the new positions. */
	private async fetchFrom(consumer: Consumer, parts: Partitions, leader: number, at: Map<number, number>, maxWaitMs: number): Promise<{ records: LogRecord[]; outOfRange: number[] }> {
		const mine = [...at].filter(([p]) => parts.leaders.get(p) === leader);
		const r = await consumer.fetch({
			node: leader, maxWaitTime: maxWaitMs, minBytes: 1, maxBytes: FETCH_MAX_BYTES, isolationLevel: 0,
			topics: [{ topicId: parts.topicId, partitions: mine.map(([partition, offset]) => ({ partition, currentLeaderEpoch: -1, fetchOffset: BigInt(offset), lastFetchedEpoch: -1, partitionMaxBytes: FETCH_MAX_BYTES })) }],
		});
		const records: LogRecord[] = [];
		const outOfRange: number[] = [];
		for (const topic of r.responses) {
			for (const p of topic.partitions) {
				if (p.errorCode === KAFKA_OFFSET_OUT_OF_RANGE) {
					outOfRange.push(p.partitionIndex);
					continue;
				}
				if (KAFKA_LEADER_MOVED.has(p.errorCode)) {
					throw new RetriableFetchError(`the leader of partition ${p.partitionIndex} moved (Kafka error ${p.errorCode})`);
				}
				if (p.errorCode) {
					const kind: LogReadErrorKind = KAFKA_NOT_ALLOWED.has(p.errorCode) ? 'notAllowed' : 'connection';
					throw new LogReadError(kind, kind === 'notAllowed' ? `not allowed to read ${LOGS_TOPIC} (Kafka error ${p.errorCode})` : `the fetch failed (Kafka error ${p.errorCode})`);
				}
				const from = at.get(p.partitionIndex) ?? 0;
				let next = from;
				for (const batch of p.records ?? []) {
					for (const rec of batch.records) {
						const offset = Number(batch.firstOffset + BigInt(rec.offsetDelta));
						if (offset < from) {
							continue;
						}
						records.push({
							partition: p.partitionIndex,
							offset,
							timestamp: Number(batch.firstTimestamp + rec.timestampDelta),
							key: rec.key ? rec.key.toString('utf8') : null,
							value: rec.value ? rec.value.toString('utf8') : null,
						});
						next = Math.max(next, offset + 1);
					}
				}
				at.set(p.partitionIndex, next);
			}
		}
		return { records, outOfRange };
	}

	async test(): Promise<void> {
		try {
			const consumer = await this.open();
			const parts = await this.partitions(consumer);
			const first = [...parts.leaders.keys()].slice(0, 1);
			if (first.length === 0) {
				throw new LogReadError('connection', `the topic ${LOGS_TOPIC} has no partitions`);
			}
			// One fetch at the end: it needs Read on the topic, and returns at once.
			const at = await this.offsetsAt(consumer, first, -1n);
			await this.fetchFrom(consumer, parts, parts.leaders.get(first[0])!, at, 0);
		} catch (err) {
			throw asLogReadError(err);
		} finally {
			await this.close();
		}
	}

	async tail(
		_pipelineId: string,
		fromTime: number,
		onRecords: (records: readonly LogRecord[], next: LogPositions) => void,
		signal: AbortSignal,
		resumeAt?: LogPositions,
	): Promise<void> {
		if (signal.aborted) {
			return;
		}
		const onAbort = () => void this.close();
		signal.addEventListener('abort', onAbort);
		const step = <T>(value: T): T => {
			if (signal.aborted) {
				throw new Aborted();
			}
			return value;
		};
		try {
			const consumer = step(await this.open());
			let parts = step(await this.partitions(consumer));
			// Every partition (AD-24: until a story proves the placement by key).
			const all = [...parts.leaders.keys()];
			const unknown = all.filter((p) => resumeAt?.get(p) === undefined);
			const at = new Map<number, number>(all.filter((p) => resumeAt?.get(p) !== undefined).map((p) => [p, resumeAt!.get(p)!]));
			for (const [p, o] of unknown.length > 0 ? step(await this.offsetsAt(consumer, unknown, BigInt(Math.floor(fromTime)))) : []) {
				at.set(p, o);
			}
			let failures = 0;
			while (!signal.aborted) {
				let fetched: { records: LogRecord[]; outOfRange: number[] }[];
				try {
					const current = parts;
					const leaders = [...new Set(all.map((p) => current.leaders.get(p)!))];
					fetched = await Promise.all(leaders.map((leader) => this.fetchFrom(consumer, current, leader, at, FETCH_WAIT_MS)));
					failures = 0;
				} catch (err) {
					const retriable = err instanceof RetriableFetchError || (!(err instanceof LogReadError) && classifyKafkaError(err) === 'connection');
					if (signal.aborted || !retriable || ++failures > this.fetchRetries) {
						throw err;
					}
					// The leaders may have moved: read them again after a short backoff, then fetch again.
					await new Promise((r) => setTimeout(r, failures * this.retryDelayMs));
					parts = step(await this.partitions(consumer));
					continue;
				}
				if (signal.aborted) {
					break;
				}
				// A position below the log's start (retention passed): from its first offset (ListOffsets earliest).
				const outOfRange = fetched.flatMap((f) => f.outOfRange);
				if (outOfRange.length > 0) {
					for (const [p, o] of step(await this.offsetsAt(consumer, outOfRange, -2n))) {
						at.set(p, o);
					}
				}
				onRecords(fetched.flatMap((f) => f.records), new Map(at));
			}
		} catch (err) {
			if (!signal.aborted) {
				throw asLogReadError(err);
			}
		} finally {
			signal.removeEventListener('abort', onAbort);
			await this.close();
		}
	}
}

/**
 * Loads the client as the extension runs it and reports how it computes CRC-32C (the test seam of
 * the bundle check): `native` is whether the optional native `@node-rs/crc32` was loaded (the bundle
 * leaves it out, so never), `crc32c` the checksum of "123456789" (0xe3069283 when correct).
 */
export async function checkClient(): Promise<{ readonly native: boolean; readonly crc32c: number }> {
	const kafka = await loadKafka();
	return { native: kafka.loadNativeCRC32C() !== null, crc32c: kafka.crc32c(Buffer.from('123456789', 'ascii')) };
}
