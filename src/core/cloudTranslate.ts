// Pure: the config text a Redpanda Cloud pipeline is sent (ticket 5.6). Cloud pipelines have no
// environment variables, only secrets, so each variable reference becomes a secret reference:
//   - `${NAME}` → `${secrets.NAME}`, `${NAME:default}` → `${secrets.NAME:default}` (the default kept),
//     by the binary's own rule (`REFERENCE` in `envUsage.ts`): anywhere in the text, comments
//     included; `$${NAME}` is not an escape, so it becomes `$${secrets.NAME}`.
//   - `${!…}` (Bloblang interpolation) and a name with a `.` are left as written. Only the reference
//     spans change; every other byte is kept, so the translation is idempotent.
//   - Bug 48: a `${secrets.NAME}` already written is a secret use as a translated one is (NAME listed,
//     once with the same name translated), and its NAME must be a secret id too.
// Refused, naming each with its line (nothing is sent): a name that is not a valid secret id
// (`^[A-Z][A-Z0-9_]*$`); a reference in a default (`${A:${B}}`, bug 48: the binary reads a default
// as literal text, so `${B}` would never be expanded); and any Bloblang `env(` call (literal or
// computed name) outside a `#` comment, which reads an environment variable the pipeline does not have.

import { Parser } from 'yaml';
import { bloblangRegions, endsInBloblangComment, type Region } from './bloblang';
import { CLOUD_SECRET_PREFIX, isCloudSecretName, REFERENCE } from './envUsage';
import { parseYaml } from './yamlPath';

/** Redpanda Cloud's secret id rule (the Data Plane API's documentation). */
export const SECRET_ID = /^[A-Z][A-Z0-9_]*$/;

export interface TranslateProblem {
	/** 1-based. */
	readonly line: number;
	/** The text shown, its line included. */
	readonly message: string;
}

/** A secret the translated text references (ticket 5.7). */
export interface CloudSecretUse {
	readonly name: string;
	/** Some use has no default (as `envUsage`'s `required`), so the cluster needs the secret. */
	readonly required: boolean;
}

export type CloudTranslation =
	/** `secrets`: the secrets the text uses, by first use, each once. */
	| { readonly kind: 'ok'; readonly text: string; readonly secrets: CloudSecretUse[] }
	/** The problems by position in the text. */
	| { readonly kind: 'refused'; readonly problems: TranslateProblem[] };

