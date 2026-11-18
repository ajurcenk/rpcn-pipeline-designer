#!/usr/bin/env node
// Spike 7.1: probe a Redpanda Cloud cluster's Prometheus endpoint while a test pipeline with known
// components runs, and record what was asked and answered, redacted, as captures. Started by
// scripts/spike/metrics-probe.sh.
//
// Inputs:
//   ~/.config/rpcn-spike/credentials.env   client_id=..., client_secret=... (the service account of
//                                          spike 5.1: the cluster's details and the test pipeline)
//   ~/.config/rpcn-spike/metrics.env       PROMETHEUS_USER=, PROMETHEUS_PWD=, PROMETHEUS_URL= (keys
//                                          read case-insensitively; the URL https)
//                                          Each file must be a regular file owned by you, mode 0600.
//   METRICS_PROBE_CLUSTER=<name>           the cluster (default rpc-vilnius)
//   --dry-run                              no network and no credentials: a fake Cloud and a fake
//                                          Prometheus endpoint on 127.0.0.1; the refusals, the
//                                          redaction and the cleanup are checked
//
// What it does (one Cloud token per run; on Prometheus only GET):
//   Cloud: token, the cluster (its `prometheus` object by field name; whether `prometheus.url`
//   equals PROMETHEUS_URL, compared, never recorded), a test pipeline `vscode-spike-metrics-<run>`
//   (generate every 100 ms -> mapping `fast` -> sleep 5 ms `slow` -> mapping `erratic` that fails
//   every tenth message -> drop, 0.1 CPU) created and waited for (up to 5 minutes).
//   Prometheus: without an Authorization header, with a wrong password (in memory only), then with
//   the file's user: one read with OpenMetrics asked for, one uncompressed; then reads every 10 s
//   for 4 minutes with one 5-read burst 1 s apart; then the pipeline is stopped (reads every 10 s
//   for up to 1 minute) and deleted (reads every 10 s for up to 3 minutes after the delete).
//   The pipeline is deleted in `finally` too, also when a step failed; a create whose reply was lost
//   is found by its name.
//
// Outputs (re-generated on every run):
//   <findings>/captures/NN-<step>.json   one per step: {step, request?, response | result | error, ms}
//   <findings>/captures/summary.tsv      one row per capture
//   <findings>/captures/run.json         the answers in short, leftovers, errors, a leak self-scan
//   --dry-run writes to .cache/metrics-probe/dry-run/<case>/ instead.
//
// Redaction (every capture and every printed line): the service account, the token, the Prometheus
// password (and a non-default user) and the Authorization headers are `<redacted>`; the organization
// and cluster ids, the Data Plane and Prometheus hosts, any other cluster host, IP addresses and the
// run tag become placeholders. Series of pipelines the probe did not create appear only as metric
// names, label names and counts; the test pipeline's series are kept, its id `<pipeline-id>`, the
// values of labels other than path, label, quantile and le reduced to their form (letters `a`,
// digits `9`, punctuation kept).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FINDINGS = path.join(ROOT, '_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-metrics/spike-7-1-findings');
const CAPS = path.join(FINDINGS, 'captures');
const CACHE = path.join(ROOT, '.cache/metrics-probe');
const CRED_FILE = path.join(os.homedir(), '.config/rpcn-spike/credentials.env');
const METRICS_FILE = path.join(os.homedir(), '.config/rpcn-spike/metrics.env');

const AUTH_URL = 'https://auth.prd.cloud.redpanda.com/oauth/token';
const AUDIENCE = 'cloudv2-production.redpanda.cloud';
const CP = 'https://api.redpanda.com';
const PIPES = '/v1/redpanda-connect/pipelines';

const CLUSTER_NAME = process.env.METRICS_PROBE_CLUSTER || 'rpc-vilnius';

// The real run's timing (decision 2026-11-18: about 8 minutes; with the stop phase, 9 to 13).
const TIMING = {
	pollMs: 5_000,            // pipeline state poll
	startTimeoutMs: 300_000,  // up to 5 minutes to Running
	goneTimeoutMs: 180_000,
	readEveryMs: 10_000,      // reads every 10 s ...
	readMs: 240_000,          // ... for 4 minutes
	burstAfterRead: 12,       // after the 13th regular read (about 2 minutes in) ...
	burstReads: 5,            // ... 5 reads ...
	burstGapMs: 1_000,        // ... 1 s apart
	stopReadMs: 60_000,       // reads after the stop, up to 1 minute
	afterDeleteMs: 180_000,   // reads after the delete, up to 3 minutes
	absentReadsToEnd: 3,      // a phase after the stop or delete ends early after this many reads without the series
};
const FETCH_MS = 30_000;
const MAX_BODY = 64 * 1024 * 1024;

const RESOURCES = { cpu_shares: '100m', memory_shares: '400M' }; // 0.1 CPU
const NAME_PREFIX = 'vscode-spike-metrics-';
const OWN_COMPONENT_LABELS = ['fast', 'slow', 'erratic'];

const SECRET_KEY = /^(authorization|client_secret|client_id|access_token|id_token|refresh_token|secret_data|password|token|api_key|private_key|azp|username|user|principal|created_by|updated_by)$/i;
const OTHER_ID_KEY = /_ids?$/i;
const PUBLIC_HOSTS = new Set(['auth.prd.cloud.redpanda.com', 'api.redpanda.com', 'cloud.redpanda.com', 'docs.redpanda.com', 'www.redpanda.com']);
// Labels of the test pipeline's series whose values are kept as they are.
const SAFE_LABELS = new Set(['path', 'label', 'quantile', 'le']);
// Response headers whose values are recorded (others by name only).
const HEADER_VALUES = /^(content-type|content-encoding|content-length|transfer-encoding|cache-control|age|expires|etag|last-modified|retry-after|vary|www-authenticate|x-ratelimit-.*|ratelimit.*|x-prometheus-.*)$/i;
// Label names that may carry a pipeline id, tried when the test pipeline's own series are absent.
const ID_LABEL_GUESSES = ['pipeline_id', 'pipeline', 'redpanda_id', 'connect_pipeline_id', 'stream', 'job'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

// ---------------------------------------------------------------------------------------------
// Credentials (readEnvFile and readCloudCredentials copied from logs-probe.mjs, with the fix named)

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

function readCloudCredentials(file) {
	const v = readEnvFile(file, 'credentials');
	if (!v.client_id || !v.client_secret) throw new Error(`credentials file needs client_id= and client_secret= lines: ${file}`);
	return { clientId: v.client_id, clientSecret: v.client_secret };
}

/** The user's keys (decision 2026-11-18): PROMETHEUS_USER, PROMETHEUS_PWD, PROMETHEUS_URL. */
function readMetricsAccess(file) {
	const v = readEnvFile(file, 'metrics');
	const missing = ['prometheus_user', 'prometheus_pwd', 'prometheus_url'].filter((k) => !v[k]);
	if (missing.length) throw new Error(`metrics file needs ${missing.map((k) => `${k.toUpperCase()}=`).join(', ')} line(s): ${file}`);
	let u;
	try { u = new URL(v.prometheus_url); } catch { throw new Error(`metrics file's PROMETHEUS_URL is not a URL: ${file}`); }
	if (u.protocol !== 'https:') throw new Error(`metrics file's PROMETHEUS_URL must be https: ${file}`);
	if (u.username || u.password) throw new Error(`metrics file's PROMETHEUS_URL must not hold a user or password: ${file}`);
	return { user: v.prometheus_user, password: v.prometheus_pwd, url: v.prometheus_url };
}

/** Both files, before any request. */
function loadInputs(credFile = CRED_FILE, metricsFile = METRICS_FILE) {
	return { cloudCreds: readCloudCredentials(credFile), access: readMetricsAccess(metricsFile) };
}

// ---------------------------------------------------------------------------------------------
// Redaction (Redactor, shape, fieldsOf, errInfo copied from logs-probe.mjs)

class Redactor {
	constructor() {
		this.scrub = new Set(); // exact strings -> <redacted>
		this.ids = new Map();   // value -> placeholder
	}
	secret(v) { if (v != null && String(v).length >= 3) this.scrub.add(String(v)); }
	id(v, ph) { if (typeof v === 'string' && v.length >= 3 && !this.ids.has(v)) this.ids.set(v, ph); }
	text(s) {
		let out = String(s);
		for (const v of [...this.scrub].sort((a, b) => b.length - a.length)) out = out.split(v).join('<redacted>');
		out = out.replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '<redacted-jwt>');
		out = out.replace(/Bearer\s+(?!<redacted)[^\s"',]+/g, 'Bearer <redacted>');
		out = out.replace(/Basic\s+(?!<redacted|realm=)[A-Za-z0-9+/=]{6,}/g, 'Basic <redacted>');
		for (const [v, ph] of [...this.ids].sort((a, b) => b[0].length - a[0].length)) out = out.split(v).join(ph);
		out = out.replace(/(?:[a-z0-9*<>-]+\.)+(?:<cluster-id>|<dataplane-prefix>)(?:\.[a-z0-9<>-]+)*|(?:<cluster-id>|<dataplane-prefix>)(?:\.[a-z0-9<>-]+)+/gi, '<cluster-host>');
		out = out.replace(/\b(?:[a-z0-9*](?:[a-z0-9-]*[a-z0-9])?\.)+(?:redpanda\.com|redpanda\.cloud|amazonaws\.com|googleapis\.com|azure\.com|cloud\.redpanda\.com)\b/gi, (h) => (PUBLIC_HOSTS.has(h.toLowerCase()) ? h : '<cluster-host>'));
		out = out.replace(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:internal|local|svc)\b/gi, '<cluster-host>');
		out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>');
		out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
		return out;
	}
	value(v) {
		if (Array.isArray(v)) return v.map((x) => this.value(x));
		if (typeof v === 'bigint') return v.toString();
		if (Buffer.isBuffer(v)) return `<${v.length} bytes>`;
		if (v && typeof v === 'object') {
			const out = {};
			for (const [k, x] of Object.entries(v)) {
				const empty = x == null || x === '';
				if (SECRET_KEY.test(k) && !empty) out[k] = '<redacted>';
				else if (OTHER_ID_KEY.test(k) && typeof x === 'string' && x && !/^<[^<>]+>$/.test(x)) {
					const t = this.text(x);
					out[k] = t === x ? '<redacted-id>' : t;
				} else out[k] = this.value(x);
			}
			return out;
		}
		if (typeof v === 'string') return this.text(v);
		return v;
	}
}

/** Body shape: leaves become their type, arrays their length and first element's shape. */
function shape(v, depth = 0, key = '') {
	if (depth > 6) return '…';
	if (/tags|labels/i.test(key) && v && typeof v === 'object' && !Array.isArray(v)) return `${Object.keys(v).length} keys`;
	if (Array.isArray(v)) return v.length ? [`length ${v.length}`, shape(v[0], depth + 1)] : [];
	if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1, k)]));
	return v === null ? 'null' : typeof v;
}

