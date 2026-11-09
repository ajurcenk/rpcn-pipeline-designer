// What the Cloud view, its deploy flow, its pipeline actions and its log access share (ticket 5.9): constants,
// texts and pure helpers, no state. Every module of the four imports it; it imports none of them (types only).

import * as fs from 'fs';
import * as vscode from 'vscode';
import { type CloudPipeline, isKnownState, type PipelineState, pipelineStateText } from '../cloud/dataPlane';
import { type ParsedMapping, parseMapping } from '../cloud/sidecar';
import type { DeployResult } from './cloudView';

export const NOT_CONNECTED_MESSAGE = 'No Redpanda Cloud service account is connected. Connect one to deploy.';
export const CONNECT_ACTION = 'Connect service account';
export const NO_REASON = 'the cluster gave no reason';
/** A row whose tag names no file in the workspace folders (outside them, or missing). */
export const NOT_IN_WORKSPACE = 'not in this workspace';
/** The scheme of a pipeline's deployed config, shown read-only. */
export const DEPLOYED_SCHEME = 'redpanda-cloud';
/** After this many failed polls in a row the deploy stops following the pipeline. */
export const MAX_POLL_FAILURES = 5;
export const NOT_STARTED: DeployResult = { kind: 'notStarted' };
export const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** `Running`, or `Error (<reason>)` with the cluster's reason or "the cluster gave no reason". */
export function pipelineStateDescription(p: CloudPipeline | undefined): string {
	if (!p) {
		return 'Unknown';
	}
	return `${pipelineStateText(p.state)}${p.state === 'STATE_ERROR' ? ` (${p.error ?? NO_REASON})` : ''}`;
}
/** The left side of the deploy's diff and of Compare with local file (ticket 5.5). */
export function deployedConfigUri(clusterId: string, pipelineId: string, name: string): vscode.Uri {
	const safe = name.replace(/[^\w.-]+/g, '_') || pipelineId;
	return vscode.Uri.from({ scheme: DEPLOYED_SCHEME, path: `/${clusterId}/${pipelineId}/${safe}.yaml` });
}
export async function readMapping(file: string): Promise<{ readonly kind: 'none' } | ParsedMapping> {
	let text: string;
	try {
		text = await fs.promises.readFile(file, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return { kind: 'none' };
		}
		return { kind: 'bad', reason: `it could not be read (${reasonOf(err)})` };
	}
	return parseMapping(text);
}
/** `running`, `in error`; a state the extension does not know, as the API names it. */
export function stateWord(state: PipelineState): string {
	if (state === 'STATE_ERROR') {
		return 'in error';
	}
	return isKnownState(state) ? pipelineStateText(state).toLowerCase() : pipelineStateText(state);
}
