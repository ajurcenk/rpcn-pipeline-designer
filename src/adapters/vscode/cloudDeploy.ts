// The deploy flow of the Cloud view (tickets 5.2, 5.3, 5.6, 5.7, 8; AD-23): Deploy to Redpanda Cloud, from the
// saved and translated file through the pre-deploy check and the missing secrets to the create or update and
// its state followed (see `cloudView.ts` for the behaviour). Built by `CloudView` only; it reaches the view's
// account, cache, prompts and messages through `CloudContext`.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CloudCluster } from '../cloud/controlPlane';
import {
	CONFIG_TAG, type CloudPipeline, type PipelineResources, type PipelineState, type CreatePipeline, createPipeline, FINAL_STATES,
	createSecret, getComponents, getPipeline, isKnownState, isRunning, listSecretNames, pipelineStateText, resourcesText, sameResources,
	type UpdatePipeline, updatePipeline,
} from '../cloud/dataPlane';
import { asCloudError, describeCloudError, hintLines } from '../cloud/errors';
import { configTag, type DeployMapping, folderOf, serializeMapping, sidecarPath, tagNames } from '../cloud/sidecar';
import { type CloudSecretUse, translateForCloud } from '../../core/cloudTranslate';
import { documentBloblangCalls } from '../../core/bloblang';
import { checkAgainstCluster, type ClusterComponents, findingMessage, lineOf, versionsDiffer } from '../../core/cloudCheck';
import { componentUses } from '../../core/graph';
import { parseYaml } from '../../core/yamlPath';
import type { LintResult } from '../redpandaConnect/lint';
import type { CloudContext, DeployResult } from './cloudView';
import type { LocalValue } from './environmentView';
import {
	CONNECT_ACTION, deployedConfigUri, filesOfTag, findMapping, MAX_POLL_FAILURES, NO_REASON, NOT_CONNECTED_MESSAGE, NOT_STARTED, reasonOf,
	mappedTagOf, refusedText, sentConfigUri, sharedMappingText, sleep, stateWord,
} from './cloudShared';

export { sentConfigUri } from './cloudShared';

export const DEPLOY_UNTITLED_MESSAGE = 'Save the file to deploy it.';
export const DEPLOY_NOT_DETECTED_MESSAGE = 'This file is not a Redpanda Connect config.';
export const DEPLOY_NOT_ON_DISK_MESSAGE = 'Deploy needs a file on disk.';

/** The confirmation of an update that restarts a running pipeline. */
export const REPLACE_ACTION = 'Replace and restart';
/** No mapping, a pipeline on the cluster tagged with this file: create another instead of updating it. */
export const CREATE_NEW_ACTION = 'Create new';
/** The mapped pipeline or cluster is gone. */
export const CREATE_NEW_PIPELINE_ACTION = 'Create a new pipeline';
/** Bug 47: an old `<stem>.cloud.json` that two configs could own is not used; bug 48: nor one that can't be read. Deploy without it. */
export const DEPLOY_WITHOUT_ACTION = 'Deploy without it';
/** Ticket 5.7: a missing cloud secret's choices. */
export const ENTER_ANOTHER_ACTION = 'Enter another value…';
export const USE_DEFAULT_ACTION = "Don't create it (the Cloud uses the default)";
export const ADD_NOW_ACTION = 'Add it now: enter its value…';
export const STOP_DEPLOY_ACTION = "Don't deploy";
/** Ticket 8: the pre-deploy check's way forward despite its findings. */
export const DEPLOY_ANYWAY_ACTION = 'Deploy anyway';
/** Ticket 8: the check's Problems entries (their own collection). */
export const CHECK_SOURCE = 'Redpanda Cloud';
export const CHECK_COLLECTION = 'redpanda-cloud-check';
/** The findings the check's message lists; the rest are counted. */
const MAX_LISTED_FINDINGS = 5;
/** "Keep the value from secret storage". */
export function keepValueAction(local: Pick<LocalValue, 'source' | 'level'>): string {
	return `Keep the value from ${localSourceText(local)}`;
}
/** Where a local value comes from, as the secret question names it. */
export function localSourceText(local: Pick<LocalValue, 'source' | 'level'>): string {
	switch (local.source) {
		case 'secret':
			return 'secret storage';
		case 'setting':
			return `redpandaConnect.env (${local.level ?? 'user'} settings)`;
		case 'envFile':
			return 'the env file';
		case 'process':
			return "VS Code's environment";
		case 'extension':
			return 'the extension';
	}
}

/** Deploy again: the deploy may only update this pipeline (anything else is explained, nothing sent). */
export interface OnlyPipeline {
	readonly clusterId: string;
	readonly pipelineId: string;
	readonly name: string;
}

/** Where a deploy goes: a new pipeline on a cluster, or an existing one replaced. */
type Target =
	| { readonly kind: 'create'; readonly cluster: CloudCluster; readonly dp: string; readonly name: string }
	| { readonly kind: 'update'; readonly cluster: CloudCluster; readonly dp: string; readonly pipeline: CloudPipeline };

/** Deploy to Redpanda Cloud and the state it follows (also for Start and Stop, through the context). */
export class CloudDeploy {
	/** Bug 45: the files (their URIs) whose deploy is running; another Deploy of one is refused. */
	private readonly deploying = new Set<string>();

	constructor(private readonly ctx: CloudContext) {}

	/** Shows `pipeline`'s deployed config beside the text that would be sent (deployed ↔ as sent, both read-only). */
	private async showDiff(cluster: CloudCluster, pipeline: CloudPipeline, sent: string, file: string): Promise<void> {
		const left = deployedConfigUri(cluster.id, pipeline.id, pipeline.displayName);
		const right = sentConfigUri(cluster.id, pipeline.id, pipeline.displayName);
		this.ctx.deployedConfigs.set(left.toString(), pipeline.configYaml);
		this.ctx.deployedConfigs.set(right.toString(), sent);
		this.ctx.deployedChanged.fire(left);
		this.ctx.deployedChanged.fire(right);
		try {
			await vscode.commands.executeCommand('vscode.diff', left, right, `${pipeline.displayName} (deployed) ↔ ${file} (as sent)`, { preview: true });
		} catch (err) {
			this.ctx.log(`Redpanda Cloud: could not open the diff of ${file}: ${reasonOf(err)}`);
		}
	}

	/** Deploy to Redpanda Cloud: `uri` (default: the active editor's file), created or updated. Never throws. */
	async deploy(uri?: vscode.Uri, only?: OnlyPipeline): Promise<DeployResult> {
		try {
			return await this.deployFile(uri, only);
		} catch (err) {
			const message = this.ctx.mask(reasonOf(err));
			this.ctx.log(`Redpanda Cloud: deploy failed: ${message}`);
			void this.ctx.showError(`Deploy failed: ${message}`);
			return { kind: 'failed', message };
		}
	}

