// The pipeline metrics sources (AD-25, ticket 7.2). The panel sees only `MetricsSource`: `read()`
// gives a reading (the read's own time and the Prometheus samples of one pipeline) or rejects with a
// `MetricsReadError` of kind `refused` (the endpoint refused the credentials), `unreachable` (no
// answer: refused connection, timeout, a server error) or `notServed` (an answer that holds no
// Connect metrics: a 404, not Prometheus text, or no component series). The integration tests use
// an in-memory fake (`src/test/helpers/fakeMetrics.ts`). No `vscode` import here.
//
// The local source reads `http://127.0.0.1:<port>/metrics` of a Run (AD-13) with a 5 s timeout; the
// whole body is the run's own pipeline. `freePort` picks the port a run is given: it listens on port
// 0 at 127.0.0.1, reads the port the system chose, and closes.
//
// The Cloud source (ticket 7.4) reads a cluster's Prometheus endpoint (`prometheus.url` of its details)
// with basic auth, `Accept-Encoding: gzip` (fetch un-gzips the answer) and a 15 s timeout, one read in
// flight at a time (a read asked meanwhile gets that read's answer). The body is the whole cluster's:
// only the `#` lines and the sample lines of its pipeline (`pipeline_id`) are parsed. A 401 or 403 is
// `refused` (the user or password is wrong; the endpoint tells a missing password from a wrong one in
// no way), never retried here. `testCloudMetricsAccess` is Set up metrics access's test read: one GET,
// any 2xx accepted. The password is only ever in the request's Authorization header, never in a message.

import * as net from 'net';
import { hasComponentSeries, type MetricsReading } from '../../core/metrics';
import { onlyPipeline, parsePrometheus } from '../../core/prometheus';

export type { MetricsReading } from '../../core/metrics';

export type MetricsReadErrorKind = 'refused' | 'unreachable' | 'notServed';

/**
 * A failed read. Told apart by `name` and `kind`, not `instanceof`: the tests' fake is compiled apart
 * from the extension's bundle, so its errors are another class (as `LogReadError`).
 */
export class MetricsReadError extends Error {
	/**
	 * `notServed` only: the answer is Prometheus text with no component series yet, which a run that is
	 * still starting also serves (its HTTP server listens before its components exist).
	 */
	readonly noSeries?: true;

	constructor(readonly kind: MetricsReadErrorKind, message: string, options: { readonly noSeries?: boolean } = {}) {
		super(message);
		this.name = 'MetricsReadError';
		if (options.noSeries) {
			this.noSeries = true;
		}
	}
}

export function isMetricsReadError(err: unknown): err is { readonly kind: MetricsReadErrorKind; readonly message: string; readonly noSeries?: true } {
	if (err === null || typeof err !== 'object') {
		return false;
	}
	const e = err as { name?: unknown; kind?: unknown; message?: unknown; noSeries?: unknown };
	return e.name === 'MetricsReadError' && (e.kind === 'refused' || e.kind === 'unreachable' || e.kind === 'notServed')
		&& typeof e.message === 'string' && (e.noSeries === undefined || e.noSeries === true);
}

export interface MetricsSource {
	/** Where it reads, as shown (`127.0.0.1:41873`). */
	readonly address: string;
	/** One reading; rejects with a `MetricsReadError`. Aborted through `signal`, it rejects too. */
	read(signal?: AbortSignal): Promise<MetricsReading>;
}

/** The slice of `fetch`'s answer a source reads. */
export interface FetchResponse {
	readonly status: number;
	readonly headers: { get(name: string): string | null };
	text(): Promise<string>;
}

export type MetricsFetch = (url: string, init: { readonly signal: AbortSignal; readonly headers?: Record<string, string> }) => Promise<FetchResponse>;

/** A local read's timeout. */
export const LOCAL_READ_TIMEOUT_MS = 5_000;

