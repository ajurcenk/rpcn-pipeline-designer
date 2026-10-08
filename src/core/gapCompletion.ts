// Completion where Red Hat 1.24.0 returns none (AD-11 amended, ticket 2.16). Pure: from the
// document text, a cursor offset and the served schema, decide whether the cursor is in one of
// the gaps the 2026-10-07 probes found, and build the items:
//   - an empty block inside a component (`socket:` with nothing under it, `socket.tls:`), or a
//     partly typed first key in one → the fields of that block;
//   - an empty value inside a component (`network: `) → the field's options, or true/false;
//   - an empty or partly typed list item inside a component (`switch` case `processors:` then
//     `- `) → the component names of a list of components, or the fields of a list of objects
//     (ticket 2.18).
// Everywhere else (top-level blocks, plain nested blocks such as `logger.file:`, blocks that
// already have a field, list items, values outside components) Red Hat completes, so this
// returns nothing and the lists never overlap (a sweep of Red Hat's server over 1039 positions).

import { isMap, isScalar, isSeq, Scalar } from 'yaml';
import type { JsonObject } from './schema';
import { fieldInfo, FieldInfo, fieldsAt, insideComponent, requiredFieldsAt } from './schemaFields';
import { ParsedYaml, PathStep, yamlString } from './yamlPath';

export type GapContext =
	/** The cursor is in the empty block at `path`; `partial` when a first key is partly typed. */
	| { readonly kind: 'block'; readonly path: readonly PathStep[]; readonly partial: boolean }
	/** The cursor is on the empty (or partly typed) list item at `path` (its last step is the index). */
	| { readonly kind: 'item'; readonly path: readonly PathStep[]; readonly partial: boolean }
	/** The cursor is on the empty value of `key` in the mapping at `path`. */
	| { readonly kind: 'value'; readonly path: readonly PathStep[]; readonly key: string };

export interface GapItem {
	readonly label: string;
	/** `required`: all required fields of the block at once (ticket 2.17). */
	readonly kind: 'field' | 'value' | 'required';
	/** VS Code snippet syntax. */
	readonly snippet: string;
	readonly documentation?: string;
	readonly deprecated?: boolean;
}

interface PairInfo {
	readonly path: readonly PathStep[];
	readonly key: string;
	readonly keyStart: number;
	readonly value: unknown;
}

/** Where the cursor at `offset` is, if it is in a gap. Never throws. */
export function gapContext(parsed: ParsedYaml | undefined, text: string, offset: number): GapContext | undefined {
	const slot = slotAt(parsed, text, offset);
	// Below the top level only: Red Hat completes empty top-level blocks itself.
	return slot && slot.kind !== 'root' && !(slot.kind === 'block' && slot.path.length === 1) ? slot : undefined;
}

/** A gap context, or the top level of the document (a line at column 0 with no parent key). */
export type Slot = GapContext | { readonly kind: 'root'; readonly partial: boolean };

/**
 * Where the cursor is, at any depth (snippets, ticket 2.10): a value, a list item, an empty
 * block (`path` is the block's own path, `['input']` for a top-level `input:`), or the top level.
 * Never throws.
 */
