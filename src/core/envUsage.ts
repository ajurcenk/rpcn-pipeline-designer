// Pure: the environment variables a config's text uses (ticket 31), for the Environment view's
// "Missing" group. Two forms, matching what the binary reads:
//   - `${NAME}` and `${NAME:default}` anywhere in the text (the binary replaces them in the raw
//     file, comments included, before parsing; `$${NAME}` is not an escape). A use with a default
//     (even an empty one) is never missing. The default's own `${…}` is not expanded, so it is not
//     a use. `${!…}` is a Bloblang interpolation, not a variable.
//   - Bloblang's `env("NAME")` / `env('NAME')` with a literal name (also with the quotes
//     backslash-escaped, as in a double-quoted YAML scalar). A computed name is not read.
// Only names a variable can have (`[A-Za-z_][A-Za-z0-9_]*`) are returned: no source can set another.

/**
 * The binary's own pattern for an env reference (`${NAME}` or `${NAME:default}`); shared with the
 * Cloud translation (`cloudTranslate.ts`). Global: use with `matchAll` or `replace` only.
 */
export const REFERENCE = /\$\{([0-9A-Za-z_.]+)(:(?:\$\{[^}]+\}|[^}])*)?\}/g;
/**
 * The source of `env(` and a quoted literal name (`"NAME"`, `'NAME'`, optionally with `\"` quotes):
 * group 1 the quote, group 2 the name. Shared with the Cloud translation (`cloudTranslate.ts`), which
 * builds its own pattern from it.
 */
export const ENV_LITERAL_CALL = String.raw`env\(\s*\\?(["'])([A-Za-z_][A-Za-z0-9_]*)\\?\1`;
/** `env("NAME")`, `env('NAME')`, optionally with `\"` quotes. Global, as `REFERENCE`. */
export const ENV_CALL = new RegExp(String.raw`\b${ENV_LITERAL_CALL}\s*\)`, 'g');
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface EnvUse {
	readonly name: string;
	/** Some use has no default, so the config needs the variable set. */
	readonly required: boolean;
}

/** The variables `text` uses, by first use, each once. Pure. */
export function envUsage(text: string): EnvUse[] {
	const uses = new Map<string, boolean>();
	const add = (name: string, required: boolean) => {
		if (NAME.test(name)) {
			uses.set(name, (uses.get(name) ?? false) || required);
		}
	};
	for (const match of text.matchAll(REFERENCE)) {
		add(match[1], match[2] === undefined);
	}
	for (const match of text.matchAll(ENV_CALL)) {
		add(match[2], true);
	}
	const order = new Map<string, number>();
	for (const match of text.matchAll(REFERENCE)) {
		if (!order.has(match[1])) {
			order.set(match[1], match.index ?? 0);
		}
	}
	for (const match of text.matchAll(ENV_CALL)) {
		const at = match.index ?? 0;
		if (!order.has(match[2]) || order.get(match[2])! > at) {
			order.set(match[2], at);
		}
	}
	return [...uses]
		.map(([name, required]) => ({ name, required }))
		.sort((a, b) => order.get(a.name)! - order.get(b.name)!);
}

/** One variable use in the text (ticket 34's hover). */
export interface EnvReference {
	readonly name: string;
	/** `${NAME:default}`'s default (possibly empty); `undefined` without one and for `env("NAME")`. */
	readonly default?: string;
	readonly form: 'reference' | 'call';
	/** The use's start offset (inclusive) and end offset (exclusive) in the text. */
	readonly start: number;
	readonly end: number;
}

/**
 * The variable use under `offset` (`start <= offset < end`), by the same rules as `envUsage`: a
 * `${NAME}` / `${NAME:default}` or an `env("NAME")` with a literal name a variable can have. Pure.
 */
export function envReferenceAt(text: string, offset: number): EnvReference | undefined {
	for (const match of text.matchAll(REFERENCE)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (offset >= start && offset < end) {
			return NAME.test(match[1])
				? { name: match[1], ...(match[2] !== undefined ? { default: match[2].slice(1) } : {}), form: 'reference', start, end }
				: undefined;
		}
		if (start > offset) {
			break;
		}
	}
	for (const match of text.matchAll(ENV_CALL)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (offset >= start && offset < end) {
			return { name: match[2], form: 'call', start, end };
		}
		if (start > offset) {
			break;
		}
	}
	return undefined;
}

// --- Ticket 46: the references a run stops on ---

/** A Cloud secret reference's prefix (`${secrets.NAME}`): only Redpanda Cloud sets it. */
export const CLOUD_SECRET_PREFIX = 'secrets.';

/** `${secrets.NAME}`'s name: no local source sets it, so a local run always stops on it. */
export function isCloudSecretName(name: string): boolean {
	return name.startsWith(CLOUD_SECRET_PREFIX);
}

/** One `${NAME}` without a default, with its range in the text. */
export interface RequiredReference {
	/** As the binary names it (any name its pattern takes: `secrets.A`, `a.b` and `1A` too). */
	readonly name: string;
	/** The reference's start offset (inclusive) and end offset (exclusive) in the text. */
	readonly start: number;
	readonly end: number;
}

/**
 * Every `${NAME}` without a default in `text`, in order, each use once: the references the binary
 * stops on (`required environment variables were not set`) when nothing sets the name. By the
 * binary's own rules (rpk connect 4.100.0 and 4.112.0, tested): in YAML comments too, `$${NAME}`
 * too (not an escape), any name its pattern takes; not `${NAME:}` or `${NAME:x}` (defaults), not
 * `${A:${B}}` (the default's own `${…}` is not expanded), not `${! … }` and not `env("NAME")`
 * (Bloblang, read when the mapping runs). Pure.
 */
export function requiredReferences(text: string): RequiredReference[] {
	const out: RequiredReference[] = [];
	for (const match of text.matchAll(REFERENCE)) {
		if (match[2] === undefined) {
			const start = match.index ?? 0;
			out.push({ name: match[1], start, end: start + match[0].length });
		}
	}
	return out;
}
