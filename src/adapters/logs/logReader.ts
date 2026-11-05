// The pipeline logs reader (AD-24, ticket 6.2): what the extension needs from the cluster's
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
	 * once `signal` aborts (the client is closed then); rejects with a `LogReadError`.
	 */
	tail(
		pipelineId: string,
		fromTime: number,
		onRecords: (records: readonly LogRecord[], next: LogPositions) => void,
		signal: AbortSignal,
		resumeAt?: LogPositions,
	): Promise<void>;
}

export type LogReaderFactory = (target: LogTarget) => LogReader;
