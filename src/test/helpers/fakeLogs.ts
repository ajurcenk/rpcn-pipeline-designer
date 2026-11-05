// An in-memory pipeline logs topic and its `LogReader`s (ticket 6.2, AD-24), as `fakeCloud.ts` is for
// the Cloud's HTTP: the integration tests hand `fake.factory` to the Cloud view's test seam instead of
// the `@platformatic/kafka` reader. Its records are kept per partition with offsets and timestamps;
// `write` adds records of any pipeline (keyed by its id) and wakes the readers that follow. A reader
// signs in only with the user and password set here (else a `signIn` error, as a refused SCRAM sign-in),
// `refuseRead` makes it a refused read, and `failTest` any other failure. Every target a reader was
// made for, every test read and every tail is recorded, and each tail's signal is kept, so a test can
// tell a reader was stopped. Nothing is written anywhere.

import type { LogPositions, LogReader, LogReadErrorKind, LogRecord, LogTarget } from '../../adapters/logs/logReader';

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

/** The fake's errors, as the reader's: told apart by `name` and `kind` (the extension's bundle has its own class). */
function readError(kind: LogReadErrorKind, message: string): Error {
	return Object.assign(new Error(message), { name: 'LogReadError', kind });
}

export class FakeLogs {
	readonly partitions: LogRecord[][];
	readonly targets: LogTarget[] = [];
	readonly tests: LogTarget[] = [];
	readonly tails: FakeTail[] = [];
	/** The user that may sign in. */
	username: string;
	password: string;
	/** When set, a read is refused after the sign-in (an authorization error). */
	refuseRead = false;
	/** When set, the test read fails with this connection error. */
	failTest: string | undefined;
	private readonly waiting = new Set<() => void>();

	constructor(options: { readonly username: string; readonly password: string; readonly partitions?: number }) {
		this.username = options.username;
		this.password = options.password;
		this.partitions = Array.from({ length: options.partitions ?? 1 }, () => []);
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

	clear(): void {
		this.partitions.forEach((p) => (p.length = 0));
		this.targets.length = 0;
		this.tests.length = 0;
		this.tails.length = 0;
		this.refuseRead = false;
		this.failTest = undefined;
	}

	/** The tails still reading. */
	activeTails(): FakeTail[] {
		return this.tails.filter((t) => !t.signal.aborted);
	}

	private signIn(target: LogTarget): void {
		if (target.access.username !== this.username || target.access.password !== this.password) {
			throw readError('signIn', 'Cannot connect to any broker: SASL authentication failed');
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
				const at = new Map(this.partitions.map((log, p) => {
					const resume = resumeAt?.get(p);
					return [p, resume ?? (log.find((r) => r.timestamp >= fromTime)?.offset ?? log.length)];
				}));
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
					await new Promise<void>((resolve) => {
						const wake = () => {
							signal.removeEventListener('abort', wake);
							this.waiting.delete(wake);
							resolve();
						};
						this.waiting.add(wake);
						signal.addEventListener('abort', wake);
					});
				}
			},
		};
	};
}
