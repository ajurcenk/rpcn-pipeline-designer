// The flat pipeline model for the graph (epic 3, ticket 3.1): the top-level input, the
// `pipeline.processors` list in order, and the output of the first YAML document. Pure (AD-15);
// no coordinates (AD-4); ranges are UTF-16 `[start, end)` offsets from the parse (AD-16); AD-7
// ids (`label:<label>`, else `path:<yamlPath>`). Nested groups and resources come in ticket 3.3.

import { isMap, isPair, isScalar, isSeq, type Node, type Pair, type YAMLMap } from 'yaml';
import { EMPTY_MODEL, type PipelineEdge, type PipelineModel, type PipelineNode } from '../shared/protocol';
import type { ParsedYaml } from './yamlPath';

/** Keys of a component map that are not the component itself. */
const NON_COMPONENT_KEYS = new Set(['label', 'processors']);

/**
 * Builds the flat model of `text` (already parsed as `parsed`). An unparseable text, or one whose
 * first document has a YAML error, gives the empty model. Never throws.
 */
export function buildPipelineModel(parsed: ParsedYaml | undefined, text: string): PipelineModel {
	try {
		const doc = parsed?.docs[0];
		if (!doc || doc.errors.length > 0 || !isMap(doc.contents)) {
			return EMPTY_MODEL;
		}
		const root = doc.contents;
		const nodes: PipelineNode[] = [];
		const labels = new Set<string>();
		const add = (role: PipelineNode['role'], path: string, value: unknown, range: () => readonly [number, number]) => {
			const component = componentName(value);
			if (!component) {
				return;
			}
			const label = labelOf(value);
			const duplicateLabel = label !== undefined && labels.has(label);
			if (label !== undefined) {
				labels.add(label);
			}
			nodes.push({
				id: label !== undefined && !duplicateLabel ? `label:${label}` : `path:${path}`,
				role,
				component,
				...(label !== undefined ? { label } : {}),
				range: range(),
				...(duplicateLabel ? { duplicateLabel: true } : {}),
			});
		};

		const input = pairOf(root, 'input');
		if (input) {
			add('input', 'input', input.value, () => pairRange(input, text));
		}

		const pipeline = pairOf(root, 'pipeline');
		const processors = pipeline && isMap(pipeline.value) ? pairOf(pipeline.value, 'processors') : undefined;
		if (processors && isSeq(processors.value)) {
			processors.value.items.forEach((item, index) => {
				const node = item as Node;
				if (node?.range) {
					add('processor', `pipeline.processors[${index}]`, item, () => [itemStart(text, node.range![0]), valueEnd(text, node.range![1])]);
				}
			});
		}

		const output = pairOf(root, 'output');
		if (output) {
			add('output', 'output', output.value, () => pairRange(output, text));
		}

		const edges: PipelineEdge[] = nodes.slice(1).map((target, i) => ({
			id: `${nodes[i].id}->${target.id}`,
			source: nodes[i].id,
			target: target.id,
		}));
		return { nodes, edges };
	} catch {
		return EMPTY_MODEL;
	}
}

/** The pair with scalar key `key` in `map`, if any. */
function pairOf(map: YAMLMap, key: string): Pair | undefined {
	return map.items.find((p) => isPair(p) && isScalar(p.key) && p.key.value === key);
}

/** The component key of a component map (`generate` in `{generate: …, label: …}`), if any. */
function componentName(value: unknown): string | undefined {
	if (!isMap(value)) {
		return undefined;
	}
	for (const pair of value.items) {
		// A null or empty key, or a merge key (`<<`), is not a component either.
		if (isScalar(pair.key) && pair.key.value !== null && pair.key.value !== undefined) {
			const key = String(pair.key.value);
			if (key !== '' && key !== '<<' && !NON_COMPONENT_KEYS.has(key)) {
				return key;
			}
		}
	}
	return undefined;
}

/**
 * The component's `label`, when it is a non-empty scalar. A number or boolean (`label: 123`) is
 * read as Redpanda Connect reads it, as its source text (`"123"`).
 */
function labelOf(value: unknown): string | undefined {
	const pair = isMap(value) ? pairOf(value, 'label') : undefined;
	if (!pair || !isScalar(pair.value)) {
		return undefined;
	}
	const scalar = pair.value;
	const raw = scalar.value;
	const label = typeof raw === 'string' ? raw
		: typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint'
			? (typeof scalar.source === 'string' ? scalar.source : String(raw))
			: undefined;
	return label !== undefined && label !== '' ? label : undefined;
}

/** From the start of the pair's key to the end of its value (AD-16). */
function pairRange(pair: Pair, text: string): readonly [number, number] {
	const key = pair.key as Node;
	const value = pair.value as Node;
	return [key.range![0], valueEnd(text, value.range![1])];
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
