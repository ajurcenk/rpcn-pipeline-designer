// The pure pipeline metrics model (AD-25, ticket 7.2): a reading's Prometheus samples as each
// component's counters and latency quantiles (per `path` + `label`), the figures of a window of
// readings, the mapping of a series to its model node (AD-7, AD-17), and the tab's rows in config
// order. No `vscode`, no I/O.
//
// Series (AD-25): counters `input_received`, `processor_received` / `_sent` / `_error` /
// `_batch_received` / `_batch_sent`, `output_sent` / `_batch_sent` / `_error`; summaries
// `processor_latency_ns` and `output_latency_ns` (quantiles 0.5, 0.9 and 0.99, `_sum`, `_count`, in
// ns). `input_latency_ns` is the whole pipeline's time (read to ack): it is not the input's own and is
// not shown here. Series without `path` are ignored.
//
// Ticket 7.6, the live window: a reading is kept compactly (`compactReading`: per component, its
// counters and `_sum` / `_count` per `pod`, and its highest quantiles), at most 15 minutes of them
// (`keepReading`). The figures over a window (`figures`) sum, per pod, the increase between each two
// consecutive readings in it, over the time from its first reading to its last: a counter that goes
// back, or a pod the reading before did not have (a restart), counts its new value as the increase
// (as Prometheus's `rate()`), never a negative one. The pods' increases are summed per component; the
// quantiles are the latest reading's (the process's own, not computable per window), the highest
// across pods; the mean is Δ`_sum` / Δ`_count`; the error share Δ`processor_error` /
// Δ`processor_received`. Each component's trend is its out rate per reading interval.
//
// Ticket 7.7, the bottleneck (E7 R6, AD-25): a component's share is the time it spent over the window
// (its Δ`_latency_ns_sum`) over the total of the top-level processors, the output's top-level series
// and every resource (a processor or output not nested in another of its kind, by Connect's path; a
// `resource:` processor reports no series of its own, so a resource's time is counted as its own);
// the input has none (its latency is end-to-end). The slowest is the largest share among the leaves (a component with no component of its
// kind nested in it, so a `sleep` inside a `branch` is marked, not the branch), the first in config order
// on a tie; none while no share is known (no rates yet). Components with errors over the window are
// marked too, and the summary names the input's and the output's rates and a gap of more than 5%.

import { isMap, isScalar, type Pair } from 'yaml';
import type { NodeFigures, NodeFiguresById, PipelineModel, PipelineNode } from '../shared/protocol';
import type { MetricKind, MetricRow, MetricsSort, MetricsSummary } from '../shared/metricsProtocol';
import { familyOf, type PromText } from './prometheus';
import type { ParsedYaml } from './yamlPath';

/** One read of a source: its own time (samples carry none) and its samples, already one pipeline's. */
export interface MetricsReading extends PromText {
	/** Milliseconds since the epoch, when the read was made. */
	readonly time: number;
}

export type SeriesKind = 'input' | 'processor' | 'output';

/** The counters (and a summary's `_sum` / `_count`) a component has, per pod. */
export type CounterField = 'received' | 'sent' | 'errors' | 'batchesIn' | 'batchesOut' | 'sum' | 'count';

export type PodCounters = { [F in CounterField]?: number };

/** One component's values in one reading. */
export interface ComponentReading {
	readonly key: string;
	/** Connect's path (`root.pipeline.processors.0`). */
	readonly path: string;
	/** Connect's `label` (`""` when none). */
	readonly label: string;
	readonly kind: SeriesKind;
	/** Its counters by `pod` (`""` without one), each summed over its other label sets. */
	readonly pods: Map<string, PodCounters>;
	/** The highest across pods. */
	p50?: number;
	p90?: number;
	p99?: number;
}

/** Ticket 7.6: one reading as kept in the window: its time and its components (not the whole text). */
export interface CompactReading {
	readonly time: number;
	readonly components: ReadonlyMap<string, ComponentReading>;
}

