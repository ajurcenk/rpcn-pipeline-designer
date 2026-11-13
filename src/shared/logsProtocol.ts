// The host<->webview contract of the Pipeline Logs panel (AD-5, AD-24, tickets 6.2, 6.3, 6.4, 6.5, 6.6, 6.7): every
// message of the third webview, as discriminated unions on `type`, plus the validators each side uses on
// what it receives, and the pure rules both share (the range menu's choices, local date-times, the gap
// notes; ticket 6.4: the levels, the filter and its search pattern; ticket 6.6: the panel's states and
// their texts; ticket 6.7: the records-per-time strip's slots, labels and state). The panel adapter
// (`src/adapters/vscode/logsPanel.ts`), the record shaping (`src/adapters/logs/records.ts`) and
// `webview/src/logs` import it. Imports nothing (AD-15).

/** At most this many records are kept (the oldest dropped first), by the host and the webview alike. */
export const MAX_LOG_ROWS = 5_000;

/** One shown record: every text masked, `license_org` left out (AD-24). */
export interface LogRow {
	/** `<partition>:<offset>`, unique in the topic. */
	readonly id: string;
	/** Milliseconds since the epoch: the value's `time`, else the record's timestamp. Shown in local time. */
	readonly time: number;
	/** `INFO`, `WARN`, …; empty for a value that is not a JSON object. */
	readonly level: string;
	/** The value's `message`; a value that is not a JSON object, as text. */
	readonly message: string;
	/** The value's `instance_id`; empty when there is none. */
	readonly instance: string;
	/** The value's further fields, in the record's order, each value as text. */
	readonly fields: readonly (readonly [string, string])[];
	/** The value is not a JSON object: `message` is its text. */
	readonly raw?: true;
	/**
	 * The whole value as shown (ticket 6.4): pretty-printed JSON, masked, `license_org` left out;
	 * absent for a value that is not a JSON object (its text is `message`).
	 */
	readonly json?: string;
}

/**
 * The level chips (ticket 6.4, board 4): a record's level as one of these; `other` for a record
 * without a known level (none, or not one of the four).
 */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'other'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LEVEL_LABELS: Readonly<Record<LogLevel, string>> = { error: 'Error', warn: 'Warn', info: 'Info', debug: 'Debug', other: 'Other' };

/** The chip a shown level (`ERROR`, `warning`, …) counts under. */
export function levelOfText(level: string): LogLevel {
	switch (level.trim().toUpperCase()) {
		case 'ERROR':
		case 'FATAL':
		case 'PANIC':
		case 'CRITICAL':
			return 'error';
		case 'WARN':
		case 'WARNING':
			return 'warn';
		case 'INFO':
			return 'info';
		case 'DEBUG':
		case 'TRACE':
			return 'debug';
		default:
			return 'other';
	}
}

/** The longest search the box takes, and the most field chips. */
export const MAX_SEARCH_LENGTH = 1_000;
export const MAX_FIELD_FILTERS = 20;

/**
 * What the panel keeps of a pipeline's records (ticket 6.4): the levels shown, a search over the
 * message, the level, the instance and each further field's name and value (`matchCase`, `regex`), and
 * field chips (a field's name and value; `instance_id` is the instance column). Applied on the host as
 * records are read.
 */
export interface LogFilter {
	readonly levels: readonly LogLevel[];
	readonly text: string;
	readonly matchCase: boolean;
	readonly regex: boolean;
	readonly fields: readonly (readonly [string, string])[];
}

export const NO_FILTER: LogFilter = { levels: LOG_LEVELS, text: '', matchCase: false, regex: false, fields: [] };

/** Whether `filter` hides anything (a level off, a search, a chip). */
export function filterActive(filter: LogFilter): boolean {
	return LOG_LEVELS.some((l) => !filter.levels.includes(l)) || filter.text !== '' || filter.fields.length > 0;
}

/**
 * Bug 51: what `filter` keeps, in words (an export's message names it): `levels Error, Warn; search "timeout"
 * (regular expression, match case); path=/config/connect.yaml`. Empty for no filter.
 */
