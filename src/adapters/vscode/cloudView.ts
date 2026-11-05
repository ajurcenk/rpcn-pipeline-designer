// The Cloud view and the deploy (ticket 5.2, AD-23): the thinnest path to Redpanda Cloud.
//
// **Connect service account** asks for the client ID, then the secret in a password box, requests
// one token with them (a 401: "the client ID or secret is wrong", nothing stored) and only then keeps
// both in VS Code's secret storage (`context.secrets`: `redpandaConnect.cloud.clientId` and
// `redpandaConnect.cloud.clientSecret`, apart from ticket 30's secret variables). The token lives in
// memory only (`src/adapters/cloud/token.ts`). **Disconnect** removes both and the token.
//
// The **Cloud** view (in the Redpanda Connect container, next to Environment) shows the service
// account (its token's `client_name`), the organization's BYOC and Dedicated clusters with cloud,
// region and Connect version (one without a Data Plane address as "no pipeline API"), and, when a
// cluster is expanded, its pipelines with their state. Refresh, or expanding a cluster again, reads
// them again. Nothing is requested in the background: only on connect, deploy, refresh and expand.
//
// **Deploy to Redpanda Cloud** (command and editor-title button on a detected, saved config) saves
// a dirty config first (as Run does; an untitled one is refused) and sends the saved file's text
// translated for the Cloud (ticket 5.6, `src/core/cloudTranslate.ts`: each `${VAR}` becomes
// `${secrets.VAR}`, a default kept; a name that is not a secret id, or a Bloblang `env(` call, is
// refused with its line before anything is asked or sent), at the size the user picks on every deploy (compute units: 1 = 0.1 CPU + 400 MB; pre-set
// to the deployed pipeline's size on an update, to 1 on a create; nothing is saved). The first
// deploy asks for a cluster (offering an update of a pipeline there already tagged with this file)
// and a name (the file's name without its extension), creates the pipeline with a tag naming the
// file, and writes the mapping beside the file (`orders.yaml` → `orders.cloud.json`, ids only,
// ticket 5.3). A deploy with a mapping reads the mapped pipeline and replaces it (`PUT`, every
// field: the deployed name, description and other tags
// kept); a running or starting one is restarted by that, so a diff of the deployed and the local
// config opens first and a modal confirmation is needed. Config and size as deployed: nothing is
// sent (compared with the translated text; the diff's right side is that text). The state is followed in a progress notification until it is Running, Error, Stopped or
// Completed (at most 3 minutes), through the restart of a running one. A config the cluster rejects
// shows each `LintHint`'s line and text. The config file is never changed.
//
// **Start**, **Stop** and **Delete pipeline…** (ticket 5.4) are a pipeline row's actions, offered by its
// state (Start: stopped, failed or completed; Stop: running or starting; Delete: any state, also one the
// extension does not know), and palette commands that act on the pipeline the active config's
// `.cloud.json` maps to, else on one picked from every cluster's pipelines. Delete needs a modal
// confirmation naming the pipeline, the cluster and the `.cloud.json` that maps a config to it, which
// is deleted with it (only when it parses and names this cluster and pipeline; the config never
// changes). After an action the state is followed as Deploy does (until a final state, or the 404
// after a delete, or the timeout); a failed action shows the API's message and reads the cluster's
// pipelines again. Nothing is polled in the background.
//
// Each pipeline row (ticket 5.5) shows the file it was deployed from (its `rpcn-vscode/config` tag),
// found inside the workspace folders only ("not in this workspace" otherwise). Clicking a row, or
// **Open deployed config**, reads the pipeline now and shows its config read-only; **Compare with local
// file** diffs that (read-only) with the local file (editable); **Deploy local file again** runs the
// normal Deploy of the file when its `.cloud.json` maps to this pipeline, else explains and sends
// nothing; **Copy pipeline ID** puts the id on the clipboard.
//
// Before the create or update (ticket 5.7), Deploy reads the chosen cluster's secrets once (only when
// the translation made at least one secret reference) and, one at a time, for each referenced secret
// the cluster lacks: with a local value (the one the binary would get: secret storage,
// `redpandaConnect.env`, the env file, VS Code's environment) offers to keep it or enter another (a
// password box), plus, for a secret used only with a default, not to create it; with no local value,
// a secret used without a default is offered to be added now (a password box), and one with a default
// is not asked about. Declining or Escape stops the deploy (secrets already created stay). Each answer
// is created (`POST {dp}/v1/secrets`; 409, created meanwhile, counts as existing); an existing cloud
// secret is never changed, and nothing local changes. A value goes only into the creation request: it
// is masked from the moment it is read or typed.
//
// Every message, log line and view item masks the client secret, the token and Authorization values.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { type CloudCall, type CloudCluster, clusterTypeText, cloudProviderText, listClusters } from '../cloud/controlPlane';
import {
	canStart, canStop, CONFIG_TAG, type CloudPipeline, type PipelineResources, type PipelineState, type CreatePipeline, createPipeline, deletePipeline, FINAL_STATES,
	createSecret, getPipeline, isKnownState, isRunning, listPipelines, listSecretNames, MAX_UNITS, MIN_UNITS, pipelineStateText, resourcesOf, resourcesText, sameResources, type SizeChoice, sizeChoices, startPipeline, stateKey,
	stopPipeline, type UpdatePipeline, updatePipeline,
} from '../cloud/dataPlane';
import { asCloudError, CloudError, describeCloudError, hintLines, maskCredentials } from '../cloud/errors';
import { defaultFetch, type FetchLike } from '../cloud/http';
import { type DeployMapping, type ParsedMapping, parseMapping, serializeMapping, sidecarPath, taggedConfigs, taggedSidecars } from '../cloud/sidecar';
import { type ServiceAccount, TokenCache } from '../cloud/token';
import { type CloudSecretUse, translateForCloud } from '../../core/cloudTranslate';
import type { LocalValue } from './environmentView';
import type { SecretStore } from './secrets';

export const CLOUD_VIEW_ID = 'redpandaConnect.cloud';
export const CONNECT_COMMAND = 'redpandaConnect.cloud.connect';
export const DISCONNECT_COMMAND = 'redpandaConnect.cloud.disconnect';
export const DEPLOY_COMMAND = 'redpandaConnect.cloud.deploy';
export const CLOUD_REFRESH_COMMAND = 'redpandaConnect.cloud.refresh';
/** Ticket 5.4: a pipeline's lifecycle, from its row or the palette. */
export const START_COMMAND = 'redpandaConnect.cloud.start';
export const STOP_COMMAND = 'redpandaConnect.cloud.stop';
export const DELETE_COMMAND = 'redpandaConnect.cloud.delete';
/** Ticket 5.5: a pipeline row's deployed config, its compare with the local file, a deploy of that file, its id. */
export const OPEN_DEPLOYED_COMMAND = 'redpandaConnect.cloud.openDeployed';
export const COMPARE_COMMAND = 'redpandaConnect.cloud.compare';
export const DEPLOY_AGAIN_COMMAND = 'redpandaConnect.cloud.deployAgain';
export const COPY_ID_COMMAND = 'redpandaConnect.cloud.copyId';
/** A row whose tag names no file in the workspace folders (outside them, or missing). */
export const NOT_IN_WORKSPACE = 'not in this workspace';
/** The delete confirmation's action. */
export const DELETE_ACTION = 'Delete';
/** Whether a service account is connected (menus and the view's empty state). */
export const CONNECTED_KEY = 'redpandaConnect.cloud.connected';
export const CLIENT_ID_KEY = 'redpandaConnect.cloud.clientId';
export const CLIENT_SECRET_KEY = 'redpandaConnect.cloud.clientSecret';

export const NOT_CONNECTED_MESSAGE = 'No Redpanda Cloud service account is connected. Connect one to deploy.';
export const CONNECT_ACTION = 'Connect service account';
export const DEPLOY_UNTITLED_MESSAGE = 'Save the file to deploy it.';
export const DEPLOY_NOT_DETECTED_MESSAGE = 'This file is not a Redpanda Connect config.';
export const DEPLOY_NOT_ON_DISK_MESSAGE = 'Deploy needs a file on disk.';
export const NO_REASON = 'the cluster gave no reason';
export const NO_CLUSTERS_TEXT = 'No BYOC or Dedicated cluster in this organization.';
export const NO_PIPELINE_API = 'no pipeline API';
/** A cluster whose details (`GET /v1/clusters/{id}`) could not be read: its pipeline API is unknown. */
export const DETAILS_UNREAD = 'could not read its details';
/** A stored account's row until the user asks for the clusters (nothing is requested on its own). */
export const NOT_READ_TEXT = 'Refresh to read the clusters.';

/** The scheme of a pipeline's deployed config, shown read-only. */
export const DEPLOYED_SCHEME = 'redpanda-cloud';
export const DEPLOYED_NOT_LOADED_TEXT = '# This read-only copy is not loaded in this window (it was restored after a reload). Close it, then use Open deployed config, Compare or Deploy in the Cloud view.\n';
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

/** After an update of a running pipeline: reported running when its state does not change for this long. */
export const RESTART_GRACE_MS = 20_000;

/** Poll the pipeline this often while it starts, for at most this long (the test seam shortens both). */
export const POLL_MS = 3_000;
export const DEPLOY_TIMEOUT_MS = 3 * 60_000;
/** After this many failed polls in a row the deploy stops following the pipeline. */
const MAX_POLL_FAILURES = 5;

export interface CloudEndpoints {
	/** The token endpoint's origin. */
	readonly authUrl: string;
	/** The Control Plane API. */
	readonly controlPlaneUrl: string;
	/** Only an `https:` Data Plane address is used (off in the test seam, whose fake is plain HTTP). */
	readonly requireHttps: boolean;
}

export const PRODUCTION_ENDPOINTS: CloudEndpoints = {
	authUrl: 'https://auth.prd.cloud.redpanda.com',
	controlPlaneUrl: 'https://api.redpanda.com',
	requireHttps: true,
};

/** In `ExtensionMode.Test` until a suite sets the fake's: nothing listens there, so nothing reaches Redpanda Cloud. */
export const UNREACHABLE_ENDPOINTS: CloudEndpoints = {
	authUrl: 'http://127.0.0.1:9',
	controlPlaneUrl: 'http://127.0.0.1:9',
	requireHttps: false,
};

/** The prompts and messages (tests replace them); messages arrive masked. */
export interface CloudUi {
	input(options: vscode.InputBoxOptions): Thenable<string | undefined>;
	pickCluster(clusters: readonly CloudCluster[], title: string): Thenable<CloudCluster | undefined>;
	/** A palette action's pipeline, from every cluster's; `undefined`: cancelled. */
	pickPipeline(pipelines: readonly PipelineChoice[], title: string): Thenable<PipelineChoice | undefined>;
	/**
	 * The pipeline's size, shown on every deploy: pre-set to `current` (the deployed pipeline's, on an
	 * update) or 1 compute unit (a new pipeline). `undefined`: cancelled.
	 */
	pickUnits(title: string, current: PipelineResources | undefined): Thenable<PipelineResources | undefined>;
	/** Ticket 5.7: one of `choices` (a missing secret's question); `undefined`: cancelled. */
	pickChoice(title: string, question: string, choices: readonly string[]): Thenable<string | undefined>;
	error(message: string, ...actions: string[]): Thenable<string | undefined>;
	info(message: string, ...actions: string[]): Thenable<string | undefined>;
	/** A modal question; `undefined`: cancelled. */
	confirm(message: string, ...actions: string[]): Thenable<string | undefined>;
	progress<T>(title: string, task: (report: (message: string) => void) => Promise<T>): Thenable<T>;
}

