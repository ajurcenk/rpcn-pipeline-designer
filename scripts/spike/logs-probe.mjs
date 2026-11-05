#!/usr/bin/env node
// Spike 6.1: probe reading a Redpanda Cloud cluster's `__redpanda.connect.logs` topic through its
// Kafka API, with each candidate Kafka client, and record what was asked and answered, redacted,
// as captures. Started by scripts/spike/logs-probe.sh.
//
// Inputs:
//   ~/.config/rpcn-spike/credentials.env   client_id=..., client_secret=... (the service account of
//                                          spike 5.1: the cluster's details and the test pipeline)
//   ~/.config/rpcn-spike/logs.env          the Redpanda user that may read the logs topic:
//                                          redpanda_user= (or username=), repanda_user_pwd= (or
//                                          password=), auth_mechanism= (or mechanism=) SCRAM-SHA-256
//                                          or SCRAM-SHA-512
//                                          Each file must be a regular file owned by you, mode 0600.
//   LOGS_PROBE_CLUSTER=<name>              the cluster (default rpc-vilnius)
//   LOGS_PROBE_CLIENTS=kafkajs,platformatic   the candidate clients run (default both)
//   LOGS_PROBE_RUN_MS=<ms>                 how long the test pipeline runs before the history reads
//                                          (default 150000)
//   LOGS_PROBE_LIVE_MS=<ms>                how long a live read waits for the pipeline's records
//                                          (default 60000)
//   --dry-run                              no network and no credentials: a fake Cloud, a fake Kafka
//                                          broker for the TLS-less protocol checks and fake clients;
//                                          the redaction, the refusals and the cleanup are checked
//
// What it does (one Cloud token per run):
//   Cloud: token, the cluster (`kafka_api` and its fields by name), a test pipeline
//   `vscode-spike-logs-<run>` (generate every second -> log INFO and WARN -> drop, 0.1 CPU) created,
//   waited for, and deleted in `finally`.
//   Kafka, without credentials: TLS to the first seed broker (the certificate chain, whether the
//   system CAs trust it), ApiVersions and a SaslHandshake that names no real mechanism (the
//   cluster answers with the mechanisms it offers), and the same port without TLS.
//   Clients: kafkajs and @platformatic/kafka installed into .cache/logs-probe/ (git-ignored),
//   bundled with the repository's esbuild as the extension is (CommonJS, Node), and loaded from that
//   bundle. With each: a wrong password, the other SCRAM mechanism (kafkajs), metadata of the topic
//   and of all topics (a count), DescribeConfigs of the topic, ListOffsets (earliest, latest, by
//   time), a live read from the end until the pipeline's records come, then (after the pipeline ran
//   a while) reads from now - 15 minutes on every partition (the records' shape and placement), and
//   seeks by time (now - 15 minutes, now - 7 days, before the oldest record) read forward.
//   Kafka is read only: no consumer group is joined, no offset committed, nothing produced, no
//   topic or ACL changed; metadata requests never auto-create topics.
//
// Outputs (re-generated on every run):
//   <findings>/captures/NN-<step>.json   one per step: {step, request?, response | result | error, ms}
//   <findings>/captures/summary.tsv      one row per capture
//   <findings>/captures/run.json         the answers in short, leftovers, errors
//   .cache/logs-probe/                   the clients, their bundles (git-ignored)
//   --dry-run writes to .cache/logs-probe/dry-run/<case>/ instead.
//
// Redaction (every capture and every printed line): the service account, the token, the Redpanda
// user's name and password are `<redacted>`; the organization and cluster ids, the Data Plane host,
// the broker hosts and any other cluster host, IP addresses and the run tag become placeholders
// (<org-id>, <cluster-id>, <dataplane-host>, <broker-host-N>, <cluster-host>, <ip>, <run>); other
// `*_id` values <redacted-id>. Records of pipelines the probe did not create appear only as
// aggregates (field names, types, counts, sizes); records of the probe's own pipeline are kept,
// with the pipeline and instance ids as placeholders and fields the probe does not know reduced to
// their type and length.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FINDINGS = path.join(ROOT, '_bmad-output/initiative-rpcn-vscode-designer/epic-pipeline-logs/spike-6-1-findings');
const CAPS = path.join(FINDINGS, 'captures');
const CACHE = path.join(ROOT, '.cache/logs-probe');
const CRED_FILE = path.join(os.homedir(), '.config/rpcn-spike/credentials.env');
const LOGS_FILE = path.join(os.homedir(), '.config/rpcn-spike/logs.env');

const AUTH_URL = 'https://auth.prd.cloud.redpanda.com/oauth/token';
const AUDIENCE = 'cloudv2-production.redpanda.cloud';
const CP = 'https://api.redpanda.com';
const PIPES = '/v1/redpanda-connect/pipelines';
const TOPIC = '__redpanda.connect.logs';

const CLUSTER_NAME = process.env.LOGS_PROBE_CLUSTER || 'rpc-vilnius';
const CLIENTS = (process.env.LOGS_PROBE_CLIENTS || 'kafkajs,platformatic').split(',').map((s) => s.trim()).filter(Boolean);
const RUN_MS = Number(process.env.LOGS_PROBE_RUN_MS || 150_000);
const LIVE_MS = Number(process.env.LOGS_PROBE_LIVE_MS || 60_000);

const FETCH_MS = 30_000;          // any one HTTP request
const KAFKA_MS = 30_000;          // any one Kafka operation
const POLL_MS = 5_000;            // pipeline state poll
const START_TIMEOUT_MS = 300_000;
const GONE_TIMEOUT_MS = 180_000;
const SAMPLE_MAX_RECORDS = 3000;  // per partition, from now - 15 minutes
const SAMPLE_MAX_FETCHES = 4;
const FETCH_MAX_BYTES = 1_048_576;

const RESOURCES = { cpu_shares: '100m', memory_shares: '400M' }; // 0.1 CPU
const NAME_PREFIX = 'vscode-spike-logs-';
const CLIENT_VERSIONS = { kafkajs: '2.2.4', '@platformatic/kafka': '2.15.0' };

const SECRET_KEY = /^(authorization|client_secret|client_id|access_token|id_token|refresh_token|secret_data|password|token|api_key|private_key|azp|username|user|principal)$/i;
const OTHER_ID_KEY = /_ids?$/i;
// Hosts that name nothing of the user's (the public Cloud endpoints, documentation).
const PUBLIC_HOSTS = new Set(['auth.prd.cloud.redpanda.com', 'api.redpanda.com', 'cloud.redpanda.com', 'docs.redpanda.com', 'www.redpanda.com', 'registry.npmjs.org']);

// Fields of a Redpanda Connect log record the probe knows; in the probe's own records only these
// keep their value (other strings become their length).
const KNOWN_FIELDS = new Set(['benthos_version', 'level', 'message', 'msg', 'path', 'label', 'time', 'ts', 'probe_n', 'pipeline_id', 'instance_id', '@service', 'stream']);
const LEVELS = new Set(['TRACE', 'DEBUG', 'INFO', 'WARN', 'WARNING', 'ERROR', 'FATAL', 'trace', 'debug', 'info', 'warn', 'warning', 'error', 'fatal']);

const KAFKA_ERRORS = { 0: 'NONE', 1: 'OFFSET_OUT_OF_RANGE', 3: 'UNKNOWN_TOPIC_OR_PARTITION', 6: 'NOT_LEADER_OR_FOLLOWER', 7: 'REQUEST_TIMED_OUT', 29: 'TOPIC_AUTHORIZATION_FAILED', 30: 'GROUP_AUTHORIZATION_FAILED', 31: 'CLUSTER_AUTHORIZATION_FAILED', 33: 'UNSUPPORTED_SASL_MECHANISM', 34: 'ILLEGAL_SASL_STATE', 35: 'UNSUPPORTED_VERSION', 58: 'SASL_AUTHENTICATION_FAILED' };
const API_KEYS = { 0: 'Produce', 1: 'Fetch', 2: 'ListOffsets', 3: 'Metadata', 8: 'OffsetCommit', 9: 'OffsetFetch', 10: 'FindCoordinator', 11: 'JoinGroup', 12: 'Heartbeat', 13: 'LeaveGroup', 14: 'SyncGroup', 15: 'DescribeGroups', 16: 'ListGroups', 17: 'SaslHandshake', 18: 'ApiVersions', 19: 'CreateTopics', 20: 'DeleteTopics', 29: 'DescribeAcls', 32: 'DescribeConfigs', 36: 'SaslAuthenticate', 60: 'DescribeCluster', 61: 'DescribeProducers' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: no answer in ${ms} ms`)), ms).unref?.())]);

// ---------------------------------------------------------------------------------------------
// Credentials

/** Reads KEY=value lines from a file you own with mode 0600; refuses anything else. */
function readEnvFile(file, what) {
	let st;
	try { st = fs.lstatSync(file); } catch { throw new Error(`${what} file not found: ${file}`); }
	if (!st.isFile()) throw new Error(`${what} file is not a regular file (symlinks are refused): ${file}`);
	if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${what} file is not owned by you: ${file}`);
	const mode = st.mode & 0o777;
	if (mode !== 0o600) throw new Error(`${what} file has mode ${mode.toString(8)}, must be 600: ${file}`);
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

/** The user's own key names first (decision 2026-11-05), then the plan's. */
function readLogsUser(file) {
	const v = readEnvFile(file, 'logs user');
	const username = v.redpanda_user || v.username;
	const password = v.repanda_user_pwd || v.password;
	const mechanism = String(v.auth_mechanism || v.mechanism || '').toUpperCase();
	if (!username || !password) throw new Error(`logs user file needs redpanda_user= (or username=) and repanda_user_pwd= (or password=) lines: ${file}`);
	if (!['SCRAM-SHA-256', 'SCRAM-SHA-512'].includes(mechanism)) throw new Error(`logs user file needs auth_mechanism= (or mechanism=) SCRAM-SHA-256 or SCRAM-SHA-512: ${file}`);
	return { username, password, mechanism };
}

// ---------------------------------------------------------------------------------------------
// Redaction