/** One component's figures over a window. Rates per second, latencies in ns, the share 0–1; `null`: none. */
export interface ComponentFigures {
	readonly key: string;
	readonly path: string;
	readonly label: string;
	readonly kind: SeriesKind;
	readonly inRate: number | null;
	readonly outRate: number | null;
	readonly batchInRate: number | null;
	readonly batchOutRate: number | null;
	readonly errorRate: number | null;
	readonly errorShare: number | null;
	readonly p50: number | null;
	readonly p90: number | null;
	readonly p99: number | null;
	readonly mean: number | null;
	/** Out per second for each reading interval of the window, oldest first. */
	readonly trend: readonly number[];
	/** Ticket 7.7: the time spent over the window (Δ`_latency_ns_sum`, ns); `null` for the input or with no rates. */
	readonly timeNs: number | null;
	/** Ticket 7.7: `timeNs` over the pipeline's (the top-level processors', the output's and the resources'), 0–1; `null`: none. */
	readonly share: number | null;
	/** Ticket 7.7: no component of its kind is nested in it, by path (only a leaf can be the slowest); a resource always is here (its config node decides, `bottleneck`). */
	readonly leaf: boolean;
}

/** Ticket 7.6: readings are kept this long (the longest window). */
export const MAX_WINDOW_MS = 15 * 60_000;

const COUNTERS: Readonly<Record<string, readonly [SeriesKind, CounterField]>> = {
	input_received: ['input', 'received'],
	processor_received: ['processor', 'received'],
	processor_sent: ['processor', 'sent'],
	processor_error: ['processor', 'errors'],
	processor_batch_received: ['processor', 'batchesIn'],
	processor_batch_sent: ['processor', 'batchesOut'],
	output_sent: ['output', 'sent'],
	output_batch_sent: ['output', 'batchesOut'],
	output_error: ['output', 'errors'],
};

const LATENCIES: Readonly<Record<string, SeriesKind>> = {
	processor_latency_ns: 'processor',
	output_latency_ns: 'output',
};

const QUANTILES: ReadonlyMap<number, 'p50' | 'p90' | 'p99'> = new Map([[0.5, 'p50'], [0.9, 'p90'], [0.99, 'p99']]);

/** Every Connect component family, the input's latency included (for `hasComponentSeries`). */
const COMPONENT_FAMILIES = new Set([...Object.keys(COUNTERS), ...Object.keys(LATENCIES), 'input_latency_ns', 'output_rejected']);

const keyOf = (path: string, label: string) => `${path}\u0000${label}`;

/** Whether `text` holds any of Connect's component series (with a `path`). */
export function hasComponentSeries(text: PromText): boolean {
	return text.samples.some((s) => s.labels.path !== undefined && COMPONENT_FAMILIES.has(familyOf(s.name, text.types).family));
}

/** Each component's counters (per pod) and quantiles in `reading`, by `path` + `label`, in the order first seen. */
export function componentReadings(reading: PromText): Map<string, ComponentReading> {
	const out = new Map<string, ComponentReading>();
	const at = (kind: SeriesKind, path: string, label: string): ComponentReading => {
		const key = keyOf(path, label);
		let entry = out.get(key);
		if (!entry) {
			entry = { key, path, label, kind, pods: new Map() };
			out.set(key, entry);
		}
		return entry;
	};
	const add = (entry: ComponentReading, pod: string, field: CounterField, value: number) => {
		let counters = entry.pods.get(pod);
		if (!counters) {
			counters = {};
			entry.pods.set(pod, counters);
		}
		counters[field] = (counters[field] ?? 0) + value;
	};
	for (const sample of reading.samples) {
		const path = sample.labels.path;
		if (path === undefined || !Number.isFinite(sample.value)) {
			continue;
		}
		const label = sample.labels.label ?? '';
		const pod = sample.labels.pod ?? '';
		const counter = COUNTERS[sample.name];
		if (counter) {
			add(at(counter[0], path, label), pod, counter[1], sample.value);
			continue;
		}
		const total = /^(.*)_(sum|count)$/.exec(sample.name);
		const totalOf = total ? LATENCIES[total[1]] : undefined;
		if (total && totalOf) {
			add(at(totalOf, path, label), pod, total[2] as 'sum' | 'count', sample.value);
			continue;
		}
		const latency = LATENCIES[sample.name];
		const quantile = sample.labels.quantile;
		if (latency && quantile !== undefined) {
			const field = QUANTILES.get(Number(quantile));
			if (field) {
				const entry = at(latency, path, label);
				entry[field] = Math.max(entry[field] ?? -Infinity, sample.value);
			}
		}
	}
	return out;
}

