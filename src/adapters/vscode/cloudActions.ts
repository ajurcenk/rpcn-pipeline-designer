// The pipeline actions of the Cloud view (tickets 5.4, 5.5, 6.9): Start, Stop and Delete pipeline… from a row or
// the palette, and a row's Open deployed config, Compare with local file, Deploy local file again and Copy
// pipeline ID (see `cloudView.ts` for the behaviour); also the palette's target path, which Show pipeline logs
// shares through the context. Built by `CloudView` only; it reaches the view's account, cache, prompts and
// messages through `CloudContext`.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CloudCluster } from '../cloud/controlPlane';
import { CONFIG_TAG, type CloudPipeline, deletePipeline, getPipeline, startPipeline, stopPipeline } from '../cloud/dataPlane';
import { canStart, canStop, pipelineStateText } from '../cloud/pipelineText';
import { asCloudError, describeCloudError } from '../cloud/errors';
import { configTag, taggedConfigs } from '../cloud/sidecar';
import type { CloudContext, CloudNode, DeployResult, PipelineActionResult, PipelineChoice, RowActionResult } from './cloudView';
import {
	compareConfigUri, CONNECT_ACTION, DEPLOYED_SCHEME, deployedConfigUri, findMapping, IN_SEVERAL_FOLDERS, mappedPipeline, mappedTagOf, mappingGoneText, NO_REASON,
	NOT_CONNECTED_MESSAGE, NOT_IN_WORKSPACE, NOT_STARTED, pipelineStateDescription, pollPipeline, readMapping, reasonOf, refusedText, sharedMappingText, stateWord,
	stillText,
} from './cloudShared';
import { translateForCloud } from '../../core/cloudTranslate';
/** The delete confirmation's action. */
export const DELETE_ACTION = 'Delete';

export type PipelineAction = 'start' | 'stop' | 'delete';

/** The pipeline an action is for. `config`: the active config, from the palette. */
interface ActionTarget {
	readonly cluster: CloudCluster;
	readonly dp: string;
	readonly pipeline: CloudPipeline;
	readonly config?: vscode.Uri;
}

/** A palette command's pipeline (`dp`: the cluster's Data Plane, when it still has one). */
export type PaletteTarget =
	| { readonly kind: 'target'; readonly cluster: CloudCluster; readonly dp: string | undefined; readonly pipeline: CloudPipeline }
	/** Nothing chosen or nothing to choose (said so where needed). */
	| { readonly kind: 'none' }
	/** The mapped pipeline could not be read (not a 404). */
	| { readonly kind: 'failed'; readonly message: string };

/** How a palette command's target path differs between its callers. */
export interface PaletteTargetHow {
	/** Said after a gone or unreadable mapping, then the pick; absent: a gone mapping stops there, an unreadable one is said, then the pick. */
	readonly pickAfterGone?: string;
	/** The pick sorted by cluster, then pipeline name; else as listed. */
	readonly byName?: boolean;
	/** "No pipeline on the clusters to <nothingTo>." */
	readonly nothingTo: string;
	readonly title: string;
	/** A choice's description, before masking. */
	readonly describe: (cluster: CloudCluster, pipeline: CloudPipeline) => string;
}

/** Case-insensitive name order (then exact, for a stable order). */
function byName(a: string, b: string): number {
	return a.localeCompare(b, 'en', { sensitivity: 'base' }) || a.localeCompare(b);
}

/** Start, Stop, Delete and the row actions of a pipeline, and the palette target path. */
export class CloudActions {
	constructor(private readonly ctx: CloudContext) {}

	/** Start, Stop or Delete pipeline…: `node` (a view row), else the palette's target. Never throws. */
	async pipelineAction(action: PipelineAction, node?: CloudNode): Promise<PipelineActionResult> {
		try {
			const target = await this.actionTarget(action, node?.kind === 'pipeline' ? node : undefined);
			if (!('pipeline' in target)) {
				return target;
			}
			if (action === 'delete') {
				return await this.deleteTarget(target);
			}
			return await this.startOrStop(action, target);
		} catch (err) {
			const message = this.ctx.mask(reasonOf(err));
			this.ctx.log(`Redpanda Cloud: ${action} failed: ${message}`);
			void this.ctx.showError(`${ACTION_TEXT[action].failed} failed: ${message}`);
			return { kind: 'failed', message };
		}
	}