class Redactor {
	constructor() {
		this.scrub = new Set(); // exact strings -> <redacted>
		this.ids = new Map();   // value -> placeholder
		this.hosts = 0;
	}
	secret(v) { if (v != null && String(v).length >= 3) this.scrub.add(String(v)); }
	id(v, ph) { if (typeof v === 'string' && v.length >= 3 && !this.ids.has(v)) this.ids.set(v, ph); }
	/** A broker host: `<broker-host-N>`, numbered in the order seen. */
	host(h) {
		if (typeof h !== 'string' || h.length < 3 || this.ids.has(h) || PUBLIC_HOSTS.has(h)) return this.ids.get(h);
		if (net.isIP(h)) { this.ids.set(h, '<ip>'); return '<ip>'; }
		const ph = `<broker-host-${++this.hosts}>`;
		this.ids.set(h, ph);
		return ph;
	}
	text(s) {
		let out = String(s);
		for (const v of [...this.scrub].sort((a, b) => b.length - a.length)) out = out.split(v).join('<redacted>');
		out = out.replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '<redacted-jwt>');
		out = out.replace(/Bearer\s+(?!<redacted)[^\s"',]+/g, 'Bearer <redacted>');
		for (const [v, ph] of [...this.ids].sort((a, b) => b[0].length - a[0].length)) out = out.split(v).join(ph);
		// Any host left that is not a public endpoint: a cluster's (by its placeholders or domain).
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
				else if (OTHER_ID_KEY.test(k) && typeof x === 'string' && x) {
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

/** An error as data: name, code, message and nested errors; never a stack. */
function errInfo(e, depth = 0) {
	if (e == null) return null;
	if (typeof e !== 'object') return { message: String(e) };
	const o = { name: e.name ?? e.constructor?.name, message: String(e.message ?? e) };
	for (const k of ['code', 'type', 'apiCode', 'apiId', 'errorCode', 'retriable', 'reason', 'broker']) {
		if (e[k] != null && typeof e[k] !== 'object' && typeof e[k] !== 'function') o[k] = typeof e[k] === 'bigint' ? e[k].toString() : e[k];
	}
	if (typeof o.code === 'number' && KAFKA_ERRORS[o.code]) o.kafka_error = KAFKA_ERRORS[o.code];
	if (typeof o.apiCode === 'number' && KAFKA_ERRORS[o.apiCode]) o.kafka_error = KAFKA_ERRORS[o.apiCode];
	if (Array.isArray(e.errors) && depth < 4) o.errors = e.errors.slice(0, 6).map((x) => errInfo(x, depth + 1));
	if (e.cause && depth < 4) o.cause = errInfo(e.cause, depth + 1);
	return o;
}

// ---------------------------------------------------------------------------------------------
// Kafka without a client: the TLS handshake and two requests a broker answers before SASL

/** Kafka's default partitioner (murmur2 of the key, positive, modulo the partition count). */
function murmur2(buf) {
	const data = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
	const m = 0x5bd1e995;
	const len = data.length;
	let h = (0x9747b28c ^ len) | 0;
	const len4 = len >> 2;
	for (let i = 0; i < len4; i++) {
		const i4 = i * 4;
		let k = (data[i4] & 0xff) | ((data[i4 + 1] & 0xff) << 8) | ((data[i4 + 2] & 0xff) << 16) | ((data[i4 + 3] & 0xff) << 24);
		k = Math.imul(k, m);
		k ^= k >>> 24;
		k = Math.imul(k, m);
		h = Math.imul(h, m);
		h ^= k;
	}
	const t = len & ~3;
	switch (len % 4) {
		case 3: h ^= (data[t + 2] & 0xff) << 16; // falls through
		case 2: h ^= (data[t + 1] & 0xff) << 8;  // falls through
		case 1: h ^= data[t] & 0xff; h = Math.imul(h, m);
	}
	h ^= h >>> 13;
	h = Math.imul(h, m);
	h ^= h >>> 15;
	return h | 0;
}
const defaultPartition = (key, n) => (murmur2(key) & 0x7fffffff) % n;

/** A minimal Kafka request/response channel over a connected socket (request header v1). */
function rawChannel(socket) {
	let buf = Buffer.alloc(0);
	const waiting = new Map();
	let corr = 0;
	socket.on('data', (d) => {
		buf = Buffer.concat([buf, d]);
		while (buf.length >= 4 && buf.length >= 4 + buf.readInt32BE(0)) {
			const size = buf.readInt32BE(0);
			const frame = buf.subarray(4, 4 + size);
			buf = buf.subarray(4 + size);
			const id = frame.readInt32BE(0);
			waiting.get(id)?.resolve(frame.subarray(4));
			waiting.delete(id);
		}
	});
	const fail = (e) => { for (const w of waiting.values()) w.reject(e); waiting.clear(); };
	socket.on('error', fail);
	socket.on('close', () => fail(new Error('connection closed')));
	return (apiKey, version, body = Buffer.alloc(0)) => new Promise((resolve, reject) => {
		const id = ++corr;
		const client = Buffer.from('rpcn-logs-probe');
		const header = Buffer.alloc(10);
		header.writeInt16BE(apiKey, 0);
		header.writeInt16BE(version, 2);
		header.writeInt32BE(id, 4);
		header.writeInt16BE(client.length, 8);
		const payload = Buffer.concat([header, client, body]);
		const size = Buffer.alloc(4);
		size.writeInt32BE(payload.length, 0);
		waiting.set(id, { resolve, reject });
		socket.write(Buffer.concat([size, payload]));
	});
}

function parseApiVersions(b) {
	const error = b.readInt16BE(0);
	const n = b.readInt32BE(2);
	const apis = [];
	for (let i = 0, o = 6; i < n && o + 6 <= b.length; i++, o += 6) {
		const key = b.readInt16BE(o);
		apis.push({ key, name: API_KEYS[key] ?? null, min: b.readInt16BE(o + 2), max: b.readInt16BE(o + 4) });
	}
	return { error_code: error, error: KAFKA_ERRORS[error] ?? null, apis };
}

function parseSaslHandshake(b) {
	const error = b.readInt16BE(0);
	const n = b.readInt32BE(2);
	const mechanisms = [];
	for (let i = 0, o = 6; i < n; i++) {
		const len = b.readInt16BE(o);
		mechanisms.push(b.subarray(o + 2, o + 2 + len).toString('utf8'));
		o += 2 + len;
	}
	return { error_code: error, error: KAFKA_ERRORS[error] ?? null, enabled_mechanisms: mechanisms };
}

const stringBody = (s) => { const b = Buffer.from(s); const h = Buffer.alloc(2); h.writeInt16BE(b.length, 0); return Buffer.concat([h, b]); };

function certChain(socket) {
	const out = [];
	let c = socket.getPeerCertificate(true);
	const seen = new Set();
	while (c && c.fingerprint256 && !seen.has(c.fingerprint256) && out.length < 6) {
		seen.add(c.fingerprint256);
		const selfSigned = c.issuerCertificate ? c.issuerCertificate.fingerprint256 === c.fingerprint256 : JSON.stringify(c.subject) === JSON.stringify(c.issuer);
		out.push({
			subject: { CN: c.subject?.CN, O: c.subject?.O },
			issuer: { CN: c.issuer?.CN, O: c.issuer?.O, C: c.issuer?.C },
			valid_from: c.valid_from,
			valid_to: c.valid_to,
			self_signed: selfSigned,
			subjectaltname_count: c.subjectaltname ? c.subjectaltname.split(',').length : 0,
			subjectaltname_wildcard: c.subjectaltname ? /DNS:\*\./.test(c.subjectaltname) : false,
			bits: c.bits,
		});
		c = c.issuerCertificate;
	}
	return out;
}

/** TLS to the broker, ApiVersions, a SaslHandshake naming no real mechanism; then the port in plain TCP. */
async function rawKafka({ host, port, useTls, tlsOptions = {} }) {
	const result = {};
	const connect = () => new Promise((resolve, reject) => {
		const s = useTls
			? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, ...tlsOptions }, () => resolve(s))
			: net.connect({ host, port }, () => resolve(s));
		s.setTimeout(10_000, () => { s.destroy(new Error('timeout')); });
		s.once('error', reject);
	});
	const s = await withTimeout(connect(), 15_000, 'connect');
	try {
		if (useTls) {
			result.tls = { authorized_by_system_cas: s.authorized, authorization_error: s.authorizationError ?? null, protocol: s.getProtocol(), cipher: s.getCipher()?.name, chain: certChain(s) };
		}
		const send = rawChannel(s);
		result.api_versions = parseApiVersions(await withTimeout(send(18, 0), 10_000, 'ApiVersions'));
		result.sasl_handshake = { request: { mechanism: 'PROBE-NO-SUCH-MECHANISM' }, response: parseSaslHandshake(await withTimeout(send(17, 1, stringBody('PROBE-NO-SUCH-MECHANISM')), 10_000, 'SaslHandshake')) };
	} finally { s.destroy(); }
	if (useTls) {
		// The same port without TLS: is TLS required?
		result.plaintext = await new Promise((resolve) => {
			const p = net.connect({ host, port });
			const t0 = Date.now();
			let done = false;
			const end = (outcome, extra = {}) => { if (done) return; done = true; p.destroy(); resolve({ outcome, ms: Date.now() - t0, ...extra }); };
			p.setTimeout(8_000, () => end('no answer within 8 s'));
			p.on('error', (e) => end('error', { error: String(e.message) }));
			p.on('close', () => end('closed by the broker'));
			p.on('data', (d) => end('answered', { first_bytes: d.length, looks_like_tls_alert: d[0] === 0x15 }));
			p.on('connect', () => { const send = rawChannel(p); send(18, 0).catch(() => {}); });
		});
	}
	return result;
}

// ---------------------------------------------------------------------------------------------
// The candidate clients, each behind one small interface:
//   connect(), metadata(topic) -> {partitions: [{partition, leader}], brokers: [{nodeId, host, port}], topicError?},
//   allTopicsCount(), topicConfigs(topic) -> [{name, value}], offsets(topic, partitions, ts) ->
//   {partition: offset} (ts: -2 earliest, -1 latest, else ms), fetch(topic, partition, offset,
//   {maxWaitMs, maxBytes, leader}) -> {records: [{partition, offset, timestamp, key, value, headers}],
//   highWatermark, logStartOffset}, close(). Errors are thrown as the library's own.

function kafkajsClient(lib, { brokers, tlsOptions, sasl, clientId }) {
	const { Kafka, logLevel, ConfigResourceTypes } = lib;
	const kafka = new Kafka({
		clientId,
		brokers,
		ssl: tlsOptions ?? false,
		sasl: { mechanism: sasl.mechanism.toLowerCase(), username: sasl.username, password: sasl.password },
		connectionTimeout: 10_000,
		authenticationTimeout: 10_000,
		requestTimeout: KAFKA_MS,
		retry: { retries: 1, initialRetryTime: 300 },
		logLevel: logLevel.NOTHING,
	});
	// kafkajs reads only through a consumer group; a group-less Fetch needs its internal cluster.
	const sym = Object.getOwnPropertySymbols(kafka).find((s) => s.description === 'private:Kafka:createCluster');
	if (!sym) throw new Error('kafkajs internals changed: no private createCluster');
	const cluster = kafka[sym]({ allowAutoTopicCreation: false, metadataMaxAge: 300_000, isolationLevel: 0 });
	let admin = null;
	return {
		name: 'kafkajs',
		notes: 'Fetch without a consumer group through kafkajs internals (Kafka[private:createCluster], Cluster.findBroker, Broker.fetch); offsets through Cluster.fetchTopicsOffset; DescribeConfigs and fetchTopicOffsetsByTimestamp through the public admin',
		async connect() { await cluster.connect(); },
		async metadata(topic) {
			const md = await cluster.metadata({ topics: [topic] });
			const t = md.topicMetadata.find((x) => x.topic === topic);
			return {
				topicError: t?.topicErrorCode ? (KAFKA_ERRORS[t.topicErrorCode] ?? t.topicErrorCode) : null,
				partitions: (t?.partitionMetadata ?? []).map((p) => ({ partition: p.partitionId, leader: p.leader, error: p.partitionErrorCode || null })).sort((a, b) => a.partition - b.partition),
				brokers: md.brokers.map((b) => ({ nodeId: b.nodeId, host: b.host, port: b.port, rack: b.rack ?? null })),
			};
		},
		async allTopicsCount() {
			const md = await cluster.metadata({ topics: [] });
			return { topics: md.topicMetadata.length, includes_logs_topic: md.topicMetadata.some((x) => x.topic === TOPIC) };
		},
		async topicConfigs(topic) {
			admin ??= kafka.admin({ retry: { retries: 1 } });
			await admin.connect();
			const r = await admin.describeConfigs({ resources: [{ type: ConfigResourceTypes.TOPIC, name: topic }], includeSynonyms: false });
			const res = r.resources[0];
			if (res.errorCode) { const e = new Error(res.errorMessage || `DescribeConfigs error ${res.errorCode}`); e.code = res.errorCode; throw e; }
			return res.configEntries.map((c) => ({ name: c.configName, value: c.configValue, is_default: c.isDefault, source: c.configSource }));
		},
		async publicOffsetsByTimestamp(topic, ts) {
			admin ??= kafka.admin({ retry: { retries: 1 } });
			await admin.connect();
			return admin.fetchTopicOffsetsByTimestamp(topic, ts);
		},
		async offsets(topic, partitions, ts) {
			await cluster.addTargetTopic(topic);
			const r = await cluster.fetchTopicsOffset([{ topic, partitions: partitions.map((p) => ({ partition: p })), fromTimestamp: ts }]);
			return Object.fromEntries(r[0].partitions.map((p) => [p.partition, Number(p.offset)]));
		},
		async fetch(topic, partition, offset, { maxWaitMs = 500, maxBytes = FETCH_MAX_BYTES, leader }) {
			const broker = await cluster.findBroker({ nodeId: leader });
			const r = await broker.fetch({ replicaId: -1, isolationLevel: 0, maxWaitTime: maxWaitMs, minBytes: 1, maxBytes, topics: [{ topic, partitions: [{ partition, fetchOffset: String(offset), maxBytes }] }] });
			const p = r.responses[0]?.partitions[0];
			if (p?.errorCode) { const e = new Error(`Fetch error ${p.errorCode}`); e.code = p.errorCode; throw e; }
			const records = (p?.messages ?? []).filter((m) => Number(m.offset) >= offset).map((m) => ({
				partition, offset: Number(m.offset), timestamp: Number(m.timestamp), key: m.key ?? null, value: m.value ?? null,
				headers: Object.entries(m.headers ?? {}).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(String(v))]),
			}));
			return { records, highWatermark: Number(p?.highWatermark ?? -1), logStartOffset: p?.logStartOffset != null ? Number(p.logStartOffset) : null };
		},
		/** kafkajs decodes only gzip; Snappy, LZ4 and ZSTD need codecs. The probe borrows @platformatic/kafka's. */
		borrowCodecs(plt) {
			const { CompressionTypes, CompressionCodecs } = lib;
			const algs = plt?.compressionsAlgorithms;
			if (!algs) return [];
			const asBuffer = (x) => (Buffer.isBuffer(x) ? x : (x?.buffer && Buffer.isBuffer(x.buffer) ? x.buffer : Buffer.from(x)));
			const done = [];
			for (const [type, alg] of [[CompressionTypes.Snappy, algs.snappy], [CompressionTypes.LZ4, algs.lz4], [CompressionTypes.ZSTD, algs.zstd]]) {
				if (!alg) continue;
				CompressionCodecs[type] = () => ({ async compress() { throw new Error('the probe never compresses'); }, async decompress(buf) { return asBuffer(alg.decompressSync(buf)); } });
				done.push(Object.keys(CompressionTypes).find((k) => CompressionTypes[k] === type));
			}
			return done;
		},
		async close() { await admin?.disconnect().catch(() => {}); await cluster.disconnect().catch(() => {}); },
	};
}

