// A cluster's Data Plane pipelines (AD-23, tickets 5.2, 5.3): list (`{dp}/v1/redpanda-connect/pipelines`,
// following `next_page_token`), create (`POST`, 200 `{pipeline}` in `STATE_STARTING`; a config the
// cluster's lint rejects is a 400 with `LintHint`s), get (`GET /{id}`) and update (`PUT /{id}`, which
// replaces the pipeline, so every field is sent; an update of a running pipeline restarts it), and
// (ticket 5.4) start and stop (`PUT /{id}/start`, `PUT /{id}/stop`, each answering `{pipeline}`) and
// delete (`DELETE /{id}`, answering `{}`; a GET then answers 404). No `vscode` import.

import { authorizedJson, type CloudCall } from './controlPlane';
import { joinUrl } from './http';

export interface PipelineResources {
	readonly cpu_shares: string;
	readonly memory_shares: string;
}

/** One compute unit is 0.1 CPU and 400 MB; Deploy offers 1–15. */
export const MIN_UNITS = 1;
export const MAX_UNITS = 15;

/** The resources of `units` compute units: `${units*100}m` CPU, `${units*400}M` memory. */
export function resourcesOf(units: number): PipelineResources {
	return { cpu_shares: `${units * 100}m`, memory_shares: `${units * 400}M` };
}

/** The compute units `resources` amount to, when they are a whole number of units as `resourcesOf` writes them. */
export function unitsOf(resources: PipelineResources | undefined): number | undefined {
	const cpu = /^(\d+)m$/.exec(resources?.cpu_shares ?? '');
	const memory = /^(\d+)M$/.exec(resources?.memory_shares ?? '');
	if (!cpu || !memory) {
		return undefined;
	}
	const units = Number(cpu[1]) / 100;
	return Number.isInteger(units) && units > 0 && Number(memory[1]) === units * 400 ? units : undefined;
}

/** `1 compute unit (0.1 CPU, 400 MB)`; resources that are no whole number of units as written. */
export function resourcesText(resources: PipelineResources | undefined): string {
	const units = unitsOf(resources);
	if (units !== undefined) {
		return `${units} compute unit${units === 1 ? '' : 's'} (${units / 10} CPU, ${units * 400} MB)`;
	}
	return resources ? `CPU ${resources.cpu_shares || '?'}, memory ${resources.memory_shares || '?'}` : 'unknown resources';
}

export function sameResources(a: PipelineResources | undefined, b: PipelineResources | undefined): boolean {
	return !!a && !!b && a.cpu_shares.trim() === b.cpu_shares.trim() && a.memory_shares.trim() === b.memory_shares.trim();
}
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
	readonly description: string;
	/** The deployed config (`''` when the answer carried none). */
	readonly configYaml: string;
	readonly resources?: PipelineResources;
}

export interface CreatePipeline {
	readonly displayName: string;
	readonly configYaml: string;
	readonly resources: PipelineResources;
	readonly tags: Readonly<Record<string, string>>;
}

/** An update's full body (`PUT` replaces: a field left out is cleared, a missing config rejected). */
export interface UpdatePipeline {
	readonly displayName: string;
	readonly description: string;
	readonly configYaml: string;
	readonly resources: PipelineResources;
	readonly tags: Readonly<Record<string, string>>;
}

/** Running or starting: an update restarts it, so the deploy asks first. */
export function isRunning(state: PipelineState): boolean {
	return state === 'STATE_RUNNING' || state === 'STATE_STARTING';
}

const MAX_PAGES = 20;
const PIPELINES = '/v1/redpanda-connect/pipelines';

/** The states the extension knows; another state the API names is shown by its raw name. */
export const KNOWN_STATES: readonly PipelineState[] = ['STATE_STARTING', 'STATE_RUNNING', 'STATE_STOPPING', 'STATE_STOPPED', 'STATE_ERROR', 'STATE_COMPLETED'];

export function isKnownState(state: PipelineState): boolean {
	return KNOWN_STATES.includes(state);
}

/** `STATE_RUNNING` → `running`; a state the extension does not know → `unknown` (the view's context value). */
export function stateKey(state: PipelineState | undefined): string {
	return state && isKnownState(state) ? state.replace(/^STATE_/, '').toLowerCase() : 'unknown';
}

/** Start is offered for a stopped, failed or completed pipeline. */
export function canStart(state: PipelineState): boolean {
	return state === 'STATE_STOPPED' || state === 'STATE_ERROR' || state === 'STATE_COMPLETED';
}

/** Stop is offered for a running or starting pipeline. */
export function canStop(state: PipelineState): boolean {
	return state === 'STATE_RUNNING' || state === 'STATE_STARTING';
}

