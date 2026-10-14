// The Bloblang test panel's pure view helpers (ticket 4.7): the output content as shown (pretty JSON,
// else verbatim) with the lines of each top-level field, the "Changed:" tags, and the input
// metadata rows as the `run` message's `meta`. No React, no host: the webview tests call them directly.

import type { BloblangChanges, InputMeta, JsonValue } from '../../../src/shared/bloblangProtocol';

/** One row of the input's Metadata table, as typed. */
export interface MetaRow {
	readonly key: string;
	readonly value: string;
}

/** The output content as the Content tab shows it. */
export interface ShownContent {
	/** The lines of the shown text. */
	readonly lines: readonly string[];
	/** For a JSON object: each top-level key's first and last line (0-based, inclusive) in `lines`. */
	readonly spans: ReadonlyMap<string, readonly [number, number]>;
}

const isObject = (v: unknown): v is Record<string, JsonValue> => typeof v === 'object' && v !== null && !Array.isArray(v);

function verbatim(content: string): ShownContent {
	return { lines: content.split('\n'), spans: new Map() };
}

/**
 * `content` pretty-printed with a 2-space indent when it parses as JSON and re-serialises to the
 * same compact text, else verbatim; for a JSON
 * object, the line span of each top-level key (its `"key": …` line through its value's last line).
 */
export function shownContent(content: string): ShownContent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return verbatim(content);
	}
	// Only a lossless round trip is pretty-printed: big integers, `1.0`, `1e2`, duplicate keys or
	// `\uXXXX` escapes would otherwise show something the mapping did not produce.
	if (JSON.stringify(parsed) !== content.trim()) {
		return verbatim(content);
	}
	const text = JSON.stringify(parsed, null, 2);
	const lines = text.split('\n');
	const spans = new Map<string, readonly [number, number]>();
	if (isObject(parsed)) {
		// JSON.stringify writes `{`, then each key's value (as many lines as the value alone takes), then `}`.
		let line = 1;
		for (const key of Object.keys(parsed)) {
			const height = JSON.stringify(parsed[key], null, 2).split('\n').length;
			spans.set(key, [line, line + height - 1]);
			line += height;
		}
	}
	return { lines, spans };
}

/** The 0-based lines of `shown` that belong to the given top-level keys. */
export function markedLines(shown: ShownContent, keys: readonly string[]): ReadonlySet<number> {
	const marked = new Set<number>();
	for (const key of keys) {
		const span = shown.spans.get(key);
		if (span) {
			for (let i = span[0]; i <= span[1]; i++) {
				marked.add(i);
			}
		}
	}
	return marked;
}

/** One tag of the output's "Changed:" footer. */
export interface ChangeTag {
	readonly kind: 'added' | 'changed' | 'removed';
	readonly text: string;
}

const SIGN = { added: '+', changed: '~', removed: '−' } as const;

/**
 * The footer's tags: the fields' then the metadata's (keys prefixed `@`), each as added (`+`),
 * changed (`~`), removed (`−`). `changes.fields === null` gives no field tags.
 */
export function changeTags(changes: BloblangChanges): ChangeTag[] {
	const tags: ChangeTag[] = [];
	for (const [group, prefix] of [[changes.fields, ''], [changes.meta, '@']] as const) {
		if (!group) {
			continue;
		}
		for (const kind of ['added', 'changed', 'removed'] as const) {
			for (const key of group[kind]) {
				tags.push({ kind, text: `${SIGN[kind]}${prefix}${key}` });
			}
		}
	}
	return tags;
}

/** The rows as the `run` message's metadata: rows with an empty key are left out; a repeated key's last row wins. */
export function inputMeta(rows: readonly MetaRow[]): InputMeta {
	const map = new Map<string, string>();
	for (const row of rows) {
		if (row.key !== '') {
			map.delete(row.key);
			map.set(row.key, row.value);
		}
	}
	return Object.fromEntries(map);
}

/** How many rows have a non-empty key (the Metadata tab's count). */
export function metaRowCount(rows: readonly MetaRow[]): number {
	return rows.filter((r) => r.key !== '').length;
}

/** A metadata value as the output table shows it: a string raw, anything else as JSON. */
export function metaValueText(value: JsonValue): string {
	return typeof value === 'string' ? value : JSON.stringify(value);
}