function platformaticClient(lib, { brokers, tlsOptions, sasl, clientId, tag }) {
	const { Consumer, Admin } = lib;
	const base = {
		clientId,
		bootstrapBrokers: brokers,
		...(tlsOptions ? { tls: tlsOptions } : {}),
		sasl: { mechanism: sasl.mechanism, username: sasl.username, password: sasl.password },
		autocreateTopics: false,
		retries: 1,
		retryDelay: 300,
		connectTimeout: 10_000,
		requestTimeout: KAFKA_MS,
	};
	// A Consumer needs a groupId; only consume() and joinGroup() use it, and the probe calls neither.
	const consumer = new Consumer({ ...base, groupId: `${NAME_PREFIX}${tag}-never-joined` });
	let admin = null;
	let topicIds = new Map();
	return {
		name: 'platformatic',
		notes: 'Consumer.metadata, Consumer.listOffsetsWithTimestamps, Consumer.fetch (public, no group joined), Admin.describeConfigs',
		async connect() { await consumer.metadata({ topics: [], autocreateTopics: false }); },
		async metadata(topic) {
			const md = await consumer.metadata({ topics: [topic], autocreateTopics: false, forceUpdate: true });
			const t = md.topics.get(topic);
			if (t) topicIds.set(topic, t.id);
			consumer.topics.track(topic);
			return {
				topicError: t ? null : 'topic not in the metadata',
				partitions: (t?.partitions ?? []).map((p, i) => ({ partition: i, leader: p.leader })),
				brokers: [...md.brokers].map(([id, b]) => ({ nodeId: id, host: b.host, port: b.port, rack: b.rack ?? null })),
			};
		},
		async allTopicsCount() { return { topics: null, note: 'not asked: Consumer.metadata takes a topic list' }; },
		async topicConfigs(topic) {
			admin ??= new Admin(base);
			const r = await admin.describeConfigs({ resources: [{ resourceType: 2, resourceName: topic }] });
			return r[0].configs.map((c) => ({ name: c.name, value: c.value, is_default: c.isDefault ?? null, source: c.configSource ?? null }));
		},
		async offsets(topic, partitions, ts) {
			const r = await consumer.listOffsetsWithTimestamps({ topics: [topic], partitions: { [topic]: partitions }, timestamp: BigInt(ts), isolationLevel: 0 });
			const m = r.get(topic);
			return Object.fromEntries(partitions.map((p) => [p, m?.get(p) ? Number(m.get(p).offset) : null]));
		},
		async fetch(topic, partition, offset, { maxWaitMs = 500, maxBytes = FETCH_MAX_BYTES, leader }) {
			const topicId = topicIds.get(topic);
			if (!topicId) throw new Error('metadata first');
			const r = await consumer.fetch({ node: leader, maxWaitTime: maxWaitMs, minBytes: 1, maxBytes, isolationLevel: 0, topics: [{ topicId, partitions: [{ partition, currentLeaderEpoch: -1, fetchOffset: BigInt(offset), lastFetchedEpoch: -1, partitionMaxBytes: maxBytes }] }] });
			const p = r.responses[0]?.partitions.find((x) => x.partitionIndex === partition);
			if (p?.errorCode) { const e = new Error(`Fetch error ${p.errorCode}`); e.code = p.errorCode; throw e; }
			const records = [];
			for (const batch of p?.records ?? []) {
				for (const rec of batch.records) {
					const off = Number(batch.firstOffset + BigInt(rec.offsetDelta));
					if (off < offset) continue;
					records.push({ partition, offset: off, timestamp: Number(batch.firstTimestamp + rec.timestampDelta), key: rec.key ?? null, value: rec.value ?? null, headers: (rec.headers ?? []).map(([k, v]) => [k?.toString() ?? '', v ?? Buffer.alloc(0)]), codec: CODECS[batch.attributes & 7] ?? String(batch.attributes & 7) });
				}
			}
			return { records, highWatermark: Number(p?.highWatermark ?? -1), logStartOffset: p?.logStartOffset != null ? Number(p.logStartOffset) : null };
		},
		async close() { await admin?.close().catch(() => {}); await consumer.close(true).catch(() => {}); },
	};
}

const CODECS = { 0: 'none', 1: 'gzip', 2: 'snappy', 3: 'lz4', 4: 'zstd' };

const CANDIDATES = {
	kafkajs: { pkg: 'kafkajs', entry: "export * from 'kafkajs';", make: kafkajsClient },
	platformatic: { pkg: '@platformatic/kafka', entry: "export * from '@platformatic/kafka';", make: platformaticClient },
};

/** Installs the candidates into .cache/logs-probe/ (never the repository's package.json). */
function installClients(dir) {
	fs.mkdirSync(dir, { recursive: true });
	const pj = path.join(dir, 'package.json');
	const want = { name: 'logs-probe-clients', private: true, dependencies: Object.fromEntries(Object.entries(CLIENT_VERSIONS).map(([k, v]) => [k, `^${v}`])) };
	const have = fs.existsSync(pj) ? JSON.parse(fs.readFileSync(pj, 'utf8')) : null;
	const missing = Object.keys(CLIENT_VERSIONS).some((k) => !fs.existsSync(path.join(dir, 'node_modules', k, 'package.json')));
	if (!have || JSON.stringify(have.dependencies) !== JSON.stringify(want.dependencies)) fs.writeFileSync(pj, `${JSON.stringify(want)}\n`);
	if (missing) execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
}

function nativeFiles(dir) {
	const out = [];
	(function walk(d, depth) {
		if (depth > 8) return;
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p, depth + 1);
			else if (e.name.endsWith('.node') || e.name.endsWith('.wasm')) out.push(path.relative(dir, p));
		}
	})(path.join(dir, 'node_modules'), 0);
	return out;
}

/**
 * Bundles a candidate as the extension is bundled (esbuild, CommonJS, Node) and loads the bundle.
 * When that bundle does not load, the workarounds the extension would need are tried in order and
 * recorded: for @platformatic/kafka, `@platformatic/wasm-utils/bundled` (the wasm inlined) instead of
 * a `native.wasm` read through `import.meta.url` (empty in CommonJS), then an `import.meta.url`
 * shim with the wasm file copied beside the bundle.
 */