/** A Cloud object's fields: booleans and numbers kept, strings by length, objects by their fields. */
function fieldsOf(v, depth = 0) {
	if (Array.isArray(v)) return { '<array>': v.length, first: v.length ? fieldsOf(v[0], depth + 1) : null };
	if (v && typeof v === 'object') {
		if (depth > 3) return `object (${Object.keys(v).length} fields)`;
		return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fieldsOf(x, depth + 1)]));
	}
	if (typeof v === 'string') return `string (${v.length} chars)`;
	return v;
}

function decodeJwtPayload(token) {
	try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

/** An error as data: name, code, message and nested causes; never a stack. */
function errInfo(e, depth = 0) {
	if (e == null) return null;
	if (typeof e !== 'object') return { message: String(e) };
	const o = { name: e.name ?? e.constructor?.name, message: String(e.message ?? e) };
	for (const k of ['code', 'errno', 'syscall', 'reason']) {
		if (e[k] != null && typeof e[k] !== 'object' && typeof e[k] !== 'function') o[k] = e[k];
	}
	if (Array.isArray(e.errors) && depth < 4) o.errors = e.errors.slice(0, 6).map((x) => errInfo(x, depth + 1));
	if (e.cause && depth < 4) o.cause = errInfo(e.cause, depth + 1);
	return o;
}

/** A label value reduced to its form: letters `a`, digits `9`, the rest kept. */
const formOf = (s) => String(s).replace(/[A-Za-z]+/g, 'a').replace(/[0-9]+/g, '9');

// ---------------------------------------------------------------------------------------------
// Prometheus: the read and the text

/** One GET with node:http(s), so the raw (compressed) size is seen; never throws. */
function promGet(url, { authorization, accept, acceptEncoding = 'gzip', lookup, timeoutMs = FETCH_MS } = {}) {
	return new Promise((resolve) => {
		const u = new URL(url);
		const mod = u.protocol === 'https:' ? https : http;
		const headers = { 'user-agent': 'rpcn-metrics-probe' };
		if (accept) headers.accept = accept;
		if (acceptEncoding) headers['accept-encoding'] = acceptEncoding;
		if (authorization) headers.authorization = authorization;
		const t0 = Date.now();
		let firstByteMs = null;
		const req = mod.request(u, { method: 'GET', headers, timeout: timeoutMs, ...(lookup ? { lookup } : {}) }, (res) => {
			const chunks = [];
			let size = 0;
			res.on('data', (d) => {
				if (firstByteMs == null) firstByteMs = Date.now() - t0;
				size += d.length;
				if (size <= MAX_BODY) chunks.push(d);
			});
			res.on('end', () => {
				const raw = Buffer.concat(chunks);
				const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
				let body = raw, decodeError = null;
				try {
					if (enc === 'gzip' || enc === 'x-gzip') body = zlib.gunzipSync(raw);
					else if (enc === 'deflate') body = zlib.inflateSync(raw);
					else if (enc === 'br') body = zlib.brotliDecompressSync(raw);
					else if (enc === 'zstd' && zlib.zstdDecompressSync) body = zlib.zstdDecompressSync(raw);
				} catch (e) { decodeError = String(e.message); }
				resolve({ status: res.statusCode, headers: res.headers, rawBytes: size, truncated: size > MAX_BODY, bytes: body.length, text: body.toString('utf8'), ms: Date.now() - t0, firstByteMs, decodeError, requestHeaders: Object.keys(headers) });
			});
			res.on('error', (e) => resolve({ netError: e, ms: Date.now() - t0, requestHeaders: Object.keys(headers) }));
		});
		req.on('timeout', () => req.destroy(new Error(`no answer in ${timeoutMs} ms`)));
		req.on('error', (e) => resolve({ netError: e, ms: Date.now() - t0, requestHeaders: Object.keys(headers) }));
		req.end();
	});
}

/** Prometheus text format 0.0.4 or OpenMetrics: TYPE lines and samples. */
function parseProm(text) {
	const types = new Map();
	const samples = [];
	let helps = 0, units = 0, bad = 0, eof = false;
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		if (line[0] === '#') {
			const m = /^#\s+(TYPE|HELP|UNIT)\s+(\S+)\s*(.*)$/.exec(line);
			if (m?.[1] === 'TYPE') types.set(m[2], m[3].trim());
			else if (m?.[1] === 'HELP') helps++;
			else if (m?.[1] === 'UNIT') units++;
			else if (line.trim() === '# EOF') eof = true;
			continue;
		}
		const s = parseSample(line);
		if (s) samples.push(s); else bad++;
	}
	return { types, samples, helps, units, bad, eof };
}

function parseSample(line) {
	const m = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(line);
	if (!m) return null;
	const name = m[0];
	let i = name.length;
	const labels = {};
	if (line[i] === '{') {
		i++;
		for (;;) {
			while (line[i] === ' ') i++;
			if (line[i] === '}') { i++; break; }
			const lm = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(line.slice(i));
			if (!lm) return null;
			i += lm[0].length;
			while (line[i] === ' ') i++;
			if (line[i] !== '=') return null;
			i++;
			while (line[i] === ' ') i++;
			if (line[i] !== '"') return null;
			i++;
			let v = '';
			for (; i < line.length && line[i] !== '"'; i++) {
				if (line[i] === '\\') { i++; v += line[i] === 'n' ? '\n' : line[i]; } else v += line[i];
			}
			if (line[i] !== '"') return null;
			i++;
			labels[lm[0]] = v;
			while (line[i] === ' ') i++;
			if (line[i] === ',') i++;
		}
	}
	const rest = line.slice(i).trim().split(/\s+/);
	if (!rest[0] || rest.length > 2) return null;
	const value = rest[0] === '+Inf' ? Infinity : rest[0] === '-Inf' ? -Infinity : Number(rest[0]);
	if (Number.isNaN(value) && rest[0] !== 'NaN') return null;
	if (rest[1] != null && Number.isNaN(Number(rest[1]))) return null;
	return { name, labels, value, ts: rest[1] != null ? Number(rest[1]) : undefined };
}

function familyOf(name, types) {
	if (types.has(name)) return name;
	for (const suf of ['_bucket', '_sum', '_count', '_total', '_created', '_info']) {
		if (name.endsWith(suf) && types.has(name.slice(0, -suf.length))) return name.slice(0, -suf.length);
	}
	return name;
}

/**
 * One read's answer, redacted: counts for everything, the test pipeline's own series in full (its
 * id a placeholder, unsafe label values by form). `foreign` collects other pipelines' label values
 * (in memory only) for the leak self-scan.
 */