	/**
	 * The action's pipeline: a row's (as the view shows it), or, from the palette, the one the active
	 * config's `.cloud.json` maps to (read now), else one picked from every cluster's pipelines.
	 */
	private async actionTarget(action: PipelineAction, node: Extract<CloudNode, { kind: 'pipeline' }> | undefined): Promise<ActionTarget | PipelineActionResult> {
		if (!(await this.connectedFirst())) {
			return NOT_STARTED;
		}
		const config = this.activeConfig();
		if (node) {
			const cluster = this.ctx.clusterById(node.clusterId);
			const dp = cluster && this.ctx.dataplaneUrlOf(cluster);
			const pipeline = this.ctx.pipelineById(node.clusterId, node.id);
			if (!cluster || !dp || !pipeline) {
				void this.ctx.showInfo('That pipeline is no longer in the Cloud view. Refresh the view to read the pipelines again.');
				return NOT_STARTED;
			}
			return { cluster, dp, pipeline, ...(config ? { config } : {}) };
		}
		const target = await this.paletteTarget(() => config, {
			nothingTo: action,
			title: `${ACTION_TEXT[action].title}: the pipeline`,
			describe: (c, pipeline) => `${c.name} · ${pipelineStateDescription(pipeline)}`,
		});
		if (target.kind === 'failed') {
			return { kind: 'failed', message: target.message };
		}
		if (target.kind === 'none' || !target.dp) {
			return NOT_STARTED;
		}
		return { cluster: target.cluster, dp: target.dp, pipeline: target.pipeline, ...(config ? { config } : {}) };
	}

	/** Connected (after `ready`), else Connect offered: `false` when it was not chosen or did not connect. */
	async connectedFirst(): Promise<boolean> {
		await this.ctx.ready;
		if (!this.ctx.account) {
			const choice = await this.ctx.showInfo('No Redpanda Cloud service account is connected.', CONNECT_ACTION);
			if (choice !== CONNECT_ACTION || !(await this.ctx.connect())) {
				return false;
			}
		}
		return true;
	}

	/** The active editor's config, when it is a detected file on disk. */
	activeConfig(): vscode.Uri | undefined {
		const doc = vscode.window.activeTextEditor?.document;
		return doc && !doc.isUntitled && doc.uri.scheme === 'file' && this.ctx.options.isDetected(doc.uri) ? doc.uri : undefined;
	}

	/**
	 * A palette command's pipeline (Start, Stop, Delete; Show pipeline logs): the clusters read, then the
	 * one the config `configOf` gives (called once the clusters are read) maps to by its `.cloud.json`
	 * (read now), else one picked from every cluster's pipelines.
	 * `how` gives each caller's differences: whether a gone mapping stops there or falls through to the
	 * pick, the pick's order and descriptions. `failed`: the mapped pipeline could not be read.
	 */
	async paletteTarget(configOf: () => vscode.Uri | undefined, how: PaletteTargetHow): Promise<PaletteTarget> {
		this.ctx.requested = true;
		await this.ctx.loadClusters(false);
		if (this.ctx.clusters?.kind !== 'ok') {
			if (this.ctx.clusters?.kind === 'error') {
				void this.ctx.showError(`Could not list the Redpanda Cloud clusters: ${this.ctx.clusters.message}`);
			}
			return { kind: 'none' };
		}
		const config = configOf();
		if (config) {
			const file = path.basename(config.fsPath);
			// Bug 47: the config's own mapping, or an old one only it could own; one two configs could own is not used.
			const at = await findMapping(config.fsPath, this.ctx.workspaceFolders(), mappedTagOf(this.ctx));
			const mappingName = path.basename(at.file);
			// With `pickAfterGone`, a message is followed by it and the pick; else a gone cluster or pipeline stops there.
			const then = (message: string) => (how.pickAfterGone ? `${message} ${how.pickAfterGone}` : message);
			const read = at.kind === 'own' ? at.read : { kind: 'none' as const };
			if (at.kind === 'shared') {
				const why = `${sharedMappingText(at, config.fsPath)}.`;
				this.ctx.log(`Redpanda Cloud: ${why}`);
				void this.ctx.showInfo(then(why));
			} else if (read.kind === 'bad') {
				// Bug 48: said before the pick for every caller (Delete, Start and Stop too).
				this.ctx.log(`Redpanda Cloud: ${at.file} could not be read as a deploy mapping: ${read.reason}`);
				void this.ctx.showInfo(then(`${mappingName} could not be read as a deploy mapping: ${read.reason}.`));
			} else if (read.kind === 'ok') {
				const mapped = await mappedPipeline(this.ctx, read.mapping);
				if (mapped.kind === 'found') {
					return { kind: 'target', cluster: mapped.cluster, dp: mapped.dp, pipeline: mapped.pipeline };
				}
				if (mapped.kind === 'failed') {
					return { kind: 'failed', message: mapped.message };
				}
				void this.ctx.showInfo(then(mappingGoneText(mapped, read.mapping, mappingName, file)));
				if (!how.pickAfterGone) {
					return { kind: 'none' };
				}
			}
		}
		const clusters = this.ctx.clusters.value.filter((c) => this.ctx.dataplaneUrlOf(c));
		await Promise.all(clusters.map((c) => this.ctx.loadPipelines(c.id, true)));
		this.ctx.fire();
		const choices: PipelineChoice[] = [];
		const unread: string[] = [];
		for (const c of how.byName ? [...clusters].sort((a, b) => byName(a.name, b.name)) : clusters) {
			const listed = this.ctx.pipelines.get(c.id);
			if (listed?.kind !== 'ok') {
				unread.push(`${c.name} (${listed?.kind === 'error' ? listed.message : 'not read'})`);
				continue;
			}
			const pipelines = how.byName ? [...listed.value].sort((a, b) => byName(a.displayName, b.displayName)) : listed.value;
			choices.push(...pipelines.map((pipeline) => ({
				cluster: c, pipeline, label: this.ctx.mask(pipeline.displayName), description: this.ctx.mask(how.describe(c, pipeline)),
			})));
		}
		if (choices.length === 0) {
			void this.ctx.showInfo(`No pipeline on the clusters to ${how.nothingTo}.${unread.length > 0 ? ` Could not list the pipelines of ${unread.join(', ')}.` : ''}`);
			return { kind: 'none' };
		}
		const picked = await this.ctx.ui.pickPipeline(choices, how.title);
		return picked ? { kind: 'target', cluster: picked.cluster, dp: this.ctx.dataplaneUrlOf(picked.cluster), pipeline: picked.pipeline } : { kind: 'none' };
	}

