// The pipeline model for the graph (epic 3; nested since ticket 3.3): every component of the
// first YAML document (input, `pipeline.processors`, output and `<category>_resources`), with
// the routes and children of nested groups, from the YAML plus the ComponentCatalog derived
// from the user's binary's schema (AD-20). Pure (AD-15); no coordinates (AD-4); ranges are
// UTF-16 `[start, end)` offsets from the parse (AD-16); AD-7 ids (`label:<label>`,
// `res:<category>:<label>`, else `path:<yamlPath>`). Nodes are in document pre-order.
//
// Structure is generic over the catalogue's slots (`src/core/catalogue.ts`):
//   - a wildcard (a list item or a map entry) before the slot's last step gives one route per
//     element (`switch` cases, `workflow` branches, `group_by`);
//   - a list or map slot that is the component's own value (`try: […]`, `fallback: […]`) gives
//     one uncaptioned route over the component key;
//   - any other slot (`branch.processors`, `retry.output`, `batching.processors`) gives direct
//     children, with no route.
// A processor list chains in order at each level; inputs and outputs in a list do not. An
// input's and an output's own `processors` join the main chain at the top level:
// input -> its processors -> `pipeline.processors` -> the output's processors -> output.
// DISPLAY_HINTS says how three components are shown, never which fields hold children.

import { isMap, isPair, isScalar, isSeq, type Node, type Pair, type Scalar, type YAMLMap } from 'yaml';
import { EMPTY_MODEL, type PipelineEdge, type PipelineModel, type PipelineNode, type PipelineNodeRole, type TextRange } from '../shared/protocol';
import { slotsOf, type CategoryCatalog, type ComponentCatalog, type Slot, type SlotStep } from './catalogue';
import type { ParsedYaml } from './yamlPath';

export { nodeAt } from './nodeAt';

// ---------------------------------------------------------------------------------------------
// Display hints: how the structure is shown, per `<category>:<component>`.
// ---------------------------------------------------------------------------------------------

interface DisplayHint {
	/** The caption of a route over a list item (a `switch` case); `index` is its position. */
	readonly itemCaption?: (item: unknown, index: number) => string | undefined;
	/** The children under this field sit in one route over its key, captioned from the component's value. */
	readonly fieldRoute?: { readonly field: string; readonly caption: (value: unknown) => string | undefined };
	/** Edges between the component's map-entry routes, as `[from key, to key]` pairs. */
	readonly routeEdges?: (value: unknown) => ReadonlyArray<readonly [string, string]>;
}

/** The longest `switch` case caption; a longer `check` is cut to one less, plus `…`. */
const CAPTION_MAX = 32;

/**
 * A `switch` case's caption: its `check` with whitespace runs collapsed to one space, cut to 31
 * characters (code points) plus `…`, else `case <i>`.
 */
function caseCaption(item: unknown, index: number): string {
	const check = isMap(item) ? scalarText(pairOf(item, 'check')?.value)?.replace(/\s+/g, ' ').trim() : undefined;
	if (!check) {
		return `case ${index}`;
	}
	// By code points, so a surrogate pair is never split.
	const chars = Array.from(check);
	return chars.length > CAPTION_MAX ? `${chars.slice(0, CAPTION_MAX - 1).join('')}…` : check;
}

/** `workflow.order`: every branch in stage k to every other branch in stage k + 1 (no self-loops). */
function workflowOrder(value: unknown): Array<readonly [string, string]> {
	const order = isMap(value) ? pairOf(value, 'order')?.value : undefined;
	if (!isSeq(order)) {
		return [];
	}
	const stages = order.items.map((stage) => (isSeq(stage)
		? stage.items.map((b) => scalarText(b)).filter((b): b is string => b !== undefined)
		: []));
	const edges: Array<readonly [string, string]> = [];
	for (let k = 0; k + 1 < stages.length; k++) {
		for (const from of stages[k]) {
			for (const to of stages[k + 1]) {
				if (from !== to) {
					edges.push([from, to]);
				}
			}
		}
	}
	return edges;
}

