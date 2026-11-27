// The assistant endpoint's own call and its error formats (story 8.3, AD-26). No `vscode` import.
//   - `listModels`: the test call of Set up assistant access… and Test connection: one
//     `GET <baseUrl>/v1/models` with the key in its auth header and `anthropic-version`, through the
//     extension's proxy and CA handling (`registryAgent`, story 8.2), 15 s at most. It costs no tokens. A
//     2xx gives the models (`data[].id`, then `display_name`); a 404 or 405 means the endpoint serves no
//     list ("reachable, no model list"), which is no failure.
//   - `classifyEndpointError`: an HTTP status and body, or a run's error text, as an access failure. It
//     reads Anthropic's `{type:'error',error:{type,message}}`, ADP's `{code,message,details[{reason}]}`
//     (spike 65, captures 07 and 08) and Claude Code's own texts ("Not logged in · Please run /login").
//   - `costMark`: a relative cost mark by model family (never a price).
// The texts here are not masked: the caller masks every one (`AssistantAccess.mask`).

import * as http from 'http';
import * as https from 'https';
import { TunnelAgent } from './runtime';
import type { AssistantAuth } from './host';

/** What a failure is, for the access states (`forbidden` shows as key refused, with the endpoint's message). */
export type EndpointFailureKind = 'keyRefused' | 'modelNotAllowed' | 'forbidden' | 'unreachable' | 'other';

export interface EndpointFailure {
	readonly kind: EndpointFailureKind;
	/** The endpoint's own message, or the error's text (unmasked; may be empty). */
	readonly message: string;
	/** The refused model's name, with `modelNotAllowed` when the text names it; else `null`. */
	readonly model: string | null;
	/** The HTTP status, when there was an answer or the text gives one. */
	readonly status: number | null;
}

export interface EndpointModel {
	readonly id: string;
	/** `display_name` (`null`: none given). */
	readonly displayName: string | null;
}

/** The test call's outcome: the models (`null`: the endpoint serves no list), or the failure. */
export type ListModelsResult =
	| { readonly ok: true; readonly models: readonly EndpointModel[] | null }
	| { readonly ok: false; readonly failure: EndpointFailure };

export interface ListModelsRequest {
	readonly baseUrl: string;
	readonly auth: AssistantAuth;
	readonly key: string;
	/** The agent for a URL (`registryAgent` with the window's proxy settings); `undefined`: Node's default. */
	readonly agentFor?: (url: URL) => http.Agent | undefined;
	/** The whole call's limit (default `LIST_MODELS_TIMEOUT_MS`). */
	readonly timeoutMs?: number;
}

export const LIST_MODELS_TIMEOUT_MS = 15_000;
export const ANTHROPIC_VERSION = '2023-06-01';
/** The most models kept from one list, and the largest body read. */
const MAX_MODELS = 500;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** `<baseUrl>/v1/models` (a base URL with a path keeps it). */
export function modelsUrl(baseUrl: string): URL {
	const base = new URL(baseUrl);
	const prefix = base.pathname.replace(/\/+$/, '');
	return new URL(`${base.origin}${prefix}/v1/models?limit=1000`);
}

/** The models of a `/v1/models` body (`data[].id`, then `display_name`), at most `MAX_MODELS`. */
export function modelsOf(body: unknown): EndpointModel[] {
	const data = isObject(body) && Array.isArray(body.data) ? body.data : [];
	const out: EndpointModel[] = [];
	const seen = new Set<string>();
	for (const m of data) {
		if (isObject(m) && typeof m.id === 'string' && m.id.trim() !== '' && !seen.has(m.id)) {
			seen.add(m.id);
			out.push({ id: m.id, displayName: typeof m.display_name === 'string' && m.display_name.trim() !== '' ? m.display_name : null });
			if (out.length >= MAX_MODELS) {
				break;
			}
		}
	}
	return out;
}