/** The source of a local run serving its metrics on 127.0.0.1 at `port`. */
export function localMetricsSource(port: number, fetchImpl: MetricsFetch = globalThis.fetch as unknown as MetricsFetch, now: () => number = Date.now): MetricsSource {
	const address = `127.0.0.1:${port}`;
	return {
		address,
		async read(signal?: AbortSignal): Promise<MetricsReading> {
			const timeout = new AbortController();
			const timer = setTimeout(() => timeout.abort(), LOCAL_READ_TIMEOUT_MS);
			const onAbort = () => timeout.abort();
			signal?.addEventListener('abort', onAbort);
			if (signal?.aborted) {
				timeout.abort();
			}
			try {
				const time = now();
				let response: FetchResponse;
				let body: string;
				try {
					response = await fetchImpl(`http://${address}/metrics`, { signal: timeout.signal });
					body = await response.text();
				} catch (err) {
					throw new MetricsReadError('unreachable', timeout.signal.aborted && !signal?.aborted
						? `no answer from ${address} within ${LOCAL_READ_TIMEOUT_MS / 1000} s`
						: `${address}: ${networkText(err)}`);
				}
				return readingOf(localWhere(address), response, body, time);
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
			}
		},
	};
}

/** How a source's messages name where it reads. */
interface Where {
	readonly address: string;
	/** What is served there (`127.0.0.1:41873/metrics`). */
	readonly served: string;
	/** The text of a refused read. */
	readonly refused: (status: number) => string;
}

const localWhere = (address: string): Where => ({
	address, served: `${address}/metrics`, refused: (status) => `${address} refused the read (HTTP ${status})`,
});

/** The refused read's text of the Cloud source (a missing and a wrong password look alike). */
export const CLOUD_REFUSED_TEXT = 'refused: the user or password is wrong';

const cloudWhere = (address: string): Where => ({
	address, served: address, refused: (status) => `${address} ${CLOUD_REFUSED_TEXT} (HTTP ${status})`,
});

/** The error an answer's status is, or `undefined` for a 2xx. */
function statusError(where: Where, status: number): MetricsReadError | undefined {
	if (status === 401 || status === 403) {
		return new MetricsReadError('refused', where.refused(status));
	}
	if (status === 404) {
		return new MetricsReadError('notServed', `${where.served} is not served (HTTP 404)`);
	}
	if (status < 200 || status >= 300) {
		return new MetricsReadError('unreachable', `${where.address} answered HTTP ${status}`);
	}
	return undefined;
}

/** The reading of an answer (`filter`: what of the body is parsed), or the error it is. */
function readingOf(where: Where, response: FetchResponse, body: string, time: number, filter: (body: string) => string = (b) => b): MetricsReading {
	const failed = statusError(where, response.status);
	if (failed) {
		throw failed;
	}
	const type = response.headers.get('content-type') ?? '';
	if (/json/i.test(type) || body.trimStart().startsWith('{')) {
		throw new MetricsReadError('notServed', `${where.served} is not Prometheus text (${type || 'JSON'})`);
	}
	const text = parsePrometheus(filter(body));
	if (!hasComponentSeries(text)) {
		throw new MetricsReadError('notServed', `${where.served} has no Redpanda Connect component series`, { noSeries: true });
	}
	return { ...text, time };
}

/** A Cloud read's timeout. */
export const CLOUD_READ_TIMEOUT_MS = 15_000;

/** The user Redpanda Cloud's Prometheus endpoint is read as unless another is set. */
export const DEFAULT_PROMETHEUS_USER = 'prometheus';

export interface CloudMetricsOptions {
	readonly fetch?: MetricsFetch;
	readonly now?: () => number;
	/** Default `CLOUD_READ_TIMEOUT_MS` (the test seam shortens it). */
	readonly timeoutMs?: number;
}

/** Where a Cloud endpoint is shown: its host (no path, query or credentials). */
export function cloudAddress(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}

