// The Bloblang-to-document position map of a `mapping` / `mutation` processor (epic 4, ticket
// 4.3). Pure, deterministic, never throws. The binary reports Bloblang positions relative to the
// mapping: `line L char C` (1-based; `char` counts Unicode code points) and `failed assignment
// (line N)` (AD-21). The map translates both to UTF-16 document offsets (AD-16).
//
// The map's text is the decoded scalar (`Scalar.value`, what a test run and `blobl -f` receive).
// It is decoded here a second time, from the raw source, mirroring the `yaml` package's own
// scalar resolution (compose/resolve-block-scalar.js, resolve-flow-scalar.js) for every style:
// block literal and folded (chomping and indentation indicators), plain, single- and
// double-quoted. Each decoded UTF-16 unit records the document offset of the source character it
// came from; a character the decoding produced records the start of its source sequence: an
// escape's result its `\`, a `''` its first `'`, and a folded line break's space (or a line feed
// a fold or chomping keeps) the first line break after the previous character's source. If the second decoding
// differs from `Scalar.value`, every position maps to the value's start: never a wrong map.

import { isScalar, Scalar } from 'yaml';

export interface BloblangPositions {
	/** The decoded Bloblang (`Scalar.value`); `''` for an empty or non-scalar value. */
	readonly text: string;
	/**
	 * The UTF-16 document offset of the mapping's `line` and `char` (both 1-based; `char` in code
	 * points). A `char` past its line's end gives the line's end; a `line` past the last gives the
	 * mapping's end. Never throws.
	 */
	offsetAt(line: number, char: number): number;
	/** The document offset of the first character of the mapping's `line` (`offsetAt(line, 1)`). */
	lineStart(line: number): number;
}

/**
 * The position map of `value` (the `mapping` / `mutation` pair's value) in `text` (the whole
 * document); `keyStart` is the key's offset. `source` is the decoded Bloblang the finder reports.
 */
export function bloblangPositions(text: string, value: unknown, keyStart: number, source: string): BloblangPositions {
	try {
		if (source === '' || !isScalar(value) || !value.range) {
			return constant(source, keyStart);
		}
		const decoded = decode(text, value as Scalar, keyStart);
		if (!decoded || decoded.text !== source) {
			return constant(source, value.range[0]);
		}
		return mapped(decoded);
	} catch {
		return constant(source, keyStart);
	}
}

/** Every position at `offset`. */
function constant(text: string, offset: number): BloblangPositions {
	return { text, offsetAt: () => offset, lineStart: () => offset };
}

interface Decoded {
	readonly text: string;
	/** Per decoded UTF-16 unit: the document offset of its source sequence's start. */
	readonly starts: readonly number[];
	/** Per decoded UTF-16 unit: the document offset just past its source sequence. */
	readonly ends: readonly number[];
}

function mapped({ text, starts, ends }: Decoded): BloblangPositions {
	const lineStarts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\n') {
			lineStarts.push(i + 1);
		}
	}
	const last = text.length - 1;
	// The mapping's end: just past its last character, or a final line break itself.
	const end = text[last] === '\n' ? starts[last] : ends[last];
	const at = (index: number): number => (index < text.length ? starts[index] : end);
	const offsetAt = (line: number, char: number): number => {
		const l = whole(line);
		if (l > lineStarts.length) {
			return end;
		}
		let i = lineStarts[l - 1];
		const lineEnd = l < lineStarts.length ? lineStarts[l] - 1 : text.length;
		for (let c = whole(char); c > 1 && i < lineEnd; c--) {
			i += isHigh(text.charCodeAt(i)) && isLow(text.charCodeAt(i + 1)) ? 2 : 1;
		}
		return at(Math.min(i, lineEnd));
	};
	return { text, offsetAt, lineStart: (line) => offsetAt(line, 1) };
}

/** A 1-based position: an integer, at least 1 (anything else, `NaN` included, is 1). */
function whole(n: number): number {
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

const isHigh = (u: number): boolean => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number): boolean => u >= 0xdc00 && u <= 0xdfff;