export const DISPLAY_HINTS: Readonly<Record<string, DisplayHint>> = {
	'processor:switch': { itemCaption: caseCaption },
	'output:switch': { itemCaption: caseCaption },
	'output:broker': {
		fieldRoute: { field: 'outputs', caption: (value) => (isMap(value) ? scalarText(pairOf(value, 'pattern')?.value) : undefined) },
	},
	'processor:workflow': { routeEdges: workflowOrder },
};

// ---------------------------------------------------------------------------------------------
// The builder.
// ---------------------------------------------------------------------------------------------

/**
 * Builds the model of `text` (already parsed as `parsed`) with `catalogue`. An unparseable text,
 * one whose first document has a YAML error, or no catalogue (no schema) gives the empty model.
 * Never throws.
 */
export function buildPipelineModel(parsed: ParsedYaml | undefined, text: string, catalogue: ComponentCatalog | undefined): PipelineModel {
	try {
		const doc = parsed?.docs[0];
		if (!catalogue || !doc || doc.errors.length > 0 || !isMap(doc.contents)) {
			return EMPTY_MODEL;
		}
		return new Builder(text, catalogue).build(doc.contents);
	} catch {
		return EMPTY_MODEL;
	}
}

type MutableNode = { -readonly [K in keyof PipelineNode]: PipelineNode[K] };

/** Where a component goes: its role, its parent, the processor chain it joins. */
interface Place {
	readonly role: PipelineNodeRole;
	readonly parent?: string;
	readonly chain?: Chain;
	/** A `<category>_resources` item: its id is `res:<category>:<label>`. */
	readonly resource?: string;
	/** At the top level, the chain the component's own shared `processors` join (no parent). */
	readonly sharedChain?: Chain;
}

interface Chain {
	push(id: string): void;
}

/** Something built later, in document order with its siblings. */
interface Site {
	readonly start: number;
	build(): void;
}

/** A place in the YAML reached by walking slot steps. */
interface Position {
	readonly node: unknown;
	readonly path: string;
	readonly range: TextRange | undefined;
	/** The map key, for a map entry. */
	readonly key?: string;
	/** The item index, for a list item. */
	readonly index?: number;
}

interface Route {
	readonly node: MutableNode;
	readonly sites: Site[];
}

class Builder {
	private readonly nodes: MutableNode[] = [];
	private readonly used = new Set<string>();
	/** Edge lists in the order they were started (pre-order); the main chain is first. */
	private readonly edgeBlocks: Array<() => PipelineEdge[]> = [];

	constructor(private readonly text: string, private readonly catalogue: ComponentCatalog) {}

	build(root: YAMLMap): PipelineModel {
		const input: string[] = [];
		const beforePipeline: string[] = [];
		const pipeline: string[] = [];
		const afterPipeline: string[] = [];
		const output: string[] = [];
		this.edgeBlocks.push(() => chainEdges([...input, ...beforePipeline, ...pipeline, ...afterPipeline, ...output]));
		const into = (ids: string[]): Chain => ({ push: (id) => ids.push(id) });

		for (const pair of root.items) {
			const key = keyText(pair);
			if (key === 'input' || key === 'output') {
				const range = this.pairRange(pair);
				if (range) {
					this.component(key, pair.value, key, range, {
						role: key,
						chain: into(key === 'input' ? input : output),
						sharedChain: into(key === 'input' ? beforePipeline : afterPipeline),
					});
				}
			} else if (key === 'pipeline') {
				const processors = isMap(pair.value) ? pairOf(pair.value, 'processors')?.value : undefined;
				if (isSeq(processors)) {
					processors.items.forEach((item, i) => {
						const range = this.itemRange(item);
						if (range) {
							this.component('processor', item, `pipeline.processors[${i}]`, range, { role: 'processor', chain: into(pipeline) });
						}
					});
				}
			} else if (key !== undefined && /^[A-Za-z0-9_]+_resources$/.test(key) && isSeq(pair.value)) {
				const category = key.slice(0, -'_resources'.length);
				pair.value.items.forEach((item, i) => {
					const range = this.itemRange(item);
					if (range) {
						this.component(category, item, `${key}[${i}]`, range, { role: 'resource', resource: category });
					}
				});
			}
		}

		const edges: PipelineEdge[] = [];
		const seen = new Set<string>();
		for (const block of this.edgeBlocks) {
			for (const edge of block()) {
				if (!seen.has(edge.id)) {
					seen.add(edge.id);
					edges.push(edge);
				}
			}
		}
		return { nodes: this.nodes, edges };
	}

