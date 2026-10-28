// Pure: the environment variables a config's text uses (ticket 31), for the Environment view's
// "Missing" group. Two forms, matching what the binary reads:
//   - `${NAME}` and `${NAME:default}` anywhere in the text (the binary replaces them in the raw
//     file, comments included, before parsing; `$${NAME}` is not an escape). A use with a default
//     (even an empty one) is never missing. The default's own `${…}` is not expanded, so it is not
//     a use. `${!…}` is a Bloblang interpolation, not a variable.
//   - Bloblang's `env("NAME")` / `env('NAME')` with a literal name (also with the quotes
//     backslash-escaped, as in a double-quoted YAML scalar). A computed name is not read.
// Only names a variable can have (`[A-Za-z_][A-Za-z0-9_]*`) are returned: no source can set another.

/** The binary's own pattern for an env reference (`${NAME}` or `${NAME:default}`). */
const REFERENCE = /\$\{([0-9A-Za-z_.]+)(:(?:\$\{[^}]+\}|[^}])*)?\}/g;
/** `env("NAME")`, `env('NAME')`, optionally with `\"` quotes. */
const ENV_CALL = /\benv\(\s*\\?(["'])([A-Za-z_][A-Za-z0-9_]*)\\?\1\s*\)/g;
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