/** The decoded text with its offsets, built side by side. */
class Out {
	text = '';
	readonly starts: number[] = [];
	readonly ends: number[] = [];

	/** `doc` is the document; `cursor` the offset where the scalar's content starts. */
	constructor(private readonly doc: string, private cursor: number) {}

	/** `s`, every unit of it from the source sequence `[start, end)`. */
	emit(s: string, start: number, end: number): void {
		this.text += s;
		for (let k = 0; k < s.length; k++) {
			this.starts.push(start);
			this.ends.push(end);
		}
		if (s) {
			this.cursor = end;
		}
	}

	/** `s`, copied from the source at `start`: unit k from `start + k`. */
	copy(s: string, start: number): void {
		this.text += s;
		for (let k = 0; k < s.length; k++) {
			this.starts.push(start + k);
			this.ends.push(start + k + 1);
		}
		if (s) {
			this.cursor = start + s.length;
		}
	}

	/** `s` (spaces and line feeds a fold made): each unit at the next line break of the source. */
	fold(s: string): void {
		for (const unit of s) {
			const lf = this.doc.indexOf('\n', this.cursor);
			const cr = this.doc.indexOf('\r', this.cursor);
			const at = cr >= 0 && (lf < 0 || cr < lf) ? cr : lf >= 0 ? lf : this.cursor;
			this.emit(unit, at, at + (this.doc.startsWith('\r\n', at) ? 2 : at < this.doc.length ? 1 : 0));
		}
	}

	/** The source up to `offset` is consumed (a `\` line continuation). */
	skipTo(offset: number): void {
		this.cursor = Math.max(this.cursor, offset);
	}

	get last(): string {
		return this.text[this.text.length - 1];
	}

	result(): Decoded {
		return { text: this.text, starts: this.starts, ends: this.ends };
	}
}

function decode(text: string, value: Scalar, keyStart: number): Decoded | undefined {
	const [start, end] = value.range!;
	switch (value.type) {
		case Scalar.BLOCK_LITERAL:
		case Scalar.BLOCK_FOLDED:
			return blockScalar(text, start, end, value.type === Scalar.BLOCK_FOLDED, keyStart - text.lastIndexOf('\n', keyStart - 1) - 1);
		case Scalar.PLAIN: {
			const out = new Out(text, start);
			unfoldLines(text.slice(start, end), start, out);
			return out.result();
		}
		case Scalar.QUOTE_SINGLE:
			return singleQuoted(text, start, end);
		case Scalar.QUOTE_DOUBLE:
			return doubleQuoted(text, start, end);
		default:
			return undefined;
	}
}

// ---------------------------------------------------------------------------------------------
// Block scalars (yaml's resolveBlockScalar).
// ---------------------------------------------------------------------------------------------

interface Line {
	/** The line's document offset. */
	readonly at: number;
	readonly indent: number;
	/** After the indentation, to the line break (a CRLF's `\r` included). */
	readonly content: string;
}