export function filterText(filter: LogFilter): string {
	const parts: string[] = [];
	if (LOG_LEVELS.some((l) => !filter.levels.includes(l))) {
		const shown = LOG_LEVELS.filter((l) => filter.levels.includes(l)).map((l) => LEVEL_LABELS[l]);
		parts.push(shown.length > 0 ? `levels ${shown.join(', ')}` : 'no level');
	}
	if (filter.text !== '') {
		const how = [...(filter.regex ? ['regular expression'] : []), ...(filter.matchCase ? ['match case'] : [])];
		// Quoted as a JSON string, so a `"`, `;` or `)` in it cannot be read as the filter's own words.
		parts.push(`search ${JSON.stringify(filter.text)}${how.length > 0 ? ` (${how.join(', ')})` : ''}`);
	}
	for (const [key, value] of filter.fields) {
		parts.push(`${key}=${value}`);
	}
	return parts.join('; ');
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Why a regular expression that could backtrack for a very long time is refused. */
export const SLOW_PATTERN_ERROR = 'This pattern could take too long; simplify it';
/** At most this many characters of each value are searched. */
export const MAX_MATCH_CHARS = 10_000;

// The slow-pattern check (bug 54): one tokenizer reads the source into items (an atom with the set of
// characters it can match, a zero-width assertion, or a group of alternatives) with their quantifiers;
// one walk refuses a repeat whose characters meet those of an earlier repeat with nothing required
// between them that neither can match, and a repeated group that holds a quantifier or an alternation.

/**
 * A set of characters: bits 0–127 for ASCII (four words of 32), and in word 4 the non-ASCII ones in
 * two kinds, spaces (what `\s` matches beyond ASCII) and the others: per kind a bit for "some of
 * them" and a bit for "all of them", so a complement stays exact (`\S` holds no non-ASCII space,
 * `[^é]` holds other non-ASCII characters).
 */
type CharSet = number[];

const NON_ASCII = 128;
const SOME_SPACES = 1;
const SOME_OTHERS = 2;
const ALL_SPACES = 4;
const ALL_OTHERS = 8;
const noChars = (): CharSet => [0, 0, 0, 0, 0];
const allChars = (): CharSet => [-1, -1, -1, -1, SOME_SPACES | SOME_OTHERS | ALL_SPACES | ALL_OTHERS];
const addChar = (s: CharSet, code: number) => {
	if (code < NON_ASCII) {
		s[code >>> 5] |= 1 << (code & 31);
	} else {
		s[4] |= /\s/.test(String.fromCharCode(code)) ? SOME_SPACES : SOME_OTHERS;
	}
};
const hasBit = (s: CharSet, bit: number) => (s[bit >>> 5] & (1 << (bit & 31))) !== 0;
const addRange = (s: CharSet, from: number, to: number) => {
	for (let c = from; c <= Math.min(to, NON_ASCII - 1); c++) {
		addChar(s, c);
	}
	if (from === to && to >= NON_ASCII) {
		addChar(s, to);
	} else if (to >= NON_ASCII) {
		s[4] |= SOME_SPACES | SOME_OTHERS;
	}
};
const unionInto = (s: CharSet, t: CharSet) => {
	for (let i = 0; i < 5; i++) {
		s[i] |= t[i];
	}
};
const union = (s: CharSet, t: CharSet): CharSet => s.map((w, i) => w | t[i]);
const overlaps = (s: CharSet, t: CharSet) => s.some((w, i) => (w & t[i] & (i === 4 ? SOME_SPACES | SOME_OTHERS : -1)) !== 0);
/** Every character not in `s`: a non-ASCII kind is in unless `s` holds all of it, and all of it when `s` holds none. */
const complement = (s: CharSet): CharSet => {
	const kind = (some: number, all: number, someBit: number, allBit: number) => ((s[4] & all) === 0 ? someBit : 0) | ((s[4] & some) === 0 ? allBit : 0);
	return [~s[0], ~s[1], ~s[2], ~s[3], kind(SOME_SPACES, ALL_SPACES, SOME_SPACES, ALL_SPACES) | kind(SOME_OTHERS, ALL_OTHERS, SOME_OTHERS, ALL_OTHERS)];
};
/** `s` with both cases of each ASCII letter in it (conservatively, whatever the flags). */
const folded = (s: CharSet): CharSet => {
	const f = [...s];
	for (let c = 65; c <= 90; c++) {
		if (hasBit(s, c) || hasBit(s, c + 32)) {
			addChar(f, c);
			addChar(f, c + 32);
		}
	}
	return f;
};
const charsOf = (ranges: readonly (readonly [number, number])[], nonAscii = 0): CharSet => {
	const s = noChars();
	for (const [from, to] of ranges) {
		addRange(s, from, to);
	}
	s[4] |= nonAscii;
	return s;
};
const DIGITS = charsOf([[48, 57]]);
const WORD = charsOf([[48, 57], [65, 90], [95, 95], [97, 122]]);
/** `\s`: tab to carriage return, space, and non-ASCII spaces. */
const SPACE = charsOf([[9, 13], [32, 32]], SOME_SPACES | ALL_SPACES);
const CLASS_ESCAPES: Readonly<Record<string, CharSet>> = {
	d: DIGITS, D: complement(DIGITS), w: WORD, W: complement(WORD), s: SPACE, S: complement(SPACE),
};
const CONTROL_ESCAPES: Readonly<Record<string, number>> = { t: 9, n: 10, v: 11, f: 12, r: 13, 0: 0 };

type RegexNode =
	| { readonly kind: 'chars'; readonly chars: CharSet; readonly backReference: boolean }
	| { readonly kind: 'assertion' }
	| { readonly kind: 'group'; readonly alternatives: RegexItem[][]; readonly lookaround: boolean };

interface RegexItem {
	readonly node: RegexNode;
	/** Whether a quantifier follows; `min` and `max` are 1 without one. */
	readonly quantified: boolean;
	readonly min: number;
	readonly max: number;
}

/** The items of `source` (read without the `u` flag), as the top level's alternatives. */
function regexItems(source: string): RegexItem[][] {
	let i = 0;
	// The capturing groups (`(` not followed by `?`, and `(?<name>`), escapes and classes skipped: `\N`
	// is a back-reference only for N up to their count, `\k<…>` only with a named group.
	const groups = (source.match(/\\.|\[(?:\\.|[^\]\\])*\]?|\((?!\?)|\(\?<(?![=!])/g) ?? []).filter((t) => t[0] === '(');
	const namedGroups = groups.some((t) => t.length > 1);
	const hex = (length: number) => {
		const digits = source.slice(i, i + length);
		return digits.length === length && /^[0-9a-fA-F]+$/.test(digits) ? parseInt(digits, 16) : undefined;
	};
	/** The escape after a `\` at `i - 1`, inside a class or not: a character or a class escape's set. */
	const escape = (inClass: boolean): number | CharSet => {
		const c = source[i++] ?? '\\';
		if (c in CLASS_ESCAPES) {
			return CLASS_ESCAPES[c];
		}
		if (c in CONTROL_ESCAPES) {
			return CONTROL_ESCAPES[c];
		}
		if (inClass && c === 'b') {
			return 8;
		}
		if (c === 'x' || c === 'u') {
			const code = hex(c === 'x' ? 2 : 4);
			if (code !== undefined) {
				i += c === 'x' ? 2 : 4;
				return code;
			}
		}
		if (c === 'c' && /[a-zA-Z]/.test(source[i] ?? '')) {
			return source.charCodeAt(i++) & 31;
		}
		return c.charCodeAt(0);
	};
	const charClass = (): CharSet => {
		const negated = source[i] === '^';
		if (negated) {
			i++;
		}
		const s = noChars();
		const member = (): number | CharSet => {
			if (source[i] === '\\') {
				i++;
				return escape(true);
			}
			return source.charCodeAt(i++);
		};
		const add = (m: number | CharSet) => {
			if (typeof m === 'number') {
				addChar(s, m);
			} else {
				unionInto(s, m);
			}
		};
		while (i < source.length && source[i] !== ']') {
			const from = member();
			if (source[i] === '-' && i + 1 < source.length && source[i + 1] !== ']') {
				i++;
				const to = member();
				if (typeof from === 'number' && typeof to === 'number') {
					addRange(s, from, to);
				} else {
					// `[\d-z]`: the escape, the `-` and the other end, each as itself.
					add(from);
					add(to);
					addChar(s, 45);
				}
			} else {
				add(from);
			}
		}
		i++;
		return negated ? complement(folded(s)) : folded(s);
	};
	const quantifier = (): { min: number; max: number } | undefined => {
		const c = source[i];
		let q: { min: number; max: number } | undefined;
		if (c === '*' || c === '+' || c === '?') {
			i++;
			q = { min: c === '+' ? 1 : 0, max: c === '?' ? 1 : Infinity };
		} else if (c === '{') {
			const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
			if (m) {
				i += m[0].length;
				const min = Number(m[1]);
				q = { min, max: m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]) };
			}
		}
		if (q && source[i] === '?') {
			i++;
		}
		return q;
	};
	const alternatives = (): RegexItem[][] => {
		const alts: RegexItem[][] = [[]];
		while (i < source.length && source[i] !== ')') {
			const c = source[i++];
			let node: RegexNode;
			if (c === '|') {
				alts.push([]);
				continue;
			} else if (c === '^' || c === '$') {
				node = { kind: 'assertion' };
			} else if (c === '.') {
				node = { kind: 'chars', chars: allChars(), backReference: false };
			} else if (c === '[') {
				node = { kind: 'chars', chars: charClass(), backReference: false };
			} else if (c === '(') {
				// `(?=`, `(?!`, `(?<=`, `(?<!` are lookarounds; `(?:`, `(?<name>`, `(?i:` plain groups.
				const prefix = /^\?(?:(=|!|<=|<!)|:|<[^>=!]*>|[a-zA-Z]*(?:-[a-zA-Z]*)?:)/.exec(source.slice(i));
				i += prefix ? prefix[0].length : 0;
				const lookaround = prefix?.[1] !== undefined;
				const inner = alternatives();
				i++;
				node = { kind: 'group', alternatives: inner, lookaround };
			} else if (c === '\\') {
				const next = source[i];
				if (next === 'b' || next === 'B') {
					i++;
					node = { kind: 'assertion' };
				} else if ((/[1-9]/.test(next ?? '') && Number(/^\d+/.exec(source.slice(i))?.[0]) <= groups.length) || (next === 'k' && namedGroups)) {
					// A back-reference (`\1`, `\k<name>`): it can match anything, of any length.
					const m = /^(?:\d+|k<[^>]*>?)/.exec(source.slice(i));
					i += m ? m[0].length : 1;
					node = { kind: 'chars', chars: allChars(), backReference: true };
				} else if (/[1-7]/.test(next ?? '')) {
					// With fewer groups, `\1`–`\377` is an octal escape (`\8`, `\9` are the digit, below).
					const m = /^(?:[0-3][0-7]{0,2}|[4-7][0-7]?)/.exec(source.slice(i));
					const digits = m?.[0] ?? next;
					i += digits.length;
					const code = parseInt(digits, 8);
					node = { kind: 'chars', chars: folded(charsOf([[code, code]])), backReference: false };
				} else {
					const e = escape(false);
					node = { kind: 'chars', chars: typeof e === 'number' ? folded(charsOf([[e, e]])) : folded(e), backReference: false };
				}
			} else {
				node = { kind: 'chars', chars: folded(charsOf([[c.charCodeAt(0), c.charCodeAt(0)]])), backReference: false };
			}
			const q = quantifier();
			alts[alts.length - 1].push({ node, quantified: q !== undefined, min: q?.min ?? 1, max: q?.max ?? 1 });
		}
		return alts;
	};
	const top: RegexItem[][] = [];
	// A stray `)` (an invalid pattern, refused when compiled): read on after it.
	while (i <= source.length) {
		top.push(...alternatives());
		i++;
	}
	return top;
}

