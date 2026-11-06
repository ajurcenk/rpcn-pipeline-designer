// The Pipeline Logs panel's filter (ticket 6.4, board 4): pure. A row matches when its level is one
// of the levels shown, the search is found in its message, its level, its instance or one of its
// further fields' names or values (as shown: masked, `license_org` never there), and every field chip
// holds (`instance_id` is the instance column). The search is compiled once per filter. The host
// applies it to the records as a range is read, so the cap counts matches. No `vscode` import.

import { LOG_LEVELS, levelOfText, MAX_MATCH_CHARS, type LogCounts, type LogFilter, type LogLevel, type LogRow, searchPattern } from '../../shared/logsProtocol';

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

	get counts(): LogCounts {
		return { levels: { ...this.levels }, total: this.total, matched: this.matched };
	}
}