/** `parentIndent` is the key's column: the base of an explicit indentation indicator. */
function blockScalar(text: string, start: number, end: number, folded: boolean, parentIndent: number): Decoded {
	// The header: `|` or `>`, then a chomping indicator and an indentation digit in either order.
	let chomp = '';
	let headerIndent = 0;
	for (let i = start + 1; i < end && /[0-9+-]/.test(text[i]); i++) {
		const ch = text[i];
		if (!chomp && (ch === '-' || ch === '+')) {
			chomp = ch;
		} else if (!headerIndent && Number(ch)) {
			headerIndent = Number(ch);
		}
	}
	const newline = text.indexOf('\n', start);
	const bodyStart = newline < 0 || newline >= end ? end : newline + 1;
	const body = text.slice(bodyStart, end);
	const out = new Out(text, bodyStart);
	const lines: Line[] = [];
	if (body) {
		let at = bodyStart;
		for (const raw of body.split('\n')) {
			const indent = /^ */.exec(raw)![0].length;
			const content = raw.slice(indent);
			lines.push({ at, indent, content });
			at += raw.length + 1;
		}
	}
	const isEmpty = (l: Line): boolean => l.content === '' || l.content === '\r';
	let chompStart = lines.length;
	for (let i = lines.length - 1; i >= 0 && isEmpty(lines[i]); i--) {
		chompStart = i;
	}
	if (chompStart === 0) {
		// Only empty lines: kept, each line feed at its own line break.
		if (chomp === '+' && lines.length > 0) {
			out.fold('\n'.repeat(Math.max(1, lines.length - 1)));
		}
		return out.result();
	}
	let trimIndent = parentIndent + headerIndent;
	let contentStart = 0;
	for (let i = 0; i < chompStart; i++) {
		const line = lines[i];
		if (isEmpty(line)) {
			if (headerIndent === 0 && line.indent > trimIndent) {
				trimIndent = line.indent;
			}
		} else {
			if (headerIndent === 0) {
				trimIndent = line.indent;
			}
			contentStart = i;
			break;
		}
	}
	for (let i = lines.length - 1; i >= chompStart; i--) {
		if (lines[i].indent > trimIndent) {
			chompStart = i + 1;
		}
	}
	/** The more-indented part of a line's indentation, copied from the source. */
	const extraIndent = (line: Line, indent: number): void => {
		if (indent > trimIndent) {
			out.copy(' '.repeat(indent - trimIndent), line.at + trimIndent);
		}
	};
	// Leading empty lines keep their whitespace.
	for (let i = 0; i < contentStart; i++) {
		extraIndent(lines[i], lines[i].indent);
		out.fold('\n');
	}
	let sep = '';
	let prevMoreIndented = false;
	for (let i = contentStart; i < chompStart; i++) {
		const line = lines[i];
		let indent = line.indent;
		const content = line.content.endsWith('\r') ? line.content.slice(0, -1) : line.content;
		if (content && indent < trimIndent) {
			indent = 0;
		}
		const contentAt = line.at + line.indent;
		if (!folded) {
			out.fold(sep);
			extraIndent(line, indent);
			out.copy(content, contentAt);
			sep = '\n';
		} else if (indent > trimIndent || content[0] === '\t') {
			if (sep === ' ') {
				sep = '\n';
			} else if (!prevMoreIndented && sep === '\n') {
				sep = '\n\n';
			}
			out.fold(sep);
			extraIndent(line, indent);
			out.copy(content, contentAt);
			sep = '\n';
			prevMoreIndented = true;
		} else if (content === '') {
			if (sep === '\n') {
				out.fold('\n');
			} else {
				sep = '\n';
			}
		} else {
			out.fold(sep);
			out.copy(content, contentAt);
			sep = ' ';
			prevMoreIndented = false;
		}
	}
	if (chomp === '+') {
		for (let i = chompStart; i < lines.length; i++) {
			out.fold('\n');
			extraIndent(lines[i], lines[i].indent);
		}
		if (out.last !== '\n') {
			out.fold('\n');
		}
	} else if (chomp !== '-') {
		out.fold('\n');
	}
	return out.result();
}

// ---------------------------------------------------------------------------------------------
// Flow scalars (yaml's resolveFlowScalar).
// ---------------------------------------------------------------------------------------------

const isBlank = (ch: string | undefined): boolean => ch === ' ' || ch === '\t';

/** yaml's `unfoldLines` of `source` (at document offset `base`): line folding of plain and single-quoted. */
function unfoldLines(source: string, base: number, out: Out): void {
	const lineRe = /(.*?)\r?\n/sy;
	let match = lineRe.exec(source);
	if (!match) {
		out.copy(source, base);
		return;
	}
	out.copy(match[1].replace(/[ \t]+$/, ''), base + match.index);
	let sep = ' ';
	let pos = lineRe.lastIndex;
	while ((match = lineRe.exec(source))) {
		const raw = match[1];
		const lead = /^[ \t]*/.exec(raw)![0].length;
		const lm = raw.slice(lead).replace(/[ \t]+$/, '');
		if (lm === '') {
			if (sep === '\n') {
				out.fold(sep);
			} else {
				sep = '\n';
			}
		} else {
			out.fold(sep);
			out.copy(lm, base + match.index + lead);
			sep = ' ';
		}
		pos = lineRe.lastIndex;
	}
	const rest = source.slice(pos);
	const lead = /^[ \t]*/.exec(rest)![0].length;
	out.fold(sep);
	out.copy(rest.slice(lead), base + pos + lead);
}

