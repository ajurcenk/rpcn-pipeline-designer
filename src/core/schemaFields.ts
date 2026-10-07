// Pure schema walk (AD-20: component structure comes from the binary's schema). Given the
// transformed schema (AD-10) and a YAML path, returns the field names valid in the mapping at
// that path. Each step expands `$ref` (`#/definitions/<name>`), every `allOf` member and every
// `anyOf` branch, then takes `properties[<key>]` (or `items` for a sequence index). At a
// component mapping the names are the component names (keys of `anyOf` branches) plus the
// shared fields (`label`, `processors`, …); inside a component they are its fields. Name-keyed
// maps (`patternProperties`, e.g. `workflow.branches.<name>`) are not stepped through: no fix
// there (known limit, user 2026-10-07).

import { isJsonObject, JsonObject } from './schema';
import type { PathStep } from './yamlPath';

/** `$ref` / `allOf` / `anyOf` nesting followed per step; deeper is treated as unknown. */
const MAX_EXPAND_DEPTH = 8;

export interface FieldsAt {
	/** Every valid name, sorted. */
	readonly all: readonly string[];
	/** The subset that are component names (one per `anyOf` branch), sorted. */
	readonly components: readonly string[];
}

interface Expanded {
	readonly node: JsonObject;
	/** The node is a direct `anyOf` branch, so its property keys are component names. */
	readonly branch: boolean;
}

/** The names valid at `path`; `undefined` when the schema cannot say. */
export function fieldsAt(schema: JsonObject, path: readonly PathStep[]): FieldsAt | undefined {
	let nodes: JsonObject[] = [schema];
	for (const step of path) {
		nodes = nodes.flatMap((n) => expand(schema, n, false, 0)).flatMap(({ node }) => {
			const next = typeof step === 'number' ? node.items : isJsonObject(node.properties) ? node.properties[step] : undefined;
			return isJsonObject(next) ? [next] : [];
		});
		if (nodes.length === 0) {
			return undefined;
		}
	}
	const all = new Set<string>();
	const components = new Set<string>();
	for (const { node, branch } of nodes.flatMap((n) => expand(schema, n, false, 0))) {
		if (isJsonObject(node.properties)) {
			for (const k of Object.keys(node.properties)) {
				all.add(k);
				if (branch) {
					components.add(k);
				}
			}
		}
	}
	return all.size > 0 ? { all: [...all].sort(), components: [...components].sort() } : undefined;
}

/** The sorted names valid at `path`; `undefined` when the schema cannot say. */
export function validFieldsAt(schema: JsonObject, path: readonly PathStep[]): string[] | undefined {
	const fields = fieldsAt(schema, path);
	return fields ? [...fields.all] : undefined;
}

/**
 * The names to suggest for a key at `path` next to `siblings`. When a sibling already names a
 * component, only the shared fields are offered: a second component would still be invalid.
 */
export function candidateFields(schema: JsonObject, path: readonly PathStep[], siblings: readonly string[]): string[] | undefined {
	const fields = fieldsAt(schema, path);
	if (!fields) {
		return undefined;
	}
	const components = new Set(fields.components);
	return siblings.some((s) => components.has(s)) ? fields.all.filter((f) => !components.has(f)) : [...fields.all];
}

/**
 * The option values of field `key` in the mapping at `path`: the string `enum`s the 2.13
 * transform adds as value suggestions. `[]` when the field has none.
 */
export function optionsAt(schema: JsonObject, path: readonly PathStep[], key: string): string[] {
	let nodes: JsonObject[] = [schema];
	for (const step of [...path, key]) {
		nodes = nodes.flatMap((n) => expand(schema, n, false, 0)).flatMap(({ node }) => {
			const next = typeof step === 'number' ? node.items : isJsonObject(node.properties) ? node.properties[step] : undefined;
			return isJsonObject(next) ? [next] : [];
		});
		if (nodes.length === 0) {
			return [];
		}
	}
	const options = new Set<string>();
	for (const { node } of nodes.flatMap((n) => expand(schema, n, false, 0))) {
		if (Array.isArray(node.enum)) {
			node.enum.forEach((v) => {
				if (typeof v === 'string') {
					options.add(v);
				}
			});
		}
	}
	return [...options];
}

/** The node itself plus everything its `$ref`, `allOf` and `anyOf` lead to. */
function expand(schema: JsonObject, node: JsonObject, branch: boolean, depth: number): Expanded[] {
	if (depth > MAX_EXPAND_DEPTH) {
		return [];
	}
	const out: Expanded[] = [{ node, branch }];
	const ref = node.$ref;
	if (typeof ref === 'string' && ref.startsWith('#/definitions/')) {
		const definitions = schema.definitions;
		const target = isJsonObject(definitions) ? definitions[ref.slice('#/definitions/'.length)] : undefined;
		if (isJsonObject(target)) {
			out.push(...expand(schema, target, false, depth + 1));
		}
	}
	for (const combinator of ['allOf', 'anyOf'] as const) {
		const members = node[combinator];
		if (Array.isArray(members)) {
			for (const member of members) {
				if (isJsonObject(member)) {
					out.push(...expand(schema, member, combinator === 'anyOf', depth + 1));
				}
			}
		}
	}
	return out;
}
