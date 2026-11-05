// A local fake of the three Redpanda Cloud hosts (ticket 5.2), modelled on spike 5.1's captures
// (`epic-deploy-to-redpanda-cloud/spike-5-1-findings/captures/`): one HTTP server on 127.0.0.1 answering
//   - the token endpoint `POST /oauth/token` (01; a wrong ID or secret: 401 `{error, error_description}`, 02),
//   - the Control Plane `GET /v1/clusters` (04, paged by `pageSize`) and `GET /v1/clusters/{id}` (07),
//   - each cluster's Data Plane at `/dp/{cluster id}` (its own address as `dataplane_api.url`):
//     `GET|POST /v1/redpanda-connect/pipelines` (09; a create the lint rejects: 400 with `LintHint`s, 26;
//     else 200 in `STATE_STARTING`, 29), `GET …/pipelines/{id}`, which walks the pipeline's state
//     sequence one step per call (30, 31: `STATE_ERROR` with or without a `status`), and
//     `PUT …/pipelines/{id}` (ticket 5.3), which replaces it (45–48: a missing description or tags is
//     cleared, a missing config 400; the new config linted as on create) and restarts a running or
//     starting one (55–57: `RUNNING` right after the `PUT`, then `STARTING`, then `RUNNING`), and
//     (ticket 5.4) `PUT …/pipelines/{id}/stop` (41, 42: `STOPPING`, then `STOPPED`), `PUT …/{id}/start`
//     (53, 54: `STARTING`, then `RUNNING`) and `DELETE …/pipelines/{id}` (59, 60: 200 `{}`, then 404).
//   - (ticket 5.7) each cluster's secrets, `GET /dp/{id}/v1/secrets` (10; paged by `secretsPageSize`,
//     ids only) and `POST /dp/{id}/v1/secrets` (19, 20: 201 `{secret}`, 409 for an id it has; the
//     decoded value kept in `secrets` for the tests, never answered). The create's lint also rejects a
//     config whose `${secrets.NAME}` without a default names a secret the cluster lacks (65).
//   - (ticket 8) each cluster's components, `GET /dp/{id}/v1/redpanda-connect/components` (18): by default
//     every component, Bloblang function and method of the pinned 4.112.0 recording (`list --format
//     json-full`, with its config trees), `version` the cluster's Connect version; `missingComponents`
//     leaves chosen names out, `componentsError` answers an error instead.
//   - (ticket 6.2) a cluster's `kafka_api.seed_brokers` in its `GET /v1/clusters/{id}` (spike 6.1, 03).
// `failures` answers a chosen request with an error instead (one call, or every matching call).
// A Bearer token other than the one it issued is refused (401, 08). Every request is recorded, for
// the no-leak checks.

import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import * as zlib from 'zlib';
import { SCHEMA_FIXTURES } from './fakeBinary';

export interface FakeRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: string;
}

/** An error answer for the requests `when` matches (`times`: how many; default 1). */
export interface FakeFailure {
	readonly when: (req: FakeRequest) => boolean;
	readonly status: number;
	readonly body: unknown;
	times?: number;
}

export interface FakeState {
	readonly state: string;
	/** `status.error`; none: the state comes with no `status` (the real API's intermittent ERROR, 31). */
	readonly error?: string;
}

export interface FakePipeline {
	id: string;
	display_name: string;
	description: string;
	config_yaml: string;
	resources: { cpu_shares: string; memory_shares: string };
	tags: Record<string, string>;
	state: string;
	status?: { error: string };
	/** The states its next GETs answer, one per call; the last one stays. */
	sequence: FakeState[];
}

export interface FakeCluster {
	readonly id: string;
	readonly name: string;
	readonly type: string;
	readonly cloudProvider: string;
	readonly region: string;
	readonly connectVersion?: string;
	/** Whether the cluster has a Data Plane address. Default true. */
	readonly dataplane?: boolean;
	/** Ticket 6.2: its `kafka_api.seed_brokers`; none: no `kafka_api`. */
	readonly seedBrokers?: readonly string[];
	pipelines: FakePipeline[];
	/** When set, the pipelines list answers this error. */
	pipelinesError?: { readonly status: number; readonly body: unknown };
	/** When set, `GET /v1/clusters/{id}` answers this error. */
	getError?: { readonly status: number; readonly body: unknown };
	/** Ticket 5.7: its secrets, id → the decoded value (the API never answers it). */
	secrets?: Map<string, string>;
	/** Ticket 8: names its components list leaves out, per list (`inputs: ['stdin']`, `bloblang_methods: ['uppercase']`). */
	missingComponents?: Readonly<Record<string, readonly string[]>>;
	/** Ticket 8: when set, the components list answers this error. */
	componentsError?: { readonly status: number; readonly body: unknown };
}