	/** The target, when its state offers the action; else said so and nothing is sent. */
	private offered(action: 'start' | 'stop', target: ActionTarget): ActionTarget | PipelineActionResult {
		const { cluster, pipeline } = target;
		const state = pipeline.state;
		const refused = action === 'start' && !canStart(state) ? 'only a stopped, failed or completed pipeline can be started'
			: action === 'stop' && !canStop(state) ? 'only a running or starting pipeline can be stopped' : undefined;
		if (!refused) {
			return target;
		}
		void this.ctx.showInfo(`Pipeline ${pipeline.displayName} on ${cluster.name} is ${stateWord(state)}: ${refused}.`);
		return { kind: 'notOffered', state, pipelineId: pipeline.id };
	}

	/**
	 * Reads the pipeline now (the view's state can be stale), checks its state offers the action, then
	 * `PUT …/start` or `…/stop` and its state followed from the state read; a failure is shown and the
	 * cluster's pipelines read again.
	 */
	private async startOrStop(action: 'start' | 'stop', target: ActionTarget): Promise<PipelineActionResult> {
		const { cluster, dp } = target;
		const on = `on ${cluster.name}`;
		let pipeline: CloudPipeline;
		try {
			pipeline = await getPipeline(this.ctx.call(), dp, target.pipeline.id);
		} catch (err) {
			const message = describeCloudError(asCloudError(err));
			this.ctx.log(`Redpanda Cloud: could not ${action} pipeline ${target.pipeline.displayName} ${on}: ${message}`);
			this.ctx.showErrorOfferingConnect(`Could not ${action} pipeline ${target.pipeline.displayName} ${on}: ${message}`, err);
			await this.ctx.loadPipelines(cluster.id, true);
			this.ctx.fire();
			return { kind: 'failed', message, pipelineId: target.pipeline.id };
		}
		this.ctx.upsertPipeline(cluster.id, pipeline);
		const allowed = this.offered(action, { ...target, pipeline });
		if (!('pipeline' in allowed)) {
			return allowed;
		}
		const name = pipeline.displayName;
		const text = ACTION_TEXT[action];
		let cause: unknown;
		let accepted = false;
		const result = await this.ctx.ui.progress(`${text.progress} ${name} on ${cluster.name}`, async (report): Promise<DeployResult> => {
			report(`${text.progress.toLowerCase()} the pipeline…`);
			let current: CloudPipeline;
			try {
				current = await (action === 'start' ? startPipeline : stopPipeline)(this.ctx.call(), dp, pipeline.id);
			} catch (err) {
				cause = err;
				return { kind: 'failed', message: describeCloudError(asCloudError(err)), pipelineId: pipeline.id };
			}
			accepted = true;
			this.ctx.log(`Redpanda Cloud: ${text.done.toLowerCase()} pipeline ${name} (${pipeline.id}) on ${cluster.name}; it is ${stateWord(current.state)}.`);
			this.ctx.upsertPipeline(cluster.id, current);
			return this.ctx.follow(cluster, dp, current, name, report, { from: pipeline.state, waiting: `${text.progress.toLowerCase()}…` }, (err) => {
				cause = err;
			});
		});
		switch (result.kind) {
			case 'failed': {
				const shown = accepted
					? `${text.done} pipeline ${name} ${on}, but its state could not be read: ${asCloudError(cause).message}`
					: `Could not ${action} pipeline ${name} ${on}: ${result.message}`;
				this.ctx.log(`Redpanda Cloud: ${shown}`);
				this.ctx.showErrorOfferingConnect(shown, cause);
				await this.ctx.loadPipelines(cluster.id, true);
				this.ctx.fire();
				break;
			}
			case 'timedOut': {
				const still = stillText(name, on, this.ctx.timeoutMs, { still: text.ongoing });
				this.ctx.log(still.log);
				void this.ctx.showInfo(still.info);
				break;
			}
			case 'final':
				if (result.state === 'STATE_ERROR') {
					const reason = result.error ?? NO_REASON;
					this.ctx.log(`Redpanda Cloud: pipeline ${name} ${on} is in Error: ${reason}`);
					this.ctx.showErrorWithLogs(`Pipeline ${name} ${on} is in Error: ${reason}.`, cluster, result.pipelineId, name);
				} else {
					this.ctx.log(`Redpanda Cloud: pipeline ${name} (${result.pipelineId}) ${on} is ${pipelineStateText(result.state)}.`);
					void this.ctx.showInfo(`Pipeline ${name} ${on} is ${stateWord(result.state)}.`);
				}
				break;
			default:
				break;
		}
		return result;
	}

