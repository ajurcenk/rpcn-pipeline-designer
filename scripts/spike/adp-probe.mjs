#!/usr/bin/env node
// Spike 65: probe the Redpanda ADP LLM proxy's Anthropic Messages API contract with plain `fetch`
// (no SDK), and record what was asked and answered, by shape, as captures. Started by
// scripts/spike/adp-probe.sh.
//
// Inputs:
//   ~/.config/rpcn-spike/adp.env   the keys ADP_BASE_URL, ADP_API_KEY, optional ADP_MODEL (default
//                                  claude-opus-5-5) and ADP_HEADERS (`Name: value` pairs separated
//                                  by `;`). Keys read case-insensitively. A regular file owned by
//                                  you, mode 0600; anything else is refused before any request.
//   --dry-run                      no network and no key: a fake Messages API on 127.0.0.1; the
//                                  refusals, the redaction, the shape recorder and the call cap are
//                                  checked
//
// What it does (at most 10 calls, none retried; ADP_HEADERS and `anthropic-version` on every call):
//   1 messages-plain-x-api-key     POST /v1/messages, the key as `x-api-key`
//   2 messages-plain-bearer        the same, the key as `Authorization: Bearer`
//   3 messages-stream              stream: true (SSE), with the auth that worked
//   4 messages-tool-use            one tool offered, tool_choice auto
//   5 count-tokens                 POST /v1/messages/count_tokens
//   6 models-list                  GET /v1/models (the SDK's model lookups)
//   7 error-wrong-key              a key changed in memory only
//   8 error-unknown-model          a model name that does not exist
//   9 error-timeout                a long answer cut by a 5 s client timeout
//
// Outputs (re-generated on every run; other files in the folder, such as the design runs'
// sub-folders, are kept):
//   <findings>/captures/NN-<step>.json   one per call: {step, request, response | error, ms}
//   <findings>/captures/summary.tsv      one row per capture
//   <findings>/captures/run.json         the answers in short, errors, a leak self-scan
//   --dry-run writes to .cache/adp-probe/dry-run/<case>/ instead.
//
// Recorded: status codes, header and field names, event types, token counts and timings. Never
// recorded: the key, the ADP host, the ADP_HEADERS values, or request and response text beyond
// short redacted samples (80 characters).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FINDINGS = path.join(ROOT, '_bmad-output/backlog/spike-can-the-extension-host-the-agent-sdk-through-the-adp-proxy-findings');
const CAPS = path.join(FINDINGS, 'captures');
const CACHE = path.join(ROOT, '.cache/adp-probe');
const ADP_FILE = path.join(os.homedir(), '.config/rpcn-spike/adp.env');

const DEFAULT_MODEL = 'claude-opus-5-5';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_CALLS = 10;
const FETCH_MS = 60_000;
const TIMEOUT_CASE_MS = 5_000;
const SAMPLE_CHARS = 80;
const PREFIX_MIN = 8; // any prefix of the key or of a header value this long is redacted
const UNKNOWN_MODEL = 'claude-no-such-model-spike-65';

const SECRET_KEY = /^(authorization|x-api-key|api_key|apikey|key|token|access_token|password|secret)$/i;
// Response headers whose values are recorded (others by name only).
const HEADER_VALUES = /^(content-type|content-encoding|content-length|transfer-encoding|cache-control|retry-after|anthropic-version|anthropic-ratelimit-.*|x-ratelimit-.*|ratelimit.*|x-should-retry)$/i;

// ---------------------------------------------------------------------------------------------
// The ADP file (readEnvFile copied from metrics-probe.mjs)

/** Reads KEY=value lines from a file you own with mode 0600; refuses anything else. Keys lower-cased. */
function readEnvFile(file, what) {
	let st;
	try { st = fs.lstatSync(file); } catch { throw new Error(`${what} file not found: ${file} (create it, mode 0600)`); }
	if (!st.isFile()) throw new Error(`${what} file is not a regular file (symlinks are refused): ${file} (put the file itself there)`);
	if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${what} file is not owned by you: ${file} (copy it into a file of your own)`);
	const mode = st.mode & 0o777;
	if (mode !== 0o600) throw new Error(`${what} file has mode ${mode.toString(8)}, must be 600: ${file} (run: chmod 600 ${file})`);
	const vals = {};
	for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!m) continue;
		let v = m[2].trim();
		if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
		vals[m[1].toLowerCase()] = v;
	}
	return vals;
}

/** `Name: value; Name2: value2` -> [[name, value], ...]; a pair without a colon is refused. */
function parseHeaders(s, file) {
	const out = [];
	for (const part of String(s ?? '').split(';')) {
		const p = part.trim();
		if (!p) continue;
		const i = p.indexOf(':');
		const name = i > 0 ? p.slice(0, i).trim() : '';
		if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new Error(`ADP file's ADP_HEADERS has a pair that is not \`Name: value\`: ${file} (separate pairs with ;)`);
		out.push([name, p.slice(i + 1).trim()]);
	}
	return out;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The ADP access (decision 2026-11-23): ADP_BASE_URL, ADP_API_KEY, ADP_MODEL, ADP_HEADERS. */
