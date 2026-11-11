// An in-memory pipeline logs topic and its `LogReader`s (tickets 6.2, 6.3, AD-24), as `fakeCloud.ts` is for
// the Cloud's HTTP: the integration tests hand `fake.factory` to the Cloud view's test seam instead of
// the `@platformatic/kafka` reader. Its records are kept per partition with offsets and timestamps;
// `write` adds records of any pipeline (keyed by its id) and wakes the readers that follow. A reader
// signs in only with the user and password set here (else a `signIn` error, as a refused SCRAM sign-in),
// `refuseRead` makes it a refused read, and `failTest` any other failure. Every target a reader was
// made for, every test read and every tail is recorded, and each tail's signal is kept, so a test can
// tell a reader was stopped. Nothing is written anywhere.
//
// History (ticket 6.3): records may carry any timestamp (written in time order per partition, as
// ListOffsets by time assumes); `logStart` is each partition's first offset (records below it are gone,
// as after the retention), `retentionMs` what DescribeConfigs answers (`'refused'`: not allowed), and
// `rangeDelayMs` slows each batch of a bounded read so a test can switch while it reads. Every range
// read is recorded.
//
// States (ticket 6.6): `dropConnections` ends every following tail with a connection error (as a dropped
// connection) and makes the next sign-ins fail the same way, so a test can tell the panel tries again
// and recovers after N tries; a refused sign-in comes from a changed `password`, a refused read from
// `refuseRead`; `rangeDelayMs` makes a slow read.

import type { LogPositions, LogRangeEnd, LogReader, LogReadErrorKind, LogRecord, LogTarget } from '../../adapters/logs/logReader';

/** A record to write: its pipeline id (the key), its value (an object is JSON-encoded) and its time. */
export interface FakeLogWrite {
	readonly key: string | null;
	readonly value: unknown;
	/** Milliseconds since the epoch (default: now). */
	readonly timestamp?: number;
	readonly partition?: number;
}

export interface FakeTail {
	readonly pipelineId: string;
	readonly fromTime: number;
	readonly resumeAt?: LogPositions;
	readonly signal: AbortSignal;
	/** The records it delivered (every key). */
	readonly delivered: LogRecord[];
}

export interface FakeRange {
	readonly fromTime: number;
	readonly toTime: number;
	readonly signal: AbortSignal;
	/** The records it delivered (every key). */
	readonly delivered: LogRecord[];
	/** Set once it ended (not aborted). */
	end?: LogRangeEnd;
}

/** A bounded read delivers at most this many records per batch (as fetches do). */
const RANGE_BATCH = 500;

/** The fake's errors, as the reader's: told apart by `name` and `kind` (the extension's bundle has its own class). */
function readError(kind: LogReadErrorKind, message: string): Error {
	return Object.assign(new Error(message), { name: 'LogReadError', kind });
}

export class FakeLogs {
	readonly partitions: LogRecord[][];
	readonly targets: LogTarget[] = [];
	readonly tests: LogTarget[] = [];
	readonly tails: FakeTail[] = [];
	readonly ranges: FakeRange[] = [];
	/** How many times the log's first offsets and the retention were asked. */
	logStartReads = 0;
	timeBeforeReads = 0;
	retentionReads = 0;
	/** Each partition's first offset: records below it are gone (default 0). */
	logStart: number[];
	/** What DescribeConfigs answers: `retention.ms`, or `'refused'`. */
	retentionMs: number | 'refused' = 7 * 24 * 60 * 60_000;
	/** A pause before each batch of a bounded read. */
	rangeDelayMs = 0;
	/** The user that may sign in. */
	username: string;
	password: string;
	/** Bug 52: the refused sign-in's message (default: SASL authentication failed). */
	signInMessage: string | undefined;
	/** When set, a read is refused after the sign-in (an authorization error). */
	refuseRead = false;
	/** When set, the test read fails with this connection error. */
	failTest: string | undefined;
	/** The next this many sign-ins fail with a connection error (then they pass again). */
	connectionFailures = 0;
	/** How many sign-ins failed with a connection error. */
	connectionsRefused = 0;
	/** When set, the next bounded read drops its connection after delivering this many batches (once). */
	dropRangeAfter: number | undefined;
	private readonly waiting = new Set<() => void>();
	private readonly dropping = new Set<(err: Error) => void>();

	constructor(options: { readonly username: string; readonly password: string; readonly partitions?: number }) {
		this.username = options.username;
		this.password = options.password;
		this.partitions = Array.from({ length: options.partitions ?? 1 }, () => []);
		this.logStart = this.partitions.map(() => 0);
	}

	/** Appends records (offsets in order per partition) and wakes the following readers. */
	write(...records: readonly FakeLogWrite[]): LogRecord[] {
		const written = records.map((r) => {
			const partition = r.partition ?? 0;
			const log = this.partitions[partition];
			const record: LogRecord = {
				partition,
				offset: log.length,
				timestamp: r.timestamp ?? Date.now(),
				key: r.key,
				value: typeof r.value === 'string' ? r.value : JSON.stringify(r.value),
			};
			log.push(record);
			return record;
		});
		const wake = [...this.waiting];
		this.waiting.clear();
		wake.forEach((w) => w());
		return written;
	}

	/**
	 * A dropped connection: every following tail ends with a connection error, and the next `failures`
	 * sign-ins fail the same way (0: the first try after the drop succeeds).
	 */
	dropConnections(failures = 0): void {
		this.connectionFailures = failures;
		const drop = [...this.dropping];
		this.dropping.clear();
		drop.forEach((d) => d(readError('connection', 'Connection closed by the broker (ECONNRESET)')));
	}

