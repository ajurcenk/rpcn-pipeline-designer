// The pre-deploy check against a cluster (ticket 8, E5, AD-23 "Components"). Pure (AD-15): from a
// config's component uses (`componentUses`, src/core/graph.ts) and Bloblang calls
// (`documentBloblangCalls`, src/core/bloblang.ts), and what the cluster runs (its
// `GET {dp}/v1/redpanda-connect/components` answer, read here by `clusterComponents`), the findings:
// each component (input, output, processor, cache, rate limit, buffer, metrics, tracer, scanner) and
// each Bloblang function and method the cluster does not offer, on the local file's line. Component
// fields are never checked against the cluster's schema.
//
// The answer's entries carry a `config` field tree (`{name, type, kind, children}`, as `list --format
// json-full` prints it), so `clusterComponents` also derives a ComponentCatalog from it (the same slot
// rule as `src/core/catalogue.ts`: a field whose `type` is `input`, `processor` or `output` is a slot,
// `kind` `array` a list, `map` a map; `type` `scanner` a scanner slot). Deploy uses it only when no
// local schema is loaded (no binary). The shared fields of a category are not in those trees: there,
// an input's and an output's `processors` list is the one shared slot (as in every Connect schema).

import type { BloblangCall } from './bloblang';
import type { CategoryCatalog, ComponentCatalog, Slot, SlotCategory, SlotStep } from './catalogue';
import type { ComponentUse } from './graph';

/** The answer's lists (`components.<key>`) by the category the config uses (the schema's definitions). */
export const CLUSTER_CATEGORIES: Readonly<Record<string, string>> = {
	inputs: 'input',
	outputs: 'output',
	processors: 'processor',
	caches: 'cache',
	rate_limits: 'rate_limit',
	buffers: 'buffer',
	metrics: 'metrics',
	tracers: 'tracer',
	scanners: 'scanner',
};

/** What a cluster runs, from its components list. */
export interface ClusterComponents {
	/** Its Redpanda Connect version (`components.version`), when given. */
	readonly version?: string;
	/** The component names per category (`input`, `cache`, …); a category the answer has no list for is absent. */
	readonly names: ReadonlyMap<string, ReadonlySet<string>>;
	/** The Bloblang functions and methods; `undefined` when the answer has no such list. */
	readonly functions?: ReadonlySet<string>;
	readonly methods?: ReadonlySet<string>;
	/** The catalogue derived from the entries' config trees (used when no local schema is loaded). */
	readonly catalogue: ComponentCatalog;
}

/** One finding of the check (a lint error is reported by the caller the same way). */
export interface CloudFinding {
	/** 1-based line of the local file. */
	readonly line: number;
	/** UTF-16 offsets `[start, end)` of the name. */
	readonly start: number;
	readonly end: number;
	/** The finding without its line: "input `stdin` is not available on rpc-vilnius (Redpanda Connect 4.115.0)". */
	readonly text: string;
}

