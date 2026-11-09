// The deploy flow of the Cloud view (tickets 5.2, 5.3, 5.6, 5.7, 8; AD-23): Deploy to Redpanda Cloud, from the
// saved and translated file through the pre-deploy check and the missing secrets to the create or update and
// its state followed (see `cloudView.ts` for the behaviour). Built by `CloudView` only; it reaches the view's
// account, cache, prompts and messages through `CloudContext`.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CloudCluster } from '../cloud/controlPlane';
import {
	CONFIG_TAG, type CloudPipeline, type PipelineState, type CreatePipeline, createPipeline, FINAL_STATES,
	createSecret, getComponents, getPipeline, isRunning, listSecretNames, pipelineStateText, resourcesText, sameResources,
	type UpdatePipeline, updatePipeline,
} from '../cloud/dataPlane';
import { asCloudError, describeCloudError, hintLines } from '../cloud/errors';
import { type DeployMapping, serializeMapping, sidecarPath } from '../cloud/sidecar';
import { type CloudSecretUse, translateForCloud } from '../../core/cloudTranslate';
import { documentBloblangCalls } from '../../core/bloblang';
import { checkAgainstCluster, type ClusterComponents, findingMessage, lineOf, versionsDiffer } from '../../core/cloudCheck';
import { componentUses } from '../../core/graph';
import { parseYaml } from '../../core/yamlPath';
import type { LintResult } from '../redpandaConnect/lint';
import type { CloudContext, DeployResult } from './cloudView';
import type { LocalValue } from './environmentView';
import {
	CONNECT_ACTION, DEPLOYED_SCHEME, deployedConfigUri, MAX_POLL_FAILURES, NO_REASON, NOT_CONNECTED_MESSAGE, NOT_STARTED, readMapping, reasonOf, sleep, stateWord,
} from './cloudShared';

export const DEPLOY_UNTITLED_MESSAGE = 'Save the file to deploy it.';
export const DEPLOY_NOT_DETECTED_MESSAGE = 'This file is not a Redpanda Connect config.';
export const DEPLOY_NOT_ON_DISK_MESSAGE = 'Deploy needs a file on disk.';

