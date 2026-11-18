// The pure pipeline metrics model (AD-25, ticket 7.2): a reading's Prometheus samples as each
// component's counters and latency quantiles (per `path` + `label`), the figures of two readings
// (rates over the time between them, with counter resets), the mapping of a series to its model node
// (AD-7, AD-17), and the tab's rows in config order. No `vscode`, no I/O.
//
// Series (AD-25): counters `input_received`, `processor_received` / `_sent` / `_error`, `output_sent` /
// `_error`; summaries `processor_latency_ns` and `output_latency_ns` (quantiles 0.5 and 0.99 shown, in
// ns). `input_latency_ns` is the whole pipeline's time (read to ack): it is not the input's own and is
// not shown here (entry 6). Series without `path` are ignored. Several label sets of one component
// (several pods) are summed for counters, and the highest quantile is kept.

import { isMap, isScalar, type Pair } from 'yaml';
import type { PipelineModel } from '../shared/protocol';
import type { MetricKind, MetricRow, MetricsSort } from '../shared/metricsProtocol';
import { familyOf, type PromText } from './prometheus';
import type { ParsedYaml } from './yamlPath';

/** One read of a source: its own time (samples carry none) and its samples, already one pipeline's. */
export interface MetricsReading extends PromText {
	/** Milliseconds since the epoch, when the read was made. */
	readonly time: number;
}

export type SeriesKind = 'input' | 'processor' | 'output';

/** One component's raw values in one reading. */
export interface ComponentReading {
	readonly key: string;
	/** Connect's path (`root.pipeline.processors.0`). */
	readonly path: string;
	/** Connect's `label` (`""` when none). */
	readonly label: string;
	readonly kind: SeriesKind;
	received?: number;
	sent?: number;
	errors?: number;
	p50?: number;
	p99?: number;
}

/** One component's figures between two readings. Rates per second, latencies in ns; `null`: none. */
export interface ComponentFigures {
	readonly key: string;
	readonly path: string;
	readonly label: string;
	readonly kind: SeriesKind;
	readonly inRate: number | null;
	readonly outRate: number | null;
	readonly errorRate: number | null;
	readonly p50: number | null;
	readonly p99: number | null;
}

type CounterField = 'received' | 'sent' | 'errors';

const COUNTERS: Readonly<Record<string, readonly [SeriesKind, CounterField]>> = {
	input_received: ['input', 'received'],
	processor_received: ['processor', 'received'],
	processor_sent: ['processor', 'sent'],
	processor_error: ['processor', 'errors'],
	output_sent: ['output', 'sent'],
	output_error: ['output', 'errors'],
};

const LATENCIES: Readonly<Record<string, SeriesKind>> = {
	processor_latency_ns: 'processor',
	output_latency_ns: 'output',
};

/** Every Connect component family, the input's latency included (for `hasComponentSeries`). */
const COMPONENT_FAMILIES = new Set([...Object.keys(COUNTERS), ...Object.keys(LATENCIES), 'input_latency_ns',
	'processor_batch_received', 'processor_batch_sent', 'output_batch_sent', 'output_rejected']);

const keyOf = (path: string, label: string) => `${path}\u0000${label}`;

/** Whether `text` holds any of Connect's component series (with a `path`). */
export function hasComponentSeries(text: PromText): boolean {
	return text.samples.some((s) => s.labels.path !== undefined && COMPONENT_FAMILIES.has(familyOf(s.name, text.types).family));
}

/** Each component's counters and quantiles in `reading`, by `path` + `label`, in the order first seen. */
export function componentReadings(reading: PromText): Map<string, ComponentReading> {
	const out = new Map<string, ComponentReading>();
	const at = (kind: SeriesKind, path: string, label: string): ComponentReading => {
		const key = keyOf(path, label);
		let entry = out.get(key);
		if (!entry) {
			entry = { key, path, label, kind };
			out.set(key, entry);
		}
		return entry;
	};
	for (const sample of reading.samples) {
		const path = sample.labels.path;
		if (path === undefined || Number.isNaN(sample.value)) {
			continue;
		}
		const label = sample.labels.label ?? '';
		const counter = COUNTERS[sample.name];
		if (counter) {
			const entry = at(counter[0], path, label);
			entry[counter[1]] = (entry[counter[1]] ?? 0) + sample.value;
			continue;
		}
		const latency = LATENCIES[sample.name];
		const quantile = sample.labels.quantile;
		if (latency && quantile !== undefined) {
			const q = Number(quantile);
			const field = q === 0.5 ? 'p50' : q === 0.99 ? 'p99' : undefined;
			if (field && Number.isFinite(sample.value)) {
				const entry = at(latency, path, label);
				entry[field] = Math.max(entry[field] ?? -Infinity, sample.value);
			}
		}
	}
	return out;
}

