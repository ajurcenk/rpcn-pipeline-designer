// An in-memory `MetricsSource` (ticket 7.2, AD-25), as `fakeLogs.ts` is for the logs reader: the
// integration tests hand `fake.factory` to the Pipeline Metrics tab's seam (`setSourceFactory`) instead
// of the local `/metrics` read. Each port's answers are scripted: `serve` sets the Prometheus text a
// port answers with from now on (each read parses it with the core parser, as the real source does),
// `fail` makes its next reads reject with a `MetricsReadError`-shaped error of a kind. Every read is
// recorded with its port, time and signal, so a test can tell reads stopped. Nothing is read anywhere.

import type { MetricsReadErrorKind, MetricsSource } from '../../adapters/metrics/source';
import type { MetricsReading } from '../../core/metrics';
import { parsePrometheus } from '../../core/prometheus';

export interface FakeMetricsRead {
	readonly port: number;
	readonly time: number;
	/** Ticket 7.6: when the read started (real time, whatever `clock` stamps the reading with). */
	readonly startedAt: number;
	readonly signal: AbortSignal | undefined;
}

/** An error shaped as `MetricsReadError` (told apart by `name` and `kind`). */
export class FakeMetricsReadError extends Error {
	readonly noSeries?: true;
	constructor(readonly kind: MetricsReadErrorKind, message: string, noSeries = false) {
		super(message);
		this.name = 'MetricsReadError';
		if (noSeries) {
			this.noSeries = true;
		}
	}
}

/**
 * The Prometheus text of a component's counters and latency summary, in Connect's form. Ticket 7.6:
 * batches (`_batch_received` / `_batch_sent`), the 0.9 quantile, the summary's `_sum` / `_count`, and a
 * Cloud `pod` label.
 */
export function connectText(components: readonly {
	readonly family: 'input' | 'processor' | 'output';
	readonly path: string;
	readonly label?: string;
	readonly pod?: string;
	readonly received?: number;
	readonly sent?: number;
	readonly errors?: number;
	readonly batchesIn?: number;
	readonly batchesOut?: number;
	readonly p50?: number;
	readonly p90?: number;
	readonly p99?: number;
	readonly sum?: number;
	readonly count?: number;
}[]): string {
	const lines: string[] = [];
	for (const c of components) {
		const labels = `label="${c.label ?? ''}",path="${c.path}"${c.pod !== undefined ? `,pod="${c.pod}"` : ''}`;
		if (c.received !== undefined) {
			lines.push(`${c.family}_received{${labels}} ${c.received}`);
		}
		if (c.sent !== undefined) {
			lines.push(`${c.family}_sent{${labels}} ${c.sent}`);
		}
		if (c.errors !== undefined) {
			lines.push(`${c.family}_error{${labels}} ${c.errors}`);
		}
		if (c.batchesIn !== undefined) {
			lines.push(`${c.family}_batch_received{${labels}} ${c.batchesIn}`);
		}
		if (c.batchesOut !== undefined) {
			lines.push(`${c.family}_batch_sent{${labels}} ${c.batchesOut}`);
		}
		if (c.p50 !== undefined || c.p90 !== undefined || c.p99 !== undefined) {
			lines.push(`${c.family}_latency_ns{${labels},quantile="0.5"} ${c.p50 ?? 0}`);
			if (c.p90 !== undefined) {
				lines.push(`${c.family}_latency_ns{${labels},quantile="0.9"} ${c.p90}`);
			}
			lines.push(`${c.family}_latency_ns{${labels},quantile="0.99"} ${c.p99 ?? 0}`);
		}
		if (c.sum !== undefined) {
			lines.push(`${c.family}_latency_ns_sum{${labels}} ${c.sum}`);
		}
		if (c.count !== undefined) {
			lines.push(`${c.family}_latency_ns_count{${labels}} ${c.count}`);
		}
	}
	return `${lines.join('\n')}\n`;
}

export class FakeMetrics {
	readonly reads: FakeMetricsRead[] = [];
	private readonly texts = new Map<number, string | ((index: number) => string | undefined)>();
	private readonly failures = new Map<number, { readonly kind: MetricsReadErrorKind; readonly message: string; readonly noSeries: boolean; left: number }>();
	/** Each read takes this long (so a test can hide the tab while one is in flight). */
	delayMs = 0;
	/** Ticket 7.6: the time each reading is stamped with (default: now), so a test can simulate minutes. */
	clock: (() => number) | undefined;

	/** The factory to hand to the panel's seam. */
	readonly factory = (port: number): MetricsSource => ({
		address: `127.0.0.1:${port}`,
		read: (signal?: AbortSignal) => this.read(port, signal),
	});

	/**
	 * `port` answers with `text` from now on. Ticket 7.6: or with `text(i)` for its `i`-th read (from 0);
	 * `undefined` there: that read never answers (until it is aborted), so no reading follows.
	 */
	serve(port: number, text: string | ((index: number) => string | undefined)): void {
		this.texts.set(port, text);
	}

	/** The next `times` reads of `port` reject with `kind`. */
	fail(port: number, kind: MetricsReadErrorKind, message = `${kind} (fake)`, times = Infinity, noSeries = false): void {
		this.failures.set(port, { kind, message, noSeries, left: times });
	}

	readsOf(port: number): FakeMetricsRead[] {
		return this.reads.filter((r) => r.port === port);
	}

	private async read(port: number, signal: AbortSignal | undefined): Promise<MetricsReading> {
		const time = this.clock?.() ?? Date.now();
		const index = this.readsOf(port).length;
		this.reads.push({ port, time, startedAt: Date.now(), signal });
		if (this.delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, this.delayMs));
		}
		if (signal?.aborted) {
			throw new FakeMetricsReadError('unreachable', 'aborted');
		}
		const failure = this.failures.get(port);
		if (failure && failure.left > 0) {
			failure.left--;
			throw new FakeMetricsReadError(failure.kind, failure.message, failure.noSeries);
		}
		const served = this.texts.get(port);
		const text = typeof served === 'function' ? served(index) : served;
		if (typeof served === 'function' && text === undefined) {
			return new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new FakeMetricsReadError('unreachable', 'aborted'))));
		}
		if (text === undefined) {
			throw new FakeMetricsReadError('unreachable', `127.0.0.1:${port}: connection refused`);
		}
		return { ...parsePrometheus(text), time };
	}
}
