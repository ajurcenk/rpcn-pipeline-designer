// Bloblang in a document (AD-14 amended, tickets 2.19–2.21). Pure: from the document text and a
// cursor offset, decide whether the cursor is in Bloblang (the value of a Bloblang field, or a
// `${! }` interpolation) and what to offer there: functions (expression positions), methods
// (after a dot, narrowed by a known type), names (`$`, `@`), and hover docs for the name under
// the cursor. The catalog itself is `./bloblangCatalog` (re-exported here).

import { isMap, isScalar, isSeq } from 'yaml';
import { BloblangCatalog, BloblangEntry, LiteralType } from './bloblangCatalog';
import type { ParsedYaml } from './yamlPath';

export * from './bloblangCatalog';

/**
 * Fields whose values are Bloblang: the same names as the injection grammar
 * (`syntaxes/bloblang.injection.tmLanguage.json`; a test keeps the two equal).
 */
export const BLOBLANG_FIELDS: readonly string[] = [
	'application_properties_map', 'args_mapping', 'bloblang', 'check', 'document_map', 'extract_tracing_map', 'fields_mapping',
	'filter_map', 'hint_map', 'inject_tracing_map', 'keys_mapping', 'mapping', 'metadata_mapping', 'mutation',
	'new_column_type_mapping', 'open_message_mapping', 'partition_keys_map', 'payload_mapping', 'request_map', 'result_map',
	'skip_on', 'tags_mapping', 'text_mapping', 'timestamp_mapping', 'value_map', 'vector_mapping',
];

/** The literal type of a Bloblang value that starts `source` (`"…"`, `[…]`, `{…}`, a number, true/false). */
export function literalTypeAtStart(source: string): LiteralType | undefined {
	const s = source.trimStart();
	if (s.startsWith('"')) {
		return 'string';
	}
	if (s.startsWith('[')) {
		return 'array';
	}
	if (s.startsWith('{')) {
		return 'object';
	}
	if (/^-?\d+(?:\.\d+)?(?![\w.])/.test(s)) {
		return 'number';
	}
	return /^(?:true|false)\b/.test(s) ? 'boolean' : undefined;
}

/**
 * The literal that ends right before the dot at the end of `raw` (the region source up to the
 * cursor, with `code` its blanked form): `"…".`, `[…].`, `{…}.`, `true.`. An index (`this.a[0].`)
 * or a block is not a literal.
 */