	/**
	 * The `.cloud.json` files that map a config to `pipeline`: of the configs its `rpcn-vscode/config`
	 * tag can name (only inside a workspace folder) and of the active config, each config's own mapping
	 * or the old one only it could own (bug 47; one two configs could own is not used), each kept only
	 * when it parses and names this cluster and pipeline.
	 */
	private async mappingsOf(cluster: CloudCluster, pipeline: CloudPipeline, config: vscode.Uri | undefined): Promise<string[]> {
		const candidates = new Set<string>();
		const configs = [...(config ? [config.fsPath] : []), ...taggedConfigs(pipeline.tags[CONFIG_TAG], this.ctx.workspaceFolders())];
		for (const c of new Set(configs)) {
			const at = await findMapping(c, this.ctx.workspaceFolders(), mappedTagOf(this.ctx));
			if (at.kind === 'own') {
				candidates.add(at.file);
			} else if (await mapsTo(at.file, cluster.id, pipeline.id)) {
				this.ctx.log(`Redpanda Cloud: ${sharedMappingText(at, c)}; it is not deleted with ${pipeline.displayName}.`);
			}
		}
		const out: string[] = [];
		for (const file of candidates) {
			if (await mapsTo(file, cluster.id, pipeline.id)) {
				out.push(file);
			}
		}
		return out;
	}

