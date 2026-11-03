#!/usr/bin/env node
// Spike 5.1: probe the Redpanda Cloud Control Plane and Data Plane APIs on a real cluster and
// record every request and response, redacted, as captures. Started by scripts/spike/cloud-probe.sh.
//
// Inputs:
//   ~/.config/rpcn-spike/credentials.env   client_id=..., client_secret=... (a service account);
//                                          must be a regular file owned by you with mode 0600
//   CLOUD_PROBE_CLUSTER=<name>             the cluster probed (default rpc-vilnius)
//   CLOUD_PROBE_OTHER_CLUSTERS=1           also list pipelines (read-only) on every other BYOC or
//                                          Dedicated cluster; successful bodies are kept as shapes only
//   CLOUD_PROBE_TRY_NO_RESOURCES=1         also create a pipeline without `resources` (the cluster's
//                                          default size, which may exceed 0.1 CPU); off by default
//   --dry-run                              no network and no credentials: the whole flow runs against
//                                          an in-memory fake, the planned requests are printed with
//                                          placeholders, and the redaction and cleanup are checked
//
// What it does (one token per run; the org has a daily token quota):
//   token, a bad-secret token request, cluster list and get, 401 and 404 cases; on the probed
//   cluster: pipeline and secret lists, config-schema and lint candidates, a secret (create, create
//   again, get, delete), pipelines `vscode-spike-<run>-*` (invalid configs, tags as an array, the
//   minimum body, the main one that reads the secret through ${secrets.NAME}, one that reads a
//   missing secret), and on the main one: wait running, stop, three update variants, start, an
//   update while running, delete. Every pipeline is `generate` -> `drop` at 0.1 CPU.
//   Cleanup runs in `finally`: everything this run created is deleted and waited for; then the
//   pipeline and secret lists are checked for `vscode-spike-*` / `VSCODE_SPIKE_*` leftovers
//   (this run's are an error; earlier runs' are reported and never touched).
//
// Outputs (re-generated on every run):
//   <findings>/captures/NN-<step>.json   {request, response, ms, derived?} per recorded call
//   <findings>/captures/summary.tsv      one row per recorded call
//   <findings>/captures/timeline.tsv     every state poll: label, ms since the poll began, state, error
//   <findings>/captures/run.json         cluster type, pipeline API availability, leftovers, errors
//   .cache/cloud-probe/                  the full config-schema body, if any (git-ignored)
//   --dry-run writes to .cache/cloud-probe/dry-run/<case>/ instead.
//
// Redaction (applied to every capture and every printed line): the client id and secret, the
// access token, any JWT, `Bearer <x>`, secret values (plain and base64) are `<redacted>`; keys
// such as authorization, client_secret, access_token, secret_data, password and license-like keys
// are `<redacted>`; the org id, cluster ids, Data Plane hosts, probe pipeline ids and the run tag
// become <org-id>, <cluster-id>, <dataplane-host>, <pipeline-id-…>, <run>; other `*_id` values
// become <redacted-id>; e-mail addresses <email>; `config_yaml` of a pipeline the probe did not
// create is dropped. Credentials and the token are never printed, logged or written.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomInt, randomBytes } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FINDINGS = path.join(ROOT, '_bmad-output/initiative-rpcn-vscode-designer/epic-deploy-to-redpanda-cloud/spike-5-1-findings');
const CAPS = path.join(FINDINGS, 'captures');
const CACHE = path.join(ROOT, '.cache/cloud-probe');
const CRED_FILE = path.join(os.homedir(), '.config/rpcn-spike/credentials.env');

const AUTH_URL = 'https://auth.prd.cloud.redpanda.com/oauth/token';
const AUDIENCE = 'cloudv2-production.redpanda.cloud';
const CP = 'https://api.redpanda.com';
const PIPES = '/v1/redpanda-connect/pipelines';

const CLUSTER_NAME = process.env.CLOUD_PROBE_CLUSTER || 'rpc-vilnius';
const OTHER_CLUSTERS = process.env.CLOUD_PROBE_OTHER_CLUSTERS === '1';
const TRY_NO_RESOURCES = process.env.CLOUD_PROBE_TRY_NO_RESOURCES === '1';

const FETCH_MS = 30_000;          // abort any one request after this
const POLL_MS = 5_000;            // state poll interval
const START_TIMEOUT_MS = 300_000; // wait for RUNNING / STOPPED
const GONE_TIMEOUT_MS = 180_000;  // wait for a deleted pipeline to 404
const ERROR_WATCH_MS = 180_000;   // wait for the missing-secret pipeline to settle
const RUNNING_WATCH_MS = 30_000;  // watch the state after an update while running

const RESOURCES = { cpu_shares: '100m', memory_shares: '400M' }; // 0.1 CPU
const NAME_PREFIX = 'vscode-spike-';
const SECRET_PREFIX = 'VSCODE_SPIKE_';

const SECRET_KEY = /^(authorization|client_secret|client_id|access_token|id_token|refresh_token|secret_data|password|token|api_key|private_key|azp)$/i;
const LICENSE_KEY = /licen[cs]e/i;
const OTHER_ID_KEY = /_ids?$/i;
const FOREIGN_CONFIG = '<redacted: a pipeline the probe did not create>';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// ---------------------------------------------------------------------------------------------
// Credentials

function readCredentials(file) {
	let st;
	try { st = fs.lstatSync(file); } catch { throw new Error(`credentials file not found: ${file}`); }
	if (!st.isFile()) throw new Error(`credentials file is not a regular file (symlinks are refused): ${file}`);
	if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`credentials file is not owned by you: ${file}`);
	const mode = st.mode & 0o777;
	if (mode !== 0o600) throw new Error(`credentials file has mode ${mode.toString(8)}, must be 600: ${file}`);
	const vals = {};
	for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const m = /^(?:export\s+)?([A-Za-z_]+)\s*=\s*(.*)$/.exec(line);
		if (!m) continue;
		let v = m[2].trim();
		if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
		vals[m[1].toLowerCase()] = v;
	}
	if (!vals.client_id || !vals.client_secret) throw new Error(`credentials file needs client_id= and client_secret= lines: ${file}`);
	return { clientId: vals.client_id, clientSecret: vals.client_secret };
}

// ---------------------------------------------------------------------------------------------
// Redaction