async function bundleClient(name, dir) {
	const c = CANDIDATES[name];
	const esbuild = createRequire(path.join(ROOT, 'package.json'))('esbuild');
	const pkgJson = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', c.pkg, 'package.json'), 'utf8'));
	const info = { package: c.pkg, version: pkgJson.version, license: pkgJson.license, dependencies: Object.keys(pkgJson.dependencies ?? {}), optional_dependencies: Object.keys(pkgJson.optionalDependencies ?? {}), esbuild: esbuild.version, attempts: [] };
	const outDir = path.join(dir, 'dist');
	fs.mkdirSync(outDir, { recursive: true });
	const build = async (label, extra, minify) => {
		const outfile = path.join(outDir, `${name}-${label}${minify ? '.min' : ''}.cjs`);
		const r = await esbuild.build({ stdin: { contents: c.entry, resolveDir: dir, loader: 'js' }, bundle: true, platform: 'node', format: 'cjs', target: 'node20', minify, outfile, metafile: true, logLevel: 'silent', sourcemap: false, ...extra });
		const inputs = Object.keys(r.metafile.inputs);
		return { outfile, bytes: fs.statSync(outfile).size, gzip_bytes: zlib.gzipSync(fs.readFileSync(outfile)).length, warnings: r.warnings.map((w) => w.text), inputs: inputs.length, native_inputs: inputs.filter((i) => /\.(node|wasm)$/.test(i)), packages: [...new Set(inputs.map((i) => /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(i)?.[1]).filter(Boolean))].sort() };
	};
	const attempts = [['plain', 'as the extension bundles today', {}]];
	if (name === 'platformatic') {
		const alias = { '@platformatic/wasm-utils': path.join(dir, 'node_modules/@platformatic/wasm-utils/dist/bundled.js') };
		const shim = { define: { 'import.meta.url': '__probe_import_meta_url' }, banner: { js: "var __probe_import_meta_url = require('url').pathToFileURL(__filename).href;" } };
		attempts.push(['wasm-inlined', 'alias @platformatic/wasm-utils -> @platformatic/wasm-utils/bundled (the wasm inlined)', { alias }]);
		attempts.push(['import-meta-shim', 'define import.meta.url from __filename; native.wasm copied beside the bundle', shim]);
		attempts.push(['import-meta-shim-wasm-inlined', 'both: the import.meta.url shim and the inlined wasm (no file beside the bundle)', { ...shim, alias }]);
	}
	let lib = null;
	for (const [label, how, extra] of attempts) {
		const a = { attempt: label, how };
		info.attempts.push(a);
		try {
			const b = await build(label, extra, false);
			const min = await build(label, extra, true);
			Object.assign(a, { bytes: b.bytes, minified_bytes: min.bytes, minified_gzip_bytes: min.gzip_bytes, warnings: b.warnings, inputs: b.inputs, native_inputs: b.native_inputs, packages: b.packages });
			fs.rmSync(path.join(outDir, 'native.wasm'), { force: true });
			if (label === 'import-meta-shim') fs.copyFileSync(path.join(dir, 'node_modules/@platformatic/wasm-utils/dist/native.wasm'), path.join(outDir, 'native.wasm'));
			lib = createRequire(import.meta.url)(b.outfile);
			a.loaded = true;
			info.loaded_from = label;
			break;
		} catch (e) {
			a.loaded = false;
			a.error = errInfo(e);
		}
	}
	if (!lib) throw new Error(`no bundle of ${c.pkg} loaded: ${info.attempts.map((a) => `${a.attempt}: ${a.error?.message}`).join('; ')}`);
	info.native_files_installed = nativeFiles(dir);
	return { lib, info };
}

/** Native addons (.node) loaded into this process so far. */
const nativeLoaded = () => Object.keys(createRequire(import.meta.url).cache).filter((k) => k.endsWith('.node')).map((k) => path.relative(ROOT, k));

