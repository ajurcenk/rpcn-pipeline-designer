// The Bloblang function and method catalog (AD-14 amended, ticket 2.19; split out in 2.12). Pure:
// built from the binary's `list --format json-full` docs (`bloblang-functions`,
// `bloblang-methods`) and kept in the served schema under `x-rpcn-bloblang`, so it always matches
// the user's version; with the docs and snippet text for an entry, and the methods that apply to
// a statically known type (2.21).

import type { JsonObject, JsonValue } from './schema';

/** Key under which the transform stores the catalog in the served schema. */
export const BLOBLANG_KEY = 'x-rpcn-bloblang';

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
	/** Every category the docs give (methods can have several, e.g. `contains`). */
	readonly categories?: readonly string[];
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
			...(categories.length > 0 ? { categories: categories as string[] } : {}),
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

/** The type of a value whose type is known statically: a literal, or a field assigned one (2.21). */
export type LiteralType = 'string' | 'number' | 'boolean' | 'array' | 'object';

/** Method categories that apply to each type; `General` and `Type Coercion` apply to all. */
const TYPE_CATEGORIES: Record<LiteralType, readonly string[]> = {
	string: ['String Manipulation', 'Regular Expressions', 'Parsing', 'Encoding and Encryption', 'JSON Web Tokens', 'Timestamp Manipulation', 'GeoIP'],
	number: ['Number Manipulation', 'Timestamp Manipulation'],
	boolean: [],
	array: ['Object & Array Manipulation', 'Parsing', 'SQL'],
	object: ['Object & Array Manipulation', 'Parsing'],
};
const ANY_TYPE = ['General', 'Type Coercion'];

/** The methods that apply to `type` (by the docs' categories); all methods when `type` is unknown. */
export function methodsFor(catalog: BloblangCatalog, type: LiteralType | undefined): readonly BloblangEntry[] {
	if (!type) {
		return catalog.methods;
	}
	const allowed = new Set([...TYPE_CATEGORIES[type], ...ANY_TYPE]);
	return catalog.methods.filter((m) => (m.categories ?? (m.category ? [m.category] : [])).some((c) => allowed.has(c)));
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