	/** Adds the component at `path` (its map is `value`) and everything nested in it; its id, if any. */
	private component(category: string, value: unknown, path: string, range: TextRange, place: Place): string | undefined {
		if (!isMap(value)) {
			return undefined;
		}
		const entry = this.catalogue.categories.get(category);
		const keyPair = componentPair(value, entry);
		const name = keyPair && keyText(keyPair);
		if (!keyPair || name === undefined) {
			return undefined;
		}
		const label = labelOf(value);
		const preferred = label === undefined ? undefined : place.resource !== undefined ? `res:${place.resource}:${label}` : `label:${label}`;
		const duplicateLabel = preferred !== undefined && this.used.has(preferred);
		const id = preferred !== undefined && !duplicateLabel ? preferred : `path:${path}`;
		this.used.add(id);
		const node: MutableNode = {
			id,
			role: place.role,
			component: name,
			...(label !== undefined ? { label } : {}),
			range,
			...(place.parent !== undefined ? { parent: place.parent } : {}),
			...(duplicateLabel ? { duplicateLabel: true } : {}),
		};
		this.nodes.push(node);
		place.chain?.push(id);

		const sites: Site[] = [];
		const routes = new Map<string, Route>();
		const routesByKey = new Map<string, string>();
		const hint = DISPLAY_HINTS[`${category}:${name}`];
		const own: Position = { node: keyPair.value, path: `${path}${segment(name)}`, range: this.pairRange(keyPair) };
		let present = false;
		const context: SlotContext = { componentId: id, hint, sites, routes, routesByKey, value: keyPair.value };
		for (const slot of slotsOf(this.catalogue, category, name)) {
			present = this.slot(slot, own, true, context) || present;
		}
		// An input's or output's own `processors`: the main chain at the top level, else children.
		const self: Position = { node: value, path, range };
		for (const slot of entry?.sharedSlots ?? []) {
			if (place.sharedChain) {
				this.slot(slot, self, false, { ...context, componentId: undefined, routes: new Map(), routesByKey: new Map(), chain: place.sharedChain });
			} else {
				present = this.slot(slot, self, false, context) || present;
			}
		}
		if (present) {
			node.group = true;
		}
		if (hint?.routeEdges) {
			const pairs = hint.routeEdges(keyPair.value);
			this.edgeBlocks.push(() => pairs.flatMap(([from, to]) => {
				const source = routesByKey.get(from);
				const target = routesByKey.get(to);
				return source !== undefined && target !== undefined ? [edge(source, target)] : [];
			}));
		}
		runInOrder(sites);
		return id;
	}

	/**
	 * Adds the sites of one slot under `start` (the component's value, or for a shared slot the
	 * component's map) to the context. Whether the slot is present in the YAML.
	 */
	private slot(slot: Slot, start: Position, ownValue: boolean, context: SlotContext): boolean {
		const { steps } = slot;
		if (steps.length === 0) {
			// The component's value is itself the child (`reject_errored`): a direct child.
			if (!isMap(start.node)) {
				return false;
			}
			// Its range is its own component pair's, from its component key to its value end (AD-16).
			const childPair = componentPair(start.node, this.catalogue.categories.get(slot.category));
			const range = childPair && this.pairRange(childPair);
			this.childSite(slot, { ...start, range }, context.componentId, context.sites, context.chain);
			return true;
		}
		const last = steps.length - 1;
		const first = steps[0];
		let routeAt: number | undefined;
		if (ownValue && steps.length === 1 && first.kind !== 'field') {
			routeAt = -1; // a route over the component key
		} else if (ownValue && context.hint?.fieldRoute && first.kind === 'field' && first.name === context.hint.fieldRoute.field && steps.length > 1) {
			routeAt = 0;
		} else {
			const wildcard = steps.findIndex((s, i) => i < last && s.kind !== 'field');
			routeAt = wildcard >= 0 ? wildcard : undefined;
		}

		if (routeAt === undefined) {
			return this.children(slot, start, steps, context.componentId, context.sites, context.chain);
		}
		const elements = routeAt < 0 ? [start] : this.walk([start], steps.slice(0, routeAt + 1));
		let present = false;
		for (const element of elements) {
			if (!(isMap(element.node) || isSeq(element.node)) || !element.range || context.componentId === undefined) {
				continue;
			}
			present = true;
			const route = this.route(element, routeAt < 0 ? undefined : steps[routeAt], context);
			this.children(slot, element, steps.slice(routeAt + 1), route.node.id, route.sites, undefined);
		}
		return present;
	}

