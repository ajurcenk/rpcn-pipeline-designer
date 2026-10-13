// The Bloblang position map's round-trip check (ticket 4.3), shared by the core suite and the
// corpus harness. Walking the decoded text in order, every character's mapped offset must be, in
// the source, exactly where the previous character's source ended or later, and hold:
//   - the character itself; or
//   - in a double-quoted scalar, a `\` escape that decodes to it; or
//   - in a single-quoted scalar, for a `'`, a `''`; or
//   - for a space or line feed a fold (or chomping) made, the first line break after the previous
//     character's source.

import { isScalar, parseAllDocuments, Scalar, visit, type Document } from 'yaml';
import type { BloblangProcessor } from '../../core/bloblangProcessors';

const ESCAPES: Readonly<Record<string, string>> = {
	'0': '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
	N: '\u0085', _: ' ', L: ' ', P: ' ', ' ': ' ', '"': '"', '/': '/', '\\': '\\', '\t': '\t',
};

/** The escape at `offset` of `text`: what it decodes to and its source length. */
function escapeAt(text: string, offset: number): { value: string; width: number } | undefined {
	if (text[offset] !== '\\') {
		return undefined;
	}
	const e = text[offset + 1];
	if (Object.prototype.hasOwnProperty.call(ESCAPES, e)) {
		return { value: ESCAPES[e], width: 2 };
	}
	const length = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
	const hex = text.substr(offset + 2, length);
	if (!length || hex.length !== length || !/^[0-9a-fA-F]+$/.test(hex)) {
		return undefined;
	}
	let value: string;
	try {
		value = String.fromCodePoint(parseInt(hex, 16));
	} catch {
		return undefined;
	}
	const width = 2 + length;
	// A surrogate pair written as two escapes is one character.
	const code = value.charCodeAt(0);
	if (value.length === 1 && code >= 0xd800 && code <= 0xdbff) {
		const low = escapeAt(text, offset + width);
		if (low) {
			return { value: value + low.value, width: width + low.width };
		}
	}
	return { value, width };
}

/** The scalar value of the pair whose key starts at `keyStart`, if any. */
function scalarAt(text: string, keyStart: number): Scalar | undefined {
	for (const doc of Array.from(parseAllDocuments(text) as Document.Parsed[])) {
		let found: unknown;
		visit(doc, {
			Pair(_, pair) {
				if (isScalar(pair.key) && pair.key.range?.[0] === keyStart) {
					found = pair.value;
					return visit.BREAK;
				}
				return undefined;
			},
		});
		if (found !== undefined) {
			return isScalar(found) ? found : undefined;
		}
	}
	return undefined;
}

const isBreak = (ch: string | undefined): boolean => ch === '\n' || ch === '\r';

/** Problems with `processor`'s position map over `text` (its document); none when it round-trips. */
export function positionProblems(text: string, processor: Pick<BloblangProcessor, 'path' | 'keyRange' | 'positions'>): string[] {
	const problems: string[] = [];
	const { positions } = processor;
	if (positions.text === '') {
		return problems;
	}
	const scalar = scalarAt(text, processor.keyRange[0]);
	if (!scalar?.range) {
		return [`  ${processor.path}: no scalar value`];
	}
	const block = scalar.type === Scalar.BLOCK_LITERAL || scalar.type === Scalar.BLOCK_FOLDED;
	const newline = text.indexOf('\n', scalar.range[0]);
	// Where the previous character's source ended: first, where the scalar's content starts.
	let cursor = block ? (newline < 0 ? scalar.range[1] : newline + 1) : scalar.range[0];

	/** The source length of `ch` at `offset`, if it holds `ch` as the rules above allow. */
	const sourceOf = (ch: string, offset: number): number | undefined => {
		if (scalar.type === Scalar.QUOTE_DOUBLE) {
			const escape = escapeAt(text, offset);
			if (escape) {
				return escape.value === ch ? escape.width : undefined;
			}
		}
		if (scalar.type === Scalar.QUOTE_SINGLE && ch === "'") {
			return text.startsWith("''", offset) ? 2 : undefined;
		}
		if ((ch === ' ' || ch === '\n') && (isBreak(text[offset]) || offset === text.length)) {
			const lf = text.indexOf('\n', cursor);
			const cr = text.indexOf('\r', cursor);
			const first = cr >= 0 && (lf < 0 || cr < lf) ? cr : lf >= 0 ? lf : text.length;
			return offset !== first ? undefined : text.startsWith('\r\n', offset) ? 2 : 1;
		}
		return text.codePointAt(offset) === ch.codePointAt(0) ? ch.length : undefined;
	};
	const check = (ch: string, offset: number, where: string): void => {
		if (offset < cursor) {
			problems.push(`  ${processor.path} ${where} ${JSON.stringify(ch)} -> ${offset}, before the previous character's source end ${cursor}`);
		}
		const width = sourceOf(ch, offset);
		if (width === undefined) {
			problems.push(`  ${processor.path} ${where} ${JSON.stringify(ch)} -> ${offset} holds ${JSON.stringify(text.slice(offset, offset + 2))}`);
		}
		cursor = Math.max(cursor, offset + (width ?? 1));
	};

	const lines = positions.text.split('\n');
	lines.forEach((line, l) => {
		const chars = Array.from(line);
		chars.forEach((ch, c) => check(ch, positions.offsetAt(l + 1, c + 1), `(${l + 1},${c + 1})`));
		// A character past the line's end gives its end: the line's own line feed, or the mapping's end.
		const end = positions.offsetAt(l + 1, chars.length + 1);
		if (l + 1 < lines.length) {
			check('\n', end, `line ${l + 1}'s line feed`);
		}
		if (positions.offsetAt(l + 1, chars.length + 100) !== end) {
			problems.push(`  ${processor.path} line ${l + 1}: a char past its end does not clamp to its end`);
		}
		if (positions.lineStart(l + 1) !== positions.offsetAt(l + 1, 1)) {
			problems.push(`  ${processor.path} line ${l + 1}: lineStart is not offsetAt(line, 1)`);
		}
	});
	const last = positions.offsetAt(lines.length, Array.from(lines[lines.length - 1]).length + 1);
	if (positions.offsetAt(lines.length + 1, 1) !== last || positions.offsetAt(lines.length + 50, 3) !== last) {
		problems.push(`  ${processor.path}: a line past the last does not clamp to the mapping's end ${last}`);
	}
	return problems;
}
