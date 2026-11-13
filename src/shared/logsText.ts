// The small texts of the Pipeline Logs panel that its host and its webview both write (story 56, the epic 6
// retrospective's A5): a count with its noun ("1 record", "2,140 records"), zero padding, and the local
// times (the menu's minute, a row's millisecond, the strip's short form, the export file's stamp). Each is
// written once here; the logs adapters (`src/adapters/logs`, `src/adapters/vscode/logsPanel.ts`), the
// protocol (`logsProtocol.ts`) and `webview/src/logs` use them. Imports nothing (AD-15).

/**
 * `n` (in the `en-US` form, "2,140") and its noun: `one` when `n` is 1, else `many` (by default `one` and
 * an "s"): "1 record", "3 records", "1 record was", "2 records were".
 */
export function countText(n: number, one: string, many = `${one}s`): string {
	return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** "1 matches", "3 match": how many of a count match the filter (the strip's bars, the end of a range's read). */
export function matchCountText(n: number): string {
	return countText(n, 'matches', 'match');
}

/** `n` with leading zeros to `width` digits: "05", "060". */
export function pad(n: number, width = 2): string {
	return String(n).padStart(width, '0');
}

/** `2026-11-05 16:49`, in local time: the menu's and the gap notes' form. */
export function localMinute(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `2026-11-05 16:49:15.510`, in local time: a row's time. */
export function localTime(ms: number): string {
	const d = new Date(ms);
	return `${localMinute(ms)}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 5 14:00", in local time: the strip's axis and its bars' names. */
export function shortTime(ms: number): string {
	const d = new Date(ms);
	return `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `20261105-1649`, in local time: the export file name's stamp. */
export function fileStamp(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
