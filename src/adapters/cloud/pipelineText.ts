// How a Data Plane pipeline is presented (story 50, moved out of `dataPlane.ts`, which keeps the
// requests, their types and the state constants): its state as text and as the view's context value,
// what its state offers (Start, Stop; an update that restarts it), its resources as text and Deploy's
// size pick. Pure; no `vscode` import.

import {
	isKnownState, MAX_UNITS, MIN_UNITS, type PipelineResources, type PipelineState, resourcesOf, sameResources, unitsOf,
} from './dataPlane';

/** `1 compute unit (0.1 CPU, 400 MB)`; resources that are no whole number of units as written. */
export function resourcesText(resources: PipelineResources | undefined): string {
	const units = unitsOf(resources);
	if (units !== undefined) {
		return `${units} compute unit${units === 1 ? '' : 's'} (${units / 10} CPU, ${units * 400} MB)`;
	}
	return resources ? `CPU ${resources.cpu_shares || '?'}, memory ${resources.memory_shares || '?'}` : 'unknown resources';
}

/** Running or starting: an update restarts it, so the deploy asks first. */
export function isRunning(state: PipelineState): boolean {
	return state === 'STATE_RUNNING' || state === 'STATE_STARTING';
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
