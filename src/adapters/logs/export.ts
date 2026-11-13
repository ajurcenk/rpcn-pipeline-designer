// Export… (ticket 6.8, board 3): the records the Pipeline Logs panel shows, as JSON lines: pure. Each
// line is a shown row's value as shown: the JSON object of `row.json` on one line (already masked,
// `license_org` left out, `pipeline_id` kept; not masked again here), or, for a value that is not a JSON
// object, `{"time":"<ISO time>","message":"<its text>"}` (its text already masked). No Kafka partition or
// offset is added. Bug 51: a JSON object with no `time` field gets its record's Kafka timestamp as `time`
// (first; left out when that timestamp is not a valid time), and the message after the save names the
// filter the rows were kept with. No `vscode` import.

import type { LogRow } from '../../shared/logsProtocol';
import { countText, fileStamp } from '../../shared/logsText';

/** `ms` as an ISO time; `undefined` for a time a `Date` cannot hold (never throws). */
function isoTime(ms: number): string | undefined {
	const d = new Date(ms);
	return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

/** One shown row as a line of the export (no line break); `kafkaTime` is its record's timestamp (default: the row's time). */
export function exportLine(row: LogRow, kafkaTime: number = row.time): string {
	if (row.json !== undefined) {
		const value: unknown = JSON.parse(row.json);
		const time = isoTime(kafkaTime);
		if (time !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value) && !Object.prototype.hasOwnProperty.call(value, 'time')) {
			return JSON.stringify({ time, ...value });
		}
		return JSON.stringify(value);
	}
	const time = isoTime(row.time);
	return JSON.stringify(time === undefined ? { message: row.message } : { time, message: row.message });
}

/**
 * The export's text: a line per row, in the order given (oldest first), each ending in a line break;
 * `kafkaTimes[i]` is row i's record timestamp.
 */
export function exportText(rows: readonly LogRow[], kafkaTimes?: readonly number[]): string {
	return rows.map((r, i) => `${exportLine(r, kafkaTimes?.[i])}\n`).join('');
}

/**
 * The save dialog's file name: `<pipeline>-<yyyymmdd-hhmm>.jsonl` in local time, the pipeline's name
 * with every character a file name may not hold (and spaces) as `-`.
 */
export function exportFileName(pipeline: string, now: number): string {
	const name = pipeline.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'pipeline';
	return `${name}-${fileStamp(now)}.jsonl`;
}

/**
 * After the save: "Exported N records to <file name>.", with a filter on "Exported N records matching
 * the filter (levels Warn; search "secret") to <file name>." (bug 51: `filter`, the filter's words), and
 * how many were left out for the cap ("1,000 older records were left out for the 5,000-record limit.";
 * bug 51: "records", not "older records", when `inGaps` of them sit between the rows exported).
 */
export function exportedMessage(count: number, fileName: string, leftOut: number, newerDropped: number, cap: number, filter = '', inGaps = 0): string {
	const limit = `${cap.toLocaleString('en-US')}-record limit`;
	const parts = [filter === '' ? `Exported ${countText(count, 'record')} to ${fileName}.` : `Exported ${countText(count, 'record')} matching the filter (${filter}) to ${fileName}.`];
	if (leftOut > 0) {
		const older = inGaps > 0 ? '' : 'older ';
		parts.push(`${countText(leftOut, `${older}record was`, `${older}records were`)} left out for the ${limit}.`);
	}
	if (newerDropped > 0) {
		parts.push(`${countText(newerDropped, 'newer record was', 'newer records were')} dropped for the ${limit}.`);
	}
	return parts.join(' ');
}

export const EXPORT_FAILED_PREFIX = 'Could not export the records: ';