function analyse(parsed, { pid, pipelineName, R, foreign, full }) {
	const { types, samples } = parsed;
	const idLabels = new Set(), idLabelsContaining = new Set();
	const own = [];
	const ownSet = new Set();
	const families = new Map();
	const labelNames = new Set();
	for (const s of samples) {
		const fam = familyOf(s.name, types);
		const f = families.get(fam) ?? { type: types.get(fam) ?? 'untyped', series: 0 };
		f.series++;
		families.set(fam, f);
		let mine = false;
		for (const [k, v] of Object.entries(s.labels)) {
			labelNames.add(k);
			if (pid && v === pid) { idLabels.add(k); mine = true; } else if (pid && v.includes(pid)) { idLabelsContaining.add(k); mine = true; }
		}
		s.fam = fam;
		if (mine) { own.push(s); ownSet.add(s); }
	}
	// Other pipelines: by the id label found (or a guess), counts only.
	const idLabel = [...idLabels][0] ?? ID_LABEL_GUESSES.find((g) => labelNames.has(g)) ?? null;
	const otherPipelines = new Set();
	const publicWords = [...families.keys(), ...labelNames];
	let otherConnectSeries = 0, nonConnectSeries = 0;
	for (const s of samples) {
		if (ownSet.has(s)) continue;
		const pv = idLabel ? s.labels[idLabel] : undefined;
		if (pv == null) { nonConnectSeries++; continue; }
		otherPipelines.add(pv);
		otherConnectSeries++;
		// Only other pipelines' Connect series (those with the id label) count for the leak self-scan:
		// cluster series' label values (topics, areas, regions) are often words of public family names.
		// Values of 3 or more characters; quantile/le numbers, `root.` paths and words of the public
		// family or label names (e.g. `input`) are not another pipeline's.
		if (foreign && foreign.size < 5000) {
			for (const [k, v] of Object.entries(s.labels)) {
				if (v.length < 3 || k === 'quantile' || k === 'le' || /^root\./.test(v) || v === CLUSTER_NAME || publicWords.some((w) => w.includes(v))) continue;
				foreign.add(v);
			}
		}
	}
	const ownLabelSets = new Set(own.map((s) => JSON.stringify(Object.fromEntries(Object.entries(s.labels).filter(([k]) => !SAFE_LABELS.has(k)).map(([k, v]) => [k, pid ? v.split(pid).map(formOf).join('<pipeline-id>') : formOf(v)])))));
	const redLabel = (k, v) => {
		if (v === pid) return '<pipeline-id>';
		if (v === pipelineName) return `${NAME_PREFIX}<run>`;
		if (R.ids.has(v)) return R.ids.get(v);
		if (pid && v.includes(pid)) return `<form: ${v.split(pid).map(formOf).join('<pipeline-id>')}>`;
		if (SAFE_LABELS.has(k) || OWN_COMPONENT_LABELS.includes(v)) return R.text(v);
		return `<form: ${formOf(v)}>`;
	};
	const ownOut = own.map((s) => ({ name: s.name, family: s.fam, labels: Object.fromEntries(Object.entries(s.labels).map(([k, v]) => [k, redLabel(k, v)])), value: Number.isFinite(s.value) ? s.value : String(s.value), ...(s.ts != null ? { ts: s.ts } : {}) }));
	const out = {
		series: samples.length,
		families: families.size,
		bad_lines: parsed.bad,
		openmetrics_eof: parsed.eof,
		samples_with_timestamps: samples.filter((s) => s.ts != null).length,
		id_label: [...idLabels],
		id_label_value_containing_pid: [...idLabelsContaining],
		own: {
			series: own.length,
			families: [...new Set(own.map((s) => s.fam))].sort(),
			non_component_label_sets: ownLabelSets.size,
			non_component_label_forms: [...ownLabelSets].map((x) => JSON.parse(x)),
			samples: ownOut,
		},
		others: { id_label_used: idLabel, pipelines: otherPipelines.size, connect_series: otherConnectSeries, other_series: nonConnectSeries },
	};
	if (full) {
		out.label_names = [...labelNames].sort();
		out.family_list = [...families].sort((a, b) => a[0].localeCompare(b[0])).map(([name, f]) => ({ name, type: f.type, series: f.series }));
		out.type_counts = [...families.values()].reduce((m, f) => ({ ...m, [f.type]: (m[f.type] ?? 0) + 1 }), {});
	}
	return out;
}

function headerSummary(h, R) {
	if (!h) return null;
	return { names: Object.keys(h).sort(), values: Object.fromEntries(Object.entries(h).filter(([k]) => HEADER_VALUES.test(k)).map(([k, v]) => [k, R.text(Array.isArray(v) ? v.join(', ') : String(v))])) };
}

/** A non-Prometheus body (an error): its kind, size, JSON shape or a short redacted preview. */
function bodyShape(text, R) {
	if (!text) return { kind: 'empty', bytes: 0 };
	try { return { kind: 'json', bytes: Buffer.byteLength(text), shape: shape(JSON.parse(text)) }; } catch { /* not JSON */ }
	const kind = /^\s*</.test(text) ? 'html' : 'text';
	return { kind, bytes: Buffer.byteLength(text), lines: text.split('\n').length, preview: R.text(text.slice(0, 80)) };
}

// ---------------------------------------------------------------------------------------------
// The probe