function literalBeforeDot(raw: string, code: string): LiteralType | undefined {
	let i = code.length - 1;
	while (i >= 0 && code[i] !== '.') {
		i--;
	}
	let j = i - 1;
	while (j >= 0 && /\s/.test(raw[j])) {
		j--; // skip spaces in the raw text (in `code` a whole string is spaces)
	}
	if (j < 0) {
		return undefined;
	}
	if (raw[j] === '"' && code[j] === ' ') {
		return 'string'; // the closing quote of a string (blanked in `code`)
	}
	if (/\b(?:true|false)$/.test(code.slice(0, j + 1))) {
		return 'boolean';
	}
	const close = code[j];
	if (close !== ']' && close !== '}') {
		return undefined;
	}
	const open = close === ']' ? '[' : '{';
	let depth = 0;
	for (let k = j; k >= 0; k--) {
		if (code[k] === close) {
			depth++;
		} else if (code[k] === open && --depth === 0) {
			// A literal starts an expression: after an operator, `(`, `,`, `:`, `=`, or the start.
			const before = code.slice(0, k).trimEnd();
			// After `if …` / `else` / `match …` a brace opens a block, not an object.
			if (close === '}' && /(?:\belse|\bif\b[^{}]*|\bmatch\b[^{}]*)$/.test(before)) {
				return undefined;
			}
			return before === '' || /[=(,:[{+\-*/%<>!&|?]$/.test(before) ? (close === ']' ? 'array' : 'object') : undefined;
		}
	}
	return undefined;
}

export type BloblangContext = {
	/** `method` after a dot, `variable` after `$`, `metadata` after `@`, `function` elsewhere. */
	readonly kind: 'function' | 'method' | 'variable' | 'metadata';
	/** The identifier typed so far, and where it starts. */
	readonly prefix: string;
	readonly start: number;
	/** After a dot on a plain path from `this` or `root` (`this.user.`): that path (ticket 2.20). */
	readonly receiver?: { readonly base: 'this' | 'root'; readonly path: readonly string[] };
	/** Start of the Bloblang region the cursor is in (for collecting names above it). */
	readonly regionStart?: number;
	/** After a dot on a literal (`"test".`): its type, to narrow the methods (2.21). */
	readonly literal?: LiteralType;
};

export interface Region {
	readonly start: number;
	readonly end: number;
	/** A YAML double-quoted scalar: `\"` in the source is a `"` in Bloblang. */
	readonly yamlDoubleQuoted?: boolean;
}

/** The Bloblang regions of the document: Bloblang field values and `${! }` interpolations. */
export function bloblangRegions(parsed: ParsedYaml, text: string): readonly Region[] {
	return regions(parsed, text);
}

function regions(parsed: ParsedYaml, text: string): Region[] {
	const out: Region[] = [];
	const fields = new Set(BLOBLANG_FIELDS);
	const visit = (node: unknown): void => {
		if (isMap(node)) {
			for (const pair of node.items) {
				const v = pair.value;
				if (isScalar(pair.key) && fields.has(String(pair.key.value)) && isScalar(v) && v.range && typeof v.value === 'string') {
					const quoted = v.type === 'QUOTE_DOUBLE' || v.type === 'QUOTE_SINGLE';
					const block = v.type === 'BLOCK_LITERAL' || v.type === 'BLOCK_FOLDED';
					// A block starts after its header line; a quoted value inside its quotes.
					const start = block ? text.indexOf('\n', v.range[0]) + 1 || v.range[1] : v.range[0] + (quoted ? 1 : 0);
					out.push({ start, end: v.range[1] - (quoted ? 1 : 0), yamlDoubleQuoted: v.type === 'QUOTE_DOUBLE' });
				}
				visit(v);
			}
		} else if (isSeq(node)) {
			node.items.forEach(visit);
		}
	};
	parsed.docs.forEach((doc) => visit(doc.contents));
	// `${! … }`: to its matching `}` by brace depth, never past the end of its line.
	for (let i = text.indexOf('${!'); i >= 0; i = text.indexOf('${!', i + 3)) {
		let depth = 0;
		let j = i + 3;
		for (; j < text.length && text[j] !== '\n'; j++) {
			if (text[j] === '{') {
				depth++;
			} else if (text[j] === '}') {
				if (depth === 0) {
					break;
				}
				depth--;
			}
		}
		out.push({ start: i + 3, end: j });
	}
	return out;
}

/** Bloblang code of `source` with strings and comments blanked (same length, newlines kept). */
export function bloblangCode(source: string): string {
	return codeOf(source).code;
}

/**
 * Blanks Bloblang comments and string literals in `source` (from a region's start to the cursor)
 * so they cannot look like code, and says whether the end is inside one. Strings end at their
 * line, triple-quoted ones may span lines; comments run to the end of their line.
 */
function codeOf(source: string): { code: string; inString: boolean } {
	let code = '';
	let state: 'code' | 'string' | 'triple' | 'comment' = 'code';
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === '\n') {
			if (state !== 'triple') {
				state = 'code';
			}
			code += c;
			continue;
		}
		if (state === 'comment') {
			code += ' ';
		} else if (state === 'triple') {
			if (source.startsWith('"""', i)) {
				state = 'code';
				code += '   ';
				i += 2;
			} else {
				code += ' ';
			}
		} else if (state === 'string') {
			if (c === '\\') {
				code += ' ';
				i++;
				if (i < source.length && source[i] !== '\n') {
					code += ' ';
				} else {
					i--;
				}
			} else {
				if (c === '"') {
					state = 'code';
				}
				code += ' ';
			}
		} else if (source.startsWith('"""', i)) {
			state = 'triple';
			code += '   ';
			i += 2;
		} else if (c === '"') {
			state = 'string';
			code += ' ';
		} else if (c === '#') {
			state = 'comment';
			code += ' ';
		} else {
			code += c;
		}
	}
	return { code, inString: state !== 'code' };
}

/** The region's source up to `offset`, with YAML double-quote escapes turned into Bloblang text. */
function sourceUpTo(text: string, region: Region, offset: number): string {
	const raw = text.slice(region.start, offset);
	return region.yamlDoubleQuoted ? raw.replace(/\\(["\\])/g, ' $1') : raw;
}

/** Where the cursor is in Bloblang, if it is. Never throws. */
export function bloblangContext(parsed: ParsedYaml | undefined, text: string, offset: number): BloblangContext | undefined {
	try {
		const region = parsed && regions(parsed, text).find((r) => offset >= r.start && offset <= r.end);
		if (!region) {
			return undefined;
		}
		const scanned = codeOf(sourceUpTo(text, region, offset));
		if (scanned.inString) {
			return undefined; // inside a string literal or a comment
		}
		const code = scanned.code.slice(scanned.code.lastIndexOf('\n') + 1);
		const m = /([A-Za-z_][\w]*)?$/.exec(code)!;
		const prefix = m[1] ?? '';
		const before = code.slice(0, code.length - prefix.length).trimEnd();
		const sigil = /([@$])([\w]*)$/.exec(code);
		if (sigil) {
			// `$name` and `@name` (ticket 2.20); `meta("x")`-style keys are not tracked here.
			return { kind: sigil[1] === '$' ? 'variable' : 'metadata', prefix: sigil[2], start: offset - sigil[2].length, regionStart: region.start };
		}
		if (/\d\.$/.test(before)) {
			return undefined; // a decimal point
		}
		if (!before.endsWith('.')) {
			return { kind: 'function', prefix, start: offset - prefix.length, regionStart: region.start };
		}
		const chain = /(?:^|[^\w.$@])(this|root)((?:\.[A-Za-z_]\w*)*)\.$/.exec(before);
		const receiver = chain ? { base: chain[1] as 'this' | 'root', path: chain[2].split('.').filter(Boolean) } : undefined;
		const raw = sourceUpTo(text, region, offset);
		const literal = receiver ? undefined : literalBeforeDot(raw.slice(0, raw.length - prefix.length), scanned.code.slice(0, scanned.code.length - prefix.length));
		return { kind: 'method', prefix, start: offset - prefix.length, regionStart: region.start,
			...(receiver ? { receiver } : {}), ...(literal ? { literal } : {}) };
	} catch {
		return undefined;
	}
}

/** The entries to offer for `context`, deprecated ones last. */
export function bloblangItems(catalog: BloblangCatalog, context: BloblangContext): BloblangEntry[] {
	if (context.kind === 'variable' || context.kind === 'metadata') {
		return [];
	}
	const list = context.kind === 'method' ? catalog.methods : catalog.functions;
	return [...list].sort((a, b) => Number(a.status === 'deprecated') - Number(b.status === 'deprecated'));
}

/** The function or method named at `offset` in Bloblang, for hover; with its range. */
export function bloblangHoverAt(
	catalog: BloblangCatalog, parsed: ParsedYaml | undefined, text: string, offset: number,
): { readonly entry: BloblangEntry; readonly start: number; readonly end: number } | undefined {
	try {
		const region = parsed && regions(parsed, text).find((r) => offset >= r.start && offset <= r.end);
		if (!region) {
			return undefined;
		}
		let start = offset;
		let end = offset;
		while (start > 0 && /\w/.test(text[start - 1])) {
			start--;
		}
		while (end < text.length && /\w/.test(text[end])) {
			end++;
		}
		const name = text.slice(start, end);
		if (!name || !/^\s*\(/.test(text.slice(end))) {
			return undefined;
		}
		const scanned = codeOf(sourceUpTo(text, region, start));
		if (scanned.inString) {
			return undefined;
		}
		const isMethod = /\.\s*$/.test(scanned.code);
		const entry = (isMethod ? catalog.methods : catalog.functions).find((e) => e.name === name);
		return entry ? { entry, start, end } : undefined;
	} catch {
		return undefined;
	}
}