/**
 * A counter's rate per second from `prev` to `cur` over `ms`: `null` without both values, without
 * time between them, or when the counter went back (a restart: the count starts again from `cur`).
 */
export function rate(prev: number | undefined, cur: number | undefined, ms: number): number | null {
	if (prev === undefined || cur === undefined || !(ms > 0) || cur < prev) {
		return null;
	}
	return (cur - prev) / (ms / 1000);
}

/**
 * The figures of `cur` against `prev` (the reading before it; none for the first): rates over the
 * time between them (none on the first reading), latencies as `cur` serves them. The input's row has
 * only Out/s (`input_received`); an output's has no In/s.
 */
export function figures(prev: MetricsReading | undefined, cur: MetricsReading): Map<string, ComponentFigures> {
	const before = prev ? componentReadings(prev) : new Map<string, ComponentReading>();
	const ms = prev ? cur.time - prev.time : 0;
	const out = new Map<string, ComponentFigures>();
	for (const c of componentReadings(cur).values()) {
		const p = before.get(c.key);
		const r = (field: CounterField) => rate(p?.[field], c[field], ms);
		const base = { key: c.key, path: c.path, label: c.label, kind: c.kind };
		switch (c.kind) {
			case 'input':
				out.set(c.key, { ...base, inRate: null, outRate: r('received'), errorRate: null, p50: null, p99: null });
				break;
			case 'processor':
				out.set(c.key, { ...base, inRate: r('received'), outRate: r('sent'), errorRate: r('errors'), p50: c.p50 ?? null, p99: c.p99 ?? null });
				break;
			case 'output':
				out.set(c.key, { ...base, inRate: null, outRate: r('sent'), errorRate: r('errors'), p50: c.p50 ?? null, p99: c.p99 ?? null });
				break;
		}
	}
	return out;
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

const EMPTY_FIGURES = { inRate: null, outRate: null, errorRate: null, p50: null, p99: null } as const;

/**
 * The tab's rows: one per component node of `model` in config order (the model's pre-order), at its
 * depth under its parent components (routes do not count), with the figures of the series that maps
 * to it; then every series with no node (or a second one on a node), by path.
 */
export function metricRows(model: PipelineModel, paths: ReadonlyMap<string, string>, all: ReadonlyMap<string, ComponentFigures>): MetricRow[] {
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
	const rows: MetricRow[] = [];
	for (const node of model.nodes) {
		if (node.role === 'route') {
			continue;
		}
		const f = byNode.get(node.id);
		const path = paths.get(node.id) ?? (node.id.startsWith('path:') ? node.id.slice('path:'.length) : f ? yamlPathOf(f.path) : '');
		rows.push({
			id: node.id,
			nodeId: node.id,
			kind: node.role as MetricKind,
			name: node.label ?? node.component ?? path,
			path,
			depth: depthOf(node.id),
			...(f ? { inRate: f.inRate, outRate: f.outRate, errorRate: f.errorRate, p50: f.p50, p99: f.p99 } : EMPTY_FIGURES),
		});
	}
	unmatched.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
	for (const f of unmatched) {
		const path = yamlPathOf(f.path);
		rows.push({
			id: `series:${f.path}:${f.label}`,
			nodeId: null,
			kind: f.kind,
			name: f.label !== '' ? f.label : path,
			path,
			depth: 0,
			inRate: f.inRate, outRate: f.outRate, errorRate: f.errorRate, p50: f.p50, p99: f.p99,
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
			case 'errors': return row.errorRate;
			case 'p50': return row.p50;
			case 'p99': return row.p99;
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
