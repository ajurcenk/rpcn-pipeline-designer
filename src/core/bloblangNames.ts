// Names a Bloblang author has already written (ticket 2.20). Pure and static: from the Bloblang
// above the cursor (earlier regions in document order, and the current region up to the cursor's
// line), collect the fields assigned (`root.a.b =`, `this.a =`, a bare `a.b =`, object-literal
// keys of `root.x = {"k": …}`) and read (`this.a.b`, `root.a`), the `let` variables and the
// metadata keys (`meta k =`, `@k`). It knows what the config writes, not what messages contain.

import { bloblangCode, bloblangRegions, BloblangContext } from './bloblang';
import type { ParsedYaml } from './yamlPath';

export type NameOrigin = 'set' | 'set-earlier' | 'read';

export interface KnownField {
	readonly path: readonly string[];
	/** 1-based line where it was first seen with this origin. */
	readonly line: number;
	readonly origin: NameOrigin;
}

export interface KnownName {
	readonly name: string;
	readonly line: number;
	readonly origin: NameOrigin;
}

export interface KnownNames {
	readonly fields: readonly KnownField[];
	readonly variables: readonly KnownName[];
	readonly metadata: readonly KnownName[];
}

const KEYWORDS = new Set(['let', 'meta', 'if', 'else', 'match', 'map', 'import', 'from', 'root', 'this', 'true', 'false', 'null']);
const IDENT = '[A-Za-z_]\\w*';
const PATH = `${IDENT}(?:\\.${IDENT})*`;

/** 1-based line of `offset`. */
function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) {
		line++;
	}
	return line;
}

/** Top-level `"key":` / `key:` names of the `{ … }` object literal starting at `open` in `source`. */
function objectKeys(source: string, open: number): string[] {
	const keys: string[] = [];
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const c = source[i];
		if (c === '{') {
			depth++;
		} else if (c === '}') {
			if (--depth === 0) {
				break;
			}
		} else if (depth === 1) {
			const m = /^(?:"([^"\\]+)"|([A-Za-z_]\w*))\s*:(?!:)/.exec(source.slice(i));
			if (m && /[{,\s]/.test(source[i - 1] ?? '{')) {
				keys.push(m[1] ?? m[2]);
				i += m[0].length - 1;
			}
		}
	}
	return keys;
}