	/** Delete pipeline…: a modal confirmation; `DELETE`, then followed until a GET answers 404; its `.cloud.json` deleted too. */
	private async deleteTarget(target: ActionTarget): Promise<PipelineActionResult> {
		const { cluster, dp, pipeline } = target;
		const name = pipeline.displayName;
		const on = `on ${cluster.name}`;
		const mappings = await this.mappingsOf(cluster, pipeline, target.config);
		const shown = mappings.map((f) => vscode.workspace.asRelativePath(f));
		const mapped = shown.length === 0 ? ''
			: ` ${shown.join(' and ')}, which ${shown.length === 1 ? 'maps a config' : 'map configs'} to it, ${shown.length === 1 ? 'is' : 'are'} deleted too; the config${shown.length === 1 ? ' is' : 's are'} not changed.`;
		const choice = await this.ctx.ui.confirm(this.ctx.mask(`Delete ${name} ${on}? This cannot be undone.${mapped}`), DELETE_ACTION);
		if (choice !== DELETE_ACTION) {
			return NOT_STARTED;
		}
		let cause: unknown;
		const outcome = await this.ctx.ui.progress(`Deleting ${name} ${on}`, async (report): Promise<'deleted' | 'alreadyGone' | 'timedOut' | { failed: string; sent: boolean }> => {
			report('deleting the pipeline…');
			try {
				await deletePipeline(this.ctx.call(), dp, pipeline.id);
			} catch (err) {
				const error = asCloudError(err);
				if (error.status === 404) {
					return 'alreadyGone';
				}
				cause = err;
				return { failed: describeCloudError(error), sent: false };
			}
			this.ctx.log(`Redpanda Cloud: deleted pipeline ${name} (${pipeline.id}) ${on}.`);
			// Followed until a GET answers 404.
			return pollPipeline<'deleted' | 'timedOut' | { failed: string; sent: boolean }>({
				call: () => this.ctx.call(), dp, id: () => pipeline.id, name, timeoutMs: this.ctx.timeoutMs, pollMs: this.ctx.pollMs,
				log: (line) => this.ctx.log(line), report,
				deadline: 'afterRead',
				read: (still) => this.ctx.upsertPipeline(cluster.id, still),
				progress: () => 'waiting for it to go…',
				notFound: () => 'deleted',
				failed: (error) => ({ failed: `it was deleted, but its state could not be read: ${error.message}`, sent: true }),
				timedOut: () => 'timedOut',
			});
		});
		if (typeof outcome === 'object' && !outcome.sent) {
			this.ctx.log(`Redpanda Cloud: could not delete pipeline ${name} ${on}: ${outcome.failed}`);
			this.ctx.showErrorOfferingConnect(`Could not delete pipeline ${name} ${on}: ${outcome.failed}`, cause);
			await this.ctx.loadPipelines(cluster.id, true);
			this.ctx.fire();
			return { kind: 'failed', message: outcome.failed, pipelineId: pipeline.id };
		}
		// The DELETE was accepted (or the pipeline was gone already): its mapping goes with it.
		const removed = await this.deleteMappings(mappings, cluster, pipeline);
		const also = removed.length > 0 ? ` Deleted ${removed.map((f) => vscode.workspace.asRelativePath(f)).join(' and ')}.` : '';
		if (outcome === 'deleted' || outcome === 'alreadyGone') {
			this.ctx.removePipeline(cluster.id, pipeline.id);
			if (outcome === 'alreadyGone') {
				this.ctx.log(`Redpanda Cloud: pipeline ${name} (${pipeline.id}) was already gone from ${cluster.name}.`);
				void this.ctx.showInfo(`Pipeline ${name} was already gone from ${cluster.name}; it is removed from the view.${also}`);
			} else {
				void this.ctx.showInfo(`Deleted pipeline ${name} ${on}.${also}`);
			}
			return { kind: 'deleted', pipelineId: pipeline.id, alreadyGone: outcome === 'alreadyGone', mappings: removed };
		}
		await this.ctx.loadPipelines(cluster.id, true);
		this.ctx.fire();
		if (outcome === 'timedOut') {
			const still = stillText(name, on, this.ctx.timeoutMs, { listedAfterDelete: true, also });
			this.ctx.log(still.log);
			void this.ctx.showInfo(still.info);
			return { kind: 'timedOut', pipelineId: pipeline.id };
		}
		this.ctx.log(`Redpanda Cloud: pipeline ${name} ${on}: ${outcome.failed}`);
		void this.ctx.showError(`Pipeline ${name} ${on}: ${outcome.failed}.${also}`);
		return { kind: 'failed', message: outcome.failed, pipelineId: pipeline.id };
	}

	/** Deletes each mapping that still names this cluster and pipeline; the ones deleted. */
	private async deleteMappings(files: readonly string[], cluster: CloudCluster, pipeline: CloudPipeline): Promise<string[]> {
		const removed: string[] = [];
		for (const file of files) {
			if (!(await mapsTo(file, cluster.id, pipeline.id))) {
				continue;
			}
			try {
				await fs.promises.rm(file);
				removed.push(file);
				this.ctx.log(`Redpanda Cloud: deleted ${file}, the mapping to the deleted pipeline ${pipeline.displayName} (${pipeline.id}).`);
			} catch (err) {
				this.ctx.log(`Redpanda Cloud: could not delete ${file}: ${reasonOf(err)}`);
				void this.ctx.showError(`Could not delete ${path.basename(file)}: ${reasonOf(err)}. It maps a config to the deleted pipeline ${pipeline.displayName}.`);
			}
		}
		return removed;
	}

	// --- the deployed config, compare, deploy again and copy ID (ticket 5.5) ---

