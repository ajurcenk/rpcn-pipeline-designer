// What the Pipeline Logs panel shows of a record (AD-24, ticket 6.2): pure. A pipeline's records are
// those whose key is its id. A JSON object value becomes time (its `time`, else the record's
// timestamp), level, message, instance (`instance_id`) and its further fields in their order (each
// value as text; `pipeline_id`, the shown pipeline, left out); a value that is not a JSON object is
// shown as text. `license_org` is never shown (ticket 38's rule): not as a field, and its value is
// masked wherever else it appears, in its record and, through the caller's `orgs` (every value seen in
// the session, `licenseOrgOf`), in every later record and the panel's other text. Every text passes the caller's `mask` (the Cloud
// view's: the client secret, the tokens, the log access passwords). No `vscode` import.

import type { LogRow } from '../../shared/logsProtocol';
import type { LogRecord } from './logReader';
import { CREDENTIAL_MASK } from '../cloud/errors';

/** Fields the row shows in its own columns, or never. */
const COLUMN_FIELDS = new Set(['time', 'level', 'message', 'instance_id']);
const HIDDEN_FIELDS = new Set(['pipeline_id', 'license_org']);

/** Whether `record` is one of `pipelineId`'s (its key is the id). */
export function isPipelineRecord(record: LogRecord, pipelineId: string): boolean {
	return record.key === pipelineId;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A field's value as text: a string as is, anything else as JSON. */
function fieldText(v: unknown): string {
	return typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
}

/** An RFC 3339 time (nanoseconds allowed) in milliseconds, or `undefined`. */
export function parseLogTime(v: unknown): number | undefined {
	if (typeof v !== 'string' || !v) {
		return undefined;
	}
	// `Date.parse` takes at most milliseconds: cut the fraction to three digits.
	const ms = Date.parse(v.replace(/(\.\d{3})\d+/, '$1'));
	return Number.isFinite(ms) ? ms : undefined;
}

/** The `license_org` a record carries, if any (so the caller can mask it everywhere from then on). */
export function licenseOrgOf(record: LogRecord): string | undefined {
	if (!record.value || !record.value.includes('license_org')) {
		return undefined;
	}
	try {
		const v = JSON.parse(record.value) as unknown;
		return isObject(v) && typeof v.license_org === 'string' && v.license_org.length > 0 ? v.license_org : undefined;
	} catch {
		return undefined;
	}
}

/** `text` with every value of `orgs` masked. */
export function maskOrgs(text: string, orgs: Iterable<string>): string {
	let out = text;
	for (const org of orgs) {
		if (org) {
			out = out.split(org).join(CREDENTIAL_MASK);
		}
	}
	return out;
}

/**
 * The row `record` is shown as; every text passes `mask`. `orgs`: the `license_org` values seen so
 * far; the record's own is added, and all of them are masked in its texts.
 */
export function toLogRow(record: LogRecord, mask: (text: string) => string = (t) => t, orgs: Set<string> = new Set()): LogRow {
	const own = licenseOrgOf(record);
	if (own) {
		orgs.add(own);
	}
	const id = `${record.partition}:${record.offset}`;
	let value: unknown;
	try {
		value = record.value === null ? undefined : JSON.parse(record.value);
	} catch {
		value = undefined;
	}
	const shown = (text: string) => mask(maskOrgs(text, orgs));
	if (!isObject(value)) {
		return { id, time: record.timestamp, level: '', message: shown(record.value ?? ''), instance: '', fields: [], raw: true };
	}
	const fields: [string, string][] = [];
	for (const [key, v] of Object.entries(value)) {
		if (!COLUMN_FIELDS.has(key) && !HIDDEN_FIELDS.has(key)) {
			fields.push([shown(key), shown(fieldText(v))]);
		}
	}
	return {
		id,
		time: parseLogTime(value.time) ?? record.timestamp,
		level: shown(typeof value.level === 'string' ? value.level.toUpperCase() : value.level === undefined ? '' : fieldText(value.level)),
		message: shown(value.message === undefined ? '' : fieldText(value.message)),
		instance: shown(value.instance_id === undefined ? '' : fieldText(value.instance_id)),
		fields,
	};
}
