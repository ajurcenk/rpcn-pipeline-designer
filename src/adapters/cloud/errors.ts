// Redpanda Cloud API errors (AD-23, ticket 5.2): the APIs answer `{code, message, details}`, the
// token endpoint `{error, error_description}`. A failed call becomes a `CloudError` carrying only the
// body's `message` (or the OAuth description) and, for a rejected pipeline config, its `LintHint`s
// `{line, column, hint}`; nothing else from the body is kept. Every text the cloud adapter shows or
// logs passes `maskCredentials`: the client secret, the token and any Authorization value are masked.
// No `vscode` import.

/** What a masked value shows. */
export const CREDENTIAL_MASK = '•••••';

/** A lint finding of a rejected pipeline config (`type.googleapis.com/redpanda.api.common.v1.LintHint`). */
export interface LintHint {
	readonly line: number;
	readonly column: number;
	readonly hint: string;
}

export type CloudErrorKind =
	/** The token endpoint refused the client ID or secret. */
	| 'unauthorized'
	/** An API answered with an error status. */
	| 'api'
	/** The request did not complete (network, DNS, TLS, a timeout) or the answer was not JSON. */
	| 'network';

export class CloudError extends Error {
	constructor(
		readonly kind: CloudErrorKind,
		message: string,
		/** The HTTP status, when there was an answer. */
		readonly status?: number,
		/** The API's `code` (`INVALID_ARGUMENT`, `PERMISSION_DENIED`, …), when it gave one. */
		readonly code?: string,
		readonly hints: readonly LintHint[] = [],
	) {
		super(message);
		this.name = 'CloudError';
	}
}

/** The message for a refused client ID or secret (matrix CONNECT). */
export const UNAUTHORIZED_MESSAGE = 'the client ID or secret is wrong';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every `LintHint` of an API error body, at any depth of `details` (`details[].details[]` on the real API). */
export function lintHintsOf(body: unknown): LintHint[] {
	const out: LintHint[] = [];
	const walk = (value: unknown, depth: number) => {
		if (depth > 4) {
			return;
		}
		if (Array.isArray(value)) {
			value.forEach((v) => walk(v, depth));
			return;
		}
		if (!isObject(value)) {
			return;
		}
		const type = value['@type'];
		if (typeof type === 'string' && type.endsWith('.LintHint') && typeof value.hint === 'string') {
			out.push({
				line: typeof value.line === 'number' ? value.line : 0,
				column: typeof value.column === 'number' ? value.column : 0,
				hint: value.hint,
			});
			return;
		}
		walk(value.details, depth + 1);
	};
	walk(isObject(body) ? body.details : undefined, 0);
	return out;
}

/**
 * The `CloudError` for an error answer: `status` and the raw body text. Only the body's `message`
 * (API) or `error_description` (token endpoint) is kept, with the `LintHint`s; a body that is not
 * one of the two shapes gives "HTTP <status>".
 */
export function cloudErrorFrom(status: number, bodyText: string, tokenEndpoint = false): CloudError {
	let body: unknown;
	try {
		body = JSON.parse(bodyText);
	} catch {
		body = undefined;
	}
	if (tokenEndpoint && (status === 401 || status === 403)) {
		return new CloudError('unauthorized', UNAUTHORIZED_MESSAGE, status);
	}
	if (isObject(body)) {
		const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim()
			: typeof body.error_description === 'string' && body.error_description.trim() ? body.error_description.trim()
				: typeof body.error === 'string' && body.error.trim() ? body.error.trim() : undefined;
		if (message) {
			return new CloudError('api', message, status, typeof body.code === 'string' ? body.code : undefined, lintHintsOf(body));
		}
	}
	return new CloudError('api', `HTTP ${status}`, status);
}

/** A thrown value as a `CloudError` (a fetch failure becomes `network`, its cause's text kept). */
export function asCloudError(err: unknown): CloudError {
	if (err instanceof CloudError) {
		return err;
	}
	if (err instanceof Error) {
		const cause = (err as { cause?: unknown }).cause;
		const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
		return new CloudError('network', `${err.message}${detail}`);
	}
	return new CloudError('network', String(err));
}

/** One line per hint: `line 2: unable to infer component type: x` (`line ?` when the API gave none). */
export function hintLines(hints: readonly LintHint[]): string[] {
	return hints.map((h) => `line ${h.line > 0 ? h.line : '?'}${h.column > 0 ? `, column ${h.column}` : ''}: ${h.hint}`);
}

/** A `CloudError`'s message with its hints, for a notification (one line). */
export function describeCloudError(err: CloudError): string {
	const lines = hintLines(err.hints);
	return lines.length > 0 ? `${err.message}: ${lines.join('; ')}` : err.message;
}

/**
 * `text` with every credential masked: each of `values` (the client secret, the token; empty values,
 * and values shorter than `minLength`, are skipped, as masking very short values would hide ordinary
 * text), any `Bearer …` value and any `authorization: …` header value. Bug 44: `minLength` 1 masks
 * short sent secret values, used only on the Cloud API's error text (http.ts).
 */
export function maskCredentials(text: string, values: readonly (string | undefined)[] = [], minLength = 4): string {
	let out = text;
	for (const value of values) {
		if (value && value.length >= Math.max(1, minLength)) {
			out = out.split(value).join(CREDENTIAL_MASK);
		}
	}
	return out
		.replace(/\b(Bearer)\s+[^\s"',;]+/gi, `$1 ${CREDENTIAL_MASK}`)
		.replace(/\b(authorization)(["']?\s*[:=]\s*["']?)(?!Bearer\b)[^\s"',;]+/gi, `$1$2${CREDENTIAL_MASK}`)
		.replace(/\b(client_secret|access_token)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, `$1$2${CREDENTIAL_MASK}`);
}