/** `STATE_RUNNING` → `Running`; a state the extension does not know, as the API names it. */
export function pipelineStateText(state: PipelineState): string {
	if (!isKnownState(state)) {
		return state || 'Unknown';
	}
	const short = state.replace(/^STATE_/, '').toLowerCase();
	return short[0].toUpperCase() + short.slice(1);
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
	const r = p.resources !== null && typeof p.resources === 'object' ? p.resources as Record<string, unknown> : undefined;
	const resources = r && (typeof r.cpu_shares === 'string' || typeof r.memory_shares === 'string')
		? { cpu_shares: typeof r.cpu_shares === 'string' ? r.cpu_shares : '', memory_shares: typeof r.memory_shares === 'string' ? r.memory_shares : '' }
		: undefined;
	return {
		id: p.id,
		displayName: typeof p.display_name === 'string' && p.display_name ? p.display_name : p.id,
		state: typeof p.state === 'string' && p.state ? p.state : 'STATE_UNSPECIFIED',
		...(error ? { error } : {}),
		tags,
		description: typeof p.description === 'string' ? p.description : '',
		configYaml: typeof p.config_yaml === 'string' ? p.config_yaml : '',
		...(resources ? { resources } : {}),
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

/** Creates a pipeline from `configYaml` as given. */
export async function createPipeline(call: CloudCall, dataplaneUrl: string, create: CreatePipeline): Promise<CloudPipeline> {
	const body = await authorizedJson<{ pipeline?: unknown }>(call, 'POST', joinUrl(dataplaneUrl, PIPELINES), {
		display_name: create.displayName,
		config_yaml: create.configYaml,
		resources: { ...create.resources },
		tags: { ...create.tags },
	});
	const pipeline = pipelineFrom(body.pipeline);
	if (!pipeline) {
		throw new Error('the cluster answered the create without a pipeline');
	}
	return pipeline;
}

/** Replaces pipeline `id` with `update`, every field sent (AD-23). */
export async function updatePipeline(call: CloudCall, dataplaneUrl: string, id: string, update: UpdatePipeline): Promise<CloudPipeline> {
	const body = await authorizedJson<{ pipeline?: unknown }>(call, 'PUT', joinUrl(dataplaneUrl, `${PIPELINES}/${encodeURIComponent(id)}`), {
		display_name: update.displayName,
		description: update.description,
		config_yaml: update.configYaml,
		resources: { ...update.resources },
		tags: { ...update.tags },
	});
	const pipeline = pipelineFrom(body.pipeline);
	if (!pipeline) {
		throw new Error('the cluster answered the update without a pipeline');
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

/** `PUT /{id}/{action}` → `{pipeline}`. */
async function lifecycle(call: CloudCall, dataplaneUrl: string, id: string, action: 'start' | 'stop'): Promise<CloudPipeline> {
	const body = await authorizedJson<{ pipeline?: unknown }>(
		call, 'PUT', joinUrl(dataplaneUrl, `${PIPELINES}/${encodeURIComponent(id)}/${action}`));
	const pipeline = pipelineFrom(body.pipeline);
	if (!pipeline) {
		throw new Error(`the cluster answered the ${action} without the pipeline`);
	}
	return pipeline;
}

/** Starts pipeline `id` (`PUT /{id}/start`); the answer is the pipeline, usually in `STATE_STARTING`. */
export function startPipeline(call: CloudCall, dataplaneUrl: string, id: string): Promise<CloudPipeline> {
	return lifecycle(call, dataplaneUrl, id, 'start');
}

/** Stops pipeline `id` (`PUT /{id}/stop`); the answer is the pipeline, usually in `STATE_STOPPING`. */
export function stopPipeline(call: CloudCall, dataplaneUrl: string, id: string): Promise<CloudPipeline> {
	return lifecycle(call, dataplaneUrl, id, 'stop');
}

/** Deletes pipeline `id` (`DELETE /{id}`, answering `{}`); a GET then answers 404. */
export async function deletePipeline(call: CloudCall, dataplaneUrl: string, id: string): Promise<void> {
	await authorizedJson<unknown>(call, 'DELETE', joinUrl(dataplaneUrl, `${PIPELINES}/${encodeURIComponent(id)}`));
}

/** One entry of Deploy's size pick. */
export interface SizeChoice {
	readonly label: string;
	readonly description: string;
	readonly resources: PipelineResources;
}

/**
 * Deploy's size pick: 1–15 compute units with their CPU and memory, and the one pre-set (`preset`,
 * an index): `current`, the deployed pipeline's size, marked " · current" (a size that is no whole
 * number of units from 1 to 15 comes first as "Current size"), or 1 unit for a new pipeline.
 */
export function sizeChoices(current: PipelineResources | undefined): { readonly items: SizeChoice[]; readonly preset: number } {
	const currentUnits = unitsOf(current);
	const items: SizeChoice[] = Array.from({ length: MAX_UNITS - MIN_UNITS + 1 }, (_, i) => {
		const units = MIN_UNITS + i;
		const resources = resourcesOf(units);
		return { label: `${units}`, description: `${resourcesText(resources)}${units === currentUnits ? ' · current' : ''}`, resources };
	});
	if (current && (currentUnits === undefined || currentUnits > MAX_UNITS)) {
		items.unshift({ label: 'Current size', description: resourcesText(current), resources: current });
	}
	const preset = items.findIndex((i) => sameResources(i.resources, current ?? resourcesOf(MIN_UNITS)));
	return { items, preset: Math.max(0, preset) };
}