function readAdpAccess(file = ADP_FILE) {
	const v = readEnvFile(file, 'ADP');
	const missing = ['adp_base_url', 'adp_api_key'].filter((k) => !v[k]);
	if (missing.length) throw new Error(`ADP file needs ${missing.map((k) => `${k.toUpperCase()}=`).join(', ')} line(s): ${file}`);
	let u;
	try { u = new URL(v.adp_base_url); } catch { throw new Error(`ADP file's ADP_BASE_URL is not a URL: ${file}`); }
	if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) throw new Error(`ADP file's ADP_BASE_URL must be https (http only on localhost): ${file}`);
	if (u.username || u.password) throw new Error(`ADP file's ADP_BASE_URL must not hold a user or password: ${file}`);
	return { baseUrl: v.adp_base_url.replace(/\/+$/, ''), apiKey: v.adp_api_key, model: v.adp_model || DEFAULT_MODEL, headers: parseHeaders(v.adp_headers, file) };
}

// ---------------------------------------------------------------------------------------------
// Redaction (Redactor, shape, errInfo copied from metrics-probe.mjs, trimmed to what ADP needs)

class Redactor {
	constructor() {
		this.scrub = new Set(); // exact strings -> <redacted>
		this.ids = new Map();   // value -> placeholder
	}
	secret(v) { if (v != null && String(v).length >= 3) this.scrub.add(String(v)); }
	/** The value and every prefix of it of PREFIX_MIN or more characters (an echoed start of a key). */
	secretWithPrefixes(v) {
		const t = String(v ?? '');
		this.secret(t);
		for (let n = PREFIX_MIN; n < t.length; n++) this.scrub.add(t.slice(0, n));
	}
	id(v, ph) { if (typeof v === 'string' && v.length >= 3 && !this.ids.has(v)) this.ids.set(v, ph); }
	text(s) {
		let out = String(s);
		for (const v of [...this.scrub].sort((a, b) => b.length - a.length)) out = out.split(v).join('<redacted>');
		out = out.replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '<redacted-jwt>');
		out = out.replace(/Bearer\s+(?!<redacted)[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer <redacted>');
		out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<redacted-key>');
		for (const [v, ph] of [...this.ids].sort((a, b) => b[0].length - a[0].length)) out = out.split(v).join(ph);
		out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>');
		out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
		return out;
	}
	value(v) {
		if (Array.isArray(v)) return v.map((x) => this.value(x));
		if (typeof v === 'bigint') return v.toString();
		if (v && typeof v === 'object') {
			const out = {};
			for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) && x != null && x !== '' ? '<redacted>' : this.value(x);
			return out;
		}
		if (typeof v === 'string') return this.text(v);
		return v;
	}
}

/** Body shape: leaves become their type, arrays their length and first element's shape. */
function shape(v, depth = 0) {
	if (depth > 6) return '…';
	if (Array.isArray(v)) return v.length ? [`length ${v.length}`, shape(v[0], depth + 1)] : [];
	if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
	return v === null ? 'null' : typeof v;
}

/** An error as data: name, code, message and nested causes; never a stack. */
function errInfo(e, depth = 0) {
	if (e == null) return null;
	if (typeof e !== 'object') return { message: String(e) };
	const o = { name: e.name ?? e.constructor?.name, message: String(e.message ?? e) };
	for (const k of ['code', 'errno', 'syscall', 'reason']) {
		if (e[k] != null && typeof e[k] !== 'object' && typeof e[k] !== 'function') o[k] = e[k];
	}
	if (e.cause && depth < 4) o.cause = errInfo(e.cause, depth + 1);
	return o;
}

const sample = (s, R) => (s == null ? null : R.text(String(s).slice(0, SAMPLE_CHARS)));

function headerSummary(h, R) {
	const entries = [...h.entries()];
	return { names: entries.map(([k]) => k).sort(), values: Object.fromEntries(entries.filter(([k]) => HEADER_VALUES.test(k)).map(([k, v]) => [k, R.text(v)])) };
}

/** A Messages API body by shape, with its type, model, stop reason, block types, usage and an error's type. */
function messageSummary(j, R) {
	if (!j || typeof j !== 'object') return null;
	const out = { type: j.type ?? null };
	if (j.model !== undefined) out.model = R.text(j.model);
	if (j.stop_reason !== undefined) out.stop_reason = j.stop_reason;
	if (Array.isArray(j.content)) {
		out.content_types = j.content.map((b) => b?.type);
		const text = j.content.find((b) => b?.type === 'text');
		if (text) out.text_sample = sample(text.text, R);
		const tu = j.content.find((b) => b?.type === 'tool_use');
		if (tu) out.tool_use = { name: tu.name, input_keys: Object.keys(tu.input ?? {}).sort() };
	}
	if (j.usage) out.usage = Object.fromEntries(Object.entries(j.usage).filter(([, x]) => typeof x === 'number' || x === null || typeof x === 'string'));
	if (j.input_tokens !== undefined) out.input_tokens = j.input_tokens;
	if (j.error) out.error = { type: j.error.type ?? null, message_sample: sample(j.error.message, R) };
	if (Array.isArray(j.data)) { out.data_length = j.data.length; out.ids_sample = j.data.slice(0, 5).map((m) => R.text(m?.id ?? '')); }
	return out;
}

