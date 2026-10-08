// Completion where Red Hat 1.24.0 returns none (AD-11 amended, ticket 2.16). Pure: from the
// document text, a cursor offset and the served schema, decide whether the cursor is in one of
// the gaps the 2026-10-07 probes found, and build the items:
//   - an empty block inside a component (`socket:` with nothing under it, `socket.tls:`), or a
//     partly typed first key in one → the fields of that block;
//   - an empty value inside a component (`network: `) → the field's options, or true/false.
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

		if (!/^\s*([A-Za-z_][\w-]*)?$/.test(before)) {
			return undefined;
		}
		const indent = before.length - before.trimStart().length;
		const parent = pairs
			.filter((p) => p.keyStart < lineStart && column(lineStarts, p.keyStart) < indent
				&& (isEmpty(p.value) || startsOnLine(p.value, lineStart, lineEnd))
				&& onlyBlankBetween(text, lineStarts, p.keyStart, line))
			.sort((a, b) => b.keyStart - a.keyStart)[0];
		// Below the top level only: Red Hat completes empty top-level blocks itself.
		return parent && parent.path.length > 0
			? { kind: 'block', path: [...parent.path, parent.key], partial: before.trim() !== '' }
			: undefined;
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

/** `name: ${1:default}` (no placeholder for an empty default), `name:\n  $0` (object) or `name:\n  - $0` (array). */
function fieldSnippet(info: FieldInfo): string {
	const name = escapeSnippet(info.name);
	switch (info.shape) {
		case 'object':
			return `${name}:\n  $0`;
		case 'array':
			return `${name}:\n  - $0`;
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