/** Ticket 7.6: `reading` as the window keeps it. */
export function compactReading(reading: MetricsReading): CompactReading {
	return { time: reading.time, components: componentReadings(reading) };
}

/**
 * Ticket 7.6: `readings` with `reading` added (a reading older than the last is dropped) and those
 * more than `MAX_WINDOW_MS` older than it dropped. A new array; `readings` is not changed.
 */
export function keepReading(readings: readonly CompactReading[], reading: CompactReading): CompactReading[] {
	const last = readings.at(-1);
	if (last && reading.time < last.time) {
		return readings.slice();
	}
	return [...readings.filter((r) => r.time >= reading.time - MAX_WINDOW_MS), reading];
}

/**
 * A counter's increase from `prev` to `cur` (ticket 7.6): `undefined` without `cur`; `cur` itself
 * when there was none before or it went back (a restart: the count starts again from 0, as
 * Prometheus's `rate()` counts it); never negative.
 */
export function increase(prev: number | undefined, cur: number | undefined): number | undefined {
	if (cur === undefined) {
		return undefined;
	}
	return prev === undefined || cur < prev ? cur : cur - prev;
}

/** The increase of `field` from `a` to `b`, summed over `b`'s pods (a pod new in `b` is a restart); `undefined`: none has it. */
function intervalIncrease(a: ComponentReading, b: ComponentReading, field: CounterField): number | undefined {
	let total: number | undefined;
	for (const [pod, counters] of b.pods) {
		const inc = increase(a.pods.get(pod)?.[field], counters[field]);
		if (inc !== undefined) {
			total = (total ?? 0) + inc;
		}
	}
	return total;
}

/** Ticket 7.7: a resource's own series (`root.processor_resources`, `root.output_resources`; its children's paths go on after it). */
const isResourcePath = (path: string) => /^root\.\w+_resources$/.test(path);

/** The out counter of a kind (the trend's): the input's received, the others' sent. */
const outField = (kind: SeriesKind): CounterField => (kind === 'input' ? 'received' : 'sent');

/**
 * The figures of the last of `readings` (oldest first) over the `windowMs` before it (ticket 7.6):
 * the readings at most `windowMs` older than the last; rates are their summed increases over the time
 * from the first to the last (none with one reading only); the quantiles the last reading's. The
 * input's row has only Out/s (`input_received`); an output's has no In/s, no batches in and no error
 * share. Two readings give the rates over the one interval between them.
 */
