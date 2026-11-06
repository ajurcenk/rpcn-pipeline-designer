// The host<->webview contract of the Pipeline Logs panel (AD-5, AD-24, tickets 6.2, 6.3): every message
// of the third webview, as discriminated unions on `type`, plus the validators each side uses on what
// it receives, and the pure time rules both share (the range menu's choices, local date-times, the gap
// notes). The panel adapter (`src/adapters/vscode/logsPanel.ts`), the record shaping
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
}

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
	/** How many of the newest rows Load older dropped for the cap (Live then paused). */
	readonly newerDropped: number;
	/** The menu's retention line; `null` until it is read (the menu opened). */
	readonly retention: string | null;
	/** The pipeline's last deploy as last read, for the menu's "Since the last deploy (…)"; `null`: unknown. */
	readonly deployedAt: number | null;
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
	| { readonly type: 'retentionRequested' };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function isRow(v: unknown): v is LogRow {
	return isObject(v) && typeof v.id === 'string' && typeof v.time === 'number' && typeof v.level === 'string'
		&& typeof v.message === 'string' && typeof v.instance === 'string' && Array.isArray(v.fields)
		&& v.fields.every((f) => Array.isArray(f) && f.length === 2 && typeof f[0] === 'string' && typeof f[1] === 'string')
		&& (v.raw === undefined || v.raw === true);
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
		&& (v.olderError === null || typeof v.olderError === 'string') && isCount(v.newerDropped) && (v.retention === null || typeof v.retention === 'string') && (v.deployedAt === null || isTime(v.deployedAt));
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