	private async deployFile(uri: vscode.Uri | undefined, only?: OnlyPipeline): Promise<DeployResult> {
		const doc = uri
			? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) ?? (uri.scheme === 'file' ? await vscode.workspace.openTextDocument(uri) : undefined)
			: vscode.window.activeTextEditor?.document;
		if (!doc) {
			void this.ctx.showInfo('Open a Redpanda Connect config to deploy it.');
			return NOT_STARTED;
		}
		// Bug 45: one deploy per file at a time (title button, palette and row alike), released however it ends.
		const key = doc.uri.toString();
		if (this.deploying.has(key)) {
			const file = path.basename(doc.uri.fsPath);
			this.ctx.log(`Redpanda Cloud: a deploy of ${file} is already running; this request was ignored.`);
			void this.ctx.showInfo(`A deploy of ${file} is already running; this request was ignored. Nothing was sent.`);
			return NOT_STARTED;
		}
		this.deploying.add(key);
		try {
			return await this.deployDoc(doc, only);
		} finally {
			this.deploying.delete(key);
		}
	}

	private async deployDoc(doc: vscode.TextDocument, only?: OnlyPipeline): Promise<DeployResult> {
		if (doc.isUntitled) {
			void this.ctx.showInfo(DEPLOY_UNTITLED_MESSAGE);
			return NOT_STARTED;
		}
		if (doc.uri.scheme !== 'file') {
			void this.ctx.showInfo(DEPLOY_NOT_ON_DISK_MESSAGE);
			return NOT_STARTED;
		}
		if (!this.ctx.options.isDetected(doc.uri)) {
			void this.ctx.showInfo(DEPLOY_NOT_DETECTED_MESSAGE);
			return NOT_STARTED;
		}
		const file = path.basename(doc.uri.fsPath);
		// The last deploy's check entries go: this deploy checks again.
		this.ctx.checkDiagnostics.delete(doc.uri);
		// Translated before anything is asked or sent, so a refusal costs no prompt and no request; done
		// again just before sending, so edits made during the prompts are sent.
		if ((await this.savedAndTranslated(doc, file)) === undefined) {
			return NOT_STARTED;
		}
		await this.ctx.ready;
		if (!this.ctx.account) {
			const choice = await this.ctx.showInfo(NOT_CONNECTED_MESSAGE, CONNECT_ACTION);
			if (choice !== CONNECT_ACTION || !(await this.ctx.connect())) {
				return NOT_STARTED;
			}
		}
		// Bug 45: the account this deploy runs with; another one (or none) during its prompts stops it before the next send.
		const clientId = this.ctx.account?.clientId;
		const accountChanged = () => this.ctx.account?.clientId !== clientId;
		this.ctx.requested = true;
		await this.ctx.loadClusters(false);
		if (this.ctx.clusters?.kind !== 'ok') {
			// The failure was shown when it was read; a failure kept from before is shown again.
			if (this.ctx.clusters?.kind === 'error') {
				void this.ctx.showError(`Could not list the Redpanda Cloud clusters: ${this.ctx.clusters.message}`);
			}
			return NOT_STARTED;
		}
		// Bug 47: the tag holds no local path, and names the workspace folder in a multi-root workspace.
		const tag = configTag(doc.uri.fsPath, this.ctx.workspaceFolders());
		const at = await findMapping(doc.uri.fsPath, this.ctx.workspaceFolders(), mappedTagOf(this.ctx));
		// The mapping read: the config's own, or an old one only this config owns. A mapping written fresh
		// goes to the config's own name; an old one is left as it is (never renamed or removed).
		const mappingFile = at.kind === 'own' ? at.file : at.own;
		const mappingName = path.basename(mappingFile);
		const ownFile = sidecarPath(doc.uri.fsPath);
		const ownName = path.basename(ownFile);
		const read = at.kind === 'own' ? at.read : { kind: 'none' as const };
		let target: Target | DeployResult;
		if (only && at.kind === 'shared') {
			const why = sharedMappingText(at, doc.uri.fsPath);
			this.ctx.log(`Redpanda Cloud: did not deploy ${file} again to ${only.name}: ${why}.`);
			void this.ctx.showInfo(`${why}. Nothing was sent.`);
			return NOT_STARTED;
		}
		if (only && (read.kind !== 'ok' || read.mapping.clusterId !== only.clusterId || read.mapping.pipelineId !== only.pipelineId)) {
			// Deploy again: the mapping changed since the row's check; nothing else is offered.
			this.ctx.log(`Redpanda Cloud: did not deploy ${file} again to ${only.name}: ${mappingName} no longer maps it to that pipeline.`);
			void this.ctx.showInfo(`${mappingName} no longer maps ${file} to ${only.name}. Nothing was sent.`);
			return NOT_STARTED;
		}
		if (at.kind === 'shared') {
			const why = sharedMappingText(at, doc.uri.fsPath);
			this.ctx.log(`Redpanda Cloud: ${why}.`);
			const choice = await this.ctx.showInfo(
				`${why}. Deploy ${file} without it? Its mapping is then ${ownName}; ${path.basename(at.file)} is not changed.`, DEPLOY_WITHOUT_ACTION);
			target = choice === DEPLOY_WITHOUT_ACTION ? await this.newTarget(file, doc.uri.fsPath, tag, true) : NOT_STARTED;
		} else if (read.kind === 'none') {
			target = await this.newTarget(file, doc.uri.fsPath, tag, true);
		} else if (read.kind === 'bad') {
			// Bug 48: as with no mapping, a pipeline tagged with this file is offered before a new one.
			this.ctx.log(`Redpanda Cloud: ${mappingFile} could not be read as a deploy mapping: ${read.reason}`);
			const choice = await this.ctx.showError(
				`${mappingName} could not be read as a deploy mapping: ${read.reason}. Deploy ${file} without it? ${mappingFile === ownFile
					? `${mappingName} is then replaced.` : `Its mapping is then ${ownName}; ${mappingName} is not changed.`}`, DEPLOY_WITHOUT_ACTION);
			target = choice === DEPLOY_WITHOUT_ACTION ? await this.newTarget(file, doc.uri.fsPath, tag, true) : NOT_STARTED;
		} else {
			target = await this.mappedTarget(file, doc.uri.fsPath, tag, mappingName, read.mapping, only !== undefined);
		}
		if (target.kind !== 'create' && target.kind !== 'update') {
			return target;
		}
		const { cluster, dp } = target;
		const existing = read.kind === 'ok' ? read.mapping : undefined;
		// The size, shown every time: an update pre-set to the deployed pipeline's, a create to 1 unit.
		const resources = await this.ctx.ui.pickUnits(
			`Deploy ${file} to ${cluster.name}: the size of ${target.kind === 'update' ? target.pipeline.displayName : target.name}`,
			target.kind === 'update' ? target.pipeline.resources : undefined);
		if (!resources) {
			return NOT_STARTED;
		}
		if (accountChanged()) {
			return this.stoppedByAccount(file, cluster, []);
		}
		const translated = await this.savedAndTranslated(doc, file);
		if (translated === undefined) {
			return NOT_STARTED;
		}
		const configYaml = translated.text;
		// The check first: when it stops the deploy, nothing at all is sent (no secret either).
		const checked = await this.checkBeforeSending(doc, file, cluster, dp, translated.source);
		if (checked) {
			return checked;
		}
		if (accountChanged()) {
			return this.stoppedByAccount(file, cluster, []);
		}
		const { stopped: secretsStopped, created: createdSecrets } = await this.ensureSecrets(doc.uri, file, cluster, dp, translated.secrets, accountChanged);
		if (secretsStopped) {
			return secretsStopped;
		}
		const created = createdSecrets.length > 0 ? { createdSecrets: [...createdSecrets] } : {};
		// A valid mapping naming these ids is never rewritten.
		const mapTo = async (p: CloudPipeline) => {
			if (existing?.clusterId !== cluster.id || existing.pipelineId !== p.id) {
				await this.writeMapping(ownFile, { clusterId: cluster.id, pipelineId: p.id, clusterName: cluster.name, pipelineName: p.displayName });
			}
		};
		/** The update not sent: the created secrets (if any) stay, said so. */
		const declined = (): DeployResult => {
			this.keptSecrets(createdSecrets, cluster, 'The pipeline was not updated.');
			return { kind: 'notStarted', ...created };
		};
		const sendCreate = async (name: string): Promise<DeployResult> => {
			if (accountChanged()) {
				return this.stoppedByAccount(file, cluster, createdSecrets);
			}
			const result = this.withCreated(await this.ctx.ui.progress(`Deploying ${name} to ${cluster.name}`, (report) =>
				this.createAndFollow(cluster, dp, { displayName: name, configYaml, resources, tags: { [CONFIG_TAG]: tag } }, report, mapTo)), createdSecrets);
			this.report(file, name, cluster, result, 'create');
			return result;
		};

		if (target.kind === 'create') {
			return sendCreate(target.name);
		}

		const same = (p: CloudPipeline) => p.configYaml === configYaml && sameResources(p.resources, resources);
		const unchanged = async (p: CloudPipeline): Promise<DeployResult> => {
			await mapTo(p);
			const list = createdSecrets.join(', ');
			const sent = createdSecrets.length > 0 ? `created ${list} on ${cluster.name}, nothing else was sent` : 'nothing was sent';
			this.ctx.log(`Redpanda Cloud: pipeline ${p.displayName} (${p.id}) on ${cluster.name} already has ${file} as saved and translated (${stateWord(p.state)}), with ${resourcesText(resources)}; ${sent}.`);
			void this.ctx.showInfo(createdSecrets.length > 0
				? `Pipeline ${p.displayName} on ${cluster.name} is already deployed from ${file}, so it was not updated; created ${list} on ${cluster.name}.`
				: `Pipeline ${p.displayName} on ${cluster.name} is already deployed from ${file}, nothing changed.`);
			return { kind: 'unchanged', pipelineId: p.id, ...created };
		};

		const first = target.pipeline;
		// A running pipeline that would change is confirmed as it was read; the pipeline is read again just
		// before the update (bug 45), and only that read decides whether it is unchanged.
		let confirmedRestart = false;
		if (!same(first) && isRunning(first.state)) {
			if (!(await this.confirmReplace(cluster, first, file, configYaml, resources))) {
				return declined();
			}
			confirmedRestart = true;
		}
		if (accountChanged()) {
			return this.stoppedByAccount(file, cluster, createdSecrets);
		}
		const reread = await this.ctx.readPipeline(cluster, dp, first.id, first.displayName);
		if (reread.kind !== 'ok') {
			if (reread.status !== 404) {
				// The read's failure was shown.
				this.keptSecrets(createdSecrets, cluster, 'The pipeline was not updated.');
				return { kind: 'failed', message: reread.message, pipelineId: first.id, ...created };
			}
			// Deleted while the deploy waited: as a mapped pipeline found gone.
			this.ctx.removePipeline(cluster.id, first.id);
			const gone = existing?.clusterId === cluster.id && existing.pipelineId === first.id
				? await this.goneTarget(file, mappingName, existing, cluster, dp, only !== undefined, createdSecrets)
				: this.goneUnmapped(file, first, cluster, createdSecrets);
			if (gone.kind === 'create') {
				return sendCreate(gone.name);
			}
			if (gone.kind === 'update') {
				return NOT_STARTED; // never: a gone pipeline is only offered to be created anew
			}
			return createdSecrets.length > 0 && gone.kind === 'notStarted' ? { ...gone, ...created } : gone;
		}
		const deployed = reread.value;
		if (same(deployed)) {
			return unchanged(deployed);
		}
		const wasRunning = isRunning(deployed.state);
		if (wasRunning && !confirmedRestart) {
			// Started elsewhere while the deploy waited.
			if (!(await this.confirmReplace(cluster, deployed, file, configYaml, resources))) {
				return declined();
			}
			if (accountChanged()) {
				return this.stoppedByAccount(file, cluster, createdSecrets);
			}
		}
		const name = deployed.displayName;
		const update: UpdatePipeline = {
			displayName: name,
			description: deployed.description,
			configYaml,
			resources,
			tags: { ...deployed.tags, [CONFIG_TAG]: tag },
		};
		const change = wasRunning
			? { from: 'STATE_RUNNING', waiting: 'waiting for the restart…' }
			// Bug 45: the answer to an update of a pipeline in Error may still carry its old error.
			: deployed.state === 'STATE_ERROR' ? { from: 'STATE_ERROR', waiting: 'waiting for the update…' } : undefined;
		const result = this.withCreated(await this.ctx.ui.progress(`Updating ${name} on ${cluster.name}`, (report) =>
			this.updateAndFollow(cluster, dp, deployed.id, update, change, report, mapTo)), createdSecrets);
		this.report(file, name, cluster, result, 'update');
		return result;
	}

	/** The diff (a config change) and "Replace and restart" for a running `deployed`; whether it was chosen. */
	private async confirmReplace(cluster: CloudCluster, deployed: CloudPipeline, file: string, configYaml: string, resources: PipelineResources): Promise<boolean> {
		const sameConfig = deployed.configYaml === configYaml;
		const sameSize = sameResources(deployed.resources, resources);
		if (!sameConfig) {
			await this.showDiff(cluster, deployed, configYaml, file);
		}
		const size = sameSize ? '' : `Its size changes from ${resourcesText(deployed.resources)} to ${resourcesText(resources)}.`;
		const what = sameConfig
			? `Changing its size restarts it. ${size}`
			: `Replacing its config with ${file} (the diff shows the changes) restarts it.${size ? ` ${size}` : ''}`;
		const choice = await this.ctx.ui.confirm(this.ctx.mask(`Pipeline ${deployed.displayName} on ${cluster.name} is ${stateWord(deployed.state)}. ${what}`), REPLACE_ACTION);
		return choice === REPLACE_ACTION;
	}

	/** The secrets this deploy created stay although it sent nothing more (`after`: what was not done); said once. */
	private keptSecrets(created: readonly string[], cluster: CloudCluster, after: string): void {
		if (created.length > 0) {
			const kept = `Created ${created.join(', ')} on ${cluster.name}; they stay. ${after}`;
			this.ctx.log(`Redpanda Cloud: ${kept}`);
			void this.ctx.showInfo(kept);
		}
	}

	/** Bug 45: the account changed during the deploy's prompts: stopped before the next send, said so. */
	private stoppedByAccount(file: string, cluster: CloudCluster, created: readonly string[]): DeployResult {
		const kept = created.length > 0 ? ` Created ${created.join(', ')} on ${cluster.name} before that; they stay.` : '';
		const text = `The Redpanda Cloud service account changed during the deploy of ${file}, so the deploy stopped.${kept} Nothing ${created.length > 0 ? 'more ' : ''}was sent.`;
		this.ctx.log(`Redpanda Cloud: ${text}`);
		void this.ctx.showInfo(text);
		return { kind: 'notStarted', ...(created.length > 0 ? { createdSecrets: [...created] } : {}) };
	}

	/** A rejected or failed send carries the secrets created before it (bug 45). */
	private withCreated(result: DeployResult, created: readonly string[]): DeployResult {
		return created.length > 0 && (result.kind === 'rejected' || result.kind === 'failed') ? { ...result, createdSecrets: [...created] } : result;
	}

	/** A pipeline offered by its tag (no mapping) deleted while the deploy waited: said so, nothing sent. */
	private goneUnmapped(file: string, p: CloudPipeline, cluster: CloudCluster, created: readonly string[]): DeployResult {
		this.ctx.log(`Redpanda Cloud: pipeline ${p.displayName} (${p.id}) is gone from ${cluster.name}; ${file} was not deployed.`);
		void this.ctx.showInfo(`Pipeline ${p.displayName} is no longer on ${cluster.name}. ${nothingSent(created, cluster)}`);
		return NOT_STARTED;
	}

	/**
	 * As Run: a dirty config is saved first; the saved file's text, translated for the Cloud (the file
	 * itself is never changed). `undefined`: not saved, or refused (each problem shown and logged).
	 */
	private async savedAndTranslated(doc: vscode.TextDocument, file: string)
		: Promise<{ readonly text: string; readonly secrets: readonly CloudSecretUse[]; readonly source: string } | undefined> {
		if (doc.isDirty && !(await doc.save())) {
			this.ctx.log(`Redpanda Cloud: ${file} could not be saved; not deployed.`);
			void this.ctx.showError(`${file} could not be saved, so it was not deployed.`);
			return undefined;
		}
		const source = await fs.promises.readFile(doc.uri.fsPath, 'utf8');
		const translation = translateForCloud(source);
		if (translation.kind === 'ok') {
			return { text: translation.text, secrets: translation.secrets, source };
		}
		const { problems } = translation;
		this.ctx.log(`Redpanda Cloud: ${file} was not deployed: ${problems.length === 1 ? 'one problem' : `${problems.length} problems`} for Redpanda Cloud.`);
		problems.forEach((p) => this.ctx.log(`  ${file}: ${p.message}`));
		void this.ctx.showError(`${refusedText(file, problems)}. Nothing was sent.`);
		return undefined;
	}

	/**
	 * Ticket 8: the check before sending: the local lint's errors and what `cluster` does not offer of the
	 * saved file's (`source`) components and Bloblang calls; the components list read once, under one
	 * progress. Findings go to the Problems panel and one error message offering Deploy anyway. Returns
	 * how the deploy ended (nothing sent), or `undefined`: it goes on (no finding, or Deploy anyway).
	 */
	private async checkBeforeSending(doc: vscode.TextDocument, file: string, cluster: CloudCluster, dp: string, source: string): Promise<DeployResult | undefined> {
		const { lint, components, listError } = await this.ctx.ui.progress(`Checking ${file} against ${cluster.name}`, async (report) => {
			report('linting the config…');
			let lintResult: LintResult;
			try {
				lintResult = this.ctx.lint ? await this.ctx.lint(doc) : { kind: 'skipped' };
			} catch (err) {
				lintResult = { kind: 'failed', logLine: `Lint ${file}: ${reasonOf(err)}` };
			}
			report('reading the cluster\'s components…');
			try {
				return { lint: lintResult, components: await getComponents(this.ctx.call(), dp) as ClusterComponents | undefined, listError: undefined };
			} catch (err) {
				return { lint: lintResult, components: undefined, listError: err };
			}
		});
		const lintErrors: { line: number; message: string }[] = [];
		if (lint.kind === 'skipped') {
			this.ctx.log(`Redpanda Cloud: no usable local Redpanda Connect binary, so ${file} was not linted before the deploy; the check against ${cluster.name} still runs.`);
		} else if (lint.kind === 'failed') {
			this.ctx.log(lint.logLine);
			this.ctx.log(`Redpanda Cloud: ${file} could not be linted before the deploy; the check against ${cluster.name} still runs.`);
		} else {
			lint.logLines.forEach((l) => this.ctx.log(l));
			for (const f of lint.findings) {
				if (f.severity !== 'warning') {
					lintErrors.push({ line: f.line, message: f.message });
				}
			}
		}
		const cloudFindings = components ? (() => {
			const parsed = parseYaml(source);
			const catalogue = this.ctx.localCatalogue() ?? components.catalogue;
			return checkAgainstCluster(source, componentUses(parsed, source, catalogue), documentBloblangCalls(parsed, source), components, cluster.name);
		})() : [];
		const findings = [
			...lintErrors.map((f) => ({ line: f.line, text: f.message, range: undefined as [number, number] | undefined })),
			...cloudFindings.map((f) => ({ line: f.line, text: f.text, range: [f.start, f.end] as [number, number] | undefined })),
		].sort((a, b) => a.line - b.line);
		const listMessage = listError ? asCloudError(listError).message : undefined;
		if (findings.length === 0 && listMessage === undefined) {
			return undefined;
		}
		this.ctx.checkDiagnostics.set(doc.uri, findings.map((f) => {
			const diagnostic = new vscode.Diagnostic(f.range ? rangeOf(source, f.range[0], f.range[1]) : lineRange(source, f.line), f.text, vscode.DiagnosticSeverity.Error);
			diagnostic.source = CHECK_SOURCE;
			return diagnostic;
		}));
		const messages = findings.map((f) => findingMessage(f));
		const clusterVersion = components?.version ?? cluster.connectVersion;
		const localVersion = this.ctx.localVersion();
		const versions = versionsDiffer(clusterVersion, localVersion)
			? ` ${cluster.name} runs Redpanda Connect ${clusterVersion}; this machine has ${localVersion}.` : '';
		const listed = messages.length > MAX_LISTED_FINDINGS
			? `${messages.slice(0, MAX_LISTED_FINDINGS).join('; ')}; and ${messages.length - MAX_LISTED_FINDINGS} more (see the Problems panel)`
			: messages.join('; ');
		let message: string;
		if (listMessage !== undefined) {
			this.ctx.log(`Redpanda Cloud: could not read the components of ${cluster.name}: ${listMessage}`);
			message = `Could not read the components of ${cluster.name}, so ${file} was not checked against it: ${listMessage}.`
				+ `${messages.length > 0 ? ` The local lint found: ${listed}.` : ''}${versions} Nothing was sent.`;
		} else {
			message = `${file} may not run on ${cluster.name}: ${listed}.${versions} Nothing was sent.`;
		}
		this.ctx.log(`Redpanda Cloud: the check of ${file} against ${cluster.name} found ${messages.length === 1 ? 'one problem' : `${messages.length} problems`}.`);
		messages.forEach((m) => this.ctx.log(`  ${file}: ${m}`));
		const choice = await this.ctx.showError(message, DEPLOY_ANYWAY_ACTION);
		if (choice === DEPLOY_ANYWAY_ACTION) {
			this.ctx.log(`Redpanda Cloud: deploying ${file} to ${cluster.name} anyway.`);
			return undefined;
		}
		this.ctx.log(`Redpanda Cloud: ${file} was not deployed to ${cluster.name}; nothing was sent.`);
		return { kind: 'checkStopped', findings: messages.map((m) => this.ctx.mask(m)), ...(listMessage !== undefined ? { listError: this.ctx.mask(listMessage) } : {}) };
	}

	/**
	 * Masks `value` (and its base64 form, as sent) from now on; called just before it is sent, so a
	 * value not sent is never masked (bug 44). A value under 4 characters is masked in Cloud API error
	 * text only (`sentSecrets`, http.ts).
	 */
	private maskValue(value: string): void {
		if (value) {
			this.ctx.sentSecrets.add(value);
			this.ctx.seenSecrets.add(value);
			this.ctx.seenSecrets.add(Buffer.from(value, 'utf8').toString('base64'));
		}
	}

	/**
	 * Ticket 5.7: the secrets the config references that `cluster` lacks, asked about one at a time and
	 * created from the answers. `stopped`: how the deploy ended (nothing more sent), none: it goes on;
	 * `created`: the secrets this deploy created.
	 */
	private async ensureSecrets(uri: vscode.Uri, file: string, cluster: CloudCluster, dp: string, secrets: readonly CloudSecretUse[], accountChanged: () => boolean)
		: Promise<{ readonly stopped?: DeployResult; readonly created: string[] }> {
		const created: string[] = [];
		if (secrets.length === 0) {
			return { created };
		}
		let existing: Set<string>;
		try {
			existing = await this.ctx.ui.progress(`Checking the secrets of ${file} on ${cluster.name}`, (report) => {
				report('reading the cluster\'s secrets…');
				return listSecretNames(this.ctx.call(), dp, cluster.name);
			});
		} catch (err) {
			const message = asCloudError(err).message;
			this.ctx.log(`Redpanda Cloud: could not read the secrets of ${cluster.name}: ${message}`);
			this.ctx.showErrorOfferingConnect(`Could not read the secrets of ${cluster.name}: ${message}. Nothing was sent.`, err);
			return { stopped: { kind: 'failed', message: this.ctx.mask(`could not read the secrets of ${cluster.name}: ${message}`) }, created };
		}
		const missing = secrets.filter((s) => !existing.has(s.name));
		if (missing.length === 0) {
			return { created };
		}
		let local: ReadonlyMap<string, LocalValue>;
		try {
			local = this.ctx.options.localValues?.(uri, missing.map((s) => s.name)) ?? new Map<string, LocalValue>();
		} catch (err) {
			this.ctx.log(`Redpanda Cloud: could not read the local values of ${file}: ${reasonOf(err)}`);
			local = new Map<string, LocalValue>();
		}
		const stopped = (name: string): DeployResult => {
			this.ctx.log(`Redpanda Cloud: the deploy of ${file} stopped at the secret ${name}; nothing more was sent.`);
			this.keptSecrets(created, cluster, 'The pipeline was not sent.');
			return created.length > 0 ? { kind: 'notStarted', createdSecrets: [...created] } : NOT_STARTED;
		};
		const title = (name: string) => `Deploy ${file} to ${cluster.name}: the secret ${name}`;
		for (const s of missing) {
			const v = local.get(s.name);
			let value: string | undefined;
			if (v) {
				const keep = keepValueAction(v);
				const choices = [keep, ENTER_ANOTHER_ACTION, ...(s.required ? [] : [USE_DEFAULT_ACTION])];
				const choice = await this.ctx.ui.pickChoice(title(s.name), this.ctx.mask(
					`${cluster.name} has no secret ${s.name}, which ${file} uses${s.required ? '' : ' (with a default)'}. ${s.name} is set in ${localSourceText(v)}.`), choices);
				if (choice === USE_DEFAULT_ACTION) {
					this.ctx.log(`Redpanda Cloud: the secret ${s.name} was not created on ${cluster.name}; the pipeline uses its default.`);
					continue;
				}
				if (choice === keep) {
					value = v.value;
				} else if (choice === ENTER_ANOTHER_ACTION) {
					value = await this.askSecretValue(s.name, cluster, file);
				}
			} else if (s.required) {
				const choice = await this.ctx.ui.pickChoice(title(s.name), this.ctx.mask(
					`${cluster.name} has no secret ${s.name}, which ${file} uses, and no local value is set. Add ${s.name} now?`), [ADD_NOW_ACTION, STOP_DEPLOY_ACTION]);
				if (choice === ADD_NOW_ACTION) {
					value = await this.askSecretValue(s.name, cluster, file);
				}
			} else {
				continue; // a default and no local value: the Cloud uses the default
			}
			if (value === undefined) {
				return { stopped: stopped(s.name), created };
			}
			if (accountChanged()) {
				return { stopped: this.stoppedByAccount(file, cluster, created), created };
			}
			const secret = value;
			this.maskValue(secret);
			try {
				const answer = await this.ctx.ui.progress(`Creating the secret ${s.name} on ${cluster.name}`, (report) => {
					report('creating the secret…');
					return createSecret(this.ctx.call(), dp, s.name, secret);
				});
				if (answer === 'created') {
					created.push(s.name);
				}
				this.ctx.log(answer === 'created'
					? `Redpanda Cloud: created the secret ${s.name} on ${cluster.name}.`
					: `Redpanda Cloud: the secret ${s.name} already exists on ${cluster.name} (created meanwhile); it was not changed.`);
			} catch (err) {
				const message = asCloudError(err).message;
				const kept = created.length > 0 ? ` Created ${created.join(', ')} on ${cluster.name} before that; they stay.` : '';
				this.ctx.log(`Redpanda Cloud: could not create the secret ${s.name} on ${cluster.name}: ${message}${kept}`);
				this.ctx.showErrorOfferingConnect(`Could not create the secret ${s.name} on ${cluster.name}: ${message}.${kept} The pipeline was not sent.`, err);
				return {
					stopped: { kind: 'failed', message: this.ctx.mask(`could not create the secret ${s.name}: ${message}`), ...(created.length > 0 ? { createdSecrets: [...created] } : {}) },
					created,
				};
			}
		}
		return { created };
	}

	/** A missing secret's value, typed in a password box (masked once it is sent); `undefined`: cancelled. */
	private async askSecretValue(name: string, cluster: CloudCluster, file: string): Promise<string | undefined> {
		const value = await this.ctx.ui.input({
			title: `Deploy ${file} to ${cluster.name}: the secret ${name}`,
			prompt: `The value of the secret ${name} on ${cluster.name}. It is sent to that secret only; nothing local changes.`,
			password: true,
			ignoreFocusOut: true,
			validateInput: (text) => (text ? undefined : `Enter the value of ${name}.`),
		});
		return value || undefined;
	}

	/** The clusters that offer the pipeline API, one picked; `undefined` (said so when there is none): no deploy. */
	private async pickTarget(file: string): Promise<CloudCluster | undefined> {
		const all = this.ctx.clusters?.kind === 'ok' ? this.ctx.clusters.value : [];
		const targets = all.filter((c) => this.ctx.dataplaneUrlOf(c));
		if (targets.length === 0) {
			const unread = all.filter((c) => c.detailsUnread);
			void this.ctx.showError(unread.length > 0
				? `Could not read the details of ${unread.map((c) => `${c.name} (${c.detailsUnread})`).join(', ')}, so no cluster to deploy to is known. Refresh the Cloud view to try again.`
				: 'No cluster of this organization offers the pipeline API: deploy needs a BYOC or Dedicated cluster with a Data Plane address.');
			return undefined;
		}
		return this.ctx.ui.pickCluster(targets, `Deploy ${file} to Redpanda Cloud`);
	}

	private async askName(file: string, cluster: CloudCluster, value = path.basename(file, path.extname(file))): Promise<string | undefined> {
		return (await this.ctx.ui.input({
			title: `Deploy ${file} to ${cluster.name}`,
			prompt: `The new pipeline's name. Deploying ${file} again updates this pipeline.`,
			value,
			ignoreFocusOut: true,
			validateInput: (text) => (text.trim() ? undefined : 'Enter a pipeline name.'),
		}))?.trim() || undefined;
	}

	/**
	 * Whether `p`'s tag names the config at `config` (bug 47). A config outside every workspace folder:
	 * its base name or its absolute path (what an older deploy sent), compared directly. A config in a
	 * folder: the tag resolves in the workspace folders to this file alone.
	 */
	private taggedWith(p: CloudPipeline, config: string): boolean {
		const t = p.tags[CONFIG_TAG];
		const folders = this.ctx.workspaceFolders();
		if (!folderOf(config, folders)) {
			return tagNames(t, config, folders);
		}
		const files = filesOfTag(t, folders);
		return files.length === 1 && path.resolve(files[0]) === path.resolve(config);
	}

	/**
	 * No mapping: a cluster, then (`offerTagged`) its pipelines tagged with this file (`config`, its
	 * `tag`) offered for an update, else a name for a new pipeline.
	 */
	private async newTarget(file: string, config: string, tag: string, offerTagged: boolean): Promise<Target | DeployResult> {
		const cluster = await this.pickTarget(file);
		const dp = cluster && this.ctx.dataplaneUrlOf(cluster);
		if (!cluster || !dp) {
			return NOT_STARTED;
		}
		if (offerTagged) {
			await this.ctx.loadPipelines(cluster.id, true);
			this.ctx.fire();
			const listed = this.ctx.pipelines.get(cluster.id);
			if (listed?.kind !== 'ok') {
				const reason = listed?.kind === 'error' ? listed.message : 'its pipelines were not read';
				void this.ctx.showError(`Could not check whether ${cluster.name} already has a pipeline deployed from ${file}: ${reason}. Nothing was deployed.`);
				return NOT_STARTED;
			}
			const tagged = listed.value.filter((p) => this.taggedWith(p, config));
			if (tagged.length > 0) {
				const names = tagged.map((p) => p.displayName);
				const updates = tagged.map((p) => (names.filter((n) => n === p.displayName).length > 1 ? `Update ${p.displayName} (${p.id})` : `Update ${p.displayName}`));
				const choice = await this.ctx.ui.confirm(this.ctx.mask(
					`${cluster.name} has ${tagged.length === 1 ? 'a pipeline' : 'pipelines'} deployed from ${tag}: ${names.join(', ')}. Update ${tagged.length === 1 ? 'it' : 'one'}, or create a new pipeline?`),
				...updates, CREATE_NEW_ACTION);
				if (choice === undefined) {
					return NOT_STARTED;
				}
				const at = updates.indexOf(choice);
				if (at >= 0) {
					const read = await this.ctx.readPipeline(cluster, dp, tagged[at].id, tagged[at].displayName);
					return read.kind === 'ok' ? { kind: 'update', cluster, dp, pipeline: read.value } : { kind: 'failed', message: read.message };
				}
				if (choice !== CREATE_NEW_ACTION) {
					return NOT_STARTED;
				}
			}
		}
		const name = await this.askName(file, cluster);
		return name ? { kind: 'create', cluster, dp, name } : NOT_STARTED;
	}

	/**
	 * A mapping: its pipeline, read now; a pipeline or cluster gone is offered to be created anew, or,
	 * with `strict` (Deploy again: this pipeline only), explained with nothing offered or sent.
	 */
	private async mappedTarget(file: string, config: string, tag: string, mappingName: string, m: DeployMapping, strict = false): Promise<Target | DeployResult> {
		const cluster = this.ctx.clusterById(m.clusterId);
		if (cluster?.detailsUnread) {
			void this.ctx.showError(`Could not read the details of ${cluster.name} (${cluster.detailsUnread}), the cluster ${mappingName} maps ${file} to. Refresh the Cloud view to try again.`);
			return NOT_STARTED;
		}
		const dp = cluster && this.ctx.dataplaneUrlOf(cluster);
		if (!cluster || !dp) {
			const named = cluster?.name ?? m.clusterName ?? m.clusterId;
			this.ctx.log(`Redpanda Cloud: the cluster ${named} (${m.clusterId}) of ${mappingName} is gone or offers no pipeline API.`);
			if (strict) {
				void this.ctx.showInfo(`The cluster ${named} that ${mappingName} maps ${file} to is gone or no longer offers the pipeline API. Nothing was sent.`);
				return NOT_STARTED;
			}
			const choice = await this.ctx.showInfo(
				`The cluster ${named} that ${mappingName} maps ${file} to is gone or no longer offers the pipeline API. Create a new pipeline on another cluster?`, CREATE_NEW_PIPELINE_ACTION);
			return choice === CREATE_NEW_PIPELINE_ACTION ? this.newTarget(file, config, tag, false) : NOT_STARTED;
		}
		const read = await this.ctx.readPipeline(cluster, dp, m.pipelineId, m.pipelineName ?? m.pipelineId);
		if (read.kind === 'ok') {
			return { kind: 'update', cluster, dp, pipeline: read.value };
		}
		if (read.status !== 404) {
			return { kind: 'failed', message: read.message };
		}
		this.ctx.removePipeline(cluster.id, m.pipelineId);
		return this.goneTarget(file, mappingName, m, cluster, dp, strict);
	}

	/** The mapped pipeline is gone from `cluster`: offered to be created anew, or (`strict`) explained, nothing sent. */
	private async goneTarget(
		file: string, mappingName: string, m: DeployMapping, cluster: CloudCluster, dp: string, strict: boolean, created: readonly string[] = [],
	): Promise<Target | DeployResult> {
		if (strict) {
			this.ctx.log(`Redpanda Cloud: pipeline ${m.pipelineName ?? m.pipelineId} (${m.pipelineId}) is gone from ${cluster.name}; ${file} was not deployed again.`);
			void this.ctx.showInfo(`Pipeline ${m.pipelineName ?? m.pipelineId}, which ${mappingName} maps ${file} to, is no longer on ${cluster.name}. ${nothingSent(created, cluster)}`);
			return NOT_STARTED;
		}
		const choice = await this.ctx.showInfo(
			`Pipeline ${m.pipelineName ?? m.pipelineId}, which ${mappingName} maps ${file} to, is no longer on ${cluster.name}. Create a new pipeline?`, CREATE_NEW_PIPELINE_ACTION);
		const name = choice === CREATE_NEW_PIPELINE_ACTION ? await this.askName(file, cluster, m.pipelineName) : undefined;
		if (!name) {
			this.keptSecrets(created, cluster, 'The pipeline was not sent.');
			return NOT_STARTED;
		}
		return { kind: 'create', cluster, dp, name };
	}
	/** Writes the mapping when it differs from the file's (only after a create or update succeeded). */
	private async writeMapping(file: string, m: DeployMapping): Promise<void> {
		const text = serializeMapping(m);
		try {
			const current = await fs.promises.readFile(file, 'utf8').catch(() => undefined);
			if (current === text) {
				return;
			}
			await fs.promises.writeFile(file, text, 'utf8');
			this.ctx.log(`Redpanda Cloud: ${file} maps the config to pipeline ${m.pipelineName ?? m.pipelineId} (${m.pipelineId}) on ${m.clusterName ?? m.clusterId}.`);
		} catch (err) {
			this.ctx.log(`Redpanda Cloud: could not write ${file}: ${reasonOf(err)}`);
			void this.ctx.showError(`Could not write ${path.basename(file)}: ${reasonOf(err)}. The next Deploy will not know the pipeline it went to.`);
		}
	}

	private async createAndFollow(
		cluster: CloudCluster, dp: string, create: CreatePipeline, report: (message: string) => void, created: (p: CloudPipeline) => Promise<void>,
	): Promise<DeployResult> {
		report('creating the pipeline…');
		let current: CloudPipeline;
		try {
			current = await createPipeline(this.ctx.call(), dp, create);
		} catch (err) {
			return this.sendFailed(err);
		}
		await created(current);
		// A list never read is read in full now (it holds the new pipeline), not replaced by it alone.
		if (this.ctx.pipelines.get(cluster.id)?.kind !== 'ok') {
			await this.ctx.loadPipelines(cluster.id, true);
		}
		this.ctx.upsertPipeline(cluster.id, current);
		this.ctx.fire();
		return this.follow(cluster, dp, current, create.displayName, report);
	}

	private async updateAndFollow(
		cluster: CloudCluster, dp: string, id: string, update: UpdatePipeline, change: { readonly from: PipelineState; readonly waiting: string } | undefined,
		report: (message: string) => void, updated: (p: CloudPipeline) => Promise<void>,
	): Promise<DeployResult> {
		report('updating the pipeline…');
		let current: CloudPipeline;
		try {
			current = await updatePipeline(this.ctx.call(), dp, id, update);
		} catch (err) {
			return this.sendFailed(err, id);
		}
		await updated(current);
		this.ctx.upsertPipeline(cluster.id, current);
		return this.follow(cluster, dp, current, update.displayName, report, change);
	}

	/** A failed create or update: a config the cluster rejected, or another failure. */
	private sendFailed(err: unknown, pipelineId?: string): DeployResult {
		const error = asCloudError(err);
		if (error.hints.length > 0 || error.status === 400) {
			return { kind: 'rejected', message: error.message, hints: hintLines(error.hints) };
		}
		return { kind: 'failed', message: describeCloudError(error), ...(pipelineId ? { pipelineId } : {}) };
	}

	/**
	 * Follows the pipeline's state until a final one. With `change` the answer may still be in the
	 * state it was in (`from`: `RUNNING` after an update of a running pipeline, the old state after a
	 * start or stop): then another state must be seen before a final one counts, unless
	 * `restartGraceMs` pass with no change (it is then reported in that state; still in Error:
	 * `errorFromBefore`). A state the extension does not know ends it at once (bug 45); a timeout names
	 * the last state seen.
	 */
	async follow(
		cluster: CloudCluster, dp: string, first: CloudPipeline, name: string, report: (message: string) => void,
		change?: { readonly from: PipelineState; readonly waiting: string },
		/** The error that ended the follow, when reading the state failed. */
		onFailure?: (err: unknown) => void,
	): Promise<DeployResult> {
		let current = first;
		const deadline = Date.now() + this.ctx.timeoutMs;
		let lastChange = Date.now();
		let changed = !change || current.state !== change.from;
		let failures = 0;
		let graceOver = false;
		for (;;) {
			if (!isKnownState(current.state)) {
				break;
			}
			if (changed && FINAL_STATES.includes(current.state)) {
				break;
			}
			if (!changed && Date.now() - lastChange >= this.ctx.restartGraceMs) {
				graceOver = true;
				break;
			}
			if (Date.now() >= deadline) {
				return { kind: 'timedOut', pipelineId: current.id, state: current.state };
			}
			report(changed || !change ? `${pipelineStateText(current.state)}…` : change.waiting);
			await sleep(this.ctx.pollMs);
			try {
				const next = await getPipeline(this.ctx.call(), dp, current.id);
				failures = 0;
				if (next.state !== current.state) {
					lastChange = Date.now();
				}
				current = next;
				if (current.state !== change?.from) {
					changed = true;
				}
				this.ctx.upsertPipeline(cluster.id, current);
			} catch (err) {
				const error = asCloudError(err);
				this.ctx.log(`Redpanda Cloud: could not read the state of ${name}: ${error.message}`);
				if (error.status === 404 || ++failures >= MAX_POLL_FAILURES) {
					onFailure?.(err);
					return { kind: 'failed', message: `could not read its state: ${error.message}`, pipelineId: current.id };
				}
			}
		}
		return {
			kind: 'final', state: current.state, pipelineId: current.id, ...(current.error ? { error: current.error } : {}),
			...(graceOver && current.state === 'STATE_ERROR' ? { errorFromBefore: true as const } : {}),
		};
	}

	/** The deploy's outcome as a message and a log line. */
	private report(file: string, name: string, cluster: CloudCluster, result: DeployResult, operation: 'create' | 'update'): void {
		const on = `on ${cluster.name}`;
		const updated = operation === 'update';
		// Bug 45: the secrets created before a send that failed stay; the message names them.
		const kept = (result.kind === 'rejected' || result.kind === 'failed') && result.createdSecrets && result.createdSecrets.length > 0
			? ` Created ${result.createdSecrets.join(', ')} on ${cluster.name}; they stay.` : '';
		switch (result.kind) {
			case 'rejected': {
				const hints = result.hints.length > 0 ? `: ${result.hints.join('; ')}` : '';
				this.ctx.log(`Redpanda Cloud: ${cluster.name} rejected ${file}: ${result.message}${kept}`);
				result.hints.forEach((h) => this.ctx.log(`  ${file}: ${h}`));
				void this.ctx.showError(`${cluster.name} rejected ${file} (${result.message})${hints}. ${updated ? `Pipeline ${name} was not updated.` : 'No pipeline was created.'}${kept}`);
				return;
			}
			case 'failed': {
				const what = updated ? `Updating pipeline ${name} ${on} with ${file}` : `Deploying ${file} as ${name} ${on}`;
				const text = kept ? `${what} failed: ${result.message}.${kept}` : `${what} failed: ${result.message}`;
				this.ctx.log(`Redpanda Cloud: ${text}`);
				void this.ctx.showError(text);
				return;
			}
			case 'timedOut': {
				// Bug 45: the last state seen (Stopping is not "starting").
				const still = result.state ? stateWord(result.state) : 'starting';
				this.ctx.log(`Redpanda Cloud: pipeline ${name} ${on} is still ${still} after ${Math.round(this.ctx.timeoutMs / 1000)} s.`);
				void this.ctx.showInfo(`Pipeline ${name} is still ${still} ${on}; the Cloud view shows its state.`);
				return;
			}
			case 'final': {
				const state = pipelineStateText(result.state);
				if (result.state === 'STATE_ERROR' && result.errorFromBefore) {
					const reason = result.error ?? NO_REASON;
					this.ctx.log(`Redpanda Cloud: pipeline ${name} ${on} is still in Error after the update: ${reason} (this error may be from before this deploy)`);
					this.ctx.showErrorWithLogs(`Pipeline ${name} ${on} is still in Error: ${reason}. The error shown may be from before this deploy.`, cluster, result.pipelineId, name);
					return;
				}
				if (result.state === 'STATE_ERROR') {
					const reason = result.error ?? NO_REASON;
					this.ctx.log(`Redpanda Cloud: pipeline ${name} ${on} is in Error: ${reason}`);
					this.ctx.showErrorWithLogs(`Pipeline ${name} ${on} is in Error: ${reason}.`, cluster, result.pipelineId, name);
					return;
				}
				this.ctx.log(`Redpanda Cloud: pipeline ${name} (${result.pipelineId}) ${on} is ${state}${updated ? ', updated from ' + file : ''}.`);
				void this.ctx.showInfo(updated ? `Updated pipeline ${name} ${on}; it is ${stateWord(result.state)}.` : `Pipeline ${name} is ${stateWord(result.state)} ${on}.`);
				return;
			}
			case 'notStarted':
			case 'unchanged':
				return;
		}
	}
}

/** "Nothing was sent.", or, after this deploy created secrets, they are named and nothing more was sent (bug 45). */
function nothingSent(created: readonly string[], cluster: CloudCluster): string {
	return created.length > 0 ? `Created ${created.join(', ')} on ${cluster.name}; they stay. Nothing more was sent.` : 'Nothing was sent.';
}

/** The range `[start, end)` of `text` (UTF-16 offsets) as a `Range` of the same text. */
function rangeOf(text: string, start: number, end: number): vscode.Range {
	const at = (offset: number) => {
		const line = lineOf(text, offset) - 1;
		const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
		return new vscode.Position(line, offset - lineStart);
	};
	return new vscode.Range(at(start), at(end));
}

/** The whole of 1-based `line` of `text` (a line past the end: the last line). */
function lineRange(text: string, line: number): vscode.Range {
	const lines = text.split('\n');
	const index = Math.max(0, Math.min(line, lines.length) - 1);
	return new vscode.Range(index, 0, index, lines[index].replace(/\r$/, '').length);
}