export function figures(readings: readonly CompactReading[], windowMs: number): Map<string, ComponentFigures> {
	const out = new Map<string, ComponentFigures>();
	const cur = readings.at(-1);
	if (!cur) {
		return out;
	}
	const window = readings.filter((r) => r.time >= cur.time - windowMs && r.time <= cur.time);
	const first = window[0];
	const seconds = (cur.time - first.time) / 1000;
	const components = [...cur.components.values()];
	const nestedIn = (inner: ComponentReading, outer: ComponentReading) =>
		inner !== outer && inner.kind === outer.kind && inner.path.startsWith(`${outer.path}.`);
	for (const c of components) {
		const totals: Partial<Record<CounterField, number>> = {};
		const trend: number[] = [];
		for (let i = 1; i < window.length; i++) {
			const b = window[i].components.get(c.key);
			const a = window[i - 1].components.get(c.key);
			// A component missing from either reading adds nothing for that interval (its running total
			// is not an increase); a new pod of a component that was there is a restart (`intervalIncrease`).
			if (!a || !b) {
				continue;
			}
			for (const field of ['received', 'sent', 'errors', 'batchesIn', 'batchesOut', 'sum', 'count'] as const) {
				const inc = intervalIncrease(a, b, field);
				if (inc !== undefined) {
					totals[field] = (totals[field] ?? 0) + inc;
				}
			}
			const ms = window[i].time - window[i - 1].time;
			const outInc = intervalIncrease(a, b, outField(c.kind));
			if (outInc !== undefined && ms > 0) {
				trend.push(outInc / (ms / 1000));
			}
		}
		const has = (field: CounterField) => [...c.pods.values()].some((p) => p[field] !== undefined);
		const r = (field: CounterField): number | null => (seconds > 0 && has(field) ? (totals[field] ?? 0) / seconds : null);
		const ratio = (num: CounterField, den: CounterField): number | null => {
			const d = totals[den];
			return seconds > 0 && has(num) && d !== undefined && d > 0 ? (totals[num] ?? 0) / d : null;
		};
		const base = {
			key: c.key, path: c.path, label: c.label, kind: c.kind, inRate: null, batchInRate: null, batchOutRate: null, errorRate: null,
			errorShare: null, p50: null, p90: null, p99: null, mean: null, trend,
			timeNs: c.kind !== 'input' && seconds > 0 && has('sum') ? totals.sum ?? 0 : null,
			share: null,
			leaf: isResourcePath(c.path) || !components.some((o) => nestedIn(o, c)),
		};
		switch (c.kind) {
			case 'input':
				out.set(c.key, { ...base, outRate: r('received') });
				break;
			case 'processor':
				out.set(c.key, {
					...base, inRate: r('received'), outRate: r('sent'), batchInRate: r('batchesIn'), batchOutRate: r('batchesOut'),
					errorRate: r('errors'), errorShare: ratio('errors', 'received'),
					p50: c.p50 ?? null, p90: c.p90 ?? null, p99: c.p99 ?? null, mean: ratio('sum', 'count'),
				});
				break;
			case 'output':
				out.set(c.key, {
					...base, outRate: r('sent'), batchOutRate: r('batchesOut'), errorRate: r('errors'),
					p50: c.p50 ?? null, p90: c.p90 ?? null, p99: c.p99 ?? null, mean: ratio('sum', 'count'),
				});
				break;
		}
	}
	// Ticket 7.7: each component's share of the time of the top-level processors, the output's top-level
	// series and the resources (a `resource:` processor reports no series, so its resource's time is not
	// in any other; the resource's children are nested in it, by path).
	let total = 0;
	for (const c of components) {
		const time = out.get(c.key)?.timeNs;
		if (c.kind !== 'input' && time !== null && time !== undefined && !components.some((o) => nestedIn(c, o))) {
			total += time;
		}
	}
	if (total > 0) {
		for (const [key, f] of out) {
			if (f.timeNs !== null) {
				out.set(key, { ...f, share: f.timeNs / total });
			}
		}
	}
	return out;
}

/** Ticket 7.7: the marks of a window's figures: the slowest component's key, and those with errors. */
export interface Marks {
	readonly slowest: string | undefined;
	readonly errors: ReadonlySet<string>;
}

/**
 * Ticket 7.7: the marks of `ordered` (the components in config order, as the tab lists them): the
 * slowest is the leaf with the largest share above 0 (never the input), the first on a tie, none
 * while no share is known; a component with errors over the window (Errors/s above 0) is marked.
 */
function marksOf(ordered: readonly ComponentFigures[], isLeaf: (f: ComponentFigures) => boolean = (f) => f.leaf): Marks {
	let slowest: ComponentFigures | undefined;
	const errors = new Set<string>();
	for (const f of ordered) {
		if (f.kind !== 'input' && isLeaf(f) && f.share !== null && f.share > 0 && (slowest === undefined || f.share > (slowest.share ?? 0))) {
			slowest = f;
		}
		if (f.errorRate !== null && f.errorRate > 0) {
			errors.add(f.key);
		}
	}
	return { slowest: slowest?.key, errors };
}

