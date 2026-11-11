// The `LogReader` on `@platformatic/kafka` (AD-24, tickets 6.2, 6.3; spike 6.1's `platformaticClient`):
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
//
// History (ticket 6.3): `range` reads forward from ListOffsets(from) to the first record after `to`
// (ListOffsets(to + 1)) or the end offsets taken at its start, with fetches that do not wait; records
// older than the brokers' local retention come from tiered storage through the same fetch. `range` and
// `logStart` share one client per reader until their signal aborts, so a walk back through empty windows
// signs in once. `retentionMs` asks DescribeConfigs through a short-lived `Admin`; a refusal is
// `undefined`.

import { type LogPositions, type LogRangeEnd, type LogReader, LogReadError, type LogReadErrorKind, type LogRecord, type LogTarget, LOGS_TOPIC } from './logReader';
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
/** DescribeConfigs' resource type of a topic. */
const TOPIC_RESOURCE = 2 as const;

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
	/** A bounded read's fetch wait once a partition answered no records below its stop (default 500 ms). */
	readonly emptyWaitMs?: number;
	/** How long a partition of a bounded read may answer no records, or have no leader, before it is given up (default 30 s). */
	readonly stallMs?: number;
	/** How often the leaders are read again while a partition has none (default 1 s). */
	readonly leaderWaitMs?: number;
	/** The output channel (a partition without a leader is named there). */
	readonly log?: (line: string) => void;
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
	/** Partition id → its leader's node id; a partition without a leader (−1, or missing from the answer) is not in it. */
	readonly leaders: ReadonlyMap<number, number>;
	/** Every partition id the answer covers (0 to its last), those without a leader too. */
	readonly all: readonly number[];
}

/** A failure worth trying again: a moved leader, or a connection error of the client (not a refusal, not an abort). */
function retriable(err: unknown): boolean {
	return err instanceof RetriableFetchError || (!(err instanceof LogReadError) && !(err instanceof Aborted) && classifyKafkaError(err) === 'connection');
}