async function probe({ fetchImpl, cloudCreds, access, outDir, timing = TIMING, failAt, lookup }) {
	const T = { ...TIMING, ...timing };
	const R = new Redactor();
	R.secret(cloudCreds.clientId);
	R.secret(cloudCreds.clientSecret);
	R.secret(access.password);
	const userIsDefault = access.user === 'prometheus';
	if (!userIsDefault) R.secret(access.user);
	const basic = `Basic ${Buffer.from(`${access.user}:${access.password}`).toString('base64')}`;
	R.secret(basic.slice(6));
	const badPassword = `probe-wrong-${randomBytes(6).toString('hex')}`;
	R.secret(badPassword);
	const badBasic = `Basic ${Buffer.from(`${access.user}:${badPassword}`).toString('base64')}`;
	R.secret(badBasic.slice(6));
	const promUrl = new URL(access.url);
	R.id(promUrl.host, '<prometheus-host>');
	R.id(promUrl.hostname, '<prometheus-host>');
	const tag = randomBytes(5).toString('hex').slice(0, 8);
	const pipelineName = `${NAME_PREFIX}${tag}`;
	R.id(pipelineName, `${NAME_PREFIX}<run>`);
	R.id(tag, '<run>');

	const caps = [];
	const errors = [];
	const reads = [];       // compact rows of every authorised read
	const foreign = new Set();
	const scanSecrets = { password: access.password, password_start: access.password.slice(0, Math.min(6, access.password.length)), basic_auth: basic.slice(6), wrong_password: badPassword, client_id: cloudCreds.clientId, client_secret: cloudCreds.clientSecret, prometheus_host: promUrl.hostname, run_tag: tag };
	if (!userIsDefault) scanSecrets.user = access.user;
	const run = { date: new Date().toISOString(), cluster_name: CLUSTER_NAME, dry_run: !fetchImpl.isReal, timing: T, prometheus_user_is_default: userIsDefault };
	let token = null;
	const print = (s) => console.log(R.text(s));
	const inject = (step) => { if (failAt && step === failAt) throw new Error(`injected failure at ${step}`); };

	async function cloud(step, { method = 'GET', url, body, form, recordIt = true, quiet = false }) {
		inject(step);
		const headers = { accept: 'application/json' };
		if (token) headers.authorization = `Bearer ${token}`;
		let payload;
		if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
		else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
		const t0 = Date.now();
		let status = 0, text = '', netError = null;
		try {
			const res = await fetchImpl(url, { method, headers, body: payload, signal: AbortSignal.timeout(FETCH_MS) });
			status = res.status;
			text = await res.text();
		} catch (e) { netError = String(e?.message ?? e); }
		const ms = Date.now() - t0;
		let json;
		try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
		const cap = { step, request: { method, url, body: form ? Object.fromEntries(Object.keys(form).map((k) => [k, '<redacted>'])) : body }, response: netError ? { error: netError } : { status, body: json !== undefined ? json : text }, ms };
		if (recordIt) caps.push(cap);
		if (!quiet) print(`${step.padEnd(40)} ${method.padEnd(6)} ${url} -> ${netError ? `network error: ${netError}` : status} (${ms} ms)`);
		return { status, json, text, cap };
	}
	const ok = (r) => r.status >= 200 && r.status < 300;

	/** A step group; its error is recorded. A fatal one ends the flow (the cleanup in `finally` still runs). */
	async function section(name, fn, { fatal = false } = {}) {
		try { await fn(); } catch (e) {
			const msg = R.text(String(e?.message ?? e));
			errors.push({ section: name, error: msg });
			print(`!! ${name}: ${msg}${fatal ? ' (the flow ends here; cleaning up)' : ''}`);
			if (fatal) throw Object.assign(new Error(msg), { recorded: true });
		}
	}

	let dp = null;
	let pipeline = null; // {id, gone}
	const pipeUrl = (id, suffix = '') => `${dp}${PIPES}/${id}${suffix}`;
	const marks = {}; // phase -> ms timestamp: running, stop_requested, stopped, delete_requested, gone

	async function pipelineState(step) {
		const r = await cloud(step, { url: pipeUrl(pipeline.id), recordIt: false, quiet: true });
		return r.status === 200 ? (r.json?.pipeline?.state ?? '?') : `HTTP ${r.status}`;
	}

	async function waitFor(label, done, timeoutMs) {
		const t0 = Date.now();
		let last = null, lastState = null, polls = 0, timedOut = false;
		for (;;) {
			const r = await cloud(label, { url: pipeUrl(pipeline.id), recordIt: false, quiet: true });
			polls++;
			const p = r.json?.pipeline;
			const state = r.status === 200 ? (p?.state ?? '?') : `HTTP ${r.status}`;
			if (state !== lastState) { print(`${label.padEnd(40)} state ${state} after ${Date.now() - t0} ms`); lastState = state; }
			last = r;
			if (done(r, p)) break;
			if (Date.now() - t0 > timeoutMs || (T.pollMs === 0 && polls > 50)) { timedOut = true; break; }
			await sleep(T.pollMs);
		}
		last.cap.step = `${label}-final`;
		last.cap.derived = { polls, ms_waited: Date.now() - t0, timed_out: timedOut, final_state: lastState };
		caps.push(last.cap);
		return { p: last.json?.pipeline, state: lastState, timedOut };
	}

	async function deletePipeline(prefix) {
		if (!pipeline || pipeline.gone) return;
		marks.delete_requested ??= Date.now();
		const r = await cloud(`${prefix}-pipeline-delete`, { method: 'DELETE', url: pipeUrl(pipeline.id) });
		if (!ok(r) && r.status !== 404) throw new Error(`delete returned ${r.status}`);
		const w = await waitFor(`${prefix}-pipeline-gone`, (x) => x.status === 404, T.goneTimeoutMs);
		if (w.state === 'HTTP 404') { pipeline.gone = true; marks.gone = Date.now(); }
	}

	/** One read of the Prometheus endpoint, recorded; returns the analysis (or null). */
	async function prom(step, { auth = 'basic', accept, acceptEncoding = 'gzip', phase, full = false } = {}) {
		inject(step);
		const authorization = auth === 'basic' ? basic : auth === 'wrong' ? badBasic : undefined;
		const r = await promGet(access.url, { authorization, accept, acceptEncoding, lookup });
		const at = Date.now();
		const request = { method: 'GET', url: access.url, auth: auth === 'basic' ? 'basic, the file\'s user' : auth === 'wrong' ? 'basic, the file\'s user with a wrong password' : 'none', headers: r.requestHeaders, accept: accept ?? null, accept_encoding: acceptEncoding };
		const cap = { step, request, ms: r.ms };
		let a = null;
		if (r.netError) {
			cap.error = errInfo(r.netError);
			print(`${step.padEnd(40)} GET    ${access.url} -> network error: ${r.netError.message} (${r.ms} ms)`);
		} else {
			cap.response = { status: r.status, headers: headerSummary(r.headers, R), raw_bytes: r.rawBytes, bytes: r.bytes, truncated: r.truncated, first_byte_ms: r.firstByteMs, decode_error: r.decodeError };
			const ct = String(r.headers['content-type'] ?? '');
			const isMetrics = r.status === 200 && !/json|html/i.test(ct);
			if (isMetrics) {
				const parsed = parseProm(r.text);
				a = analyse(parsed, { pid: pipeline?.id, pipelineName, R, foreign, full });
				cap.response.metrics = a;
			} else cap.response.body = bodyShape(r.text, R);
			print(`${step.padEnd(40)} GET    ${access.url} -> ${r.status} ${r.rawBytes} B raw, ${r.bytes} B (${r.ms} ms)${a ? `, ${a.series} series, own ${a.own.series}` : ''}`);
		}
		caps.push(cap);
		if (auth === 'basic' && phase) {
			reads.push({ step, phase, at, since_running_ms: marks.running ? at - marks.running : null, status: r.status ?? 'network error', retry_after: r.headers?.['retry-after'] ?? null, raw_bytes: r.rawBytes ?? null, bytes: r.bytes ?? null, ms: r.ms, series: a?.series ?? null, own_series: a?.own.series ?? null, own: a ? Object.fromEntries(a.own.samples.map((s) => [`${s.name}{${Object.entries(s.labels).filter(([k]) => SAFE_LABELS.has(k)).map(([k, v]) => `${k}=${v}`).join(',')}}`, s.value])) : null, body_same_as_previous: null, _text: r.text?.length ? r.text : null });
			const n = reads.length;
			if (n > 1 && reads[n - 1]._text != null && reads[n - 2]._text != null) reads[n - 1].body_same_as_previous = reads[n - 1]._text === reads[n - 2]._text;
			if (n > 1) reads[n - 2]._text = null; // keep only the previous body, in memory
		}
		return { a, status: r.status, netError: r.netError };
	}

	/** Reads every `every` ms for at most `forMs`; ends early after `absentToEnd` reads without the series. */
	async function readPhase(prefix, phase, { every, forMs, absentToEnd, onEach }) {
		const t0 = Date.now();
		let absent = 0;
		for (let i = 0; ; i++) {
			const due = t0 + i * every;
			if (due - t0 > forMs) break;
			await sleep(Math.max(0, due - Date.now()));
			const r = await prom(`${prefix}-${String(i + 1).padStart(2, '0')}`, { phase });
			if (onEach) await onEach(i, r);
			if (absentToEnd && r.a && r.a.own.series === 0) { if (++absent >= absentToEnd) break; } else absent = 0;
		}
	}

	const pipelineConfig = [
		'input:',
		'  generate:',
		'    interval: 100ms',
		'    mapping: \'root = {"n": counter()}\'',
		'pipeline:',
		'  processors:',
		'    - label: fast',
		'      mapping: \'root = this\'',
		'    - label: slow',
		'      sleep:',
		'        duration: 5ms',
		'    - label: erratic',
		'      mapping: \'root = if this.n % 10 == 0 { throw("erratic failure") } else { this }\'',
		'output:',
		'  drop: {}',
		'',
	].join('\n');

	try {
		// ---- Cloud: token, cluster
		await section('token', async () => {
			const r = await cloud('token', { method: 'POST', url: AUTH_URL, form: { grant_type: 'client_credentials', client_id: cloudCreds.clientId, client_secret: cloudCreds.clientSecret, audience: AUDIENCE } });
			if (!ok(r) || !r.json?.access_token) throw new Error(`token request returned ${r.status}`);
			token = r.json.access_token;
			R.secret(token);
			scanSecrets.token = token;
			const claims = decodeJwtPayload(token) ?? {};
			for (const [k, v] of Object.entries(claims)) if (/org/i.test(k) && typeof v === 'string') { R.id(v, '<org-id>'); scanSecrets.org_id = v; }
			r.cap.response.body = { access_token: '<redacted>', expires_in: r.json.expires_in, token_type: r.json.token_type };
		});
		if (!token) throw new Error('no token; nothing else can run');

		await section('cluster', async () => {
			const l = await cloud('clusters-list', { url: `${CP}/v1/clusters?page_size=100` });
			const clusters = l.json?.clusters ?? [];
			let n = 2;
			let target = null;
			for (const c of clusters) {
				const mine = c.name === CLUSTER_NAME;
				R.id(c.id, mine ? '<cluster-id>' : `<cluster-id-${n++}>`);
				if (!mine && c.name) R.secret(c.name);
				if (mine) target = c;
			}
			l.cap.response.body = { clusters: clusters.length, found: !!target, next_page_token: l.json?.next_page_token ?? null };
			if (!target) throw new Error(`cluster ${CLUSTER_NAME} not in the list`);
			scanSecrets.cluster_id = target.id;
			const g = await cloud('cluster-get', { url: `${CP}/v1/clusters/${target.id}` });
			if (!ok(g)) throw new Error(`cluster get returned ${g.status}`);
			const c = g.json.cluster;
			dp = c.dataplane_api?.url?.replace(/\/+$/, '') ?? null;
			if (dp) {
				const host = new URL(dp).host;
				R.id(host, '<dataplane-host>');
				scanSecrets.dataplane_host = host;
				const prefix = /^[a-z]+-([a-z0-9]+)\./.exec(host)?.[1];
				if (prefix) R.id(prefix, '<dataplane-prefix>');
			}
			// Q1: the `prometheus` object by field name; its url compared with the file's, never recorded.
			const p = c.prometheus;
			const cmp = { cluster_has_prometheus: p != null && typeof p === 'object' };
			if (cmp.cluster_has_prometheus && typeof p.url === 'string') {
				let cu = null;
				try { cu = new URL(p.url); } catch { /* not a URL */ }
				if (cu && cu.hostname !== promUrl.hostname) { R.id(cu.host, '<cluster-prometheus-host>'); R.id(cu.hostname, '<cluster-prometheus-host>'); scanSecrets.cluster_prometheus_host = cu.hostname; }
				const norm = (u) => String(u).replace(/\/+$/, '');
				Object.assign(cmp, {
					url_is_a_url: !!cu,
					url_equals_file_url: p.url === access.url,
					url_equals_file_url_ignoring_trailing_slash: norm(p.url) === norm(access.url),
					same_scheme: cu ? cu.protocol === promUrl.protocol : null,
					same_host: cu ? cu.host === promUrl.host : null,
					same_path: cu ? norm(cu.pathname) === norm(promUrl.pathname) : null,
					cluster_url_path_segments: cu ? cu.pathname.split('/').filter(Boolean).length : null,
					file_url_path_segments: promUrl.pathname.split('/').filter(Boolean).length,
					file_url_has_query: !!promUrl.search,
				});
			}
			run.prometheus = { fields: p ? fieldsOf(p) : null, ...cmp };
			g.cap.response.body = { cluster: {
				name: c.name, type: c.type, state: c.state, cloud_provider: c.cloud_provider, region: c.region,
				redpanda_connect: c.redpanda_connect ? { version: c.redpanda_connect.version } : undefined,
				prometheus: p ? fieldsOf(p) : null,
				'<fields with prometheus, metric or monitor in their name>': fieldsOf(Object.fromEntries(Object.entries(c).filter(([x]) => /prometheus|metric|monitor/i.test(x) && x !== 'prometheus'))),
				'<other fields>': Object.keys(c).filter((x) => !['name', 'type', 'state', 'cloud_provider', 'region', 'prometheus', 'redpanda_connect'].includes(x)).sort(),
			} };
			run.cluster_type = c.type;
			run.connect_version = c.redpanda_connect?.version ?? null;
			print(`cluster: prometheus ${cmp.cluster_has_prometheus ? 'present' : 'absent'}, url equals the file's: ${cmp.url_equals_file_url ?? 'n/a'}`);
		});

		// ---- Q2: auth, before the pipeline exists
		await section('auth', async () => {
			const none = await prom('prom-auth-none', { auth: 'none' });
			const wrong = await prom('prom-auth-wrong-password', { auth: 'wrong' });
			const right = await prom('prom-auth-ok-before-pipeline', { auth: 'basic', full: true, phase: 'before-pipeline' });
			run.auth = { no_header: none.status ?? 'network error', wrong_password: wrong.status ?? 'network error', right: right.status ?? 'network error' };
		});

		// ---- The test pipeline
		if (dp) {
			await section('pipeline-create', async () => {
				const r = await cloud('pipeline-create', { method: 'POST', url: `${dp}${PIPES}`, body: { display_name: pipelineName, description: 'vscode spike 7.1 metrics probe, safe to delete', config_yaml: pipelineConfig, resources: RESOURCES, tags: { 'vscode-spike': 'metrics' } } });
				const p = r.json?.pipeline;
				if (ok(r) && p?.id && p.display_name === pipelineName) {
					pipeline = { id: p.id, gone: false };
					R.id(p.id, '<pipeline-id>');
					scanSecrets.pipeline_id = p.id;
				} else throw new Error(`pipeline create returned ${r.status}`);
			});
		}

		if (pipeline) {
			await section('pipeline-running', async () => {
				const w = await waitFor('pipeline-wait-running', (r, p) => ['STATE_RUNNING', 'STATE_ERROR', 'STATE_STOPPED', 'STATE_COMPLETED'].includes(p?.state) || r.status === 404, T.startTimeoutMs);
				run.start = { state: w.state, timed_out: w.timedOut, ms: caps.at(-1).derived.ms_waited };
				if (w.state !== 'STATE_RUNNING') throw new Error(`the test pipeline never got to Running (${w.state}${w.timedOut ? ', timed out' : ''})`);
				marks.running = Date.now();
			}, { fatal: true });
		}

		if (marks.running) {
			// ---- Q3: the variants: OpenMetrics, uncompressed
			await section('variants', async () => {
				const om = await prom('prom-openmetrics', { phase: 'variant', accept: 'application/openmetrics-text; version=1.0.0; charset=utf-8, text/plain; version=0.0.4; q=0.5', full: true });
				const id = await prom('prom-identity-encoding', { acceptEncoding: 'identity', phase: 'variant' });
				run.variants = { openmetrics: om.status ?? 'network error', identity: id.status ?? 'network error' };
			}, { fatal: true });

			// ---- Q4–Q6: reads every 10 s for 4 minutes, one burst
			await section('reads-running', async () => {
				await readPhase('read', 'running', {
					every: T.readEveryMs, forMs: T.readMs,
					onEach: async (i) => {
						if (i !== T.burstAfterRead) return;
						for (let b = 1; b <= T.burstReads; b++) {
							await sleep(T.burstGapMs);
							await prom(`burst-${b}`, { phase: 'burst' });
						}
					},
				});
				const s = await cloud('pipeline-state-after-reads', { url: pipeUrl(pipeline.id) });
				run.state_after_reads = s.json?.pipeline?.state ?? `HTTP ${s.status}`;
			}, { fatal: true });

			// ---- Q7: stop, then delete
			await section('stop', async () => {
				marks.stop_requested = Date.now();
				const r = await cloud('pipeline-stop', { method: 'PUT', url: pipeUrl(pipeline.id, '/stop') });
				if (!ok(r)) throw new Error(`stop returned ${r.status}`);
				await readPhase('after-stop', 'after-stop', {
					every: T.readEveryMs, forMs: T.stopReadMs, absentToEnd: T.absentReadsToEnd,
					onEach: async () => { if (!marks.stopped && (await pipelineState('pipeline-stop-poll')) === 'STATE_STOPPED') marks.stopped = Date.now(); },
				});
				run.stopped_after_ms = marks.stopped ? marks.stopped - marks.stop_requested : null;
			}, { fatal: true });
			await section('delete', async () => {
				await deletePipeline('main');
				const left = T.afterDeleteMs - (Date.now() - marks.delete_requested);
				await readPhase('after-delete', 'after-delete', { every: T.readEveryMs, forMs: Math.max(0, left), absentToEnd: T.absentReadsToEnd });
			});
		}
	} catch (e) {
		if (!e?.recorded) errors.push({ section: 'probe', error: R.text(String(e?.message ?? e)) });
	} finally {
		// ---- cleanup: the pipeline this run created, also when a step failed
		if (token && dp) {
			await section('cleanup', async () => {
				if (pipeline && !pipeline.gone) await deletePipeline('cleanup');
				const l = await cloud('cleanup-check-pipelines', { url: `${dp}${PIPES}?page_size=100&filter.name_contains=${NAME_PREFIX}` });
				const left = [], earlier = [];
				for (const p of l.json?.pipelines ?? []) {
					if (!String(p.display_name ?? '').startsWith(NAME_PREFIX)) continue;
					if (p.display_name === pipelineName) {
						if (!pipeline || pipeline.id !== p.id) {
							pipeline = { id: p.id, gone: false };
							R.id(p.id, '<pipeline-id>');
							scanSecrets.pipeline_id = p.id;
						}
						if (!pipeline.gone) await deletePipeline('cleanup-untracked');
						if (!pipeline.gone) left.push(`pipeline ${p.display_name}`);
					} else earlier.push(`pipeline ${p.display_name} (${p.state})`);
				}
				if (!ok(l)) left.push(`could not list pipelines (HTTP ${l.status})`);
				l.cap.response.body = { pipelines_named_vscode_spike_metrics: (l.json?.pipelines ?? []).length };
				run.leftovers_this_run = left.map((x) => R.text(x));
				run.leftovers_earlier_runs = earlier.map((x) => R.text(x));
				print(`cleanup: ${left.length ? `LEFT BEHIND: ${left.join(', ')}` : 'nothing left from this run'}`);
				if (earlier.length) print(`cleanup: earlier runs left (not touched): ${earlier.join(', ')}`);
			});
		}
		for (const r of reads) delete r._text;
		run.reads = reads;
		run.answers = summarise(reads, marks, caps);
		run.errors = errors;
		writeCaptures(outDir, caps, run, R);
		run.leak_scan = selfScan(outDir, scanSecrets, foreign);
		fs.writeFileSync(path.join(outDir, 'run.json'), `${JSON.stringify(R.value(run), null, 2)}\n`);
		print(`leak self-scan: ${run.leak_scan.clean ? 'clean' : `HITS in ${run.leak_scan.hits.map((h) => h.what).join(', ')}`}`);
	}
	return { run, tag, badPassword, pipelineId: pipeline?.id, R };
}