/** The test call. Never rejects: a failure is its classified `EndpointFailure`. */
export function listModels(request: ListModelsRequest): Promise<ListModelsResult> {
	return new Promise((resolve) => {
		let target: URL;
		try {
			target = modelsUrl(request.baseUrl);
		} catch {
			resolve({ ok: false, failure: { kind: 'other', message: 'the base URL is not a URL', model: null, status: null } });
			return;
		}
		const timeoutMs = request.timeoutMs ?? LIST_MODELS_TIMEOUT_MS;
		let done = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: ListModelsResult) => {
			if (!done) {
				done = true;
				if (timer !== undefined) {
					clearTimeout(timer);
				}
				resolve(result);
			}
		};
		const failText = (text: string) => finish({ ok: false, failure: classifyEndpointError(undefined, undefined, text) });
		let agent: http.Agent | undefined;
		try {
			agent = request.agentFor?.(target);
		} catch (err) {
			failText(`the proxy setting is not usable: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		if (agent instanceof TunnelAgent) {
			agent.handshakeTimeoutMs = timeoutMs;
		}
		const headers: Record<string, string> = {
			accept: 'application/json',
			'anthropic-version': ANTHROPIC_VERSION,
			...(request.auth === 'x-api-key' ? { 'x-api-key': request.key } : { authorization: `Bearer ${request.key}` }),
		};
		const path = `${target.pathname}${target.search}`;
		// Through a tunnel: a `ClientRequest` of its own (as `download`: VS Code's patched `https` would drop the agent).
		let req: http.ClientRequest;
		try {
			req = agent instanceof TunnelAgent
				? new http.ClientRequest({
					protocol: 'https:', hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 443, path, method: 'GET', headers, agent, _defaultAgent: https.globalAgent,
				} as http.ClientRequestArgs)
				: (target.protocol === 'https:' ? https : http).request(target, { method: 'GET', headers, ...(agent ? { agent } : {}) });
		} catch (err) {
			failText(err instanceof Error ? err.message : String(err));
			return;
		}
		timer = setTimeout(() => {
			req.destroy(new Error(`timed out after ${Math.max(1, Math.round(timeoutMs / 1000))} s`));
		}, timeoutMs);
		req.once('error', (err: NodeJS.ErrnoException) => {
			const code = err.code && !err.message.includes(err.code) ? ` (${err.code})` : '';
			failText(`${err.message}${code}`);
		});
		req.once('response', (res) => {
			const status = res.statusCode ?? 0;
			const chunks: Buffer[] = [];
			let bytes = 0;
			res.on('data', (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes <= MAX_BODY_BYTES) {
					chunks.push(chunk);
				}
			});
			res.once('error', (err) => failText(err.message));
			res.once('end', () => {
				const text = Buffer.concat(chunks).toString('utf8');
				let body: unknown = text;
				try {
					body = text ? JSON.parse(text) : undefined;
				} catch {
					// not JSON: the text itself
				}
				if (status >= 200 && status < 300) {
					finish({ ok: true, models: modelsOf(body) });
				} else if (status === 404 || status === 405) {
					finish({ ok: true, models: null });
				} else {
					finish({ ok: false, failure: classifyEndpointError(status, body) });
				}
			});
		});
		req.end();
	});
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** The first JSON object inside `text` (Claude Code's "API Error: 401 {…}"), if any. */
function jsonIn(text: string): unknown {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) {
		return undefined;
	}
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
}

/** The fields the classifier reads from a body: Anthropic's error type and message, ADP's code, message and reasons. */
function fieldsOf(body: unknown): { readonly type?: string; readonly message?: string; readonly code?: string | number; readonly reasons: string[] } {
	if (typeof body === 'string') {
		const inner = jsonIn(body);
		return inner === undefined ? { message: str(body), reasons: [] } : fieldsOf(inner);
	}
	if (!isObject(body)) {
		return { reasons: [] };
	}
	const error = isObject(body.error) ? body.error : undefined;
	const details = Array.isArray(body.details) ? body.details : [];
	const reasons = details.map((d) => (isObject(d) ? str(d.reason) : undefined)).filter((r): r is string => r !== undefined);
	const code = typeof body.code === 'number' || typeof body.code === 'string' ? body.code : undefined;
	return {
		type: str(error?.type) ?? (body.type !== 'error' ? str(body.type) : undefined),
		message: str(error?.message) ?? str(body.message) ?? (typeof body.error === 'string' ? str(body.error) : undefined),
		...(code !== undefined ? { code } : {}),
		reasons,
	};
}

/** "model "x" is not allowed" (ADP), with the model's name. */
const MODEL_NOT_ALLOWED = /model\s+[\\]*["'`]?([^"'`\s\\]+)[\\]*["'`]?\s+is not allowed/i;
/** A status in a run's text: "API Error: 401", "HTTP 403", "403 model …" at the start. */
const STATUS_IN_TEXT = /(?:^\s*|API Error:?\s*|HTTP\s*|status(?: code)?\s*)([1-5]\d\d)\b/i;
/** A connection that never got an answer: refused, no such host, TLS, a timeout (Node's, undici's and Claude Code's words). */
const UNREACHABLE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT|timed? ?out|\btimeout\b|Connection error|fetch failed|getaddrinfo|socket hang up|certificate|self[- ]signed|\bTLS\b|\bSSL\b|ERR_TLS|EPROTO|the proxy (?:could not be reached|refused|closed|did not answer)/i;

/**
 * An endpoint failure, from an HTTP `status` and `body` (a test call's answer), or from a run's error
 * `text` (Claude Code's, with any status and JSON body it holds). In order: model not allowed (the model
 * named when the text does), key refused, forbidden, unreachable, other.
 */
export function classifyEndpointError(status: number | undefined, body: unknown, text = ''): EndpointFailure {
	const fromBody = fieldsOf(body);
	const fromText = fieldsOf(text);
	const type = fromBody.type ?? fromText.type;
	const reasons = [...fromBody.reasons, ...fromText.reasons];
	const code = fromBody.code ?? fromText.code;
	const textStatus = STATUS_IN_TEXT.exec(text)?.[1];
	const http = status ?? (textStatus ? Number(textStatus) : undefined);
	const message = (fromBody.message ?? (typeof body === 'string' ? body : undefined) ?? fromText.message ?? text).trim();
	const all = [message, text, type ?? '', ...reasons].join('\n');
	const base = { message, status: http ?? null };
	const named = MODEL_NOT_ALLOWED.exec(all);
	if (type === 'model_not_allowed' || reasons.includes('MODEL_NOT_ALLOWED') || /model_not_allowed/i.test(all) || named) {
		return { ...base, kind: 'modelNotAllowed', model: named?.[1] ?? null };
	}
	if (http === 401 || type === 'authentication_error' || reasons.includes('UNAUTHENTICATED') || code === 16 || code === 'UNAUTHENTICATED'
		|| /Not logged in|Please run \/login|Invalid API key|authentication_error|authentication_failed/i.test(all)) {
		return { ...base, kind: 'keyRefused', model: null };
	}
	if (http === 403 || type === 'permission_error' || code === 7 || code === 'PERMISSION_DENIED' || reasons.includes('PERMISSION_DENIED') || /permission_error/i.test(all)) {
		return { ...base, kind: 'forbidden', model: null };
	}
	if (http === undefined && UNREACHABLE.test(text)) {
		return { ...base, kind: 'unreachable', model: null };
	}
	return { ...base, kind: 'other', model: null };
}

/** A relative cost mark by model family, never a price: `$$$` opus, `$$` sonnet and fable, `$` haiku, else none. */
export function costMark(model: string): '$$$' | '$$' | '$' | '' {
	const m = model.toLowerCase();
	return m.includes('opus') ? '$$$' : m.includes('sonnet') || m.includes('fable') ? '$$' : m.includes('haiku') ? '$' : '';
}