	/** Open deployed config, Compare, Deploy again or Copy pipeline ID on a pipeline row. Never throws. */
	async rowAction(action: 'open' | 'compare' | 'deployAgain' | 'copyId', node?: CloudNode): Promise<RowActionResult> {
		try {
			if (node?.kind !== 'pipeline') {
				void this.ctx.showInfo('Choose a pipeline in the Cloud view.');
				return NOT_STARTED;
			}
			await this.ctx.ready;
			if (!this.ctx.account) {
				// Offered as Deploy does; a new connection reads the view afresh, so nothing is sent for this row.
				const choice = await this.ctx.showInfo(NOT_CONNECTED_MESSAGE, CONNECT_ACTION);
				if (choice === CONNECT_ACTION) {
					await this.ctx.connect();
				}
				return NOT_STARTED;
			}
			const cluster = this.ctx.clusterById(node.clusterId);
			const dp = cluster && this.ctx.dataplaneUrlOf(cluster);
			const pipeline = this.ctx.pipelineById(node.clusterId, node.id);
			if (!cluster || !dp || !pipeline) {
				void this.ctx.showInfo('That pipeline is no longer in the Cloud view. Refresh the view to read the pipelines again.');
				return NOT_STARTED;
			}
			const target: ActionTarget = { cluster, dp, pipeline };
			switch (action) {
				case 'open':
					return await this.openDeployed(target);
				case 'compare':
					return await this.compare(target);
				case 'deployAgain':
					return await this.deployAgain(target);
				case 'copyId':
					await vscode.env.clipboard.writeText(pipeline.id);
					this.ctx.log(`Redpanda Cloud: copied the ID of pipeline ${pipeline.displayName} (${pipeline.id}) on ${cluster.name}.`);
					void this.ctx.showInfo(`Copied the ID of ${pipeline.displayName}.`);
					return { kind: 'copied', pipelineId: pipeline.id };
			}
		} catch (err) {
			const message = this.ctx.mask(reasonOf(err));
			this.ctx.log(`Redpanda Cloud: ${ROW_ACTION_TEXT[action]} failed: ${message}`);
			void this.ctx.showError(`${ROW_ACTION_TEXT[action]} failed: ${message}`);
			return { kind: 'failed', message };
		}
	}

	/** `GET` the pipeline now; a 404 is said ("gone") and the cluster's pipelines read again; other errors are shown by `readPipeline`. */
	private async readNow(target: ActionTarget): Promise<CloudPipeline | RowActionResult> {
		const { cluster, dp, pipeline } = target;
		const read = await this.ctx.readPipeline(cluster, dp, pipeline.id, pipeline.displayName);
		if (read.kind === 'ok') {
			return read.value;
		}
		if (read.status !== 404) {
			return { kind: 'failed', message: read.message, pipelineId: pipeline.id };
		}
		this.ctx.log(`Redpanda Cloud: pipeline ${pipeline.displayName} (${pipeline.id}) is gone from ${cluster.name}.`);
		void this.ctx.showInfo(`Pipeline ${pipeline.displayName} is gone from ${cluster.name}; the Cloud view reads its pipelines again.`);
		this.ctx.removePipeline(cluster.id, pipeline.id);
		await this.ctx.loadPipelines(cluster.id, true);
		this.ctx.fire();
		return { kind: 'gone', pipelineId: pipeline.id };
	}