class Redactor {
	constructor() {
		this.scrub = new Set();   // exact strings -> <redacted>
		this.ids = new Map();     // value -> placeholder
		this.probePipelines = new Set();
	}
	secret(v) { if (v != null && String(v).length >= 4) this.scrub.add(String(v)); }
	id(v, ph) { if (typeof v === 'string' && v.length >= 3 && !this.ids.has(v)) this.ids.set(v, ph); }
	text(s) {
		let out = String(s);
		for (const v of [...this.scrub].sort((a, b) => b.length - a.length)) out = out.split(v).join('<redacted>');
		out = out.replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '<redacted-jwt>');
		out = out.replace(/Bearer\s+(?!<redacted)[^\s"',]+/g, 'Bearer <redacted>');
		for (const [v, ph] of [...this.ids].sort((a, b) => b[0].length - a[0].length)) out = out.split(v).join(ph);
		out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
		return out;
	}
	value(v) {
		if (Array.isArray(v)) return v.map((x) => this.value(x));
		if (v && typeof v === 'object') {
			const out = {};
			for (const [k, x] of Object.entries(v)) {
				const empty = x == null || x === '';
				if (SECRET_KEY.test(k) && !empty) out[k] = '<redacted>';
				else if (LICENSE_KEY.test(k) && !empty) out[k] = '<redacted>';
				else if (OTHER_ID_KEY.test(k) && typeof x === 'string' && x) {
					const t = this.text(x);
					out[k] = t === x ? '<redacted-id>' : t;
				} else if (k === 'config_yaml' && typeof x === 'string' && typeof v.id === 'string' && !this.probePipelines.has(v.id)) out[k] = FOREIGN_CONFIG;
				else out[k] = this.value(x);
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

function decodeJwtPayload(token) {
	try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

const pipelineOf = (json) => (json && typeof json === 'object' && json.pipeline) ? json.pipeline : json;

function fieldsDiff(before, after) {
	const keys = ['display_name', 'description', 'config_yaml', 'resources', 'tags', 'state', 'status'];
	const out = {};
	for (const k of keys) out[k] = JSON.stringify(before?.[k]) === JSON.stringify(after?.[k]) ? 'unchanged' : 'changed';
	return out;
}

// ---------------------------------------------------------------------------------------------
// The probe

async function probe({ fetchImpl, creds, outDir, pollMs, failAt, cacheDir }) {
	const R = new Redactor();
	R.secret(creds.clientId);
	R.secret(creds.clientSecret);
	const tag = randomBytes(5).toString('hex').slice(0, 8);
	const TAG = tag.toUpperCase();
	R.id(`${NAME_PREFIX}${tag}`, `${NAME_PREFIX}<run>`);
	R.id(`${SECRET_PREFIX}${TAG}`, `${SECRET_PREFIX}<RUN>`);
	// A duration: the main pipeline's `generate.interval` reads it, so the pipeline starts only when
	// the value really reaches it (an unsubstituted `${secrets.X}` is no duration).
	const secretValue = `${randomInt(1000, 9999)}ms`;
	R.secret(secretValue);
	R.secret(b64(secretValue));
	// Quotes and a backslash: does a quoted reference inside Bloblang survive such a value?
	const quotedValue = `q"${randomInt(100000, 999999)}\\x`;
	R.secret(quotedValue);
	R.secret(b64(quotedValue));
	const badToken = `probe-invalid-${randomBytes(6).toString('hex')}`;
	R.secret(badToken);

	const caps = [];
	const timeline = [];
	const errors = [];
	const run = { date: new Date().toISOString(), cluster_name: CLUSTER_NAME, dry_run: !fetchImpl.isReal };
	let token = null;
	let seq = 0;

	const print = (s) => console.log(R.text(s));

	async function http(step, { method = 'GET', url, auth = 'token', body, form, record = true, quiet = false }) {
		if (failAt && step === failAt) throw new Error(`injected failure at ${step}`);
		const headers = { accept: 'application/json' };
		if (auth === 'token') headers.authorization = `Bearer ${token}`;
		if (auth === 'bad') headers.authorization = `Bearer ${badToken}`;
		let payload;
		if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
		else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
		const t0 = Date.now();
		let status = 0, text = '', resHeaders = {}, netError = null;
		try {
			const res = await fetchImpl(url, { method, headers, body: payload, signal: AbortSignal.timeout(FETCH_MS) });
			status = res.status;
			res.headers.forEach((v, k) => { resHeaders[k] = /authorization|cookie|token/i.test(k) ? '<redacted>' : v; });
			text = await res.text();
		} catch (e) {
			netError = String(e?.message ?? e);
		}
		const ms = Date.now() - t0;
		let json;
		try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
		const cap = {
			step,
			request: { method, url, headers: { ...headers, ...(headers.authorization ? { authorization: 'Bearer <redacted>' } : {}) }, body: form ? { ...form } : body },
			response: netError ? { error: netError } : { status, headers: resHeaders, body: json !== undefined ? json : text },
			ms,
		};
		if (record) caps.push(cap);
		if (!quiet) print(`${step.padEnd(40)} ${method.padEnd(6)} ${url} -> ${netError ? `network error: ${netError}` : status} (${ms} ms)`);
		return { status, json, text, cap };
	}

	const ok = (r) => r.status >= 200 && r.status < 300;

	async function listAll(step, url, key) {
		const items = [];
		let pageToken = '';
		for (let page = 0; page < 20; page++) {
			const sep = url.includes('?') ? '&' : '?';
			const r = await http(page ? `${step}-page${page + 1}` : step, { url: `${url}${sep}page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}` });
			if (!ok(r)) return { ok: false, r, items };
			items.push(...(r.json?.[key] ?? []));
			pageToken = r.json?.next_page_token ?? '';
			if (!pageToken) return { ok: true, r, items };
		}
		return { ok: true, items };
	}

	async function section(name, fn) {
		try { await fn(); } catch (e) {
			const msg = R.text(String(e?.message ?? e));
			errors.push({ section: name, error: msg });
			print(`!! ${name}: ${msg}`);
		}
	}

	// pipeline bookkeeping
	const created = new Map(); // label -> { id, gone }
	let dp = null;
	const pipeUrl = (id, suffix = '') => `${dp}${PIPES}/${id}${suffix}`;

	function track(label, r) {
		const p = pipelineOf(r.json);
		if (ok(r) && p && typeof p.id === 'string' && p.id && String(p.display_name ?? '').startsWith(`${NAME_PREFIX}${tag}-`)) {
			R.id(p.id, `<pipeline-id-${label}>`);
			R.probePipelines.add(p.id);
			created.set(label, { id: p.id, gone: false });
			return p;
		}
		return null;
	}

	async function waitFor(label, id, done, timeoutMs) {
		const t0 = Date.now();
		let last = null, lastState = null, polls = 0, timedOut = false;
		for (;;) {
			const r = await http(label, { url: pipeUrl(id), record: false, quiet: true });
			polls++;
			const p = pipelineOf(r.json);
			const state = r.status === 200 ? (p?.state ?? '?') : `HTTP ${r.status}`;
			const err = p?.status?.error ?? '';
			timeline.push([label, Date.now() - t0, state, R.text(err)]);
			if (state !== lastState) { print(`${label.padEnd(40)} state ${state}${err ? ` (${err})` : ''} after ${Date.now() - t0} ms`); lastState = state; }
			last = r;
			if (done(r, p)) break;
			if (Date.now() - t0 > timeoutMs || (pollMs === 0 && polls > 50)) { timedOut = true; print(`${label.padEnd(40)} timed out in state ${state}`); break; }
			await sleep(pollMs);
		}
		last.cap.step = `${label}-final`;
		last.cap.derived = { polls, ms_waited: Date.now() - t0, timed_out: timedOut, final_state: lastState };
		caps.push(last.cap);
		return { r: last, p: pipelineOf(last.json), timedOut };
	}

	const isState = (...states) => (r, p) => r.status === 200 && states.includes(p?.state);
	const isGone = (r) => r.status === 404;

	async function deletePipeline(label, stepPrefix) {
		const c = created.get(label);
		if (!c || c.gone) return;
		const r = await http(`${stepPrefix}-delete-${label}`, { method: 'DELETE', url: pipeUrl(c.id) });
		if (!ok(r) && r.status !== 404) throw new Error(`delete ${label} returned ${r.status}`);
		const w = await waitFor(`${stepPrefix}-gone-${label}`, c.id, isGone, GONE_TIMEOUT_MS);
		if (w.r.status === 404) c.gone = true;
	}

	const generateConfig = ({ interval = '5s', secret, intervalSecret } = {}) => [
		'input:',
		'  generate:',
		intervalSecret ? `    interval: "\${secrets.${intervalSecret}}"` : `    interval: ${interval}`,
		'    mapping: |',
		// Quoted: the create-time lint substitutes an empty value for ${secrets.X} (run 1), so an
		// unquoted reference leaves `root.n = ` and fails to parse.
		secret ? `      root.n = "\${secrets.${secret}}"` : '      root.n = 1',
		'      root.at = now()',
		'output:',
		'  drop: {}',
		'',
	].join('\n');

	const secretId = `${SECRET_PREFIX}${TAG}_N`;
	const missingSecretId = `${SECRET_PREFIX}${TAG}_MISSING`;
	const quotedSecretId = `${SECRET_PREFIX}${TAG}_Q`;
	let secretCreated = false, secretGone = false;

	try {
		// ---- token
		await section('token', async () => {
			const form = { grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.clientSecret, audience: AUDIENCE };
			const r = await http('token', { method: 'POST', url: AUTH_URL, auth: 'none', form });
			if (!ok(r) || !r.json?.access_token) throw new Error(`token request returned ${r.status}`);
			token = r.json.access_token;
			R.secret(token);
			const claims = decodeJwtPayload(token) ?? {};
			const keep = new Set(['aud', 'scope', 'gty', 'iss', 'permissions']);
			const derived = { claim_keys: Object.keys(claims), claims: {}, lifetime_s: (claims.exp && claims.iat) ? claims.exp - claims.iat : null };
			for (const [k, v] of Object.entries(claims)) {
				const org = /org/i.test(k) && typeof v === 'string';
				if (org) R.id(v, '<org-id>');
				derived.claims[k] = keep.has(k) || org ? v : '<redacted>';
			}
			r.cap.derived = derived;
		});
		if (!token) throw new Error('no token; nothing else can run');

		await section('token-bad-secret', async () => {
			await http('token-bad-secret', { method: 'POST', url: AUTH_URL, auth: 'none', form: { grant_type: 'client_credentials', client_id: creds.clientId, client_secret: badToken, audience: AUDIENCE } });
		});

		// ---- clusters
		let target = null;
		let clusters = [];
		await section('clusters', async () => {
			await http('cp-401-bad-token', { url: `${CP}/v1/clusters`, auth: 'bad' });
			const l = await listAll('clusters-list', `${CP}/v1/clusters`, 'clusters');
			clusters = l.items;
			let n = 2;
			for (const c of clusters) {
				const mine = c.name === CLUSTER_NAME;
				R.id(c.id, mine ? '<cluster-id>' : `<cluster-id-${n}>`);
				const host = c.dataplane_api?.url ? new URL(c.dataplane_api.url).host : null;
				if (host) R.id(host, mine ? '<dataplane-host>' : `<dataplane-host-${n}>`);
				if (!mine) n++;
				if (mine) target = c;
			}
			// Other clusters are kept without their names (the captures name only the probed one).
			let other = 2;
			run.clusters = clusters.map((c) => ({ name: c.name === CLUSTER_NAME ? c.name : `<cluster-${other++}>`, type: c.type, cloud_provider: c.cloud_provider, region: c.region, state: c.state, has_dataplane_api: !!c.dataplane_api?.url }));
			for (const c of clusters) if (c.name !== CLUSTER_NAME && c.name) R.secret(c.name);
			await http('serverless-clusters-list', { url: `${CP}/v1/serverless/clusters?page_size=100` });
			await http('cluster-get-404', { url: `${CP}/v1/clusters/probe-no-such-cluster` });
			if (!target) throw new Error(`cluster ${CLUSTER_NAME} not in the list`);
			const g = await http('cluster-get', { url: `${CP}/v1/clusters/${target.id}` });
			if (ok(g)) target = g.json?.cluster ?? target;
			if (ok(g)) {
				// The cluster's full record holds its NAT IPs and per-service host prefixes: only the
				// fields the findings use are captured.
				const t = target;
				g.cap.response.body = { cluster: { name: t.name, type: t.type, state: t.state, cloud_provider: t.cloud_provider, region: t.region, dataplane_api: t.dataplane_api ? { url: t.dataplane_api.url } : undefined, redpanda_connect: t.redpanda_connect ? { version: t.redpanda_connect.version } : undefined, '<other fields>': Object.keys(t).filter((k) => !['name', 'type', 'state', 'cloud_provider', 'region', 'dataplane_api', 'redpanda_connect'].includes(k)).sort() } };
			}
			run.cluster_type = target.type;
			dp = target.dataplane_api?.url?.replace(/\/+$/, '') ?? null;
			// The Data Plane host (and its prefix, shared with the Kafka seed host) names the cluster.
			if (dp) {
				const host = new URL(dp).host;
				R.id(host, '<dataplane-host>');
				const prefix = /^[a-z]+-([a-z0-9]+)\./.exec(host)?.[1];
				if (prefix) R.id(prefix, '<dataplane-prefix>');
			}
			if (!dp) throw new Error(`cluster ${CLUSTER_NAME} has no dataplane_api.url`);
		});

		if (dp) {
			// ---- reads on the probed cluster
			let pipelineApi = false;
			await section('dataplane-reads', async () => {
				await http('dp-401-bad-token', { url: `${dp}${PIPES}`, auth: 'bad' });
				const l = await listAll('pipelines-list', `${dp}${PIPES}`, 'pipelines');
				pipelineApi = l.ok;
				run.pipeline_api = l.ok ? 'available' : `unavailable (HTTP ${l.r?.status})`;
				await listAll('secrets-list', `${dp}/v1/secrets`, 'secrets');
			});

			await section('validation-candidates', async () => {
				for (const p of ['/v1/redpanda-connect/config-schema', '/v1alpha2/redpanda-connect/config-schema', '/v1alpha3/redpanda-connect/config-schema']) {
					const r = await http(`config-schema-${p.split('/')[1]}`, { url: `${dp}${p}` });
					if (ok(r) && r.text.length > 4000) {
						fs.mkdirSync(cacheDir, { recursive: true });
						fs.writeFileSync(path.join(cacheDir, `config-schema-${p.split('/')[1]}.json`), R.text(r.text));
						const versions = [];
						(function walk(v, at) {
							if (versions.length > 20 || !v || typeof v !== 'object') return;
							for (const [k, x] of Object.entries(v)) {
								if (/version/i.test(k) && (typeof x === 'string' || typeof x === 'number')) versions.push(`${at}${k}=${x}`);
								else if (at.split('.').length < 4) walk(x, `${at}${k}.`);
							}
						})(r.json, '');
						r.cap.response.body = { '<summary>': `body of ${r.text.length} bytes kept in .cache/cloud-probe/`, top_level_keys: r.json ? Object.keys(r.json) : null, version_fields: versions, shape: shape(r.json, 4) };
					}
				}
				const invalid = 'input:\n  probe_no_such_input: {}\noutput:\n  drop: {}\n';
				for (const [label, p] of [['lint', '/v1/redpanda-connect/lint'], ['pipelines-lint', `${PIPES}/lint`], ['pipelines-colon-lint', `${PIPES}:lint`], ['config-lint', '/v1/redpanda-connect/config/lint']]) {
					const r = await http(`validate-candidate-${label}`, { method: 'POST', url: `${dp}${p}`, body: { config_yaml: invalid } });
					track(`candidate-${label}`, r);
				}
				const comp = await http('components-candidate', { url: `${dp}/v1/redpanda-connect/components` });
				const all = comp.json?.components;
				if (ok(comp) && all && typeof all === 'object') {
					// About 5 MB of component documentation: kept in .cache/, summarised in the capture.
					fs.mkdirSync(cacheDir, { recursive: true });
					fs.writeFileSync(path.join(cacheDir, 'components.json'), R.text(comp.text));
					const summary = { '<summary>': 'full body kept in .cache/cloud-probe/ (git-ignored)', version: all.version };
					for (const [k, v] of Object.entries(all)) {
						if (Array.isArray(v)) summary[k] = { count: v.length, names: v.map((x) => x?.name), entry_keys: v[0] && typeof v[0] === 'object' ? Object.keys(v[0]).sort() : [] };
					}
					comp.cap.response.body = { components: summary };
				}
			});

			// ---- secret
			await section('secret', async () => {
				const body = { id: secretId, scopes: ['SCOPE_REDPANDA_CONNECT'], secret_data: b64(secretValue) };
				const c = await http('secret-create', { method: 'POST', url: `${dp}/v1/secrets`, body });
				if (!ok(c)) throw new Error(`secret create returned ${c.status}`);
				secretCreated = true;
				await http('secret-create-again', { method: 'POST', url: `${dp}/v1/secrets`, body });
				await http('secret-get', { url: `${dp}/v1/secrets/${secretId}` });
				await http('secret-get-404', { url: `${dp}/v1/secrets/${SECRET_PREFIX}${TAG}_NO_SUCH` });
				await http('secrets-list-filtered', { url: `${dp}/v1/secrets?filter.name_contains=${SECRET_PREFIX}${TAG}` });
				await http('secret-create-quoted', { method: 'POST', url: `${dp}/v1/secrets`, body: { id: quotedSecretId, scopes: ['SCOPE_REDPANDA_CONNECT'], secret_data: b64(quotedValue) } });
			});

			if (pipelineApi) {
				const name = (label) => `${NAME_PREFIX}${tag}-${label}`;

				// ---- rejected creates
				await section('pipeline-create-errors', async () => {
					const cases = [
						['invalid-yaml', { display_name: name('invalid-yaml'), config_yaml: 'input: [unclosed\n  generate: {', resources: RESOURCES }],
						['unknown-component', { display_name: name('unknown-component'), config_yaml: 'input:\n  probe_no_such_input: {}\noutput:\n  drop: {}\n', resources: RESOURCES }],
						['tags-array', { display_name: name('tags-array'), config_yaml: generateConfig(), resources: RESOURCES, tags: ['vscode-spike'] }],
					];
					for (const [label, body] of cases) {
						const r = await http(`pipeline-create-${label}`, { method: 'POST', url: `${dp}${PIPES}`, body });
						if (track(label, r)) await deletePipeline(label, 'pipeline');
					}
					await http('pipeline-get-404', { url: pipeUrl('probe-no-such-pipeline') });
				});

				// ---- minimum body (display_name, config_yaml, resources)
				await section('pipeline-minimum', async () => {
					const r = await http('pipeline-create-minimum', { method: 'POST', url: `${dp}${PIPES}`, body: { display_name: name('minimum'), config_yaml: generateConfig(), resources: RESOURCES } });
					if (track('minimum', r)) {
						await http('pipeline-get-minimum', { url: pipeUrl(created.get('minimum').id) });
						await waitFor('pipeline-wait-minimum', created.get('minimum').id, isState('STATE_RUNNING', 'STATE_ERROR', 'STATE_COMPLETED'), START_TIMEOUT_MS);
						await deletePipeline('minimum', 'pipeline');
					}
					if (TRY_NO_RESOURCES) {
						const n = await http('pipeline-create-no-resources', { method: 'POST', url: `${dp}${PIPES}`, body: { display_name: name('no-resources'), config_yaml: generateConfig() } });
						if (track('no-resources', n)) {
							await http('pipeline-get-no-resources', { url: pipeUrl(created.get('no-resources').id) });
							await deletePipeline('no-resources', 'pipeline');
						}
					}
				});

				// ---- a larger pipeline (0.5 CPU): run 1's 0.1 CPU pipeline went to ERROR with no message
				await section('pipeline-larger', async () => {
					const r = await http('pipeline-create-larger', { method: 'POST', url: `${dp}${PIPES}`, body: { display_name: name('larger'), config_yaml: generateConfig(), resources: { cpu_shares: '500m', memory_shares: '2G' } } });
					if (track('larger', r)) {
						await waitFor('pipeline-wait-larger', created.get('larger').id, isState('STATE_RUNNING', 'STATE_ERROR', 'STATE_COMPLETED'), START_TIMEOUT_MS);
						await http('pipeline-get-larger', { url: pipeUrl(created.get('larger').id) });
						await deletePipeline('larger', 'pipeline');
					}
				});

				// ---- main pipeline
				await section('pipeline-main', async () => {
					const full = {
						display_name: name('main'),
						description: 'vscode spike probe, safe to delete',
						config_yaml: generateConfig({ secret: secretCreated ? secretId : undefined, intervalSecret: secretCreated ? secretId : undefined }),
						resources: RESOURCES,
						tags: { 'vscode-spike': `${NAME_PREFIX}${tag}`, 'rpcn-vscode/config': 'pipelines/demo.yaml' },
					};
					let r = await http('pipeline-create-main', { method: 'POST', url: `${dp}${PIPES}`, body: full });
					if (!track('main', r)) {
						full.tags = { 'vscode-spike': `${NAME_PREFIX}${tag}` };
						r = await http('pipeline-create-main-simple-tags', { method: 'POST', url: `${dp}${PIPES}`, body: full });
						if (!track('main', r)) throw new Error(`main create returned ${r.status}`);
					}
					const id = created.get('main').id;
					let w = await waitFor('pipeline-wait-main-running', id, isState('STATE_RUNNING', 'STATE_ERROR', 'STATE_COMPLETED'), START_TIMEOUT_MS);
					run.main_first_state = w.p?.state;
					// RUNNING with `interval: "${secrets.N}"` means the value reached the pipeline.
					run.secret_delivered = secretCreated ? (w.p?.state === 'STATE_RUNNING' ? 'yes: the pipeline started with its interval from the secret' : `no: ${w.p?.state}`) : 'not tested (no secret)';

					await http('pipeline-main-stop', { method: 'PUT', url: pipeUrl(id, '/stop') });
					w = await waitFor('pipeline-wait-main-stopped', id, isState('STATE_STOPPED', 'STATE_ERROR', 'STATE_COMPLETED'), START_TIMEOUT_MS);

					const update = async (step, url, body) => {
						const before = pipelineOf((await http(`${step}-before`, { url: pipeUrl(id), record: false, quiet: true })).json);
						const u = await http(step, { method: 'PUT', url, body });
						const g = await http(`${step}-get`, { url: pipeUrl(id) });
						g.cap.derived = { fields_vs_before: fieldsDiff(before, pipelineOf(g.json)) };
						return u;
					};
					await update('pipeline-main-update-partial', pipeUrl(id), { description: 'partial update: description only' });
					await update('pipeline-main-update-full', pipeUrl(id), { ...full, description: 'full update', config_yaml: generateConfig({ interval: '10s', secret: secretCreated ? secretId : undefined }) });
					// The whole body again but without description and tags: are they cleared or kept?
					await update('pipeline-main-update-omitting', pipeUrl(id), { display_name: full.display_name, config_yaml: full.config_yaml, resources: RESOURCES });
					await update('pipeline-main-update-masked', `${pipeUrl(id)}?update_mask=description`, { description: 'masked update', display_name: name('main-renamed-by-mask') });
					await update('pipeline-main-update-wrapped', pipeUrl(id), { pipeline: { description: 'wrapped update' } });

					await http('pipeline-main-start', { method: 'PUT', url: pipeUrl(id, '/start') });
					await waitFor('pipeline-wait-main-restarted', id, isState('STATE_RUNNING', 'STATE_ERROR', 'STATE_COMPLETED'), START_TIMEOUT_MS);

					await update('pipeline-main-update-running', pipeUrl(id), { ...full, description: 'update while running', config_yaml: generateConfig({ interval: '7s', secret: secretCreated ? secretId : undefined }) });
					await waitFor('pipeline-watch-main-after-running-update', id, () => false, pollMs === 0 ? 0 : RUNNING_WATCH_MS);

					await http('pipelines-list-with-main', { url: `${dp}${PIPES}?page_size=100&filter.name_contains=${NAME_PREFIX}${tag}` });
					await deletePipeline('main', 'pipeline');
				});

				// ---- a quoted reference to a secret whose value holds a quote and a backslash
				await section('pipeline-quoted-secret', async () => {
					const r = await http('pipeline-create-quoted', { method: 'POST', url: `${dp}${PIPES}`, body: { display_name: name('quoted'), config_yaml: generateConfig({ secret: quotedSecretId }), resources: RESOURCES } });
					if (track('quoted', r)) {
						const w = await waitFor('pipeline-wait-quoted', created.get('quoted').id, isState('STATE_RUNNING', 'STATE_ERROR', 'STATE_COMPLETED'), ERROR_WATCH_MS);
						run.quoted_secret_state = w.p?.state;
						await deletePipeline('quoted', 'pipeline');
					}
				});

				// ---- a pipeline that reads a missing secret
				await section('pipeline-missing-secret', async () => {
					const r = await http('pipeline-create-missing-secret', { method: 'POST', url: `${dp}${PIPES}`, body: { display_name: name('missing-secret'), config_yaml: generateConfig({ secret: missingSecretId }), resources: RESOURCES } });
					if (track('missing-secret', r)) {
						await waitFor('pipeline-wait-missing-secret', created.get('missing-secret').id, isState('STATE_RUNNING', 'STATE_ERROR', 'STATE_COMPLETED'), ERROR_WATCH_MS);
						await deletePipeline('missing-secret', 'pipeline');
					}
				});
			}

			// ---- secret delete (after every pipeline that reads it is gone)
			await section('secret-delete', async () => {
				if (!secretCreated) return;
				if ([...created.values()].some((c) => !c.gone)) return; // left to cleanup
				const d = await http('secret-delete', { method: 'DELETE', url: `${dp}/v1/secrets/${secretId}` });
				const g = await http('secret-get-after-delete', { url: `${dp}/v1/secrets/${secretId}` });
				if (ok(d) || g.status === 404) secretGone = g.status === 404;
				await http('secret-delete-quoted', { method: 'DELETE', url: `${dp}/v1/secrets/${quotedSecretId}` });
			});

			// ---- other clusters, read-only, shapes only
			if (OTHER_CLUSTERS) {
				await section('other-clusters', async () => {
					for (const c of clusters) {
						if (c.name === CLUSTER_NAME || !c.dataplane_api?.url) continue;
						const r = await http(`other-cluster-pipelines-list-${c.type ?? 'unknown'}`, { url: `${c.dataplane_api.url.replace(/\/+$/, '')}${PIPES}?page_size=1` });
						if (ok(r)) r.cap.response.body = { '<shape only>': shape(r.json ?? r.text) }; // errors are kept whole
					}
				});
			}
		}
	} finally {
		// ---- cleanup: everything this run created
		if (token && dp) {
			await section('cleanup', async () => {
				for (const label of [...created.keys()].reverse()) {
					try { await deletePipeline(label, 'cleanup'); } catch (e) { errors.push({ section: `cleanup ${label}`, error: R.text(String(e?.message ?? e)) }); }
				}
				// A create that timed out may still have happened: find this run's names and delete them.
				const named = await listAll('cleanup-find-pipelines', `${dp}${PIPES}`, 'pipelines');
				for (const p of named.items ?? []) {
					const known = [...created.values()].some((c) => c.id === p.id);
					if (known || typeof p.id !== 'string' || !String(p.display_name ?? '').startsWith(`${NAME_PREFIX}${tag}-`)) continue;
					const label = `untracked-${created.size + 1}`;
					R.id(p.id, `<pipeline-id-${label}>`);
					R.probePipelines.add(p.id);
					created.set(label, { id: p.id, gone: false });
					try { await deletePipeline(label, 'cleanup'); } catch (e) { errors.push({ section: `cleanup ${label}`, error: R.text(String(e?.message ?? e)) }); }
				}
				// Every secret this run may have made, whether or not its create was answered.
				for (const sid of [secretId, quotedSecretId]) {
					if (sid === secretId && secretGone) continue;
					const sg = await http(`cleanup-find-secret-${sid === secretId ? 'n' : 'q'}`, { url: `${dp}/v1/secrets/${sid}` });
					if (!ok(sg)) continue;
					await http(`cleanup-secret-delete-${sid === secretId ? 'n' : 'q'}`, { method: 'DELETE', url: `${dp}/v1/secrets/${sid}` });
					const g = await http(`cleanup-secret-get-${sid === secretId ? 'n' : 'q'}`, { url: `${dp}/v1/secrets/${sid}` });
					if (sid === secretId) secretGone = g.status === 404;
				}
				const pl = await listAll('cleanup-check-pipelines', `${dp}${PIPES}`, 'pipelines');
				const sl = await listAll('cleanup-check-secrets', `${dp}/v1/secrets`, 'secrets');
				const thisRun = [], earlier = [];
				for (const p of pl.items ?? []) {
					if (!String(p.display_name ?? '').startsWith(NAME_PREFIX)) continue;
					(String(p.display_name).startsWith(`${NAME_PREFIX}${tag}`) || R.probePipelines.has(p.id) ? thisRun : earlier).push(`pipeline ${p.display_name} (${p.state})`);
				}
				for (const s of sl.items ?? []) {
					const sid = String(s.id ?? s.name ?? '');
					if (!sid.startsWith(SECRET_PREFIX)) continue;
					(sid.startsWith(`${SECRET_PREFIX}${TAG}`) ? thisRun : earlier).push(`secret ${sid}`);
				}
				if (!pl.ok || !sl.ok) thisRun.push(`could not list (pipelines ${pl.r?.status}, secrets ${sl.r?.status})`);
				run.leftovers_this_run = thisRun.map((x) => R.text(x));
				run.leftovers_earlier_runs = earlier.map((x) => R.text(x));
				print(`cleanup: ${thisRun.length ? `LEFT BEHIND: ${thisRun.join(', ')}` : 'nothing left from this run'}`);
				if (earlier.length) print(`cleanup: earlier runs left (not touched): ${earlier.join(', ')}`);
			});
		}
		run.errors = errors;
		writeCaptures(outDir, caps, timeline, run, R);
	}
	return { run, tag, TAG, secretValue, quotedValue, created, R };
}

/**
 * Pipelines and secrets the probe did not create are kept as their shape only (no id, name,
 * description, tags or config): the captures are committed, and the cluster's own pipelines and
 * secret names are not the probe's to publish.
 */
function foreign(body) {
	if (!body || typeof body !== 'object') return body;
	const mine = (x) => String(x?.display_name ?? '').startsWith(NAME_PREFIX) || String(x?.id ?? '').startsWith(SECRET_PREFIX) || String(x?.name ?? '').startsWith(SECRET_PREFIX);
	const out = Array.isArray(body) ? [...body] : { ...body };
	for (const key of ['cloud_provider_tags', 'redpanda_cloud_provider_tags']) {
		if (out[key] && typeof out[key] === 'object') out[key] = { '<redacted>': `${Object.keys(out[key]).length} tags` }; // tag keys can hold account ids
	}
	for (const k of Object.keys(out)) {
		if (out[k] && typeof out[k] === 'object' && !['pipelines', 'secrets', 'clusters', 'serverless_clusters'].includes(k)) out[k] = foreign(out[k]);
	}
	for (const key of ['pipelines', 'secrets', 'clusters', 'serverless_clusters']) {
		if (Array.isArray(out[key])) out[key] = out[key].map((x) => (!key.endsWith('clusters') && mine(x) ? x : { '<not the probe\'s; shape only>': shape(x) }));
	}
	return out;
}

function writeCaptures(outDir, caps, timeline, run, R) {
	fs.rmSync(outDir, { recursive: true, force: true });
	fs.mkdirSync(outDir, { recursive: true });
	const rows = [['n', 'step', 'method', 'url', 'status', 'ms'].join('\t')];
	caps.forEach((c, i) => {
		const n = String(i + 1).padStart(2, '0');
		const red = R.value({ ...c, response: c.response.body !== undefined ? { ...c.response, body: foreign(c.response.body) } : c.response });
		fs.writeFileSync(path.join(outDir, `${n}-${c.step}.json`), `${JSON.stringify(red, null, 2)}\n`);
		rows.push([n, red.step, red.request.method, red.request.url, red.response.status ?? 'error', c.ms].join('\t'));
	});
	fs.writeFileSync(path.join(outDir, 'summary.tsv'), `${rows.join('\n')}\n`);
	fs.writeFileSync(path.join(outDir, 'timeline.tsv'), `${['label\tms\tstate\terror', ...timeline.map((t) => t.join('\t'))].join('\n')}\n`);
	fs.writeFileSync(path.join(outDir, 'run.json'), `${JSON.stringify(R.value(run), null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------
// Dry run: an in-memory fake of the three hosts, then checks on what was written

function makeFake({ loseCreate } = {}) {
	const F = {
		clientId: 'fakeClientIdAAAA1111',
		clientSecret: 'fakeClientSecretBBBB2222',
		org: 'org0fake0c0ffee0',
		cl: 'clfake0vilnius00',
		cl2: 'clfake0other000',
		license: 'LICENSE-fake-9f8e7d6c',
		foreignPw: 'hunter2-foreign-pw',
		networkId: 'netfake0abc123',
		natIp: '203.0.113.77',
		registryPrefix: '77aa88bb',
		awsPartnerId: '555566667777',
		teamTagKey: 'team-secret-tagkey',
	};
	F.dp = `api-a1b2c3.${F.cl}.byoc.prd.cloud.redpanda.com`;
	F.dp2 = `api-d4e5f6.${F.cl2}.fmc.prd.cloud.redpanda.com`;
	const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
	const now = Math.floor(Date.now() / 1000);
	F.jwt = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ 'https://cloud.redpanda.com/organization_id': F.org, aud: [AUDIENCE], iat: now, exp: now + 86400, sub: `${F.clientId}@clients`, azp: F.clientId, gty: 'client-credentials', scope: '' })}.ZmFrZXNpZw`;

	const pipelines = new Map();
	pipelines.set('pfakeforeign01', { id: 'pfakeforeign01', display_name: 'orders-etl', config_yaml: `input:\n  kafka:\n    sasl:\n      password: ${F.foreignPw}\n`, state: 'STATE_RUNNING', resources: { cpu_shares: '1', memory_shares: '4G' }, tags: { [F.teamTagKey]: 'x' } });
	pipelines.set('pfakeoldleft01', { id: 'pfakeoldleft01', display_name: 'vscode-spike-old00000-main', config_yaml: 'input: {}', state: 'STATE_STOPPED', resources: RESOURCES, tags: {} });
	const secrets = new Map([['FOREIGN_DB_PASSWORD', { id: 'FOREIGN_DB_PASSWORD', scopes: ['SCOPE_REDPANDA_CONNECT'], value: F.foreignPw }], ['VSCODE_SPIKE_OLD00000_N', { id: 'VSCODE_SPIKE_OLD00000_N', scopes: ['SCOPE_REDPANDA_CONNECT'] }]]);
	const pending = new Map();
	let nextId = 1;

	const res = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
	const err = (status, code, message) => res(status, { code, message, details: [] });
	const cluster = (id, name, type, host) => ({ id, name, type, cloud_provider: 'CLOUD_PROVIDER_AWS', region: 'eu-central-1', state: 'STATE_READY', network_id: F.networkId, redpanda_license_key: F.license, dataplane_api: { url: `https://${host}` }, nat_gateways: [{ ip: F.natIp }], schema_registry: { url: `https://schema-registry-${F.registryPrefix}.${id}.byoc.prd.cloud.redpanda.com` }, cloud_provider_tags: { [`aws-apn-id-${F.awsPartnerId}`]: 'pc:xyz123' } });
	const clusters = [cluster(F.cl, 'rpc-vilnius', 'TYPE_BYOC', F.dp), cluster(F.cl2, 'other-dedicated', 'TYPE_DEDICATED', F.dp2)];
	const view = (p) => { const { value, ...rest } = p; return rest; };

	async function fetchImpl(url, init) {
		const u = new URL(url);
		const method = init.method ?? 'GET';
		const body = init.body && init.headers['content-type'] === 'application/json' ? JSON.parse(init.body) : undefined;
		const authed = init.headers.authorization === `Bearer ${F.jwt}`;
		if (u.host === 'auth.prd.cloud.redpanda.com') {
			const f = new URLSearchParams(init.body);
			const quota = { 'auth0-organization-quota-limit': 'b=per_day;q=100;r=99;t=3600' };
			if (f.get('client_id') !== F.clientId || f.get('client_secret') !== F.clientSecret) return res(401, { error: 'access_denied', error_description: 'Unauthorized' }, quota);
			return res(200, { access_token: F.jwt, expires_in: 86400, token_type: 'Bearer', scope: '' }, quota);
		}
		if (!authed) return err(401, 16, 'unauthenticated');
		if (u.host === 'api.redpanda.com') {
			if (u.pathname === '/v1/clusters') return res(200, { clusters, next_page_token: '' });
			if (u.pathname === '/v1/serverless/clusters') return res(200, { serverless_clusters: [], next_page_token: '' });
			const m = /^\/v1\/clusters\/([^/]+)$/.exec(u.pathname);
			const c = m && clusters.find((x) => x.id === m[1]);
			return c ? res(200, { cluster: c }) : err(404, 5, 'cluster not found');
		}
		if (u.host === F.dp2) return err(404, 5, 'Not Found');
		if (u.host !== F.dp) throw new Error(`fake: unknown host ${u.host}`);
		const p = u.pathname;
		// A guessed lint path that answers with someone else's pipeline: the probe must not adopt it.
		if (p === '/v1/redpanda-connect/lint') return res(200, { id: 'pfakeforeign01' });
		if (p === '/v1/redpanda-connect/config-schema') return res(200, { version: '4.67.0', properties: { input: { type: 'object' } }, filler: 'x'.repeat(5000) });
		if (p === PIPES && method === 'GET') return res(200, { pipelines: [...pipelines.values()].filter((x) => !u.searchParams.get('filter.name_contains') || x.display_name.includes(u.searchParams.get('filter.name_contains'))), next_page_token: '' });
		if (p === PIPES && method === 'POST') {
			if (!body.display_name) return err(400, 3, 'display_name: value is required');
			if (Array.isArray(body.tags)) return err(400, 3, 'invalid tags');
			if (/unclosed|probe_no_such_input/.test(body.config_yaml)) return err(400, 3, 'config is invalid');
			const id = `pfakenew${String(nextId++).padStart(4, '0')}`;
			const pl = { id, ...body, state: 'STATE_STARTING', status: {}, url: '' };
			pipelines.set(id, pl);
			pending.set(id, body.config_yaml.includes('_MISSING}') ? ['STATE_ERROR'] : ['STATE_RUNNING']);
			// A create whose reply is lost: the pipeline exists, the probe never learns its id.
			if (loseCreate && body.display_name.endsWith(loseCreate)) return err(504, 4, 'deadline exceeded');
			return res(201, { pipeline: pl });
		}
		const pm = /^\/v1\/redpanda-connect\/pipelines\/([^/:]+)(\/start|\/stop)?$/.exec(p);
		if (pm) {
			const pl = pipelines.get(pm[1]);
			if (!pl) return err(404, 5, 'pipeline not found');
			if (method === 'GET') {
				const q = pending.get(pl.id) ?? [];
				if (q.length) {
					const s = q.shift();
					if (s === 'GONE') { pipelines.delete(pl.id); return err(404, 5, 'pipeline not found'); }
					pl.state = s;
					if (s === 'STATE_ERROR') pl.status = { error: 'secret not found' };
				}
				return res(200, { pipeline: pl });
			}
			if (method === 'DELETE') { pl.state = 'STATE_STOPPING'; pending.set(pl.id, ['GONE']); return res(200, {}); }
			if (method === 'PUT' && pm[2] === '/stop') { pl.state = 'STATE_STOPPING'; pending.set(pl.id, ['STATE_STOPPED']); return res(200, { pipeline: pl }); }
			if (method === 'PUT' && pm[2] === '/start') { pl.state = 'STATE_STARTING'; pending.set(pl.id, ['STATE_RUNNING']); return res(200, { pipeline: pl }); }
			if (method === 'PUT') { Object.assign(pl, body.pipeline ?? body); return res(200, { pipeline: pl }); }
		}
		if (p === '/v1/secrets' && method === 'GET') return res(200, { secrets: [...secrets.values()].map(view).filter((s) => !u.searchParams.get('filter.name_contains') || s.id.includes(u.searchParams.get('filter.name_contains'))), next_page_token: '' });
		if (p === '/v1/secrets' && method === 'POST') {
			if (secrets.has(body.id)) return err(409, 6, 'secret already exists');
			secrets.set(body.id, { id: body.id, scopes: body.scopes, value: Buffer.from(body.secret_data, 'base64').toString() });
			return res(201, { secret: { id: body.id, scopes: body.scopes } });
		}
		const sm = /^\/v1\/secrets\/([^/]+)$/.exec(p);
		if (sm) {
			if (!secrets.has(sm[1])) return err(404, 5, 'secret not found');
			if (method === 'DELETE') { secrets.delete(sm[1]); return res(200, {}); }
			return res(200, { secret: view(secrets.get(sm[1])) });
		}
		return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
	}
	return { F, fetchImpl, pipelines, secrets };
}

function scanDir(dir) {
	return fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
}

async function dryRun() {
	const failures = [];
	const check = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); };

	console.log('== credentials file checks');
	const credDir = path.join(CACHE, 'dry-run', 'creds');
	fs.rmSync(credDir, { recursive: true, force: true });
	fs.mkdirSync(credDir, { recursive: true });
	const cf = path.join(credDir, 'credentials.env');
	fs.writeFileSync(cf, 'client_id=abc123\nclient_secret="s3cr3t-value"\n');
	fs.chmodSync(cf, 0o644);
	let refused = false;
	try { readCredentials(cf); } catch (e) { refused = /mode 644/.test(e.message) && !e.message.includes('s3cr3t'); }
	check(refused, 'a 0644 credentials file is refused, and the message holds no value');
	fs.chmodSync(cf, 0o600);
	const c = readCredentials(cf);
	check(c.clientId === 'abc123' && c.clientSecret === 's3cr3t-value', 'a 0600 credentials file is read (quotes stripped)');
	fs.symlinkSync(cf, path.join(credDir, 'link.env'));
	refused = false;
	try { readCredentials(path.join(credDir, 'link.env')); } catch { refused = true; }
	check(refused, 'a symlinked credentials file is refused');
	fs.writeFileSync(path.join(credDir, 'partial.env'), 'client_id=abc\n', { mode: 0o600 });
	refused = false;
	try { readCredentials(path.join(credDir, 'partial.env')); } catch { refused = true; }
	check(refused, 'a credentials file without client_secret is refused');

	console.log('== redaction on sample responses');
	{
		const R = new Redactor();
		R.secret('tok-ABCDEF123456');
		R.id('cl-xyz', '<cluster-id>');
		const sample = { access_token: 'tok-ABCDEF123456', note: 'Bearer tok-ABCDEF123456 in text', jwt: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln', resource_group_id: 'rg-123', cluster_id: 'cl-xyz', mail: 'someone@example.com', redpanda_license: 'LIC', pipelines: [{ id: 'other', config_yaml: 'password: p' }], secret: { secret_data: 'c2VjcmV0' } };
		const out = JSON.stringify(R.value(sample));
		check(!/tok-ABCDEF|eyJhbGci|rg-123|cl-xyz|someone@|"LIC"|password: p|c2VjcmV0/.test(out), `sample is clean: ${out}`);
	}

	for (const [label, failAt, loseCreate] of [['normal', null], ['failure-mid-flow', 'pipeline-main-stop'], ['failure-after-secret', 'pipeline-create-invalid-yaml'], ['lost-create', null, '-minimum']]) {
		console.log(`== dry run: ${label}${failAt ? ` (fails at ${failAt})` : ''}${loseCreate ? ` (the ${loseCreate} create's reply is lost)` : ''}`);
		const fake = makeFake({ loseCreate });
		const outDir = path.join(CACHE, 'dry-run', label);
		const res = await probe({ fetchImpl: fake.fetchImpl, creds: { clientId: fake.F.clientId, clientSecret: fake.F.clientSecret }, outDir, pollMs: 0, failAt, cacheDir: path.join(CACHE, 'dry-run', `${label}-cache`) });
		const files = scanDir(outDir);
		const all = files.map(([, t]) => t).join('\n');
		const sensitive = { ...fake.F, secretValue: res.secretValue, secretB64: b64(res.secretValue), quotedValue: res.quotedValue, quotedB64: b64(res.quotedValue), jwtPayload: fake.F.jwt.split('.')[1], tag: res.tag, TAG: res.TAG };
		delete sensitive.dp; delete sensitive.dp2; // hosts checked by their cluster-id part and below
		for (const [k, v] of Object.entries(sensitive)) check(!all.includes(v), `${label}: no ${k} in the captures`);
		check(!all.includes('a1b2c3'), `${label}: no dataplane host in the captures`);
		check(!/pfakenew\d+/.test(all), `${label}: no probe pipeline id in the captures`);
		const grepHits = all.split('\n').filter((l) => /client_secret|access_token|Bearer [A-Za-z0-9]/i.test(l));
		check(grepHits.every((l) => l.includes('<redacted')), `${label}: the plan's grep finds only redaction markers (${grepHits.length} lines)`);
		const leftP = [...fake.pipelines.values()].filter((p) => p.display_name.startsWith(`${NAME_PREFIX}${res.tag}`));
		const leftS = [...fake.secrets.keys()].filter((s) => s.startsWith(`${SECRET_PREFIX}${res.TAG}`));
		check(leftP.length === 0 && leftS.length === 0, `${label}: the fake cluster holds nothing this run created`);
		check(fake.pipelines.has('pfakeforeign01') && fake.pipelines.has('pfakeoldleft01') && fake.secrets.has('VSCODE_SPIKE_OLD00000_N') && fake.secrets.has('FOREIGN_DB_PASSWORD'), `${label}: nothing else was touched`);
		check((res.run.leftovers_this_run ?? ['missing']).length === 0, `${label}: cleanup reports nothing left from this run`);
		check((res.run.leftovers_earlier_runs ?? []).length === 2, `${label}: earlier-run leftovers are reported, not deleted`);
		if (loseCreate) check(res.run.errors.length === 0 || res.run.errors.every((e) => !/cleanup/.test(e.section)), `${label}: the untracked pipeline was found by its name and deleted`);
		else if (failAt) check(res.run.errors.some((e) => e.error.includes('injected failure')), `${label}: the injected failure is recorded`);
		else check(res.run.errors.length === 0, `${label}: no section failed (${JSON.stringify(res.run.errors)})`);
	}
	console.log(failures.length ? `\ndry run: ${failures.length} check(s) FAILED` : '\ndry run: all checks passed');
	process.exit(failures.length ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------

async function main() {
	const args = process.argv.slice(2);
	if (args.includes('--dry-run')) return dryRun();
	if (args.length) { console.error(`cloud-probe: unknown argument(s): ${args.join(' ')}`); process.exit(2); }
	let creds;
	try { creds = readCredentials(CRED_FILE); } catch (e) { console.error(`cloud-probe: ${e.message}`); process.exit(1); }
	const fetchImpl = (url, init) => fetch(url, init);
	fetchImpl.isReal = true;
	const res = await probe({ fetchImpl, creds, outDir: CAPS, pollMs: POLL_MS, failAt: null, cacheDir: CACHE });
	console.log(`captures: ${path.relative(ROOT, CAPS)}`);
	const left = res.run.leftovers_this_run;
	if (!left || left.length || res.run.errors.length) process.exit(1);
}

main().catch((e) => { console.error(`cloud-probe: ${String(e?.message ?? e).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<redacted-jwt>')}`); process.exit(1); });