/**
 * A quantified item whose count can vary (`*`, `+`, `?`, `{n,}`, `{n,m}` with m > n: a chain of
 * `a?` or `a{1,2}` multiplies the tries too); a back-reference always. `{n}` is not.
 */
const isRepeat = (item: RegexItem) => (item.node.kind === 'chars' && item.node.backReference) || (item.quantified && item.max > item.min);

const charsInMemo = new WeakMap<readonly (readonly RegexItem[])[], CharSet>();

/** Every character an item of `alts` can match. */
function charsIn(alts: readonly (readonly RegexItem[])[]): CharSet {
	const known = charsInMemo.get(alts);
	if (known) {
		return known;
	}
	const s = noChars();
	for (const item of alts.flat()) {
		if (item.node.kind === 'chars') {
			unionInto(s, item.node.chars);
		} else if (item.node.kind === 'group' && !item.node.lookaround) {
			unionInto(s, charsIn(item.node.alternatives));
		}
	}
	charsInMemo.set(alts, s);
	return s;
}

/** Whether `alts` hold a quantifier or an alternation, at any depth. */
const holdsVariation = (alts: readonly (readonly RegexItem[])[]): boolean =>
	alts.length > 1 || alts.flat().some((item) => item.quantified || (item.node.kind === 'group' && holdsVariation(item.node.alternatives)));

/** The 6.4 rule's repeat of a group: `*`, `+`, `{n,}`, any `{n,m}` but `{0,1}`, or `{n}` with n ≥ 10. */
const repeatsGroup = (item: RegexItem) => item.quantified && item.max > 1 && (item.max > item.min || item.min >= 10);

class Refused extends Error {}

/**
 * The repeats' characters after `alts`, walked from `pending` (the characters of the repeats since the
 * last separator); throws `Refused` for a slow shape.
 */
function walk(alts: readonly (readonly RegexItem[])[], pending: CharSet): CharSet {
	// Memoised per (group, pending), so a nested `(…){2}` is not walked 2^depth times.
	let byPending = walkMemo.get(alts);
	if (!byPending) {
		byPending = new Map();
		walkMemo.set(alts, byPending);
	}
	const key = pending.join(',');
	const known = byPending.get(key);
	if (known) {
		return known;
	}
	const ends = walkUncached(alts, pending);
	byPending.set(key, ends);
	return ends;
}

const walkMemo = new WeakMap<readonly (readonly RegexItem[])[], Map<string, CharSet>>();

function walkUncached(alts: readonly (readonly RegexItem[])[], pending: CharSet): CharSet {
	const ends = noChars();
	for (const seq of alts) {
		let p = pending;
		for (const item of seq) {
			p = step(item, p);
		}
		unionInto(ends, p);
	}
	return ends;
}