/** The series in the tab's order: those on a node in the model's order, then the others by path and label. */
function inConfigOrder(model: PipelineModel, byNode: ReadonlyMap<string, ComponentFigures>, unmatched: readonly ComponentFigures[]): {
	readonly matched: readonly (readonly [PipelineNode, ComponentFigures | undefined])[];
	readonly unmatched: readonly ComponentFigures[];
	readonly ordered: readonly ComponentFigures[];
} {
	const matched = model.nodes.filter((n) => n.role !== 'route').map((n) => [n, byNode.get(n.id)] as const);
	const rest = unmatched.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
	const ordered = [...matched.flatMap(([, f]) => (f ? [f] : [])), ...rest];
	return { matched, unmatched: rest, ordered };
}

/**
 * Ticket 7.7: the marks of `all` on `model` (the tab's and the graph's), ties broken in the tab's
 * order. A resource is a leaf when its config node has no child components (the series under
 * `root.processor_resources.` are any resource's children, so its path cannot tell); with no node, it is.
 */
export function bottleneck(model: PipelineModel, paths: ReadonlyMap<string, string>, all: ReadonlyMap<string, ComponentFigures>): Marks {
	const { byNode, unmatched } = figuresByNode(model, paths, all);
	const nodeOf = new Map([...byNode].map(([id, f]) => [f.key, id]));
	const parents = new Set(model.nodes.flatMap((n) => (n.parent !== undefined ? [n.parent] : [])));
	return marksOf(inConfigOrder(model, byNode, unmatched).ordered, (f) => {
		if (!isResourcePath(f.path)) {
			return f.leaf;
		}
		const id = nodeOf.get(f.key);
		return id === undefined || !parents.has(id);
	});
}

/** Ticket 7.7: a gap is named when the output's rate differs from the input's by more than this share of it. */
export const GAP_THRESHOLD = 0.05;

/**
 * Ticket 7.7: the gap between the input's and the output's rates: `null` when either is unknown or
 * they differ by at most `GAP_THRESHOLD` of the input's; else the difference (input − output, per
 * second) and its share of the input's (`null` when the input's is 0).
 */
export function gapOf(inputRate: number | null, outputRate: number | null): { readonly rate: number; readonly share: number | null } | null {
	if (inputRate === null || outputRate === null) {
		return null;
	}
	const diff = inputRate - outputRate;
	if (Math.abs(diff) <= GAP_THRESHOLD * inputRate && !(inputRate === 0 && diff !== 0)) {
		return null;
	}
	return { rate: diff, share: inputRate > 0 ? diff / inputRate : null };
}

/**
 * Ticket 7.7: the tab's summary line from its rows (config order): the slowest, the input's
 * (`input`) and the output's (`output`) rates and their gap, and the rows with errors; `null` while
 * no row has a rate (the first reading).
 */
export function metricsSummary(rows: readonly MetricRow[]): MetricsSummary | null {
	const hasRates = rows.some((r) => r.inRate !== null || r.outRate !== null || r.errorRate !== null);
	if (!hasRates) {
		return null;
	}
	const slowest = rows.find((r) => r.slowest);
	const input = rows.find((r) => r.kind === 'input' && r.path === 'input') ?? rows.find((r) => r.kind === 'input');
	// Only `root.output`'s own series: under a `broker` there is none, and one child's rate is not the output's.
	const output = rows.find((r) => r.kind === 'output' && r.path === 'output');
	const inputRate = input?.outRate ?? null;
	const outputRate = output?.outRate ?? null;
	return {
		slowest: slowest && slowest.share !== null ? { name: slowest.name, path: slowest.path, share: slowest.share, p50: slowest.p50 } : null,
		inputRate,
		outputRate,
		gap: gapOf(inputRate, outputRate),
		errors: rows.filter((r) => r.hasErrors && r.errorRate !== null).map((r) => ({ name: r.name, rate: r.errorRate as number })),
	};
}

/** Connect's path in AD-7's form: `root.` dropped, `.N` written `[N]` (`root.pipeline.processors.0` → `pipeline.processors[0]`). */
export function yamlPathOf(connectPath: string): string {
	const rest = connectPath === 'root' ? '' : connectPath.replace(/^root\./, '');
	let out = '';
	for (const part of rest.split('.')) {
		if (/^\d+$/.test(part)) {
			out += `[${part}]`;
		} else {
			out += out === '' ? part : `.${part}`;
		}
	}
	return out;
}