export function slotAt(parsed: ParsedYaml | undefined, text: string, offset: number): Slot | undefined {
	try {
		if (!parsed) {
			return undefined;
		}
		const lineStarts = parsed.lineCounter.lineStarts;
		let line = 0; // 0-based
		while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) {
			line++;
		}
		const lineStart = lineStarts[line];
		const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
		const lineText = text.slice(lineStart, lineEnd).replace(/\r$/, '');
		const before = lineText.slice(0, offset - lineStart);
		const after = lineText.slice(offset - lineStart);
		// A tab in the indentation would make inserted keys invalid YAML.
		if (after.trim() !== '' || before.includes('\t')) {
			return undefined;
		}
		const pairs = allPairs(parsed);

		const valueMatch = /^\s*(?:-\s+)*([^\s#'"{[][^:#]*?)\s*:\s+$/.exec(before);
		if (valueMatch) {
			const key = valueMatch[1];
			const pair = pairs.find((p) => p.key === key && p.keyStart >= lineStart && p.keyStart < lineEnd && isEmpty(p.value));
			return pair ? { kind: 'value', path: pair.path, key } : undefined;
		}

		const itemMatch = /^\s*-\s+([A-Za-z_][\w-]*)?$/.exec(before) ?? /^\s*-$/.exec(before);
		if (itemMatch) {
			const item = allItems(parsed).find((i) => i.start >= lineStart && i.start <= lineEnd
				&& (isEmpty(i.value) || startsOnLine(i.value, lineStart, lineEnd)));
			return item ? { kind: 'item', path: item.path, partial: !!itemMatch[1] } : undefined;
		}

		if (!/^\s*([A-Za-z_][\w-]*)?$/.test(before)) {
			return undefined;
		}
		const indent = before.length - before.trimStart().length;
		const partial = before.trim() !== '';
		const parent = pairs
			.filter((p) => p.keyStart < lineStart && column(lineStarts, p.keyStart) < indent
				&& (isEmpty(p.value) || startsOnLine(p.value, lineStart, lineEnd))
				&& onlyBlankBetween(text, lineStarts, p.keyStart, line))
			.sort((a, b) => b.keyStart - a.keyStart)[0];
		if (parent) {
			return { kind: 'block', path: [...parent.path, parent.key], partial };
		}
		return indent === 0 ? { kind: 'root', partial } : undefined;
	} catch {
		return undefined;
	}
}

/** The items for `context`; `[]` where Red Hat would complete or the schema cannot say. */
export function gapItems(schema: JsonObject, context: GapContext): GapItem[] {
	if (context.kind === 'value') {
		if (!insideComponent(schema, context.path)) {
			return [];
		}
		const info = fieldInfo(schema, context.path, context.key);
		if (!info) {
			return [];
		}
		if (info.options.length > 0) {
			return info.options.map((o) => ({ label: o.value, kind: 'value', snippet: escapeSnippet(yamlString(o.value)), documentation: o.description }));
		}
		return info.boolean ? ['true', 'false'].map((v) => ({ label: v, kind: 'value', snippet: v })) : [];
	}
	// Outside components Red Hat completes nested blocks itself (logger.file, http.cors, …).
	if (!insideComponent(schema, context.path)) {
		return [];
	}
	const fields = fieldsAt(schema, context.path);
	if (context.kind === 'item') {
		// A new list item: its key sits after `- `, so children go 4 columns past the dash's line.
		return (fields?.all ?? [])
			.map((name) => fieldInfo(schema, context.path, name))
			.filter((info): info is FieldInfo => info !== undefined && !info.deprecated)
			.map((info) => ({ label: info.name, kind: 'field', snippet: fieldSnippet(info, '    '), documentation: info.markdown }));
	}
	// A component-level mapping (its names are components) is left to Red Hat's component list.
	if (!fields || fields.components.length > 0) {
		return [];
	}
	const infos = fields.all
		.map((name) => fieldInfo(schema, context.path, name))
		.filter((info): info is FieldInfo => info !== undefined);
	const items: GapItem[] = infos.map((info) => ({
		label: info.name, kind: 'field', snippet: fieldSnippet(info), documentation: info.markdown, deprecated: info.deprecated,
	}));
	// The schema's list, minus deprecated fields: it is broader than lint's (list fields such as
	// `file.paths` are listed though lint accepts them empty), which makes a better scaffold.
	const required = context.partial ? [] : requiredFieldsAt(schema, context.path)
		.map((name) => infos.find((i) => i.name === name))
		.filter((info): info is FieldInfo => info !== undefined && !info.deprecated);
	if (required.length === 0) {
		return items;
	}
	const owner = [...context.path].reverse().find((s): s is string => typeof s === 'string') ?? '';
	return [{
		label: `${owner}: required fields`,
		kind: 'required',
		snippet: requiredSnippet(required),
		documentation: `Inserts the required fields: ${required.map((i) => `\`${i.name}\``).join(', ')}.`,
	}, ...items];
}

/**
 * All required fields, one per line, tab stops in order: options as a choice, a scalar default
 * as a placeholder, objects and arrays opened on an indented line (ticket 2.17).
 */
function requiredSnippet(infos: readonly FieldInfo[]): string {
	return infos.map((info, i) => {
		const stop = i + 1;
		const name = escapeSnippet(info.name);
		if (info.options.length > 0) {
			return `${name}: \${${stop}|${info.options.map((o) => escapeChoice(yamlString(o.value))).join(',')}|}`;
		}
		switch (info.shape) {
			case 'object':
				return `${name}:\n  $${stop}`;
			case 'array':
				return `${name}:\n  - $${stop}`;
			default:
				if (info.default === undefined || info.default === '') {
					return `${name}: $${stop}`;
				}
				return `${name}: \${${stop}:${escapeSnippet(typeof info.default === 'string' ? yamlString(info.default) : String(info.default), true)}}`;
		}
	}).join('\n');
}

/** Escapes a snippet choice value (`,`, `|`, `$`, `}`, `\`). */
function escapeChoice(text: string): string {
	return text.replace(/[,|$}\\]/g, (c) => `\\${c}`);
}

/**
 * `name: ${1:default}` (no placeholder for an empty default), `name:\n<indent>$0` (object) or
 * `name:\n<indent>- $0` (array). `indent` is relative to the line's own indentation: 2 in a
 * block, 4 after a list item's `- `.
 */
function fieldSnippet(info: FieldInfo, indent = '  '): string {
	const name = escapeSnippet(info.name);
	switch (info.shape) {
		case 'object':
			return `${name}:\n${indent}$0`;
		case 'array':
			return `${name}:\n${indent}- $0`;
		default: {
			if (info.default === undefined || info.default === '') {
				return `${name}: $0`;
			}
			const value = typeof info.default === 'string' ? yamlString(info.default) : String(info.default);
			return `${name}: \${1:${escapeSnippet(value, true)}}`;
		}
	}
}

/** Escapes snippet syntax: `$`, `\` and, inside a placeholder, `}`. */
function escapeSnippet(text: string, placeholder = false): string {
	return text.replace(placeholder ? /[$}\\]/g : /[$\\]/g, (c) => `\\${c}`);
}

function isEmpty(value: unknown): boolean {
	return value === null || value === undefined || (isScalar(value) && value.value === null && !(value as Scalar).source);
}

function startsOnLine(value: unknown, lineStart: number, lineEnd: number): boolean {
	return isScalar(value) && value.type === 'PLAIN' && !!value.range && value.range[0] >= lineStart && value.range[0] <= lineEnd;
}

function column(lineStarts: readonly number[], offset: number): number {
	let start = 0;
	for (const s of lineStarts) {
		if (s > offset) {
			break;
		}
		start = s;
	}
	return offset - start;
}

/** Whether every line after the key's line and before `line` is blank or a comment. */
function onlyBlankBetween(text: string, lineStarts: readonly number[], keyStart: number, line: number): boolean {
	let keyLine = 0;
	while (keyLine + 1 < lineStarts.length && lineStarts[keyLine + 1] <= keyStart) {
		keyLine++;
	}
	for (let l = keyLine + 1; l < line; l++) {
		const t = text.slice(lineStarts[l], l + 1 < lineStarts.length ? lineStarts[l + 1] : text.length).trim();
		if (t !== '' && !t.startsWith('#')) {
			return false;
		}
	}
	return keyLine < line;
}

/** Every list item, with its path (ending in its index) and start offset. */
function allItems(parsed: ParsedYaml): { readonly path: readonly PathStep[]; readonly start: number; readonly value: unknown }[] {
	const out: { path: PathStep[]; start: number; value: unknown }[] = [];
	const visit = (node: unknown, path: PathStep[]): void => {
		if (isMap(node)) {
			for (const pair of node.items) {
				if (isScalar(pair.key)) {
					visit(pair.value, [...path, String(pair.key.value)]);
				}
			}
		} else if (isSeq(node)) {
			node.items.forEach((item, i) => {
				const range = isScalar(item) || isMap(item) || isSeq(item) ? item.range : undefined;
				if (range) {
					out.push({ path: [...path, i], start: range[0], value: item });
				}
				visit(item, [...path, i]);
			});
		}
	};
	parsed.docs.forEach((doc) => visit(doc.contents, []));
	return out;
}

function allPairs(parsed: ParsedYaml): PairInfo[] {
	const out: PairInfo[] = [];
	const visit = (node: unknown, path: PathStep[]): void => {
		if (isMap(node)) {
			for (const pair of node.items) {
				if (isScalar(pair.key) && pair.key.range) {
					const key = String(pair.key.value);
					out.push({ path, key, keyStart: pair.key.range[0], value: pair.value });
					visit(pair.value, [...path, key]);
				}
			}
		} else if (isSeq(node)) {
			node.items.forEach((item, i) => visit(item, [...path, i]));
		}
	};
	parsed.docs.forEach((doc) => visit(doc.contents, []));
	return out;
}
