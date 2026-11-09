// The one place the cloud adapter calls `fetch` (Node's global `fetch`, the extension host's Node 20;
// tests inject their own). A JSON request with a bearer token; an error status becomes a
// `CloudError` (errors.ts) and a failed request a `network` one. Logs one line per request
// (method, URL, status, time), masked; never a header or a body. No `vscode` import.

import { asCloudError, CloudError, cloudErrorFrom, maskCredentials } from './errors';

/** The slice of `fetch` the adapter uses. */
export type FetchLike = (url: string, init: {
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body?: string;
	readonly signal?: AbortSignal;
}) => Promise<{ readonly status: number; readonly ok: boolean; text(): Promise<string> }>;

/** How long one request may take. */
export const REQUEST_TIMEOUT_MS = 30_000;

export interface HttpOptions {
	readonly fetch: FetchLike;
	readonly log?: (line: string) => void;
	/** The credentials to mask in every logged line and error message. */
	readonly secrets?: () => readonly (string | undefined)[];
	/**
	 * Secret values this session sent (bug 44): masked with no minimum length in an error status's
	 * message and hints only, the Cloud API's own text, which may echo a short value.
	 */
	readonly sentValues?: () => readonly string[];
	readonly timeoutMs?: number;
}

export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/**
 * Sends one request and returns its parsed JSON body (`{}` for an empty one). Throws a `CloudError`:
 * `api` for an error status, `network` when there is no answer or it is not JSON.
 */
export async function requestJson<T>(
	options: HttpOptions,
	method: string,
	url: string,
	init: { readonly token?: string; readonly json?: unknown; readonly form?: Record<string, string>; readonly tokenEndpoint?: boolean } = {},
): Promise<T> {
	const headers: Record<string, string> = { accept: 'application/json' };
	let body: string | undefined;
	if (init.token !== undefined) {
		headers.authorization = `Bearer ${init.token}`;
	}
	if (init.form) {
		headers['content-type'] = 'application/x-www-form-urlencoded';
		body = new URLSearchParams(init.form).toString();
	} else if (init.json !== undefined) {
		headers['content-type'] = 'application/json';
		body = JSON.stringify(init.json);
	}
	const mask = (text: string) => maskCredentials(text, [...(options.secrets?.() ?? []), init.token, init.form?.client_secret]);
	const shownUrl = mask(url);
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
	let status: number;
	let text: string;
	try {
		const response = await options.fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: controller.signal });
		status = response.status;
		text = await response.text();
	} catch (err) {
		const error = asCloudError(err);
		const reason = controller.signal.aborted ? `no answer within ${Math.round((options.timeoutMs ?? REQUEST_TIMEOUT_MS) / 1000)} s` : mask(error.message);
		options.log?.(`Redpanda Cloud: ${method} ${shownUrl} failed: ${reason}`);
		throw new CloudError('network', `could not reach ${hostOf(url)}: ${reason}`);
	} finally {
		clearTimeout(timer);
	}
	options.log?.(`Redpanda Cloud: ${method} ${shownUrl} → ${status} (${Date.now() - started} ms)`);
	if (status < 200 || status >= 300) {
		const error = cloudErrorFrom(status, text, init.tokenEndpoint);
		const sent = options.sentValues?.() ?? [];
		const maskApi = (t: string) => maskCredentials(mask(t), sent, 1);
		throw new CloudError(error.kind, maskApi(error.message), error.status, error.code, error.hints.map((h) => ({ ...h, hint: maskApi(h.hint) })));
	}
	if (!text.trim()) {
		return {} as T;
	}
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new CloudError('network', `${hostOf(url)} answered ${status} with a body that is not JSON`, status);
	}
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return 'the server';
	}
}

/** `base` and `path` joined with one `/`. */
export function joinUrl(base: string, path: string): string {
	return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
