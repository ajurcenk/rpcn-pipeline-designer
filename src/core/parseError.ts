// The YAML parse error the graph reports (ticket 3.6, AD-6): the first error of the first YAML
// document, which is the document the graph builder reads (src/core/graph.ts), so the graph has a
// model exactly when this gives `undefined`. Pure; never throws.

import type { ParseError, TextRange } from '../shared/protocol';
import type { ParsedYaml } from './yamlPath';

/** Shown when the parser gave up entirely (`parseYaml` returned `undefined`). */
export const UNPARSED_MESSAGE = 'The YAML could not be parsed';

/**
 * The first error of the first document, as `{message, range}`: the message's first line (the
 * `yaml` parser appends a code excerpt) and the error's UTF-16 offsets, clamped to the text. The
 * range is empty when the parser gives no end. `undefined` when that document has no error;
 * errors in later documents are not reported (the builder does not read them).
 */
export function parseErrorOf(parsed: ParsedYaml | undefined): ParseError | undefined {
	try {
		if (!parsed) {
			return { message: UNPARSED_MESSAGE, range: [0, 0] };
		}
		const error = parsed.docs[0]?.errors[0];
		if (!error) {
			return undefined;
		}
		const clamp = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(0, Math.trunc(n)), parsed.length) : 0);
		const start = clamp(error.pos?.[0]);
		const end = Math.max(start, clamp(error.pos?.[1]));
		const message = String(error.message ?? '').split('\n')[0].replace(/:\s*$/, '').trim() || UNPARSED_MESSAGE;
		return { message, range: [start, end] };
	} catch {
		return { message: UNPARSED_MESSAGE, range: [0, 0] };
	}
}

/**
 * What a click on the banner selects for `error` in `text` (UTF-16 offsets): the error's range,
 * or, when the parser gives no end (`yaml` marks most errors with one character, a position
 * rather than an end), from its position to the end of its line. When that end is not after the
 * start (the error sits on a line break or at the end of the text), the start's whole line, from
 * its first character to its end, or just the start when that line is empty. Never crosses into
 * the next line for a position-only error. Pure; never throws.
 */
export function errorSelection(text: string, range: TextRange): TextRange {
	try {
		const start = Math.min(Math.max(0, range[0]), text.length);
		const lineStart = text.lastIndexOf('\n', start - 1) + 1;
		let lineEnd = text.indexOf('\n', start);
		lineEnd = lineEnd < 0 ? text.length : lineEnd;
		if (lineEnd > lineStart && text[lineEnd - 1] === '\r') {
			lineEnd--;
		}
		const end = range[1] - range[0] > 1 ? Math.min(range[1], text.length) : lineEnd;
		if (end > start) {
			return [start, end];
		}
		return lineEnd > lineStart ? [lineStart, lineEnd] : [start, start];
	} catch {
		return [0, 0];
	}
}
