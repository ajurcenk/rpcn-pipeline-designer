// A local fake of the three Redpanda Cloud hosts (ticket 5.2), modelled on spike 5.1's captures
// (`epic-deploy-to-redpanda-cloud/spike-5-1-findings/captures/`): one HTTP server on 127.0.0.1 answering
//   - the token endpoint `POST /oauth/token` (01; a wrong ID or secret: 401 `{error, error_description}`, 02),
//   - the Control Plane `GET /v1/clusters` (04, paged by `pageSize`) and `GET /v1/clusters/{id}` (07),
//   - each cluster's Data Plane at `/dp/{cluster id}` (its own address as `dataplane_api.url`):
//     `GET|POST /v1/redpanda-connect/pipelines` (09; a create the lint rejects: 400 with `LintHint`s, 26;
//     else 200 in `STATE_STARTING`, 29) and `GET …/pipelines/{id}`, which walks the pipeline's state
//     sequence one step per call (30, 31: `STATE_ERROR` with or without a `status`).
// A Bearer token other than the one it issued is refused (401, 08). Every request is recorded, for
// the no-leak checks.

import * as http from 'http';
import type { AddressInfo } from 'net';

export interface FakeRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: string;
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
	pipelines: FakePipeline[];
	/** When set, the pipelines list answers this error. */
	pipelinesError?: { readonly status: number; readonly body: unknown };
	/** When set, `GET /v1/clusters/{id}` answers this error. */
	getError?: { readonly status: number; readonly body: unknown };
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
				},
			}];
		}
		const dp = /^\/dp\/([^/]+)\/v1\/redpanda-connect\/pipelines(?:\/([^/]+))?$/.exec(url.pathname);
		if (dp) {
			const c = this.options.clusters.find((x) => x.id === dp[1] && x.dataplane !== false);
			if (!c) {
				return [404, { code: 'NOT_FOUND', message: 'not found', details: [] }];
			}
			return this.pipelines(c, req, dp[2] ? decodeURIComponent(dp[2]) : undefined);
		}
		return [404, { code: 'NOT_FOUND', message: `no fake route ${req.method} ${url.pathname}`, details: [] }];
	}

	private shown(p: FakePipeline): unknown {
		const { sequence: _sequence, ...rest } = p;
		return rest;
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
			const lines = config.split('\n');
			const at = lines.findIndex((l) => l.includes(FAKE_LINT_MARKER));
			if (at >= 0) {
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
		return [405, { code: 'UNIMPLEMENTED', message: 'not in the fake', details: [] }];
	}
}
