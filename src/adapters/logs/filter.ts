// The Pipeline Logs panel's filter (ticket 6.4, board 4): pure. A row matches when its level is one
// of the levels shown, the search is found in its message, its level, its instance or one of its
// further fields' names or values (as shown: masked, `license_org` never there), and every field chip
// holds (`instance_id` is the instance column). The search is compiled once per filter. The host
// applies it to the records as a range is read, so the cap counts matches. Ticket 6.7: `SlotCounter`
// keeps the strip's counts per minute beside the level counts. No `vscode` import.

import {
	LOG_LEVELS, levelOfText, MAX_MATCH_CHARS, MINUTE_MS, type LogCounts, type LogFilter, type LogLevel, type LogRow, type LogStrip, searchPattern, slotOf, stripLayout,
} from '../../shared/logsProtocol';

/** The field chip that stands for the instance column. */
export const INSTANCE_FIELD = 'instance_id';

/** A filter ready to apply: its search compiled. */
export interface CompiledFilter {
	readonly filter: LogFilter;
	readonly levels: ReadonlySet<LogLevel>;
	readonly search: RegExp | undefined;
}

/** The level chip `row` counts under. */
export function levelOf(row: Pick<LogRow, 'level'>): LogLevel {
	return levelOfText(row.level);
}

/** `filter` compiled, or `undefined` when its search is not a valid regular expression. */
export function compileFilter(filter: LogFilter): CompiledFilter | undefined {
	const search = searchPattern(filter.text, filter.matchCase, filter.regex);
	if (search !== undefined && !(search instanceof RegExp)) {
		return undefined;
	}
	return { filter, levels: new Set(filter.levels), search };
}

/** Whether `row` is kept under `compiled`. */
export function matches(row: LogRow, compiled: CompiledFilter): boolean {
	if (!compiled.levels.has(levelOf(row))) {
		return false;
	}
	for (const [key, value] of compiled.filter.fields) {
		const holds = key === INSTANCE_FIELD ? row.instance === value : row.fields.some(([k, v]) => k === key && v === value);
		if (!holds) {
			return false;
		}
	}
	const re = compiled.search;
	if (!re) {
		return true;
	}
	// At most the first MAX_MATCH_CHARS of each value: the user's pattern runs on the extension host.
	const test = (text: string) => re.test(text.length > MAX_MATCH_CHARS ? text.slice(0, MAX_MATCH_CHARS) : text);
	return test(row.message) || test(row.level) || test(row.instance) || row.fields.some(([k, v]) => test(k) || test(v));
}

/**
 * Whether two filters keep the same rows (so a change between them needs no read): the same levels,
 * chips and search; Match case and `.*` count only with a search.
 */
export function sameFilter(a: LogFilter, b: LogFilter): boolean {
	const levels = (f: LogFilter) => LOG_LEVELS.filter((l) => f.levels.includes(l)).join(',');
	const fields = (f: LogFilter) => JSON.stringify(f.fields);
	if (levels(a) !== levels(b) || fields(a) !== fields(b) || a.text !== b.text) {
		return false;
	}
	return a.text === '' || (a.matchCase === b.matchCase && a.regex === b.regex);
}

/** One minute's counts (ticket 6.7): every record, its ERROR and WARN ones, those matching. */
interface MinuteCounts {
	total: number;
	errors: number;
	warns: number;
	matched: number;
}

/**
 * The strip's counts (ticket 6.7): every record of the pipeline counted once (as `Counter`), kept per
 * minute of its timestamp, so the strip can be slotted again for any span (every slot size is whole
 * minutes, and the slots start on a minute) without keeping the records.
 */
export class SlotCounter {
	private readonly minutes = new Map<number, MinuteCounts>();

	add(time: number, level: LogLevel, matching: boolean): void {
		const minute = Math.floor(time / MINUTE_MS);
		let m = this.minutes.get(minute);
		if (!m) {
			m = { total: 0, errors: 0, warns: 0, matched: 0 };
			this.minutes.set(minute, m);
		}
		m.total++;
		if (level === 'error') {
			m.errors++;
		} else if (level === 'warn') {
			m.warns++;
		}
		if (matching) {
			m.matched++;
		}
	}

	/** Bug 52: a record counted as matching no longer matches (its row was masked again). */
	unmatch(time: number): void {
		const m = this.minutes.get(Math.floor(time / MINUTE_MS));
		if (m && m.matched > 0) {
			m.matched--;
		}
	}

	/** The strip from `from` to `end`: the counts per slot of `stripLayout(from, end)`; a record outside it counts in the nearest slot. */
	strip(from: number, end: number): LogStrip {
		const layout = stripLayout(from, end);
		const zero = () => new Array<number>(layout.count).fill(0);
		const total = zero();
		const errors = zero();
		const warns = zero();
		const matched = zero();
		for (const [minute, m] of this.minutes) {
			const i = Math.min(layout.count - 1, Math.max(0, slotOf(minute * MINUTE_MS, layout.start, layout.size)));
			total[i] += m.total;
			errors[i] += m.errors;
			warns[i] += m.warns;
			matched[i] += m.matched;
		}
		return { start: layout.start, from: layout.from, size: layout.size, end: layout.end, total, errors, warns, matched };
	}
}

/** Counts that go up as records are read: per level, every record, those matching. */
export class Counter {
	private readonly levels: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0, other: 0 };
	private total = 0;
	private matched = 0;

	add(row: LogRow, matching: boolean): void {
		this.levels[levelOf(row)]++;
		this.total++;
		if (matching) {
			this.matched++;
		}
	}

	/** Bug 52: a record counted as matching no longer matches (its row was masked again). */
	unmatch(): void {
		if (this.matched > 0) {
			this.matched--;
		}
	}

	get counts(): LogCounts {
		return { levels: { ...this.levels }, total: this.total, matched: this.matched };
	}
}