/** A pipeline on its cluster, offered in the palette's pick. */
export interface PipelineChoice {
	readonly cluster: CloudCluster;
	readonly pipeline: CloudPipeline;
	/** The pick's texts, masked by the view. */
	readonly label: string;
	readonly description: string;
}

/** `Running`, or `Error (<reason>)` with the cluster's reason or "the cluster gave no reason". */
export function pipelineStateDescription(p: CloudPipeline | undefined): string {
	if (!p) {
		return 'Unknown';
	}
	return `${pipelineStateText(p.state)}${p.state === 'STATE_ERROR' ? ` (${p.error ?? NO_REASON})` : ''}`;
}

export function clusterDescription(c: CloudCluster): string {
	const where = [cloudProviderText(c.cloudProvider), c.region].filter(Boolean).join(' ');
	const connect = c.detailsUnread ? `${DETAILS_UNREAD}: ${c.detailsUnread}`
		: c.dataplaneUrl ? (c.connectVersion ? `Connect ${c.connectVersion}` : 'Connect version unknown') : NO_PIPELINE_API;
	return [clusterTypeText(c.type), where, connect].filter(Boolean).join(' · ');
}

export const defaultCloudUi: CloudUi = {
	input: (options) => vscode.window.showInputBox(options),
	pickCluster: async (clusters, title) => {
		const picked = await vscode.window.showQuickPick(
			clusters.map((c) => ({ label: c.name, description: clusterDescription(c), cluster: c })),
			{ title, placeHolder: 'The cluster to create the pipeline on' },
		);
		return picked?.cluster;
	},
	pickPipeline: async (pipelines, title) => {
		const picked = await vscode.window.showQuickPick(
			pipelines.map((choice) => ({
				label: choice.label,
				description: choice.description,
				choice,
			})),
			{ title, placeHolder: 'The pipeline', matchOnDescription: true },
		);
		return picked?.choice;
	},
	pickUnits: (title, current) => new Promise<PipelineResources | undefined>((resolve) => {
		type Item = vscode.QuickPickItem & SizeChoice;
		const { items, preset } = sizeChoices(current);
		const pick = vscode.window.createQuickPick<Item>();
		pick.title = title;
		pick.placeholder = current
			? 'The pipeline\'s size (its current size is selected): 1 compute unit is 0.1 CPU and 400 MB'
			: 'The pipeline\'s size: 1 compute unit is 0.1 CPU and 400 MB';
		pick.items = items;
		pick.activeItems = [items[preset]];
		pick.ignoreFocusOut = true;
		let chosen: PipelineResources | undefined;
		pick.onDidAccept(() => {
			chosen = pick.selectedItems[0]?.resources ?? pick.activeItems[0]?.resources;
			pick.hide();
		});
		pick.onDidHide(() => {
			pick.dispose();
			resolve(chosen);
		});
		pick.show();
	}),
	pickChoice: (title, question, choices) => vscode.window.showQuickPick([...choices], { title, placeHolder: question, ignoreFocusOut: true }),
	error: (message, ...actions) => vscode.window.showErrorMessage(message, ...actions),
	info: (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
	confirm: (message, ...actions) => vscode.window.showWarningMessage(message, { modal: true }, ...actions),
	progress: (title, task) => vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title, cancellable: false },
		(progress) => task((message) => progress.report({ message })),
	),
};

export type CloudNode =
	| { readonly kind: 'account' }
	| { readonly kind: 'cluster'; readonly id: string }
	| { readonly kind: 'pipeline'; readonly clusterId: string; readonly id: string }
	| { readonly kind: 'note'; readonly id: string; readonly text: string; readonly error: boolean };

/** One shown item, flattened (the test seam). */
export interface CloudItem {
	readonly node: CloudNode;
	readonly label: string;
	readonly description: string;
	readonly contextValue: string;
	readonly tooltip: string;
	readonly accessibility: string;
	/** Whether it can be expanded. */
	readonly expandable: boolean;
	/** The theme icon's id. */
	readonly icon: string;
}

/** How a deploy ended (the command's result, for tests). */
export type DeployResult =
	| { readonly kind: 'notStarted' }
	| { readonly kind: 'rejected'; readonly message: string; readonly hints: readonly string[] }
	| { readonly kind: 'failed'; readonly message: string; readonly pipelineId?: string }
	| { readonly kind: 'final'; readonly state: string; readonly pipelineId: string; readonly error?: string }
	| { readonly kind: 'timedOut'; readonly pipelineId: string }
	/** The mapped pipeline already runs this config at this size: nothing was sent. */
	| { readonly kind: 'unchanged'; readonly pipelineId: string };

const NOT_STARTED: DeployResult = { kind: 'notStarted' };

/** How a Start, Stop or Delete ended (the command's result, for tests). */
export type PipelineActionResult =
	| DeployResult
	/** The pipeline's state does not offer the action (from the palette): nothing was sent. */
	| { readonly kind: 'notOffered'; readonly state: string; readonly pipelineId: string }
	/** Deleted (`alreadyGone`: the `DELETE` answered 404); `mappings`: the `.cloud.json` files deleted with it. */
	| { readonly kind: 'deleted'; readonly pipelineId: string; readonly alreadyGone: boolean; readonly mappings: readonly string[] };

type PipelineAction = 'start' | 'stop' | 'delete';

/** How Open deployed config, Compare, Deploy again or Copy pipeline ID ended (the command's result, for tests). */
export type RowActionResult =
	| DeployResult
	/** The deployed config shown (`uri`: the read-only side), read now. */
	| { readonly kind: 'opened'; readonly pipelineId: string; readonly uri: string }
	/** The `GET` answered 404: said so, the cluster's pipelines read again. */
	| { readonly kind: 'gone'; readonly pipelineId: string }
	/** The tag names no file in the workspace folders (or there is no tag): said so, nothing opened or sent. */
	| { readonly kind: 'notInWorkspace'; readonly pipelineId: string }
	/** Deploy again: the file's `.cloud.json` maps to another pipeline, is missing or is not one; nothing sent. */
	| { readonly kind: 'notMapped'; readonly pipelineId: string; readonly mapping?: DeployMapping }
	| { readonly kind: 'copied'; readonly pipelineId: string };

/** Deploy again: the deploy may only update this pipeline (anything else is explained, nothing sent). */
interface OnlyPipeline {
	readonly clusterId: string;
	readonly pipelineId: string;
	readonly name: string;
}

/** The local file a pipeline was deployed from, by its tag. */
type LocalFile =
	| { readonly kind: 'none' }
	| { readonly kind: 'outside'; readonly tag: string }
	| { readonly kind: 'ok'; readonly tag: string; readonly path: string };

/** The pipeline an action is for. `config`: the active config, from the palette. */
interface ActionTarget {
	readonly cluster: CloudCluster;
	readonly dp: string;
	readonly pipeline: CloudPipeline;
	readonly config?: vscode.Uri;
}

/** Where a deploy goes: a new pipeline on a cluster, or an existing one replaced. */
type Target =
	| { readonly kind: 'create'; readonly cluster: CloudCluster; readonly dp: string; readonly name: string }
	| { readonly kind: 'update'; readonly cluster: CloudCluster; readonly dp: string; readonly pipeline: CloudPipeline };

type Loaded<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'error'; readonly message: string };