/** The short answers to 4–7 from the compact read rows. */
function summarise(reads, marks, caps) {
	const ok = reads.filter((r) => r.status === 200 && r.series != null);
	const withOwn = ok.filter((r) => r.own_series > 0);
	const metricsCaps = caps.filter((c) => c.response?.metrics);
	const lastOwn = [...metricsCaps].reverse().find((c) => c.response.metrics.own.series > 0)?.response.metrics;
	const out = {
		authorised_reads: reads.length,
		reads_with_status_200: ok.length,
		reads_with_own_series: withOwn.length,
		statuses: reads.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {}),
		raw_bytes_median: median(ok.map((r) => r.raw_bytes)),
		bytes_median: median(ok.map((r) => r.bytes)),
		bytes_max: ok.length ? Math.max(...ok.map((r) => r.bytes)) : null,
		ms_median: median(ok.map((r) => r.ms)),
		ms_max: ok.length ? Math.max(...ok.map((r) => r.ms)) : null,
		series_median: median(ok.map((r) => r.series)),
		id_label: lastOwn?.id_label ?? null,
		own_families: lastOwn?.own.families ?? null,
		own_series: lastOwn?.own.series ?? null,
	};
	// Q5: the latency per component from the last read with the series.
	if (lastOwn) {
		const lat = {};
		for (const s of lastOwn.own.samples) {
			if (!/latency/.test(s.family)) continue;
			const comp = `${s.labels.path ?? '?'} (${s.labels.label ?? ''})`;
			const e = (lat[comp] ??= { family: s.family });
			if (s.labels.quantile != null) e[`p${Math.round(Number(s.labels.quantile) * 100)}`] = s.value;
			else if (s.name.endsWith('_sum')) e.sum = s.value;
			else if (s.name.endsWith('_count')) e.count = s.value;
		}
		for (const e of Object.values(lat)) if (e.sum != null && e.count) e.mean = e.sum / e.count;
		out.latency_ns = lat;
		const p50 = Object.entries(lat).filter(([, e]) => typeof e.p50 === 'number');
		const top = p50.sort((a, b) => b[1].p50 - a[1].p50)[0];
		out.slowest_by_p50 = top ? top[0] : null;
	}
	// Q6: how often the input's counter moves across the regular reads; the burst.
	const counterKey = (r) => r.own && Object.keys(r.own).find((k) => /input_received/.test(k) && !/_bucket|_sum/.test(k));
	const running = reads.filter((r) => r.phase === 'running' && r.own_series > 0);
	const key = running.map(counterKey).find(Boolean) ?? null;
	if (key) {
		const pts = running.filter((r) => r.own[key] != null).map((r) => ({ at: r.at, v: r.own[key] }));
		const changes = [];
		for (let i = 1; i < pts.length; i++) if (pts[i].v !== pts[i - 1].v) changes.push(pts[i].at);
		const gaps = changes.slice(1).map((t, i) => t - changes[i]);
		out.counter = { series: key, reads: pts.length, changes: changes.length, unchanged_reads: pts.length - 1 - changes.length, median_ms_between_changes: median(gaps), values: pts.map((p) => p.v), went_back: pts.some((p, i) => i && p.v < pts[i - 1].v) };
	}
	const burst = reads.filter((r) => r.phase === 'burst');
	if (burst.length) out.burst = { reads: burst.length, statuses: burst.map((r) => r.status), retry_after: burst.map((r) => r.retry_after).filter(Boolean), body_same_as_previous: burst.map((r) => r.body_same_as_previous), counter_values: key ? burst.map((r) => r.own?.[key] ?? null) : null, ms: burst.map((r) => r.ms) };
	// Q7: appearance and disappearance.
	const first = reads.find((r) => r.own_series > 0);
	out.first_seen_after_running_ms = first && marks.running ? first.at - marks.running : null;
	out.first_read_had_series = reads.find((r) => r.since_running_ms != null)?.own_series > 0;
	const goneAfter = (phase, from) => {
		const r = reads.find((x) => x.phase === phase && x.own_series === 0);
		return r && from ? r.at - from : null;
	};
	out.gone_after_stop_ms = goneAfter('after-stop', marks.stop_requested);
	out.stopped_after_ms = marks.stopped && marks.stop_requested ? marks.stopped - marks.stop_requested : null;
	out.gone_after_delete_ms = goneAfter('after-delete', marks.delete_requested);
	out.still_present_on_last_read_after_delete = reads.filter((r) => r.phase === 'after-delete').at(-1)?.own_series > 0;
	out.delete_took_ms = marks.gone && marks.delete_requested ? marks.gone - marks.delete_requested : null;
	return out;
}