/** An SSE body: event types in order (runs collapsed), counts, the first data's shape per type. */
function sseSummary(text, R) {
	const events = [];
	const shapes = {};
	let usage = null, stop = null, textChars = 0, firstText = '';
	for (const block of text.split(/\r?\n\r?\n/)) {
		let ev = null, data = '';
		for (const line of block.split(/\r?\n/)) {
			if (line.startsWith('event:')) ev = line.slice(6).trim();
			else if (line.startsWith('data:')) data += line.slice(5).trim();
		}
		if (!ev && !data) continue;
		let j = null;
		try { j = data ? JSON.parse(data) : null; } catch { /* not JSON */ }
		const type = ev ?? j?.type ?? '(no event)';
		events.push(type);
		if (!(type in shapes) && j) shapes[type] = shape(j);
		if (j?.type === 'message_delta') { usage = j.usage ?? usage; stop = j.delta?.stop_reason ?? stop; }
		if (j?.type === 'message_start' && j.message?.usage) usage = { start: j.message.usage, ...(usage ?? {}) };
		if (j?.type === 'content_block_delta' && j.delta?.type === 'text_delta') { textChars += j.delta.text.length; if (firstText.length < SAMPLE_CHARS) firstText += j.delta.text; }
	}
	const runs = [];
	for (const e of events) { const last = runs.at(-1); if (last && last.event === e) last.count++; else runs.push({ event: e, count: 1 }); }
	const counts = events.reduce((m, e) => ({ ...m, [e]: (m[e] ?? 0) + 1 }), {});
	return { events: events.length, sequence: runs, counts, first_data_shape: shapes, stop_reason: stop, usage, text_chars: textChars, text_sample: sample(firstText, R) };
}

// ---------------------------------------------------------------------------------------------
// The probe

