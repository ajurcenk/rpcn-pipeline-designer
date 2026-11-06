// The host<->webview contract of the Pipeline Logs panel (AD-5, AD-24, tickets 6.2, 6.3, 6.4, 6.5): every
// message of the third webview, as discriminated unions on `type`, plus the validators each side uses on
// what it receives, and the pure rules both share (the range menu's choices, local date-times, the gap
// notes; ticket 6.4: the levels, the filter and its search pattern). The panel adapter (`src/adapters/vscode/logsPanel.ts`), the record shaping
// (`src/adapters/logs/records.ts`) and `webview/src/logs` import it. Imports nothing (AD-15).

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

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Why a regular expression that could backtrack for a very long time is refused. */
export const SLOW_PATTERN_ERROR = 'This pattern could take too long; simplify it';
/** At most this many characters of each value are searched. */
export const MAX_MATCH_CHARS = 10_000;

/**
 * Whether `source` has a quantified group that holds a quantifier or an alternation (`(a+)+`, `(a*)*`,
 * `(a|aa)+`, `(?:x{2,})*`), the shape whose backtracking can block for a very long time.
 */
export function slowPattern(source: string): boolean {
	/** Per open group: whether it holds a quantifier or an alternation. */
	const stack: boolean[] = [];
	const quantifierAt = (i: number) => source[i] === '*' || source[i] === '+' || source[i] === '?' || (source[i] === '{' && /^\{\d+(,\d*)?\}/.test(source.slice(i)));
	const repeatsAt = (i: number) => source[i] === '*' || source[i] === '+' || (source[i] === '{' && /^\{\d+,\d*\}|^\{\d{2,}\}/.test(source.slice(i)));
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === '\\') {
			i++;
		} else if (c === '[') {
			// A class: to its closing `]` (escapes skipped).
			for (i++; i < source.length && source[i] !== ']'; i++) {
				if (source[i] === '\\') {
					i++;
				}
			}
		} else if (c === '(') {
			stack.push(false);
			if (source[i + 1] === '?') {
				// `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>`: skip the prefix.
				const m = /^\?(?::|=|!|<=|<!|<[^>]*>)/.exec(source.slice(i + 1));
				i += m ? m[0].length : 1;
			}
		} else if (c === ')') {
			const inner = stack.pop() ?? false;
			const repeated = repeatsAt(i + 1);
			if (inner && repeated) {
				return true;
			}
			if (stack.length > 0 && (inner || quantifierAt(i + 1))) {
				stack[stack.length - 1] = true;
			}
		} else if (c === '|') {
			if (stack.length > 0) {
				stack[stack.length - 1] = true;
			}
		} else if (quantifierAt(i) && stack.length > 0) {
			stack[stack.length - 1] = true;
		}
	}
	return false;
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
	| { readonly type: 'copyRequested'; readonly id: string };

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

function isState(v: unknown): v is LogsViewState {
	if (!isObject(v) || !isObject(v.range)) {
		return false;
	}
	const r = v.range;
	return isKind(r.kind) && isTime(r.from) && (r.to === null || isTime(r.to))
		&& typeof v.live === 'boolean' && typeof v.done === 'boolean' && (v.older === 'more' || v.older === 'reading' || v.older === 'none')
		&& (v.olderError === null || typeof v.olderError === 'string') && (v.olderNote === null || typeof v.olderNote === 'string') && isCount(v.newerDropped) && (v.retention === null || typeof v.retention === 'string') && (v.deployedAt === null || isTime(v.deployedAt))
		&& isTime(v.olderBefore) && parseLogFilter(v.filter) !== undefined && isCounts(v.counts)
		&& typeof v.highlightErrors === 'boolean' && (v.focusId === null || typeof v.focusId === 'string') && (v.note === null || typeof v.note === 'string');
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
			return { type: v.type };
		case 'liveToggled':
			return typeof v.live === 'boolean' ? { type: 'liveToggled', live: v.live } : undefined;
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