/** Waits `ms`, or less once `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
	});
}

export class PlatformaticReader implements LogReader {
	private consumer: Consumer | undefined;
	/** The client `range` and `logStart` share, while it opens. */
	private opening: Promise<Consumer> | undefined;
	/** The signals that close the shared client when they abort. */
	private readonly watched = new WeakSet<AbortSignal>();

	private readonly fetchRetries: number;
	private readonly retryDelayMs: number;
	private readonly emptyWaitMs: number;
	private readonly stallMs: number;
	private readonly leaderWaitMs: number;
	private readonly log: (line: string) => void;
	/** The most partitions a metadata answer of this reader named (a later answer missing the last ones has holes). */
	private partitionCount = 0;
	/** Each partition without a leader now, since when (kept across the reader's reads, so a later range does not wait again). */
	private readonly unled = new Map<number, number>();
	/** The partitions a range gave up for having no leader, said once until they get one. */
	private readonly givenUp = new Set<number>();

	constructor(private readonly target: LogTarget, private readonly kafka: () => Promise<Kafka> = loadKafka, options: PlatformaticReaderOptions = {}) {
		this.fetchRetries = options.fetchRetries ?? 3;
		this.retryDelayMs = options.retryDelayMs ?? 500;
		this.emptyWaitMs = options.emptyWaitMs ?? 500;
		this.stallMs = options.stallMs ?? 30_000;
		this.leaderWaitMs = options.leaderWaitMs ?? 1_000;
		this.log = options.log ?? (() => undefined);
	}

	/** The client options both the Consumer and the Admin get: the address, TLS, SCRAM. */
	private baseOptions() {
		const { access, brokers } = this.target;
		return {
			clientId: CLIENT_ID,
			bootstrapBrokers: [...brokers],
			tls: {},
			sasl: { mechanism: access.mechanism, username: access.username, password: access.password },
			autocreateTopics: false,
			retries: 1,
			retryDelay: 300,
			connectTimeout: 10_000,
			requestTimeout: 30_000,
		};
	}

	private async open(): Promise<Consumer> {
		const { Consumer } = await this.kafka();
		// Never joined: no group, no commit (AD-24).
		this.consumer = new Consumer({ ...this.baseOptions(), groupId: `${CLIENT_ID}-never-joined` });
		return this.consumer;
	}

	/** The client `range` and `logStart` share; it is closed once `signal` aborts. */
	private shared(signal: AbortSignal): Promise<Consumer> {
		if (!this.watched.has(signal)) {
			this.watched.add(signal);
			signal.addEventListener('abort', () => void this.close(), { once: true });
		}
		if (this.consumer) {
			return Promise.resolve(this.consumer);
		}
		this.opening ??= this.open().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	private async close(): Promise<void> {
		const consumer = this.consumer;
		this.consumer = undefined;
		this.opening = undefined;
		await consumer?.close(true).catch(() => undefined);
	}

	private async partitions(consumer: Consumer): Promise<Partitions> {
		const md = await consumer.metadata({ topics: [LOGS_TOPIC], autocreateTopics: false, forceUpdate: true });
		const topic = md.topics.get(LOGS_TOPIC);
		if (!topic) {
			throw new LogReadError('connection', `the topic ${LOGS_TOPIC} is not on this cluster`);
		}
		// The client keeps each partition at its id (`partitions[partitionIndex]`); one missing from the answer is
		// a hole, and a leader of −1 is an election in progress: neither is fetched until it has a leader. The
		// most partitions seen on this reader count, so one missing at the end is a hole too.
		this.partitionCount = Math.max(this.partitionCount, topic.partitions.length);
		const leaders = new Map<number, number>();
		const all: number[] = [];
		const now = Date.now();
		for (let id = 0; id < this.partitionCount; id++) {
			all.push(id);
			const leader = (topic.partitions[id] as { leader?: unknown } | undefined)?.leader;
			if (typeof leader === 'number' && leader >= 0) {
				leaders.set(id, leader);
				// It has a leader again: a later loss is waited on (and named) afresh.
				this.unled.delete(id);
				this.givenUp.delete(id);
			} else if (!this.unled.has(id)) {
				this.unled.set(id, now);
				this.log(`Pipeline logs: partition ${id} of ${LOGS_TOPIC} has no leader now; it is read once it has one.`);
			}
		}
		return { topicId: topic.id, leaders, all };
	}

	/** Since when partition `p` has had no leader, as this reader saw it (`undefined`: it has one). */
	private unledSince(p: number): number | undefined {
		return this.unled.get(p);
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
					// Past the whole batch, also one with no record at or after the position (compacted away, a
					// control batch): the next fetch asks after it. The client decodes only whole batches (a batch
					// cut by the response's size is left out, `readRecordsBatches`), so `lastOffsetDelta` is read.
					if (typeof batch.lastOffsetDelta === 'number' && batch.lastOffsetDelta >= 0) {
						next = Math.max(next, Number(batch.firstOffset) + batch.lastOffsetDelta + 1);
					}
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

	/**
	 * One fetch of `at`'s partitions from each of their leaders. A moved leader or a connection error
	 * reads the leaders again (into `state`) and retries, a few times with a growing backoff; a
	 * position below the log's start (retention passed) goes on from its first offset.
	 */
	private async fetchRound(consumer: Consumer, state: { parts: Partitions }, at: Map<number, number>, maxWaitMs: number, signal: AbortSignal, step: <T>(v: T) => T): Promise<LogRecord[]> {
		let failures = 0;
		let reread = false;
		for (;;) {
			let fetched: { records: LogRecord[]; outOfRange: number[] }[];
			try {
				if (reread) {
					// A failed read of the leaders is retried as a failed fetch is.
					state.parts = step(await this.partitions(consumer));
					reread = false;
				}
				const current = state.parts;
				// A partition without a leader now is left out of this round (it keeps its position).
				const leaders = [...new Set([...at.keys()].map((p) => current.leaders.get(p)).filter((l): l is number => l !== undefined))];
				fetched = await Promise.all(leaders.map((leader) => this.fetchFrom(consumer, current, leader, at, maxWaitMs)));
			} catch (err) {
				if (signal.aborted || !retriable(err) || ++failures > this.fetchRetries) {
					throw err;
				}
				// The leaders may have moved: read them again after a short backoff, then fetch again.
				await sleep(failures * this.retryDelayMs, signal);
				reread = true;
				continue;
			}
			// A position below the log's start (retention passed): from its first offset (ListOffsets earliest).
			const outOfRange = fetched.flatMap((f) => f.outOfRange);
			if (outOfRange.length > 0 && !signal.aborted) {
				for (const [p, o] of step(await this.offsetsAt(consumer, outOfRange, -2n))) {
					at.set(p, o);
				}
			}
			return fetched.flatMap((f) => f.records);
		}
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
		const step = abortStep(signal);
		try {
			const consumer = step(await this.open());
			const state = { parts: step(await this.partitions(consumer)) };
			// Every partition (AD-24: until a story proves the placement by key); one without a leader is
			// placed (its position found) once it has one.
			const at = new Map<number, number>();
			const place = async () => {
				const led = state.parts.all.filter((p) => !at.has(p) && state.parts.leaders.has(p));
				for (const p of led.filter((x) => resumeAt?.get(x) !== undefined)) {
					at.set(p, resumeAt!.get(p)!);
				}
				const unknown = led.filter((p) => resumeAt?.get(p) === undefined);
				if (unknown.length > 0) {
					for (const [p, o] of step(await this.retried(() => this.offsetsAt(consumer, unknown, BigInt(Math.floor(fromTime))), signal))) {
						at.set(p, o);
					}
				}
			};
			await place();
			let checked = Date.now();
			while (!signal.aborted) {
				if (state.parts.all.some((p) => !state.parts.leaders.has(p)) && Date.now() - checked >= this.leaderWaitMs) {
					// A partition without a leader: its leader read again now and then.
					state.parts = step(await this.retried(() => this.partitions(consumer), signal));
					checked = Date.now();
				}
				await place();
				if (![...at.keys()].some((p) => state.parts.leaders.has(p))) {
					// Nothing has a leader: wait, then read the leaders again.
					await sleep(this.leaderWaitMs, signal);
					checked = 0;
					continue;
				}
				const records = await this.fetchRound(consumer, state, at, FETCH_WAIT_MS, signal, step);
				if (signal.aborted) {
					break;
				}
				onRecords(records, this.positionsOf(at, resumeAt));
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

	/** The positions to resume at: `at`, and `resumeAt`'s for a partition not placed yet (no leader). */
	private positionsOf(at: ReadonlyMap<number, number>, resumeAt: LogPositions | undefined): Map<number, number> {
		const out = new Map(at);
		for (const [p, o] of resumeAt ?? []) {
			if (!out.has(p)) {
				out.set(p, o);
			}
		}
		return out;
	}

	/** `read` retried as a failed fetch is (a connection error: a few times, with a growing backoff). */
	private async retried<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
		for (let failures = 0; ; ) {
			try {
				return await read();
			} catch (err) {
				if (signal.aborted || !retriable(err) || ++failures > this.fetchRetries) {
					throw err;
				}
				await sleep(failures * this.retryDelayMs, signal);
			}
		}
	}

	async range(
		_pipelineId: string,
		fromTime: number,
		toTime: number,
		onRecords: (records: readonly LogRecord[], next: LogPositions) => void,
		signal: AbortSignal,
		resumeAt?: LogPositions,
	): Promise<LogRangeEnd> {
		const start = new Map<number, number>();
		const at = new Map<number, number>();
		if (signal.aborted) {
			return { start, next: this.positionsOf(at, resumeAt) };
		}
		const step = abortStep(signal);
		// A partition placed late stops where the range would have stopped when it began: never past `toTime`
		// nor past the time the read started.
		const stopTime = Math.min(Math.floor(toTime), Date.now());
		try {
			const consumer = step(await this.shared(signal));
			const state = { parts: step(await this.partitions(consumer)) };
			const stop = new Map<number, number>();
			// Every partition (AD-24: until a story proves the placement by key), each placed (its start and stop
			// found) once it has a leader; a partition named in `resumeAt` goes on from there.
			const place = async () => {
				const led = state.parts.all.filter((p) => !stop.has(p) && state.parts.leaders.has(p));
				if (led.length === 0) {
					return;
				}
				const late = stop.size > 0;
				const offsets = (time: bigint) => this.retried(() => this.offsetsAt(consumer, led, time), signal);
				const from = step(await offsets(BigInt(Math.floor(fromTime))));
				const end = step(await offsets(-1n));
				const after = step(await offsets(BigInt((late ? stopTime : Math.floor(toTime)) + 1)));
				for (const p of led) {
					const s = from.get(p) ?? end.get(p) ?? 0;
					start.set(p, s);
					at.set(p, resumeAt?.get(p) ?? s);
					stop.set(p, Math.min(end.get(p) ?? 0, after.get(p) ?? end.get(p) ?? 0));
				}
			};
			await place();
			// Since when each partition has answered no records below its stop (a tiered-storage read can
			// answer empty for a while): fetched again with a wait, given up after `stallMs`. A partition without
			// a leader is waited on, its leader read again, and given up `stallMs` after it lost it (as this
			// reader saw: a later range does not wait again for one still without a leader).
			const emptySince = new Map<number, number>();
			const stalled: number[] = [];
			const leaderless: number[] = [];
			const waiting = () => state.parts.all.filter((p) => !stalled.includes(p) && !leaderless.includes(p) && !state.parts.leaders.has(p)
				&& (!stop.has(p) || at.get(p)! < stop.get(p)!));
			let checked = Date.now();
			for (;;) {
				if (waiting().length > 0 && Date.now() - checked >= this.leaderWaitMs) {
					// A partition without a leader: its leader read again now and then, and placed once it has one.
					state.parts = step(await this.retried(() => this.partitions(consumer), signal));
					checked = Date.now();
					await place();
				}
				const now = Date.now();
				for (const p of waiting()) {
					// Without a leader, it is not answering empty: that wait is its own.
					emptySince.delete(p);
					if (now - (this.unledSince(p) ?? now) >= this.stallMs) {
						leaderless.push(p);
					}
				}
				const pending = new Map([...at].filter(([p, o]) => o < stop.get(p)! && !stalled.includes(p) && !leaderless.includes(p) && state.parts.leaders.has(p)));
				if (signal.aborted || (pending.size === 0 && waiting().length === 0)) {
					break;
				}
				if (pending.size === 0) {
					// Only partitions without a leader are left: wait, then read the leaders again.
					await sleep(Math.min(this.leaderWaitMs, this.stallMs), signal);
					checked = 0;
					continue;
				}
				const wait = [...pending.keys()].some((p) => emptySince.has(p)) ? this.emptyWaitMs : 0;
				const records = await this.fetchRound(consumer, state, pending, wait, signal, step);
				if (signal.aborted) {
					break;
				}
				const after = Date.now();
				for (const [p, o] of pending) {
					if (!state.parts.leaders.has(p)) {
						// It lost its leader in this round (the fetch's retries read the leaders again): not fetched, not empty.
						emptySince.delete(p);
						continue;
					}
					const moved = o > at.get(p)!;
					at.set(p, Math.min(o, stop.get(p)!));
					if (moved) {
						emptySince.delete(p);
					} else if (!emptySince.has(p)) {
						emptySince.set(p, after);
					} else if (after - emptySince.get(p)! >= this.stallMs) {
						stalled.push(p);
					}
				}
				if (waiting().length > 0) {
					// A partition may have got a leader meanwhile (the fetch's retries read the leaders again).
					await place();
				}
				onRecords(records.filter((r) => r.offset < stop.get(r.partition)!), this.positionsOf(at, resumeAt));
			}
			const told = leaderless.filter((p) => !this.givenUp.has(p));
			if (told.length > 0) {
				told.forEach((p) => this.givenUp.add(p));
				this.log(`Pipeline logs: partition ${told.join(', ')} of ${LOGS_TOPIC} had no leader for ${Math.round(this.stallMs / 1000)} s; reads go on without it until it has one.`);
			}
			return { start, next: this.positionsOf(at, resumeAt), ...(stalled.length > 0 ? { stalled } : {}), ...(leaderless.length > 0 ? { leaderless } : {}) };
		} catch (err) {
			if (signal.aborted) {
				return { start, next: this.positionsOf(at, resumeAt) };
			}
			await this.close();
			throw asLogReadError(err);
		}
	}

	async logStart(signal: AbortSignal): Promise<LogPositions> {
		if (signal.aborted) {
			return new Map();
		}
		const step = abortStep(signal);
		try {
			const consumer = step(await this.shared(signal));
			const parts = step(await this.partitions(consumer));
			const first = step(await this.offsetsAt(consumer, [...parts.leaders.keys()], -2n));
			// A partition without a leader: its first offset unknown (-1), so no read is "at the log's start" there.
			return new Map(parts.all.map((p) => [p, first.get(p) ?? -1]));
		} catch (err) {
			if (signal.aborted) {
				return new Map();
			}
			await this.close();
			throw asLogReadError(err);
		}
	}

	async timeBefore(start: LogPositions, signal: AbortSignal): Promise<number | undefined> {
		if (signal.aborted) {
			return undefined;
		}
		const step = abortStep(signal);
		try {
			const consumer = step(await this.shared(signal));
			const state = { parts: step(await this.partitions(consumer)) };
			const first = step(await this.offsetsAt(consumer, [...start.keys()].filter((p) => state.parts.leaders.has(p)), -2n));
			const at = new Map([...start].map(([p, o]) => [p, o - 1] as const).filter(([p, o]) => o >= 0 && o >= (first.get(p) ?? Infinity)));
			if (at.size === 0) {
				return undefined;
			}
			const wanted = new Map(at);
			const records = await this.fetchRound(consumer, state, at, 0, signal, step);
			const times = records.filter((r) => wanted.get(r.partition) === r.offset).map((r) => r.timestamp);
			return times.length > 0 ? Math.max(...times) : undefined;
		} catch (err) {
			if (signal.aborted) {
				return undefined;
			}
			await this.close();
			throw asLogReadError(err);
		}
	}

	async retentionMs(signal: AbortSignal): Promise<number | undefined> {
		if (signal.aborted) {
			return undefined;
		}
		let admin: InstanceType<Kafka['Admin']> | undefined;
		const onAbort = () => void admin?.close().catch(() => undefined);
		signal.addEventListener('abort', onAbort, { once: true });
		try {
			const { Admin } = await this.kafka();
			if (signal.aborted) {
				return undefined;
			}
			admin = new Admin(this.baseOptions());
			const described = await admin.describeConfigs({
				resources: [{ resourceType: TOPIC_RESOURCE, resourceName: LOGS_TOPIC, configurationKeys: ['retention.ms'] }],
			});
			const value = described.find((d) => d.resourceName === LOGS_TOPIC)?.configs.find((c) => c.name === 'retention.ms')?.value;
			const ms = value === null || value === undefined || value === '' ? NaN : Number(value);
			return Number.isFinite(ms) ? ms : undefined;
		} catch {
			// Refused (DescribeConfigs not allowed) or any other failure: the panel says "within the topic's retention".
			return undefined;
		} finally {
			signal.removeEventListener('abort', onAbort);
			await admin?.close().catch(() => undefined);
		}
	}
}

/** Thrown by `step` once the signal aborted. */
function abortStep(signal: AbortSignal): <T>(value: T) => T {
	return <T>(value: T): T => {
		if (signal.aborted) {
			throw new Aborted();
		}
		return value;
	};
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
