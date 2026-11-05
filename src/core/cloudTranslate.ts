// Pure: the config text a Redpanda Cloud pipeline is sent (ticket 5.6). Cloud pipelines have no
// environment variables, only secrets, so each variable reference becomes a secret reference:
//   - `${NAME}` → `${secrets.NAME}`, `${NAME:default}` → `${secrets.NAME:default}` (the default kept),
//     by the binary's own rule (`REFERENCE` in `envUsage.ts`): anywhere in the text, comments
//     included; `$${NAME}` is not an escape, so it becomes `$${secrets.NAME}`.
//   - `${!…}` (Bloblang interpolation) and a name with a `.` (such as an existing `${secrets.X}`)
//     are left as written. Only the reference spans change; every other byte is kept, so the
//     translation is idempotent.
// Refused, naming each with its line (nothing is sent): a name that is not a valid secret id
// (`^[A-Z][A-Z0-9_]*$`), and any Bloblang `env(` call (literal or computed name), which reads an
// environment variable the pipeline does not have.

import { REFERENCE } from './envUsage';

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
		const name = match[1];
		if (name.includes('.')) {
			continue;
		}
		if (!SECRET_ID.test(name)) {
			found.push({ at: match.index ?? 0, problem: (line) => `${name} (line ${line}): a Redpanda Cloud secret name must match ${SECRET_ID.source}` });
		} else {
			const required = match[2] === undefined;
			const known = secrets.find((s) => s.name === name);
			if (known === undefined) {
				secrets.push({ name, required });
			} else if (required) {
				known.required = true;
			}
		}
	}
	for (const match of text.matchAll(ANY_ENV_CALL)) {
		const at = match.index ?? 0;
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