export interface CloudViewOptions {
	readonly store: SecretStore;
	readonly log: (line: string) => void;
	readonly endpoints?: CloudEndpoints;
	readonly ui?: CloudUi;
	readonly fetch?: FetchLike;
	/** Whether a URI is a detected Redpanda Connect config. */
	readonly isDetected: (uri: vscode.Uri) => boolean;
	/** Ticket 5.7: the value the binary would get for each variable a config uses (the Environment view's). */
	readonly localValues?: (uri: vscode.Uri) => ReadonlyMap<string, LocalValue>;
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CloudView implements vscode.TreeDataProvider<CloudNode>, vscode.Disposable {
	/** The prompts and messages; tests replace them. */
	ui: CloudUi;
	/** The three hosts (the test seam points them at its fake). */
	endpoints: CloudEndpoints;
	/** The deploy's poll interval and timeout (the test seam shortens them). */
	pollMs = POLL_MS;
	timeoutMs = DEPLOY_TIMEOUT_MS;
	restartGraceMs = RESTART_GRACE_MS;
	/**
	 * The workspace folders a pipeline's tag is resolved in (the local file of a row, the mapping a
	 * delete removes): VS Code's `file:` folders; the test seam replaces it (the stable run opens none).
	 */
	workspaceFolders: () => readonly string[] = () =>
		(vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
	readonly tokens: TokenCache;
	/** `redpanda-cloud:` URI → the deployed config it shows. */
	private readonly deployedConfigs = new Map<string, string>();
	private readonly deployedChanged = new vscode.EventEmitter<vscode.Uri>();
	private readonly changeEmitter = new vscode.EventEmitter<CloudNode | undefined>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private treeView: vscode.TreeView<CloudNode> | undefined;
	private account: { readonly clientId: string; name?: string } | undefined;
	/** Every client secret this window has seen (the stored one, one being tested), in memory, for masking. */
	private readonly seenSecrets = new Set<string>();
	/** Bumped when the account changes (connect starting, disconnect, another window's change). */
	private accountGeneration = 0;
	/** This window's own secret storage writes in progress: their change events are not another window's. */
	private writing = 0;
	private clusters: Loaded<CloudCluster[]> | undefined;
	private clustersLoading: Promise<void> | undefined;
	private readonly pipelines = new Map<string, Loaded<CloudPipeline[]>>();
	private readonly pipelinesLoading = new Map<string, Promise<void>>();
	private readonly pipelinesLoadedAt = new Map<string, number>();
	/** Bumped on connect and disconnect, so an older load is not kept. */
	private generation = 0;
	/**
	 * Whether the user asked for the clusters this window (connect, deploy, refresh, expand): until
	 * then a stored account shows a "Refresh" row, so opening the view requests nothing.
	 */
	private requested = false;
	/** Resolves when the stored account has been read (at activation and after a storage change). */
	ready: Promise<void>;

	readonly onDidChangeTreeData: vscode.Event<CloudNode | undefined> = this.changeEmitter.event;

	constructor(private readonly options: CloudViewOptions) {
		this.ui = options.ui ?? defaultCloudUi;
		this.endpoints = options.endpoints ?? PRODUCTION_ENDPOINTS;
		const fetch = options.fetch ?? defaultFetch;
		this.tokens = new TokenCache({
			fetch,
			log: (line) => this.log(line),
			authUrl: () => this.endpoints.authUrl,
		});
		this.subscriptions.push(
			this.changeEmitter,
			this.deployedChanged,
			options.store.onDidChange((e) => {
				if ((e.key === CLIENT_ID_KEY || e.key === CLIENT_SECRET_KEY) && this.writing === 0) {
					this.ready = this.readAccount();
				}
			}),
		);
		this.ready = this.readAccount();
	}

	/** Creates the tree view and registers the commands. */
	register(): vscode.Disposable[] {
		this.treeView = vscode.window.createTreeView(CLOUD_VIEW_ID, { treeDataProvider: this });
		return [
			this.treeView,
			// Expanding a cluster again reads its pipelines again.
			this.treeView.onDidExpandElement((e) => this.expanded(e.element)),
			vscode.commands.registerCommand(CONNECT_COMMAND, () => this.connect()),
			vscode.commands.registerCommand(DISCONNECT_COMMAND, () => this.disconnect()),
			vscode.commands.registerCommand(DEPLOY_COMMAND, (uri?: vscode.Uri) => this.deploy(uri instanceof vscode.Uri ? uri : undefined)),
			vscode.commands.registerCommand(CLOUD_REFRESH_COMMAND, (node?: CloudNode) => this.refresh(node)),
			vscode.commands.registerCommand(START_COMMAND, (node?: CloudNode) => this.pipelineAction('start', node)),
			vscode.commands.registerCommand(STOP_COMMAND, (node?: CloudNode) => this.pipelineAction('stop', node)),
			vscode.commands.registerCommand(DELETE_COMMAND, (node?: CloudNode) => this.pipelineAction('delete', node)),
			vscode.commands.registerCommand(OPEN_DEPLOYED_COMMAND, (node?: CloudNode) => this.rowAction('open', node)),
			vscode.commands.registerCommand(COMPARE_COMMAND, (node?: CloudNode) => this.rowAction('compare', node)),
			vscode.commands.registerCommand(DEPLOY_AGAIN_COMMAND, (node?: CloudNode) => this.rowAction('deployAgain', node)),
			vscode.commands.registerCommand(COPY_ID_COMMAND, (node?: CloudNode) => this.rowAction('copyId', node)),
			vscode.workspace.registerTextDocumentContentProvider(DEPLOYED_SCHEME, {
				onDidChange: this.deployedChanged.event,
				provideTextDocumentContent: (uri) => this.provideTextDocumentContent(uri),
			}),
		];
	}

	/** Whether a service account is connected. */
	get connected(): boolean {
		return this.account !== undefined;
	}

	/** The connected account's name (its token's `client_name`, else the client ID). */
	get accountName(): string | undefined {
		return this.account ? this.account.name ?? this.account.clientId : undefined;
	}

	/** Which of the two keys the secret storage holds (the test seam; never their values). */
	async stored(): Promise<{ readonly clientId: boolean; readonly clientSecret: boolean }> {
		const [id, secret] = await Promise.all([this.options.store.get(CLIENT_ID_KEY), this.options.store.get(CLIENT_SECRET_KEY)]);
		return { clientId: !!id, clientSecret: !!secret };
	}

	private secrets(): (string | undefined)[] {
		return [...this.seenSecrets, ...this.tokens.values()];
	}

	/** `text` with the client secret and every token masked. */
	mask(text: string): string {
		return maskCredentials(text, this.secrets());
	}

	private log(line: string): void {
		this.options.log(this.mask(line));
	}

	private showError(message: string, ...actions: string[]): Thenable<string | undefined> {
		return this.ui.error(this.mask(message), ...actions);
	}

	/** An error; for a refused token, with Connect service account (which runs when chosen). */
	private showErrorOfferingConnect(message: string, err: unknown): void {
		if (err instanceof CloudError && err.kind === 'unauthorized') {
			void Promise.resolve(this.showError(message, CONNECT_ACTION)).then((choice) => (choice === CONNECT_ACTION ? this.connect() : undefined));
		} else {
			void this.showError(message);
		}
	}

	private showInfo(message: string, ...actions: string[]): Thenable<string | undefined> {
		return this.ui.info(this.mask(message), ...actions);
	}

	private setConnectedContext(): void {
		void vscode.commands.executeCommand('setContext', CONNECTED_KEY, this.connected);
	}

	private fire(): void {
		this.changeEmitter.fire(undefined);
	}

	private resetData(): void {
		this.generation++;
		this.clusters = undefined;
		this.clustersLoading = undefined;
		this.pipelines.clear();
		this.pipelinesLoading.clear();
		this.pipelinesLoadedAt.clear();
	}

	/**
	 * Reads the stored account: at activation and after another window's change. A client ID without
	 * its secret (a pair being written or removed elsewhere) is no account, silently. A changed account
	 * starts over as at startup: nothing is requested until the user asks.
	 */
	private async readAccount(): Promise<void> {
		const generation = this.accountGeneration;
		let clientId: string | undefined;
		let secret: string | undefined;
		try {
			[clientId, secret] = await Promise.all([this.options.store.get(CLIENT_ID_KEY), this.options.store.get(CLIENT_SECRET_KEY)]);
		} catch (err) {
			this.log(`Redpanda Cloud: could not read the secret storage: ${reasonOf(err)}`);
		}
		if (generation !== this.accountGeneration) {
			return; // this window connected or disconnected meanwhile
		}
		if (secret) {
			this.seenSecrets.add(secret);
		}
		const stored = clientId && secret ? clientId : undefined;
		if (stored === this.account?.clientId) {
			this.setConnectedContext();
			return;
		}
		this.accountGeneration++;
		this.resetData();
		this.tokens.clear();
		this.requested = false;
		this.account = stored ? { clientId: stored } : undefined;
		this.setConnectedContext();
		this.fire();
	}

	/** The stored service account (the secret read now), `undefined` when none is complete. */
	private async storedAccount(): Promise<ServiceAccount | undefined> {
		await this.ready;
		if (!this.account) {
			return undefined;
		}
		const clientSecret = await this.options.store.get(CLIENT_SECRET_KEY);
		if (!clientSecret) {
			return undefined;
		}
		this.seenSecrets.add(clientSecret);
		return { clientId: this.account.clientId, clientSecret };
	}

	/** A call with the stored account's token (requested once, then cached). */
	private call(): CloudCall {
		return {
			http: { fetch: this.options.fetch ?? defaultFetch, log: (line) => this.log(line), secrets: () => this.secrets() },
			invalidate: (token) => this.tokens.invalidate(token),
			token: async () => {
				const account = await this.storedAccount();
				if (!account) {
					throw new CloudError('unauthorized', 'no service account is connected');
				}
				const token = await this.tokens.get(account);
				if (token.clientName && this.account && this.account.name !== token.clientName) {
					this.account.name = token.clientName;
					this.fire();
				}
				return token.accessToken;
			},
		};
	}

	// --- connect and disconnect ---

	/** Connect service account: the client ID, then the secret; stored only once a token is granted. */
	async connect(): Promise<boolean> {
		const nonEmpty = (what: string) => (text: string) => (text.trim() ? undefined : `Enter the ${what}.`);
		const clientId = (await this.ui.input({
			title: 'Connect a Redpanda Cloud service account (1/2)',
			prompt: "The service account's client ID (Redpanda Cloud: Organization IAM, Service accounts).",
			ignoreFocusOut: true,
			validateInput: nonEmpty('client ID'),
		}))?.trim();
		if (!clientId) {
			return false;
		}
		const clientSecret = (await this.ui.input({
			title: 'Connect a Redpanda Cloud service account (2/2)',
			prompt: `The client secret of ${clientId}. It is kept in VS Code's secret storage on this machine only.`,
			password: true,
			ignoreFocusOut: true,
			validateInput: nonEmpty('client secret'),
		}))?.trim();
		if (!clientSecret) {
			return false;
		}
		const account: ServiceAccount = { clientId, clientSecret };
		// Masked from here on, also when the connect fails.
		this.seenSecrets.add(clientSecret);
		// A disconnect or another connect while the token is requested wins: this one then stores nothing.
		const generation = ++this.accountGeneration;
		let clientName: string | undefined;
		try {
			// A new token tests the secret; a valid cached one of the same client ID stays until it is granted.
			const token = await this.ui.progress('Connecting the Redpanda Cloud service account', () => this.tokens.get(account, { fresh: true }));
			clientName = token.clientName;
		} catch (err) {
			const message = asCloudError(err).message;
			this.log(`Redpanda Cloud: could not connect ${clientId}: ${message}`);
			void this.showError(`Could not connect the service account: ${message}.`);
			return false;
		}
		if (generation !== this.accountGeneration) {
			this.log(`Redpanda Cloud: the connect of ${clientId} was superseded; nothing was stored.`);
			return false;
		}
		const previous = this.account;
		if (previous && previous.clientId !== clientId) {
			this.tokens.clear(previous.clientId);
		}
		this.resetData();
		this.account = { clientId, ...(clientName ? { name: clientName } : {}) };
		this.ready = Promise.resolve();
		// The secret first: another window reading in between finds no client ID, so no account.
		this.writing++;
		try {
			await this.options.store.store(CLIENT_SECRET_KEY, clientSecret);
			await this.options.store.store(CLIENT_ID_KEY, clientId);
		} catch (err) {
			await Promise.allSettled([this.removeStored(CLIENT_ID_KEY), this.removeStored(CLIENT_SECRET_KEY)]);
			this.accountGeneration++;
			this.tokens.clear();
			this.account = undefined;
			this.setConnectedContext();
			this.fire();
			this.log(`Redpanda Cloud: could not store the service account: ${reasonOf(err)}`);
			void this.showError(`Could not store the service account in the secret storage: ${reasonOf(err)}`);
			return false;
		} finally {
			this.writing--;
		}
		this.setConnectedContext();
		this.fire();
		this.log(`Redpanda Cloud: connected the service account ${this.accountName}.`);
		void this.showInfo(`Connected the Redpanda Cloud service account ${this.accountName}.`);
		this.requested = true;
		await this.loadClusters(true);
		this.fire();
		return true;
	}

	/**
	 * Deletes `key` only when it is stored. A secret-storage delete resolves before VS Code's
	 * application storage has settled it, and a store of the same key within some tens of
	 * milliseconds can then be undone by it (seen in the tests: a disconnect, then a connect,
	 * lost the new account). A delete of a key that is not stored is never sent.
	 */
	private async removeStored(key: string): Promise<void> {
		if ((await this.options.store.get(key)) !== undefined) {
			await this.options.store.delete(key);
		}
	}

	/** Disconnect: the stored client ID and secret and the cached token are removed. */
	async disconnect(): Promise<boolean> {
		const name = this.accountName;
		this.accountGeneration++;
		this.tokens.clear();
		this.account = undefined;
		this.resetData();
		this.ready = Promise.resolve();
		this.setConnectedContext();
		this.fire();
		this.writing++;
		try {
			await this.removeStored(CLIENT_ID_KEY);
			await this.removeStored(CLIENT_SECRET_KEY);
		} catch (err) {
			void this.showError(`Could not remove the service account from the secret storage: ${reasonOf(err)}`);
			this.ready = this.readAccount();
			return false;
		} finally {
			this.writing--;
		}
		if (name) {
			this.log(`Redpanda Cloud: disconnected the service account ${name}.`);
			void this.showInfo(`Disconnected the Redpanda Cloud service account ${name}.`);
		}
		return true;
	}

	// --- loading ---

	private dataplaneUrlOf(c: CloudCluster): string | undefined {
		if (!c.dataplaneUrl) {
			return undefined;
		}
		return !this.endpoints.requireHttps || c.dataplaneUrl.startsWith('https://') ? c.dataplaneUrl : undefined;
	}

	private clusterById(id: string): CloudCluster | undefined {
		return this.clusters?.kind === 'ok' ? this.clusters.value.find((c) => c.id === id) : undefined;
	}

	/** Reads the clusters (again with `force`); a failure is kept for the view and shown once. */
	private loadClusters(force: boolean): Promise<void> {
		if (!this.account) {
			return Promise.resolve();
		}
		if (this.clustersLoading) {
			return this.clustersLoading;
		}
		if (this.clusters && !force) {
			return Promise.resolve();
		}
		const generation = this.generation;
		const load = (async () => {
			try {
				const clusters = await listClusters(this.call(), this.endpoints.controlPlaneUrl);
				const checked = clusters.map((c) => (c.dataplaneUrl && !this.dataplaneUrlOf(c)
					? { ...c, dataplaneUrl: undefined, detailError: 'its Data Plane address is not https' } : c));
				if (generation === this.generation) {
					this.clusters = { kind: 'ok', value: checked };
				}
			} catch (err) {
				const message = asCloudError(err).message;
				if (generation === this.generation) {
					this.clusters = { kind: 'error', message };
					this.log(`Redpanda Cloud: could not list the clusters: ${message}`);
					this.showErrorOfferingConnect(`Could not list the Redpanda Cloud clusters: ${message}`, err);
				}
			}
		})().finally(() => {
			if (this.clustersLoading === load) {
				this.clustersLoading = undefined;
			}
		});
		this.clustersLoading = load;
		return load;
	}

	/** Reads a cluster's pipelines (again with `force`); a failure becomes the cluster's error row. */
	private loadPipelines(clusterId: string, force: boolean): Promise<void> {
		const running = this.pipelinesLoading.get(clusterId);
		if (running) {
			return running;
		}
		if (this.pipelines.has(clusterId) && !force) {
			return Promise.resolve();
		}
		const cluster = this.clusterById(clusterId);
		const dp = cluster && this.dataplaneUrlOf(cluster);
		if (!dp) {
			return Promise.resolve();
		}
		const generation = this.generation;
		const load = (async () => {
			let loaded: Loaded<CloudPipeline[]>;
			try {
				loaded = { kind: 'ok', value: await listPipelines(this.call(), dp) };
			} catch (err) {
				const message = asCloudError(err).message;
				this.log(`Redpanda Cloud: could not list the pipelines of ${cluster.name}: ${message}`);
				loaded = { kind: 'error', message };
			}
			if (generation === this.generation) {
				this.pipelines.set(clusterId, loaded);
				this.pipelinesLoadedAt.set(clusterId, Date.now());
			}
		})().finally(() => {
			if (this.pipelinesLoading.get(clusterId) === load) {
				this.pipelinesLoading.delete(clusterId);
			}
		});
		this.pipelinesLoading.set(clusterId, load);
		return load;
	}

	/** A cluster was expanded: its pipelines are read again (unless they were just read for this expand). */
	async expanded(node: CloudNode): Promise<void> {
		if (node.kind === 'account' && !this.requested) {
			this.requested = true;
			await this.loadClusters(false);
			this.fire();
			return;
		}
		if (node.kind !== 'cluster' || this.pipelinesLoading.has(node.id)) {
			return;
		}
		const at = this.pipelinesLoadedAt.get(node.id);
		if (at !== undefined && Date.now() - at < 1_000) {
			return;
		}
		await this.loadPipelines(node.id, true);
		this.fire();
	}

	/**
	 * Refresh: a cluster's pipelines (`node`), or the clusters and the pipelines of every cluster
	 * read before. Resolves when they are read.
	 */
	async refresh(node?: CloudNode): Promise<void> {
		if (!this.account) {
			this.fire();
			return;
		}
		this.requested = true;
		if (node?.kind === 'cluster') {
			await this.loadPipelines(node.id, true);
			this.fire();
			return;
		}
		const read = [...this.pipelines.keys()];
		this.fire();
		await this.loadClusters(true);
		await Promise.all(read.filter((id) => this.clusterById(id)).map((id) => this.loadPipelines(id, true)));
		this.fire();
	}

	/** Puts `pipeline` into its cluster's list, when that list was read (an unread list stays unread). */
	private upsertPipeline(clusterId: string, pipeline: CloudPipeline): void {
		const current = this.pipelines.get(clusterId);
		if (current?.kind !== 'ok') {
			return;
		}
		this.pipelines.set(clusterId, { kind: 'ok', value: [...current.value.filter((p) => p.id !== pipeline.id), pipeline] });
		this.fire();
	}

	/** Takes a pipeline that is gone out of its cluster's list. */
	private removePipeline(clusterId: string, id: string): void {
		const current = this.pipelines.get(clusterId);
		if (current?.kind === 'ok' && current.value.some((p) => p.id === id)) {
			this.pipelines.set(clusterId, { kind: 'ok', value: current.value.filter((p) => p.id !== id) });
			this.fire();
		}
	}

	// --- the tree ---

	async getChildren(node?: CloudNode): Promise<CloudNode[]> {
		if (!node) {
			await this.ready;
		} else if (node.kind === 'account' && this.requested) {
			await this.loadClusters(false);
		} else if (node.kind === 'cluster') {
			await this.loadPipelines(node.id, false);
		}
		return this.cachedChildren(node);
	}

	/** The children as read so far (nothing is requested). */
	private cachedChildren(node?: CloudNode): CloudNode[] {
		if (!this.account) {
			return [];
		}
		if (!node) {
			return [{ kind: 'account' }];
		}
		if (node.kind === 'account') {
			if (!this.clusters) {
				return this.requested ? [] : [{ kind: 'note', id: 'clusters:notRead', text: NOT_READ_TEXT, error: false }];
			}
			if (this.clusters.kind === 'error') {
				return [{ kind: 'note', id: 'clusters:error', text: `Could not list the clusters: ${this.clusters.message}`, error: true }];
			}
			return this.clusters.value.length > 0
				? this.clusters.value.map((c): CloudNode => ({ kind: 'cluster', id: c.id }))
				: [{ kind: 'note', id: 'clusters:none', text: NO_CLUSTERS_TEXT, error: false }];
		}
		if (node.kind === 'cluster') {
			const loaded = this.pipelines.get(node.id);
			if (!loaded) {
				return [];
			}
			if (loaded.kind === 'error') {
				return [{ kind: 'note', id: `pipelines:${node.id}:error`, text: `Could not list the pipelines: ${loaded.message}`, error: true }];
			}
			return loaded.value.length > 0
				? loaded.value.map((p): CloudNode => ({ kind: 'pipeline', clusterId: node.id, id: p.id }))
				: [{ kind: 'note', id: `pipelines:${node.id}:none`, text: 'No pipelines.', error: false }];
		}
		return [];
	}

	/** The item the tree shows, its texts masked (the one masking path: `items()` reads this). */
	getTreeItem(node: CloudNode): vscode.TreeItem {
		const item = this.buildItem(node);
		if (typeof item.label === 'string') {
			item.label = this.mask(item.label);
		}
		if (typeof item.description === 'string') {
			item.description = this.mask(item.description);
		}
		if (typeof item.tooltip === 'string') {
			item.tooltip = this.mask(item.tooltip);
		}
		if (item.accessibilityInformation) {
			item.accessibilityInformation = { ...item.accessibilityInformation, label: this.mask(item.accessibilityInformation.label) };
		}
		return item;
	}

	private buildItem(node: CloudNode): vscode.TreeItem {
		switch (node.kind) {
			case 'account': {
				const item = new vscode.TreeItem(this.accountName ?? '', vscode.TreeItemCollapsibleState.Expanded);
				item.id = 'account';
				item.description = 'service account';
				item.iconPath = new vscode.ThemeIcon('account');
				item.contextValue = 'cloudAccount';
				item.tooltip = `The Redpanda Cloud service account ${this.accountName} (client ID ${this.account?.clientId}).`;
				item.accessibilityInformation = { label: `Service account ${this.accountName}` };
				return item;
			}
			case 'cluster': {
				const c = this.clusterById(node.id);
				const hasApi = !!c && !!this.dataplaneUrlOf(c);
				const item = new vscode.TreeItem(c?.name ?? node.id, hasApi ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
				item.id = `cluster:${node.id}`;
				item.description = c ? clusterDescription(c) : '';
				item.iconPath = new vscode.ThemeIcon('server');
				item.contextValue = hasApi ? 'cloudCluster' : c?.detailsUnread ? 'cloudCluster detailsUnread' : 'cloudCluster noPipelineApi';
				item.tooltip = c
					? `${c.name} (${c.id}): ${clusterDescription(c)}${c.detailError ? `. ${c.detailError}` : ''}${hasApi ? '' : c.detailsUnread ? '. Refresh to read them again.' : '. Pipelines cannot be deployed to it.'}`
					: node.id;
				item.accessibilityInformation = { label: `Cluster ${c?.name ?? node.id}, ${item.description}` };
				return item;
			}
			case 'pipeline': {
				const p = this.pipelineById(node.clusterId, node.id);
				const state = pipelineStateDescription(p);
				const local = this.localFileOf(p);
				const item = new vscode.TreeItem(p?.displayName ?? node.id, vscode.TreeItemCollapsibleState.None);
				item.id = `pipeline:${node.clusterId}:${node.id}`;
				const from = local.kind === 'ok' ? path.basename(local.path) : local.kind === 'outside' ? NOT_IN_WORKSPACE : undefined;
				item.description = from ? `${state} · ${from}` : state;
				item.iconPath = new vscode.ThemeIcon(stateIcon(p?.state));
				// A state the extension does not know is `state-unknown`: Delete only. ` hasFile`: Deploy again.
				item.contextValue = `cloudPipeline state-${stateKey(p?.state)}${local.kind === 'ok' ? ' hasFile' : ''}`;
				// A click opens the deployed config, read now.
				item.command = { command: OPEN_DEPLOYED_COMMAND, title: 'Open deployed config', arguments: [node] };
				const deployedFrom = local.kind === 'ok' ? `. Deployed from ${local.path}.`
					: local.kind === 'outside' ? `. Deployed from ${local.tag}, which is ${NOT_IN_WORKSPACE}.` : '.';
				item.tooltip = `${p?.displayName ?? node.id} (${node.id}): ${state}${deployedFrom}`;
				item.accessibilityInformation = { label: `Pipeline ${p?.displayName ?? node.id}, ${state}${from ? `, ${local.kind === 'ok' ? `deployed from ${from}` : `its file ${from}`}` : ''}` };
				return item;
			}
			case 'note': {
				const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
				item.id = node.id;
				item.iconPath = new vscode.ThemeIcon(node.error ? 'error' : 'info');
				item.contextValue = node.error ? 'cloudError' : 'cloudNote';
				if (node.id === 'clusters:notRead' || node.error) {
					item.command = { command: CLOUD_REFRESH_COMMAND, title: 'Refresh' };
				}
				item.tooltip = node.text;
				item.accessibilityInformation = { label: node.text };
				return item;
			}
		}
	}

	/**
	 * The file a pipeline was deployed from: its tag resolved inside the workspace folders only, the
	 * first that is a file there; a tag outside them, or naming no file, is `outside`.
	 */
	private localFileOf(p: CloudPipeline | undefined): LocalFile {
		const tag = p?.tags[CONFIG_TAG];
		if (!tag) {
			return { kind: 'none' };
		}
		const found = taggedConfigs(tag, this.workspaceFolders()).find((file) => {
			try {
				return fs.statSync(file).isFile();
			} catch {
				return false;
			}
		});
		return found ? { kind: 'ok', tag, path: found } : { kind: 'outside', tag };
	}

	private pipelineById(clusterId: string, id: string): CloudPipeline | undefined {
		const loaded = this.pipelines.get(clusterId);
		return loaded?.kind === 'ok' ? loaded.value.find((p) => p.id === id) : undefined;
	}

	/** Every item read so far, depth first, as `getTreeItem` gives it (the test seam; nothing is requested). */
	items(): CloudItem[] {
		const out: CloudItem[] = [];
		const walk = (nodes: readonly CloudNode[]) => {
			for (const node of nodes) {
				const item = this.getTreeItem(node);
				const label = typeof item.label === 'string' ? item.label : item.label?.label ?? '';
				out.push({
					node,
					label,
					description: typeof item.description === 'string' ? item.description : '',
					contextValue: item.contextValue ?? '',
					tooltip: typeof item.tooltip === 'string' ? item.tooltip : item.tooltip?.value ?? '',
					accessibility: item.accessibilityInformation?.label ?? label,
					expandable: item.collapsibleState !== vscode.TreeItemCollapsibleState.None,
					icon: item.iconPath instanceof vscode.ThemeIcon ? item.iconPath.id : '',
				});
				walk(this.cachedChildren(node));
			}
		};
		walk(this.cachedChildren(undefined));
		return out;
	}

	dispose(): void {
		this.subscriptions.forEach((s) => s.dispose());
	}

	// --- deploy ---

	/** The deployed config of a pipeline, read-only (`redpanda-cloud:/<cluster>/<pipeline>/<name>.yaml`). */
	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.deployedConfigs.get(uri.toString()) ?? DEPLOYED_NOT_LOADED_TEXT;
	}

	/** Shows `pipeline`'s deployed config beside the text that would be sent (deployed ↔ as sent, both read-only). */
	private async showDiff(cluster: CloudCluster, pipeline: CloudPipeline, sent: string, file: string): Promise<void> {
		const left = deployedConfigUri(cluster.id, pipeline.id, pipeline.displayName);
		const right = sentConfigUri(cluster.id, pipeline.id, pipeline.displayName);
		this.deployedConfigs.set(left.toString(), pipeline.configYaml);
		this.deployedConfigs.set(right.toString(), sent);
		this.deployedChanged.fire(left);
		this.deployedChanged.fire(right);
		try {
			await vscode.commands.executeCommand('vscode.diff', left, right, `${pipeline.displayName} (deployed) ↔ ${file} (as sent)`, { preview: true });
		} catch (err) {
			this.log(`Redpanda Cloud: could not open the diff of ${file}: ${reasonOf(err)}`);
		}
	}

	/** Deploy to Redpanda Cloud: `uri` (default: the active editor's file), created or updated. Never throws. */
	async deploy(uri?: vscode.Uri, only?: OnlyPipeline): Promise<DeployResult> {
		try {
			return await this.deployFile(uri, only);
		} catch (err) {
			const message = this.mask(reasonOf(err));
			this.log(`Redpanda Cloud: deploy failed: ${message}`);
			void this.showError(`Deploy failed: ${message}`);
			return { kind: 'failed', message };
		}
	}

	private async deployFile(uri: vscode.Uri | undefined, only?: OnlyPipeline): Promise<DeployResult> {
		const doc = uri
			? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) ?? (uri.scheme === 'file' ? await vscode.workspace.openTextDocument(uri) : undefined)
			: vscode.window.activeTextEditor?.document;
		if (!doc) {
			void this.showInfo('Open a Redpanda Connect config to deploy it.');
			return NOT_STARTED;
		}
		if (doc.isUntitled) {
			void this.showInfo(DEPLOY_UNTITLED_MESSAGE);
			return NOT_STARTED;
		}
		if (doc.uri.scheme !== 'file') {
			void this.showInfo(DEPLOY_NOT_ON_DISK_MESSAGE);
			return NOT_STARTED;
		}
		if (!this.options.isDetected(doc.uri)) {
			void this.showInfo(DEPLOY_NOT_DETECTED_MESSAGE);
			return NOT_STARTED;
		}
		const file = path.basename(doc.uri.fsPath);
		// Translated before anything is asked or sent, so a refusal costs no prompt and no request; done
		// again just before sending, so edits made during the prompts are sent.
		if ((await this.savedAndTranslated(doc, file)) === undefined) {
			return NOT_STARTED;
		}
		await this.ready;
		if (!this.account) {
			const choice = await this.showInfo(NOT_CONNECTED_MESSAGE, CONNECT_ACTION);
			if (choice !== CONNECT_ACTION || !(await this.connect())) {
				return NOT_STARTED;
			}
		}
		this.requested = true;
		await this.loadClusters(false);
		if (this.clusters?.kind !== 'ok') {
			// The failure was shown when it was read; a failure kept from before is shown again.
			if (this.clusters?.kind === 'error') {
				void this.showError(`Could not list the Redpanda Cloud clusters: ${this.clusters.message}`);
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
			this.log(`Redpanda Cloud: did not deploy ${file} again to ${only.name}: ${mappingName} no longer maps it to that pipeline.`);
			void this.showInfo(`${mappingName} no longer maps ${file} to ${only.name}. Nothing was sent.`);
			return NOT_STARTED;
		}
		if (read.kind === 'none') {
			target = await this.newTarget(file, rel, true);
		} else if (read.kind === 'bad') {
			this.log(`Redpanda Cloud: ${mappingFile} is not a deploy mapping: ${read.reason}`);
			const choice = await this.showError(
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
		const resources = await this.ui.pickUnits(
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
			const result = await this.ui.progress(`Deploying ${name} to ${cluster.name}`, (report) =>
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
			this.log(`Redpanda Cloud: pipeline ${name} (${deployed.id}) on ${cluster.name} already has ${file} as saved and translated (${stateWord(deployed.state)}), with ${resourcesText(resources)}; nothing was sent.`);
			void this.showInfo(`Pipeline ${name} on ${cluster.name} is already deployed from ${file}, nothing changed.`);
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
			const choice = await this.ui.confirm(this.mask(`Pipeline ${name} on ${cluster.name} is ${stateWord(deployed.state)}. ${what}`), REPLACE_ACTION);
			if (choice !== REPLACE_ACTION) {
				if (createdSecrets.length > 0) {
					const kept = `Created ${createdSecrets.join(', ')} on ${cluster.name}; they stay. The pipeline was not updated.`;
					this.log(`Redpanda Cloud: ${kept}`);
					void this.showInfo(kept);
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
		const result = await this.ui.progress(`Updating ${name} on ${cluster.name}`, (report) =>
			this.updateAndFollow(cluster, dp, deployed.id, update, wasRunning, report, mapTo));
		this.report(file, name, cluster, result, 'update');
		return result;
	}

	/**
	 * As Run: a dirty config is saved first; the saved file's text, translated for the Cloud (the file
	 * itself is never changed). `undefined`: not saved, or refused (each problem shown and logged).
	 */
	private async savedAndTranslated(doc: vscode.TextDocument, file: string): Promise<{ readonly text: string; readonly secrets: readonly CloudSecretUse[] } | undefined> {
		if (doc.isDirty && !(await doc.save())) {
			this.log(`Redpanda Cloud: ${file} could not be saved; not deployed.`);
			void this.showError(`${file} could not be saved, so it was not deployed.`);
			return undefined;
		}
		const translation = translateForCloud(await fs.promises.readFile(doc.uri.fsPath, 'utf8'));
		if (translation.kind === 'ok') {
			return { text: translation.text, secrets: translation.secrets };
		}
		const { problems } = translation;
		this.log(`Redpanda Cloud: ${file} was not deployed: ${problems.length === 1 ? 'one problem' : `${problems.length} problems`} for Redpanda Cloud.`);
		problems.forEach((p) => this.log(`  ${file}: ${p.message}`));
		void this.showError(`${file} can't be deployed to Redpanda Cloud: ${problems.map((p) => p.message).join('; ')}. Nothing was sent.`);
		return undefined;
	}

	/** Masks `value` (and its base64 form, as sent) from now on. */
	private maskValue(value: string): void {
		if (value) {
			this.seenSecrets.add(value);
			this.seenSecrets.add(Buffer.from(value, 'utf8').toString('base64'));
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
			existing = await this.ui.progress(`Checking the secrets of ${file} on ${cluster.name}`, (report) => {
				report('reading the cluster\'s secrets…');
				return listSecretNames(this.call(), dp, cluster.name);
			});
		} catch (err) {
			const message = asCloudError(err).message;
			this.log(`Redpanda Cloud: could not read the secrets of ${cluster.name}: ${message}`);
			this.showErrorOfferingConnect(`Could not read the secrets of ${cluster.name}: ${message}. Nothing was sent.`, err);
			return { stopped: { kind: 'failed', message: this.mask(`could not read the secrets of ${cluster.name}: ${message}`) }, created };
		}
		const missing = secrets.filter((s) => !existing.has(s.name));
		if (missing.length === 0) {
			return { created };
		}
		let local: ReadonlyMap<string, LocalValue>;
		try {
			local = this.options.localValues?.(uri) ?? new Map<string, LocalValue>();
		} catch (err) {
			this.log(`Redpanda Cloud: could not read the local values of ${file}: ${reasonOf(err)}`);
			local = new Map<string, LocalValue>();
		}
		for (const s of missing) {
			const v = local.get(s.name);
			if (v) {
				this.maskValue(v.value);
			}
		}
		const stopped = (name: string): DeployResult => {
			this.log(`Redpanda Cloud: the deploy of ${file} stopped at the secret ${name}; nothing more was sent.`);
			return NOT_STARTED;
		};
		const title = (name: string) => `Deploy ${file} to ${cluster.name}: the secret ${name}`;
		for (const s of missing) {
			const v = local.get(s.name);
			let value: string | undefined;
			if (v) {
				const keep = keepValueAction(v);
				const choices = [keep, ENTER_ANOTHER_ACTION, ...(s.required ? [] : [USE_DEFAULT_ACTION])];
				const choice = await this.ui.pickChoice(title(s.name), this.mask(
					`${cluster.name} has no secret ${s.name}, which ${file} uses${s.required ? '' : ' (with a default)'}. ${s.name} is set in ${localSourceText(v)}.`), choices);
				if (choice === USE_DEFAULT_ACTION) {
					this.log(`Redpanda Cloud: the secret ${s.name} was not created on ${cluster.name}; the pipeline uses its default.`);
					continue;
				}
				if (choice === keep) {
					value = v.value;
				} else if (choice === ENTER_ANOTHER_ACTION) {
					value = await this.askSecretValue(s.name, cluster, file);
				}
			} else if (s.required) {
				const choice = await this.ui.pickChoice(title(s.name), this.mask(
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
				const answer = await this.ui.progress(`Creating the secret ${s.name} on ${cluster.name}`, (report) => {
					report('creating the secret…');
					return createSecret(this.call(), dp, s.name, secret);
				});
				if (answer === 'created') {
					created.push(s.name);
				}
				this.log(answer === 'created'
					? `Redpanda Cloud: created the secret ${s.name} on ${cluster.name}.`
					: `Redpanda Cloud: the secret ${s.name} already exists on ${cluster.name} (created meanwhile); it was not changed.`);
			} catch (err) {
				const message = asCloudError(err).message;
				this.log(`Redpanda Cloud: could not create the secret ${s.name} on ${cluster.name}: ${message}`);
				this.showErrorOfferingConnect(`Could not create the secret ${s.name} on ${cluster.name}: ${message}. The pipeline was not sent.`, err);
				return { stopped: { kind: 'failed', message: this.mask(`could not create the secret ${s.name}: ${message}`) }, created };
			}
		}
		return { created };
	}

	/** A missing secret's value, typed in a password box (masked at once); `undefined`: cancelled. */
	private async askSecretValue(name: string, cluster: CloudCluster, file: string): Promise<string | undefined> {
		const value = await this.ui.input({
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
		const all = this.clusters?.kind === 'ok' ? this.clusters.value : [];
		const targets = all.filter((c) => this.dataplaneUrlOf(c));
		if (targets.length === 0) {
			const unread = all.filter((c) => c.detailsUnread);
			void this.showError(unread.length > 0
				? `Could not read the details of ${unread.map((c) => `${c.name} (${c.detailsUnread})`).join(', ')}, so no cluster to deploy to is known. Refresh the Cloud view to try again.`
				: 'No cluster of this organization offers the pipeline API: deploy needs a BYOC or Dedicated cluster with a Data Plane address.');
			return undefined;
		}
		return this.ui.pickCluster(targets, `Deploy ${file} to Redpanda Cloud`);
	}

	private async askName(file: string, cluster: CloudCluster, value = path.basename(file, path.extname(file))): Promise<string | undefined> {
		return (await this.ui.input({
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
		const dp = cluster && this.dataplaneUrlOf(cluster);
		if (!cluster || !dp) {
			return NOT_STARTED;
		}
		if (offerTagged) {
			await this.loadPipelines(cluster.id, true);
			this.fire();
			const listed = this.pipelines.get(cluster.id);
			if (listed?.kind !== 'ok') {
				const reason = listed?.kind === 'error' ? listed.message : 'its pipelines were not read';
				void this.showError(`Could not check whether ${cluster.name} already has a pipeline deployed from ${file}: ${reason}. Nothing was deployed.`);
				return NOT_STARTED;
			}
			const tagged = listed.value.filter((p) => p.tags[CONFIG_TAG] === rel);
			if (tagged.length > 0) {
				const names = tagged.map((p) => p.displayName);
				const updates = tagged.map((p) => (names.filter((n) => n === p.displayName).length > 1 ? `Update ${p.displayName} (${p.id})` : `Update ${p.displayName}`));
				const choice = await this.ui.confirm(this.mask(
					`${cluster.name} has ${tagged.length === 1 ? 'a pipeline' : 'pipelines'} deployed from ${rel}: ${names.join(', ')}. Update ${tagged.length === 1 ? 'it' : 'one'}, or create a new pipeline?`),
				...updates, CREATE_NEW_ACTION);
				if (choice === undefined) {
					return NOT_STARTED;
				}
				const at = updates.indexOf(choice);
				if (at >= 0) {
					const read = await this.readPipeline(cluster, dp, tagged[at].id, tagged[at].displayName);
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
		const cluster = this.clusterById(m.clusterId);
		if (cluster?.detailsUnread) {
			void this.showError(`Could not read the details of ${cluster.name} (${cluster.detailsUnread}), the cluster ${mappingName} maps ${file} to. Refresh the Cloud view to try again.`);
			return NOT_STARTED;
		}
		const dp = cluster && this.dataplaneUrlOf(cluster);
		if (!cluster || !dp) {
			const named = cluster?.name ?? m.clusterName ?? m.clusterId;
			this.log(`Redpanda Cloud: the cluster ${named} (${m.clusterId}) of ${mappingName} is gone or offers no pipeline API.`);
			if (strict) {
				void this.showInfo(`The cluster ${named} that ${mappingName} maps ${file} to is gone or no longer offers the pipeline API. Nothing was sent.`);
				return NOT_STARTED;
			}
			const choice = await this.showInfo(
				`The cluster ${named} that ${mappingName} maps ${file} to is gone or no longer offers the pipeline API. Create a new pipeline on another cluster?`, CREATE_NEW_PIPELINE_ACTION);
			return choice === CREATE_NEW_PIPELINE_ACTION ? this.newTarget(file, rel, false) : NOT_STARTED;
		}
		const read = await this.readPipeline(cluster, dp, m.pipelineId, m.pipelineName ?? m.pipelineId);
		if (read.kind === 'ok') {
			return { kind: 'update', cluster, dp, pipeline: read.value };
		}
		if (read.status !== 404) {
			return { kind: 'failed', message: read.message };
		}
		this.removePipeline(cluster.id, m.pipelineId);
		if (strict) {
			this.log(`Redpanda Cloud: pipeline ${m.pipelineName ?? m.pipelineId} (${m.pipelineId}) is gone from ${cluster.name}; ${file} was not deployed again.`);
			void this.showInfo(`Pipeline ${m.pipelineName ?? m.pipelineId}, which ${mappingName} maps ${file} to, is no longer on ${cluster.name}. Nothing was sent.`);
			return NOT_STARTED;
		}
		const choice = await this.showInfo(
			`Pipeline ${m.pipelineName ?? m.pipelineId}, which ${mappingName} maps ${file} to, is no longer on ${cluster.name}. Create a new pipeline?`, CREATE_NEW_PIPELINE_ACTION);
		if (choice !== CREATE_NEW_PIPELINE_ACTION) {
			return NOT_STARTED;
		}
		const name = await this.askName(file, cluster, m.pipelineName);
		return name ? { kind: 'create', cluster, dp, name } : NOT_STARTED;
	}

	/** `GET` a pipeline; a failure other than 404 is shown (404 is the caller's). */
	private async readPipeline(cluster: CloudCluster, dp: string, id: string, shown: string)
		: Promise<{ readonly kind: 'ok'; readonly value: CloudPipeline } | { readonly kind: 'error'; readonly message: string; readonly status?: number }> {
		try {
			const value = await getPipeline(this.call(), dp, id);
			this.upsertPipeline(cluster.id, value);
			return { kind: 'ok', value };
		} catch (err) {
			const error = asCloudError(err);
			if (error.status !== 404) {
				this.log(`Redpanda Cloud: could not read pipeline ${shown} on ${cluster.name}: ${error.message}`);
				this.showErrorOfferingConnect(`Could not read pipeline ${shown} on ${cluster.name}: ${error.message}`, err);
			}
			return { kind: 'error', message: `could not read pipeline ${shown}: ${error.message}`, ...(error.status !== undefined ? { status: error.status } : {}) };
		}
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
			this.log(`Redpanda Cloud: ${file} maps the config to pipeline ${m.pipelineName ?? m.pipelineId} (${m.pipelineId}) on ${m.clusterName ?? m.clusterId}.`);
		} catch (err) {
			this.log(`Redpanda Cloud: could not write ${file}: ${reasonOf(err)}`);
			void this.showError(`Could not write ${path.basename(file)}: ${reasonOf(err)}. The next Deploy will not know the pipeline it went to.`);
		}
	}

	private async createAndFollow(
		cluster: CloudCluster, dp: string, create: CreatePipeline, report: (message: string) => void, created: (p: CloudPipeline) => Promise<void>,
	): Promise<DeployResult> {
		report('creating the pipeline…');
		let current: CloudPipeline;
		try {
			current = await createPipeline(this.call(), dp, create);
		} catch (err) {
			return this.sendFailed(err);
		}
		await created(current);
		// A list never read is read in full now (it holds the new pipeline), not replaced by it alone.
		if (this.pipelines.get(cluster.id)?.kind !== 'ok') {
			await this.loadPipelines(cluster.id, true);
		}
		this.upsertPipeline(cluster.id, current);
		this.fire();
		return this.follow(cluster, dp, current, create.displayName, report);
	}

	private async updateAndFollow(
		cluster: CloudCluster, dp: string, id: string, update: UpdatePipeline, restart: boolean, report: (message: string) => void,
		updated: (p: CloudPipeline) => Promise<void>,
	): Promise<DeployResult> {
		report('updating the pipeline…');
		let current: CloudPipeline;
		try {
			current = await updatePipeline(this.call(), dp, id, update);
		} catch (err) {
			return this.sendFailed(err, id);
		}
		await updated(current);
		this.upsertPipeline(cluster.id, current);
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
	private async follow(
		cluster: CloudCluster, dp: string, first: CloudPipeline, name: string, report: (message: string) => void,
		change?: { readonly from: PipelineState; readonly waiting: string },
		/** The error that ended the follow, when reading the state failed. */
		onFailure?: (err: unknown) => void,
	): Promise<DeployResult> {
		let current = first;
		const deadline = Date.now() + this.timeoutMs;
		let lastChange = Date.now();
		let changed = !change || current.state !== change.from;
		let failures = 0;
		for (;;) {
			if (changed && FINAL_STATES.includes(current.state)) {
				break;
			}
			if (!changed && Date.now() - lastChange >= this.restartGraceMs) {
				break;
			}
			if (Date.now() >= deadline) {
				return { kind: 'timedOut', pipelineId: current.id };
			}
			report(changed || !change ? `${pipelineStateText(current.state)}…` : change.waiting);
			await sleep(this.pollMs);
			try {
				const next = await getPipeline(this.call(), dp, current.id);
				failures = 0;
				if (next.state !== current.state) {
					lastChange = Date.now();
				}
				current = next;
				if (current.state !== change?.from) {
					changed = true;
				}
				this.upsertPipeline(cluster.id, current);
			} catch (err) {
				const error = asCloudError(err);
				this.log(`Redpanda Cloud: could not read the state of ${name}: ${error.message}`);
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
				this.log(`Redpanda Cloud: ${cluster.name} rejected ${file}: ${result.message}`);
				result.hints.forEach((h) => this.log(`  ${file}: ${h}`));
				void this.showError(`${cluster.name} rejected ${file} (${result.message})${hints}. ${updated ? `Pipeline ${name} was not updated.` : 'No pipeline was created.'}`);
				return;
			}
			case 'failed': {
				const what = updated ? `Updating pipeline ${name} ${on} with ${file}` : `Deploying ${file} as ${name} ${on}`;
				this.log(`Redpanda Cloud: ${what} failed: ${result.message}`);
				void this.showError(`${what} failed: ${result.message}`);
				return;
			}
			case 'timedOut':
				this.log(`Redpanda Cloud: pipeline ${name} ${on} is still starting after ${Math.round(this.timeoutMs / 1000)} s.`);
				void this.showInfo(`Pipeline ${name} is still starting ${on}; the Cloud view shows its state.`);
				return;
			case 'final': {
				const state = pipelineStateText(result.state);
				if (result.state === 'STATE_ERROR') {
					const reason = result.error ?? NO_REASON;
					this.log(`Redpanda Cloud: pipeline ${name} ${on} is in Error: ${reason}`);
					void this.showError(`Pipeline ${name} ${on} is in Error: ${reason}.`);
					return;
				}
				this.log(`Redpanda Cloud: pipeline ${name} (${result.pipelineId}) ${on} is ${state}${updated ? ', updated from ' + file : ''}.`);
				void this.showInfo(updated ? `Updated pipeline ${name} ${on}; it is ${stateWord(result.state)}.` : `Pipeline ${name} is ${stateWord(result.state)} ${on}.`);
				return;
			}
			case 'notStarted':
			case 'unchanged':
				return;
		}
	}

	// --- start, stop and delete (ticket 5.4) ---

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
			const message = this.mask(reasonOf(err));
			this.log(`Redpanda Cloud: ${action} failed: ${message}`);
			void this.showError(`${ACTION_TEXT[action].failed} failed: ${message}`);
			return { kind: 'failed', message };
		}
	}

	/**
	 * The action's pipeline: a row's (as the view shows it), or, from the palette, the one the active
	 * config's `.cloud.json` maps to (read now), else one picked from every cluster's pipelines.
	 */
	private async actionTarget(action: PipelineAction, node: Extract<CloudNode, { kind: 'pipeline' }> | undefined): Promise<ActionTarget | PipelineActionResult> {
		await this.ready;
		if (!this.account) {
			const choice = await this.showInfo('No Redpanda Cloud service account is connected.', CONNECT_ACTION);
			if (choice !== CONNECT_ACTION || !(await this.connect())) {
				return NOT_STARTED;
			}
		}
		const doc = vscode.window.activeTextEditor?.document;
		const config = doc && !doc.isUntitled && doc.uri.scheme === 'file' && this.options.isDetected(doc.uri) ? doc.uri : undefined;
		if (node) {
			const cluster = this.clusterById(node.clusterId);
			const dp = cluster && this.dataplaneUrlOf(cluster);
			const pipeline = this.pipelineById(node.clusterId, node.id);
			if (!cluster || !dp || !pipeline) {
				void this.showInfo('That pipeline is no longer in the Cloud view. Refresh the view to read the pipelines again.');
				return NOT_STARTED;
			}
			return { cluster, dp, pipeline, ...(config ? { config } : {}) };
		}
		this.requested = true;
		await this.loadClusters(false);
		if (this.clusters?.kind !== 'ok') {
			if (this.clusters?.kind === 'error') {
				void this.showError(`Could not list the Redpanda Cloud clusters: ${this.clusters.message}`);
			}
			return NOT_STARTED;
		}
		if (config) {
			const file = path.basename(config.fsPath);
			const mappingName = path.basename(sidecarPath(config.fsPath));
			const read = await readMapping(sidecarPath(config.fsPath));
			if (read.kind === 'ok') {
				const m = read.mapping;
				const cluster = this.clusterById(m.clusterId);
				const dp = cluster && this.dataplaneUrlOf(cluster);
				if (!cluster || !dp) {
					const named = cluster?.name ?? m.clusterName ?? m.clusterId;
					void this.showInfo(`The cluster ${named} that ${mappingName} maps ${file} to is gone or no longer offers the pipeline API.`);
					return NOT_STARTED;
				}
				const got = await this.readPipeline(cluster, dp, m.pipelineId, m.pipelineName ?? m.pipelineId);
				if (got.kind === 'ok') {
					return { cluster, dp, pipeline: got.value, config };
				}
				if (got.status === 404) {
					this.removePipeline(cluster.id, m.pipelineId);
					void this.showInfo(`Pipeline ${m.pipelineName ?? m.pipelineId}, which ${mappingName} maps ${file} to, is no longer on ${cluster.name}.`);
					return NOT_STARTED;
				}
				return { kind: 'failed', message: got.message };
			}
		}
		const clusters = this.clusters.value.filter((c) => this.dataplaneUrlOf(c));
		await Promise.all(clusters.map((c) => this.loadPipelines(c.id, true)));
		this.fire();
		const choices: PipelineChoice[] = [];
		const unread: string[] = [];
		for (const c of clusters) {
			const listed = this.pipelines.get(c.id);
			if (listed?.kind === 'ok') {
				choices.push(...listed.value.map((pipeline) => ({
					cluster: c, pipeline, label: this.mask(pipeline.displayName), description: this.mask(`${c.name} · ${pipelineStateDescription(pipeline)}`),
				})));
			} else {
				unread.push(`${c.name} (${listed?.kind === 'error' ? listed.message : 'not read'})`);
			}
		}
		if (choices.length === 0) {
			void this.showInfo(`No pipeline on the clusters to ${action}.${unread.length > 0 ? ` Could not list the pipelines of ${unread.join(', ')}.` : ''}`);
			return NOT_STARTED;
		}
		const picked = await this.ui.pickPipeline(choices, `${ACTION_TEXT[action].title}: the pipeline`);
		if (!picked) {
			return NOT_STARTED;
		}
		const dp = this.dataplaneUrlOf(picked.cluster);
		return dp ? { cluster: picked.cluster, dp, pipeline: picked.pipeline, ...(config ? { config } : {}) } : NOT_STARTED;
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
		void this.showInfo(`Pipeline ${pipeline.displayName} on ${cluster.name} is ${stateWord(state)}: ${refused}.`);
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
			pipeline = await getPipeline(this.call(), dp, target.pipeline.id);
		} catch (err) {
			const message = describeCloudError(asCloudError(err));
			this.log(`Redpanda Cloud: could not ${action} pipeline ${target.pipeline.displayName} ${on}: ${message}`);
			this.showErrorOfferingConnect(`Could not ${action} pipeline ${target.pipeline.displayName} ${on}: ${message}`, err);
			await this.loadPipelines(cluster.id, true);
			this.fire();
			return { kind: 'failed', message, pipelineId: target.pipeline.id };
		}
		this.upsertPipeline(cluster.id, pipeline);
		const allowed = this.offered(action, { ...target, pipeline });
		if (!('pipeline' in allowed)) {
			return allowed;
		}
		const name = pipeline.displayName;
		const text = ACTION_TEXT[action];
		let cause: unknown;
		let accepted = false;
		const result = await this.ui.progress(`${text.progress} ${name} on ${cluster.name}`, async (report): Promise<DeployResult> => {
			report(`${text.progress.toLowerCase()} the pipeline…`);
			let current: CloudPipeline;
			try {
				current = await (action === 'start' ? startPipeline : stopPipeline)(this.call(), dp, pipeline.id);
			} catch (err) {
				cause = err;
				return { kind: 'failed', message: describeCloudError(asCloudError(err)), pipelineId: pipeline.id };
			}
			accepted = true;
			this.log(`Redpanda Cloud: ${text.done.toLowerCase()} pipeline ${name} (${pipeline.id}) on ${cluster.name}; it is ${stateWord(current.state)}.`);
			this.upsertPipeline(cluster.id, current);
			return this.follow(cluster, dp, current, name, report, { from: pipeline.state, waiting: `${text.progress.toLowerCase()}…` }, (err) => {
				cause = err;
			});
		});
		switch (result.kind) {
			case 'failed': {
				const shown = accepted
					? `${text.done} pipeline ${name} ${on}, but its state could not be read: ${asCloudError(cause).message}`
					: `Could not ${action} pipeline ${name} ${on}: ${result.message}`;
				this.log(`Redpanda Cloud: ${shown}`);
				this.showErrorOfferingConnect(shown, cause);
				await this.loadPipelines(cluster.id, true);
				this.fire();
				break;
			}
			case 'timedOut':
				this.log(`Redpanda Cloud: pipeline ${name} ${on} is still ${text.ongoing} after ${Math.round(this.timeoutMs / 1000)} s.`);
				void this.showInfo(`Pipeline ${name} is still ${text.ongoing} ${on}; the Cloud view shows its state.`);
				break;
			case 'final':
				if (result.state === 'STATE_ERROR') {
					const reason = result.error ?? NO_REASON;
					this.log(`Redpanda Cloud: pipeline ${name} ${on} is in Error: ${reason}`);
					void this.showError(`Pipeline ${name} ${on} is in Error: ${reason}.`);
				} else {
					this.log(`Redpanda Cloud: pipeline ${name} (${result.pipelineId}) ${on} is ${pipelineStateText(result.state)}.`);
					void this.showInfo(`Pipeline ${name} ${on} is ${stateWord(result.state)}.`);
				}
				break;
			default:
				break;
		}
		return result;
	}

	/**
	 * The `.cloud.json` files that map a config to `pipeline`: beside the config its
	 * `rpcn-vscode/config` tag names (only inside a workspace folder) and beside the active config,
	 * each kept only when it parses and names this cluster and pipeline.
	 */
	private async mappingsOf(cluster: CloudCluster, pipeline: CloudPipeline, config: vscode.Uri | undefined): Promise<string[]> {
		const candidates = new Set<string>();
		if (config) {
			candidates.add(sidecarPath(config.fsPath));
		}
		for (const file of taggedSidecars(pipeline.tags[CONFIG_TAG], this.workspaceFolders())) {
			candidates.add(file);
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
		const choice = await this.ui.confirm(this.mask(`Delete ${name} ${on}? This cannot be undone.${mapped}`), DELETE_ACTION);
		if (choice !== DELETE_ACTION) {
			return NOT_STARTED;
		}
		let cause: unknown;
		const outcome = await this.ui.progress(`Deleting ${name} ${on}`, async (report): Promise<'deleted' | 'alreadyGone' | 'timedOut' | { failed: string; sent: boolean }> => {
			report('deleting the pipeline…');
			try {
				await deletePipeline(this.call(), dp, pipeline.id);
			} catch (err) {
				const error = asCloudError(err);
				if (error.status === 404) {
					return 'alreadyGone';
				}
				cause = err;
				return { failed: describeCloudError(error), sent: false };
			}
			this.log(`Redpanda Cloud: deleted pipeline ${name} (${pipeline.id}) ${on}.`);
			// Followed until a GET answers 404.
			const deadline = Date.now() + this.timeoutMs;
			let failures = 0;
			for (;;) {
				try {
					const still = await getPipeline(this.call(), dp, pipeline.id);
					failures = 0;
					this.upsertPipeline(cluster.id, still);
				} catch (err) {
					const error = asCloudError(err);
					if (error.status === 404) {
						return 'deleted';
					}
					this.log(`Redpanda Cloud: could not read the state of ${name}: ${error.message}`);
					if (++failures >= MAX_POLL_FAILURES) {
						return { failed: `it was deleted, but its state could not be read: ${error.message}`, sent: true };
					}
				}
				if (Date.now() >= deadline) {
					return 'timedOut';
				}
				report('waiting for it to go…');
				await sleep(this.pollMs);
			}
		});
		if (typeof outcome === 'object' && !outcome.sent) {
			this.log(`Redpanda Cloud: could not delete pipeline ${name} ${on}: ${outcome.failed}`);
			this.showErrorOfferingConnect(`Could not delete pipeline ${name} ${on}: ${outcome.failed}`, cause);
			await this.loadPipelines(cluster.id, true);
			this.fire();
			return { kind: 'failed', message: outcome.failed, pipelineId: pipeline.id };
		}
		// The DELETE was accepted (or the pipeline was gone already): its mapping goes with it.
		const removed = await this.deleteMappings(mappings, cluster, pipeline);
		const also = removed.length > 0 ? ` Deleted ${removed.map((f) => vscode.workspace.asRelativePath(f)).join(' and ')}.` : '';
		if (outcome === 'deleted' || outcome === 'alreadyGone') {
			this.removePipeline(cluster.id, pipeline.id);
			if (outcome === 'alreadyGone') {
				this.log(`Redpanda Cloud: pipeline ${name} (${pipeline.id}) was already gone from ${cluster.name}.`);
				void this.showInfo(`Pipeline ${name} was already gone from ${cluster.name}; it is removed from the view.${also}`);
			} else {
				void this.showInfo(`Deleted pipeline ${name} ${on}.${also}`);
			}
			return { kind: 'deleted', pipelineId: pipeline.id, alreadyGone: outcome === 'alreadyGone', mappings: removed };
		}
		await this.loadPipelines(cluster.id, true);
		this.fire();
		if (outcome === 'timedOut') {
			this.log(`Redpanda Cloud: pipeline ${name} ${on} is still listed ${Math.round(this.timeoutMs / 1000)} s after its delete.`);
			void this.showInfo(`Pipeline ${name} is being deleted ${on}; the Cloud view shows it until it is gone.${also}`);
			return { kind: 'timedOut', pipelineId: pipeline.id };
		}
		this.log(`Redpanda Cloud: pipeline ${name} ${on}: ${outcome.failed}`);
		void this.showError(`Pipeline ${name} ${on}: ${outcome.failed}.${also}`);
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
				this.log(`Redpanda Cloud: deleted ${file}, the mapping to the deleted pipeline ${pipeline.displayName} (${pipeline.id}).`);
			} catch (err) {
				this.log(`Redpanda Cloud: could not delete ${file}: ${reasonOf(err)}`);
				void this.showError(`Could not delete ${path.basename(file)}: ${reasonOf(err)}. It maps a config to the deleted pipeline ${pipeline.displayName}.`);
			}
		}
		return removed;
	}

	// --- the deployed config, compare, deploy again and copy ID (ticket 5.5) ---

	/** Open deployed config, Compare, Deploy again or Copy pipeline ID on a pipeline row. Never throws. */
	async rowAction(action: 'open' | 'compare' | 'deployAgain' | 'copyId', node?: CloudNode): Promise<RowActionResult> {
		try {
			if (node?.kind !== 'pipeline') {
				void this.showInfo('Choose a pipeline in the Cloud view.');
				return NOT_STARTED;
			}
			await this.ready;
			if (!this.account) {
				// Offered as Deploy does; a new connection reads the view afresh, so nothing is sent for this row.
				const choice = await this.showInfo(NOT_CONNECTED_MESSAGE, CONNECT_ACTION);
				if (choice === CONNECT_ACTION) {
					await this.connect();
				}
				return NOT_STARTED;
			}
			const cluster = this.clusterById(node.clusterId);
			const dp = cluster && this.dataplaneUrlOf(cluster);
			const pipeline = this.pipelineById(node.clusterId, node.id);
			if (!cluster || !dp || !pipeline) {
				void this.showInfo('That pipeline is no longer in the Cloud view. Refresh the view to read the pipelines again.');
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
					this.log(`Redpanda Cloud: copied the ID of pipeline ${pipeline.displayName} (${pipeline.id}) on ${cluster.name}.`);
					void this.showInfo(`Copied the ID of ${pipeline.displayName}.`);
					return { kind: 'copied', pipelineId: pipeline.id };
			}
		} catch (err) {
			const message = this.mask(reasonOf(err));
			this.log(`Redpanda Cloud: ${ROW_ACTION_TEXT[action]} failed: ${message}`);
			void this.showError(`${ROW_ACTION_TEXT[action]} failed: ${message}`);
			return { kind: 'failed', message };
		}
	}

	/** `GET` the pipeline now; a 404 is said ("gone") and the cluster's pipelines read again; other errors are shown by `readPipeline`. */
	private async readNow(target: ActionTarget): Promise<CloudPipeline | RowActionResult> {
		const { cluster, dp, pipeline } = target;
		const read = await this.readPipeline(cluster, dp, pipeline.id, pipeline.displayName);
		if (read.kind === 'ok') {
			return read.value;
		}
		if (read.status !== 404) {
			return { kind: 'failed', message: read.message, pipelineId: pipeline.id };
		}
		this.log(`Redpanda Cloud: pipeline ${pipeline.displayName} (${pipeline.id}) is gone from ${cluster.name}.`);
		void this.showInfo(`Pipeline ${pipeline.displayName} is gone from ${cluster.name}; the Cloud view reads its pipelines again.`);
		this.removePipeline(cluster.id, pipeline.id);
		await this.loadPipelines(cluster.id, true);
		this.fire();
		return { kind: 'gone', pipelineId: pipeline.id };
	}

	/** Puts `text` behind a `redpanda-cloud:` URI and waits (briefly) until an open document of it shows it. */
	private async setDeployed(uri: vscode.Uri, text: string): Promise<void> {
		this.deployedConfigs.set(uri.toString(), text);
		const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
		if (!open || open.getText() === text) {
			this.deployedChanged.fire(uri);
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
		this.deployedChanged.fire(uri);
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
		this.log(`Redpanda Cloud: opened the deployed config of pipeline ${read.displayName} (${read.id}) on ${target.cluster.name}.`);
		return { kind: 'opened', pipelineId: read.id, uri: uri.toString() };
	}

	/** The row's local file, or said why there is none (`what`: what needs it). */
	private localFileFor(pipeline: CloudPipeline, what: string): string | RowActionResult {
		const local = this.localFileOf(pipeline);
		if (local.kind === 'ok') {
			return local.path;
		}
		void this.showInfo(local.kind === 'outside'
			? `Pipeline ${pipeline.displayName} was deployed from ${local.tag}, which is ${NOT_IN_WORKSPACE}, so there is no local file to ${what}.`
			: `Pipeline ${pipeline.displayName} names no file it was deployed from, so there is no local file to ${what}.`);
		return { kind: 'notInWorkspace', pipelineId: pipeline.id };
	}

	/** Compare with the local file: the deployed config (read now, read-only) ↔ the local file (editable). */
	private async compare(target: ActionTarget): Promise<RowActionResult> {
		const file = this.localFileFor(target.pipeline, 'compare with');
		if (typeof file !== 'string') {
			return file;
		}
		const read = await this.readNow(target);
		if (!('configYaml' in read)) {
			return read;
		}
		const left = deployedConfigUri(target.cluster.id, read.id, read.displayName);
		await this.setDeployed(left, read.configYaml);
		const name = path.basename(file);
		await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(file), `${read.displayName} (deployed) ↔ ${name}`, { preview: true });
		this.log(`Redpanda Cloud: compared the deployed config of pipeline ${read.displayName} (${read.id}) on ${target.cluster.name} with ${file}.`);
		return { kind: 'opened', pipelineId: read.id, uri: left.toString() };
	}

	/** Deploy again: the normal Deploy of the row's file, only when its `.cloud.json` maps to this pipeline. */
	private async deployAgain(target: ActionTarget): Promise<RowActionResult> {
		const { cluster, pipeline } = target;
		const file = this.localFileFor(pipeline, 'deploy');
		if (typeof file !== 'string') {
			return file;
		}
		const name = path.basename(file);
		const mappingFile = sidecarPath(file);
		const mappingName = path.basename(mappingFile);
		const read = await readMapping(mappingFile);
		if (read.kind === 'ok' && read.mapping.clusterId === cluster.id && read.mapping.pipelineId === pipeline.id) {
			return this.deploy(vscode.Uri.file(file), { clusterId: cluster.id, pipelineId: pipeline.id, name: pipeline.displayName });
		}
		const why = read.kind === 'none' ? `${name} has no ${mappingName}, so a Deploy of it would not update ${pipeline.displayName}`
			: read.kind === 'bad' ? `${mappingName} is not a deploy mapping (${read.reason})`
				: `${mappingName} maps ${name} to pipeline ${read.mapping.pipelineName ?? read.mapping.pipelineId}`
					+ `${read.mapping.clusterId === cluster.id ? '' : ` on ${this.clusterById(read.mapping.clusterId)?.name ?? read.mapping.clusterName ?? read.mapping.clusterId}`}, not to ${pipeline.displayName} on ${cluster.name}`;
		this.log(`Redpanda Cloud: did not deploy ${file} again to ${pipeline.displayName} (${pipeline.id}): ${why}.`);
		void this.showInfo(`${why}. Deploy ${name} from its editor to choose where it goes. Nothing was sent.`);
		return { kind: 'notMapped', pipelineId: pipeline.id, ...(read.kind === 'ok' ? { mapping: read.mapping } : {}) };
	}
}

/** The left side of the deploy's diff and of Compare with local file (ticket 5.5). */
export function deployedConfigUri(clusterId: string, pipelineId: string, name: string): vscode.Uri {
	const safe = name.replace(/[^\w.-]+/g, '_') || pipelineId;
	return vscode.Uri.from({ scheme: DEPLOYED_SCHEME, path: `/${clusterId}/${pipelineId}/${safe}.yaml` });
}

/** Open deployed config's read-only document, titled "<name> (deployed)" (its language set to YAML). */
export function deployedViewUri(clusterId: string, pipelineId: string, name: string): vscode.Uri {
	const safe = name.replace(/[/\\]+/g, '_').trim() || pipelineId;
	return vscode.Uri.from({ scheme: DEPLOYED_SCHEME, path: `/${clusterId}/${pipelineId}/${safe} (deployed)` });
}

/** The right side of the deploy's diff: the local config as it would be sent. */
export function sentConfigUri(clusterId: string, pipelineId: string, name: string): vscode.Uri {
	const safe = name.replace(/[^\w.-]+/g, '_') || pipelineId;
	return vscode.Uri.from({ scheme: DEPLOYED_SCHEME, path: `/${clusterId}/${pipelineId}/${safe}.local.yaml` });
}

async function readMapping(file: string): Promise<{ readonly kind: 'none' } | ParsedMapping> {
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
function stateWord(state: PipelineState): string {
	if (state === 'STATE_ERROR') {
		return 'in error';
	}
	return isKnownState(state) ? pipelineStateText(state).toLowerCase() : pipelineStateText(state);
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

function stateIcon(state: string | undefined): string {
	switch (state) {
		case 'STATE_RUNNING':
			return 'pass';
		case 'STATE_STARTING':
			return 'sync~spin';
		case 'STATE_STOPPING':
			return 'loading~spin';
		case 'STATE_ERROR':
			return 'error';
		case 'STATE_STOPPED':
			return 'circle-slash';
		case 'STATE_COMPLETED':
			return 'check';
		default:
			return 'circle-large-outline';
	}
}