/** The names written above `context` (its region up to the cursor's line, and earlier regions). */
export function knownNames(parsed: ParsedYaml | undefined, text: string, offset: number, context: BloblangContext): KnownNames {
	const fields: KnownField[] = [];
	const variables: KnownName[] = [];
	const metadata: KnownName[] = [];
	if (!parsed) {
		return { fields, variables, metadata };
	}
	const cursorLineStart = text.lastIndexOf('\n', offset - 1) + 1;
	const regions = [...bloblangRegions(parsed, text)].filter((r) => r.start < offset).sort((a, b) => a.start - b.start);
	for (const region of regions) {
		const current = region.start === context.regionStart;
		const end = current ? Math.min(region.end, cursorLineStart) : region.end;
		if (end <= region.start) {
			continue;
		}
		const source = text.slice(region.start, end);
		const code = bloblangCode(source);
		const lineAt = (i: number) => lineOf(text, region.start + i);
		const set: NameOrigin = current ? 'set' : 'set-earlier';
		// Statements: one per line start (Bloblang assignments start a line).
		const statement = new RegExp(`^[ \\t]*(?:(let)\\s+(${IDENT})|(meta)\\s+(${IDENT})|@(${IDENT})|(?:(?:root|this)(?:\\.(${PATH}))?|(${PATH})))\\s*=(?![=>])`, 'gm');
		for (let m = statement.exec(code); m; m = statement.exec(code)) {
			const at = lineAt(m.index);
			if (m[1]) {
				variables.push({ name: m[2], line: at, origin: set });
				continue;
			}
			if (m[3] || m[5]) {
				metadata.push({ name: m[4] ?? m[5], line: at, origin: set });
				continue;
			}
			const target = m[6] ?? m[7];
			const path = target ? target.split('.') : [];
			if (m[7] && KEYWORDS.has(path[0])) {
				continue;
			}
			if (path.length > 0) {
				fields.push({ path, line: at, origin: set });
			}
			// `root.x = { "k": … }`: the literal's keys are fields under that path.
			const rhs = code.slice(m.index + m[0].length);
			const brace = /^\s*\{/.exec(rhs);
			if (brace) {
				const open = m.index + m[0].length + brace[0].length - 1;
				for (const key of objectKeys(source, open)) {
					fields.push({ path: [...path, key], line: at, origin: set });
				}
			}
		}
		// Reads: `this.a.b` / `root.a`, stopping before a method call.
		const read = new RegExp(`(?<![\\w.$@])(?:this|root)((?:\\.${IDENT})+)`, 'g');
		for (let m = read.exec(code); m; m = read.exec(code)) {
			let path = m[1].split('.').filter(Boolean);
			if (/^\s*\(/.test(code.slice(m.index + m[0].length))) {
				path = path.slice(0, -1); // the last segment is a method
			}
			if (path.length > 0) {
				fields.push({ path, line: lineAt(m.index), origin: 'read' });
			}
		}
		for (const m of code.matchAll(new RegExp(`\\$(${IDENT})`, 'g'))) {
			variables.push({ name: m[1], line: lineAt(m.index ?? 0), origin: 'read' });
		}
		for (const m of code.matchAll(new RegExp(`@(${IDENT})`, 'g'))) {
			metadata.push({ name: m[1], line: lineAt(m.index ?? 0), origin: 'read' });
		}
	}
	return { fields, variables, metadata };
}

const RANK: Record<NameOrigin, number> = { 'set': 0, 'set-earlier': 1, 'read': 2 };

export interface NameSuggestion {
	readonly name: string;
	readonly line: number;
	readonly origin: NameOrigin;
	/** For fields: the full path, for the item's docs. */
	readonly path?: readonly string[];
	/** For fields: whether deeper fields are known under it. */
	readonly hasChildren?: boolean;
}

/** The next path segments known under `receiverPath`, best origin first, one per name. */
export function fieldSuggestions(names: KnownNames, receiverPath: readonly string[]): NameSuggestion[] {
	const best = new Map<string, NameSuggestion>();
	const children = new Set<string>();
	for (const f of names.fields) {
		if (f.path.length <= receiverPath.length || !receiverPath.every((s, i) => f.path[i] === s)) {
			continue;
		}
		const name = f.path[receiverPath.length];
		if (f.path.length > receiverPath.length + 1) {
			children.add(name);
		}
		const prev = best.get(name);
		if (!prev || RANK[f.origin] < RANK[prev.origin]) {
			best.set(name, { name, line: f.line, origin: f.origin, path: [...receiverPath, name] });
		}
	}
	return [...best.values()].map((s) => ({ ...s, hasChildren: children.has(s.name) }))
		.sort((a, b) => RANK[a.origin] - RANK[b.origin] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The known variables or metadata keys, best origin first, one per name. */
export function nameSuggestions(list: readonly KnownName[]): NameSuggestion[] {
	const best = new Map<string, KnownName>();
	for (const n of list) {
		const prev = best.get(n.name);
		if (!prev || RANK[n.origin] < RANK[prev.origin]) {
			best.set(n.name, n);
		}
	}
	return [...best.values()].sort((a, b) => RANK[a.origin] - RANK[b.origin] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** "assigned on line 23" / "set by an earlier step, line 17" / "read on line 9". */
export function originText(s: NameSuggestion): string {
	switch (s.origin) {
		case 'set':
			return `assigned on line ${s.line}`;
		case 'set-earlier':
			return `set by an earlier step, line ${s.line}`;
		case 'read':
			return `read on line ${s.line}`;
	}
}