	/** Puts `text` behind a `redpanda-cloud:` URI and waits (briefly) until an open document of it shows it. */
	private async setDeployed(uri: vscode.Uri, text: string): Promise<void> {
		this.ctx.deployedConfigs.set(uri.toString(), text);
		const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
		if (!open || open.getText() === text) {
			this.ctx.deployedChanged.fire(uri);
			return;
		}
		const updated = new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				sub.dispose();
				resolve();
			}, 2_000);
			const sub = vscode.workspace.onDidChangeTextDocument((e) => {
				if (e.document.uri.toString() === uri.toString() && e.document.getText() === text) {
					clearTimeout(timer);
					sub.dispose();
					resolve();
				}
			});
		});
		this.ctx.deployedChanged.fire(uri);
		await updated;
	}

	/** Open deployed config: read now, shown read-only as "<name> (deployed)". */
	private async openDeployed(target: ActionTarget): Promise<RowActionResult> {
		const read = await this.readNow(target);
		if (!('configYaml' in read)) {
			return read;
		}
		const uri = deployedViewUri(target.cluster.id, read.id, read.displayName);
		await this.setDeployed(uri, read.configYaml);
		let doc = await vscode.workspace.openTextDocument(uri);
		if (doc.languageId !== 'yaml') {
			doc = await vscode.languages.setTextDocumentLanguage(doc, 'yaml');
		}
		await vscode.window.showTextDocument(doc, { preview: true });
		this.ctx.log(`Redpanda Cloud: opened the deployed config of pipeline ${read.displayName} (${read.id}) on ${target.cluster.name}.`);
		return { kind: 'opened', pipelineId: read.id, uri: uri.toString() };
	}

	/**
	 * The row's local file, or said why there is none (`what`: what needs it). Bug 47: a tag naming
	 * files in more than one folder is never resolved alone: the user picks one (cancelled: nothing done).
	 */
	private async localFileFor(pipeline: CloudPipeline, what: string): Promise<string | RowActionResult> {
		const local = this.ctx.localFileOf(pipeline);
		if (local.kind === 'ok') {
			return local.path;
		}
		if (local.kind === 'ambiguous') {
			// Each choice carries its file: shown by its tag here, with its path when two would read the same.
			const folders = this.ctx.workspaceFolders();
			const tags = local.paths.map((f) => configTag(f, folders));
			const offered = local.paths.map((file, i) => ({
				file, label: tags.filter((t) => t === tags[i]).length > 1 ? `${tags[i]} (${file})` : tags[i],
			}));
			const choice = await this.ctx.ui.pickChoice(`${ROW_ACTION_TEXT[what === 'deploy' ? 'deployAgain' : 'compare']}: ${pipeline.displayName}`, this.ctx.mask(
				`Pipeline ${pipeline.displayName} was deployed from ${local.tag}, which is ${IN_SEVERAL_FOLDERS}. Which file to ${what}?`), offered.map((o) => o.label));
			return offered.find((o) => o.label === choice)?.file ?? NOT_STARTED;
		}
		void this.ctx.showInfo(local.kind === 'outside'
			? `Pipeline ${pipeline.displayName} was deployed from ${local.tag}, which is ${NOT_IN_WORKSPACE}, so there is no local file to ${what}.`
			: `Pipeline ${pipeline.displayName} names no file it was deployed from, so there is no local file to ${what}.`);
		return { kind: 'notInWorkspace', pipelineId: pipeline.id };
	}

	/**
	 * Compare with the local file: the deployed config (read now) ↔ the local file as Deploy would send it
	 * (bug 48: translated, so a `${VAR}` sent as `${secrets.VAR}` is no change), both read-only; the file
	 * is edited in its own editor. A translation Deploy would refuse is said as Deploy says it, nothing opened.
	 */
	private async compare(target: ActionTarget): Promise<RowActionResult> {
		const file = await this.localFileFor(target.pipeline, 'compare with');
		if (typeof file !== 'string') {
			return file;
		}
		const name = path.basename(file);
		// Deploy saves an edited file first, so unsaved edits are what it would send; else the saved file.
		const fileUri = vscode.Uri.file(file).toString();
		const edited = vscode.workspace.textDocuments.find((d) => d.isDirty && d.uri.toString() === fileUri);
		let source: string;
		try {
			source = edited ? edited.getText() : await fs.promises.readFile(file, 'utf8');
		} catch (err) {
			this.ctx.log(`Redpanda Cloud: did not compare ${file}: it could not be read: ${reasonOf(err)}`);
			void this.ctx.showError(`Could not read ${name}: ${reasonOf(err)}. Nothing was compared.`);
			return NOT_STARTED;
		}
		const translation = translateForCloud(source);
		if (translation.kind === 'refused') {
			const { problems } = translation;
			this.ctx.log(`Redpanda Cloud: did not compare ${file}: ${problems.length === 1 ? 'one problem' : `${problems.length} problems`} for Redpanda Cloud.`);
			problems.forEach((p) => this.ctx.log(`  ${file}: ${p.message}`));
			void this.ctx.showError(`${refusedText(name, problems)}. Nothing was compared.`);
			return NOT_STARTED;
		}
		const read = await this.readNow(target);
		if (!('configYaml' in read)) {
			return read;
		}
		const left = deployedConfigUri(target.cluster.id, read.id, read.displayName);
		// Its own URI: a Deploy's diff open meanwhile keeps the text it asks to confirm.
		const right = compareConfigUri(target.cluster.id, read.id, read.displayName);
		await this.setDeployed(left, read.configYaml);
		await this.setDeployed(right, translation.text);
		await vscode.commands.executeCommand('vscode.diff', left, right, `${read.displayName} (deployed) ↔ ${name} (as sent)`, { preview: true });
		this.ctx.log(`Redpanda Cloud: compared the deployed config of pipeline ${read.displayName} (${read.id}) on ${target.cluster.name} with ${file} as it would be sent (${edited ? 'its unsaved edits included' : 'as saved'}).`);
		return { kind: 'opened', pipelineId: read.id, uri: left.toString() };
	}

	/** Deploy again: the normal Deploy of the row's file, only when its `.cloud.json` maps to this pipeline. */
	private async deployAgain(target: ActionTarget): Promise<RowActionResult> {
		const { cluster, pipeline } = target;
		const file = await this.localFileFor(pipeline, 'deploy');
		if (typeof file !== 'string') {
			return file;
		}
		const name = path.basename(file);
		// Bug 47: the file's own mapping, or an old one only it could own.
		const at = await findMapping(file, this.ctx.workspaceFolders(), mappedTagOf(this.ctx));
		const mappingName = path.basename(at.kind === 'own' ? at.file : at.own);
		if (at.kind === 'shared') {
			const why = sharedMappingText(at, file);
			this.ctx.log(`Redpanda Cloud: did not deploy ${file} again to ${pipeline.displayName} (${pipeline.id}): ${why}.`);
			void this.ctx.showInfo(`${why}. Deploy ${name} from its editor to choose where it goes. Nothing was sent.`);
			return { kind: 'notMapped', pipelineId: pipeline.id };
		}
		const read = at.read;
		if (read.kind === 'ok' && read.mapping.clusterId === cluster.id && read.mapping.pipelineId === pipeline.id) {
			return this.ctx.deploy(vscode.Uri.file(file), { clusterId: cluster.id, pipelineId: pipeline.id, name: pipeline.displayName });
		}
		const why = read.kind === 'none' ? `${name} has no ${mappingName}, so a Deploy of it would not update ${pipeline.displayName}`
			: read.kind === 'bad' ? `${mappingName} could not be read as a deploy mapping: ${read.reason}`
				: `${mappingName} maps ${name} to pipeline ${read.mapping.pipelineName ?? read.mapping.pipelineId}`
					+ `${read.mapping.clusterId === cluster.id ? '' : ` on ${this.ctx.clusterById(read.mapping.clusterId)?.name ?? read.mapping.clusterName ?? read.mapping.clusterId}`}, not to ${pipeline.displayName} on ${cluster.name}`;
		this.ctx.log(`Redpanda Cloud: did not deploy ${file} again to ${pipeline.displayName} (${pipeline.id}): ${why}.`);
		void this.ctx.showInfo(`${why}. Deploy ${name} from its editor to choose where it goes. Nothing was sent.`);
		return { kind: 'notMapped', pipelineId: pipeline.id, ...(read.kind === 'ok' ? { mapping: read.mapping } : {}) };
	}
}

