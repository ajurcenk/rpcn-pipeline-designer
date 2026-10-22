// The `mapping` and `mutation` processors of a document (epic 4, ticket 4.2). Pure: from a parsed
// text, every map item of a `processors` or `processor_resources` list (and, since ticket 4.12,
// of the processor lists `try`, `catch` and `for_each`), at any depth, whose component is
// `mapping` or `mutation`, with its path, its label, the range of the component key
// and its decoded Bloblang (`Scalar.value`). Since ticket 4.3 each also carries its
// Bloblang-to-document position map (src/core/bloblangPositions.ts) and, given the document's
// PipelineModel, its graph node's AD-7 id (through `nodeAt`, never a copied rule).
// Ticket 4.18: the previous steps of a processor in its own list (`previousSteps`).
// Ticket 22: a third kind, `generate`: the `mapping` of a `generate` input at `input` or at a
// broker's `inputs[i]` below it (`input.broker.inputs[i]`, nested brokers too), for the live parse
// (4.5) and the graph marker (4.6) only. The processor-only features (the lens, the Test mapping
// command, the panel and its samples) take `processorsOnly` of the list.

import { isMap, isScalar, isSeq, type YAMLMap } from 'yaml';
import type { BloblangProcessorKind } from '../shared/bloblangProtocol';
import type { PipelineModel } from '../shared/protocol';
import { bloblangPositions, type BloblangPositions } from './bloblangPositions';
import { nodeAt } from './nodeAt';
import type { PathStep, ParsedYaml } from './yamlPath';

/**
 * The Bloblang kinds: the processors a test run supports (AD-21; a `mutation` keeps the input's
 * fields), and a `generate` input's `mapping` (ticket 22).
 */
export type BloblangKind = BloblangProcessorKind;

/** The processor kinds, as their component keys. */
export const BLOBLANG_KINDS: readonly BloblangKind[] = ['mapping', 'mutation'];

/**
 * Keys whose list items are processors: `processors`, `processor_resources`, and the `try`,
 * `catch` and `for_each` processors, whose value is itself a processor list (ticket 4.12).
 */
const PROCESSOR_LISTS = new Set(['processors', 'processor_resources', 'try', 'catch', 'for_each']);

export interface BloblangProcessor {
	/**
	 * The processor's YAML path, as in AD-7 ids without the `path:` prefix:
	 * `pipeline.processors[0]`, `processor_resources[1]`; prefixed `documents[i].` past the first document.
	 * A `generate` entry's is its `generate` map's: `input.generate`, `input.broker.inputs[1].generate`.
	 */
	readonly path: string;
	readonly kind: BloblangKind;
	/** The processor's `label`, when it has a non-empty string one (`generate`: the input's own `label`). */
	readonly label?: string;
	/** UTF-16 offsets `[start, end)` of the `mapping` / `mutation` key token (`generate`: its `mapping` key). */
	readonly keyRange: readonly [number, number];
	/** UTF-16 offsets `[start, end)` of the whole processor map (`generate`: the `generate` map). */
	readonly range: readonly [number, number];
	/** The Bloblang, decoded from its YAML scalar (an empty or non-scalar value gives `''`). */
	readonly source: string;
	/**
	 * The AD-7 id of the processor's PipelineModel node: the node `nodeAt` gives at the key, when
	 * it is a node of the processor's kind (`generate`: the input's node, a `generate` component).
	 * None with no model, or when the graph has no such node.
	 */
	readonly id?: string;
	/** From the binary's mapping-relative `line L char C` to UTF-16 document offsets (AD-21). */
	readonly positions: BloblangPositions;
}

/**
 * Every `mapping` / `mutation` processor and `generate` input mapping of `parsed`, in document
 * order; `model` (the first document's PipelineModel) gives their ids. Never throws.
 */
export function bloblangProcessors(parsed: ParsedYaml | undefined, model?: PipelineModel): BloblangProcessor[] {
	const out: BloblangProcessor[] = [];
	if (!parsed) {
		return out;
	}
	try {
		const context: Context = { text: parsed.text, ...(model ? { model } : {}) };
		parsed.docs.forEach((doc, i) => visit(doc.contents, i > 0 ? [`documents[${i}]`] : [], false, out, context));
	} catch {
		return out;
	}
	return out.sort((a, b) => a.keyRange[0] - b.keyRange[0]);
}

/** A `mapping` / `mutation` processor: what the panel can test. */
export type TestableProcessor = BloblangProcessor & { readonly kind: Exclude<BloblangKind, 'generate'> };

/** The `mapping` / `mutation` processors of `found`: what the lens, the command and the panel use (ticket 22). */
export function processorsOnly(found: readonly BloblangProcessor[]): TestableProcessor[] {
	return found.filter((p): p is TestableProcessor => p.kind !== 'generate');
}

/** The processor of `processors` whose map holds `offset` (the innermost one), if any. */
export function bloblangProcessorAt(processors: readonly BloblangProcessor[], offset: number): BloblangProcessor | undefined {
	let best: BloblangProcessor | undefined;
	for (const p of processors) {
		if (p.range[0] <= offset && offset <= p.range[1] && (!best || p.range[1] - p.range[0] < best.range[1] - best.range[0])) {
			best = p;
		}
	}
	return best;
}

/** The processor of `processors` at `path`, if any. */
export function bloblangProcessorByPath(processors: readonly BloblangProcessor[], path: string): BloblangProcessor | undefined {
	return processors.find((p) => p.path === path);
}

/** A processor's title, as its panel names it: its label, else its path (4.18). */
export function stepTitle(processor: Pick<BloblangProcessor, 'label' | 'path'>): string {
	return processor.label ?? processor.path;
}

