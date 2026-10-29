// Pure: what a `run`'s startup log says about the Redpanda Enterprise license (ticket 38). The binary
// looks the license up by itself (`REDPANDA_LICENSE`, else the file in `REDPANDA_LICENSE_FILEPATH`,
// else `/etc/redpanda/redpanda.license`) and reports it only in `run`'s log, as logfmt (probed
// 2026-10-29 on 4.100.0 and 4.112.0):
//
//   level=info msg="Successfully loaded Redpanda license" … expires_at="2027-03-09T15:18:26-05:00" license_org=… license_type=enterprise
//   level=error msg="Failed to read Redpanda License" … error="validating license: failed to split license contents by delimiter"
//
// With no license at all there is no line. `license_org` is never read (ticket 38: not shown).

export const LICENSE_LOADED_MSG = 'Successfully loaded Redpanda license';
export const LICENSE_FAILED_MSG = 'Failed to read Redpanda License';

export type LicenseLogResult =
	| { readonly kind: 'loaded'; readonly licenseType: string; readonly expiresAt: string }
	| { readonly kind: 'failed'; readonly reason: string }
	| { readonly kind: 'none' };

/**
 * The `key=value` pairs of one logfmt line: a value is bare (up to the next space) or double-quoted
 * with `\"` and `\\` escapes. A key without `=` gets the empty value. Pure.
 */
export function parseLogfmt(line: string): Map<string, string> {
	const out = new Map<string, string>();
	let i = 0;
	const n = line.length;
	while (i < n) {
		while (i < n && line[i] === ' ') {
			i++;
		}
		const keyStart = i;
		while (i < n && line[i] !== '=' && line[i] !== ' ') {
			i++;
		}
		const key = line.slice(keyStart, i);
		if (i >= n || line[i] === ' ') {
			if (key) {
				out.set(key, '');
			}
			continue;
		}
		i++; // '='
		let value = '';
		if (line[i] === '"') {
			i++;
			while (i < n && line[i] !== '"') {
				if (line[i] === '\\' && i + 1 < n) {
					const next = line[i + 1];
					value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
					i += 2;
				} else {
					value += line[i];
					i++;
				}
			}
			i++; // closing '"'
		} else {
			const start = i;
			while (i < n && line[i] !== ' ') {
				i++;
			}
			value = line.slice(start, i);
		}
		if (key) {
			out.set(key, value);
		}
	}
	return out;
}

/** The license line of a run's output (stderr, stdout or both), the last one when several. Pure. */
export function readLicenseLog(output: string): LicenseLogResult {
	let result: LicenseLogResult = { kind: 'none' };
	for (const line of output.split(/\r?\n/)) {
		if (!line.includes(LICENSE_LOADED_MSG) && !line.includes(LICENSE_FAILED_MSG)) {
			continue;
		}
		const fields = parseLogfmt(line);
		const msg = fields.get('msg');
		if (msg === LICENSE_LOADED_MSG) {
			result = { kind: 'loaded', licenseType: fields.get('license_type') ?? '', expiresAt: fields.get('expires_at') ?? '' };
		} else if (msg === LICENSE_FAILED_MSG) {
			result = { kind: 'failed', reason: fields.get('error') ?? '' };
		}
	}
	return result;
}

/** An expiry as the view shows it: the date of an RFC 3339 time (`2027-03-09`), else as given. Pure. */
export function licenseExpiryDate(expiresAt: string): string {
	return /^\d{4}-\d{2}-\d{2}/.exec(expiresAt)?.[0] ?? expiresAt;
}