async function probe({ fetchImpl, access, outDir, timeoutCaseMs = TIMEOUT_CASE_MS }) {
	const R = new Redactor();
	R.secretWithPrefixes(access.apiKey);
	const base = new URL(access.baseUrl);
	R.id(access.baseUrl, '<adp-base-url>');
	R.id(base.host, '<adp-host>');
	R.id(base.hostname, '<adp-host>');
	for (const [, v] of access.headers) R.secretWithPrefixes(v);
	const wrongKey = `probe-wrong-${randomBytes(8).toString('hex')}`;
	R.secret(wrongKey);

	const caps = [];
	const errors = [];
	let calls = 0;
	const scanSecrets = { api_key: access.apiKey, api_key_start: access.apiKey.slice(0, Math.min(PREFIX_MIN, access.apiKey.length)), wrong_key: wrongKey, adp_host: base.hostname, ...Object.fromEntries(access.headers.flatMap(([k, v], i) => [[`header_${i}_${k}_value`, v], [`header_${i}_${k}_value_start`, v.slice(0, PREFIX_MIN)]])) };
	const run = { date: new Date().toISOString(), dry_run: !fetchImpl.isReal, model: access.model, anthropic_version: ANTHROPIC_VERSION, base_url_path_segments: base.pathname.split('/').filter(Boolean).length, extra_header_names: access.headers.map(([k]) => k), max_calls: MAX_CALLS };
	const print = (s) => console.log(R.text(s));

	/** One call, recorded; never retried, never throws. */
	async function call(step, { method = 'POST', route, auth = 'x-api-key', key = access.apiKey, body, timeoutMs = FETCH_MS, stream = false }) {
		if (calls >= MAX_CALLS) { errors.push({ step, error: `cost cap: more than ${MAX_CALLS} calls` }); return null; }
		calls++;
		const headers = { 'anthropic-version': ANTHROPIC_VERSION, accept: stream ? 'text/event-stream' : 'application/json' };
		for (const [k, v] of access.headers) headers[k] = v;
		if (auth === 'x-api-key') headers['x-api-key'] = key;
		else if (auth === 'bearer') headers.authorization = `Bearer ${key}`;
		if (body !== undefined) headers['content-type'] = 'application/json';
		const url = `${access.baseUrl}${route}`;
		const request = { method, url, auth, header_names: Object.keys(headers).sort(), body: body === undefined ? undefined : { shape: shape(body), model: body.model, max_tokens: body.max_tokens, stream: body.stream ?? false, tools: body.tools?.map((t) => t.name) } };
		const t0 = Date.now();
		const cap = { step, request };
		let res = null;
		try {
			res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
			const headMs = Date.now() - t0;
			let firstByteMs = null;
			const chunks = [];
			const reader = res.body?.getReader();
			if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; if (firstByteMs == null) firstByteMs = Date.now() - t0; chunks.push(Buffer.from(value)); }
			const text = Buffer.concat(chunks).toString('utf8');
			const ct = res.headers.get('content-type') ?? '';
			cap.response = { status: res.status, headers: headerSummary(res.headers, R), bytes: Buffer.byteLength(text), headers_ms: headMs, first_byte_ms: firstByteMs };
			if (/event-stream/.test(ct)) cap.response.sse = sseSummary(text, R);
			else {
				let j;
				try { j = JSON.parse(text); } catch { j = undefined; }
				if (j !== undefined) { cap.response.body_shape = shape(j); cap.response.summary = messageSummary(j, R); }
				else cap.response.body = { kind: /^\s*</.test(text) ? 'html' : text ? 'text' : 'empty', bytes: Buffer.byteLength(text), preview: sample(text, R) };
			}
		} catch (e) {
			cap.error = errInfo(e);
			if (res) cap.response = { status: res.status, headers: headerSummary(res.headers, R), note: 'the body was cut' };
		}
		cap.ms = Date.now() - t0;
		caps.push(cap);
		print(`${step.padEnd(28)} ${method.padEnd(5)} ${url} -> ${cap.response ? cap.response.status : `error: ${cap.error?.name}`}${cap.error && cap.response ? ` then ${cap.error.name}` : ''} (${cap.ms} ms)`);
		return cap;
	}
	const ok = (c) => c?.response && c.response.status >= 200 && c.response.status < 300 && !c.error;
	const msg = (text, extra = {}) => ({ model: access.model, max_tokens: 512, messages: [{ role: 'user', content: text }], ...extra });

	try {
		// Auth: both forms, so the record says which work.
		const a1 = await call('messages-plain-x-api-key', { route: '/v1/messages', auth: 'x-api-key', body: msg('Reply with the single word: pong') });
		const a2 = await call('messages-plain-bearer', { route: '/v1/messages', auth: 'bearer', body: msg('Reply with the single word: pong') });
		const works = { 'x-api-key': ok(a1), bearer: ok(a2) };
		const auth = works['x-api-key'] ? 'x-api-key' : works.bearer ? 'bearer' : null;
		run.auth = { x_api_key: a1?.response?.status ?? 'network error', bearer: a2?.response?.status ?? 'network error', works, used_below: auth, sdk_env: auth === 'x-api-key' ? 'ANTHROPIC_API_KEY' : auth === 'bearer' ? 'ANTHROPIC_AUTH_TOKEN' : null };
		run.model_answered = [a1, a2].find(ok)?.response?.summary?.model ?? null;
		if (!auth) throw new Error('neither x-api-key nor a bearer token was accepted; the other calls would only repeat the refusal');

		const s = await call('messages-stream', { route: '/v1/messages', auth, stream: true, body: msg('Count from 1 to 20, one number per line.', { stream: true }) });
		run.stream = { status: s?.response?.status ?? null, content_type: s?.response?.headers.values['content-type'] ?? null, event_types: s?.response?.sse ? Object.keys(s.response.sse.counts) : null, first_byte_ms: s?.response?.first_byte_ms ?? null };

		const tools = [{ name: 'get_weather', description: 'Get the current weather for a city.', input_schema: { type: 'object', properties: { city: { type: 'string', description: 'The city name' } }, required: ['city'] } }];
		const t = await call('messages-tool-use', { route: '/v1/messages', auth, body: msg('What is the weather in Vilnius right now? Use the tool.', { tools, tool_choice: { type: 'auto' } }) });
		run.tool_use = { status: t?.response?.status ?? null, stop_reason: t?.response?.summary?.stop_reason ?? null, tool_use: t?.response?.summary?.tool_use ?? null };

		const c = await call('count-tokens', { route: '/v1/messages/count_tokens', auth, body: { model: access.model, messages: [{ role: 'user', content: 'Hello' }] } });
		run.count_tokens = { status: c?.response?.status ?? null, input_tokens: c?.response?.summary?.input_tokens ?? null };

		const m = await call('models-list', { method: 'GET', route: '/v1/models', auth });
		run.models = { status: m?.response?.status ?? null, data_length: m?.response?.summary?.data_length ?? null, ids_sample: m?.response?.summary?.ids_sample ?? null };

		const w = await call('error-wrong-key', { route: '/v1/messages', auth, key: wrongKey, body: msg('Reply with the single word: pong') });
		const u = await call('error-unknown-model', { route: '/v1/messages', auth, body: { ...msg('Reply with the single word: pong'), model: UNKNOWN_MODEL } });
		const to = await call('error-timeout', { route: '/v1/messages', auth, timeoutMs: timeoutCaseMs, body: msg('Write a 600-word story about a lighthouse keeper.', { max_tokens: 2048 }) });
		const errShape = (x) => (x ? { status: x.response?.status ?? null, error_type: x.response?.summary?.error?.type ?? null, body_shape: x.response?.body_shape ?? x.response?.body ?? null, client_error: x.error?.name ?? null } : null);
		run.errors_seen = { wrong_key: errShape(w), unknown_model: errShape(u), timeout: { ...errShape(to), timed_out: !!to?.error, timeout_ms: timeoutCaseMs } };
	} catch (e) {
		errors.push({ step: 'probe', error: R.text(String(e?.message ?? e)) });
		print(`!! ${R.text(String(e?.message ?? e))}`);
	} finally {
		run.calls = calls;
		run.errors = errors;
		writeCaptures(outDir, caps, run, R);
		run.leak_scan = selfScanImpl.fn(outDir, scanSecrets);
		if (run.leak_scan.clean) fs.writeFileSync(path.join(outDir, 'run.json'), `${JSON.stringify(R.value(run), null, 2)}\n`);
		else removeOwnFiles(outDir); // a hit: nothing of this run is kept
		print(`leak self-scan: ${run.leak_scan.clean ? 'clean' : `HITS in ${run.leak_scan.hits.map((h) => h.what).join(', ')}; this run's capture files were deleted`}`);
	}
	return { run, caps, wrongKey, R };
}