	/** The route over `element`, made once per component and element. */
	private route(element: Position, step: SlotStep | undefined, context: SlotContext): Route {
		const id = `path:${element.path}`;
		const existing = context.routes.get(id);
		if (existing) {
			return existing;
		}
		const caption = step === undefined ? undefined
			: step.kind === 'entries' ? element.key
				: step.kind === 'items' ? context.hint?.itemCaption?.(element.node, element.index ?? 0)
					: context.hint?.fieldRoute?.caption(context.value);
		const node: MutableNode = {
			id,
			role: 'route',
			...(caption !== undefined ? { caption } : {}),
			range: element.range!,
			parent: context.componentId,
		};
		const route: Route = { node, sites: [] };
		context.routes.set(id, route);
		if (element.key !== undefined) {
			context.routesByKey.set(element.key, id);
		}
		context.sites.push({
			start: node.range[0],
			build: () => {
				this.used.add(id);
				this.nodes.push(node);
				runInOrder(route.sites);
			},
		});
		return route;
	}

	/** The child sites at the end of `steps` from `from`. Whether the slot's place is present. */
	private children(slot: Slot, from: Position, steps: readonly SlotStep[], parent: string | undefined, sites: Site[], chain: Chain | undefined): boolean {
		const containers = this.walk([from], steps.slice(0, -1));
		const final = steps[steps.length - 1];
		let present = false;
		for (const container of containers) {
			const reached = final.kind === 'field' ? isMap(container.node) && pairOf(container.node, final.name) !== undefined
				: final.kind === 'items' ? isSeq(container.node) : isMap(container.node);
			if (!reached) {
				continue;
			}
			present = true;
			// A processor list chains in order; inputs and outputs do not.
			const listChain = chain ?? (slot.category === 'processor' && slot.kind === 'list' ? this.chain() : undefined);
			for (const child of this.walk([container], [final])) {
				this.childSite(slot, child, parent, sites, listChain);
			}
		}
		return present;
	}

	private childSite(slot: Slot, child: Position, parent: string | undefined, sites: Site[], chain: Chain | undefined): void {
		const range = child.range;
		if (!range) {
			return;
		}
		sites.push({
			start: range[0],
			build: () => {
				this.component(slot.category, child.node, child.path, range, {
					role: slot.category,
					...(parent !== undefined ? { parent } : {}),
					...(chain ? { chain } : {}),
				});
			},
		});
	}

	/** A processor chain whose edges are listed from when its first member is added. */
	private chain(): Chain {
		const ids: string[] = [];
		return {
			push: (id) => {
				if (ids.length === 0) {
					this.edgeBlocks.push(() => chainEdges(ids));
				}
				ids.push(id);
			},
		};
	}

	/** Every position `steps` lead to from `from`. */
	private walk(from: readonly Position[], steps: readonly SlotStep[]): Position[] {
		let positions = [...from];
		for (const step of steps) {
			positions = positions.flatMap((p) => this.step(p, step));
		}
		return positions;
	}

	private step(p: Position, step: SlotStep): Position[] {
		if (step.kind === 'field') {
			const pair = isMap(p.node) ? pairOf(p.node, step.name) : undefined;
			return pair ? [{ node: pair.value, path: `${p.path}${segment(step.name)}`, range: this.pairRange(pair) }] : [];
		}
		if (step.kind === 'items') {
			return isSeq(p.node)
				? p.node.items.map((item, index) => ({ node: item, path: `${p.path}[${index}]`, range: this.itemRange(item), index }))
				: [];
		}
		if (!isMap(p.node)) {
			return [];
		}
		return p.node.items.flatMap((pair) => {
			const key = keyText(pair);
			return key === undefined ? [] : [{ node: pair.value, path: `${p.path}${segment(key)}`, range: this.pairRange(pair), key }];
		});
	}