/** Open deployed config's read-only document, titled "<name> (deployed)" (its language set to YAML). */
export function deployedViewUri(clusterId: string, pipelineId: string, name: string): vscode.Uri {
	const safe = name.replace(/[/\\]+/g, '_').trim() || pipelineId;
	return vscode.Uri.from({ scheme: DEPLOYED_SCHEME, path: `/${clusterId}/${pipelineId}/${safe} (deployed)` });
}

/** Whether `file` is a deploy mapping naming this cluster and pipeline. */
async function mapsTo(file: string, clusterId: string, pipelineId: string): Promise<boolean> {
	const read = await readMapping(file);
	return read.kind === 'ok' && read.mapping.clusterId === clusterId && read.mapping.pipelineId === pipelineId;
}

const ACTION_TEXT: Record<PipelineAction, { readonly title: string; readonly progress: string; readonly ongoing: string; readonly failed: string; readonly done: string }> = {
	start: { title: 'Start pipeline', progress: 'Starting', ongoing: 'starting', failed: 'Start', done: 'Started' },
	stop: { title: 'Stop pipeline', progress: 'Stopping', ongoing: 'stopping', failed: 'Stop', done: 'Stopped' },
	delete: { title: 'Delete pipeline', progress: 'Deleting', ongoing: 'being deleted', failed: 'Delete', done: 'Deleted' },
};

const ROW_ACTION_TEXT: Record<'open' | 'compare' | 'deployAgain' | 'copyId', string> = {
	open: 'Open deployed config',
	compare: 'Compare with local file',
	deployAgain: 'Deploy local file again',
	copyId: 'Copy pipeline ID',
};
