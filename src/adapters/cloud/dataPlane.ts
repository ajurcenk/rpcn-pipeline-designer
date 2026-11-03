// A cluster's Data Plane pipelines (AD-23, ticket 5.2): list (`{dp}/v1/redpanda-connect/pipelines`,
// following `next_page_token`), create (`POST`, 200 `{pipeline}` in `STATE_STARTING`; a config the
// cluster's lint rejects is a 400 with `LintHint`s) and get (`GET /{id}`). Update, start, stop and
// delete are later stories. No `vscode` import.

import { authorizedJson, type CloudCall } from './controlPlane';
import { joinUrl } from './http';

/** The tracer's resources (user, 2026-11-02): 0.1 CPU, 400 MB, until story 5.3's setting. */
export const TRACER_RESOURCES = { cpu_shares: '100m', memory_shares: '400M' } as const;
/** The tag naming the config a pipeline was deployed from (its workspace-relative path). */
export const CONFIG_TAG = 'rpcn-vscode/config';

export type PipelineState = 'STATE_STARTING' | 'STATE_RUNNING' | 'STATE_STOPPING' | 'STATE_STOPPED' | 'STATE_ERROR' | 'STATE_COMPLETED' | string;

/** The states a deploy stops following at. */
export const FINAL_STATES: readonly PipelineState[] = ['STATE_RUNNING', 'STATE_ERROR', 'STATE_STOPPED', 'STATE_COMPLETED'];

export interface CloudPipeline {
	readonly id: string;
	readonly displayName: string;
	readonly state: PipelineState;
	/** The reason of an error state, when the cluster gave one (it can give none). */
	readonly error?: string;
	readonly tags: Readonly<Record<string, string>>;
}

export interface CreatePipeline {
	readonly displayName: string;
	readonly configYaml: string;
	readonly tags: Readonly<Record<string, string>>;
}

const MAX_PAGES = 20;
const PIPELINES = '/v1/redpanda-connect/pipelines';

/** `STATE_RUNNING` → `Running`. */
export function pipelineStateText(state: PipelineState): string {
	const short = state.replace(/^STATE_/, '').toLowerCase();
	return short ? short[0].toUpperCase() + short.slice(1) : 'Unknown';
}

/** The pipeline object of an answer as the extension keeps it. */
export function pipelineFrom(raw: unknown): CloudPipeline | undefined {
	if (raw === null || typeof raw !== 'object') {
		return undefined;
	}
	const p = raw as Record<string, unknown>;
	if (typeof p.id !== 'string' || !p.id) {
		return undefined;
	}
	const tags: Record<string, string> = {};
	if (p.tags !== null && typeof p.tags === 'object' && !Array.isArray(p.tags)) {
		for (const [k, v] of Object.entries(p.tags as Record<string, unknown>)) {
			if (typeof v === 'string') {
				tags[k] = v;
			}
		}
	}
	const status = p.status;
	const statusError = status !== null && typeof status === 'object' ? (status as Record<string, unknown>).error : undefined;
	const error = typeof statusError === 'string' && statusError.trim() ? statusError.trim() : undefined;
	return {
		id: p.id,
		displayName: typeof p.display_name === 'string' && p.display_name ? p.display_name : p.id,
		state: typeof p.state === 'string' && p.state ? p.state : 'STATE_UNSPECIFIED',
		...(error ? { error } : {}),
		tags,
	};
}

export async function listPipelines(call: CloudCall, dataplaneUrl: string): Promise<CloudPipeline[]> {
	const out: CloudPipeline[] = [];
	let pageToken = '';
	for (let page = 0; page < MAX_PAGES; page++) {
		const query = `page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
		const body = await authorizedJson<{ pipelines?: unknown; next_page_token?: unknown }>(
			call, 'GET', joinUrl(dataplaneUrl, `${PIPELINES}?${query}`));
		if (Array.isArray(body.pipelines)) {
			out.push(...body.pipelines.map(pipelineFrom).filter((p): p is CloudPipeline => p !== undefined));
		}
		pageToken = typeof body.next_page_token === 'string' ? body.next_page_token : '';
		if (!pageToken) {
			break;
		}
	}
	return out;
}

/** Creates a pipeline from `configYaml` as given, with the tracer's resources. */
export async function createPipeline(call: CloudCall, dataplaneUrl: string, create: CreatePipeline): Promise<CloudPipeline> {
	const body = await authorizedJson<{ pipeline?: unknown }>(call, 'POST', joinUrl(dataplaneUrl, PIPELINES), {
		display_name: create.displayName,
		config_yaml: create.configYaml,
		resources: { ...TRACER_RESOURCES },
		tags: { ...create.tags },
	});
	const pipeline = pipelineFrom(body.pipeline);
	if (!pipeline) {
		throw new Error('the cluster answered the create without a pipeline');
	}
	return pipeline;
}

export async function getPipeline(call: CloudCall, dataplaneUrl: string, id: string): Promise<CloudPipeline> {
	const body = await authorizedJson<{ pipeline?: unknown }>(
		call, 'GET', joinUrl(dataplaneUrl, `${PIPELINES}/${encodeURIComponent(id)}`));
	const pipeline = pipelineFrom(body.pipeline);
	if (!pipeline) {
		throw new Error('the cluster answered without the pipeline');
	}
	return pipeline;
}
