// What the Cloud view, its deploy flow, its pipeline actions and its log access share (ticket 5.9): constants,
// texts and helpers. Every module of the four imports it; it imports none of them (types only). Ticket 7.10:
// also the log and metrics accesses' shared flow (Forget, a cluster row's cluster) and `SetUpGuard`, the one
// stateful part (the clusters whose Set up runs, one guard per access); each access keeps its own texts and masking.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CloudCall, CloudCluster } from '../cloud/controlPlane';
import { CONFIG_TAG, type CloudPipeline, getPipeline, isKnownState, type PipelineState } from '../cloud/dataPlane';
import { asCloudError, type CloudError } from '../cloud/errors';
import { pipelineStateText } from '../cloud/pipelineText';
import {
	type DeployMapping, legacyOwnersOf, legacySidecarPath, type ParsedMapping, parseMapping, sidecarPath, tagNames, taggedConfigs, type WorkspaceRoot,
} from '../cloud/sidecar';
import { mergeResources, resourceBlockLines } from '../../core/cloudResources';
import { type CloudSecretUse, translateForCloud } from '../../core/cloudTranslate';
import { errorText } from '../../shared/errorText';
import type { CloudContext, CloudNode, DeployResult } from './cloudView';

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
/** The right side of the deploy's diff: the local config as it would be sent. */
export function sentConfigUri(clusterId: string, pipelineId: string, name: string): vscode.Uri {
	const safe = name.replace(/[^\w.-]+/g, '_') || pipelineId;
	return vscode.Uri.from({ scheme: DEPLOYED_SCHEME, path: `/${clusterId}/${pipelineId}/${safe}.local.yaml` });
}
/** Bug 48: the right side of Compare with local file (the local config as it would be sent), apart from the deploy's. */
export function compareConfigUri(clusterId: string, pipelineId: string, name: string): vscode.Uri {
	const safe = name.replace(/[^\w.-]+/g, '_') || pipelineId;
	return vscode.Uri.from({ scheme: DEPLOYED_SCHEME, path: `/${clusterId}/${pipelineId}/${safe}.compare.yaml` });
}
/** Why `file` can't be sent to Redpanda Cloud, each problem with its line (Deploy's message; bug 48: Compare's too). */
export function refusedText(file: string, problems: readonly { readonly message: string }[]): string {
	return `${file} can't be deployed to Redpanda Cloud: ${problems.map((p) => p.message).join('; ')}`;
}
export async function readMapping(file: string): Promise<{ readonly kind: 'none' } | ParsedMapping> {
	let text: string;
	try {
		text = await fs.promises.readFile(file, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return { kind: 'none' };
		}
		return { kind: 'bad', reason: `it could not be read (${errorText(err)})` };
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

/**
 * How `pollPipeline` follows a pipeline (story 50): what Deploy's follow (and Start's and Stop's, which
 * reuse it) and Delete's wait differ in. Their timing stays their own (`deadline`), and tests count
 * the requests of both.
 */
export interface PollHow<T> {
	readonly call: () => CloudCall;
	readonly dp: string;
	/** The id each read GETs (Deploy's follow: the id of the pipeline last read). */
	readonly id: () => string;
	/** In the log line of a failed read: "could not read the state of <name>: …". */
	readonly name: string;
	readonly timeoutMs: number;
	readonly pollMs: number;
	readonly log: (line: string) => void;
	readonly report: (message: string) => void;
	/**
	 * Where each round checks the deadline: `beforeRead` (Deploy's follow: the deadline, the progress
	 * and the wait, then the read) or `afterRead` (Delete's wait: the read first, then the deadline,
	 * the progress and the wait).
	 */
	readonly deadline: 'beforeRead' | 'afterRead';
	/** Whether what was read so far ends the poll, checked at the start of each round: its end, or `undefined` to go on. */
	readonly done?: () => T | undefined;
	/** A pipeline read (the failures in a row start again). */
	readonly read: (p: CloudPipeline) => void;
	/** The progress reported before each wait. */
	readonly progress: () => string;
	/** What a 404 means: `failed` (a failed read, logged, that ends the poll at once), or its own end (not logged). */
	readonly notFound: 'failed' | (() => T);
	/** The end after a 404 that counts as failed, or after `MAX_POLL_FAILURES` failed reads in a row. */
	readonly failed: (error: CloudError, err: unknown) => T;
	/** The end at the deadline. */
	readonly timedOut: () => T;
}

/** `GET`s pipeline `how.id()` every `pollMs` until `how` says it ended, a 404 or too many failed reads end it, or the deadline passes. */
export async function pollPipeline<T>(how: PollHow<T>): Promise<T> {
	const deadline = Date.now() + how.timeoutMs;
	let failures = 0;
	const wait = async () => {
		how.report(how.progress());
		await sleep(how.pollMs);
	};
	for (;;) {
		const end = how.done?.();
		if (end !== undefined) {
			return end;
		}
		if (how.deadline === 'beforeRead') {
			if (Date.now() >= deadline) {
				return how.timedOut();
			}
			await wait();
		}
		try {
			const p = await getPipeline(how.call(), how.dp, how.id());
			failures = 0;
			how.read(p);
		} catch (err) {
			const error = asCloudError(err);
			if (error.status === 404 && how.notFound !== 'failed') {
				return how.notFound();
			}
			how.log(`Redpanda Cloud: could not read the state of ${how.name}: ${error.message}`);
			if (error.status === 404 || ++failures >= MAX_POLL_FAILURES) {
				return how.failed(error, err);
			}
		}
		if (how.deadline === 'afterRead') {
			if (Date.now() >= deadline) {
				return how.timedOut();
			}
			await wait();
		}
	}
}

/**
 * Story 50: the log line and the message of a follow that timed out (`on`: "on <cluster>"): "still
 * <still> after N s" (Deploy, Start, Stop), or a deleted pipeline still listed (`also`: what the
 * message adds).
 */
export function stillText(
	name: string, on: string, timeoutMs: number, what: { readonly still: string } | { readonly listedAfterDelete: true; readonly also: string },
): { readonly log: string; readonly info: string } {
	const seconds = Math.round(timeoutMs / 1000);
	if ('still' in what) {
		return {
			log: `Redpanda Cloud: pipeline ${name} ${on} is still ${what.still} after ${seconds} s.`,
			info: `Pipeline ${name} is still ${what.still} ${on}; the Cloud view shows its state.`,
		};
	}
	return {
		log: `Redpanda Cloud: pipeline ${name} ${on} is still listed ${seconds} s after its delete.`,
		info: `Pipeline ${name} is being deleted ${on}; the Cloud view shows it until it is gone.${what.also}`,
	};
}

/** What a deploy mapping names now (story 50: Deploy's and the palette's resolution). */
export type MappedPipeline =
	| { readonly kind: 'found'; readonly cluster: CloudCluster; readonly dp: string; readonly pipeline: CloudPipeline }
	/** The cluster is gone or offers no pipeline API; `named`: its name (the cluster's, else the mapping's, else its id). */
	| { readonly kind: 'clusterGone'; readonly named: string }
	/** A GET answered 404; the pipeline is removed from the view's cache. */
	| { readonly kind: 'pipelineGone'; readonly cluster: CloudCluster; readonly dp: string }
	/** The read failed otherwise (`readPipeline` showed it). */
	| { readonly kind: 'failed'; readonly message: string };

/** The cluster of mapping `m` by its id, its Data Plane address, then its pipeline read now (a 404: removed from the cache). */
export async function mappedPipeline(
	ctx: Pick<CloudContext, 'clusterById' | 'dataplaneUrlOf' | 'readPipeline' | 'removePipeline'>, m: DeployMapping,
): Promise<MappedPipeline> {
	const cluster = ctx.clusterById(m.clusterId);
	const dp = cluster && ctx.dataplaneUrlOf(cluster);
	if (!cluster || !dp) {
		return { kind: 'clusterGone', named: cluster?.name ?? m.clusterName ?? m.clusterId };
	}
	const read = await ctx.readPipeline(cluster, dp, m.pipelineId, m.pipelineName ?? m.pipelineId);
	if (read.kind === 'ok') {
		return { kind: 'found', cluster, dp, pipeline: read.value };
	}
	if (read.status !== 404) {
		return { kind: 'failed', message: read.message };
	}
	ctx.removePipeline(cluster.id, m.pipelineId);
	return { kind: 'pipelineGone', cluster, dp };
}

/**
 * The message of mapping `m` (the file `mappingName`, for `file`) whose cluster or pipeline is gone,
 * then each caller's own ending `then` when given (story 50: these texts are built here only).
 */
export function mappingGoneText(
	gone: { readonly kind: 'clusterGone'; readonly named: string } | { readonly kind: 'pipelineGone'; readonly cluster: CloudCluster },
	m: DeployMapping, mappingName: string, file: string, then?: string,
): string {
	const text = gone.kind === 'clusterGone'
		? `The cluster ${gone.named} that ${mappingName} maps ${file} to is gone or no longer offers the pipeline API.`
		: `Pipeline ${m.pipelineName ?? m.pipelineId}, which ${mappingName} maps ${file} to, is no longer on ${gone.cluster.name}.`;
	return then ? `${text} ${then}` : text;
}

/** A cluster row's command on a node that is not a cluster row. */
export const CHOOSE_A_CLUSTER = 'Choose a cluster in the Cloud view.';
/** A cluster row's command on a cluster the view no longer holds. */
export const CLUSTER_GONE = 'That cluster is no longer in the Cloud view. Refresh the view to read the clusters again.';

/** The cluster of a cluster row's command (`undefined`: not a cluster row, or gone; said so). */
export function rowCluster(ctx: Pick<CloudContext, 'clusterById' | 'showInfo'>, node: CloudNode | undefined): CloudCluster | undefined {
	if (node?.kind !== 'cluster') {
		void ctx.showInfo(CHOOSE_A_CLUSTER);
		return undefined;
	}
	const cluster = ctx.clusterById(node.id);
	if (!cluster) {
		void ctx.showInfo(CLUSTER_GONE);
	}
	return cluster;
}

/**
 * Epic 7 refactor sweep (7.10): the one-at-a-time rule of a cluster's Set up (log or metrics) access.
 * `what`: "log access", "metrics access"; `changed`: told each time a cluster's set-up starts or ends.
 * A call whose node is not a cluster row runs unguarded and is not told to `changed`.
 */
export class SetUpGuard {
	private readonly running = new Set<string>();

	constructor(private readonly what: string, private readonly log: (line: string) => void, private readonly changed?: (clusterId: string) => void) {}

	/** Whether a set-up of `clusterId` runs now. */
	has(clusterId: string): boolean {
		return this.running.has(clusterId);
	}

	/** `run` for a cluster row's `node`, unless a set-up of that cluster runs already (then `ignored`, logged). */
	async guard<T>(node: CloudNode | undefined, ignored: T, run: () => Promise<T>): Promise<T> {
		const clusterId = node?.kind === 'cluster' ? node.id : undefined;
		if (clusterId === undefined) {
			return run();
		}
		if (this.running.has(clusterId)) {
			this.log(`Redpanda Cloud: Set up ${this.what} is already running for that cluster; this request was ignored.`);
			return ignored;
		}
		this.running.add(clusterId);
		this.changed?.(clusterId);
		try {
			return await run();
		} finally {
			this.running.delete(clusterId);
			this.changed?.(clusterId);
		}
	}
}

/** What Forget (log or metrics) access differs in (7.10: the flow itself is `forgetAccess`). */
export interface ForgetHow {
	/** "log access", "metrics access". */
	readonly what: string;
	/** The cluster's user held now (none: no access held; the palette offers only clusters with one). */
	readonly userOf: (clusterId: string) => string | undefined;
	/** The cluster's secret storage key. */
	readonly key: (clusterId: string) => string;
	/** Removes the cluster's access (the record and memory); throws when the secret storage does. */
	readonly remove: (clusterId: string) => Promise<void>;
	/** The palette's message when no cluster has an access. */
	readonly noneSet: string;
	/** The message once removed. */
	readonly forgotten: (cluster: string) => string;
	/** The mask of a failure's text. */
	readonly mask: (text: string) => string;
}

/**
 * Forget (log or metrics) access: on a cluster row, that cluster's; from the palette (no node), one picked
 * from the clusters with an access (connected first). Escape: nothing changes. Never throws.
 */
export async function forgetAccess(
	ctx: CloudContext, node: CloudNode | undefined, how: ForgetHow,
): Promise<{ readonly kind: 'notStarted' } | { readonly kind: 'forgotten'; readonly clusterId: string }> {
	const notStarted = { kind: 'notStarted' } as const;
	try {
		let cluster: CloudCluster | undefined;
		if (node === undefined) {
			if (!(await ctx.connectedFirst())) {
				return notStarted;
			}
			await ctx.loadClusters(false);
			const clusters = ctx.clusters;
			if (clusters?.kind !== 'ok') {
				if (clusters?.kind === 'error') {
					void ctx.showError(`Could not list the Redpanda Cloud clusters: ${clusters.message}`);
				}
				return notStarted;
			}
			const offered = clusters.value.filter((c) => how.userOf(c.id) !== undefined);
			if (offered.length === 0) {
				void ctx.showInfo(how.noneSet);
				return notStarted;
			}
			cluster = await ctx.ui.pickCluster(offered, `Forget ${how.what}: the cluster`, `The cluster whose ${how.what} to remove`);
			if (!cluster) {
				return notStarted;
			}
		} else {
			cluster = rowCluster(ctx, node);
			if (!cluster) {
				return notStarted;
			}
		}
		const user = how.userOf(cluster.id);
		if (!user && (await ctx.options.store.get(how.key(cluster.id))) === undefined) {
			void ctx.showInfo(`${cluster.name} has no ${how.what} set.`);
			return notStarted;
		}
		await how.remove(cluster.id);
		ctx.log(`Redpanda Cloud: removed the ${how.what} to ${cluster.name}${user ? ` (${user})` : ''}.`);
		void ctx.showInfo(how.forgotten(cluster.name));
		return { kind: 'forgotten', clusterId: cluster.id };
	} catch (err) {
		const message = how.mask(errorText(err));
		ctx.log(`Redpanda Cloud: Forget ${how.what} failed: ${message}`);
		void ctx.showError(`Could not remove the ${how.what} from the secret storage: ${message}`);
		return notStarted;
	}
}

/** Story 42: a config's resource files (each `redpandaConnect.resourceFiles` entry expanded), or why the setting can't be used. */
export type ResourceFiles =
	| { readonly kind: 'ok'; readonly files: readonly string[] }
	| { readonly kind: 'unusable'; readonly message: string };
export const NO_RESOURCE_FILES: ResourceFiles = { kind: 'ok', files: [] };

/** The text sent to Redpanda Cloud and its secrets, or why it can't be (each problem's message names its file). */
export type SentConfig =
	/** `resourcesFrom`: the resource files whose resources `text` includes (none: the config alone). */
	| { readonly kind: 'ok'; readonly text: string; readonly secrets: readonly CloudSecretUse[]; readonly resourcesFrom: readonly string[] }
	| { readonly kind: 'refused'; readonly problems: readonly { readonly message: string }[] };

/**
 * Story 42: `source` (the text of the config at `uri`, named `file`) as Deploy sends it and Compare shows it:
 * with the resources of its resource files (read from disk now, as a local run reads them) merged in,
 * translated for the Cloud. No resource files: `translateForCloud(source)` itself. Refused before the merge:
 * an unusable setting, the config's own translation problems, a file that can't be read, and each file's
 * translation problems inside its `*_resources` blocks, the only part sent (named with the file, the line its
 * own). Never throws; nothing is written.
 */
export async function sentConfig(ctx: Pick<CloudContext, 'resourceFiles'>, uri: vscode.Uri, file: string, source: string): Promise<SentConfig> {
	const resources = ctx.resourceFiles(uri);
	if (resources.kind === 'unusable') {
		return { kind: 'refused', problems: [{ message: resources.message.replace(/\.$/, '') }] };
	}
	const own = translateForCloud(source);
	if (resources.files.length === 0 || own.kind === 'refused') {
		return own.kind === 'ok' ? { ...own, resourcesFrom: [] } : own;
	}
	const problems: { message: string }[] = [];
	const texts: { path: string; text: string }[] = [];
	for (const resourceFile of resources.files) {
		const shown = vscode.workspace.asRelativePath(resourceFile);
		let text: string;
		try {
			text = await fs.promises.readFile(resourceFile, 'utf8');
		} catch (err) {
			problems.push({ message: `the resource file ${shown} could not be read (${errorText(err)})` });
			continue;
		}
		const alone = translateForCloud(text);
		if (alone.kind === 'refused') {
			// Only the `*_resources` blocks are sent: a problem elsewhere in the file (under `logger:`) is not the Cloud's.
			const blocks = resourceBlockLines(text);
			const sent = alone.problems.filter((p) => blocks === undefined || blocks.some((b) => p.line >= b.start && p.line <= b.end));
			problems.push(...sent.map((p) => ({ message: `${shown}: ${p.message}` })));
		}
		texts.push({ path: shown, text });
	}
	if (problems.length > 0) {
		return { kind: 'refused', problems };
	}
	const merged = mergeResources(source, texts, file);
	if (merged.kind === 'refused') {
		return merged;
	}
	const translated = translateForCloud(merged.text);
	return translated.kind === 'ok' ? { ...translated, resourcesFrom: merged.from } : translated;
}