	/** From the start of the pair's key to the end of its value (AD-16). */
	private pairRange(pair: Pair): TextRange | undefined {
		const key = pair.key as Node | null;
		const value = pair.value as Node | null;
		const start = key?.range?.[0];
		const end = value?.range?.[1] ?? key?.range?.[1];
		return start === undefined || end === undefined ? undefined : [start, Math.max(start, valueEnd(this.text, end))];
	}

	/** From a sequence item's `- ` indicator (or its start, in a flow sequence) to its value's end. */
	private itemRange(item: unknown): TextRange | undefined {
		const range = (item as Node | null)?.range;
		return range ? [itemStart(this.text, range[0]), valueEnd(this.text, range[1])] : undefined;
	}
}

interface SlotContext {
	/** The component the slot's children (or routes) belong to; none for the top-level shared chain. */
	readonly componentId: string | undefined;
	readonly hint: DisplayHint | undefined;
	readonly sites: Site[];
	readonly routes: Map<string, Route>;
	readonly routesByKey: Map<string, string>;
	/** A chain every child joins (the top-level shared `processors`). */
	readonly chain?: Chain;
	/** The component's value, for a field route's caption. */
	readonly value?: unknown;
}

function runInOrder(sites: Site[]): void {
	[...sites].sort((a, b) => a.start - b.start).forEach((s) => s.build());
}

function edge(source: string, target: string): PipelineEdge {
	return { id: `${source}->${target}`, source, target };
}

function chainEdges(ids: readonly string[]): PipelineEdge[] {
	return ids.slice(1).map((target, i) => edge(ids[i], target));
}

/** `.key`, or `["key"]` (JSON string escaping) when the key is not `[A-Za-z0-9_-]+` (AD-7). */
function segment(key: string): string {
	return /^[A-Za-z0-9_-]+$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/** The pair with scalar key `key` in `map`, if any. */
function pairOf(map: YAMLMap, key: string): Pair | undefined {
	return map.items.find((p) => isPair(p) && isScalar(p.key) && p.key.value === key);
}

/** A scalar key as text; none for a null, empty or merge (`<<`) key. */
function keyText(pair: Pair): string | undefined {
	const key = scalarText(pair.key);
	return key !== undefined && key !== '' && key !== '<<' ? key : undefined;
}

/**
 * The component key of a component map: the first key that is a component name of the
 * category; else (a plugin, a typo, a component of another version) the first key that is not
 * one of the category's shared fields.
 */
function componentPair(value: YAMLMap, entry: CategoryCatalog | undefined): Pair | undefined {
	const keyed = value.items.filter((p) => keyText(p) !== undefined);
	return keyed.find((p) => entry?.names.has(keyText(p)!))
		?? keyed.find((p) => !(entry?.sharedFields ?? DEFAULT_SHARED_FIELDS).has(keyText(p)!));
}

const DEFAULT_SHARED_FIELDS: ReadonlySet<string> = new Set(['label']);

/**
 * A scalar's text: a string as is; a number or boolean as its source text (`label: 123` is
 * `"123"`, as Redpanda Connect reads it). None for anything else.
 */
function scalarText(node: unknown): string | undefined {
	if (!isScalar(node)) {
		return undefined;
	}
	const scalar = node as Scalar;
	const raw = scalar.value;
	return typeof raw === 'string' ? raw
		: typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint'
			? (typeof scalar.source === 'string' ? scalar.source : String(raw))
			: undefined;
}

/** The component's `label`, when it is a non-empty scalar. */
function labelOf(value: YAMLMap): string | undefined {
	const label = scalarText(pairOf(value, 'label')?.value);
	return label !== undefined && label !== '' ? label : undefined;
}

/** A block collection's value end includes its line break; the node ends at its last character. */
function valueEnd(text: string, end: number): number {
	let e = end;
	while (e > 0 && /\s/.test(text[e - 1])) {
		e--;
	}
	return e;
}

/** Moves a sequence item's start back over its `- ` indicator, when one precedes it on the line. */
function itemStart(text: string, start: number): number {
	let i = start - 1;
	while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) {
		i--;
	}
	return i >= 0 && text[i] === '-' ? i : start;
}