/** The `json-full` keys of the components answer's lists. */
const COMPONENT_LISTS: Readonly<Record<string, string>> = {
	inputs: 'inputs', outputs: 'outputs', processors: 'processors', caches: 'caches', 'rate-limits': 'rate_limits', buffers: 'buffers',
	metrics: 'metrics', tracers: 'tracers', scanners: 'scanners', 'bloblang-functions': 'bloblang_functions', 'bloblang-methods': 'bloblang_methods',
};

let recordedComponents: Record<string, { name: string; type?: string; status?: string; config?: unknown }[]> | undefined;

/** Every list of the 4.112.0 `json-full` recording, as the components answer names them (read once). */
function defaultComponents(): Record<string, { name: string; type?: string; status?: string; config?: unknown }[]> {
	if (!recordedComponents) {
		const full = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SCHEMA_FIXTURES, 'json-full-4.112.0.json.gz'))).toString('utf8')) as Record<string, unknown>;
		recordedComponents = {};
		for (const [from, to] of Object.entries(COMPONENT_LISTS)) {
			const list = Array.isArray(full[from]) ? full[from] as Record<string, unknown>[] : [];
			recordedComponents[to] = list.map((e) => ({
				name: String(e.name), ...(typeof e.type === 'string' ? { type: e.type } : {}),
				...(typeof e.status === 'string' ? { status: e.status } : {}), ...(e.config !== undefined ? { config: e.config } : {}),
			}));
		}
	}
	return recordedComponents;
}

export interface FakeCloudOptions {
	readonly clientId: string;
	readonly clientSecret: string;
	/** The token's `client_name` claim. */
	readonly clientName: string;
	readonly clusters: FakeCluster[];
}

/** The `LintHint` answer for a config holding `no_such_input` (26). */
export const FAKE_LINT_MARKER = 'no_such_input';

let tokenCounter = 0;

export class FakeCloud {
	readonly requests: FakeRequest[] = [];
	/** The tokens it issued. */
	readonly tokens: string[] = [];
	/** Tokens it no longer accepts (revoked mid-session). */
	readonly revoked = new Set<string>();
	/** When true, the APIs refuse every token, also new ones (a service account without access). */
	refuseTokens = false;
	/** The Control Plane's list page size. */
	pageSize = 100;
	/** When set, the Control Plane's cluster list answers this error. */
	clustersError: { readonly status: number; readonly body: unknown } | undefined;
	/** The state sequence a created pipeline walks through (its GETs, one step each). */
	createSequence: FakeState[] = [{ state: 'STATE_STARTING' }, { state: 'STATE_RUNNING' }];
	/** The states a running or starting pipeline walks through after an update (its GETs); the `PUT` answers the first. */
	restartSequence: FakeState[] = [{ state: 'STATE_RUNNING' }, { state: 'STATE_RUNNING' }, { state: 'STATE_STARTING' }, { state: 'STATE_RUNNING' }];
	/** The states a pipeline walks through after `PUT …/stop`; the `PUT` answers the first. */
	stopSequence: FakeState[] = [{ state: 'STATE_STOPPING' }, { state: 'STATE_STOPPED' }];
	/** The states a pipeline walks through after `PUT …/start`; the `PUT` answers the first. */
	startSequence: FakeState[] = [{ state: 'STATE_STARTING' }, { state: 'STATE_RUNNING' }];
	/** The secrets list's page size (ticket 5.7). */
	secretsPageSize = 100;
	/** Error answers for chosen requests, checked before every other route (after the token check). */
	failures: FakeFailure[] = [];
	private server: http.Server | undefined;
	private nextPipeline = 1;

	constructor(readonly options: FakeCloudOptions) {}

