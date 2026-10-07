// Pure YAML key lookup (AD-2: only src/core parses YAML, with `yaml` and a LineCounter). Finds
// the mapping key named `key` whose key token starts on a given line, in whichever YAML document
// contains it, and returns its path (from the document root to the mapping that holds it), its
// source range and its sibling keys. Block and flow mappings both count (user, 2026-10-07). Used
// by the unknown-field Quick Fix (2.5).

import { Document, isMap, isPair, isScalar, isSeq, LineCounter, parseAllDocuments, parse as parseYamlValue } from 'yaml';

/** A mapping key (string) or a sequence index (number). */
export type PathStep = string | number;

export interface KeyLocation {
	/** Steps from the document root to the mapping that holds the key. */
	readonly path: readonly PathStep[];
	/** UTF-16 offsets of the key token in the text, quotes included: `[start, end)`. */
	readonly start: number;
	readonly end: number;
	/** The other keys of that mapping. */
	readonly siblings: readonly string[];
}

/** A text parsed once, for several lookups. */
export interface ParsedYaml {
	readonly docs: readonly Document.Parsed[];
	readonly lineCounter: LineCounter;
	readonly length: number;
}

/** Parses all YAML documents in `text`; `undefined` if the parser gives up. Never throws. */
export function parseYaml(text: string): ParsedYaml | undefined {
	try {
		const lineCounter = new LineCounter();
		const parsed = parseAllDocuments(text, { lineCounter });
		return { docs: Array.isArray(parsed) ? parsed : [], lineCounter, length: text.length };
	} catch {
		return undefined;
	}
}

/**
 * Locates key `key` on 1-based `line`; `undefined` when there is none, when the line holds it
 * more than once (`{nope: {nope: 1}}`), or when the document has a parse error at or before the
 * key (recovery could give a wrong path). Never throws.
 */
export function findKeyOnLine(parsed: ParsedYaml | undefined, line: number, key: string): KeyLocation | undefined {
	try {
		const lineStart = parsed?.lineCounter.lineStarts[line - 1];
		if (!parsed || lineStart === undefined) {
			return undefined;
		}
		const lineEnd = parsed.lineCounter.lineStarts[line] ?? parsed.length + 1;
		const found: { location: KeyLocation; doc: Document.Parsed }[] = [];
		for (const doc of parsed.docs) {
			collect(doc.contents, [], key, lineStart, lineEnd, (location) => found.push({ location, doc }));
		}
		if (found.length !== 1) {
			return undefined;
		}
		const { location, doc } = found[0];
		return doc.errors.some((e) => e.pos[0] <= location.start) ? undefined : location;
	} catch {
		return undefined;
	}
}

export interface ValueLocation {
	/** Steps from the document root to the mapping that holds the pair. */
	readonly path: readonly PathStep[];
	/** The pair's key. */
	readonly key: string;
	/** UTF-16 offsets of the value token, quotes included: `[start, end)`. */
	readonly start: number;
	readonly end: number;
}

/**
 * Locates the scalar value `value` of a mapping pair whose value token starts on 1-based
 * `line` (ticket 2.14). Same rules as `findKeyOnLine`: none, ambiguous or after a parse error
 * at or before it → `undefined`. Never throws.
 */
export function findValueOnLine(parsed: ParsedYaml | undefined, line: number, value: string): ValueLocation | undefined {
	try {
		const lineStart = parsed?.lineCounter.lineStarts[line - 1];
		if (!parsed || lineStart === undefined) {
			return undefined;
		}
		const lineEnd = parsed.lineCounter.lineStarts[line] ?? parsed.length + 1;
		const found: { location: ValueLocation; doc: Document.Parsed }[] = [];
		for (const doc of parsed.docs) {
			collectValues(doc.contents, [], value, lineStart, lineEnd, (location) => found.push({ location, doc }));
		}
		if (found.length !== 1) {
			return undefined;
		}
		const { location, doc } = found[0];
		return doc.errors.some((e) => e.pos[0] <= location.start) ? undefined : location;
	} catch {
		return undefined;
	}
}

function collectValues(
	node: unknown, path: PathStep[], value: string, lineStart: number, lineEnd: number, report: (l: ValueLocation) => void,
): void {
	if (isMap(node)) {
		for (const pair of node.items) {
			if (!isPair(pair) || !isScalar(pair.key)) {
				continue;
			}
			const key = String(pair.key.value);
			const v = pair.value;
			// An anchored value is skipped: lint reports aliases at the anchor, and editing it changes every alias.
			if (isScalar(v) && v.range && !v.anchor && keyNames(v).includes(value) && v.range[0] >= lineStart && v.range[0] < lineEnd) {
				report({ path, key, start: v.range[0], end: v.range[1] });
			}
			collectValues(v, [...path, key], value, lineStart, lineEnd, report);
		}
	} else if (isSeq(node)) {
		for (const [i, item] of node.items.entries()) {
			collectValues(item, [...path, i], value, lineStart, lineEnd, report);
		}
	}
}

/**
 * `value` as YAML source for a plain string: as is when YAML reads it back as that exact string,
 * otherwise double-quoted (`OFF`, `no`, `1`, `a: b` …). Redpanda Connect reads YAML 1.2 (yaml.v3), but
 * the YAML 1.1 words are quoted too, so neither reading turns the option into a boolean.
 */
export function yamlString(value: string): string {
	const yaml11 = /^(y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|true|True|TRUE|false|False|FALSE|~|null|Null|NULL)$/;
	// Flow indicators (`,[]{}`) would break a flow mapping; a leading indicator (`%@` …) is not plain.
	if (yaml11.test(value) || value !== value.trim() || /[,[\]{}]/.test(value) || /^[%@`!&*|>'"#?:-]/.test(value)
		|| value.includes(': ') || value.includes(' #')) {
		return JSON.stringify(value);
	}
	try {
		if (parseYamlValue(value) === value) {
			return value;
		}
	} catch {
		// Not valid as a plain scalar: quote it.
	}
	return JSON.stringify(value);
}

/** Text of a scalar key as written (`0x1`) and as its value (`1`). */
function keyNames(node: unknown): string[] {
	if (!isScalar(node)) {
		return [];
	}
	const names = [String(node.value)];
	if (typeof node.source === 'string' && node.source !== names[0]) {
		names.push(node.source);
	}
	return names;
}

function collect(
	node: unknown, path: PathStep[], key: string, lineStart: number, lineEnd: number, report: (l: KeyLocation) => void,
): void {
	if (isMap(node)) {
		const keys = node.items.map((pair) => (isScalar(pair.key) ? String(pair.key.value) : undefined));
		for (const [i, pair] of node.items.entries()) {
			const k = pair.key;
			if (isScalar(k) && k.range && keyNames(k).includes(key) && k.range[0] >= lineStart && k.range[0] < lineEnd) {
				const siblings = keys.filter((s, j): s is string => s !== undefined && j !== i);
				report({ path, start: k.range[0], end: k.range[1], siblings });
			}
			const name = keys[i];
			if (name !== undefined) {
				collect(pair.value, [...path, name], key, lineStart, lineEnd, report);
			}
		}
	} else if (isSeq(node)) {
		for (const [i, item] of node.items.entries()) {
			collect(item, [...path, i], key, lineStart, lineEnd, report);
		}
	}
}
