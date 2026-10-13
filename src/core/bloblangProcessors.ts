// The `mapping` and `mutation` processors of a document (epic 4, ticket 4.2). Pure: from a parsed
// text, every map item of a `processors` or `processor_resources` list, at any depth, whose
// component is `mapping` or `mutation`, with its path, its label, the range of the component key
// and its decoded Bloblang (`Scalar.value`). Entry 4.3 adds the Bloblang-to-document position map.

import { isMap, isScalar, isSeq, type YAMLMap } from 'yaml';
import type { BloblangProcessorKind } from '../shared/bloblangProtocol';
import type { PathStep, ParsedYaml } from './yamlPath';

/** The processor kinds a test run supports (AD-21): a `mutation` keeps the input's fields. */
export type BloblangKind = BloblangProcessorKind;

export const BLOBLANG_KINDS: readonly BloblangKind[] = ['mapping', 'mutation'];

/** Keys whose list items are processors. */
const PROCESSOR_LISTS = new Set(['processors', 'processor_resources']);

export interface BloblangProcessor {
	/**
	 * The processor's YAML path, as in AD-7 ids without the `path:` prefix:
	 * `pipeline.processors[0]`, `processor_resources[1]`; prefixed `documents[i].` past the first document.
	 */
	readonly path: string;
	readonly kind: BloblangKind;
	/** The processor's `label`, when it has a non-empty string one. */
	readonly label?: string;
	/** UTF-16 offsets `[start, end)` of the `mapping` / `mutation` key token. */
	readonly keyRange: readonly [number, number];
	/** UTF-16 offsets `[start, end)` of the whole processor map. */
	readonly range: readonly [number, number];
	/** The Bloblang, decoded from its YAML scalar (an empty or non-scalar value gives `''`). */
	readonly source: string;
}

/** Every `mapping` / `mutation` processor of `parsed`, in document order. Never throws. */
export function bloblangProcessors(parsed: ParsedYaml | undefined): BloblangProcessor[] {
	const out: BloblangProcessor[] = [];
	if (!parsed) {
		return out;
	}
	try {
		parsed.docs.forEach((doc, i) => visit(doc.contents, i > 0 ? [`documents[${i}]`] : [], false, out));
	} catch {
		return out;
	}
	return out.sort((a, b) => a.keyRange[0] - b.keyRange[0]);
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

/** `pipeline.processors[0]` from `['pipeline', 'processors', 0]` (a first `documents[i]` step is kept as is). */
function pathText(steps: readonly PathStep[]): string {
	return steps.reduce<string>((text, step) => (typeof step === 'number' ? `${text}[${step}]` : text ? `${text}.${step}` : step), '');
}

function visit(node: unknown, steps: readonly PathStep[], processorItem: boolean, out: BloblangProcessor[]): void {
	if (isMap(node)) {
		if (processorItem) {
			const found = processorOf(node, pathText(steps));
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
				pair.value.items.forEach((item, i) => visit(item, [...steps, key, i], true, out));
			} else {
				visit(pair.value, [...steps, key], false, out);
			}
		}
	} else if (isSeq(node) && !processorItem) {
		node.items.forEach((item, i) => visit(item, [...steps, i], false, out));
	}
}

/** A processor item's `mapping` / `mutation`: the first such key of the map. */
function processorOf(map: YAMLMap, path: string): BloblangProcessor | undefined {
	const range = map.range;
	if (!range) {
		return undefined;
	}
	for (const pair of map.items) {
		const key = pair.key;
		if (!isScalar(key) || !key.range || !BLOBLANG_KINDS.includes(String(key.value) as BloblangKind)) {
			continue;
		}
		const value = pair.value;
		const source = isScalar(value) && value.value !== null && value.value !== undefined ? String(value.value) : '';
		const labelPair = map.items.find((p) => isScalar(p.key) && p.key.value === 'label');
		const label = labelPair && isScalar(labelPair.value) && typeof labelPair.value.value === 'string' && labelPair.value.value !== ''
			? labelPair.value.value
			: undefined;
		return {
			path,
			kind: String(key.value) as BloblangKind,
			...(label !== undefined ? { label } : {}),
			keyRange: [key.range[0], key.range[1]],
			range: [range[0], range[1]],
			source,
		};
	}
	return undefined;
}