function npmView(pkg) {
	try {
		const out = execFileSync('npm', ['view', pkg, 'version', 'time.modified', `time.${CLIENT_VERSIONS[pkg]}`, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
		return JSON.parse(out);
	} catch (e) { return { error: String(e.message).split('\n')[0] }; }
}

// ---------------------------------------------------------------------------------------------
// Records: own ones kept (ids as placeholders), the rest as aggregates

function parseValue(v) {
	if (!v) return { ok: false };
	try { const j = JSON.parse(v.toString('utf8')); return { ok: j && typeof j === 'object' && !Array.isArray(j), json: j }; } catch { return { ok: false }; }
}

const isOwn = (rec, pid) => (rec.key && rec.key.toString('utf8') === pid) || parseValue(rec.value).json?.pipeline_id === pid;

/** One of the probe's own records, its unknown fields reduced to type and length. */
function ownRecord(rec, R) {
	const v = parseValue(rec.value);
	let value;
	if (v.ok) {
		value = {};
		for (const [k, x] of Object.entries(v.json)) {
			if (k === 'instance_id' && typeof x === 'string') { R.id(x, `<instance-id-${[...R.ids.values()].filter((p) => p.startsWith('<instance-id')).length + 1}>`); value[k] = x; }
			else if (KNOWN_FIELDS.has(k)) value[k] = x;
			else value[k] = typeof x === 'string' ? `<string, ${x.length} chars>` : (x && typeof x === 'object' ? shape(x) : x);
		}
	} else value = `<not a JSON object, ${rec.value?.length ?? 0} bytes>`;
	return { partition: rec.partition, offset: rec.offset, timestamp: new Date(rec.timestamp).toISOString(), key: rec.key ? rec.key.toString('utf8') : null, headers: rec.headers.map(([k, hv]) => [k, `<${hv?.length ?? 0} bytes>`]), value };
}

const stats = (xs) => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
	return { n: s.length, min: s[0], median: q(0.5), p95: q(0.95), max: s[s.length - 1] };
};

/** Aggregates over records: no key, message or id of anyone's appears. */
function aggregate(records, pid, partitionCount) {
	const fields = {};
	const levels = {};
	const headerNames = {};
	const codecs = {};
	const keyLens = [], valueSizes = [], timeSkew = [];
	let nullKeys = 0, jsonObjects = 0, keyIsPipelineId = 0, keyLooksLikeXid = 0;
	const byKey = new Map();
	for (const r of records) {
		const key = r.key ? r.key.toString('utf8') : null;
		if (key == null) nullKeys++; else keyLens.push(key.length);
		if (key && /^[a-v0-9]{20}$/.test(key)) keyLooksLikeXid++;
		valueSizes.push(r.value?.length ?? 0);
		if (r.codec) codecs[r.codec] = (codecs[r.codec] ?? 0) + 1;
		for (const [h] of r.headers) { const n = /^[A-Za-z0-9_.-]{1,40}$/.test(h) ? h : '<other>'; headerNames[n] = (headerNames[n] ?? 0) + 1; }
		const v = parseValue(r.value);
		if (v.ok) {
			jsonObjects++;
			for (const [k, x] of Object.entries(v.json)) {
				const name = /^[A-Za-z0-9_@.-]{1,40}$/.test(k) ? k : '<other>';
				const f = (fields[name] ??= { present: 0, types: {} });
				f.present++;
				const t = x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x;
				f.types[t] = (f.types[t] ?? 0) + 1;
			}
			if (key && v.json.pipeline_id === key) keyIsPipelineId++;
			const lv = String(v.json.level ?? '');
			const l = LEVELS.has(lv) ? lv : (lv ? '<other>' : '<none>');
			levels[l] = (levels[l] ?? 0) + 1;
			const t = Date.parse(v.json.time);
			if (Number.isFinite(t)) timeSkew.push(r.timestamp - t);
		}
		if (key != null) {
			const e = byKey.get(key) ?? { partitions: new Set(), n: 0 };
			e.partitions.add(r.partition);
			e.n++;
			byKey.set(key, e);
		}
	}
	let oneP = 0, defaultP = 0;
	for (const [k, e] of byKey) {
		if (e.partitions.size === 1) oneP++;
		if (e.partitions.size === 1 && partitionCount && [...e.partitions][0] === defaultPartition(Buffer.from(k), partitionCount)) defaultP++;
	}
	const own = pid ? byKey.get(pid) : null;
	return {
		records: records.length,
		json_objects: jsonObjects,
		null_keys: nullKeys,
		key_length: stats(keyLens),
		keys_like_a_20_char_xid: keyLooksLikeXid,
		key_equals_value_pipeline_id: keyIsPipelineId,
		value_bytes: stats(valueSizes),
		fields: Object.fromEntries(Object.entries(fields).sort((a, b) => b[1].present - a[1].present)),
		levels,
		header_names: headerNames,
		batch_compression: Object.keys(codecs).length ? codecs : 'not reported by this client',
		record_timestamp_minus_value_time_ms: stats(timeSkew),
		placement: { distinct_keys: byKey.size, keys_in_one_partition: oneP, keys_on_their_murmur2_partition: defaultP, own_pipeline: own ? { records: own.n, partitions: [...own.partitions].sort((a, b) => a - b), murmur2_partition: partitionCount ? defaultPartition(Buffer.from(pid), partitionCount) : null } : null },
	};
}

// ---------------------------------------------------------------------------------------------
// The probe

async function probe({ fetchImpl, cloudCreds, logsUser, outDir, pollMs, runMs, liveMs, failAt, rawKafkaImpl, loadClient, clientFactory = (name, lib, opts) => CANDIDATES[name].make(lib, opts), clients, tlsOptions }) {
	const R = new Redactor();
	R.secret(cloudCreds.clientId);
	R.secret(cloudCreds.clientSecret);
	R.secret(logsUser.username);
	R.secret(logsUser.password);
	const tag = randomBytes(5).toString('hex').slice(0, 8);
	R.id(`${NAME_PREFIX}${tag}`, `${NAME_PREFIX}<run>`);
	R.id(tag, '<run>');
	const badPassword = `probe-wrong-${randomBytes(6).toString('hex')}`;
	R.secret(badPassword);

	const caps = [];
	const errors = [];
	const run = { date: new Date().toISOString(), cluster_name: CLUSTER_NAME, topic: TOPIC, dry_run: !fetchImpl.isReal, clients, user_mechanism: logsUser.mechanism };
	let token = null;
	const print = (s) => console.log(R.text(s));

	function record(step, data, ms) {
		if (failAt && step === failAt) throw new Error(`injected failure at ${step}`);
		caps.push({ step, ...data, ...(ms != null ? { ms } : {}) });
	}

	async function http(step, { method = 'GET', url, body, form, recordIt = true, quiet = false }) {
		if (failAt && step === failAt) throw new Error(`injected failure at ${step}`);
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
		if (!quiet) print(`${step.padEnd(44)} ${method.padEnd(6)} ${url} -> ${netError ? `network error: ${netError}` : status} (${ms} ms)`);
		return { status, json, text, cap };
	}
	const ok = (r) => r.status >= 200 && r.status < 300;

	async function section(name, fn) {
		try { await fn(); } catch (e) {
			const msg = R.text(String(e?.message ?? e));
			errors.push({ section: name, error: msg });
			print(`!! ${name}: ${msg}`);
		}
	}

	/** A Kafka step: its result or its error, recorded either way; returns the result or undefined. */
	async function kstep(step, request, fn, { keep = (x) => x } = {}) {
		const t0 = Date.now();
		try {
			const result = await withTimeout(fn(), KAFKA_MS * 2, step);
			record(step, { request, result: keep(result) }, Date.now() - t0);
			print(`${step.padEnd(44)} ok (${Date.now() - t0} ms)`);
			return { ok: true, result };
		} catch (e) {
			if (String(e?.message).startsWith('injected failure')) throw e;
			record(step, { request, error: errInfo(e) }, Date.now() - t0);
			print(`${step.padEnd(44)} ERROR ${R.text(errInfo(e).message)} (${Date.now() - t0} ms)`);
			return { ok: false, error: e };
		}
	}

	let dp = null;
	let seeds = [];
	let pipeline = null; // {id, gone}
	const pipelineName = `${NAME_PREFIX}${tag}`;
	const pipeUrl = (id, suffix = '') => `${dp}${PIPES}/${id}${suffix}`;
	let runningAt = null;

	async function waitFor(label, done, timeoutMs) {
		const t0 = Date.now();
		let last = null, lastState = null, polls = 0, timedOut = false;
		for (;;) {
			const r = await http(label, { url: pipeUrl(pipeline.id), recordIt: false, quiet: true });
			polls++;
			const p = r.json?.pipeline;
			const state = r.status === 200 ? (p?.state ?? '?') : `HTTP ${r.status}`;
			if (state !== lastState) { print(`${label.padEnd(44)} state ${state} after ${Date.now() - t0} ms`); lastState = state; }
			last = r;
			if (done(r, p)) break;
			if (Date.now() - t0 > timeoutMs || (pollMs === 0 && polls > 50)) { timedOut = true; break; }
			await sleep(pollMs);
		}
		last.cap.step = `${label}-final`;
		last.cap.derived = { polls, ms_waited: Date.now() - t0, timed_out: timedOut, final_state: lastState };
		caps.push(last.cap);
		return { p: last.json?.pipeline, state: lastState, timedOut };
	}

	async function deletePipeline(prefix) {
		if (!pipeline || pipeline.gone) return;
		const r = await http(`${prefix}-pipeline-delete`, { method: 'DELETE', url: pipeUrl(pipeline.id) });
		if (!ok(r) && r.status !== 404) throw new Error(`delete returned ${r.status}`);
		const w = await waitFor(`${prefix}-pipeline-gone`, (x) => x.status === 404, GONE_TIMEOUT_MS);
		if (w.state === 'HTTP 404') pipeline.gone = true;
	}

	const pipelineConfig = [
		'input:',
		'  generate:',
		'    interval: 1s',
		'    mapping: \'root = {"n": counter()}\'',
		'pipeline:',
		'  processors:',
		'    - log:',
		'        level: INFO',
		'        message: \'vscode-spike-logs info ${! this.n }\'',
		'    - log:',
		'        level: WARN',
		'        message: \'vscode-spike-logs warn ${! this.n }\'',
		'        fields_mapping: \'root.probe_n = this.n\'',
		'output:',
		'  drop: {}',
		'',
	].join('\n');

	const loaded = {}; // client name -> lib
	const answers = {}; // client name -> per-question results
	let partitions = null; // [{partition, leader}] from the first client that read metadata
	const open = {}; // client name -> the signed-in client

	try {
		// ---- Cloud: token, cluster, the test pipeline
		await section('token', async () => {
			const r = await http('token', { method: 'POST', url: AUTH_URL, form: { grant_type: 'client_credentials', client_id: cloudCreds.clientId, client_secret: cloudCreds.clientSecret, audience: AUDIENCE } });
			if (!ok(r) || !r.json?.access_token) throw new Error(`token request returned ${r.status}`);
			token = r.json.access_token;
			R.secret(token);
			const claims = decodeJwtPayload(token) ?? {};
			for (const [k, v] of Object.entries(claims)) if (/org/i.test(k) && typeof v === 'string') R.id(v, '<org-id>');
			r.cap.response.body = { access_token: '<redacted>', expires_in: r.json.expires_in, token_type: r.json.token_type };
		});
		if (!token) throw new Error('no token; nothing else can run');

		await section('cluster', async () => {
			const l = await http('clusters-list', { url: `${CP}/v1/clusters?page_size=100` });
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
			const g = await http('cluster-get', { url: `${CP}/v1/clusters/${target.id}` });
			if (!ok(g)) throw new Error(`cluster get returned ${g.status}`);
			const c = g.json.cluster;
			dp = c.dataplane_api?.url?.replace(/\/+$/, '') ?? null;
			if (dp) {
				const host = new URL(dp).host;
				R.id(host, '<dataplane-host>');
				const prefix = /^[a-z]+-([a-z0-9]+)\./.exec(host)?.[1];
				if (prefix) R.id(prefix, '<dataplane-prefix>');
			}
			const k = c.kafka_api ?? {};
			seeds = (k.seed_brokers ?? []).map((s) => { const m = /^(.*):(\d+)$/.exec(String(s)); return { host: m ? m[1] : String(s), port: m ? Number(m[2]) : 9092 }; });
			for (const s of seeds) R.host(s.host);
			// Only the fields the findings use; the rest of the cluster by name.
			g.cap.response.body = { cluster: {
				name: c.name, type: c.type, state: c.state, cloud_provider: c.cloud_provider, region: c.region,
				kafka_api: { seed_brokers: seeds.map((s) => `${R.ids.get(s.host)}:${s.port}`), '<fields>': fieldsOf(Object.fromEntries(Object.entries(k).filter(([x]) => x !== 'seed_brokers'))) },
				dataplane_api: c.dataplane_api ? { url: c.dataplane_api.url } : undefined,
				'<other fields with kafka, sasl, tls or mtls in their name>': fieldsOf(Object.fromEntries(Object.entries(c).filter(([x]) => /kafka|sasl|tls|mtls/i.test(x) && x !== 'kafka_api'))),
				'<other fields>': Object.keys(c).filter((x) => !['name', 'type', 'state', 'cloud_provider', 'region', 'kafka_api', 'dataplane_api'].includes(x)).sort(),
			} };
			run.seed_brokers = seeds.length;
			run.seed_ports = [...new Set(seeds.map((s) => s.port))];
			if (!seeds.length) throw new Error('the cluster has no kafka_api.seed_brokers');
		});

		if (dp) {
			await section('pipeline-create', async () => {
				const r = await http('pipeline-create', { method: 'POST', url: `${dp}${PIPES}`, body: { display_name: pipelineName, description: 'vscode spike 6.1 logs probe, safe to delete', config_yaml: pipelineConfig, resources: RESOURCES, tags: { 'vscode-spike': 'logs' } } });
				const p = r.json?.pipeline;
				if (ok(r) && p?.id && p.display_name === pipelineName) {
					pipeline = { id: p.id, gone: false };
					R.id(p.id, '<pipeline-id>');
				} else throw new Error(`pipeline create returned ${r.status}`);
			});
		}

		// ---- Kafka without a client
		if (seeds.length) {
			await section('raw-kafka', async () => {
				const s = seeds[0];
				const t0 = Date.now();
				const r = await rawKafkaImpl({ host: s.host, port: s.port, useTls: !!tlsOptions, tlsOptions: tlsOptions ?? {} });
				record('raw-tls-apiversions-saslhandshake', { request: { broker: `${R.ids.get(s.host)}:${s.port}`, tls: !!tlsOptions, requests: ['ApiVersions v0', 'SaslHandshake v1 PROBE-NO-SUCH-MECHANISM', 'ApiVersions v0 without TLS'] }, result: r }, Date.now() - t0);
				run.tls = r.tls ? { authorized_by_system_cas: r.tls.authorized_by_system_cas, protocol: r.tls.protocol, issuer: r.tls.chain?.[0]?.issuer } : null;
				run.sasl_mechanisms_offered = r.sasl_handshake?.response.enabled_mechanisms;
				run.user_mechanism_offered = run.sasl_mechanisms_offered?.includes(logsUser.mechanism) ?? null;
				run.plaintext_port = r.plaintext?.outcome ?? null;
				print(`raw: mechanisms ${JSON.stringify(run.sasl_mechanisms_offered)}, tls trusted by system CAs: ${r.tls?.authorized_by_system_cas}`);
			});
		}

		// ---- The clients: install, bundle, load
		await section('clients-bundle', async () => {
			for (const name of clients) {
				const t0 = Date.now();
				try {
					const { lib, info } = await loadClient(name);
					loaded[name] = lib;
					record(`client-${name}-bundle`, { result: info }, Date.now() - t0);
				} catch (e) {
					record(`client-${name}-bundle`, { error: errInfo(e) }, Date.now() - t0);
					errors.push({ section: `bundle ${name}`, error: R.text(String(e?.message ?? e)) });
				}
			}
		});

		const brokers = seeds.map((s) => `${s.host}:${s.port}`);
		const makeClient = (name, sasl) => clientFactory(name, loaded[name], { brokers, tlsOptions, sasl, clientId: `rpcn-logs-probe-${tag}`, tag });

		// ---- Per client: sign-in, metadata, configs, offsets (no pipeline needed)
		for (const name of clients) {
			if (!loaded[name]) continue;
			const a = (answers[name] = {});
			await section(`${name}-access`, async () => {
				const bad = makeClient(name, { ...logsUser, password: badPassword });
				const w = await kstep(`${name}-auth-wrong-password`, { mechanism: logsUser.mechanism, password: '<a wrong one>' }, async () => { await bad.connect(); return bad.metadata(TOPIC); });
				await bad.close();
				a.wrong_password = w.ok ? 'ACCEPTED (unexpected)' : errInfo(w.error);
				if (name === 'kafkajs') {
					const other = logsUser.mechanism === 'SCRAM-SHA-256' ? 'SCRAM-SHA-512' : 'SCRAM-SHA-256';
					const om = makeClient(name, { ...logsUser, mechanism: other });
					const o = await kstep(`${name}-auth-other-mechanism`, { mechanism: other }, async () => { await om.connect(); return om.metadata(TOPIC); }, { keep: () => 'signed in' });
					await om.close();
					a.other_mechanism = { mechanism: other, signed_in: o.ok };
				}

				const c = makeClient(name, logsUser);
				open[name] = c;
				const conn = await kstep(`${name}-connect`, { mechanism: logsUser.mechanism }, () => c.connect(), { keep: () => 'connected and signed in' });
				a.signed_in = conn.ok;
				if (!conn.ok) return;
				const md = await kstep(`${name}-metadata-topic`, { topic: TOPIC, auto_create: false }, () => c.metadata(TOPIC));
				if (md.ok) {
					for (const b of md.result.brokers) R.host(b.host);
					a.partitions = md.result.partitions.length;
					a.brokers = md.result.brokers.length;
					partitions ??= md.result.partitions;
					if (!md.result.partitions.length) throw new Error(`no partitions of ${TOPIC} visible (${md.result.topicError})`);
				}
				const all = await kstep(`${name}-metadata-all-topics`, { topics: 'all (a count only)' }, () => c.allTopicsCount());
				a.all_topics = all.ok ? all.result : errInfo(all.error);
				const cfg = await kstep(`${name}-describe-configs`, { resource: `topic ${TOPIC}` }, () => c.topicConfigs(TOPIC), { keep: (x) => x.map((e) => ({ ...e, value: e.value != null && String(e.value).length > 200 ? `<${String(e.value).length} chars>` : e.value })) });
				a.describe_configs = cfg.ok ? Object.fromEntries(cfg.result.filter((e) => /^(retention|cleanup|segment|redpanda\.remote|message\.timestamp)/.test(e.name)).map((e) => [e.name, e.value])) : errInfo(cfg.error);
				const parts = (md.ok ? md.result.partitions : partitions ?? []).map((p) => p.partition);
				const now = Date.now();
				const offs = {};
				for (const [label, ts] of [['earliest', -2], ['latest', -1], ['now-1h', now - 3_600_000], ['now-24h', now - 86_400_000]]) {
					const r = await kstep(`${name}-list-offsets-${label}`, { partitions: parts, timestamp: ts }, () => c.offsets(TOPIC, parts, ts));
					offs[label] = r.ok ? r.result : null;
					if (!r.ok) a[`list_offsets_${label}`] = errInfo(r.error);
				}
				const sum = (o, base) => (o && base ? parts.reduce((s, p) => s + Math.max(0, (base[p] ?? 0) - ((o[p] ?? -1) < 0 ? base[p] : o[p])), 0) : null);
				a.records_in_topic = sum(offs.earliest, offs.latest);
				a.records_last_hour = sum(offs['now-1h'], offs.latest);
				a.records_last_24h = sum(offs['now-24h'], offs.latest);
				// One fetch of the newest records on a partition that has some: does the client decode them?
				const withData = parts.find((p) => (offs.latest?.[p] ?? 0) > (offs.earliest?.[p] ?? 0));
				if (withData != null) {
					const from = Math.max(offs.earliest[withData], offs.latest[withData] - 20);
					const leader = (md.ok ? md.result.partitions : partitions).find((p) => p.partition === withData)?.leader;
					const keep = (x) => ({ records: x.records.length, batch_compression: [...new Set(x.records.map((r) => r.codec ?? 'not reported'))], high_watermark: x.highWatermark, log_start_offset: x.logStartOffset });
					const f = await kstep(`${name}-fetch-newest`, { partition: withData, from_offset: from }, () => c.fetch(TOPIC, withData, from, { leader }), { keep });
					a.fetch = f.ok ? 'decoded' : errInfo(f.error);
					if (!f.ok && name === 'kafkajs' && /compression not implemented/i.test(String(f.error?.message))) {
						const borrowed = c.borrowCodecs(loaded.platformatic);
						a.codecs_borrowed = borrowed;
						if (borrowed.length) {
							const g = await kstep(`${name}-fetch-newest-with-borrowed-codecs`, { partition: withData, from_offset: from, codecs: borrowed.map((x) => `${x} from @platformatic/kafka`) }, () => c.fetch(TOPIC, withData, from, { leader }), { keep });
							a.fetch_with_borrowed_codecs = g.ok ? 'decoded' : errInfo(g.error);
						}
					}
				}
				if (name === 'kafkajs') await kstep(`${name}-public-offsets-by-timestamp`, { api: 'admin.fetchTopicOffsetsByTimestamp', timestamp: 'now - 15 minutes' }, () => c.publicOffsetsByTimestamp(TOPIC, Date.now() - 900_000));
			});
		}

		// ---- The pipeline runs; live reads from the end
		if (pipeline) {
			await section('pipeline-wait-running', async () => {
				const w = await waitFor('pipeline-wait-running', (r, p) => r.status === 200 && ['STATE_RUNNING', 'STATE_ERROR', 'STATE_COMPLETED'].includes(p?.state), START_TIMEOUT_MS);
				run.pipeline_state = w.state;
				if (w.state === 'STATE_RUNNING') runningAt = Date.now();
			});
		}

		const pid = pipeline?.id;
		// Both clients read live in the same window, so they see the same records (run 1 read them one after
		// the other and the test pipeline wrote its records in one burst).
		await Promise.all(clients.map(async (name) => {
			const c = open[name];
			if (!c || !partitions || !pid) return;
			await section(`${name}-live`, async () => {
				const n = partitions.length;
				const kp = defaultPartition(Buffer.from(pid), n);
				const leader = partitions.find((p) => p.partition === kp)?.leader;
				const t0 = Date.now();
				const end = await c.offsets(TOPIC, [kp], -1);
				let offset = end[kp];
				let first = null;
				const latencies = [];
				const got = [];
				let fetches = 0;
				while (Date.now() - t0 < liveMs && (got.length < 6 || Date.now() - t0 < 15_000)) {
					const r = await withTimeout(c.fetch(TOPIC, kp, offset, { maxWaitMs: 2000, leader }), KAFKA_MS, 'live fetch');
					fetches++;
					const now = Date.now();
					for (const rec of r.records) {
						offset = Math.max(offset, rec.offset + 1);
						if (!isOwn(rec, pid)) continue;
						first ??= now - t0;
						latencies.push(now - rec.timestamp);
						if (got.length < 6) got.push(ownRecord(rec, R));
					}
					if (!r.records.length && fetches > 400) break;
					if (pollMs === 0 && fetches > 60) break;
				}
				const result = { key_partition_murmur2: kp, partitions: n, start_offset: end[kp], fetches, own_records: latencies.length, first_own_record_after_ms: first, receive_minus_record_timestamp_ms: stats(latencies), examples: got };
				record(`${name}-live-from-end`, { request: { partition: kp, from: 'latest', max_wait_ms: 2000, for_ms: liveMs }, result }, Date.now() - t0);
				answers[name].live = { own_records: latencies.length, first_after_ms: first, latency: stats(latencies) };
				print(`${`${name}-live-from-end`.padEnd(44)} ${latencies.length} own records, first after ${first} ms`);
			});
		}));

		// ---- Let the pipeline write a while, then read history
		if (runningAt) {
			const wait = runMs - (Date.now() - runningAt);
			if (wait > 0) { print(`waiting ${Math.round(wait / 1000)} s for the pipeline's records`); await sleep(wait); }
		}
		for (const name of clients) {
			const c = open[name];
			if (!c || !partitions) continue;
			await section(`${name}-history`, async () => {
				const n = partitions.length;
				const parts = partitions.map((p) => p.partition);
				const leaderOf = (p) => partitions.find((x) => x.partition === p)?.leader;
				const now = Date.now();
				const ts15 = now - 900_000;
				// Every partition from now - 15 minutes: shape and placement
				const t0 = Date.now();
				const from = await c.offsets(TOPIC, parts, ts15);
				const latest = await c.offsets(TOPIC, parts, -1);
				const all = [];
				const perPartition = {};
				for (const p of parts) {
					let off = from[p] != null && from[p] >= 0 ? from[p] : latest[p];
					let got = 0, fetches = 0;
					while (off < latest[p] && got < SAMPLE_MAX_RECORDS && fetches < SAMPLE_MAX_FETCHES) {
						const r = await withTimeout(c.fetch(TOPIC, p, off, { maxWaitMs: 500, leader: leaderOf(p) }), KAFKA_MS, 'fetch');
						fetches++;
						if (!r.records.length) break;
						for (const rec of r.records) { if (got < SAMPLE_MAX_RECORDS) { all.push(rec); got++; } off = rec.offset + 1; }
					}
					perPartition[p] = { from_offset: from[p], latest: latest[p], read: got, fetches };
				}
				const agg = aggregate(all, pid, n);
				const ownRecs = pid ? all.filter((r) => isOwn(r, pid)) : [];
				record(`${name}-read-last-15-min`, { request: { partitions: parts, from: 'ListOffsets(now - 15 min)', max_records_per_partition: SAMPLE_MAX_RECORDS }, result: { per_partition: perPartition, aggregate: agg, own_records_found: ownRecs.length, own_records_by_partition: ownRecs.reduce((m, r) => ({ ...m, [r.partition]: (m[r.partition] ?? 0) + 1 }), {}), own_examples: ownRecs.slice(0, 12).map((r) => ownRecord(r, R)) } }, Date.now() - t0);
				answers[name].sample = { records: agg.records, placement: agg.placement, fields: Object.keys(agg.fields) };

				// Seeks by time on the key's partition, read forward
				if (pid) {
					const kp = defaultPartition(Buffer.from(pid), n);
					const seeks = {};
					// The log's first offset: a seek before every kept record lands on it, and has no record before it.
					const logStart = (await c.offsets(TOPIC, [kp], 0))[kp];
					// now-24h and now-7d reach past the brokers' 6 h local retention, into tiered storage.
					for (const [label, ts] of [['now-15m', ts15], ['now-24h', now - 86_400_000], ['now-7d', now - 7 * 86_400_000], ['before-oldest', 0]]) {
						const t1 = Date.now();
						const all2 = await c.offsets(TOPIC, parts, ts);
						const off = all2[kp];
						const s = { requested_timestamp: new Date(ts).toISOString(), offset_on_key_partition: off, offsets_all_partitions: all2, latest_on_key_partition: latest[kp] };
						if (off != null && off >= 0 && off < latest[kp]) {
							const r = await c.fetch(TOPIC, kp, off, { maxWaitMs: 500, leader: leaderOf(kp) });
							const firstRec = r.records[0];
							s.first_record = firstRec ? { offset: firstRec.offset, timestamp: new Date(firstRec.timestamp).toISOString(), at_or_after_requested: firstRec.timestamp >= ts, own: isOwn(firstRec, pid) } : null;
							s.read_forward = { records: r.records.length, own: r.records.filter((x) => isOwn(x, pid)).length, log_start_offset: r.logStartOffset, high_watermark: r.highWatermark };
							if (ts > 0 && off - 1 >= logStart) {
								const prev = await c.fetch(TOPIC, kp, off - 1, { maxWaitMs: 500, leader: leaderOf(kp), maxBytes: 65_536 });
								const pr = prev.records.find((x) => x.offset === off - 1);
								s.previous_record_before_requested = pr ? pr.timestamp < ts : null;
							}
						}
						record(`${name}-seek-${label}`, { request: { partition: kp, timestamp: ts }, result: s }, Date.now() - t1);
						seeks[label] = { offset: off, first_at_or_after: s.first_record?.at_or_after_requested ?? null, previous_before: s.previous_record_before_requested ?? null };
					}
					answers[name].seeks = seeks;
				}
			});
		}
	} finally {
		for (const c of Object.values(open)) await c.close().catch(() => {});
		// ---- cleanup: the pipeline this run created, also when a step failed
		if (token && dp) {
			await section('cleanup', async () => {
				if (pipeline && !pipeline.gone) await deletePipeline('cleanup');
				// A create whose reply was lost may still have made it: find it by name.
				const l = await http('cleanup-check-pipelines', { url: `${dp}${PIPES}?page_size=100&filter.name_contains=${NAME_PREFIX}` });
				const left = [], earlier = [];
				for (const p of l.json?.pipelines ?? []) {
					if (!String(p.display_name ?? '').startsWith(NAME_PREFIX)) continue;
					if (p.display_name === pipelineName) {
						if (!pipeline || pipeline.id !== p.id) {
							pipeline = { id: p.id, gone: false };
							R.id(p.id, '<pipeline-id>');
						}
						if (!pipeline.gone) await deletePipeline('cleanup-untracked');
						if (!pipeline.gone) left.push(`pipeline ${p.display_name}`);
					} else earlier.push(`pipeline ${p.display_name} (${p.state})`);
				}
				if (!ok(l)) left.push(`could not list pipelines (HTTP ${l.status})`);
				l.cap.response.body = { pipelines_named_vscode_spike_logs: (l.json?.pipelines ?? []).length };
				run.leftovers_this_run = left.map((x) => R.text(x));
				run.leftovers_earlier_runs = earlier.map((x) => R.text(x));
				print(`cleanup: ${left.length ? `LEFT BEHIND: ${left.join(', ')}` : 'nothing left from this run'}`);
				if (earlier.length) print(`cleanup: earlier runs left (not touched): ${earlier.join(', ')}`);
			});
		}
		run.answers = answers;
		run.native_modules_loaded = fetchImpl.isReal ? nativeLoaded() : [];
		run.errors = errors;
		writeCaptures(outDir, caps, run, R);
	}
	return { run, tag, badPassword, pipelineId: pipeline?.id, R };
}

/** Pipelines the probe did not create are kept as their shape only. */
function foreign(body) {
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
		const red = R.value(c.response?.body !== undefined ? { ...c, response: { ...c.response, body: foreign(c.response.body) } } : c);
		fs.writeFileSync(path.join(outDir, `${n}-${c.step}.json`), `${JSON.stringify(red, null, 2)}\n`);
		const outcome = red.response ? (red.response.status ?? 'network error') : (red.error ? `error: ${red.error.kafka_error ?? red.error.name ?? ''}` : 'ok');
		rows.push([n, red.step, outcome, c.ms ?? ''].join('\t'));
	});
	fs.writeFileSync(path.join(outDir, 'summary.tsv'), `${rows.join('\n')}\n`);
	fs.writeFileSync(path.join(outDir, 'run.json'), `${JSON.stringify(R.value(run), null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------
// Dry run: a fake Cloud, a fake broker for the raw requests, fake clients; then checks on the output

function makeFake({ loseCreate, refuseConfigs, snappy } = {}) {
	const F = {
		clientId: 'fakeClientIdAAAA1111',
		clientSecret: 'fakeClientSecretBBBB2222',
		username: 'fake-logs-reader-user',
		password: 'fakeLogsPassword-CCCC3333',
		org: 'org0fake0c0ffee0',
		cl: 'clfake0vilnius00abcd',
		foreignPid: 'd0foreignpipe0000xyz',
		foreignInstance: 'inst-foreign-7777',
		foreignText: 'FOREIGN-LOG-TEXT-card-4111-1111',
		foreignCluster: 'other-cluster-name',
		ownInstance: 'inst-own-5555',
	};
	F.dp = `api-a1b2c3.${F.cl}.byoc.prd.cloud.redpanda.com`;
	F.seed = `seed-9f8e7d.${F.cl}.byoc.prd.cloud.redpanda.com`;
	F.broker0 = `broker-0-a1b2c3.${F.cl}.byoc.prd.cloud.redpanda.com`;
	F.broker1 = 'ip-10-0-3-17.eu-central-1.compute.internal';
	const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
	const now = Math.floor(Date.now() / 1000);
	F.jwt = `${enc({ alg: 'RS256' })}.${enc({ 'https://cloud.redpanda.com/organization_id': F.org, iat: now, exp: now + 86400 })}.ZmFrZXNpZw`;

	const pipelines = new Map([['pfakeforeign01', { id: 'pfakeforeign01', display_name: 'orders-etl', state: 'STATE_RUNNING' }], ['pfakeoldlogs1', { id: 'pfakeoldlogs1', display_name: 'vscode-spike-logs-old00000', state: 'STATE_STOPPED' }]]);
	const pending = new Map();
	let nextId = 1;
	const res = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	const cluster = { id: F.cl, name: 'rpc-vilnius', type: 'TYPE_DEDICATED', state: 'STATE_READY', cloud_provider: 'CLOUD_PROVIDER_AWS', region: 'eu-central-1', dataplane_api: { url: `https://${F.dp}` }, kafka_api: { seed_brokers: [`${F.seed}:9092`], mtls: { enabled: false, ca_certificates_pem: ['-----BEGIN CERTIFICATE-----x'] } }, nat_gateways: [{ ip: '203.0.113.9' }] };

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
			if (u.pathname === '/v1/clusters') return res(200, { clusters: [cluster, { id: 'clfake0other0000wxyz', name: F.foreignCluster }], next_page_token: '' });
			if (u.pathname === `/v1/clusters/${F.cl}`) return res(200, { cluster });
			return res(404, { code: 'NOT_FOUND' });
		}
		if (u.host !== F.dp) throw new Error(`fake: unknown host ${u.host}`);
		const p = u.pathname;
		if (p === PIPES && method === 'GET') return res(200, { pipelines: [...pipelines.values()].filter((x) => x.display_name.includes(u.searchParams.get('filter.name_contains') ?? '')), next_page_token: '' });
		if (p === PIPES && method === 'POST') {
			const id = `pfakenew${String(nextId++).padStart(4, '0')}`;
			pipelines.set(id, { id, ...body, state: 'STATE_STARTING' });
			pending.set(id, ['STATE_RUNNING']);
			F.ownPid = id;
			if (loseCreate) return res(504, { code: 'DEADLINE_EXCEEDED' });
			return res(200, { pipeline: pipelines.get(id) });
		}
		const m = /^\/v1\/redpanda-connect\/pipelines\/([^/]+)$/.exec(p);
		if (m) {
			const pl = pipelines.get(m[1]);
			if (!pl) return res(404, { code: 'NOT_FOUND' });
			if (method === 'DELETE') { pending.set(pl.id, ['GONE']); return res(200, {}); }
			const q = pending.get(pl.id) ?? [];
			if (q.length) { const s = q.shift(); if (s === 'GONE') { pipelines.delete(pl.id); return res(404, { code: 'NOT_FOUND' }); } pl.state = s; }
			return res(200, { pipeline: pl });
		}
		return res(404, { code: 'NOT_FOUND' });
	}

	// A fake topic: 4 partitions, the foreign pipeline's records and (once created) the probe's own.
	const N = 4;
	const parts = Array.from({ length: N }, () => []);
	const t0 = Date.now() - 2 * 86_400_000;
	const add = (pid, instance, level, message, ts) => {
		const p = defaultPartition(Buffer.from(pid), N);
		parts[p].push({ partition: p, offset: parts[p].length, timestamp: ts, key: Buffer.from(pid), value: Buffer.from(JSON.stringify({ benthos_version: '4.115.0', instance_id: instance, level, message, path: 'root.pipeline.processors.0', pipeline_id: pid, time: new Date(ts - 3).toISOString(), host_pod: `rpcn-${pid}-pod` })), headers: [['trace', Buffer.from(`${F.broker0}`)]] });
	};
	// 300 records over two days, then 100 in the last 8 minutes.
	for (let i = 0; i < 400; i++) add(F.foreignPid, F.foreignInstance, i % 7 ? 'INFO' : 'ERROR', `${F.foreignText} ${i}`, i < 300 ? t0 + i * 500_000 : Date.now() - (400 - i) * 5000);
	let ownSeq = 0;
	const tick = () => { if (F.ownPid && pipelines.get(F.ownPid)?.state === 'STATE_RUNNING') { const ts = Date.now(); add(F.ownPid, F.ownInstance, 'INFO', `vscode-spike-logs info ${ownSeq}`, ts); add(F.ownPid, F.ownInstance, 'WARN', `vscode-spike-logs warn ${ownSeq++}`, ts); } };
	const offsetFor = (p, ts) => {
		if (ts === -2) return 0;
		if (ts === -1) return parts[p].length;
		const i = parts[p].findIndex((r) => r.timestamp >= ts);
		return i < 0 ? -1 : i;
	};

	function fakeClient(name, { sasl }) {
		const authFail = () => { const e = new Error(`SASL SCRAM authentication failed for user ${sasl.username} at ${F.broker0}:9092`); e.name = 'KafkaJSSASLAuthenticationError'; e.code = 58; return e; };
		const signedIn = () => sasl.password === F.password && sasl.mechanism === 'SCRAM-SHA-256';
		let codecs = !(snappy && name === 'kafkajs');
		return {
			name,
			borrowCodecs() { codecs = true; return ['Snappy', 'LZ4', 'ZSTD']; },
			async connect() { if (!signedIn()) throw authFail(); },
			async metadata(topic) { if (!signedIn()) throw authFail(); return { topicError: null, partitions: parts.map((_, i) => ({ partition: i, leader: i % 2 })), brokers: [{ nodeId: 0, host: F.broker0, port: 9092 }, { nodeId: 1, host: F.broker1, port: 9092 }], topic }; },
			async allTopicsCount() { return { topics: 1, includes_logs_topic: true }; },
			async topicConfigs() {
				if (refuseConfigs) { const e = new Error(`Not authorized to access topics: [${TOPIC}] on ${F.broker1}`); e.code = 29; e.type = 'TOPIC_AUTHORIZATION_FAILED'; throw e; }
				return [{ name: 'retention.ms', value: '604800000' }, { name: 'cleanup.policy', value: 'delete' }];
			},
			async publicOffsetsByTimestamp() { return parts.map((_, p) => ({ partition: p, offset: String(offsetFor(p, Date.now() - 900_000)) })); },
			async offsets(topic, ps, ts) { tick(); return Object.fromEntries(ps.map((p) => [p, offsetFor(p, ts)])); },
			async fetch(topic, p, offset, { maxBytes = FETCH_MAX_BYTES } = {}) {
				tick();
				if (!codecs) { const e = new Error('Snappy compression not implemented'); e.name = 'KafkaJSNotImplemented'; throw e; }
				const records = parts[p].slice(offset, offset + Math.max(1, Math.floor(maxBytes / 2000)));
				return { records, highWatermark: parts[p].length, logStartOffset: 0 };
			},
			async close() {},
		};
	}
	const libs = Object.fromEntries(Object.keys(CANDIDATES).map((n) => [n, { fake: true }]));
	return { F, fetchImpl, pipelines, fakeClient, libs };
}