/** Pipelines the probe did not create are kept as their shape only. */
function foreignPipelines(body) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
	const out = { ...body };
	if (Array.isArray(out.pipelines)) out.pipelines = out.pipelines.map((x) => (String(x?.display_name ?? '').startsWith(NAME_PREFIX) ? x : { '<not the probe\'s; shape only>': shape(x) }));
	return out;
}

function writeCaptures(outDir, caps, run, R) {
	fs.rmSync(outDir, { recursive: true, force: true });
	fs.mkdirSync(outDir, { recursive: true });
	const rows = [['n', 'step', 'outcome', 'ms'].join('\t')];
	caps.forEach((c, i) => {
		const n = String(i + 1).padStart(2, '0');
		const red = R.value(c.response?.body !== undefined ? { ...c, response: { ...c.response, body: foreignPipelines(c.response.body) } } : c);
		fs.writeFileSync(path.join(outDir, `${n}-${c.step}.json`), `${JSON.stringify(red, null, 2)}\n`);
		const outcome = red.response ? `${red.response.status}${red.response.metrics ? ` series ${red.response.metrics.series} own ${red.response.metrics.own.series}` : ''}` : red.error ? `error: ${red.error.code ?? red.error.name ?? ''}` : 'ok';
		rows.push([n, red.step, outcome, c.ms ?? ''].join('\t'));
	});
	fs.writeFileSync(path.join(outDir, 'summary.tsv'), `${rows.join('\n')}\n`);
	fs.writeFileSync(path.join(outDir, 'run.json'), `${JSON.stringify(R.value(run), null, 2)}\n`);
}

/** Every output file scanned for each secret value and other pipelines' label values; names only. */
function selfScan(dir, secrets, foreign) {
	const files = fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
	const hits = [];
	for (const [what, v] of Object.entries(secrets)) {
		if (v == null || String(v).length < 3) continue;
		const inFiles = files.filter(([, t]) => t.includes(String(v))).map(([f]) => f);
		if (inFiles.length) hits.push({ what, files: inFiles.slice(0, 10) });
	}
	let foreignHits = 0;
	const foreignFiles = new Set();
	for (const v of foreign ?? []) for (const [f, t] of files) if (t.includes(v)) { foreignHits++; foreignFiles.add(f); }
	if (foreignHits) hits.push({ what: 'other pipelines\' label values', count: foreignHits, files: [...foreignFiles].slice(0, 10) });
	return { clean: hits.length === 0, files: files.length, secrets_checked: Object.keys(secrets).length, foreign_values_checked: foreign?.size ?? 0, hits };
}

// ---------------------------------------------------------------------------------------------
// Dry run: a fake Cloud (as in logs-probe.mjs) and a fake Prometheus endpoint on 127.0.0.1

function makeFake({ loseCreate, neverRunning, urlMismatch, rateLimit, unreachable } = {}) {
	const F = {
		clientId: 'fakeClientIdAAAA1111',
		clientSecret: 'fakeClientSecretBBBB2222',
		promUser: 'prometheus',
		promPassword: 'fakePromPassword-CCCC3333',
		org: 'org0fake0c0ffee0',
		cl: 'clfake0vilnius00abcd',
		foreignPid: 'd0foreignpipe0000xyz',
		foreignLabel: 'FOREIGN-LABEL-orders-secret',
		foreignInstance: 'ip-10-0-3-17.eu-central-1.compute.internal',
		foreignCluster: 'other-cluster-name',
		ownInstance: 'rpcn-inst-own-5555',
		topicName: 'customer-topic-confidential',
		creator: 'fakecreator000000001',
	};
	F.dp = `api-a1b2c3.${F.cl}.byoc.prd.cloud.redpanda.com`;
	F.promHost = `metrics-d4e5f6.${F.cl}.byoc.prd.cloud.redpanda.com`;
	const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
	const now = Math.floor(Date.now() / 1000);
	F.jwt = `${enc({ alg: 'RS256' })}.${enc({ 'https://cloud.redpanda.com/organization_id': F.org, iat: now, exp: now + 86400 })}.ZmFrZXNpZw`;

	const pipelines = new Map([['pfakeforeign01', { id: 'pfakeforeign01', display_name: 'orders-etl', state: 'STATE_RUNNING' }], ['pfakeoldmetr1', { id: 'pfakeoldmetr1', display_name: 'vscode-spike-metrics-old00000', state: 'STATE_STOPPED' }]]);
	const pending = new Map();
	let nextId = 1;
	const res = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	const cluster = () => ({ id: F.cl, name: 'rpc-vilnius', type: 'TYPE_DEDICATED', state: 'STATE_READY', cloud_provider: 'CLOUD_PROVIDER_AWS', region: 'eu-central-1', dataplane_api: { url: `https://${F.dp}` }, redpanda_connect: { version: '4.115.0' }, prometheus: { url: urlMismatch ? `https://metrics-other.${F.cl}.byoc.prd.cloud.redpanda.com/api/v1/metrics` : F.promUrl }, nat_gateways: [{ ip: '203.0.113.9' }] });

	async function fetchImpl(url, init) {
		const u = new URL(url);
		const method = init.method ?? 'GET';
		const body = init.body && init.headers['content-type'] === 'application/json' ? JSON.parse(init.body) : undefined;
		if (u.host === 'auth.prd.cloud.redpanda.com') {
			const f = new URLSearchParams(init.body);
			if (f.get('client_id') !== F.clientId || f.get('client_secret') !== F.clientSecret) return res(401, { error: 'access_denied' });
			return res(200, { access_token: F.jwt, expires_in: 86400, token_type: 'Bearer' });
		}
		if (init.headers.authorization !== `Bearer ${F.jwt}`) return res(401, { code: 'UNAUTHENTICATED' });
		if (u.host === 'api.redpanda.com') {
			if (u.pathname === '/v1/clusters') return res(200, { clusters: [cluster(), { id: 'clfake0other0000wxyz', name: F.foreignCluster }], next_page_token: '' });
			if (u.pathname === `/v1/clusters/${F.cl}`) return res(200, { cluster: cluster() });
			return res(404, { code: 'NOT_FOUND' });
		}
		if (u.host !== F.dp) throw new Error(`fake: unknown host ${u.host}`);
		const p = u.pathname;
		if (p === PIPES && method === 'GET') return res(200, { pipelines: [...pipelines.values()].filter((x) => x.display_name.includes(u.searchParams.get('filter.name_contains') ?? '')), next_page_token: '' });
		if (p === PIPES && method === 'POST') {
			const id = `pfakenew${String(nextId++).padStart(4, '0')}`;
			pipelines.set(id, { id, ...body, state: 'STATE_STARTING', created_by: `${F.creator}@${F.cl}.byoc.prd.cloud.redpanda.com`, updated_by: `${F.creator}@${F.cl}.byoc.prd.cloud.redpanda.com` });
			pending.set(id, neverRunning ? [] : ['STATE_STARTING', 'STATE_RUNNING']);
			F.ownPid = id;
			if (loseCreate) return res(504, { code: 'DEADLINE_EXCEEDED' });
			return res(200, { pipeline: pipelines.get(id) });
		}
		const m = /^\/v1\/redpanda-connect\/pipelines\/([^/]+)(\/stop)?$/.exec(p);
		if (m) {
			const pl = pipelines.get(m[1]);
			if (!pl) return res(404, { code: 'NOT_FOUND' });
			if (method === 'PUT' && m[2]) { pl.state = 'STATE_STOPPING'; pending.set(pl.id, ['STATE_STOPPED']); return res(200, { pipeline: pl }); }
			if (method === 'DELETE') { pending.set(pl.id, ['GONE']); return res(200, {}); }
			const q = pending.get(pl.id) ?? [];
			if (q.length) { const s = q.shift(); if (s === 'GONE') { pipelines.delete(pl.id); return res(404, { code: 'NOT_FOUND' }); } pl.state = s; }
			return res(200, { pipeline: pl });
		}
		return res(404, { code: 'NOT_FOUND' });
	}

	// The fake endpoint: the foreign pipeline's series, a cluster series, and the probe's own while it runs.
	const t0 = Date.now();
	let lastReq = 0;
	const comps = [['root.input', '', 'input'], ['root.pipeline.processors.0', 'fast', 'processor'], ['root.pipeline.processors.1', 'slow', 'processor'], ['root.pipeline.processors.2', 'erratic', 'processor'], ['root.output', '', 'output']];
	const text = (openmetrics) => {
		const n = Math.floor((Date.now() - t0) / 5); // counters move every 5 ms
		const L = (o) => `{${Object.entries(o).map(([k, v]) => `${k}="${String(v).replace(/["\\]/g, (c) => `\\${c}`)}"`).join(',')}}`;
		// A cluster series whose label value is a word of a family name the captures list (spike 7.1's
		// false positive): not another pipeline's value, so the self-scan must not count it.
		const lines = ['# HELP redpanda_kafka_partitions Partitions', '# TYPE redpanda_kafka_partitions gauge', `redpanda_kafka_partitions${L({ redpanda_topic: F.topicName })} 3`, '# TYPE redpanda_kafka_partitions_inflight gauge', `redpanda_kafka_partitions_inflight${L({ area: 'partitions', redpanda_region: 'eu-central-1' })} 1`];
		const series = (pid, inst, label, running) => {
			const out = [];
			for (const [p, l, kind] of comps) {
				const base = { pipeline_id: pid, instance: inst, path: p, label: label ?? l };
				out.push([`${kind === 'output' ? 'output_sent' : `${kind}_received`}`, 'counter', base, running ? n : 0]);
				if (kind === 'processor') out.push(['processor_error', 'counter', base, l === 'erratic' ? Math.floor(n / 10) : 0]);
				const lat = l === 'slow' ? 5.16e6 : 7700;
				for (const q of ['0.5', '0.9', '0.99']) out.push([`${kind}_latency_ns`, 'summary', { ...base, quantile: q }, lat * (1 + Number(q) / 10)]);
				out.push([`${kind}_latency_ns_sum`, null, base, lat * n]);
				out.push([`${kind}_latency_ns_count`, null, base, n]);
			}
			return out;
		};
		const all = series(F.foreignPid, F.foreignInstance, F.foreignLabel, true);
		const own = F.ownPid && pipelines.get(F.ownPid);
		if (own && ['STATE_RUNNING', 'STATE_STOPPING'].includes(own.state)) all.push(...series(F.ownPid, F.ownInstance, null, true));
		const typed = new Set();
		for (const [name, type, labels, v] of all) {
			if (type && !typed.has(name)) { typed.add(name); lines.push(`# TYPE ${name} ${type}`); }
			lines.push(`${name}${L(labels)} ${v}`);
		}
		if (openmetrics) lines.push('# EOF');
		return `${lines.join('\n')}\n`;
	};
	const want = `Basic ${Buffer.from(`${F.promUser}:${F.promPassword}`).toString('base64')}`;
	const server = http.createServer((req, rs) => {
		const gap = Date.now() - lastReq;
		lastReq = Date.now();
		if (req.headers.authorization !== want) { rs.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': `Basic realm="${F.promHost}"` }); rs.end(`Unauthorized for ${F.promHost}\n`); return; }
		if (rateLimit && gap < rateLimit) { rs.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '1' }); rs.end('Too Many Requests\n'); return; }
		const om = /openmetrics/.test(req.headers.accept ?? '');
		let body = Buffer.from(text(om));
		const headers = { 'content-type': om ? 'application/openmetrics-text; version=1.0.0; charset=utf-8' : 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-cache' };
		if (/gzip/.test(req.headers['accept-encoding'] ?? '')) { body = zlib.gzipSync(body); headers['content-encoding'] = 'gzip'; }
		rs.writeHead(200, headers);
		rs.end(body);
	});
	const start = () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
		const port = unreachable ? 1 : server.address().port;
		F.promUrl = `http://${F.promHost}:${port}/api/cloud/prometheus/public_metrics`;
		resolve();
	}));
	// The endpoint's host resolves to 127.0.0.1, so its name is the one the redaction must hide.
	const lookup = (hostname, opts, cb) => {
		if (hostname !== F.promHost) return cb(new Error(`fake lookup: unknown host ${hostname}`));
		return opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
	};
	return { F, fetchImpl, pipelines, start, stop: () => new Promise((r) => server.close(() => r())), lookup };
}