/** `'…'`: unfolded, then each `''` is one `'`, at the first. */
function singleQuoted(doc: string, base: number, end: number): Decoded {
	const unfolded = new Out(doc, base + 1);
	unfoldLines(doc.slice(base, end).slice(1, -1), base + 1, unfolded);
	const out = new Out(doc, base);
	const { text, starts, ends } = unfolded;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "'" && text[i + 1] === "'") {
			out.emit("'", starts[i], ends[i + 1]);
			i++;
		} else {
			out.emit(text[i], starts[i], ends[i]);
		}
	}
	return out.result();
}

const ESCAPES: Readonly<Record<string, string>> = {
	'0': '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
	N: '\u0085', _: ' ', L: ' ', P: ' ', ' ': ' ', '"': '"', '/': '/', '\\': '\\', '\t': '\t',
};

/** `"…"`: escapes (each result at its `\`), `\` line continuations and folded line breaks. */
function doubleQuoted(doc: string, base: number, end: number): Decoded {
	const source = doc.slice(base, end);
	const out = new Out(doc, base + 1);
	for (let i = 1; i < source.length - 1; ++i) {
		const ch = source[i];
		if (ch === '\r' && source[i + 1] === '\n') {
			continue;
		}
		if (ch === '\n') {
			// A fold: one break is a space, N breaks are N - 1 line feeds, from the first break on.
			let fold = '';
			let next = source[i + 1];
			while (next === ' ' || next === '\t' || next === '\n' || next === '\r') {
				if (next === '\r' && source[i + 2] !== '\n') {
					break;
				}
				if (next === '\n') {
					fold += '\n';
				}
				i += 1;
				next = source[i + 1];
			}
			out.fold(fold || ' ');
			out.skipTo(base + i + 1);
		} else if (ch === '\\') {
			const escapeAt = i;
			let next = source[++i];
			const code = ESCAPES[next];
			if (code) {
				out.emit(code, base + escapeAt, base + i + 1);
			} else if (next === '\n') {
				next = source[i + 1];
				while (isBlank(next)) {
					next = source[++i + 1];
				}
				out.skipTo(base + i + 1);
			} else if (next === '\r' && source[i + 1] === '\n') {
				next = source[++i + 1];
				while (isBlank(next)) {
					next = source[++i + 1];
				}
				out.skipTo(base + i + 1);
			} else if (next === 'x' || next === 'u' || next === 'U') {
				const length = next === 'x' ? 2 : next === 'u' ? 4 : 8;
				const hex = source.substr(i + 1, length);
				const cp = hex.length === length && /^[0-9a-fA-F]+$/.test(hex) ? parseInt(hex, 16) : NaN;
				let decoded: string | undefined;
				try {
					decoded = String.fromCodePoint(cp);
				} catch {
					decoded = undefined;
				}
				if (decoded === undefined) {
					out.copy(source.substr(i - 1, length + 2), base + i - 1);
				} else {
					out.emit(decoded, base + escapeAt, base + i + 1 + length);
				}
				i += length;
			} else {
				out.copy(source.substr(i - 1, 2), base + i - 1);
			}
		} else if (isBlank(ch)) {
			// Whitespace before a line break is trimmed.
			const wsStart = i;
			let next = source[i + 1];
			while (isBlank(next)) {
				next = source[++i + 1];
			}
			if (next !== '\n' && !(next === '\r' && source[i + 2] === '\n')) {
				out.copy(source.slice(wsStart, i + 1), base + wsStart);
			}
		} else {
			out.copy(ch, base + i);
		}
	}
	return out.result();
}
