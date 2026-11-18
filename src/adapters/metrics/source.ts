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

import * as net from 'net';
import { hasComponentSeries, type MetricsReading } from '../../core/metrics';
import { parsePrometheus } from '../../core/prometheus';

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
				return readingOf(address, response, body, time);
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
			}
		},
	};
}

/** The reading of an answer, or the error it is. */
function readingOf(address: string, response: FetchResponse, body: string, time: number): MetricsReading {
	const { status } = response;
	if (status === 401 || status === 403) {
		throw new MetricsReadError('refused', `${address} refused the read (HTTP ${status})`);
	}
	if (status === 404) {
		throw new MetricsReadError('notServed', `${address}/metrics is not served (HTTP 404)`);
	}
	if (status < 200 || status >= 300) {
		throw new MetricsReadError('unreachable', `${address} answered HTTP ${status}`);
	}
	const type = response.headers.get('content-type') ?? '';
	if (/json/i.test(type) || body.trimStart().startsWith('{')) {
		throw new MetricsReadError('notServed', `${address}/metrics is not Prometheus text (${type || 'JSON'})`);
	}
	const text = parsePrometheus(body);
	if (!hasComponentSeries(text)) {
		throw new MetricsReadError('notServed', `${address}/metrics has no Redpanda Connect component series`, { noSeries: true });
	}
	return { ...text, time };
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