function step(item: RegexItem, p: CharSet): CharSet {
	const { node } = item;
	if (node.kind === 'assertion') {
		return p;
	}
	if (node.kind === 'group') {
		if (node.lookaround) {
			// Zero-width: its content is checked from here (`\w+(?=.*x)` backtracks both), and leaves P as it was.
			walk(node.alternatives, p);
			return p;
		}
		if (!item.quantified) {
			return walk(node.alternatives, p);
		}
		if (repeatsGroup(item) && holdsVariation(node.alternatives)) {
			return refuse();
		}
		if (!isRepeat(item)) {
			// `(…){n}`: its content in place, twice when n ≥ 2.
			let q = p;
			for (let n = 0; n < Math.min(item.max, 2); n++) {
				q = walk(node.alternatives, q);
			}
			return q;
		}
		walk(node.alternatives, noChars());
		return repeatStep(item, charsIn(node.alternatives), p);
	}
	if (isRepeat(item)) {
		return repeatStep(item, node.chars, p);
	}
	if (item.min === 0) {
		return p;
	}
	return overlaps(node.chars, p) ? p : noChars();
}

function repeatStep(item: RegexItem, chars: CharSet, p: CharSet): CharSet {
	if (overlaps(chars, p)) {
		return refuse();
	}
	return item.min === 0 ? union(p, chars) : chars;
}

const refuse = (): never => {
	throw new Refused();
};

/**
 * Whether `source` could backtrack for a very long time on a long value, so the search refuses it:
 * - a repeated group that holds a quantifier or an alternation (`(a+)+`, `(a|aa)*`, `(?:x{2,})*`);
 * - two repeats (`*`, `+`, `?`, `{n,}`, `{n,m}` with m > n, a back-reference) whose characters meet,
 *   with nothing required between them that neither can match, at any depth, lookarounds included:
 *   `.*.*x`, `\w+\w+x`, `a*a*x`, `.*a.*b` (`a` is in `.`), `.{1,100}.{1,100}`, `.*a?a?b`, `(?<n>.*)\k<n>`.
 * Repeats of characters that cannot meet pass (`\w+\s+\w+`, `\d+\s*ms`, `a+b*`, `[^a]+a+`), as do
 * single quantifiers, `{n}` and a range after nothing it meets (`\d{1,3}`, `\d{1,3}\.\d{1,3}`). Letters
 * count in both cases, whatever the flags. Nested too deep to check counts as refused.
 */
export function slowPattern(source: string): boolean {
	try {
		walk(regexItems(source), noChars());
		return false;
	} catch (err) {
		// Refused, or nested too deep to check (a RangeError): refused. Anything else is malformed input,
		// left for `new RegExp` to report.
		return err instanceof Refused || err instanceof RangeError;
	}
}

/**
 * The search as a regular expression (`global` for highlighting), `undefined` for an empty search, or
 * why a regular expression is refused (`{ error }`: invalid, or `slowPattern`). Without Match case it ignores case.
 */
