// The AD-21 live parse, pure (ticket 4.5): what `blobl --file <mapping>` with stdin closed means.
// Spike 4.1 (B parse-only): exit 0 means the mapping parses; a parse error exits 1 with
//
//   failed to parse mapping: line 3 char 8: required: expected comma or closing bracket
//     |
//   3 | root.c = 3
//     |        ^---
//
// on stderr, `line` and `char` 1-based and relative to the mapping (`char` in code points). Any
// other failure (an unset `${VAR}`: `failed to replace env vars: …`, a crash, a signal) is not a
// parse error: it is `other`, its stderr kept for the log.

export type BloblParseOutcome =
	| { readonly kind: 'ok' }
	| {
		readonly kind: 'parseError';
		/** The binary's message, without the `failed to parse mapping: line L char C: ` prefix. */
		readonly message: string;
		readonly line: number;
		readonly char: number;
		/** The caret excerpt below the message, verbatim (`''` when there is none). */
		readonly excerpt: string;
	}
	| { readonly kind: 'other'; readonly message: string };

const PARSE_ERROR = /^failed to parse mapping: line (\d+) char (\d+): ?(.*)$/;
/** An excerpt line: `  |`, `3 | root.c = 3`, `  |        ^---`. */
const EXCERPT_LINE = /^\s*\d*\s*\|/;

/** Reads a `blobl --file` parse run's exit code (`null`: a signal) and stderr. Never throws. */
export function parseBloblParseOutput(exitCode: number | null, stderr: string): BloblParseOutcome {
	if (exitCode === 0) {
		return { kind: 'ok' };
	}
	const lines = stderr.split(/\r?\n/);
	const first = lines.findIndex((l) => l.trim() !== '');
	const match = first >= 0 ? PARSE_ERROR.exec(lines[first].trim()) : null;
	if (match) {
		// The message runs until the excerpt (a message of several lines keeps them).
		let i = first + 1;
		const more: string[] = [];
		for (; i < lines.length && !EXCERPT_LINE.test(lines[i]); i++) {
			more.push(lines[i]);
		}
		const excerpt = lines.slice(i);
		while (excerpt.length > 0 && excerpt[excerpt.length - 1].trim() === '') {
			excerpt.pop();
		}
		const message = [match[3], ...more].join('\n').trim();
		return {
			kind: 'parseError',
			message: message || 'Bloblang parse error.',
			line: Number(match[1]),
			char: Number(match[2]),
			excerpt: excerpt.join('\n'),
		};
	}
	const text = lines.filter((l) => l.trim() !== '').join('\n');
	if (text) {
		return { kind: 'other', message: text };
	}
	return { kind: 'other', message: exitCode === null ? 'blobl was stopped by a signal.' : `blobl exited with code ${exitCode}.` };
}
