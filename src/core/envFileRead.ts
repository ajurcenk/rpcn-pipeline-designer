// Pure: an env file read the way the binary reads `--env-file` (ticket 31), for the Environment
// view only (the commands pass the file to the binary as is). Probed 2026-10-28 on 4.100.0
// (`redpanda-connect`) and 4.112.0 (`rpk connect`), both the same:
//   - Blank lines, and lines whose first non-blank character is `#`, are skipped.
//   - `KEY=value`, with spaces (not tabs) allowed around `=`. The key is anything up to the spaces
//     or `=`; one that is not `[A-Za-z_][A-Za-z0-9_]*` (`1A`, `A.b`, a tab before it or before `=`)
//     sets a variable `${…}` cannot read, so it is left out here.
//   - An unquoted value ends at a space, a tab or `#` (`A=a#b` is `a`); a double-quoted value takes
//     Go's escapes (`\\`, `\"`, `\n`, `\r`, `\t`, …; `\$` or a quote left open fails the file);
//     single quotes are kept as part of the value. After the value, only spaces and a `# comment`.
//   - Anything else after the value (`A=1 2`, `A="x" y`) and a line starting with a space: the
//     binary keeps what came before and silently ignores that line and every line after it.
//   - A line that is no assignment (`export A=1`, `A: 1`, `A`): the binary rejects the whole file
//     ("failed to parse dotenv file"), and the command fails.
// A name set twice keeps the last value. Lines are counted from 1; `\r\n` endings are fine.

export interface EnvFileVariable {
	readonly name: string;
	readonly value: string;
	/** The line (from 1) that set the value the binary keeps. */
	readonly line: number;
}

export type EnvFileProblem =
	/** The binary will not use the file at all (the command fails). */
	| { readonly kind: 'rejected'; readonly line: number; readonly reason: string }
	/**
	 * The binary stops reading at this line: it ignores the lines after it, and this line too when
	 * it starts with a space; with `keepsLine` (more text after a value), it keeps this line's value.
	 */
	| { readonly kind: 'stops'; readonly line: number; readonly keepsLine: boolean };

export interface EnvFileRead {
	/** The variables up to the first problem, by name (last value wins), in the order first set. */
	readonly variables: readonly EnvFileVariable[];
	readonly problem?: EnvFileProblem;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGNMENT = /^([^ =#][^ =]*) *= */;
const AFTER_VALUE = /^[ \t]*(#.*)?$/;
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
	a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"',
};

/** Reads an env file's content as the binary does. Pure. */
export function readEnvFile(content: string): EnvFileRead {
	const variables = new Map<string, EnvFileVariable>();
	const result = (problem?: EnvFileProblem): EnvFileRead => ({ variables: [...variables.values()], ...(problem ? { problem } : {}) });
	const lines = content.split('\n');
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
		const number = index + 1;
		if (/^[ \t]*$/.test(line) || /^[ \t]*#/.test(line)) {
			continue;
		}
		if (line.startsWith(' ')) {
			return result({ kind: 'stops', line: number, keepsLine: false });
		}
		const assignment = ASSIGNMENT.exec(line);
		if (!assignment) {
			return result({ kind: 'rejected', line: number, reason: 'not a NAME=value line' });
		}
		const value = parseValue(line.slice(assignment[0].length));
		if (value.kind === 'rejected') {
			return result({ kind: 'rejected', line: number, reason: value.reason });
		}
		const name = assignment[1];
		if (NAME.test(name)) {
			variables.delete(name);
			variables.set(name, { name, value: value.value, line: number });
		}
		if (!value.clean) {
			// The binary keeps this line's value and ignores what follows it, here and below.
			return result({ kind: 'stops', line: number, keepsLine: true });
		}
	}
	return result();
}

type Value =
	| { readonly kind: 'ok'; readonly value: string; readonly clean: boolean }
	| { readonly kind: 'rejected'; readonly reason: string };

/** A value and what follows it on its line. */
function parseValue(rest: string): Value {
	if (!rest.startsWith('"')) {
		const token = /^[^ \t#]*/.exec(rest)![0];
		return { kind: 'ok', value: token, clean: AFTER_VALUE.test(rest.slice(token.length)) };
	}
	let value = '';
	for (let i = 1; i < rest.length; i++) {
		const c = rest[i];
		if (c === '"') {
			return { kind: 'ok', value, clean: AFTER_VALUE.test(rest.slice(i + 1)) };
		}
		if (c !== '\\') {
			value += c;
			continue;
		}
		const escape = unescape(rest, i + 1);
		if (!escape) {
			return { kind: 'rejected', reason: 'an invalid escape in a quoted value' };
		}
		value += escape.text;
		i = escape.end - 1;
	}
	return { kind: 'rejected', reason: 'a quoted value without its closing quote' };
}

/** Go's escape at `at` (after the backslash): its text and where it ends; `undefined` when invalid. */
function unescape(text: string, at: number): { readonly text: string; readonly end: number } | undefined {
	const c = text[at];
	if (c === undefined) {
		return undefined;
	}
	if (c in SIMPLE_ESCAPES) {
		return { text: SIMPLE_ESCAPES[c], end: at + 1 };
	}
	const hex = (length: number) => {
		const digits = text.slice(at + 1, at + 1 + length);
		return digits.length === length && /^[0-9A-Fa-f]+$/.test(digits) ? parseInt(digits, 16) : undefined;
	};
	if (c === 'x') {
		const code = hex(2);
		return code === undefined ? undefined : { text: String.fromCharCode(code), end: at + 3 };
	}
	if (c === 'u' || c === 'U') {
		const length = c === 'u' ? 4 : 8;
		const code = hex(length);
		return code === undefined || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
			? undefined
			: { text: String.fromCodePoint(code), end: at + 1 + length };
	}
	if (/[0-7]/.test(c)) {
		const digits = text.slice(at, at + 3);
		return /^[0-7]{3}$/.test(digits) && parseInt(digits, 8) <= 0xff
			? { text: String.fromCharCode(parseInt(digits, 8)), end: at + 3 }
			: undefined;
	}
	return undefined;
}
