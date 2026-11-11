// What the Pipeline Logs panel shows of a record (AD-24, ticket 6.2): pure. A pipeline's records are
// those whose key is its id. A JSON object value becomes time (its `time`, else the record's
// timestamp), level, message, instance (`instance_id`) and its further fields in their order (each
// value as text; `pipeline_id`, the shown pipeline, left out); a value that is not a JSON object is
// shown as text. `license_org` is never shown (ticket 38's rule): not as a field, and its value is
// masked wherever else it appears, in its record and, through the caller's `orgs` (every value seen in
// the session, `licenseOrgOf`), in every later record and the panel's other text. Every text passes the caller's `mask` (the Cloud
// view's: the client secret, the tokens, the log access passwords). Ticket 6.4: the row also carries
// the whole value as shown (`json`: pretty-printed, masked, `license_org` left out). Bug 52: a value of
// any shape is masked value by value (a JSON array, string or number too, not only an object), and log
// access passwords under 4 characters are masked where a whole value equals one. No `vscode` import.

import type { LogRow } from '../../shared/logsProtocol';
import type { LogRecord } from './logReader';
import { CREDENTIAL_MASK, maskWhole } from '../cloud/errors';

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
 * far; the record's own is added, and all of them are masked in its texts. Bug 52: `exact` (the log
 * access passwords under 4 characters) is masked where a whole value, a key or the raw text equals one;
 * every value is masked value by value, whatever its shape (a JSON object, array, string or number, or
 * text that is not JSON), so a secret's `"` or `\` escaped in the JSON text is not missed.
 */
export function toLogRow(record: LogRecord, mask: (text: string) => string = (t) => t, orgs: Set<string> = new Set(), exact: readonly string[] = []): LogRow {
	const own = licenseOrgOf(record);
	if (own) {
		orgs.add(own);
	}
	const id = `${record.partition}:${record.offset}`;
	let value: unknown;
	let parsed = false;
	try {
		value = record.value === null ? undefined : JSON.parse(record.value);
		parsed = record.value !== null;
	} catch {
		value = undefined;
	}
	const shown = (text: string) => mask(maskOrgs(maskWhole(text, exact), orgs));
	// Masked value by value before anything is written as JSON (a nested field, the whole record): in
	// JSON text a secret's `"`, `\` or control characters are escaped, so masking the text would miss it.
	// A number or boolean whose text holds a secret becomes the mask.
	const maskDeep = (v: unknown): unknown => {
		if (typeof v === 'string') {
			return shown(v);
		}
		if (Array.isArray(v)) {
			return v.map(maskDeep);
		}
		if (isObject(v)) {
			return Object.fromEntries(Object.entries(v).map(([k, x]) => [shown(k), maskDeep(x)]));
		}
		if (typeof v === 'number' || typeof v === 'boolean') {
			const text = String(v);
			return shown(text) === text ? v : CREDENTIAL_MASK;
		}
		return v;
	};
	if (!isObject(value)) {
		const raw = record.value ?? '';
		let message = shown(raw);
		if (parsed && (typeof value === 'string' || Array.isArray(value))) {
			// A JSON array or string: shown as its text, re-written only when a value in it was masked (its
			// text may hold a secret escaped). A number's text is masked as text.
			const masked = maskDeep(value);
			const same = JSON.stringify(masked) === JSON.stringify(value);
			message = same ? message : shown(JSON.stringify(masked));
		}
		return { id, time: record.timestamp, level: '', message, instance: '', fields: [], raw: true };
	}
	const text = (v: unknown) => shown(fieldText(maskDeep(v)));
	const fields: [string, string][] = [];
	for (const [key, v] of Object.entries(value)) {
		if (!COLUMN_FIELDS.has(key) && !HIDDEN_FIELDS.has(key)) {
			fields.push([shown(key), text(v)]);
		}
	}
	const whole: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(value)) {
		if (key !== 'license_org') {
			whole[shown(key)] = maskDeep(v);
		}
	}
	return {
		id,
		time: parseLogTime(value.time) ?? record.timestamp,
		level: typeof value.level === 'string' ? shown(shown(value.level).toUpperCase()) : value.level === undefined ? '' : text(value.level),
		message: value.message === undefined ? '' : text(value.message),
		instance: value.instance_id === undefined ? '' : text(value.instance_id),
		fields,
		json: JSON.stringify(whole, null, 2),
	};
}
