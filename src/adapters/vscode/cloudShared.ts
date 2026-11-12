// What the Cloud view, its deploy flow, its pipeline actions and its log access share (ticket 5.9): constants,
// texts and pure helpers, no state. Every module of the four imports it; it imports none of them (types only).

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_TAG, type CloudPipeline, isKnownState, type PipelineState, pipelineStateText } from '../cloud/dataPlane';
import {
	type DeployMapping, legacyOwnersOf, legacySidecarPath, type ParsedMapping, parseMapping, sidecarPath, tagNames, taggedConfigs, type WorkspaceRoot,
} from '../cloud/sidecar';
import type { CloudContext, DeployResult } from './cloudView';

export const NOT_CONNECTED_MESSAGE = 'No Redpanda Cloud service account is connected. Connect one to deploy.';
export const CONNECT_ACTION = 'Connect service account';
export const NO_REASON = 'the cluster gave no reason';
/** A row whose tag names no file in the workspace folders (outside them, or missing). */
export const NOT_IN_WORKSPACE = 'not in this workspace';
/** Bug 47: a row whose tag names files in more than one workspace folder (a tag written before the fix). */
export const IN_SEVERAL_FOLDERS = 'in more than one folder';
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
/** Whether `file` is a file now (sync: the rows' file is looked up while the tree is drawn). */
export function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/** The existing files a pipeline's tag names in `folders` (bug 47: more than one is never resolved silently). */
export function filesOfTag(tag: string | undefined, folders: readonly WorkspaceRoot[]): string[] {
	return taggedConfigs(tag, folders).filter(isFile);
}

/**
 * Where a config's deploy mapping is (bug 47). `own`: `file` is read: `<file name>.cloud.json` when
 * it exists, else the old `<stem>.cloud.json` when it exists and is this config's (no other config
 * beside could own it, or its pipeline's tag names this config alone), else the new name (`read`
 * none; also when the tag names another owner alone). `shared`: only the old `file` exists and
 * `owners` (this config among them) could each own it, so it is not used. A mapping a deploy writes
 * fresh always goes to `sidecarPath` (the old file is then left as it is).
 */
export type MappingAt =
	| { readonly kind: 'own'; readonly file: string; readonly read: { readonly kind: 'none' } | ParsedMapping }
	| { readonly kind: 'shared'; readonly file: string; readonly own: string; readonly owners: readonly string[] };

/** `(dev, ino)` of a file, so two names of one file (a case-insensitive file system) count once. */
function identityOf(file: string): string {
	try {
		const st = fs.statSync(file);
		return st.ino ? `${st.dev}:${st.ino}` : path.resolve(file).toLowerCase();
	} catch {
		return file;
	}
}

/**
 * `tagOf`: the `rpcn-vscode/config` tag of the pipeline an old mapping names (`undefined`: not known),
 * which decides between the configs that could own it; `folders`: where that tag is resolved.
 */
export async function findMapping(
	config: string, folders: readonly WorkspaceRoot[] = [], tagOf?: (m: DeployMapping) => Promise<string | undefined>,
): Promise<MappingAt> {
	const own = sidecarPath(config);
	const read = await readMapping(own);
	const legacy = legacySidecarPath(config);
	if (read.kind !== 'none' || !legacy) {
		return { kind: 'own', file: own, read };
	}
	const old = await readMapping(legacy);
	if (old.kind === 'none') {
		return { kind: 'own', file: own, read };
	}
	const self = identityOf(config);
	const seen = new Set<string>([self]);
	const owners = [config];
	for (const f of legacyOwnersOf(config)) {
		const id = identityOf(f);
		if (f !== config && isFile(f) && !seen.has(id)) {
			seen.add(id);
			owners.push(f);
		}
	}
	if (owners.length === 1) {
		return { kind: 'own', file: legacy, read: old };
	}
	if (old.kind === 'ok' && tagOf) {
		const tag = await tagOf(old.mapping);
		const named = owners.filter((f) => tagNames(tag, f, folders));
		if (named.length === 1) {
			return named[0] === config ? { kind: 'own', file: legacy, read: old } : { kind: 'own', file: own, read: { kind: 'none' } };
		}
	}
	return { kind: 'shared', file: legacy, own, owners };
}

/**
 * "orders.cloud.json could map orders.yaml or orders.yml, so it is not used for orders.yaml (rename it
 * to <file name>.cloud.json for the config it belongs to, or remove it)" (bug 47; `config`: the one asking).
 */
export function sharedMappingText(at: Extract<MappingAt, { kind: 'shared' }>, config: string): string {
	const names = at.owners.map((f) => path.basename(f));
	const old = path.basename(at.file);
	return `${old} could map ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}, so it is not used for ${path.basename(config)}`
		+ ` (rename it to <file name>.cloud.json for the config it belongs to, such as ${path.basename(at.own)}, or remove it)`;
}

/** `findMapping`'s `tagOf` (bug 47): the tag of the pipeline an old mapping names, from the cluster's list (read when it was not). */
export function mappedTagOf(ctx: CloudContext): (m: DeployMapping) => Promise<string | undefined> {
	return async (m) => {
		const cluster = ctx.clusterById(m.clusterId);
		if (!cluster || !ctx.dataplaneUrlOf(cluster)) {
			return undefined;
		}
		if (ctx.pipelines.get(m.clusterId)?.kind !== 'ok') {
			await ctx.loadPipelines(m.clusterId, false);
		}
		return ctx.pipelineById(m.clusterId, m.pipelineId)?.tags[CONFIG_TAG];
	};
}

/** `running`, `in error`; a state the extension does not know, as the API names it. */
export function stateWord(state: PipelineState): string {
	if (state === 'STATE_ERROR') {
		return 'in error';
	}
	return isKnownState(state) ? pipelineStateText(state).toLowerCase() : pipelineStateText(state);
}