/** Any call of Bloblang's `env(` (not `getenv(`, `my_env(` or a method such as `this.env(`). */
const ANY_ENV_CALL = /(?<![.\w])env\(/g;
/** A literal first argument (`"NAME"`, `'NAME'`, `\"NAME\"`), other arguments allowed after it. */
const LITERAL_ARG = /env\(\s*\\?(["'])([A-Za-z_][A-Za-z0-9_]*)\\?\1/y;

/** A `${…}` in a default, other than a Bloblang interpolation `${!…}` (which runs once the config is parsed). */
const NESTED = /\$\{(?!!)[^}]+\}/;

/**
 * Bug 48: whether the `env(` at each offset is in a comment, so never run: a YAML comment token (the
 * `yaml` package's CST), or a Bloblang `#` comment of a Bloblang field or `${! }` interpolation, scanned
 * from the field's start with its strings (`"…"`, `"""…"""` across lines) followed, and in a scalar that folds
 * its lines (all but a literal block) a comment whether or not a line break is kept. Anything else, or a
 * text the parser reports errors in, counts as code: refused, as before bug 48.
 */
function commentTest(text: string): (at: number) => boolean {
	const parsed = parseYaml(text);
	if (!parsed || parsed.docs.some((d) => d.errors.length > 0)) {
		return () => false;
	}
	const comments: [number, number][] = [];
	const walk = (token: unknown): void => {
		if (Array.isArray(token)) {
			token.forEach(walk);
		} else if (token && typeof token === 'object') {
			const t = token as { type?: unknown; offset?: unknown; source?: unknown };
			if (t.type === 'comment' && typeof t.offset === 'number' && typeof t.source === 'string') {
				comments.push([t.offset, t.offset + t.source.length]);
			}
			Object.values(token).forEach((v) => (v && typeof v === 'object' ? walk(v) : undefined));
		}
	};
	try {
		for (const token of new Parser().parse(text)) {
			walk(token);
		}
	} catch {
		return () => false;
	}
	const regions = bloblangRegions(parsed, text);
	const inBloblangComment = (r: Region, at: number): boolean => {
		const raw = text.slice(r.start, at);
		const source = r.yamlDoubleQuoted ? raw.replace(/\\(["\\])/g, ' $1') : raw;
		// A scalar other than a literal block folds its line breaks (mostly to spaces): a comment both ways.
		return endsInBloblangComment(source) && (r.literalBlock === true || endsInBloblangComment(source.replace(/\n/g, ' ')));
	};
	return (at) => comments.some(([start, end]) => at >= start && at < end)
		|| regions.some((r) => at >= r.start && at < r.end && inBloblangComment(r, at));
}

/** The 1-based line of each offset, by a running count (offsets in increasing order). */
function lineCounter(text: string): (offset: number) => number {
	let at = 0;
	let line = 1;
	return (offset) => {
		for (; at < offset; at++) {
			if (text.charCodeAt(at) === 10) {
				line++;
			}
		}
		return line;
	};
}

/** `text` as sent to Redpanda Cloud, or why it can't be. Pure. */
export function translateForCloud(text: string): CloudTranslation {
	const found: { readonly at: number; readonly problem: (line: number) => string }[] = [];
	const secrets: { name: string; required: boolean }[] = [];
	for (const match of text.matchAll(REFERENCE)) {
		const at = match.index ?? 0;
		const name = match[1];
		// An existing `${secrets.NAME}` uses the secret NAME; any other dotted name is left as written.
		const written = isCloudSecretName(name);
		if (name.includes('.') && !written) {
			continue;
		}
		// Every problem of the reference is said: a reference in its default, and a bad name.
		const nested = match[2] !== undefined && NESTED.test(match[2]);
		if (nested) {
			const span = match[0];
			found.push({ at, problem: (line) => `line ${line}: ${span} has a reference in its default, which is never expanded (a default is literal text); use a default without \${…}` });
		}
		const id = written ? name.slice(CLOUD_SECRET_PREFIX.length) : name;
		if (!SECRET_ID.test(id)) {
			const rule = `must match ${SECRET_ID.source}`;
			found.push({
				at,
				problem: (line) => (!written ? `${name} (line ${line}): a Redpanda Cloud secret name ${rule}`
					: id === '' ? `${name} (line ${line}): the secret name after secrets. is empty; it ${rule}`
						: `${name} (line ${line}): ${id}, the secret name, ${rule}`),
			});
		} else if (!nested) {
			const required = match[2] === undefined;
			const known = secrets.find((s) => s.name === id);
			if (known === undefined) {
				secrets.push({ name: id, required });
			} else if (required) {
				known.required = true;
			}
		}
	}
	let inComment: ((at: number) => boolean) | undefined;
	for (const match of text.matchAll(ANY_ENV_CALL)) {
		const at = match.index ?? 0;
		inComment ??= commentTest(text);
		if (inComment(at)) {
			continue; // a comment is never run
		}
		const literal = new RegExp(LITERAL_ARG);
		literal.lastIndex = at;
		const name = literal.exec(text)?.[2];
		const suggested = name === undefined || SECRET_ID.test(name) ? `"\${${name}}"`
			: `"\${${name.toUpperCase()}}" (a Redpanda Cloud secret name must match ${SECRET_ID.source})`;
		found.push({
			at,
			problem: (line) => name !== undefined
				? `line ${line}: env("${name}") reads an environment variable, which Redpanda Cloud pipelines do not have; use ${suggested}`
				: `line ${line}: env(…) reads an environment variable, which Redpanda Cloud pipelines do not have; use "\${NAME}" with the variable's name`,
		});
	}
	if (found.length > 0) {
		const lineOf = lineCounter(text);
		return {
			kind: 'refused',
			problems: found.sort((a, b) => a.at - b.at).map(({ at, problem }) => {
				const line = lineOf(at);
				return { line, message: problem(line) };
			}),
		};
	}
	const translated = text.replace(REFERENCE, (span: string, name: string) => (name.includes('.') ? span : `\${secrets.${span.slice(2)}`));
	return { kind: 'ok', text: translated, secrets };
}
