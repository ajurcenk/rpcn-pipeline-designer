// The host<->webview contract of the Pipeline Logs panel (AD-5, AD-24, ticket 6.2): every message of
// the third webview, as discriminated unions on `type`, plus the validator the webview uses on what it
// receives. The panel adapter (`src/adapters/vscode/logsPanel.ts`), the record shaping
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

export type LogsHostMessage =
	/**
	 * The whole state: the pipeline (`title`: "<pipeline> · <cluster>"; `null`: none chosen yet), every
	 * kept row (oldest first), how many were dropped for the cap, and the reading status line.
	 */
	| { readonly type: 'show'; readonly title: string | null; readonly rows: readonly LogRow[]; readonly dropped: number; readonly cap: number; readonly status: string }
	/** New rows for the shown pipeline, oldest first; `dropped`: the total dropped so far. */
	| { readonly type: 'append'; readonly rows: readonly LogRow[]; readonly dropped: number }
	| { readonly type: 'status'; readonly status: string };

export type LogsWebviewMessage = { readonly type: 'ready' };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function isRow(v: unknown): v is LogRow {
	return isObject(v) && typeof v.id === 'string' && typeof v.time === 'number' && typeof v.level === 'string'
		&& typeof v.message === 'string' && typeof v.instance === 'string' && Array.isArray(v.fields)
		&& v.fields.every((f) => Array.isArray(f) && f.length === 2 && typeof f[0] === 'string' && typeof f[1] === 'string')
		&& (v.raw === undefined || v.raw === true);
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** A host message, or `undefined` for anything malformed. */
export function parseLogsHostMessage(v: unknown): LogsHostMessage | undefined {
	if (!isObject(v)) {
		return undefined;
	}
	switch (v.type) {
		case 'show':
			return (v.title === null || typeof v.title === 'string') && Array.isArray(v.rows) && v.rows.every(isRow)
				&& isCount(v.dropped) && isCount(v.cap) && v.cap > 0 && typeof v.status === 'string'
				? v as LogsHostMessage : undefined;
		case 'append':
			return Array.isArray(v.rows) && v.rows.every(isRow) && isCount(v.dropped) ? v as LogsHostMessage : undefined;
		case 'status':
			return typeof v.status === 'string' ? v as LogsHostMessage : undefined;
		default:
			return undefined;
	}
}