/** The confirmation of an update that restarts a running pipeline. */
export const REPLACE_ACTION = 'Replace and restart';
/** No mapping, a pipeline on the cluster tagged with this file: create another instead of updating it. */
export const CREATE_NEW_ACTION = 'Create new';
/** The mapped pipeline or cluster is gone. */
export const CREATE_NEW_PIPELINE_ACTION = 'Create a new pipeline';
/** The mapping file is not one. */
export const DEPLOY_AS_NEW_ACTION = 'Deploy as new';
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
		this.ctx.requested = true;
		await this.ctx.loadClusters(false);
		if (this.ctx.clusters?.kind !== 'ok') {
			// The failure was shown when it was read; a failure kept from before is shown again.
			if (this.ctx.clusters?.kind === 'error') {
				void this.ctx.showError(`Could not list the Redpanda Cloud clusters: ${this.ctx.clusters.message}`);
			}
			return NOT_STARTED;
		}
		const rel = vscode.workspace.asRelativePath(doc.uri, false);
		const mappingFile = sidecarPath(doc.uri.fsPath);
		const mappingName = path.basename(mappingFile);
		const read = await readMapping(mappingFile);
		let target: Target | DeployResult;
		if (only && (read.kind !== 'ok' || read.mapping.clusterId !== only.clusterId || read.mapping.pipelineId !== only.pipelineId)) {
			// Deploy again: the mapping changed since the row's check; nothing else is offered.
			this.ctx.log(`Redpanda Cloud: did not deploy ${file} again to ${only.name}: ${mappingName} no longer maps it to that pipeline.`);
			void this.ctx.showInfo(`${mappingName} no longer maps ${file} to ${only.name}. Nothing was sent.`);
			return NOT_STARTED;
		}
		if (read.kind === 'none') {
			target = await this.newTarget(file, rel, true);
		} else if (read.kind === 'bad') {
			this.ctx.log(`Redpanda Cloud: ${mappingFile} is not a deploy mapping: ${read.reason}`);
			const choice = await this.ctx.showError(
				`${mappingName} is not a deploy mapping: ${read.reason}. Deploy ${file} as a new pipeline? ${mappingName} is then replaced.`, DEPLOY_AS_NEW_ACTION);
			target = choice === DEPLOY_AS_NEW_ACTION ? await this.newTarget(file, rel, false) : NOT_STARTED;
		} else {
			target = await this.mappedTarget(file, rel, mappingName, read.mapping, only !== undefined);
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
		const { stopped: secretsStopped, created: createdSecrets } = await this.ensureSecrets(doc.uri, file, cluster, dp, translated.secrets);
		if (secretsStopped) {
			return secretsStopped;
		}
		// A valid mapping naming these ids is never rewritten.
		const mapTo = async (p: CloudPipeline) => {
			if (existing?.clusterId !== cluster.id || existing.pipelineId !== p.id) {
				await this.writeMapping(mappingFile, { clusterId: cluster.id, pipelineId: p.id, clusterName: cluster.name, pipelineName: p.displayName });
			}
		};

		if (target.kind === 'create') {
			const name = target.name;
			const result = await this.ctx.ui.progress(`Deploying ${name} to ${cluster.name}`, (report) =>
				this.createAndFollow(cluster, dp, { displayName: name, configYaml, resources, tags: { [CONFIG_TAG]: rel } }, report, mapTo));
			this.report(file, name, cluster, result, 'create');
			return result;
		}

		const deployed = target.pipeline;
		const name = deployed.displayName;
		const sameConfig = deployed.configYaml === configYaml;
		const sameSize = sameResources(deployed.resources, resources);
		if (sameConfig && sameSize) {
			await mapTo(deployed);
			this.ctx.log(`Redpanda Cloud: pipeline ${name} (${deployed.id}) on ${cluster.name} already has ${file} as saved and translated (${stateWord(deployed.state)}), with ${resourcesText(resources)}; nothing was sent.`);
			void this.ctx.showInfo(`Pipeline ${name} on ${cluster.name} is already deployed from ${file}, nothing changed.`);
			return { kind: 'unchanged', pipelineId: deployed.id };
		}
		const wasRunning = isRunning(deployed.state);
		if (wasRunning) {
			if (!sameConfig) {
				await this.showDiff(cluster, deployed, configYaml, file);
			}
			const size = sameSize ? '' : `Its size changes from ${resourcesText(deployed.resources)} to ${resourcesText(resources)}.`;
			const what = sameConfig
				? `Changing its size restarts it. ${size}`
				: `Replacing its config with ${file} (the diff shows the changes) restarts it.${size ? ` ${size}` : ''}`;
			const choice = await this.ctx.ui.confirm(this.ctx.mask(`Pipeline ${name} on ${cluster.name} is ${stateWord(deployed.state)}. ${what}`), REPLACE_ACTION);
			if (choice !== REPLACE_ACTION) {
				if (createdSecrets.length > 0) {
					const kept = `Created ${createdSecrets.join(', ')} on ${cluster.name}; they stay. The pipeline was not updated.`;
					this.ctx.log(`Redpanda Cloud: ${kept}`);
					void this.ctx.showInfo(kept);
				}
				return NOT_STARTED;
			}
		}
		const update: UpdatePipeline = {
			displayName: name,
			description: deployed.description,
			configYaml,
			resources,
			tags: { ...deployed.tags, [CONFIG_TAG]: rel },
		};
		const result = await this.ctx.ui.progress(`Updating ${name} on ${cluster.name}`, (report) =>
			this.updateAndFollow(cluster, dp, deployed.id, update, wasRunning, report, mapTo));
		this.report(file, name, cluster, result, 'update');
		return result;
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
		void this.ctx.showError(`${file} can't be deployed to Redpanda Cloud: ${problems.map((p) => p.message).join('; ')}. Nothing was sent.`);
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

	/** Masks `value` (and its base64 form, as sent) from now on. */
	private maskValue(value: string): void {
		if (value) {
			this.ctx.seenSecrets.add(value);
			this.ctx.seenSecrets.add(Buffer.from(value, 'utf8').toString('base64'));
		}
	}

	/**
	 * Ticket 5.7: the secrets the config references that `cluster` lacks, asked about one at a time and
	 * created from the answers. `stopped`: how the deploy ended (nothing more sent), none: it goes on;
	 * `created`: the secrets this deploy created.
	 */
	private async ensureSecrets(uri: vscode.Uri, file: string, cluster: CloudCluster, dp: string, secrets: readonly CloudSecretUse[])
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
			local = this.ctx.options.localValues?.(uri) ?? new Map<string, LocalValue>();
		} catch (err) {
			this.ctx.log(`Redpanda Cloud: could not read the local values of ${file}: ${reasonOf(err)}`);
			local = new Map<string, LocalValue>();
		}
		for (const s of missing) {
			const v = local.get(s.name);
			if (v) {
				this.maskValue(v.value);
			}
		}
		const stopped = (name: string): DeployResult => {
			this.ctx.log(`Redpanda Cloud: the deploy of ${file} stopped at the secret ${name}; nothing more was sent.`);
			return NOT_STARTED;
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
			const secret = value;
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
				this.ctx.log(`Redpanda Cloud: could not create the secret ${s.name} on ${cluster.name}: ${message}`);
				this.ctx.showErrorOfferingConnect(`Could not create the secret ${s.name} on ${cluster.name}: ${message}. The pipeline was not sent.`, err);
				return { stopped: { kind: 'failed', message: this.ctx.mask(`could not create the secret ${s.name}: ${message}`) }, created };
			}
		}
		return { created };
	}

	/** A missing secret's value, typed in a password box (masked at once); `undefined`: cancelled. */
	private async askSecretValue(name: string, cluster: CloudCluster, file: string): Promise<string | undefined> {
		const value = await this.ctx.ui.input({
			title: `Deploy ${file} to ${cluster.name}: the secret ${name}`,
			prompt: `The value of the secret ${name} on ${cluster.name}. It is sent to that secret only; nothing local changes.`,
			password: true,
			ignoreFocusOut: true,
			validateInput: (text) => (text ? undefined : `Enter the value of ${name}.`),
		});
		if (value) {
			this.maskValue(value);
		}
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
	 * No mapping: a cluster, then (`offerTagged`) its pipelines tagged with this file offered for an
	 * update, else a name for a new pipeline.
	 */
	private async newTarget(file: string, rel: string, offerTagged: boolean): Promise<Target | DeployResult> {
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
			const tagged = listed.value.filter((p) => p.tags[CONFIG_TAG] === rel);
			if (tagged.length > 0) {
				const names = tagged.map((p) => p.displayName);
				const updates = tagged.map((p) => (names.filter((n) => n === p.displayName).length > 1 ? `Update ${p.displayName} (${p.id})` : `Update ${p.displayName}`));
				const choice = await this.ctx.ui.confirm(this.ctx.mask(
					`${cluster.name} has ${tagged.length === 1 ? 'a pipeline' : 'pipelines'} deployed from ${rel}: ${names.join(', ')}. Update ${tagged.length === 1 ? 'it' : 'one'}, or create a new pipeline?`),
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
	private async mappedTarget(file: string, rel: string, mappingName: string, m: DeployMapping, strict = false): Promise<Target | DeployResult> {
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
			return choice === CREATE_NEW_PIPELINE_ACTION ? this.newTarget(file, rel, false) : NOT_STARTED;
		}
		const read = await this.ctx.readPipeline(cluster, dp, m.pipelineId, m.pipelineName ?? m.pipelineId);
		if (read.kind === 'ok') {
			return { kind: 'update', cluster, dp, pipeline: read.value };
		}
		if (read.status !== 404) {
			return { kind: 'failed', message: read.message };
		}
		this.ctx.removePipeline(cluster.id, m.pipelineId);
		if (strict) {
			this.ctx.log(`Redpanda Cloud: pipeline ${m.pipelineName ?? m.pipelineId} (${m.pipelineId}) is gone from ${cluster.name}; ${file} was not deployed again.`);
			void this.ctx.showInfo(`Pipeline ${m.pipelineName ?? m.pipelineId}, which ${mappingName} maps ${file} to, is no longer on ${cluster.name}. Nothing was sent.`);
			return NOT_STARTED;
		}
		const choice = await this.ctx.showInfo(
			`Pipeline ${m.pipelineName ?? m.pipelineId}, which ${mappingName} maps ${file} to, is no longer on ${cluster.name}. Create a new pipeline?`, CREATE_NEW_PIPELINE_ACTION);
		if (choice !== CREATE_NEW_PIPELINE_ACTION) {
			return NOT_STARTED;
		}
		const name = await this.askName(file, cluster, m.pipelineName);
		return name ? { kind: 'create', cluster, dp, name } : NOT_STARTED;
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
		cluster: CloudCluster, dp: string, id: string, update: UpdatePipeline, restart: boolean, report: (message: string) => void,
		updated: (p: CloudPipeline) => Promise<void>,
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
		return this.follow(cluster, dp, current, update.displayName, report, restart ? { from: 'STATE_RUNNING', waiting: 'waiting for the restart…' } : undefined);
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
	 * `restartGraceMs` pass with no change (it is then reported in that state).
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
		for (;;) {
			if (changed && FINAL_STATES.includes(current.state)) {
				break;
			}
			if (!changed && Date.now() - lastChange >= this.ctx.restartGraceMs) {
				break;
			}
			if (Date.now() >= deadline) {
				return { kind: 'timedOut', pipelineId: current.id };
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
		return { kind: 'final', state: current.state, pipelineId: current.id, ...(current.error ? { error: current.error } : {}) };
	}

	/** The deploy's outcome as a message and a log line. */
	private report(file: string, name: string, cluster: CloudCluster, result: DeployResult, operation: 'create' | 'update'): void {
		const on = `on ${cluster.name}`;
		const updated = operation === 'update';
		switch (result.kind) {
			case 'rejected': {
				const hints = result.hints.length > 0 ? `: ${result.hints.join('; ')}` : '';
				this.ctx.log(`Redpanda Cloud: ${cluster.name} rejected ${file}: ${result.message}`);
				result.hints.forEach((h) => this.ctx.log(`  ${file}: ${h}`));
				void this.ctx.showError(`${cluster.name} rejected ${file} (${result.message})${hints}. ${updated ? `Pipeline ${name} was not updated.` : 'No pipeline was created.'}`);
				return;
			}
			case 'failed': {
				const what = updated ? `Updating pipeline ${name} ${on} with ${file}` : `Deploying ${file} as ${name} ${on}`;
				this.ctx.log(`Redpanda Cloud: ${what} failed: ${result.message}`);
				void this.ctx.showError(`${what} failed: ${result.message}`);
				return;
			}
			case 'timedOut':
				this.ctx.log(`Redpanda Cloud: pipeline ${name} ${on} is still starting after ${Math.round(this.ctx.timeoutMs / 1000)} s.`);
				void this.ctx.showInfo(`Pipeline ${name} is still starting ${on}; the Cloud view shows its state.`);
				return;
			case 'final': {
				const state = pipelineStateText(result.state);
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

/** The right side of the deploy's diff: the local config as it would be sent. */
export function sentConfigUri(clusterId: string, pipelineId: string, name: string): vscode.Uri {
	const safe = name.replace(/[^\w.-]+/g, '_') || pipelineId;
	return vscode.Uri.from({ scheme: DEPLOYED_SCHEME, path: `/${clusterId}/${pipelineId}/${safe}.local.yaml` });
}