function scanDir(dir) { return fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]); }

async function dryRun() {
	const failures = [];
	const check = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); };

	console.log('== credentials files');
	const dir = path.join(CACHE, 'dry-run', 'creds');
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	const f = (name, text, mode = 0o600) => { const p = path.join(dir, name); fs.writeFileSync(p, text); fs.chmodSync(p, mode); return p; };
	const refuses = (fn, re, secret) => { try { fn(); return false; } catch (e) { return re.test(e.message) && !(secret && e.message.includes(secret)); } };
	const good = 'PROMETHEUS_USER=prometheus\nPROMETHEUS_PWD=pw-secret-1\nPROMETHEUS_URL=https://metrics.example.test/public_metrics\n';
	const open = f('open.env', good, 0o644);
	check(refuses(() => readMetricsAccess(open), new RegExp(`mode 644.*chmod 600 ${open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'pw-secret-1'), 'a 0644 metrics file is refused, naming the file and the chmod fix, and the message holds no value');
	check(refuses(() => readMetricsAccess(f('group.env', good, 0o640)), /mode 640/), 'a 0640 metrics file is refused');
	const upper = readMetricsAccess(f('upper.env', '# the user\'s keys\nPROMETHEUS_USER=prometheus\nPROMETHEUS_PWD="p@ss w=rd"\nPROMETHEUS_URL=https://metrics.example.test/x\n'));
	check(upper.user === 'prometheus' && upper.password === 'p@ss w=rd' && upper.url === 'https://metrics.example.test/x', 'the user\'s keys are read, quotes stripped');
	const lower = readMetricsAccess(f('lower.env', 'prometheus_user=u2\nPrometheus_Pwd=pw2\nprometheus_url=https://m.example.test/\n'));
	check(lower.user === 'u2' && lower.password === 'pw2', 'the keys are read case-insensitively');
	for (const k of ['PROMETHEUS_USER', 'PROMETHEUS_PWD', 'PROMETHEUS_URL']) {
		check(refuses(() => readMetricsAccess(f(`no-${k}.env`, good.split('\n').filter((l) => !l.startsWith(k)).join('\n'))), new RegExp(`needs ${k}=`), 'pw-secret-1'), `a metrics file without ${k} is refused`);
	}
	check(refuses(() => readMetricsAccess(f('http.env', good.replace('https:', 'http:'))), /must be https/, 'pw-secret-1'), 'an http PROMETHEUS_URL is refused');
	check(refuses(() => readMetricsAccess(f('userinfo.env', good.replace('https://', 'https://a:b@'))), /must not hold a user/), 'a PROMETHEUS_URL with a user in it is refused');
	fs.symlinkSync(path.join(dir, 'upper.env'), path.join(dir, 'link.env'));
	check(refuses(() => readMetricsAccess(path.join(dir, 'link.env')), /symlinks are refused/), 'a symlinked metrics file is refused');
	check(refuses(() => readMetricsAccess(path.join(dir, 'missing.env')), /not found/), 'a missing metrics file is refused');
	check(refuses(() => readCloudCredentials(f('cloud-open.env', 'client_id=a\nclient_secret=b\n', 0o644)), /mode 644.*chmod 600/), 'a 0644 credentials file is refused, naming the fix');
	check(refuses(() => readCloudCredentials(f('cloud-partial.env', 'client_id=a\n')), /needs client_id/), 'a credentials file without client_secret is refused');
	check(refuses(() => loadInputs(f('cloud-ok.env', 'client_id=a1234\nclient_secret=b1234\n'), open), /metrics file has mode 644/), 'loadInputs (run before any request) refuses a bad metrics file');

	console.log('== redaction and the parser');
	{
		const R = new Redactor();
		R.secret('pw-ABCDEF'); R.secret('dXNlcjpwdy1BQkNERUY=');
		R.id('clxyz0000000000000ab', '<cluster-id>');
		R.id('metrics-9a.clxyz0000000000000ab.fmc.prd.cloud.redpanda.com', '<prometheus-host>');
		const sample = { msg: 'auth pw-ABCDEF Basic dXNlcjpwdy1BQkNERUY= at https://metrics-9a.clxyz0000000000000ab.fmc.prd.cloud.redpanda.com/x and broker-3.clxyz0000000000000ab.fmc.prd.cloud.redpanda.com', other: 'redpanda-0.abcd1234.byoc.prd.cloud.redpanda.com 10.1.2.3 Basic Zm9vOmJhcg==', instance_id: 'i-123', public: 'https://api.redpanda.com/v1 auth.prd.cloud.redpanda.com', password: 'y' };
		const out = JSON.stringify(R.value(sample));
		check(!/pw-ABCDEF|dXNlcj|Zm9vOmJhcg|clxyz|metrics-9a|broker-3|abcd1234|10\.1\.2\.3|i-123|"y"/.test(out) && /api\.redpanda\.com/.test(out) && /<prometheus-host>/.test(out), `sample is clean and keeps public hosts: ${out}`);
		const p = parseProm('# HELP a_b x\n# TYPE a_b summary\na_b{path="root.input",label="",quantile="0.5"} 5.163878e+06\na_b_sum{path="root.input",label="x\\"y"} 12 1700000000000\na_b_count{path="root.input",label="z,w"} 3\nbad line here\nc +Inf\n# EOF\n');
		check(p.samples.length === 4 && p.samples[0].value === 5163878 && p.samples[1].labels.label === 'x"y' && p.samples[1].ts === 1700000000000 && p.samples[2].labels.label === 'z,w' && p.samples[3].value === Infinity && p.bad === 1 && p.eof && familyOf('a_b_sum', p.types) === 'a_b', 'the parser reads labels with escapes and commas, exponents, timestamps, +Inf, # EOF, and families');
		check(formOf('ip-10-0-3-17.eu-central-1.compute.internal') === 'a-9-9-9-9.a-a-9.a.a', 'a label value is reduced to its form');
	}

	const cases = [['normal', {}], ['burst-limited', { rateLimit: 0 }], ['url-mismatch', { urlMismatch: true }], ['failure-mid-flow', { failAt: 'read-05' }], ['lost-create', { loseCreate: true }], ['never-running', { neverRunning: true }], ['prometheus-unreachable', { unreachable: true }]];
	const timing = { pollMs: 0, startTimeoutMs: 5000, goneTimeoutMs: 5000, readEveryMs: 25, readMs: 600, burstAfterRead: 12, burstReads: 5, burstGapMs: 1, stopReadMs: 100, afterDeleteMs: 150, absentReadsToEnd: 3 };
	for (const [label, opt] of cases) {
		console.log(`== dry run: ${label}`);
		// burst-limited: a read within 10 ms of the previous one is answered 429 (only the burst's are).
		const fake = makeFake({ ...opt, rateLimit: opt.rateLimit === 0 ? 10 : undefined });
		await fake.start();
		const outDir = path.join(CACHE, 'dry-run', label);
		let res;
		try {
			res = await probe({ fetchImpl: fake.fetchImpl, cloudCreds: { clientId: fake.F.clientId, clientSecret: fake.F.clientSecret }, access: { user: fake.F.promUser, password: fake.F.promPassword, url: fake.F.promUrl }, outDir, timing, failAt: opt.failAt, lookup: fake.lookup });
		} finally { await fake.stop(); }
		const files = scanDir(outDir);
		const all = files.map(([, t]) => t).join('\n');
		const b64 = Buffer.from(`${fake.F.promUser}:${fake.F.promPassword}`).toString('base64');
		const sensitive = { clientId: fake.F.clientId, clientSecret: fake.F.clientSecret, password: fake.F.promPassword, passwordStart: fake.F.promPassword.slice(0, 6), basicAuth: b64, badPassword: res.badPassword, jwt: fake.F.jwt.split('.')[1], org: fake.F.org, cluster: fake.F.cl, dpHost: 'a1b2c3', promHost: 'metrics-d4e5f6', otherPromHost: 'metrics-other', foreignPid: fake.F.foreignPid, foreignLabel: 'FOREIGN-LABEL', foreignInstance: 'ip-10-0-3-17', foreignCluster: fake.F.foreignCluster, creator: fake.F.creator, topic: fake.F.topicName, natIp: '203.0.113.9', ownInstance: 'inst-own-5555', tag: res.tag, loopback: '127.0.0.1' };
		if (fake.F.ownPid) sensitive.ownPid = fake.F.ownPid;
		for (const [k, v] of Object.entries(sensitive)) check(!all.includes(v), `${label}: no ${k} in the captures`);
		check(res.run.leak_scan?.clean === true, `${label}: the probe's own leak self-scan is clean (${JSON.stringify(res.run.leak_scan?.hits)})`);
		if (label === 'normal') check(/redpanda_kafka_partitions_inflight/.test(all) && /eu-central-1/.test(all) && res.run.leak_scan.foreign_values_checked > 0, `${label}: a cluster series' label value that is a word of a listed family name (or the region) is not counted as another pipeline's value, while other pipelines' values are still checked`);
		check(!fake.pipelines.has(fake.F.ownPid ?? 'none') && fake.pipelines.has('pfakeforeign01') && fake.pipelines.has('pfakeoldmetr1'), `${label}: the fake cluster holds nothing this run created, and nothing else was touched`);
		check((res.run.leftovers_this_run ?? ['missing']).length === 0, `${label}: cleanup reports nothing left from this run`);
		check((res.run.leftovers_earlier_runs ?? []).length === 1, `${label}: an earlier run's pipeline is reported, not deleted`);
		if (label !== 'prometheus-unreachable') {
			const none = files.find(([n]) => n.includes('prom-auth-none'));
			const wrong = files.find(([n]) => n.includes('prom-auth-wrong-password'));
			check(none && /"status": 401/.test(none[1]) && /www-authenticate/.test(none[1]) && /"kind": "text"/.test(none[1]), `${label}: no Authorization header is recorded as 401 with the header names and the body's shape`);
			check(none && /Basic realm=/.test(none[1]), `${label}: the www-authenticate realm is kept (not taken for a Basic credential)`);
			check(wrong && /"status": 401/.test(wrong[1]) && /wrong password/.test(wrong[1]), `${label}: a wrong password is recorded as 401`);
		}
		if (label === 'normal' || label === 'url-mismatch') {
			check(res.run.errors.length === 0, `${label}: no section failed (${JSON.stringify(res.run.errors)})`);
			const a = res.run.answers;
			check(a.reads_with_own_series >= 20, `${label}: the test pipeline's series were found in at least 20 reads (${a.reads_with_own_series})`);
			check(JSON.stringify(a.id_label) === '["pipeline_id"]', `${label}: the id label is found by the pipeline's id (${JSON.stringify(a.id_label)})`);
			check(a.slowest_by_p50 === 'root.pipeline.processors.1 (slow)', `${label}: the sleep processor is the slowest by p50 (${a.slowest_by_p50})`);
			check(a.counter && a.counter.changes > 0 && !a.counter.went_back, `${label}: the input's counter moves across the reads`);
			check(a.burst?.reads === 5, `${label}: one burst of 5 reads`);
			check(a.first_seen_after_running_ms != null && a.authorised_reads === res.run.reads.length && res.run.reads.some((r) => r.phase === 'variant') && res.run.reads[0].phase === 'before-pipeline', `${label}: the auth and variant reads are in the read sequence (first seen, cached bodies)`);
			check(a.gone_after_stop_ms != null && a.gone_after_delete_ms != null, `${label}: the series' end is measured after the stop and the delete`);
			const read = files.find(([n]) => /-read-01\.json$/.test(n));
			check(read && /"<pipeline-id>"/.test(read[1]) && /"label": "slow"/.test(read[1]) && /"path": "root.pipeline.processors.1"/.test(read[1]) && /"instance": "<form: a-a-a-9>"/.test(read[1]), `${label}: own series keep path and label, the id a placeholder, the instance by form`);
			const om = files.find(([n]) => n.includes('prom-openmetrics'));
			check(om && /openmetrics-text/.test(om[1]) && /"openmetrics_eof": true/.test(om[1]) && /"family_list"/.test(om[1]), `${label}: the OpenMetrics read is recorded with the family list`);
			const first = files.find(([n]) => n.includes('prom-auth-ok-before-pipeline'));
			check(first && /"label_names"/.test(first[1]) && /"pipelines": 1/.test(first[1]), `${label}: other pipelines are counted by the guessed id label, by shape only`);
			check(/content-encoding/.test(read?.[1] ?? '') && /"raw_bytes": \d+/.test(read?.[1] ?? ''), `${label}: compression and raw size are recorded`);
		}
		if (label === 'normal') check(res.run.prometheus.url_equals_file_url === true, `${label}: the cluster's prometheus.url is compared, equal`);
		if (label === 'url-mismatch') check(res.run.prometheus.url_equals_file_url === false && res.run.prometheus.same_host === false, `${label}: a different prometheus.url is reported, not recorded`);
		if (label === 'burst-limited') check(res.run.answers.burst?.statuses.includes(429) && res.run.answers.burst.retry_after.includes('1'), `${label}: a refused burst read is recorded with 429 and Retry-After`);
		if (label === 'failure-mid-flow') check(res.run.errors.some((e) => e.error.includes('injected failure')) && files.some(([n]) => n.includes('cleanup-pipeline-delete')), `${label}: the injected failure is recorded and the pipeline deleted in cleanup`);
		if (label === 'lost-create') check(files.some(([n]) => n.includes('cleanup-untracked-pipeline-delete')), `${label}: the pipeline whose create reply was lost is found by its name and deleted`);
		if (label === 'never-running') check(res.run.errors.some((e) => /never got to Running/.test(e.error)) && files.some(([n]) => n.includes('cleanup-pipeline-delete')), `${label}: a pipeline that never runs is reported and deleted`);
		if (label === 'prometheus-unreachable') check(files.some(([n, t]) => n.includes('prom-auth-none') && /"error"/.test(t) && /ECONNREFUSED/.test(t)) && files.some(([n]) => n.includes('main-pipeline-delete')), `${label}: a network error is recorded and the pipeline still deleted`);
	}

	console.log('== the self-scan finds a planted leak');
	{
		const d = path.join(CACHE, 'dry-run', 'planted');
		fs.rmSync(d, { recursive: true, force: true });
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, '01-x.json'), '{"a": "the password is hunter2-xyz and FOREIGN-VALUE-123"}');
		const s = selfScan(d, { password: 'hunter2-xyz' }, new Set(['FOREIGN-VALUE-123']));
		check(!s.clean && s.hits.length === 2 && !JSON.stringify(s).includes('hunter2'), 'a planted password and a foreign value are reported by name, not value');
	}
	console.log(failures.length ? `\ndry run: ${failures.length} check(s) FAILED` : '\ndry run: all checks passed');
	process.exit(failures.length ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------

async function main() {
	const args = process.argv.slice(2);
	if (args.includes('--dry-run')) return dryRun();
	if (args.length) { console.error(`metrics-probe: unknown argument(s): ${args.join(' ')}`); process.exit(2); }
	let inputs;
	try { inputs = loadInputs(); } catch (e) { console.error(`metrics-probe: ${e.message}`); process.exit(1); }
	const fetchImpl = (url, init) => fetch(url, init);
	fetchImpl.isReal = true;
	const res = await probe({ fetchImpl, ...inputs, outDir: CAPS, timing: TIMING, failAt: null });
	console.log(`captures: ${path.relative(ROOT, CAPS)}`);
	const left = res.run.leftovers_this_run;
	if (!left || left.length || res.run.errors.length || !res.run.leak_scan.clean) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((e) => { console.error(`metrics-probe: ${String(e?.message ?? e).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<redacted-jwt>').replace(/Basic\s+[A-Za-z0-9+/=]{6,}/g, 'Basic <redacted>')}`); process.exit(1); });
}

export { probe, makeFake, parseProm, analyse, readMetricsAccess, selfScan };
