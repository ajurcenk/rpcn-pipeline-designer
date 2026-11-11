// The pipeline logs reader (AD-24, tickets 6.2, 6.3): what the extension needs from the cluster's
// `__redpanda.connect.logs` topic, behind an interface so the integration tests use an in-memory fake
// (`src/test/helpers/fakeLogs.ts`) and the client (`platformaticReader.ts`, `@platformatic/kafka`) can
// be replaced. A reader is made for one cluster and one Redpanda user: the address is the cluster's
// `kafka_api.seed_brokers`, TLS with the system CAs, SASL SCRAM; no consumer group, no commit.
// No `vscode` import.

/** The topic every pipeline of a cluster logs to. */
export const LOGS_TOPIC = '__redpanda.connect.logs';

export const SASL_MECHANISMS = ['SCRAM-SHA-256', 'SCRAM-SHA-512'] as const;
export type SaslMechanism = (typeof SASL_MECHANISMS)[number];

export function isSaslMechanism(v: unknown): v is SaslMechanism {
	return typeof v === 'string' && (SASL_MECHANISMS as readonly string[]).includes(v);
}

/** A Redpanda user that may read the logs topic. The password lives in memory and secret storage only. */
export interface LogAccess {
	readonly username: string;
	readonly password: string;
	readonly mechanism: SaslMechanism;
}

/** Where and as whom a reader reads. */
export interface LogTarget {
	/** `host:port` each, from the cluster's `kafka_api.seed_brokers`. */
	readonly brokers: readonly string[];
	readonly access: LogAccess;
}

/** One record of the topic, as read: the key and value decoded as UTF-8. */
export interface LogRecord {
	readonly partition: number;
	readonly offset: number;
	/** The record's timestamp (CreateTime), milliseconds since the epoch. */
	readonly timestamp: number;
	readonly key: string | null;
	readonly value: string | null;
}

/** The next offset to read on each partition: where a stopped tail resumes. */
export type LogPositions = ReadonlyMap<number, number>;

/**
 * Why a read failed: `signIn` (the broker refused the user, `SASL_AUTHENTICATION_FAILED`),
 * `notAllowed` (an authorization error), `connection` (anything else).
 */
export type LogReadErrorKind = 'signIn' | 'notAllowed' | 'connection';

/**
 * A failed read. Told apart by `name` and `kind`, not `instanceof`: the tests' fake is compiled
 * apart from the extension's bundle, so its errors are another class.
 */
export class LogReadError extends Error {
	constructor(readonly kind: LogReadErrorKind, message: string) {
		super(message);
		this.name = 'LogReadError';
	}
}

export function isLogReadError(err: unknown): err is { readonly kind: LogReadErrorKind; readonly message: string } {
	if (err === null || typeof err !== 'object') {
		return false;
	}
	const e = err as { name?: unknown; kind?: unknown; message?: unknown };
	return e.name === 'LogReadError' && (e.kind === 'signIn' || e.kind === 'notAllowed' || e.kind === 'connection') && typeof e.message === 'string';
}

/** How a bounded read (`range`) ended. */
export interface LogRangeEnd {
	/** The offset it started at on each partition: ListOffsets(fromTime), the end where no record is that late. */
	readonly start: LogPositions;
	/** The next offset on each partition after the read: a tail goes on from here. */
	readonly next: LogPositions;
	/**
	 * Partitions given up before their stop: fetches kept answering no records (as a slow tiered-storage
	 * read might) for the reader's time limit; `next` is where each stopped.
	 */
	readonly stalled?: readonly number[];
	/** Bug 51: partitions given up because they had no leader (−1, or missing from the metadata) for the reader's time limit. */
	readonly leaderless?: readonly number[];
}

export interface LogReader {
	/**
	 * The test read of log access: the topic's metadata and one fetch. Resolves when both succeed;
	 * rejects with a `LogReadError`. The reader is closed afterwards.
	 */
	test(): Promise<void>;
	/**
	 * Reads the partitions `pipelineId`'s records may be on (every partition, until their placement
	 * is proven, AD-24) from the first record at or after `fromTime` (ListOffsets by time), or from
	 * `resumeAt` for a partition it names, then follows the end (fetches with a 2 s wait).
	 * `onRecords` gets every record read, of any key, in offset order per partition (the caller keeps
	 * the pipeline's: `isPipelineRecord`), and the positions to resume at, after each fetch. Resolves
	 * once `signal` aborts (the client is closed then); rejects with a `LogReadError`. Bug 51: every
	 * fetched batch moves the position past it (one with no record at or after it too); a failed read of
	 * the leaders is retried as a failed fetch is; a partition without a leader is not fetched until it
	 * has one.
	 */
	tail(
		pipelineId: string,
		fromTime: number,
		onRecords: (records: readonly LogRecord[], next: LogPositions) => void,
		signal: AbortSignal,
		resumeAt?: LogPositions,
	): Promise<void>;
	/**
	 * A bounded read (ticket 6.3): the same partitions as `tail`, forward from the first record at or
	 * after `fromTime` (ListOffsets by time; never below the log's first offset) up to the first record
	 * after `toTime` or the end offsets taken when it starts, whichever is first; then it ends.
	 * `onRecords` gets every record read, of any key, after each fetch, and the next offset on each
	 * partition (bug 51: a read that failed goes on from these with `resumeAt`, each partition from its
	 * own, so a partition that was behind loses nothing). Records older than the brokers' local retention
	 * come from tiered storage through the same fetch. The client stays open for the reader's next
	 * `range`, `logStart` or `retentionMs` and is closed once `signal` aborts (the caller aborts it when it
	 * is done); an abort ends the read early. Rejects with a `LogReadError`. A partition without a leader
	 * is not fetched; it is waited on until it has one, within the reader's time limit (`leaderless`); one
	 * placed late stops at the first record after `toTime` or after the time the read started, whichever is
	 * first (not at the end it has when it is placed). The reader remembers since when a partition has had
	 * no leader, so its next `range` does not wait the time limit again for it.
	 */
	range(
		pipelineId: string,
		fromTime: number,
		toTime: number,
		onRecords: (records: readonly LogRecord[], next: LogPositions) => void,
		signal: AbortSignal,
		resumeAt?: LogPositions,
	): Promise<LogRangeEnd>;
	/** The log's first offset on each partition (ListOffsets earliest); the client as for `range`. */
	logStart(signal: AbortSignal): Promise<LogPositions>;
	/**
	 * The time of the newest of the records just before `start` (offset − 1 on each partition, where
	 * that is not below the log's first offset), any key; `undefined` when there is none. Load older
	 * jumps over a silence with it. The client as for `range`.
	 */
	timeBefore(start: LogPositions, signal: AbortSignal): Promise<number | undefined>;
	/**
	 * The topic's `retention.ms` (DescribeConfigs), `-1` for no time limit; `undefined` when it cannot
	 * be read (DescribeConfigs not allowed, or any other failure). Never rejects.
	 */
	retentionMs(signal: AbortSignal): Promise<number | undefined>;
}

export type LogReaderFactory = (target: LogTarget) => LogReader;