/**
 * The steps before the processor at `path` in its own list (4.18), nearest first: for `<list>[n]`,
 * `<list>[n-1]`, `<list>[n-2]`, … while each is one of `processors` (a `mapping` or `mutation`);
 * the first item of another kind, or the start of the list, ends them. None for a `processor_resources`
 * item (resources are not a sequence of steps) or a path that names no list item.
 */
export function previousSteps(processors: readonly BloblangProcessor[], path: string): BloblangProcessor[] {
	const match = /^(.*)\[(\d+)\]$/.exec(path);
	if (!match) {
		return [];
	}
	const [, list, index] = match;
	if (list.split('.').pop() === 'processor_resources') {
		return [];
	}
	const out: BloblangProcessor[] = [];
	for (let i = Number(index) - 1; i >= 0; i--) {
		const step = bloblangProcessorByPath(processors, `${list}[${i}]`);
		if (!step) {
			break;
		}
		out.push(step);
	}
	return out;
}

/** `pipeline.processors[0]` from `['pipeline', 'processors', 0]` (a first `documents[i]` step is kept as is). */
function pathText(steps: readonly PathStep[]): string {
	return steps.reduce<string>((text, step) => (typeof step === 'number' ? `${text}[${step}]` : text ? `${text}.${step}` : step), '');
}

interface Context {
	readonly text: string;
	/** The first document's PipelineModel, when the caller has one: the source of `id`. */
	readonly model?: PipelineModel;
}

function visit(node: unknown, steps: readonly PathStep[], processorItem: boolean, out: BloblangProcessor[], context: Context): void {
	if (isMap(node)) {
		if (processorItem) {
			const found = processorOf(node, steps, context);
			if (found) {
				out.push(found);
			}
		} else if (isInputPath(steps)) {
			const found = generateOf(node, steps, context);
			if (found) {
				out.push(found);
			}
		}
		for (const pair of node.items) {
			if (!isScalar(pair.key)) {
				continue;
			}
			const key = String(pair.key.value);
			if (PROCESSOR_LISTS.has(key) && isSeq(pair.value)) {
				pair.value.items.forEach((item, i) => visit(item, [...steps, key, i], true, out, context));
			} else {
				visit(pair.value, [...steps, key], false, out, context);
			}
		}
	} else if (isSeq(node) && !processorItem) {
		node.items.forEach((item, i) => visit(item, [...steps, i], false, out, context));
	}
}

/**
 * Whether `steps` is where an input's map sits: a document's `input`, or `broker.inputs[i]` below
 * one (at any depth of brokers).
 */
function isInputPath(steps: readonly PathStep[]): boolean {
	const rest = typeof steps[0] === 'string' && /^documents\[\d+\]$/.test(steps[0]) ? steps.slice(1) : steps;
	let end = rest.length;
	while (end >= 4 && typeof rest[end - 1] === 'number' && rest[end - 2] === 'inputs' && rest[end - 3] === 'broker') {
		end -= 3;
	}
	return end === 1 && rest[0] === 'input';
}

/** An input map's `generate.mapping`, when its `generate` is a map with a `mapping` key. */
function generateOf(input: YAMLMap, steps: readonly PathStep[], context: Context): BloblangProcessor | undefined {
	const generatePair = input.items.find((p) => isScalar(p.key) && p.key.value === 'generate');
	const generate = generatePair?.value;
	if (!isMap(generate) || !generate.range) {
		return undefined;
	}
	const pair = generate.items.find((p) => isScalar(p.key) && p.key.value === 'mapping');
	const key = pair?.key;
	if (!pair || !isScalar(key) || !key.range) {
		return undefined;
	}
	return entryOf('generate', input, key.range, pair.value, generate.range, pathText([...steps, 'generate']), context);
}

/** A processor item's `mapping` / `mutation`: the first such key of the map. */
function processorOf(map: YAMLMap, steps: readonly PathStep[], context: Context): BloblangProcessor | undefined {
	const path = pathText(steps);
	const range = map.range;
	if (!range) {
		return undefined;
	}
	for (const pair of map.items) {
		const key = pair.key;
		if (!isScalar(key) || !key.range || !BLOBLANG_KINDS.includes(String(key.value) as BloblangKind)) {
			continue;
		}
		return entryOf(String(key.value) as BloblangKind, map, key.range, pair.value, range, path, context);
	}
	return undefined;
}

/**
 * The entry of a `kind` Bloblang `value` under the key at `keyRange`: its label is `owner`'s (the
 * processor's or the input's map), its range `range`.
 */
function entryOf(
	kind: BloblangKind,
	owner: YAMLMap,
	keyRange: readonly number[],
	value: unknown,
	range: readonly number[],
	path: string,
	context: Context,
): BloblangProcessor {
	const source = isScalar(value) && value.value !== null && value.value !== undefined ? String(value.value) : '';
	const labelPair = owner.items.find((p) => isScalar(p.key) && p.key.value === 'label');
	const label = labelPair && isScalar(labelPair.value) && typeof labelPair.value.value === 'string' && labelPair.value.value !== ''
		? labelPair.value.value
		: undefined;
	const nodeId = context.model ? nodeAt(context.model, keyRange[0]) : undefined;
	const node = nodeId === undefined ? undefined : context.model?.nodes.find((n) => n.id === nodeId);
	return {
		path,
		kind,
		...(label !== undefined ? { label } : {}),
		keyRange: [keyRange[0], keyRange[1]],
		range: [range[0], range[1]],
		source,
		...(node?.component === kind ? { id: node.id } : {}),
		positions: bloblangPositions(context.text, value, keyRange[0], source),
	};
}