	clear(): void {
		this.partitions.forEach((p) => (p.length = 0));
		this.targets.length = 0;
		this.tests.length = 0;
		this.tails.length = 0;
		this.ranges.length = 0;
		this.logStartReads = 0;
		this.timeBeforeReads = 0;
		this.retentionReads = 0;
		this.logStart = this.partitions.map(() => 0);
		this.retentionMs = 7 * 24 * 60 * 60_000;
		this.rangeDelayMs = 0;
		this.refuseRead = false;
		this.failTest = undefined;
		this.connectionFailures = 0;
		this.connectionsRefused = 0;
		this.dropRangeAfter = undefined;
		this.signInMessage = undefined;
	}

	/** The ranges still reading. */
	activeRanges(): FakeRange[] {
		return this.ranges.filter((r) => !r.signal.aborted && !r.end);
	}

	/** As ListOffsets by time: the first offset at or after `time` (not below the log's start), else the end. */
	private offsetAt(p: number, time: number): number {
		const log = this.partitions[p];
		return log.find((r) => r.offset >= this.logStart[p] && r.timestamp >= time)?.offset ?? log.length;
	}

	/** The tails still reading. */
	activeTails(): FakeTail[] {
		return this.tails.filter((t) => !t.signal.aborted);
	}

	private signIn(target: LogTarget): void {
		if (this.connectionFailures > 0) {
			this.connectionFailures--;
			this.connectionsRefused++;
			throw readError('connection', 'Cannot connect to any broker: connect ECONNREFUSED');
		}
		if (target.access.username !== this.username || target.access.password !== this.password) {
			throw readError('signIn', this.signInMessage ?? 'Cannot connect to any broker: SASL authentication failed');
		}
		if (this.refuseRead) {
			throw readError('notAllowed', 'not allowed to read __redpanda.connect.logs (Kafka error 29)');
		}
	}

	readonly factory = (target: LogTarget): LogReader => {
		this.targets.push(target);
		return {
			test: async () => {
				this.tests.push(target);
				if (this.failTest) {
					throw readError('connection', this.failTest);
				}
				this.signIn(target);
			},
			tail: async (pipelineId, fromTime, onRecords, signal, resumeAt) => {
				const tail: FakeTail = { pipelineId, fromTime, ...(resumeAt ? { resumeAt: new Map(resumeAt) } : {}), signal, delivered: [] };
				this.tails.push(tail);
				this.signIn(target);
				// As ListOffsets by time: the first offset at or after `fromTime`, else the end.
				const at = new Map(this.partitions.map((_log, p) => [p, resumeAt?.get(p) ?? this.offsetAt(p, fromTime)]));
				while (!signal.aborted) {
					const batch: LogRecord[] = [];
					for (const [p, from] of at) {
						const got = this.partitions[p].slice(from);
						batch.push(...got);
						at.set(p, from + got.length);
					}
					tail.delivered.push(...batch);
					onRecords(batch, new Map(at));
					// The live fetch's wait: until a write or the abort.
					await new Promise<void>((resolve, reject) => {
						const done = () => {
							signal.removeEventListener('abort', wake);
							this.waiting.delete(wake);
							this.dropping.delete(drop);
						};
						const wake = () => {
							done();
							resolve();
						};
						const drop = (err: Error) => {
							done();
							reject(err);
						};
						this.waiting.add(wake);
						this.dropping.add(drop);
						signal.addEventListener('abort', wake);
					});
				}
			},
			range: async (_pipelineId, fromTime, toTime, onRecords, signal) => {
				const range: FakeRange = { fromTime, toTime, signal, delivered: [] };
				this.ranges.push(range);
				this.signIn(target);
				const start = new Map(this.partitions.map((_log, p) => [p, this.offsetAt(p, fromTime)]));
				const stop = new Map(this.partitions.map((log, p) => [p, Math.min(log.length, this.offsetAt(p, toTime + 1))]));
				const at = new Map(start);
				for (const [p, from] of start) {
					for (let o = from; o < stop.get(p)! && !signal.aborted; o += RANGE_BATCH) {
						if (this.rangeDelayMs > 0) {
							await new Promise((r) => setTimeout(r, this.rangeDelayMs));
							if (signal.aborted) {
								break;
							}
						}
						if (this.dropRangeAfter !== undefined && range.delivered.length >= this.dropRangeAfter * RANGE_BATCH) {
							this.dropRangeAfter = undefined;
							throw readError('connection', 'Connection closed by the broker (ECONNRESET)');
						}
						const batch = this.partitions[p].slice(o, Math.min(o + RANGE_BATCH, stop.get(p)!));
						range.delivered.push(...batch);
						at.set(p, o + batch.length);
						onRecords(batch);
					}
				}
				const end = { start, next: at };
				if (!signal.aborted) {
					range.end = end;
				}
				return end;
			},
			logStart: async () => {
				this.logStartReads++;
				this.signIn(target);
				return new Map(this.logStart.map((o, p) => [p, o]));
			},
			timeBefore: async (start) => {
				this.timeBeforeReads++;
				this.signIn(target);
				const times = [...start].filter(([p, o]) => o - 1 >= this.logStart[p] && o - 1 < this.partitions[p].length).map(([p, o]) => this.partitions[p][o - 1].timestamp);
				return times.length > 0 ? Math.max(...times) : undefined;
			},
			retentionMs: async () => {
				this.retentionReads++;
				return this.retentionMs === 'refused' ? undefined : this.retentionMs;
			},
		};
	};
}