/** "line 4: input `stdin` is not available on …". */
export function findingMessage(f: Pick<CloudFinding, 'line' | 'text'>): string {
	return `line ${f.line}: ${f.text}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function namesOf(list: unknown): Set<string> | undefined {
	if (!Array.isArray(list)) {
		return undefined;
	}
	const out = new Set<string>();
	for (const e of list) {
		if (isObject(e) && typeof e.name === 'string' && e.name) {
			out.add(e.name);
		}
	}
	return out;
}

/**
 * The cluster's components from its answer (`{components: {version, inputs: [{name, config, …}], …,
 * bloblang_functions, bloblang_methods}}`, or the inner object). `undefined` when it holds none.
 */
export function clusterComponents(body: unknown): ClusterComponents | undefined {
	const c = isObject(body) && isObject(body.components) ? body.components : isObject(body) && 'version' in body ? body : undefined;
	if (!c) {
		return undefined;
	}
	const names = new Map<string, ReadonlySet<string>>();
	const categories = new Map<string, CategoryCatalog>();
	for (const [key, category] of Object.entries(CLUSTER_CATEGORIES)) {
		const list = c[key];
		const found = namesOf(list);
		if (!found) {
			continue;
		}
		names.set(category, found);
		categories.set(category, categoryCatalogue(category, list as unknown[]));
	}
	const functions = namesOf(c.bloblang_functions);
	const methods = namesOf(c.bloblang_methods);
	return {
		...(typeof c.version === 'string' && c.version ? { version: c.version } : {}),
		names,
		...(functions ? { functions } : {}),
		...(methods ? { methods } : {}),
		catalogue: { categories },
	};
}

const SLOT_TYPES: ReadonlySet<string> = new Set(['input', 'processor', 'output']);

/** The fields every component of a category shares, which the config trees leave out. */
function sharedFieldsOf(category: string): Set<string> {
	const shared = new Set(['label', 'meta', 'plugin', 'type']);
	if (category === 'input' || category === 'output') {
		shared.add('processors');
	}
	if (category === 'metrics') {
		shared.add('mapping');
	}
	return shared;
}

function categoryCatalogue(category: string, list: readonly unknown[]): CategoryCatalog {
	const names = new Set<string>();
	const slots = new Map<string, readonly Slot[]>();
	const scannerSlots = new Map<string, readonly (readonly SlotStep[])[]>();
	for (const e of list) {
		if (!isObject(e) || typeof e.name !== 'string' || !e.name || names.has(e.name)) {
			continue;
		}
		names.add(e.name);
		const found: Slot[] = [];
		const scanners: SlotStep[][] = [];
		if (isObject(e.config)) {
			treeSlots(e.config, [], found, scanners, 0);
		}
		if (found.length > 0) {
			slots.set(e.name, found);
		}
		if (scanners.length > 0) {
			scannerSlots.set(e.name, scanners);
		}
	}
	const processorsSlot: Slot = { steps: [{ kind: 'field', name: 'processors' }, { kind: 'items' }], category: 'processor', kind: 'list' };
	return {
		names,
		slots,
		sharedFields: sharedFieldsOf(category),
		sharedSlots: category === 'input' || category === 'output' ? [processorsSlot] : [],
		scannerSlots,
	};
}

/** The slots and scanner slots of a config field tree node reached by `steps` (its own name already in them). */
function treeSlots(field: Record<string, unknown>, steps: readonly SlotStep[], found: Slot[], scanners: SlotStep[][], depth: number): void {
	if (depth > 30) {
		return;
	}
	const kind = field.kind;
	const type = field.type;
	const here: SlotStep[] = kind === 'array' ? [...steps, { kind: 'items' }] : kind === 'map' ? [...steps, { kind: 'entries' }] : [...steps];
	if (typeof type === 'string' && SLOT_TYPES.has(type)) {
		found.push({ steps: here, category: type as SlotCategory, kind: kind === 'array' ? 'list' : kind === 'map' ? 'map' : 'single' });
		return;
	}
	if (type === 'scanner') {
		scanners.push(here);
		return;
	}
	if (!Array.isArray(field.children)) {
		return;
	}
	for (const child of field.children) {
		if (isObject(child) && typeof child.name === 'string' && child.name) {
			treeSlots(child, [...here, { kind: 'field', name: child.name }], found, scanners, depth + 1);
		}
	}
}

/** `rate_limit` → `rate limit`. */
export function categoryText(category: string): string {
	return category.replace(/_/g, ' ');
}

/** The 1-based line of `offset` in `text`. */
export function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) {
		line++;
	}
	return line;
}

/**
 * The findings of the local `text` against `cluster` (named `clusterName`): every use of a component
 * of a category the cluster lists but not under that name, and every call of a function or method it
 * does not list, in document order.
 */
export function checkAgainstCluster(
	text: string, uses: readonly ComponentUse[], calls: readonly BloblangCall[], cluster: ClusterComponents, clusterName: string,
): CloudFinding[] {
	const out: CloudFinding[] = [];
	const version = cluster.version ? ` (Redpanda Connect ${cluster.version})` : '';
	for (const u of uses) {
		const available = cluster.names.get(u.category);
		if (available && !available.has(u.name)) {
			out.push({ line: lineOf(text, u.offset), start: u.offset, end: u.offset + u.name.length,
				text: `${categoryText(u.category)} \`${u.name}\` is not available on ${clusterName}${version}` });
		}
	}
	for (const c of calls) {
		const available = c.kind === 'function' ? cluster.functions : cluster.methods;
		if (available && !available.has(c.name)) {
			out.push({ line: lineOf(text, c.offset), start: c.offset, end: c.offset + c.name.length,
				text: c.kind === 'function'
					? `Bloblang function \`${c.name}()\` is not available on ${clusterName}`
					: `Bloblang method \`.${c.name}()\` is not available on ${clusterName}` });
		}
	}
	return out.sort((a, b) => a.start - b.start);
}

/** Whether two Connect versions are both known and differ (`v4.1.0` and `4.1.0` are the same). */
export function versionsDiffer(cluster: string | undefined, local: string | undefined): boolean {
	const norm = (v: string | undefined) => v?.trim().replace(/^v/i, '') || undefined;
	const a = norm(cluster);
	const b = norm(local);
	return a !== undefined && b !== undefined && a !== b;
}