/** A local broker that answers ApiVersions and SaslHandshake, over plain TCP. */
function fakeBroker() {
	const server = net.createServer((s) => {
		let buf = Buffer.alloc(0);
		s.on('data', (d) => {
			buf = Buffer.concat([buf, d]);
			while (buf.length >= 4 && buf.length >= 4 + buf.readInt32BE(0)) {
				const size = buf.readInt32BE(0);
				const req = buf.subarray(4, 4 + size);
				buf = buf.subarray(4 + size);
				const apiKey = req.readInt16BE(0), corr = req.readInt32BE(4);
				let body;
				if (apiKey === 18) {
					const apis = [[1, 4, 13], [2, 0, 8], [3, 0, 12], [17, 0, 1], [18, 0, 3], [32, 0, 4], [36, 0, 2]];
					body = Buffer.alloc(6 + apis.length * 6);
					body.writeInt16BE(0, 0); body.writeInt32BE(apis.length, 2);
					apis.forEach(([k, a, b], i) => { body.writeInt16BE(k, 6 + i * 6); body.writeInt16BE(a, 8 + i * 6); body.writeInt16BE(b, 10 + i * 6); });
				} else {
					const ms = ['SCRAM-SHA-256', 'SCRAM-SHA-512'].map((x) => stringBody(x));
					const h = Buffer.alloc(6); h.writeInt16BE(33, 0); h.writeInt32BE(ms.length, 2);
					body = Buffer.concat([h, ...ms]);
				}
				const out = Buffer.alloc(8); out.writeInt32BE(body.length + 4, 0); out.writeInt32BE(corr, 4);
				s.write(Buffer.concat([out, body]));
			}
		});
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
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
	check(refuses(() => readLogsUser(f('open.env', 'redpanda_user=u\nrepanda_user_pwd=pw-secret-1\nauth_mechanism=SCRAM-SHA-256\n', 0o644)), /mode 644/, 'pw-secret-1'), 'a 0644 logs user file is refused, and the message holds no value');
	check(refuses(() => readLogsUser(f('group.env', 'redpanda_user=u\nrepanda_user_pwd=pw\nauth_mechanism=SCRAM-SHA-256\n', 0o640)), /mode 640/), 'a 0640 logs user file is refused');
	const own = readLogsUser(f('own.env', '# the user\'s keys\nredpanda_user=reader\nrepanda_user_pwd="p@ss w=rd"\nauth_mechanism=scram-sha-256\n'));
	check(own.username === 'reader' && own.password === 'p@ss w=rd' && own.mechanism === 'SCRAM-SHA-256', 'the user\'s keys (redpanda_user, repanda_user_pwd, auth_mechanism) are read, quotes stripped, the mechanism upper-cased');
	const plan = readLogsUser(f('plan.env', 'username=reader2\npassword=pw2\nmechanism=SCRAM-SHA-512\n'));
	check(plan.username === 'reader2' && plan.password === 'pw2' && plan.mechanism === 'SCRAM-SHA-512', 'the plan\'s keys (username, password, mechanism) are read');
	check(refuses(() => readLogsUser(f('plain.env', 'username=u\npassword=pw\nmechanism=PLAIN\n')), /SCRAM-SHA-256 or SCRAM-SHA-512/), 'a mechanism other than SCRAM is refused');
	check(refuses(() => readLogsUser(f('nopw.env', 'username=u\nmechanism=SCRAM-SHA-256\n')), /needs redpanda_user/), 'a logs user file without a password is refused');
	fs.symlinkSync(path.join(dir, 'own.env'), path.join(dir, 'link.env'));
	check(refuses(() => readLogsUser(path.join(dir, 'link.env')), /symlinks are refused/), 'a symlinked logs user file is refused');
	check(refuses(() => readCloudCredentials(f('cloud-open.env', 'client_id=a\nclient_secret=b\n', 0o644)), /mode 644/), 'a 0644 credentials file is refused');
	check(refuses(() => readCloudCredentials(f('cloud-partial.env', 'client_id=a\n')), /needs client_id/), 'a credentials file without client_secret is refused');
	check(refuses(() => readLogsUser(path.join(dir, 'missing.env')), /not found/), 'a missing logs user file is refused');

	console.log('== redaction and the partitioner');
	{
		const R = new Redactor();
		R.secret('reader-user'); R.secret('pw-ABCDEF');
		R.id('clxyz0000000000000ab', '<cluster-id>');
		R.host('seed-1a2b.clxyz0000000000000ab.fmc.prd.cloud.redpanda.com');
		const sample = { msg: 'SASL failed for reader-user with pw-ABCDEF at seed-1a2b.clxyz0000000000000ab.fmc.prd.cloud.redpanda.com:9092 and broker-3.clxyz0000000000000ab.fmc.prd.cloud.redpanda.com', other: 'redpanda-0.abcd1234.byoc.prd.cloud.redpanda.com 10.1.2.3', instance_id: 'i-123', public: 'https://api.redpanda.com/v1 auth.prd.cloud.redpanda.com', username: 'x', password: 'y' };
		const out = JSON.stringify(R.value(sample));
		check(!/reader-user|pw-ABCDEF|clxyz|1a2b|broker-3|abcd1234|10\.1\.2\.3|i-123|"x"|"y"/.test(out) && /api\.redpanda\.com/.test(out) && /auth\.prd\.cloud\.redpanda\.com/.test(out), `sample is clean and keeps public hosts: ${out}`);
		const kjsMurmur = path.join(CACHE, 'node_modules/kafkajs/src/producer/partitioners/default/murmur2.js');
		if (fs.existsSync(kjsMurmur)) {
			const ref = createRequire(import.meta.url)(kjsMurmur);
			const keys = ['', 'a', 'ab', 'abc', 'abcd', 'd0foreignpipe0000xyz', 'ctest0000000000000z1', 'üñî', 'x'.repeat(37)];
			check(keys.every((k) => (ref(k) & 0x7fffffff) === (murmur2(Buffer.from(k)) & 0x7fffffff)), 'murmur2 matches kafkajs\'s Java-compatible murmur2 on 9 keys');
		} else console.log('SKIP  murmur2 cross-check (kafkajs not installed in .cache/logs-probe)');
	}

	console.log('== raw Kafka requests against a local fake broker');
	const fb = await fakeBroker();
	try {
		const r = await rawKafka({ host: '127.0.0.1', port: fb.port, useTls: false });
		check(r.api_versions.apis.some((a) => a.name === 'Fetch' && a.max === 13), 'ApiVersions is framed and parsed');
		check(JSON.stringify(r.sasl_handshake.response.enabled_mechanisms) === '["SCRAM-SHA-256","SCRAM-SHA-512"]' && r.sasl_handshake.response.error === 'UNSUPPORTED_SASL_MECHANISM', 'SaslHandshake answers the enabled mechanisms');
	} finally { fb.server.close(); }

	const cases = [['normal', {}], ['configs-refused-snappy', { refuseConfigs: true, snappy: true }], ['failure-mid-flow', { failAt: 'kafkajs-live-from-end' }], ['lost-create', { loseCreate: true }]];
	for (const [label, opt] of cases) {
		console.log(`== dry run: ${label}`);
		const fake = makeFake(opt);
		const fb2 = await fakeBroker();
		const outDir = path.join(CACHE, 'dry-run', label);
		let res;
		try {
			res = await probe({
				fetchImpl: fake.fetchImpl,
				cloudCreds: { clientId: fake.F.clientId, clientSecret: fake.F.clientSecret },
				logsUser: { username: fake.F.username, password: fake.F.password, mechanism: 'SCRAM-SHA-256' },
				outDir, pollMs: 0, runMs: 0, liveMs: 2000, failAt: opt.failAt,
				clientFactory: (name, lib, opts) => fake.fakeClient(name, opts),
				rawKafkaImpl: (a) => rawKafka({ ...a, host: '127.0.0.1', port: fb2.port, useTls: false }),
				loadClient: async (name) => ({ lib: fake.libs[name], info: { package: CANDIDATES[name].pkg, fake: true } }),
				clients: ['kafkajs', 'platformatic'],
				tlsOptions: null,
			});
		} finally { fb2.server.close(); }
		// The fake clients stand in for the libraries.
		const files = scanDir(outDir);
		const all = files.map(([, t]) => t).join('\n');
		const sensitive = { clientId: fake.F.clientId, clientSecret: fake.F.clientSecret, username: fake.F.username, password: fake.F.password, badPassword: res.badPassword, jwt: fake.F.jwt.split('.')[1], org: fake.F.org, cluster: fake.F.cl, seedHost: 'seed-9f8e7d', broker0: 'broker-0-a1b2c3', broker1: 'ip-10-0-3-17', dpHost: 'a1b2c3', foreignPid: fake.F.foreignPid, foreignInstance: fake.F.foreignInstance, foreignText: 'FOREIGN-LOG-TEXT', foreignCluster: fake.F.foreignCluster, natIp: '203.0.113.9', ownInstance: fake.F.ownInstance, pemBody: 'BEGIN CERTIFICATE', tag: res.tag };
		if (fake.F.ownPid) sensitive.ownPid = fake.F.ownPid;
		for (const [k, v] of Object.entries(sensitive)) check(!all.includes(v), `${label}: no ${k} in the captures`);
		check(!/pod/.test(all.replace(/"host_pod"/g, '')), `${label}: an unknown field of the probe's own records keeps only its length`);
		check(!fake.pipelines.has(fake.F.ownPid ?? 'none') && fake.pipelines.has('pfakeforeign01') && fake.pipelines.has('pfakeoldlogs1'), `${label}: the fake cluster holds nothing this run created, and nothing else was touched`);
		check((res.run.leftovers_this_run ?? ['missing']).length === 0, `${label}: cleanup reports nothing left from this run`);
		check((res.run.leftovers_earlier_runs ?? []).length === 1, `${label}: an earlier run's pipeline is reported, not deleted`);
		const authCap = files.find(([n]) => n.includes('kafkajs-auth-wrong-password'));
		check(authCap && /SASL_AUTHENTICATION_FAILED/.test(authCap[1]) && /<redacted>/.test(authCap[1]), `${label}: a wrong password is recorded as SASL_AUTHENTICATION_FAILED, the user redacted`);
		if (label === 'normal') {
			check(res.run.errors.length === 0, `${label}: no section failed (${JSON.stringify(res.run.errors)})`);
			const live = files.find(([n]) => n.includes('kafkajs-live-from-end'));
			check(live && /"own_records": [1-9]/.test(live[1]) && /<pipeline-id>/.test(live[1]) && /vscode-spike-logs info/.test(live[1]), `${label}: the live read returns the probe's own records, the pipeline id a placeholder`);
			const sample = files.find(([n]) => n.includes('platformatic-read-last-15-min'));
			check(sample && /"keys_on_their_murmur2_partition": 2/.test(sample[1]) && /"benthos_version"/.test(sample[1]), `${label}: the 15-minute read aggregates the records (fields, placement)`);
			check(files.some(([n, t]) => n.includes('seek-now-7d') && /"at_or_after_requested": true/.test(t)), `${label}: a seek by time reads forward from the requested time`);
			check(JSON.stringify(res.run.sasl_mechanisms_offered) === '["SCRAM-SHA-256","SCRAM-SHA-512"]', `${label}: run.json names the offered mechanisms`);
		}
		if (label === 'configs-refused-snappy') {
			check(files.some(([n, t]) => n.includes('describe-configs') && /TOPIC_AUTHORIZATION_FAILED/.test(t)), `${label}: a refused DescribeConfigs is recorded with its Kafka error`);
			check(files.some(([n, t]) => n.includes('kafkajs-fetch-newest.json') && /Snappy compression not implemented/.test(t)) && files.some(([n, t]) => n.includes('kafkajs-fetch-newest-with-borrowed-codecs') && /"records": [1-9]/.test(t)), `${label}: kafkajs without a Snappy codec is recorded, then read with borrowed codecs`);
			check(files.some(([n, t]) => n.includes('kafkajs-live-from-end') && /"own_records": [1-9]/.test(t)), `${label}: kafkajs reads live after borrowing the codecs`);
		}
		if (label === 'failure-mid-flow') check(res.run.errors.some((e) => e.error.includes('injected failure')), `${label}: the injected failure is recorded`);
		if (label === 'lost-create') check(files.some(([n]) => n.includes('cleanup-untracked-pipeline-delete')), `${label}: the pipeline whose create reply was lost is found by its name and deleted`);
	}
	console.log(failures.length ? `\ndry run: ${failures.length} check(s) FAILED` : '\ndry run: all checks passed');
	process.exit(failures.length ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------

async function main() {
	const args = process.argv.slice(2);
	if (args.includes('--dry-run')) return dryRun();
	if (args.length) { console.error(`logs-probe: unknown argument(s): ${args.join(' ')}`); process.exit(2); }
	let cloudCreds, logsUser;
	try { cloudCreds = readCloudCredentials(CRED_FILE); logsUser = readLogsUser(LOGS_FILE); } catch (e) { console.error(`logs-probe: ${e.message}`); process.exit(1); }
	for (const c of CLIENTS) if (!CANDIDATES[c]) { console.error(`logs-probe: unknown client ${c}`); process.exit(2); }
	console.log('installing the candidate clients into .cache/logs-probe/ (if missing)');
	installClients(CACHE);
	const fetchImpl = (url, init) => fetch(url, init);
	fetchImpl.isReal = true;
	const loadClient = async (name) => {
		const b = await bundleClient(name, CACHE);
		b.info.npm = npmView(CANDIDATES[name].pkg);
		return b;
	};
	const res = await probe({ fetchImpl, cloudCreds, logsUser, outDir: CAPS, pollMs: POLL_MS, runMs: RUN_MS, liveMs: LIVE_MS, failAt: null, rawKafkaImpl: rawKafka, loadClient, clients: CLIENTS, tlsOptions: {} });
	console.log(`captures: ${path.relative(ROOT, CAPS)}`);
	const left = res.run.leftovers_this_run;
	if (!left || left.length || res.run.errors.length) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((e) => { console.error(`logs-probe: ${String(e?.message ?? e).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<redacted-jwt>')}`); process.exit(1); });
}

export { probe, makeFake, kafkajsClient, platformaticClient, bundleClient, rawKafka, aggregate, defaultPartition, CANDIDATES };