const OWN_FILE = /^(\d\d-.*\.json|summary\.tsv|run\.json)$/;

/** Deletes the probe's own files in `outDir` (other files and folders, the design runs', are kept). */
function removeOwnFiles(outDir) {
	for (const f of fs.readdirSync(outDir)) if (OWN_FILE.test(f)) fs.rmSync(path.join(outDir, f));
}

/** Replaces the probe's own files in `outDir`. */
function writeCaptures(outDir, caps, run, R) {
	fs.mkdirSync(outDir, { recursive: true });
	removeOwnFiles(outDir);
	const rows = [['n', 'step', 'outcome', 'ms'].join('\t')];
	caps.forEach((c, i) => {
		const n = String(i + 1).padStart(2, '0');
		const red = R.value(c);
		fs.writeFileSync(path.join(outDir, `${n}-${c.step}.json`), `${JSON.stringify(red, null, 2)}\n`);
		rows.push([n, red.step, red.response ? `${red.response.status}${red.error ? ` then ${red.error.name}` : ''}` : `error: ${red.error?.name ?? ''}`, c.ms].join('\t'));
	});
	fs.writeFileSync(path.join(outDir, 'summary.tsv'), `${rows.join('\n')}\n`);
	fs.writeFileSync(path.join(outDir, 'run.json'), `${JSON.stringify(R.value(run), null, 2)}\n`);
}

/** The probe's output files scanned for each secret value; names only. */
function selfScan(dir, secrets) {
	const files = fs.readdirSync(dir).filter((f) => OWN_FILE.test(f)).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
	const hits = [];
	for (const [what, v] of Object.entries(secrets)) {
		if (v == null || String(v).length < 3) continue;
		const inFiles = files.filter(([, t]) => t.includes(String(v))).map(([f]) => f);
		if (inFiles.length) hits.push({ what, files: inFiles.slice(0, 10) });
	}
	return { clean: hits.length === 0, files: files.length, secrets_checked: Object.keys(secrets).length, hits };
}

/** The scan the probe calls (replaceable by the dry run, to plant a hit). */
const selfScanImpl = { fn: selfScan };

// ---------------------------------------------------------------------------------------------
// Dry run: a fake Messages API on 127.0.0.1

