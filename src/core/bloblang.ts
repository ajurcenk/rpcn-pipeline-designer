// Bloblang functions and methods (AD-14 amended, ticket 2.19). Pure: the catalog is built from the
// binary's `list --format json-full` docs (`bloblang-functions`, `bloblang-methods`) and kept in
// the served schema under `x-rpcn-bloblang`, so it always matches the user's version. From the
// document text and a cursor offset, decide whether the cursor is in Bloblang (the value of a
// Bloblang field, or a `${! }` interpolation) and offer functions (expression positions) or
// methods (after a dot), and hover docs for the name under the cursor.

import { isMap, isScalar, isSeq } from 'yaml';
import type { JsonObject, JsonValue } from './schema';
import type { ParsedYaml } from './yamlPath';

/** Key under which the transform stores the catalog in the served schema. */
export const BLOBLANG_KEY = 'x-rpcn-bloblang';

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

export interface BloblangParam {
	readonly name: string;
	readonly type?: string;
	readonly description?: string;
	/** No default and not optional: the snippet gets a placeholder for it. */
	readonly required: boolean;
}

export interface BloblangEntry {
	readonly name: string;
	readonly kind: 'function' | 'method';
	readonly status: string;
	readonly category?: string;
	readonly description?: string;
	readonly params: readonly BloblangParam[];
	/** Takes any number of arguments (`format`, `concat`, …); the docs list none by name. */
	readonly variadic?: boolean;
	/** The first example mapping, trimmed. */
	readonly example?: string;
}

export interface BloblangCatalog {
	readonly functions: readonly BloblangEntry[];
	readonly methods: readonly BloblangEntry[];
}

const MAX_EXAMPLE_LINES = 8;

const str = (v: JsonValue | undefined): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const obj = (v: JsonValue | undefined): JsonObject | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);

function entriesOf(list: JsonValue | undefined, kind: 'function' | 'method'): BloblangEntry[] {
	if (!Array.isArray(list)) {
		return [];
	}
	const out: BloblangEntry[] = [];
	for (const raw of list) {
		const e = obj(raw);
		const name = str(e?.name);
		if (!e || !name || e.status === 'hidden') {
			continue;
		}
		const named = obj(e.params)?.named;
		const params = (Array.isArray(named) ? named : []).map(obj).filter((p): p is JsonObject => !!p && !!str(p.name))
			.map((p) => ({ name: str(p.name)!, type: str(p.type), description: str(p.description),
				required: p.default === undefined && p.is_optional !== true }));
		const categories = Array.isArray(e.categories) ? e.categories.map((c) => str(obj(c)?.Category) ?? str(c)).filter(Boolean) : [];
		const examples = Array.isArray(e.examples) ? e.examples : [];
		const variadic = obj(e.params)?.variadic === true;
		const mapping = str(obj(examples[0])?.mapping);
		out.push({
			name, kind, status: str(e.status) ?? 'stable', category: str(e.category) ?? categories[0],
			description: plainText(str(e.description)), params, ...(variadic ? { variadic } : {}),
			example: mapping?.split('\n').slice(0, MAX_EXAMPLE_LINES).join('\n'),
		});
	}
	return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** AsciiDoc cross-references (`<<id, text>>`, `<<id>>`) as plain text, for Markdown hovers. */
function plainText(text: string | undefined): string | undefined {
	return text?.replace(/<<([^,>]+),\s*([^>]+)>>/g, '$2').replace(/<<([^>]+)>>/g, '$1');
}

/** The catalog from json-full docs, as plain JSON for the served schema. Hidden entries are left out. */
export function bloblangCatalogFromDocs(docs: JsonObject): JsonObject {
	const catalog: BloblangCatalog = {
		functions: entriesOf(docs['bloblang-functions'], 'function'),
		methods: entriesOf(docs['bloblang-methods'], 'method'),
	};
	return JSON.parse(JSON.stringify(catalog)) as JsonObject;
}

/** The catalog stored in a served schema, or `undefined`. */
export function bloblangCatalogOf(schema: JsonObject): BloblangCatalog | undefined {
	const c = obj(schema[BLOBLANG_KEY]);
	return c && Array.isArray(c.functions) && Array.isArray(c.methods) ? (c as unknown as BloblangCatalog) : undefined;
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
		return { kind: 'method', prefix, start: offset - prefix.length, regionStart: region.start, ...(receiver ? { receiver } : {}) };
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

/**
 * `name(${1:p}, ${2:q})` for required parameters; `name($0)` when all are optional or the method
 * is variadic; `name()` without parameters; just the name when `(` already follows.
 */
export function bloblangSnippet(entry: BloblangEntry, parenFollows = false): string {
	if (parenFollows) {
		return entry.name;
	}
	const required = entry.params.filter((p) => p.required);
	if (required.length === 0) {
		return entry.params.length > 0 || entry.variadic ? `${entry.name}($0)` : `${entry.name}()`;
	}
	return `${entry.name}(${required.map((p, i) => `\${${i + 1}:${p.name.replace(/[$}\\]/g, (c) => `\\${c}`)}}`).join(', ')})`;
}

/** Markdown docs: description, parameters, an example. */
export function bloblangMarkdown(entry: BloblangEntry): string {
	const parts: string[] = [];
	const status = entry.status !== 'stable' ? ` (${entry.status})` : '';
	parts.push(`**${entry.name}**${entry.kind === 'method' ? ' method' : ' function'}${status}${entry.category ? ` · ${entry.category}` : ''}`);
	if (entry.description) {
		parts.push(entry.description);
	}
	if (entry.params.length > 0) {
		parts.push(entry.params.map((p) => `- \`${p.name}\`${p.type ? ` (${p.type})` : ''}${p.required ? '' : ', optional'}${p.description ? `: ${p.description}` : ''}`).join('\n'));
	}
	if (entry.example) {
		parts.push(`\`\`\`coffee\n${entry.example}\n\`\`\``);
	}
	return parts.join('\n\n');
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
