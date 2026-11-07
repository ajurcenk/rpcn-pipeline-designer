// Export… (ticket 6.8, board 3): the records the Pipeline Logs panel shows, as JSON lines: pure. Each
// line is a shown row's value as shown: the JSON object of `row.json` on one line (already masked,
// `license_org` left out, `pipeline_id` kept; not masked again here), or, for a value that is not a JSON
// object, `{"time":"<ISO time>","message":"<its text>"}` (its text already masked). No Kafka partition,
// offset or timestamp is added. No `vscode` import.

import type { LogRow } from '../../shared/logsProtocol';

/** One shown row as a line of the export (no line break). */
export function exportLine(row: LogRow): string {
	if (row.json !== undefined) {
		return JSON.stringify(JSON.parse(row.json));
	}
	return JSON.stringify({ time: new Date(row.time).toISOString(), message: row.message });
}

/** The export's text: a line per row, in the order given (oldest first), each ending in a line break. */
export function exportText(rows: readonly LogRow[]): string {
	return rows.map((r) => `${exportLine(r)}\n`).join('');
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The save dialog's file name: `<pipeline>-<yyyymmdd-hhmm>.jsonl` in local time, the pipeline's name
 * with every character a file name may not hold (and spaces) as `-`.
 */
export function exportFileName(pipeline: string, now: number): string {
	const d = new Date(now);
	const name = pipeline.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'pipeline';
	return `${name}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.jsonl`;
}

const records = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'record' : 'records'}`;

/**
 * After the save: "Exported N records to <file name>.", and how many were left out for the cap
 * ("1,000 older records were left out for the 5,000-record limit.").
 */
export function exportedMessage(count: number, fileName: string, leftOut: number, newerDropped: number, cap: number): string {
	const limit = `${cap.toLocaleString('en-US')}-record limit`;
	const parts = [`Exported ${records(count)} to ${fileName}.`];
	if (leftOut > 0) {
		parts.push(`${leftOut.toLocaleString('en-US')} older ${leftOut === 1 ? 'record was' : 'records were'} left out for the ${limit}.`);
	}
	if (newerDropped > 0) {
		parts.push(`${newerDropped.toLocaleString('en-US')} newer ${newerDropped === 1 ? 'record was' : 'records were'} dropped for the ${limit}.`);
	}
	return parts.join(' ');
}

export const EXPORT_FAILED_PREFIX = 'Could not export the records: ';