function makeFake({ auth = 'both', countTokens = true, requiredHeader = ['X-Adp-Tenant', 'tenant-secret-0042'], key = 'sk-fake-adp-KEY-0000aaaa1111', echoKey = false } = {}) {
	const F = { key, host: 'adp-gateway.fake-tenant.example.test', requiredHeader, requests: [] };
	const sse = (rs, events) => {
		rs.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'request-id': 'req_fake_0001' });
		for (const [e, d] of events) rs.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
		rs.end();
	};
	const json = (rs, status, body, extra = {}) => { rs.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_fake_0001', 'x-gateway-host': F.host, ...extra }); rs.end(JSON.stringify(body)); };
	const err = (rs, status, type, message) => json(rs, status, { type: 'error', error: { type, message } });
	const server = http.createServer((req, rs) => {
		let raw = '';
		req.on('data', (d) => { raw += d; });
		req.on('end', () => {
			const u = new URL(req.url, 'http://x');
			u.pathname = u.pathname.replace(/^\/llm\/anthropic/, '');
			F.requests.push({ method: req.method, path: u.pathname, headers: Object.keys(req.headers) });
			const xk = req.headers['x-api-key'];
			const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
			const given = auth === 'x-api-key' ? xk : auth === 'bearer' ? bearer : (xk ?? bearer);
			if (req.headers[requiredHeader[0].toLowerCase()] !== requiredHeader[1]) return err(rs, 403, 'permission_error', `missing tenant header for ${F.host}`);
			if (!given) return err(rs, 401, 'authentication_error', 'x-api-key header is required');
			if (given !== F.key) return err(rs, 401, 'authentication_error', `invalid x-api-key ${given.slice(0, 12)}…`);
			if (!req.headers['anthropic-version']) return err(rs, 400, 'invalid_request_error', 'anthropic-version header is required');
			let body = {};
			try { body = raw ? JSON.parse(raw) : {}; } catch { return err(rs, 400, 'invalid_request_error', 'bad JSON'); }
			if (u.pathname === '/v1/models' && req.method === 'GET') return json(rs, 200, { data: [{ id: 'claude-opus-5-5', type: 'model' }, { id: 'adp-default', type: 'model' }], has_more: false });
			if (u.pathname === '/v1/messages/count_tokens') return countTokens ? json(rs, 200, { input_tokens: 9 }) : err(rs, 404, 'not_found_error', 'Not found');
			if (u.pathname !== '/v1/messages') return err(rs, 404, 'not_found_error', 'Not found');
			// echoKey: the error echoes the start of the caller's key and of the tenant header (as some gateways do).
			if (body.model !== 'claude-opus-5-5') return err(rs, 404, 'not_found_error', `model: ${body.model}${echoKey ? ` (key ${given.slice(0, 10)}…, tenant ${requiredHeader[1].slice(0, 9)}…)` : ''}`);
			const prompt = String(body.messages?.[0]?.content ?? '');
			if (/lighthouse/.test(prompt)) { setTimeout(() => json(rs, 200, { type: 'message', content: [] }), 1500); return; }
			const usage = { input_tokens: 12, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
			if (body.stream) {
				return sse(rs, [['message_start', { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, content: [], usage } }], ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }], ['ping', { type: 'ping' }], ...[1, 2, 3].map((n) => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${n}\n` } }]), ['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }], ['message_stop', { type: 'message_stop' }]]);
			}
			if (body.tools?.length) return json(rs, 200, { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', id: 'toolu_fake', name: 'get_weather', input: { city: 'Vilnius' } }], stop_reason: 'tool_use', usage });
			return json(rs, 200, { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: `pong (served by ${F.host})` }], stop_reason: 'end_turn', usage });
		});
	});
	let port = 0;
	const start = () => new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
	const stop = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
	// The access names a fake https host; the fetch sends it to the local server instead, and refuses any other host.
	const fetchImpl = (url, init) => {
		const u = new URL(url);
		if (u.hostname !== F.host) throw new Error(`dry run: a request to ${u.hostname} was refused`);
		return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
	};
	return { F, fetchImpl, start, stop, access: () => ({ baseUrl: `https://${F.host}/llm/anthropic`, apiKey: F.key, model: 'claude-opus-5-5', headers: [requiredHeader] }) };
}

async function dryRun() {
	const failures = [];
	const check = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); };
	// No network: any fetch that is not to the local fake fails the run.
	const realFetch = globalThis.fetch;
	let outside = 0;
	globalThis.fetch = (url, init) => {
		const u = new URL(String(url));
		if (u.hostname !== '127.0.0.1') { outside++; throw new Error(`dry run: network to ${u.hostname} refused`); }
		return realFetch(url, init);
	};

	console.log('== the ADP file');
	const dir = path.join(CACHE, 'dry-run', 'files');
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	const f = (name, text, mode = 0o600) => { const p = path.join(dir, name); fs.writeFileSync(p, text); fs.chmodSync(p, mode); return p; };
	const refuses = (fn, re, secret) => { try { fn(); return false; } catch (e) { return re.test(e.message) && !(secret && e.message.includes(secret)); } };
	const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const good = 'ADP_BASE_URL=https://adp.example.test/llm\nadp_api_key=sk-secret-value-1\n';
	const open = f('open.env', good, 0o644);
	check(refuses(() => readAdpAccess(open), new RegExp(`mode 644.*chmod 600 ${esc(open)}`), 'sk-secret-value-1'), 'a 0644 ADP file is refused, naming the file and the chmod fix, and the message holds no value');
	check(refuses(() => readAdpAccess(f('group.env', good, 0o640)), /mode 640/), 'a 0640 ADP file is refused');
	check(refuses(() => readAdpAccess(path.join(dir, 'missing.env')), new RegExp(`not found: ${esc(path.join(dir, 'missing.env'))}`)), 'a missing ADP file is refused, naming it');
	fs.symlinkSync(f('target.env', good), path.join(dir, 'link.env'));
	check(refuses(() => readAdpAccess(path.join(dir, 'link.env')), /symlinks are refused/), 'a symlinked ADP file is refused');
	check(refuses(() => readAdpAccess(f('no-url.env', 'adp_api_key=sk-secret-value-1\n')), /needs ADP_BASE_URL=/, 'sk-secret-value-1'), 'an ADP file without ADP_BASE_URL is refused');
	check(refuses(() => readAdpAccess(f('no-key.env', 'ADP_BASE_URL=https://adp.example.test\n')), /needs ADP_API_KEY[=]/), 'an ADP file without ADP_API_KEY is refused');
	check(refuses(() => readAdpAccess(f('http.env', good.replace('https:', 'http:'))), /must be https/, 'sk-secret-value-1'), 'an http ADP_BASE_URL (not localhost) is refused');
	check(refuses(() => readAdpAccess(f('bad-headers.env', `${good}ADP_HEADERS=no colon here\n`)), /ADP_HEADERS/, 'sk-secret-value-1'), 'an ADP_HEADERS pair without a colon is refused');
	const lower = readAdpAccess(f('lower.env', 'adp_base_url=https://adp.example.test/llm/\nAdp_Api_Key="sk-quoted value"\nADP_HEADERS=X-A: 1; X-B: two words ;\n'));
	check(lower.baseUrl === 'https://adp.example.test/llm' && lower.apiKey === 'sk-quoted value' && lower.model === DEFAULT_MODEL && JSON.stringify(lower.headers) === '[["X-A","1"],["X-B","two words"]]', 'keys are read case-insensitively, quotes stripped, the default model set, ADP_HEADERS split on ;');
	check(readAdpAccess(f('model.env', `${good}ADP_MODEL=adp-alias\n`)).model === 'adp-alias', 'ADP_MODEL overrides the model');
	{
		const before = outside;
		let fetched = 0;
		const code = await runMain({ file: open, fetchImpl: () => { fetched++; throw new Error('no'); }, quiet: true });
		check(code === 1 && fetched === 0 && outside === before, 'a refused file ends the probe before any request (exit 1)');
	}

	console.log('== redaction and the recorders');
	{
		const R = new Redactor();
		R.secret('sk-live-ABCDEF123'); R.id('gw.tenant.example.test', '<adp-host>');
		const out = JSON.stringify(R.value({ msg: 'bad key sk-live-ABCDEF123 at https://gw.tenant.example.test/v1 from 10.1.2.3 Bearer abc.def.ghi123', 'x-api-key': 'k', other: 'sk-another-key-99999999' }));
		check(!/ABCDEF|gw\.tenant|10\.1\.2\.3|abc\.def|Bearer <redacted> accepted|"k"|sk-another/.test(out) && /<adp-host>/.test(out), `a sample is clean: ${out}`);
		const s = sseSummary('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n', R);
		check(s.events === 4 && s.sequence[1].count === 2 && s.stop_reason === 'end_turn' && s.text_chars === 8 && s.usage.output_tokens === 2, 'the SSE recorder counts event types, collapses runs and keeps usage');
		check(messageSummary({ type: 'message', content: [{ type: 'text', text: 'x'.repeat(500) }] }, R).text_sample.length === SAMPLE_CHARS, 'a text sample is cut at 80 characters');
	}

	const cases = [['x-api-key', { auth: 'x-api-key' }], ['bearer-only', { auth: 'bearer' }], ['no-count-tokens', { countTokens: false }], ['echoed-key-prefix', { key: 'adpkey-ZZZZ9999yyyy8888xxxx', echoKey: true }]];
	for (const [label, opt] of cases) {
		console.log(`== dry run: ${label}`);
		const fake = makeFake(opt);
		await fake.start();
		const outDir = path.join(CACHE, 'dry-run', label);
		fs.mkdirSync(path.join(outDir, 'design-run-1'), { recursive: true });
		fs.writeFileSync(path.join(outDir, 'design-run-1', 'keep.json'), '{}');
		let res;
		try { res = await probe({ fetchImpl: fake.fetchImpl, access: fake.access(), outDir, timeoutCaseMs: 300 }); } finally { await fake.stop(); }
		const files = fs.readdirSync(outDir).filter((x) => OWN_FILE.test(x)).map((x) => [x, fs.readFileSync(path.join(outDir, x), 'utf8')]);
		const all = files.map(([, t]) => t).join('\n');
		const sensitive = { key: fake.F.key, keyStart: fake.F.key.slice(0, 12), keyStart8: fake.F.key.slice(0, 8), headerStart: fake.F.requiredHeader[1].slice(0, 8), wrongKey: res.wrongKey, host: 'fake-tenant', headerValue: fake.F.requiredHeader[1], loopback: '127.0.0.1' };
		for (const [k, v] of Object.entries(sensitive)) check(!all.includes(v), `${label}: no ${k} in the captures`);
		check(res.run.leak_scan.clean, `${label}: the probe's own leak self-scan is clean (${JSON.stringify(res.run.leak_scan.hits)})`);
		check(res.run.model_answered === 'claude-opus-5-5', `${label}: model_answered comes from the call that worked (${res.run.model_answered})`);
		if (opt.echoKey) {
			const u = files.find(([n]) => /error-unknown-model/.test(n))?.[1] ?? '';
			check(/<redacted>…/.test(u) && !u.includes(fake.F.key.slice(0, 8)), `${label}: an echoed start of a key that does not begin with sk- is redacted`);
		}
		check(res.run.calls <= MAX_CALLS && fake.F.requests.length === res.run.calls, `${label}: ${res.run.calls} calls, at most ${MAX_CALLS}, none retried`);
		check(fake.F.requests.every((r) => r.headers.includes('x-adp-tenant') && r.headers.includes('anthropic-version')), `${label}: ADP_HEADERS and anthropic-version on every call`);
		check(fs.existsSync(path.join(outDir, 'design-run-1', 'keep.json')), `${label}: other files in the captures folder are kept`);
		check(res.run.errors.length === 0, `${label}: no step failed (${JSON.stringify(res.run.errors)})`);
		const a = res.run.auth;
		if (label === 'x-api-key') check(a.works['x-api-key'] && !a.works.bearer && a.sdk_env === 'ANTHROPIC_API_KEY', `${label}: x-api-key works, Bearer refused, recorded`);
		if (label === 'bearer-only') check(!a.works['x-api-key'] && a.works.bearer && a.sdk_env === 'ANTHROPIC_AUTH_TOKEN', `${label}: Bearer works, x-api-key refused, recorded`);
		check(!!res.run.stream?.event_types?.includes('message_start') && res.run.stream.event_types.includes('content_block_delta') && /event-stream/.test(res.run.stream.content_type), `${label}: the stream's event types and content type are recorded`);
		check(res.run.tool_use?.stop_reason === 'tool_use' && res.run.tool_use.tool_use?.name === 'get_weather' && res.run.tool_use.tool_use.input_keys[0] === 'city', `${label}: tool use is recorded by name and input keys`);
		check(res.run.count_tokens?.status === (opt.countTokens === false ? 404 : 200), `${label}: count_tokens' status is recorded (${res.run.count_tokens?.status})`);
		check(res.run.models?.status === 200 && res.run.models.data_length === 2, `${label}: the models list is recorded`);
		const e = res.run.errors_seen ?? { wrong_key: {}, unknown_model: {}, timeout: {} };
		check(e.wrong_key.status === 401 && e.wrong_key.error_type === 'authentication_error', `${label}: a wrong key is recorded as 401 with its error type`);
		check(e.unknown_model.status === 404 && e.unknown_model.error_type === 'not_found_error', `${label}: an unknown model is recorded with its status and error type`);
		check(e.timeout.timed_out && e.timeout.client_error === 'TimeoutError', `${label}: a timeout is recorded as the client's TimeoutError`);
		const plain = files.find(([n]) => (label === 'bearer-only' ? /messages-plain-bearer/ : /messages-plain-x-api-key/).test(n))?.[1] ?? '';
		check(/"usage"/.test(plain) && /"input_tokens": 12/.test(plain) && /"header_names"/.test(plain) && /<redacted>|<adp-host>/.test(plain), `${label}: token counts and header names are recorded, the host a placeholder`);
	}
	console.log('== the self-scan finds a planted leak');
	{
		const d = path.join(CACHE, 'dry-run', 'planted');
		fs.rmSync(d, { recursive: true, force: true });
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, '01-x.json'), '{"a": "the key is sk-planted-9999"}');
		const s = selfScan(d, { api_key: 'sk-planted-9999' });
		check(!s.clean && s.hits.length === 1 && !JSON.stringify(s).includes('sk-planted'), 'a planted key is reported by name, not value');
		// The whole probe on a scan hit: the scan is given one more "secret" that every capture holds
		// (`"status": 200`), standing in for a leak the redaction missed; the run's files must go.
		const fake = makeFake({ key: 'adpkey-LEAK0000leak1111' });
		await fake.start();
		const dd = path.join(CACHE, 'dry-run', 'leak-hit');
		fs.rmSync(dd, { recursive: true, force: true });
		fs.mkdirSync(path.join(dd, 'design-run-1'), { recursive: true });
		let leaked;
		const origSelfScan = selfScanImpl.fn;
		selfScanImpl.fn = (dir, secrets) => origSelfScan(dir, { ...secrets, planted: '"status": 200' });
		try { leaked = await probe({ fetchImpl: fake.fetchImpl, access: fake.access(), outDir: dd, timeoutCaseMs: 300 }); } finally { selfScanImpl.fn = origSelfScan; await fake.stop(); }
		check(!leaked.run.leak_scan.clean && fs.readdirSync(dd).filter((x) => OWN_FILE.test(x)).length === 0 && fs.existsSync(path.join(dd, 'design-run-1')), 'on a self-scan hit the run\'s capture files are deleted (other folders kept)');
		check(await runMain({ fetchImpl: fake.fetchImpl, outDir: dd, quiet: true, file: f('leak.env', `ADP_BASE_URL=https://${fake.F.host}\nadp_api_key=x\n`), probeImpl: async () => leaked }) === 1, 'a self-scan hit exits non-zero');
	}
	check(outside === 0, 'no request left 127.0.0.1');
	globalThis.fetch = realFetch;
	console.log(failures.length ? `\ndry run: ${failures.length} check(s) FAILED` : '\ndry run: all checks passed');
	return failures.length ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------

/** The real run: the file first (refused before any request), then the probe. Returns the exit code. */
async function runMain({ file = ADP_FILE, fetchImpl, outDir = CAPS, quiet = false, probeImpl = probe } = {}) {
	let access;
	try { access = readAdpAccess(file); } catch (e) { if (!quiet) console.error(`adp-probe: ${e.message}`); return 1; }
	const res = await probeImpl({ fetchImpl, access, outDir });
	console.log(`captures: ${path.relative(ROOT, outDir)}`);
	return res.run.errors.length || !res.run.leak_scan.clean ? 1 : 0;
}

async function main() {
	const args = process.argv.slice(2);
	if (args.includes('--dry-run')) process.exit(await dryRun());
	if (args.length) { console.error(`adp-probe: unknown argument(s): ${args.join(' ')}`); process.exit(2); }
	const fetchImpl = (url, init) => fetch(url, init);
	fetchImpl.isReal = true;
	process.exit(await runMain({ fetchImpl }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((e) => { console.error(`adp-probe: ${String(e?.message ?? e).replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<redacted-key>').replace(/Bearer\s+\S+/g, 'Bearer <redacted>')}`); process.exit(1); });
}

export { probe, makeFake, readAdpAccess, parseHeaders, Redactor, shape, errInfo, sseSummary, selfScan };
