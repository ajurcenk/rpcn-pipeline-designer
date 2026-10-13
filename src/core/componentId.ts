// The PipelineModel builder's AD-7 component id rule and the YAML helpers it reads labels with
// (src/core/graph.ts). Pure. The Bloblang finder takes its ids from the built model (`nodeAt`).

import { isPair, isScalar, type Pair, type Scalar, type YAMLMap } from 'yaml';

/**
 * A component's AD-7 id: `res:<resource>:<label>` for a `<resource>_resources` item with a label,
 * `label:<label>` for any other labelled component, else `path:<path>`. A label id already in
 * `used` (a duplicate label: the first in document order keeps it) falls back to the path id.
 * Adds the id to `used`.
 */
export function componentId(
	label: string | undefined,
	resource: string | undefined,
	path: string,
	used: Set<string>,
): { readonly id: string; readonly duplicateLabel: boolean } {
	const preferred = label === undefined ? undefined : resource !== undefined ? `res:${resource}:${label}` : `label:${label}`;
	const duplicateLabel = preferred !== undefined && used.has(preferred);
	const id = preferred !== undefined && !duplicateLabel ? preferred : `path:${path}`;
	used.add(id);
	return { id, duplicateLabel };
}

/** `.key`, or `["key"]` (JSON string escaping) when the key is not `[A-Za-z0-9_-]+` (AD-7). */
export function segment(key: string): string {
	return /^[A-Za-z0-9_-]+$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/** The pair with scalar key `key` in `map`, if any. */
export function pairOf(map: YAMLMap, key: string): Pair | undefined {
	return map.items.find((p) => isPair(p) && isScalar(p.key) && p.key.value === key);
}

/**
 * A scalar's text: a string as is; a number or boolean as its source text (`label: 123` is
 * `"123"`, as Redpanda Connect reads it). None for anything else.
 */
export function scalarText(node: unknown): string | undefined {
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
export function labelOf(value: YAMLMap): string | undefined {
	const label = scalarText(pairOf(value, 'label')?.value);
	return label !== undefined && label !== '' ? label : undefined;
}