/**
 * The node a series maps to (AD-25): a non-empty `label` that one component node of the model has
 * gives that node (`label:<label>`, or `res:<kind>:<label>` for a resource); otherwise (no label, or
 * a label used more than once) the node at the series' path (`paths`, from `componentPaths`; else
 * the `path:` id). `undefined` when none matches.
 */
export function pathToNodeId(model: PipelineModel, paths: ReadonlyMap<string, string>, connectPath: string, label: string): string | undefined {
	if (label !== '') {
		const labelled = model.nodes.filter((n) => n.role !== 'route' && n.label === label);
		if (labelled.length === 1) {
			return labelled[0].id;
		}
	}
	const yamlPath = yamlPathOf(connectPath);
	for (const [id, p] of paths) {
		if (p === yamlPath) {
			return id;
		}
	}
	const id = `path:${yamlPath}`;
	return model.nodes.some((n) => n.id === id) ? id : undefined;
}

/**
 * Each series' figures on the node it maps to (`pathToNodeId`, AD-25), the first series of a node
 * winning; the series with no node (or a second one on a node) are `unmatched`, in reading order.
 */
export function figuresByNode(model: PipelineModel, paths: ReadonlyMap<string, string>, all: ReadonlyMap<string, ComponentFigures>): {
	readonly byNode: ReadonlyMap<string, ComponentFigures>;
	readonly unmatched: ComponentFigures[];
} {
	const byNode = new Map<string, ComponentFigures>();
	const unmatched: ComponentFigures[] = [];
	for (const f of all.values()) {
		const id = pathToNodeId(model, paths, f.path, f.label);
		if (id !== undefined && !byNode.has(id)) {
			byNode.set(id, f);
		} else {
			unmatched.push(f);
		}
	}
	return { byNode, unmatched };
}

/**
 * The graph's figures by node id (ticket 7.3, AD-17, AD-25): the same mapping as the tab's rows
 * (`figuresByNode`), for each component node drawn as a box (not a route, not a group); the input's
 * series gives only its Out/s (its latency is end-to-end). A node with no series has no entry.
 * Ticket 7.7: a component's share, and its marks (`slowest`, `hasErrors`) as the tab's (`bottleneck`).
 */
export function nodeFiguresOf(model: PipelineModel, paths: ReadonlyMap<string, string>, all: ReadonlyMap<string, ComponentFigures>): NodeFiguresById {
	const { byNode } = figuresByNode(model, paths, all);
	const marks = bottleneck(model, paths, all);
	const out: Record<string, NodeFigures> = {};
	for (const node of model.nodes) {
		const f = byNode.get(node.id);
		if (!f || node.role === 'route' || node.group === true) {
			continue;
		}
		out[node.id] = f.kind === 'input'
			? { kind: 'input', outRate: f.outRate }
			: {
				kind: 'component', inRate: f.inRate, outRate: f.outRate, errorRate: f.errorRate, p50: f.p50, p99: f.p99, share: f.share,
				...(marks.slowest === f.key ? { slowest: true as const } : {}),
				...(marks.errors.has(f.key) ? { hasErrors: true as const } : {}),
			};
	}
	return out;
}

const EMPTY_FIGURES = {
	inRate: null, outRate: null, batchInRate: null, batchOutRate: null, errorRate: null, errorShare: null, p50: null, p90: null, p99: null, mean: null,
	trend: [] as readonly number[], share: null, slowest: false, hasErrors: false,
} as const;

/** A row's figures from a component's, with its marks (ticket 7.7). */
const rowFigures = (f: ComponentFigures, marks: Marks) => ({
	inRate: f.inRate, outRate: f.outRate, batchInRate: f.batchInRate, batchOutRate: f.batchOutRate, errorRate: f.errorRate,
	errorShare: f.errorShare, p50: f.p50, p90: f.p90, p99: f.p99, mean: f.mean, trend: f.trend,
	share: f.share, slowest: marks.slowest === f.key, hasErrors: marks.errors.has(f.key),
});