export function searchPattern(text: string, matchCase: boolean, regex: boolean, global = false): RegExp | undefined | { readonly error: string } {
	if (text === '') {
		return undefined;
	}
	if (regex && slowPattern(text)) {
		return { error: SLOW_PATTERN_ERROR };
	}
	const flags = `${global ? 'g' : ''}${matchCase ? '' : 'i'}`;
	try {
		return new RegExp(regex ? text : escapeRegExp(text), flags);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/** Why the filter's search is refused (an invalid regular expression), or `undefined`. */
export function searchError(filter: Pick<LogFilter, 'text' | 'matchCase' | 'regex'>): string | undefined {
	const p = searchPattern(filter.text, filter.matchCase, filter.regex);
	return p !== undefined && !(p instanceof RegExp) ? p.error : undefined;
}

/** How many of the pipeline's records were read in the range, per level, and how many match (ticket 6.4). */
export interface LogCounts {
	readonly levels: Readonly<Record<LogLevel, number>>;
	/** Every record of the pipeline read (the "M" of "N of M records match"). */
	readonly total: number;
	/** Those that match the filter. */
	readonly matched: number;
}

export const NO_COUNTS: LogCounts = { levels: { error: 0, warn: 0, info: 0, debug: 0, other: 0 }, total: 0, matched: 0 };

/**
 * The time-range menu's choices (ticket 6.3, board 5). `live`: from now on; `recent`: the last
 * 15 minutes, then live (the default); `hour`, `day`, `week`: the last hour, 24 hours, 7 days, read to
 * now and then stopped; `deploy`: since the pipeline's last deploy (its `update_time`), then live;
 * `custom`: From to To, then stopped.
 */
export const RANGE_KINDS = ['live', 'recent', 'hour', 'day', 'week', 'deploy', 'custom'] as const;
export type RangeKind = (typeof RANGE_KINDS)[number];

export const RANGE_LABELS: Readonly<Record<RangeKind, string>> = {
	live: 'Live (from now on)',
	recent: 'Last 15 minutes, then live',
	hour: 'Last hour',
	day: 'Last 24 hours',
	week: 'Last 7 days',
	deploy: 'Since the last deploy',
	custom: 'Custom range…',
};

/** The ranges that follow new records once read (Live on). */
export function isLiveRange(kind: RangeKind): boolean {
	return kind === 'live' || kind === 'recent' || kind === 'deploy';
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
/** Two shown records this far apart or more get a gap note between them. */
export const GAP_MS = 30 * MINUTE_MS;

/** The range the panel reads: `from` and `to` in milliseconds since the epoch; `to` is `null` for a range that goes on live. */
export interface LogsRange {
	readonly kind: RangeKind;
	readonly from: number;
	readonly to: number | null;
}

/**
 * Ticket 6.6 (board 6): the state that fills the panel's list area (the toolbar stays). Every name in it
 * is masked by the host. `none`: the records (or 6.4's "No records match"). `noAccess`: the cluster has no
 * log access set. `signIn`: the stored user could not sign in (Kafka 58). `notAllowed`: the user may not
 * read the topic. `noRecords`: a range read to its end with none of the pipeline's records, or only
 * records of hidden levels (`hiddenLevels`, for Show every level). `reading`: a bounded range or Load
 * older reads (`count`: the pipeline's records read so far; Stop reading). `connectionLost`: retried after
 * `retryInS` (at `retryAt`, ms since the epoch; `null` while it tries, or while the tab is hidden).
 * `stopped` (bug 52): reading was stopped for `reason` (the service account was disconnected or changed);
 * nothing is read until Show logs is used again.
 */
export type LogsPanelState =
	| { readonly kind: 'none' }
	| { readonly kind: 'noAccess'; readonly cluster: string; readonly topic: string }
	| { readonly kind: 'signIn'; readonly user: string; readonly cluster: string }
	| { readonly kind: 'notAllowed'; readonly user: string; readonly topic: string }
	| { readonly kind: 'noRecords'; readonly pipeline: string; readonly range: string; readonly hiddenLevels: readonly LogLevel[] }
	| { readonly kind: 'reading'; readonly what: string; readonly count: number }
	| { readonly kind: 'connectionLost'; readonly cluster: string; readonly live: boolean; readonly retryInS: number; readonly retryAt: number | null }
	| { readonly kind: 'stopped'; readonly reason: string };

export const NO_PANEL_STATE: LogsPanelState = { kind: 'none' };

/** Bug 52: the Stopped state's text (the records already shown stay). */
export const STOPPED_BODY = 'The records already shown stay. Use Show logs on a pipeline in the Cloud view to read its log again.';

/** A lost connection is tried again after these waits, then every last one (ticket 6.6, the user's decision of 2026-11-06). */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 30_000, 60_000];

/** The wait before try `attempt` (1 for the first after the loss). */
export function retryDelayMs(attempt: number, delays: readonly number[] = RETRY_DELAYS_MS): number {
	return delays[Math.min(Math.max(attempt, 1), delays.length) - 1];
}

/** "Trying again in 5 s.", "Trying again…" (`null`: trying now). */
export function retryText(seconds: number | null): string {
	return seconds === null ? 'Trying again…' : `Trying again in ${seconds} s.`;
}

/** "2,140 records so far". */
export function soFarText(count: number): string {
	return `${count.toLocaleString('en-US')} ${count === 1 ? 'record' : 'records'} so far`;
}

/** A state's small label, title and text, as board 6 has them (the countdown: `retrySeconds`, else the state's wait). */
export function panelStateTexts(state: LogsPanelState, retrySeconds?: number | null): { readonly label: string; readonly title: string; readonly body: string } | undefined {
	switch (state.kind) {
		case 'none':
			return undefined;
		case 'noAccess':
			return {
				label: 'No log access', title: `${state.cluster} has no log access set`,
				body: `Logs are read from the cluster's ${state.topic} topic, with a Redpanda user that may read it.`,
			};
		case 'signIn':
			return {
				label: 'Sign-in refused', title: `${state.user} could not sign in to ${state.cluster}`,
				body: 'The cluster refused the sign-in (SASL authentication failed). The username, password or mechanism is wrong.',
			};
		case 'notAllowed':
			return {
				label: 'Not allowed', title: `${state.user} may not read the logs topic`,
				body: `The cluster refused reading ${state.topic}. An admin can grant Read on it in the Cloud UI's ACLs.`,
			};
		case 'noRecords':
			return {
				label: 'No records', title: `No records for ${state.pipeline} in ${state.range}`,
				body: state.hiddenLevels.length > 0
					? `It wrote only levels that are hidden (${state.hiddenLevels.map((l) => LEVEL_LABELS[l]).join(', ')}).`
					: 'It may not have started yet, or it wrote nothing in this range.',
			};
		case 'reading':
			return { label: 'Reading', title: state.what, body: 'The list fills as the records come.' };
		case 'connectionLost': {
			const seconds = retrySeconds === undefined ? (state.retryAt === null ? null : state.retryInS) : retrySeconds;
			return {
				label: 'Connection lost', title: `Lost the connection to ${state.cluster}`,
				body: `${state.live ? 'Live is paused' : 'Reading is paused'}; the records already shown stay. ${retryText(seconds)}`,
			};
		}
		case 'stopped':
			return { label: 'Stopped', title: state.reason, body: STOPPED_BODY };
	}
}

/**
 * Ticket 6.7 (board 5): the slot sizes of the records-per-time strip, smallest first. A range gets the
 * smallest that gives it at most `MAX_STRIP_SLOTS` slots (about 30 to 60 bars).
 */
export const SLOT_SIZES_MS: readonly number[] = [
	MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS,
	HOUR_MS, 2 * HOUR_MS, 4 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS, DAY_MS,
];
export const MAX_STRIP_SLOTS = 60;

/**
 * The slot size for a strip spanning `spanMs`: the smallest of `SLOT_SIZES_MS` with at most
 * `MAX_STRIP_SLOTS` slots; past 60 days (beyond the list), whole days so that it stays at 60.
 */
export function slotSize(spanMs: number): number {
	const span = Math.max(0, spanMs);
	for (const size of SLOT_SIZES_MS) {
		if (Math.ceil(span / size) <= MAX_STRIP_SLOTS) {
			return size;
		}
	}
	return Math.ceil(span / (MAX_STRIP_SLOTS * DAY_MS)) * DAY_MS;
}

/**
 * Where a strip's slots lie: `start` (a whole minute), `size`, `count`; the first slot begins at `from`
 * (the range read), the last ends at `end`.
 */
export interface StripLayout {
	readonly start: number;
	readonly from: number;
	readonly size: number;
	readonly count: number;
	readonly end: number;
}

/**
 * The slots of a strip from `from` to `end`: the size from the span, the start floored to the minute
 * (so the host's per-minute counts fall in whole slots), as many slots as the span needs.
 */
export function stripLayout(from: number, end: number): StripLayout {
	const to = Math.max(from, end);
	const size = slotSize(to - from);
	return { start: Math.floor(from / MINUTE_MS) * MINUTE_MS, from, size, count: Math.max(1, Math.ceil((to - from) / size)), end: to };
}

/** The slot `time` falls in, counted from `start` (may be out of the strip: the caller clamps). */
export function slotOf(time: number, start: number, size: number): number {
	return Math.floor((time - start) / size);
}

/**
 * Slot `index`'s times within the span read: `from` and `to` inclusive (a custom range); the first one
 * begins at the strip's `from`, the last ends at its `end` (never past what was read).
 */
export function slotBounds(layout: Pick<StripLayout, 'start' | 'from' | 'size' | 'end'>, count: number, index: number): { readonly from: number; readonly to: number } {
	const begin = layout.start + index * layout.size;
	const from = index === 0 ? Math.max(begin, layout.from) : begin;
	return { from, to: index === count - 1 ? layout.end : Math.min(layout.end, begin + layout.size - 1) };
}

/** "per minute", "per 30 minutes", "per 4 hours", "per day", "per 2 days". */
export function slotSizeText(size: number): string {
	const unit = (n: number, one: string) => (n === 1 ? `per ${one}` : `per ${n.toLocaleString('en-US')} ${one}s`);
	if (size % DAY_MS === 0) {
		return unit(size / DAY_MS, 'day');
	}
	if (size % HOUR_MS === 0) {
		return unit(size / HOUR_MS, 'hour');
	}
	return unit(Math.round(size / MINUTE_MS), 'minute');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 5 14:00", in local time: the strip's axis and its bars' names. */
export function shortTime(ms: number): string {
	const d = new Date(ms);
	return `${MONTHS[d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Nov 5 14:00–14:30", or "Nov 5 20:00–Nov 6 00:00" across midnight (`end` exclusive). */
export function slotTimeText(from: number, end: number): string {
	const a = new Date(from);
	const b = new Date(end);
	const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
	return `${shortTime(from)}–${sameDay ? shortTime(end).slice(shortTime(end).lastIndexOf(' ') + 1) : shortTime(end)}`;
}

/**
 * A bar's accessible name: "Nov 5 14:00–14:30: 120 records, 3 errors, 1 warning" (the errors and
 * warnings when there are some; with a filter on, how many match).
 */
export function slotLabel(from: number, end: number, counts: { readonly total: number; readonly errors: number; readonly warns: number; readonly matched: number }, filtered: boolean): string {
	const n = (v: number, one: string) => `${v.toLocaleString('en-US')} ${one}${v === 1 ? '' : 's'}`;
	const parts = [counts.total === 0 ? 'no records' : n(counts.total, 'record')];
	if (counts.errors > 0) {
		parts.push(n(counts.errors, 'error'));
	}
	if (counts.warns > 0) {
		parts.push(n(counts.warns, 'warning'));
	}
	if (filtered && counts.total > 0) {
		parts.push(`${counts.matched.toLocaleString('en-US')} ${counts.matched === 1 ? 'matches' : 'match'}`);
	}
	return `${slotTimeText(from, end)}: ${parts.join(', ')}`;
}

/** At most this many slots in a posted strip (the validator's bound). */
export const MAX_POSTED_SLOTS = 10_000;

/**
 * Ticket 6.7: the records-per-time strip of a bounded range (board 5): its layout (`start`, `size`, the
 * last slot to `end`) and per slot every record of the pipeline read (`total`), its ERROR and WARN ones
 * (the level chips' levels) and those matching the filter. `null` for the live ranges.
 */
export interface LogStrip {
	readonly start: number;
	/** Where the span read begins (the first slot's start). */
	readonly from: number;
	readonly size: number;
	readonly end: number;
	readonly total: readonly number[];
	readonly errors: readonly number[];
	readonly warns: readonly number[];
	readonly matched: readonly number[];
}

/** The panel's reading state beside its rows (ticket 6.3). */
export interface LogsViewState {
	readonly range: LogsRange;
	/** Following new records (the Live toggle). */
	readonly live: boolean;
	/** The range's read has ended (an empty list then says "No records <from> – <to>"). */
	readonly done: boolean;
	/** Load older records: offered, reading, or the log's first record is shown ("No older records"). */
	readonly older: 'more' | 'reading' | 'none';
	/** Why the last Load older failed ("Could not load older records: …"), until the next action; else `null`. */
	readonly olderError: string | null;
	/**
	 * With a filter on, Load older searched back as far as one click goes without a match: "No matches
	 * back to <time>; Load older to search further", until the next action; else `null`.
	 */
	readonly olderNote: string | null;
	/** How many of the newest rows Load older dropped for the cap (Live then paused). */
	readonly newerDropped: number;
	/** The menu's retention line; `null` until it is read (the menu opened). */
	readonly retention: string | null;
	/** The pipeline's last deploy as last read, for the menu's "Since the last deploy (…)"; `null`: unknown. */
	readonly deployedAt: number | null;
	/** Where Load older reads back from (the button's "before …"). */
	readonly olderBefore: number;
	/** The filter applied (ticket 6.4). */
	readonly filter: LogFilter;
	/** The level chips' counts and "N of M records match". */
	readonly counts: LogCounts;
	/** Ticket 6.5: the ERROR records are highlighted (opened from an Error: its notification, or around the error). */
	readonly highlightErrors: boolean;
	/** Ticket 6.5: the row to scroll to and mark (the error "around the error" found), until the next range; else `null`. */
	readonly focusId: string | null;
	/** Ticket 6.5: a note above the records ("No ERROR record in the last 24 hours"), until the next range; else `null`. */
	readonly note: string | null;
	/** Ticket 6.6: the state that fills the list area. */
	readonly panelState: LogsPanelState;
	/** Ticket 6.6: Stop reading ended the range's read early (an empty list is not "No records"). */
	readonly stoppedShort: boolean;
	/** Ticket 6.6: Set up log access runs for the shown pipeline's cluster (its buttons are disabled). */
	readonly settingUp: boolean;
	/** Ticket 6.7: the records-per-time strip, for a bounded range (and Since the last deploy); else `null`. */
	readonly strip: LogStrip | null;
	/**
	 * Bug 51: records left out for the cap between two shown rows (the tail at the cap while Load older
	 * read): one marker row before the row `before` (its id), "N records left out here". Counted in the
	 * footer's left-out total. Absent or empty: none.
	 */
	readonly leftOutHere?: readonly { readonly before: string; readonly count: number }[];
}

/** Bug 51: the marker row of records left out for the cap between two shown rows. */
export function leftOutHereText(count: number): string {
	return `${count.toLocaleString('en-US')} ${count === 1 ? 'record' : 'records'} left out here`;
}

export type LogsHostMessage =
	/**
	 * The whole state: the pipeline (`title`: "<pipeline> · <cluster>"; `null`: none chosen yet), every
	 * kept row (oldest first), how many older ones were left out for the cap, the reading status line,
	 * and the range and its reading.
	 */
	| { readonly type: 'show'; readonly title: string | null; readonly rows: readonly LogRow[]; readonly dropped: number; readonly cap: number; readonly status: string; readonly state: LogsViewState }
	/** New rows for the shown pipeline, oldest first; `dropped`: how many older ones are left out now. */
	| { readonly type: 'append'; readonly rows: readonly LogRow[]; readonly dropped: number }
	/**
	 * Older rows (Load older), oldest first, before the shown ones; then at most the cap are kept, the
	 * newest dropped. `dropped`: how many older ones are left out now.
	 */
	| { readonly type: 'prepend'; readonly rows: readonly LogRow[]; readonly dropped: number }
	| { readonly type: 'status'; readonly status: string }
	| { readonly type: 'state'; readonly state: LogsViewState };

/** A range the webview asks for: `from` and `to` only for `custom`. */
export interface RangeChoice {
	readonly kind: RangeKind;
	readonly from?: number;
	readonly to?: number;
}

export type LogsWebviewMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'rangeChosen'; readonly range: RangeChoice }
	| { readonly type: 'olderRequested' }
	| { readonly type: 'liveToggled'; readonly live: boolean }
	/** The menu opened: the host reads the topic's retention once per pipeline. */
	| { readonly type: 'retentionRequested' }
	/** Ticket 6.4: the levels, the search or the chips changed; the host reads the range again. */
	| { readonly type: 'filterChanged'; readonly filter: LogFilter }
	/** Show records around this one: 5 minutes before and after the row's time, the filter cleared, Live off. */
	| { readonly type: 'aroundRequested'; readonly id: string }
	/** Copy JSON where the webview cannot write the clipboard itself: the host copies the row's JSON. */
	| { readonly type: 'copyRequested'; readonly id: string }
	/** Ticket 6.6: Stop reading (a bounded range or Load older): the records read stay, the read ends. */
	| { readonly type: 'stopReading' }
	/** Ticket 6.6: Retry (a refused sign-in, a missing permission) and Retry now (a lost connection). */
	| { readonly type: 'retryNow' }
	/** Ticket 6.6: Set up log access…, Set up log access again… (6.2's flow for the shown pipeline's cluster). */
	| { readonly type: 'setUpAccess' }
	/** Ticket 6.6: Use another user… (the same flow). */
	| { readonly type: 'useAnotherUser' }
	/** Ticket 6.6: No records' Show every level: the level filter cleared. */
	| { readonly type: 'showEveryLevel' }
	/** Ticket 6.6: No records' Last 24 hours. */
	| { readonly type: 'last24h' }
	/** Ticket 6.7: a bar of the strip: its slot's times as drawn (inclusive), read as a custom range, the filter kept. */
	| { readonly type: 'slotChosen'; readonly from: number; readonly to: number }
	/** Ticket 6.8: Export…: the host saves the rows it shows (a snapshot) as JSON lines, through the save dialog. */
	| { readonly type: 'exportRequested' };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function isRow(v: unknown): v is LogRow {
	return isObject(v) && typeof v.id === 'string' && typeof v.time === 'number' && typeof v.level === 'string'
		&& typeof v.message === 'string' && typeof v.instance === 'string' && Array.isArray(v.fields)
		&& v.fields.every((f) => Array.isArray(f) && f.length === 2 && typeof f[0] === 'string' && typeof f[1] === 'string')
		&& (v.raw === undefined || v.raw === true) && (v.json === undefined || typeof v.json === 'string');
}

const isLevel = (v: unknown): v is LogLevel => typeof v === 'string' && (LOG_LEVELS as readonly string[]).includes(v);

/** A filter as posted, or `undefined` for anything malformed or a search that is not a valid regular expression. */
export function parseLogFilter(v: unknown): LogFilter | undefined {
	if (!isObject(v) || !Array.isArray(v.levels) || !v.levels.every(isLevel) || new Set(v.levels).size !== v.levels.length
		|| typeof v.text !== 'string' || v.text.length > MAX_SEARCH_LENGTH || typeof v.matchCase !== 'boolean' || typeof v.regex !== 'boolean'
		|| !Array.isArray(v.fields) || v.fields.length > MAX_FIELD_FILTERS
		|| !v.fields.every((f) => Array.isArray(f) && f.length === 2 && typeof f[0] === 'string' && typeof f[1] === 'string')) {
		return undefined;
	}
	const filter: LogFilter = {
		levels: LOG_LEVELS.filter((l) => (v.levels as LogLevel[]).includes(l)),
		text: v.text, matchCase: v.matchCase, regex: v.regex,
		fields: (v.fields as [string, string][]).map(([k, val]) => [k, val] as const),
	};
	return searchError(filter) === undefined ? filter : undefined;
}

function isCounts(v: unknown): v is LogCounts {
	return isObject(v) && isObject(v.levels) && LOG_LEVELS.every((l) => isCount((v.levels as Record<string, unknown>)[l]))
		&& isCount(v.total) && isCount(v.matched);
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isKind = (v: unknown): v is RangeKind => typeof v === 'string' && (RANGE_KINDS as readonly string[]).includes(v);

const isText = (v: unknown): v is string => typeof v === 'string';

function isPanelState(v: unknown): v is LogsPanelState {
	if (!isObject(v)) {
		return false;
	}
	switch (v.kind) {
		case 'none':
			return true;
		case 'noAccess':
			return isText(v.cluster) && isText(v.topic);
		case 'signIn':
			return isText(v.user) && isText(v.cluster);
		case 'notAllowed':
			return isText(v.user) && isText(v.topic);
		case 'noRecords':
			return isText(v.pipeline) && isText(v.range) && Array.isArray(v.hiddenLevels) && v.hiddenLevels.every(isLevel);
		case 'reading':
			return isText(v.what) && isCount(v.count);
		case 'connectionLost':
			return isText(v.cluster) && typeof v.live === 'boolean' && isCount(v.retryInS) && (v.retryAt === null || isTime(v.retryAt));
		case 'stopped':
			return isText(v.reason);
		default:
			return false;
	}
}

function isStrip(v: unknown): v is LogStrip {
	if (!isObject(v) || !isTime(v.start) || !isTime(v.from) || !isTime(v.end) || v.from < v.start || v.end < v.from
		|| !isCount(v.size) || v.size <= 0 || v.size % MINUTE_MS !== 0) {
		return false;
	}
	const counts = [v.total, v.errors, v.warns, v.matched];
	if (!counts.every((c) => Array.isArray(c) && c.every(isCount))) {
		return false;
	}
	const total = v.total as number[];
	const n = total.length;
	// A slot's errors, warnings and matches are each among its records.
	return n > 0 && n <= MAX_POSTED_SLOTS && counts.every((c) => (c as number[]).length === n && (c as number[]).every((x, i) => x <= total[i]));
}

function isState(v: unknown): v is LogsViewState {
	if (!isObject(v) || !isObject(v.range)) {
		return false;
	}
	const r = v.range;
	return isKind(r.kind) && isTime(r.from) && (r.to === null || isTime(r.to))
		&& typeof v.live === 'boolean' && typeof v.done === 'boolean' && (v.older === 'more' || v.older === 'reading' || v.older === 'none')
		&& (v.olderError === null || typeof v.olderError === 'string') && (v.olderNote === null || typeof v.olderNote === 'string') && isCount(v.newerDropped) && (v.retention === null || typeof v.retention === 'string') && (v.deployedAt === null || isTime(v.deployedAt))
		&& isTime(v.olderBefore) && parseLogFilter(v.filter) !== undefined && isCounts(v.counts)
		&& typeof v.highlightErrors === 'boolean' && (v.focusId === null || typeof v.focusId === 'string') && (v.note === null || typeof v.note === 'string')
		&& isPanelState(v.panelState) && typeof v.stoppedShort === 'boolean' && typeof v.settingUp === 'boolean'
		&& (v.strip === null || isStrip(v.strip))
		&& (v.leftOutHere === undefined || (Array.isArray(v.leftOutHere) && v.leftOutHere.every((g) => isObject(g) && typeof g.before === 'string' && isCount(g.count) && g.count > 0)));
}

/** A host message, or `undefined` for anything malformed. */
export function parseLogsHostMessage(v: unknown): LogsHostMessage | undefined {
	if (!isObject(v)) {
		return undefined;
	}
	switch (v.type) {
		case 'show':
			return (v.title === null || typeof v.title === 'string') && Array.isArray(v.rows) && v.rows.every(isRow)
				&& isCount(v.dropped) && isCount(v.cap) && v.cap > 0 && typeof v.status === 'string' && isState(v.state)
				? v as LogsHostMessage : undefined;
		case 'append':
		case 'prepend':
			return Array.isArray(v.rows) && v.rows.every(isRow) && isCount(v.dropped) ? v as LogsHostMessage : undefined;
		case 'status':
			return typeof v.status === 'string' ? v as LogsHostMessage : undefined;
		case 'state':
			return isState(v.state) ? v as LogsHostMessage : undefined;
		default:
			return undefined;
	}
}

/** A webview message, or `undefined` for anything malformed (the host's check). */
export function parseLogsWebviewMessage(v: unknown): LogsWebviewMessage | undefined {
	if (!isObject(v)) {
		return undefined;
	}
	switch (v.type) {
		case 'ready':
		case 'olderRequested':
		case 'retentionRequested':
		case 'stopReading':
		case 'retryNow':
		case 'setUpAccess':
		case 'useAnotherUser':
		case 'showEveryLevel':
		case 'last24h':
		case 'exportRequested':
			return { type: v.type };
		case 'liveToggled':
			return typeof v.live === 'boolean' ? { type: 'liveToggled', live: v.live } : undefined;
		case 'slotChosen':
			return isTime(v.from) && isTime(v.to) && v.from < v.to ? { type: 'slotChosen', from: v.from, to: v.to } : undefined;
		case 'filterChanged': {
			const filter = parseLogFilter(v.filter);
			return filter ? { type: 'filterChanged', filter } : undefined;
		}
		case 'aroundRequested':
		case 'copyRequested':
			return typeof v.id === 'string' && v.id.length > 0 ? { type: v.type, id: v.id } : undefined;
		case 'rangeChosen': {
			const r = v.range;
			if (!isObject(r) || !isKind(r.kind)) {
				return undefined;
			}
			if (r.kind === 'custom') {
				return isTime(r.from) && isTime(r.to) ? { type: 'rangeChosen', range: { kind: 'custom', from: r.from, to: r.to } } : undefined;
			}
			return { type: 'rangeChosen', range: { kind: r.kind } };
		}
		default:
			return undefined;
	}
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `2026-11-05 16:49`, in local time: the menu's and the gap notes' form. */
export function localMinute(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A local date-time typed in the Custom range's From or To: `YYYY-MM-DD HH:MM`, optionally with
 * `:SS`, or `YYYY-MM-DD` (midnight); a `T` may stand for the space. `undefined` when it is not one
 * (a day or hour that does not exist included).
 */
export function parseLocalDateTime(text: string): number | undefined {
	const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?\s*$/.exec(text);
	if (!m) {
		return undefined;
	}
	const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number);
	const date = new Date(y, mo - 1, d, h, mi, s);
	// `Date` rolls over (Feb 30 → Mar 2): refuse what does not read back the same.
	if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi) {
		return undefined;
	}
	return date.getTime();
}

/** Why a Custom range is refused, or `undefined` when it can be read. */
export function customRangeError(fromText: string, toText: string, now: number): string | undefined {
	const from = parseLocalDateTime(fromText);
	const to = parseLocalDateTime(toText);
	if (from === undefined) {
		return 'From is not a date and time (YYYY-MM-DD HH:MM).';
	}
	if (to === undefined) {
		return 'To is not a date and time (YYYY-MM-DD HH:MM).';
	}
	if (from > now) {
		return 'From is in the future.';
	}
	if (to < from) {
		return 'To is before From.';
	}
	return undefined;
}

/** "No records <from> – <to>". */
export function noRecordsText(from: number, to: number): string {
	return `No records ${localMinute(from)} – ${localMinute(to)}`;
}

/**
 * Where the gap notes go: for each pair of neighbouring rows `GAP_MS` or more apart, the index of
 * the later row and the two times. Rows are oldest first.
 */
export function gapsIn(rows: readonly Pick<LogRow, 'time'>[], minGapMs = GAP_MS): { readonly before: number; readonly from: number; readonly to: number }[] {
	const out: { before: number; from: number; to: number }[] = [];
	for (let i = 1; i < rows.length; i++) {
		if (rows[i].time - rows[i - 1].time >= minGapMs) {
			out.push({ before: i, from: rows[i - 1].time, to: rows[i].time });
		}
	}
	return out;
}