/**
 * One GET of a Cloud Prometheus endpoint with basic auth and gzip, within the timeout: its answer and
 * body; rejects with an `unreachable` `MetricsReadError` when none came.
 */
async function cloudGet(url: string, user: string, password: string, options: CloudMetricsOptions, signal?: AbortSignal)
	: Promise<{ readonly response: FetchResponse; readonly body: string; readonly time: number }> {
	const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as MetricsFetch);
	const timeoutMs = options.timeoutMs ?? CLOUD_READ_TIMEOUT_MS;
	const address = cloudAddress(url);
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), timeoutMs);
	const onAbort = () => timeout.abort();
	signal?.addEventListener('abort', onAbort);
	if (signal?.aborted) {
		timeout.abort();
	}
	try {
		const time = (options.now ?? Date.now)();
		try {
			const response = await fetchImpl(url, {
				signal: timeout.signal,
				headers: {
					authorization: `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`,
					'accept-encoding': 'gzip',
					accept: 'text/plain',
				},
			});
			const body = await response.text();
			return { response, body, time };
		} catch (err) {
			throw new MetricsReadError('unreachable', timeout.signal.aborted && !signal?.aborted
				? `no answer from ${address} within ${timeoutMs / 1000} s`
				: `${address}: ${networkText(err)}`);
		}
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	}
}

/**
 * The source of one Cloud pipeline (`pipelineId`) on the cluster whose Prometheus endpoint is `url`,
 * read as `user` with `password`.
 */
export function cloudMetricsSource(url: string, user: string, password: string, pipelineId: string, options: CloudMetricsOptions = {}): MetricsSource {
	const where = cloudWhere(cloudAddress(url));
	let inFlight: Promise<MetricsReading> | undefined;
	return {
		address: where.address,
		read(signal?: AbortSignal): Promise<MetricsReading> {
			if (signal?.aborted) {
				return Promise.reject(abortedRead(where.address));
			}
			// The shared read is bound to no caller's signal (its own timeout only); a caller's abort ends only its own wait.
			if (!inFlight) {
				const read = (async () => {
					const { response, body, time } = await cloudGet(url, user, password, options);
					return readingOf(where, response, body, time, (b) => onlyPipeline(b, pipelineId));
				})().finally(() => {
					if (inFlight === read) {
						inFlight = undefined;
					}
				});
				inFlight = read;
			}
			const shared = inFlight;
			if (!signal) {
				return shared;
			}
			return new Promise<MetricsReading>((resolve, reject) => {
				const onAbort = () => reject(abortedRead(where.address));
				signal.addEventListener('abort', onAbort, { once: true });
				shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
			});
		},
	};
}

/** A caller's aborted read (as the local source's: unreachable). */
function abortedRead(address: string): MetricsReadError {
	return new MetricsReadError('unreachable', `${address}: the read was aborted`);
}

/**
 * Set up metrics access's test read (ticket 7.4): one GET of the endpoint; resolves on a 2xx, rejects with
 * a `MetricsReadError` (`refused` on a 401 or 403, not retried) otherwise.
 */
export async function testCloudMetricsAccess(url: string, user: string, password: string, options: CloudMetricsOptions = {}): Promise<void> {
	const { response } = await cloudGet(url, user, password, options);
	const failed = statusError(cloudWhere(cloudAddress(url)), response.status);
	if (failed) {
		throw failed;
	}
}

/** A network error's text: its cause's code (`ECONNREFUSED`) when it has one. */
function networkText(err: unknown): string {
	const cause = (err as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
	if (cause && typeof cause.code === 'string') {
		return cause.code === 'ECONNREFUSED' ? 'connection refused' : cause.code;
	}
	return err instanceof Error ? err.message : String(err);
}

/** A port free on 127.0.0.1 now: listen on port 0, read the port, close. Rejects when none can be had. */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : undefined;
			server.close(() => (port ? resolve(port) : reject(new Error('no port was assigned'))));
		});
	});
}