	get url(): string {
		const address = this.server?.address() as AddressInfo | null | undefined;
		if (!address) {
			throw new Error('the fake cloud is not started');
		}
		return `http://127.0.0.1:${address.port}`;
	}

	dataplaneUrl(clusterId: string): string {
		return `${this.url}/dp/${clusterId}`;
	}

	cluster(id: string): FakeCluster {
		const c = this.options.clusters.find((x) => x.id === id);
		if (!c) {
			throw new Error(`no fake cluster ${id}`);
		}
		return c;
	}

	/** Revokes every token issued so far: the APIs answer 401 for them. */
	revokeAll(): void {
		this.tokens.forEach((t) => this.revoked.add(t));
	}

	/** Requests to a path starting with `prefix` (`/oauth/token`, `/v1/clusters`, `/dp/<id>/…`). */
	requestsTo(prefix: string): FakeRequest[] {
		return this.requests.filter((r) => r.url.startsWith(prefix));
	}

	async start(): Promise<void> {
		this.server = http.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf8');
				const recorded: FakeRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
				this.requests.push(recorded);
				const [status, answer] = this.answer(recorded);
				res.writeHead(status, { 'content-type': 'application/json' });
				res.end(JSON.stringify(answer));
			});
		});
		await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (server) {
			server.closeAllConnections?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	private issueToken(): string {
		const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
		const token = [
			b64({ alg: 'RS256', typ: 'JWT' }),
			b64({ 'https://cloud.redpanda.com/client_name': this.options.clientName, sub: 'fake', n: ++tokenCounter }),
			`fake-signature-${tokenCounter}-${Math.random().toString(36).slice(2)}`,
		].join('.');
		this.tokens.push(token);
		return token;
	}

	private answer(req: FakeRequest): [number, unknown] {
		const url = new URL(req.url, 'http://fake');
		if (req.method === 'POST' && url.pathname === '/oauth/token') {
			const form = new URLSearchParams(req.body);
			if (form.get('grant_type') !== 'client_credentials' || form.get('audience') !== 'cloudv2-production.redpanda.cloud') {
				return [400, { error: 'invalid_request', error_description: 'bad grant' }];
			}
			if (form.get('client_id') !== this.options.clientId || form.get('client_secret') !== this.options.clientSecret) {
				return [401, { error: 'access_denied', error_description: 'Unauthorized' }];
			}
			return [200, { access_token: this.issueToken(), scope: 'read:organization-info', expires_in: 86400, token_type: 'Bearer' }];
		}
		const auth = req.headers.authorization ?? '';
		const presented = auth.slice('Bearer '.length);
		if (!auth.startsWith('Bearer ') || !this.tokens.includes(presented)) {
			return url.pathname.startsWith('/dp/')
				? [401, { code: 'UNAUTHENTICATED', message: 'bearer token is invalid', details: [] }]
				: [500, { code: 'UNKNOWN', message: 'failed to parse token', details: [] }];
		}
		if (this.refuseTokens || this.revoked.has(presented)) {
			// An expired or revoked JWT (well-formed): 401 on both APIs.
			return [401, { code: 'UNAUTHENTICATED', message: 'token is expired or revoked', details: [] }];
		}
		const failure = this.failures.find((f) => (f.times ?? 1) > 0 && f.when(req));
		if (failure) {
			failure.times = (failure.times ?? 1) - 1;
			return [failure.status, failure.body];
		}
		if (req.method === 'GET' && url.pathname === '/v1/clusters') {
			if (this.clustersError) {
				return [this.clustersError.status, this.clustersError.body];
			}
			const start = Number(url.searchParams.get('page_token') || '0');
			const page = this.options.clusters.slice(start, start + this.pageSize);
			const next = start + this.pageSize < this.options.clusters.length ? String(start + this.pageSize) : '';
			// The list carries no `dataplane_api` (run.json `has_dataplane_api: false`).
			return [200, {
				clusters: page.map((c) => ({ id: c.id, name: c.name, type: c.type, state: 'STATE_READY', cloud_provider: c.cloudProvider, region: c.region })),
				next_page_token: next,
			}];
		}
		const clusterGet = /^\/v1\/clusters\/([^/]+)$/.exec(url.pathname);
		if (req.method === 'GET' && clusterGet) {
			const c = this.options.clusters.find((x) => x.id === decodeURIComponent(clusterGet[1]));
			if (!c) {
				return [404, { code: 'NOT_FOUND', message: 'cluster not found', details: [] }];
			}
			if (c.getError) {
				return [c.getError.status, c.getError.body];
			}
			return [200, {
				cluster: {
					id: c.id, name: c.name, type: c.type, state: 'STATE_READY', cloud_provider: c.cloudProvider, region: c.region,
					...(c.dataplane === false ? {} : { dataplane_api: { url: this.dataplaneUrl(c.id) } }),
					...(c.connectVersion ? { redpanda_connect: { version: c.connectVersion } } : {}),
					...(c.seedBrokers ? { kafka_api: { seed_brokers: c.seedBrokers, sasl: { enabled: true }, mtls: { enabled: false } } } : {}),
				},
			}];
		}
		const components = /^\/dp\/([^/]+)\/v1\/redpanda-connect\/components$/.exec(url.pathname);
		if (components && req.method === 'GET') {
			const c = this.options.clusters.find((x) => x.id === components[1] && x.dataplane !== false);
			if (!c) {
				return [404, { code: 'NOT_FOUND', message: 'not found', details: [] }];
			}
			if (c.componentsError) {
				return [c.componentsError.status, c.componentsError.body];
			}
			const lists: Record<string, unknown> = {};
			for (const [key, list] of Object.entries(defaultComponents())) {
				const missing = new Set(c.missingComponents?.[key] ?? []);
				lists[key] = list.filter((e) => !missing.has(e.name));
			}
			return [200, { components: { version: c.connectVersion ?? '', ...lists } }];
		}
		const secrets = /^\/dp\/([^/]+)\/v1\/secrets$/.exec(url.pathname);
		if (secrets) {
			const c = this.options.clusters.find((x) => x.id === secrets[1] && x.dataplane !== false);
			if (!c) {
				return [404, { code: 'NOT_FOUND', message: 'not found', details: [] }];
			}
			return this.secretsRoute(c, req, url);
		}
		const dp = /^\/dp\/([^/]+)\/v1\/redpanda-connect\/pipelines(?:\/([^/]+)(?:\/(start|stop))?)?$/.exec(url.pathname);
		if (dp) {
			const c = this.options.clusters.find((x) => x.id === dp[1] && x.dataplane !== false);
			if (!c) {
				return [404, { code: 'NOT_FOUND', message: 'not found', details: [] }];
			}
			if (dp[3]) {
				return this.lifecycle(c, req, decodeURIComponent(dp[2]), dp[3] as 'start' | 'stop');
			}
			return this.pipelines(c, req, dp[2] ? decodeURIComponent(dp[2]) : undefined);
		}
		return [404, { code: 'NOT_FOUND', message: `no fake route ${req.method} ${url.pathname}`, details: [] }];
	}

	private shown(p: FakePipeline): unknown {
		const { sequence: _sequence, ...rest } = p;
		return rest;
	}

	/** `GET` (paged, ids only) and `POST` (201; 409 for an id it has) of `{dp}/v1/secrets`. */
	private secretsRoute(c: FakeCluster, req: FakeRequest, url: URL): [number, unknown] {
		c.secrets ??= new Map();
		if (req.method === 'GET') {
			const ids = [...c.secrets.keys()];
			const start = Number(url.searchParams.get('page_token') || '0');
			const next = start + this.secretsPageSize < ids.length ? String(start + this.secretsPageSize) : '';
			return [200, {
				secrets: ids.slice(start, start + this.secretsPageSize).map((id) => ({ id, labels: {}, scopes: ['SCOPE_REDPANDA_CONNECT'] })),
				next_page_token: next,
			}];
		}
		if (req.method === 'POST') {
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(req.body) as Record<string, unknown>;
			} catch {
				return [400, { code: 'INVALID_ARGUMENT', message: 'proto: syntax error', details: [] }];
			}
			const id = typeof body.id === 'string' ? body.id : '';
			if (!/^[A-Z][A-Z0-9_]*$/.test(id) || typeof body.secret_data !== 'string'
				|| !Array.isArray(body.scopes) || !body.scopes.includes('SCOPE_REDPANDA_CONNECT')) {
				return [400, { code: 'INVALID_ARGUMENT', message: 'invalid secret request', details: [] }];
			}
			if (c.secrets.has(id)) {
				return [409, { code: 'ALREADY_EXISTS', message: `secret ${id} already exists`, details: [] }];
			}
			c.secrets.set(id, Buffer.from(body.secret_data, 'base64').toString('utf8'));
			return [201, { secret: { id, labels: {}, scopes: ['SCOPE_REDPANDA_CONNECT'] } }];
		}
		return [405, { code: 'UNIMPLEMENTED', message: 'not in the fake', details: [] }];
	}

	/**
	 * The create's (and update's) lint: a 400 with `LintHint`s for a config holding the marker (26), or
	 * naming, without a default, a secret the cluster lacks (65).
	 */
	private lint(config: string, c: FakeCluster): [number, unknown] | undefined {
		const lines = config.split('\n');
		const missing = [...new Set([...config.matchAll(/\$\{secrets\.([A-Za-z0-9_]+)\}/g)].map((m) => m[1]))]
			.filter((name) => !(c.secrets?.has(name) ?? false));
		if (missing.length > 0) {
			return [400, {
				code: 'INVALID_ARGUMENT',
				message: 'invalid pipeline configuration',
				details: [{
					'@type': 'redpanda.api.common.v1.ExternalError',
					message: 'invalid pipeline configuration',
					details: [
						{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'REASON_CONNECT_INVALID_PIPELINE_CONFIGURATION', domain: 'redpanda.com/dataplane', metadata: {} },
						{ '@type': 'type.googleapis.com/redpanda.api.common.v1.LintHint', line: 1, column: 1,
							hint: `required secrets were not set: [${missing.map((n) => `secrets.${n}`).join(' ')}]`, lint_type: '' },
					],
				}],
			}];
		}
		const at = lines.findIndex((l) => l.includes(FAKE_LINT_MARKER));
		if (at < 0) {
			return undefined;
		}
		return [400, {
			code: 'INVALID_ARGUMENT',
			message: 'invalid pipeline configuration',
			details: [{
				'@type': 'redpanda.api.common.v1.ExternalError',
				message: 'invalid pipeline configuration',
				details: [
					{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'REASON_CONNECT_INVALID_PIPELINE_CONFIGURATION', domain: 'redpanda.com/dataplane', metadata: {} },
					{ '@type': 'type.googleapis.com/redpanda.api.common.v1.LintHint', line: at + 1, column: 3, hint: `unable to infer component type: ${FAKE_LINT_MARKER}`, lint_type: '' },
					{ '@type': 'type.googleapis.com/redpanda.api.common.v1.LintHint', line: lines.length, column: 1, hint: 'second fake hint', lint_type: '' },
				],
			}],
		}];
	}

	private pipelines(c: FakeCluster, req: FakeRequest, id: string | undefined): [number, unknown] {
		if (req.method === 'GET' && !id) {
			if (c.pipelinesError) {
				return [c.pipelinesError.status, c.pipelinesError.body];
			}
			return [200, { pipelines: c.pipelines.map((p) => this.shown(p)), next_page_token: '' }];
		}
		if (req.method === 'POST' && !id) {
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(req.body) as Record<string, unknown>;
			} catch {
				return [400, { code: 'INVALID_ARGUMENT', message: 'proto: syntax error', details: [] }];
			}
			if (body.tags !== undefined && (body.tags === null || typeof body.tags !== 'object' || Array.isArray(body.tags))) {
				return [400, { code: 'INVALID_ARGUMENT', message: 'proto: syntax error (line 1:1): unexpected token [', details: [] }];
			}
			const config = typeof body.config_yaml === 'string' ? body.config_yaml : '';
			const rejected = this.lint(config, c);
			if (rejected) {
				return rejected;
			}
			const resources = body.resources as { cpu_shares?: string; memory_shares?: string } | undefined;
			const pipeline: FakePipeline = {
				id: `fakepipe${String(this.nextPipeline++).padStart(12, '0')}`,
				display_name: typeof body.display_name === 'string' ? body.display_name : '',
				description: typeof body.description === 'string' ? body.description : '',
				config_yaml: config,
				resources: { cpu_shares: resources?.cpu_shares ?? '', memory_shares: resources?.memory_shares ?? '' },
				tags: (body.tags as Record<string, string> | undefined) ?? {},
				state: 'STATE_STARTING',
				sequence: [...this.createSequence],
			};
			c.pipelines.push(pipeline);
			return [200, { pipeline: this.shown(pipeline) }];
		}
		if (req.method === 'GET' && id) {
			const p = c.pipelines.find((x) => x.id === id);
			if (!p) {
				return [404, { code: 'NOT_FOUND', message: 'pipeline not found', details: [] }];
			}
			const next = p.sequence.length > 1 ? p.sequence.shift()! : p.sequence[0];
			if (next) {
				p.state = next.state;
				if (next.error) {
					p.status = { error: next.error };
				} else {
					delete p.status;
				}
			}
			return [200, { pipeline: this.shown(p) }];
		}
		if (req.method === 'PUT' && id) {
			const p = c.pipelines.find((x) => x.id === id);
			if (!p) {
				return [404, { code: 'NOT_FOUND', message: 'pipeline not found', details: [] }];
			}
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(req.body) as Record<string, unknown>;
			} catch {
				return [400, { code: 'INVALID_ARGUMENT', message: 'proto: syntax error', details: [] }];
			}
			if (typeof body.config_yaml !== 'string' || !body.config_yaml) {
				return [400, { code: 'INVALID_ARGUMENT', message: 'a pipeline needs a configuration before it can run', details: [] }];
			}
			if (body.tags !== undefined && (body.tags === null || typeof body.tags !== 'object' || Array.isArray(body.tags))) {
				return [400, { code: 'INVALID_ARGUMENT', message: 'proto: syntax error (line 1:1): unexpected token [', details: [] }];
			}
			const rejected = this.lint(body.config_yaml, c);
			if (rejected) {
				return rejected;
			}
			const resources = body.resources as { cpu_shares?: string; memory_shares?: string } | undefined;
			// Replace: what the body leaves out is cleared (47, 48).
			p.display_name = typeof body.display_name === 'string' ? body.display_name : '';
			p.description = typeof body.description === 'string' ? body.description : '';
			p.config_yaml = body.config_yaml;
			p.resources = { cpu_shares: resources?.cpu_shares ?? '', memory_shares: resources?.memory_shares ?? '' };
			p.tags = (body.tags as Record<string, string> | undefined) ?? {};
			if (p.state === 'STATE_RUNNING' || p.state === 'STATE_STARTING') {
				const [first, ...rest] = this.restartSequence;
				p.state = first?.state ?? p.state;
				p.sequence = rest.length > 0 ? rest : [{ state: p.state }];
			} else {
				p.sequence = [{ state: p.state, ...(p.status ? { error: p.status.error } : {}) }];
			}
			return [200, { pipeline: this.shown(p) }];
		}
		if (req.method === 'DELETE' && id) {
			const at = c.pipelines.findIndex((x) => x.id === id);
			if (at < 0) {
				return [404, { code: 'NOT_FOUND', message: `pipelines.connect.redpanda.com "${id}" not found`, details: [] }];
			}
			c.pipelines.splice(at, 1);
			return [200, {}];
		}
		return [405, { code: 'UNIMPLEMENTED', message: 'not in the fake', details: [] }];
	}

	/** `PUT …/{id}/start` and `…/stop`: the pipeline in the first state of the sequence, walking the rest on its GETs. */
	private lifecycle(c: FakeCluster, req: FakeRequest, id: string, action: 'start' | 'stop'): [number, unknown] {
		if (req.method !== 'PUT') {
			return [405, { code: 'UNIMPLEMENTED', message: 'not in the fake', details: [] }];
		}
		const p = c.pipelines.find((x) => x.id === id);
		if (!p) {
			return [404, { code: 'NOT_FOUND', message: `pipelines.connect.redpanda.com "${id}" not found`, details: [] }];
		}
		const [first, ...rest] = action === 'start' ? this.startSequence : this.stopSequence;
		if (first) {
			p.state = first.state;
			if (first.error) {
				p.status = { error: first.error };
			} else {
				delete p.status;
			}
		}
		p.sequence = rest.length > 0 ? rest : [{ state: p.state, ...(p.status ? { error: p.status.error } : {}) }];
		return [200, { pipeline: this.shown(p) }];
	}
}