/**
 * The tab's rows: one per component node of `model` in config order (the model's pre-order), at its
 * depth under its parent components (routes do not count), with the figures of the series that maps
 * to it; then every series with no node (or a second one on a node), by path.
 */
export function metricRows(model: PipelineModel, paths: ReadonlyMap<string, string>, all: ReadonlyMap<string, ComponentFigures>): MetricRow[] {
	const { byNode, unmatched } = figuresByNode(model, paths, all);
	const nodes = new Map(model.nodes.map((n) => [n.id, n]));
	const depthOf = (id: string): number => {
		let depth = 0;
		const seen = new Set<string>();
		for (let parent = nodes.get(id)?.parent; parent !== undefined && !seen.has(parent); parent = nodes.get(parent)?.parent) {
			seen.add(parent);
			if (nodes.get(parent)?.role !== 'route') {
				depth++;
			}
		}
		return depth;
	};
	const order = inConfigOrder(model, byNode, unmatched);
	const marks = bottleneck(model, paths, all);
	const rows: MetricRow[] = [];
	for (const [node, f] of order.matched) {
		const path = paths.get(node.id) ?? (node.id.startsWith('path:') ? node.id.slice('path:'.length) : f ? yamlPathOf(f.path) : '');
		rows.push({
			id: node.id,
			nodeId: node.id,
			kind: node.role as MetricKind,
			name: node.label ?? node.component ?? path,
			path,
			depth: depthOf(node.id),
			...(f ? rowFigures(f, marks) : EMPTY_FIGURES),
		});
	}
	for (const f of order.unmatched) {
		const path = yamlPathOf(f.path);
		rows.push({
			id: `series:${f.path}:${f.label}`,
			nodeId: null,
			kind: f.kind,
			name: f.label !== '' ? f.label : path,
			path,
			depth: 0,
			...rowFigures(f, marks),
		});
	}
	return rows;
}

/** `rows` in `sort`'s order (stable; a row with no figure always last), or as they are for `null`. */
export function sortRows(rows: readonly MetricRow[], sort: MetricsSort | null): MetricRow[] {
	if (!sort) {
		return rows.slice();
	}
	const value = (row: MetricRow): string | number | null => {
		switch (sort.column) {
			case 'name': return row.name;
			case 'path': return row.path === '' ? null : row.path;
			case 'in': return row.inRate;
			case 'out': return row.outRate;
			case 'batchesIn': return row.batchInRate;
			case 'batchesOut': return row.batchOutRate;
			case 'errors': return row.errorRate;
			case 'errorShare': return row.errorShare;
			case 'p50': return row.p50;
			case 'p90': return row.p90;
			case 'p99': return row.p99;
			case 'mean': return row.mean;
			case 'share': return row.share;
		}
	};
	const sign = sort.dir === 'asc' ? 1 : -1;
	return rows
		.map((row, index) => ({ row, index, v: value(row) }))
		.sort((a, b) => {
			if (a.v === null || b.v === null) {
				return a.v === b.v ? a.index - b.index : a.v === null ? 1 : -1;
			}
			const c = typeof a.v === 'string' && typeof b.v === 'string' ? a.v.localeCompare(b.v) : (a.v as number) - (b.v as number);
			return c !== 0 ? sign * c : a.index - b.index;
		})
		.map((x) => x.row);
}

/**
 * The type of the first YAML document's top-level `metrics` section (`prometheus`, `none`,
 * `json_api`, …): its first key other than `mapping`. `undefined` without one (Connect's default is
 * `prometheus`) or when the text does not parse.
 */
export function metricsTypeOf(parsed: ParsedYaml | undefined): string | undefined {
	const doc = parsed?.docs[0];
	if (!doc || doc.errors.length > 0 || !isMap(doc.contents)) {
		return undefined;
	}
	const section = (doc.contents.items as Pair[]).find((p) => isScalar(p.key) && p.key.value === 'metrics')?.value;
	if (!isMap(section)) {
		return undefined;
	}
	for (const pair of section.items as Pair[]) {
		const key = isScalar(pair.key) ? pair.key.value : undefined;
		if (typeof key === 'string' && key !== 'mapping') {
			return key;
		}
	}
	return undefined;
}
