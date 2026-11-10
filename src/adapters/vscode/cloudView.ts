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
// Then (ticket 8) Deploy checks the config before sending it: the local lint (its errors; with no binary
// it is skipped, with a note in the output channel) and the cluster's components list (`GET
// {dp}/v1/redpanda-connect/components`, once per deploy): every component the local file uses (by
// category, nested ones and resources included, and buffer, metrics, tracer and scanners) and every
// Bloblang function and method its mappings call that the cluster does not offer. Findings go to the
// Problems panel on the local file's lines (their own collection, source "Redpanda Cloud", cleared when
// the file changes or closes and at its next deploy) and into one error message offering **Deploy
// anyway** (the cluster's own lint still applies); Escape sends nothing. A list that cannot be read is
// said so with the same offer (the lint still counts). With no finding the deploy goes on unchanged.
//
// Ticket 6.2 (AD-24): **Set up log access…** on a cluster row asks for a Redpanda user that may read the
// cluster's `__redpanda.connect.logs` topic (the username, the password in a password box, the SASL
// mechanism), makes a test read (the topic's metadata and one fetch, at the cluster's
// `kafka_api.seed_brokers`) and only once it passes keeps the three as one JSON record in the secret
// storage (`redpandaConnect.cloud.logs.<cluster id>`); a refused sign-in is "<username> could not sign
// in to <cluster>", any other failure its message, and nothing is stored. The row then says "logs:
// <username>" and its pipeline rows offer **Show logs** inline (the menu always has it), which opens
// the Pipeline Logs tab on that pipeline (`logsPanel.ts`); a cluster without access says to set it up
// first, with the action. The password is read from the secret storage when needed and handed to the
// reader in memory; it is masked like the client secret.
//
// Ticket 6.5 (board 2): **Show pipeline logs** in the Command Palette shows the log of the pipeline the
// active config's `.cloud.json` maps to (read now; gone: said so, then the pick), else a pick of every
// pipeline on every cluster (name; cluster, state, local file; "no log access set" where its cluster has
// none, and choosing it offers Set up log access first), sorted by cluster then name. The Error
// notification of a deploy, an update and a start offers **Show logs** (the default range, its ERROR
// records highlighted), or **Set up log access…** first when the cluster has none. **Show logs around the
// error** on an Error pipeline's row opens the log around its newest ERROR record (`logsPanel.ts`).
//
// Ticket 6.6 (board 6): Show logs on a pipeline whose cluster has no log access opens the tab in its No
// log access state (and still offers Set up log access…); every source handed to the tab carries
// `setUpAccess`, 6.2's Set up log access for its cluster, which the tab's Set up log access again… and
// Use another user… run before reading the same range again.
//
// Every message, log line and view item masks the client secret, the token and Authorization values.
//
// The code is in four modules (ticket 5.9): this one (the account, Connect and Disconnect, the clusters and
// pipelines cache, the tree), `cloudDeploy.ts` (the deploy flow), `cloudActions.ts` (Start, Stop, Delete and a
// row's actions) and `cloudLogs.ts` (the log access and the log entry points). `CloudView` builds the other
// three and gives them one `CloudContext`; they import nothing of it but types, and its exports stay here.
// What they share without state (constants, texts, pure helpers) is in `cloudShared.ts`; no feature module
// imports another.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { type CloudCall, type CloudCluster, clusterTypeText, cloudProviderText, listClusters } from '../cloud/controlPlane';
import { CONFIG_TAG, type CloudPipeline, getPipeline, type PipelineState, listPipelines, type PipelineResources, type SizeChoice, sizeChoices, stateKey } from '../cloud/dataPlane';
import { asCloudError, CloudError, maskCredentials } from '../cloud/errors';
import { defaultFetch, type FetchLike } from '../cloud/http';
import { type DeployMapping, taggedConfigs } from '../cloud/sidecar';
import { type ServiceAccount, TokenCache } from '../cloud/token';
import type { LogReaderFactory, SaslMechanism } from '../logs/logReader';
import { PlatformaticReader } from '../logs/platformaticReader';
import type { LogsShowOptions, LogSource } from './logsPanel';
import type { ComponentCatalog } from '../../core/catalogue';
import type { LintResult } from '../redpandaConnect/lint';
import { CloudActions, type PaletteTarget, type PaletteTargetHow, type PipelineAction } from './cloudActions';
import { CHECK_COLLECTION, CloudDeploy, type OnlyPipeline } from './cloudDeploy';
import { CloudLogs, LOG_ACCESS_PREFIX } from './cloudLogs';
import { CONNECT_ACTION, DEPLOYED_SCHEME, NOT_IN_WORKSPACE, pipelineStateDescription, reasonOf } from './cloudShared';
import type { LocalValue } from './environmentView';
import type { SecretStore } from './secrets';

// The names that moved to the deploy flow, the pipeline actions, the log access and the shared module, exported here as before.
export {
	ADD_NOW_ACTION, CHECK_COLLECTION, CHECK_SOURCE, CREATE_NEW_ACTION, CREATE_NEW_PIPELINE_ACTION, DEPLOY_ANYWAY_ACTION, DEPLOY_AS_NEW_ACTION,
	DEPLOY_NOT_DETECTED_MESSAGE, DEPLOY_NOT_ON_DISK_MESSAGE, DEPLOY_UNTITLED_MESSAGE, ENTER_ANOTHER_ACTION, keepValueAction,
	localSourceText, REPLACE_ACTION, sentConfigUri, STOP_DEPLOY_ACTION, USE_DEFAULT_ACTION,
} from './cloudDeploy';
export { DELETE_ACTION, deployedViewUri } from './cloudActions';
export {
	CONNECT_ACTION, DEPLOYED_SCHEME, deployedConfigUri, NO_REASON, NOT_CONNECTED_MESSAGE, NOT_IN_WORKSPACE, pipelineStateDescription,
} from './cloudShared';
export {
	LOG_ACCESS_PREFIX, logAccessKey, NO_LOG_ACCESS_SET, noLogAccessMessage, SET_UP_LOG_ACCESS_ACTION, SHOW_LOGS_ACTION, signInRefusedMessage,
} from './cloudLogs';

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
/** Ticket 6.2: a cluster row's log access, a pipeline row's log. */
export const SET_UP_LOG_ACCESS_COMMAND = 'redpandaConnect.cloud.setUpLogAccess';
export const SHOW_LOGS_COMMAND = 'redpandaConnect.cloud.showLogs';
/** Ticket 6.5: an Error pipeline row's log around its newest ERROR record. */
export const SHOW_LOGS_AROUND_ERROR_COMMAND = 'redpandaConnect.cloud.showLogsAroundError';
/** Whether a service account is connected (menus and the view's empty state). */
export const CONNECTED_KEY = 'redpandaConnect.cloud.connected';
export const CLIENT_ID_KEY = 'redpandaConnect.cloud.clientId';
export const CLIENT_SECRET_KEY = 'redpandaConnect.cloud.clientSecret';

export const NO_CLUSTERS_TEXT = 'No BYOC or Dedicated cluster in this organization.';
export const NO_PIPELINE_API = 'no pipeline API';
/** A cluster whose details (`GET /v1/clusters/{id}`) could not be read: its pipeline API is unknown. */
export const DETAILS_UNREAD = 'could not read its details';
/** A stored account's row until the user asks for the clusters (nothing is requested on its own). */
export const NOT_READ_TEXT = 'Refresh to read the clusters.';

export const DEPLOYED_NOT_LOADED_TEXT = '# This read-only copy is not loaded in this window (it was restored after a reload). Close it, then use Open deployed config, Compare or Deploy in the Cloud view.\n';

/** After an update of a running pipeline: reported running when its state does not change for this long. */
export const RESTART_GRACE_MS = 20_000;

/** Poll the pipeline this often while it starts, for at most this long (the test seam shortens both). */
export const POLL_MS = 3_000;
export const DEPLOY_TIMEOUT_MS = 3 * 60_000;

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
	/** `createdSecrets` (bug 45): the secrets the deploy created before it stopped; they stay. */
	| { readonly kind: 'notStarted'; readonly createdSecrets?: readonly string[] }
	| { readonly kind: 'rejected'; readonly message: string; readonly hints: readonly string[]; readonly createdSecrets?: readonly string[] }
	| { readonly kind: 'failed'; readonly message: string; readonly pipelineId?: string; readonly createdSecrets?: readonly string[] }
	/** `errorFromBefore` (bug 45): still in Error after the grace period, so `error` may be from before the request. */
	| { readonly kind: 'final'; readonly state: string; readonly pipelineId: string; readonly error?: string; readonly errorFromBefore?: true }
	/** `state`: the last state seen. */
	| { readonly kind: 'timedOut'; readonly pipelineId: string; readonly state?: string }
	/** The mapped pipeline already runs this config at this size: no pipeline change was sent (`createdSecrets`: only those). */
	| { readonly kind: 'unchanged'; readonly pipelineId: string; readonly createdSecrets?: readonly string[] }
	/**
	 * Ticket 8: the pre-deploy check found problems (`findings`, as listed) or could not read the
	 * cluster's components (`listError`), and Deploy anyway was not chosen: nothing was sent.
	 */
	| { readonly kind: 'checkStopped'; readonly findings: readonly string[]; readonly listError?: string };


/** How a Start, Stop or Delete ended (the command's result, for tests). */
export type PipelineActionResult =
	| DeployResult
	/** The pipeline's state does not offer the action (from the palette): nothing was sent. */
	| { readonly kind: 'notOffered'; readonly state: string; readonly pipelineId: string }
	/** Deleted (`alreadyGone`: the `DELETE` answered 404); `mappings`: the `.cloud.json` files deleted with it. */
	| { readonly kind: 'deleted'; readonly pipelineId: string; readonly alreadyGone: boolean; readonly mappings: readonly string[] };


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


/** The local file a pipeline was deployed from, by its tag. */
type LocalFile =
	| { readonly kind: 'none' }
	| { readonly kind: 'outside'; readonly tag: string }
	| { readonly kind: 'ok'; readonly tag: string; readonly path: string };


type Loaded<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'error'; readonly message: string };

/**
 * What the deploy flow, the pipeline actions and the log access reach of the view (ticket 5.9): its
 * options, test seams and account, the clusters and pipelines cache, the prompts and the masked messages,
 * and the few calls one of them makes into another (the view passes them on). `CloudView` builds it.
 */
export interface CloudContext {
	readonly options: CloudViewOptions;
	readonly ui: CloudUi;
	readonly pollMs: number;
	readonly timeoutMs: number;
	readonly restartGraceMs: number;
	readonly lint: ((doc: vscode.TextDocument) => Promise<LintResult>) | undefined;
	localVersion(): string | undefined;
	localCatalogue(): ComponentCatalog | undefined;
	readonly logReader: LogReaderFactory;
	readonly nodeVersion: string;
	errorFollowUp: Promise<ShowLogsResult | undefined> | undefined;
	workspaceFolders(): readonly string[];
	readonly account: { readonly clientId: string; name?: string } | undefined;
	readonly ready: Promise<void>;
	requested: boolean;
	writing: number;
	readonly seenSecrets: Set<string>;
	/** Secret values a deploy sent, raw (bug 44): also masked when shorter than 4 in Cloud API error text. */
	readonly sentSecrets: Set<string>;
	readonly clusters: Loaded<CloudCluster[]> | undefined;
	readonly pipelines: ReadonlyMap<string, Loaded<CloudPipeline[]>>;
	readonly checkDiagnostics: vscode.DiagnosticCollection;
	readonly deployedConfigs: Map<string, string>;
	readonly deployedChanged: vscode.EventEmitter<vscode.Uri>;
	mask(text: string): string;
	log(line: string): void;
	showError(message: string, ...actions: string[]): Thenable<string | undefined>;
	showInfo(message: string, ...actions: string[]): Thenable<string | undefined>;
	showErrorOfferingConnect(message: string, err: unknown): void;
	fire(): void;
	call(): CloudCall;
	connect(): Promise<boolean>;
	removeStored(key: string): Promise<void>;
	loadClusters(force: boolean): Promise<void>;
	loadPipelines(clusterId: string, force: boolean): Promise<void>;
	upsertPipeline(clusterId: string, pipeline: CloudPipeline): void;
	removePipeline(clusterId: string, id: string): void;
	clusterById(id: string): CloudCluster | undefined;
	pipelineById(clusterId: string, id: string): CloudPipeline | undefined;
	dataplaneUrlOf(c: CloudCluster): string | undefined;
	localFileOf(p: CloudPipeline | undefined): LocalFile;
	readPipeline(cluster: CloudCluster, dp: string, id: string, shown: string)
		: Promise<{ readonly kind: 'ok'; readonly value: CloudPipeline } | { readonly kind: 'error'; readonly message: string; readonly status?: number }>;
	/** The deploy flow's (Deploy again, and the state Start and Stop follow). */
	deploy(uri?: vscode.Uri, only?: OnlyPipeline): Promise<DeployResult>;
	follow(
		cluster: CloudCluster, dp: string, first: CloudPipeline, name: string, report: (message: string) => void,
		change?: { readonly from: PipelineState; readonly waiting: string },
		onFailure?: (err: unknown) => void,
	): Promise<DeployResult>;
	/** The pipeline actions' (Show pipeline logs shares the palette's target path). */
	connectedFirst(): Promise<boolean>;
	activeConfig(): vscode.Uri | undefined;
	paletteTarget(configOf: () => vscode.Uri | undefined, how: PaletteTargetHow): Promise<PaletteTarget>;
	/** The log access's (a deploy's and a start's Error). */
	showErrorWithLogs(message: string, cluster: CloudCluster, pipelineId: string, name: string): void;
}

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
	/** Ticket 8: lint of the saved file, as lint on save runs it (none: skipped, as with no binary). */
	readonly lint?: (doc: vscode.TextDocument) => Promise<LintResult>;
	/** Ticket 8: the local binary's Connect version (the status bar's), when one is usable. */
	readonly localVersion?: () => string | undefined;
	/** Ticket 8: the local schema's catalogue, when one is loaded (else the cluster's is used). */
	readonly catalogue?: () => ComponentCatalog | undefined;
	/** Ticket 6.2: the Pipeline Logs tab, which Show logs opens on a pipeline. */
	readonly logs?: { show(source: LogSource, options?: LogsShowOptions): Promise<void> };
	/** Ticket 6.2: how a cluster's logs are read (default: `@platformatic/kafka`). */
	readonly logReader?: LogReaderFactory;
}

/** How Set up log access… ended (the command's result, for tests). */
export type LogAccessResult =
	| { readonly kind: 'notStarted' }
	/** This VS Code's Node is too old for the client: said so, nothing asked or sent. */
	| { readonly kind: 'notSupported'; readonly message: string }
	| { readonly kind: 'stored'; readonly username: string }
	/** The test read failed (`refused`: the sign-in): nothing stored. */
	| { readonly kind: 'failed'; readonly refused: boolean; readonly message: string };

/** How Show logs ended (the command's result, for tests). */
export type ShowLogsResult =
	| { readonly kind: 'notStarted' }
	| { readonly kind: 'notSupported'; readonly message: string }
	| { readonly kind: 'noAccess' }
	| { readonly kind: 'shown'; readonly pipelineId: string };


export class CloudView implements vscode.TreeDataProvider<CloudNode>, vscode.Disposable {
	/** The prompts and messages; tests replace them. */
	ui: CloudUi;
	/** The three hosts (the test seam points them at its fake). */
	endpoints: CloudEndpoints;
	/** The deploy's poll interval and timeout (the test seam shortens them). */
	pollMs = POLL_MS;
	timeoutMs = DEPLOY_TIMEOUT_MS;
	restartGraceMs = RESTART_GRACE_MS;
	/** Ticket 8: the pre-deploy lint, the local version and the local catalogue (the test seam replaces them). */
	lint: ((doc: vscode.TextDocument) => Promise<LintResult>) | undefined;
	localVersion: () => string | undefined;
	localCatalogue: () => ComponentCatalog | undefined;
	/** Ticket 8: the pre-deploy check's Problems entries. */
	private readonly checkDiagnostics: vscode.DiagnosticCollection;
	/** Ticket 6.2: how a cluster's logs are read (the test seam replaces it). */
	logReader: LogReaderFactory;
	/** Ticket 6.2: the Node version the logs check (the test seam may change it). */
	nodeVersion = process.versions.node;
	/** Ticket 6.5: what the last Error notification's action did, once chosen (the test seam awaits it). */
	errorFollowUp: Promise<ShowLogsResult | undefined> | undefined;
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
	/** Secret values a deploy sent (bug 44), raw; also in `seenSecrets`. */
	private readonly sentSecrets = new Set<string>();
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
	/** The deploy flow, the pipeline actions and the log access (ticket 5.9), built here only. */
	private readonly deployFlow: CloudDeploy;
	private readonly actions: CloudActions;
	private readonly logAccess: CloudLogs;

	readonly onDidChangeTreeData: vscode.Event<CloudNode | undefined> = this.changeEmitter.event;

	constructor(private readonly options: CloudViewOptions) {
		this.ui = options.ui ?? defaultCloudUi;
		this.endpoints = options.endpoints ?? PRODUCTION_ENDPOINTS;
		this.lint = options.lint;
		this.localVersion = options.localVersion ?? (() => undefined);
		this.localCatalogue = options.catalogue ?? (() => undefined);
		this.logReader = options.logReader ?? ((target) => new PlatformaticReader(target));
		this.checkDiagnostics = vscode.languages.createDiagnosticCollection(CHECK_COLLECTION);
		const context = this.context();
		this.deployFlow = new CloudDeploy(context);
		this.actions = new CloudActions(context);
		this.logAccess = new CloudLogs(context);
		const fetch = options.fetch ?? defaultFetch;
		this.tokens = new TokenCache({
			fetch,
			log: (line) => this.log(line),
			authUrl: () => this.endpoints.authUrl,
		});
		this.subscriptions.push(
			this.changeEmitter,
			this.deployedChanged,
			this.checkDiagnostics,
			// The check's entries are for the text it checked: they go when it changes or closes.
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (e.contentChanges.length > 0) {
					this.checkDiagnostics.delete(e.document.uri);
				}
			}),
			vscode.workspace.onDidCloseTextDocument((doc) => this.checkDiagnostics.delete(doc.uri)),
			options.store.onDidChange((e) => {
				if ((e.key === CLIENT_ID_KEY || e.key === CLIENT_SECRET_KEY) && this.writing === 0) {
					this.ready = this.readAccount();
				}
				// Another window set up a cluster's log access: its rows follow.
				if (e.key.startsWith(LOG_ACCESS_PREFIX) && this.writing === 0) {
					void this.logAccess.readLogAccess(e.key.slice(LOG_ACCESS_PREFIX.length)).then(() => this.fire());
				}
			}),
		);
		this.ready = this.readAccount();
	}

	/** The view as the other three modules reach it (ticket 5.9): the seams read now, the private state by reference. */
	private context(): CloudContext {
		const view = this;
		return {
			options: this.options,
			get ui() { return view.ui; },
			get pollMs() { return view.pollMs; },
			get timeoutMs() { return view.timeoutMs; },
			get restartGraceMs() { return view.restartGraceMs; },
			get lint() { return view.lint; },
			localVersion: () => view.localVersion(),
			localCatalogue: () => view.localCatalogue(),
			get logReader() { return view.logReader; },
			get nodeVersion() { return view.nodeVersion; },
			get errorFollowUp() { return view.errorFollowUp; },
			set errorFollowUp(value) { view.errorFollowUp = value; },
			workspaceFolders: () => view.workspaceFolders(),
			get account() { return view.account; },
			get ready() { return view.ready; },
			get requested() { return view.requested; },
			set requested(value) { view.requested = value; },
			get writing() { return view.writing; },
			set writing(value) { view.writing = value; },
			seenSecrets: this.seenSecrets,
			sentSecrets: this.sentSecrets,
			get clusters() { return view.clusters; },
			pipelines: this.pipelines,
			checkDiagnostics: this.checkDiagnostics,
			deployedConfigs: this.deployedConfigs,
			deployedChanged: this.deployedChanged,
			mask: (text) => view.mask(text),
			log: (line) => view.log(line),
			showError: (message, ...actions) => view.showError(message, ...actions),
			showInfo: (message, ...actions) => view.showInfo(message, ...actions),
			showErrorOfferingConnect: (message, err) => view.showErrorOfferingConnect(message, err),
			fire: () => view.fire(),
			call: () => view.call(),
			connect: () => view.connect(),
			removeStored: (key) => view.removeStored(key),
			loadClusters: (force) => view.loadClusters(force),
			loadPipelines: (clusterId, force) => view.loadPipelines(clusterId, force),
			upsertPipeline: (clusterId, pipeline) => view.upsertPipeline(clusterId, pipeline),
			removePipeline: (clusterId, id) => view.removePipeline(clusterId, id),
			clusterById: (id) => view.clusterById(id),
			pipelineById: (clusterId, id) => view.pipelineById(clusterId, id),
			dataplaneUrlOf: (c) => view.dataplaneUrlOf(c),
			localFileOf: (p) => view.localFileOf(p),
			readPipeline: (cluster, dp, id, shown) => view.readPipeline(cluster, dp, id, shown),
			deploy: (uri, only) => view.deployFlow.deploy(uri, only),
			follow: (cluster, dp, first, name, report, change, onFailure) => view.deployFlow.follow(cluster, dp, first, name, report, change, onFailure),
			connectedFirst: () => view.actions.connectedFirst(),
			activeConfig: () => view.actions.activeConfig(),
			paletteTarget: (configOf, how) => view.actions.paletteTarget(configOf, how),
			showErrorWithLogs: (message, cluster, pipelineId, name) => view.logAccess.showErrorWithLogs(message, cluster, pipelineId, name),
		};
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
			vscode.commands.registerCommand(SET_UP_LOG_ACCESS_COMMAND, (node?: CloudNode) => this.setUpLogAccess(node)),
			// From the palette (ticket 6.5) it gets no argument: the mapped pipeline, else a pick.
			vscode.commands.registerCommand(SHOW_LOGS_COMMAND, (node?: CloudNode) => this.showLogs(node)),
			vscode.commands.registerCommand(SHOW_LOGS_AROUND_ERROR_COMMAND, (node?: CloudNode) => this.showLogsAroundError(node)),
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
			http: { fetch: this.options.fetch ?? defaultFetch, log: (line) => this.log(line), secrets: () => this.secrets(), sentValues: () => [...this.sentSecrets] },
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
				// Ticket 6.2: which clusters have log access (the secret storage only; nothing is requested).
				await Promise.all(checked.map((c) => this.logAccess.readLogAccess(c.id)));
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
				const logs = this.logAccess.logUsers.get(node.id);
				item.description = c ? `${clusterDescription(c)}${logs ? ` · logs: ${logs.username}` : ''}` : '';
				item.iconPath = new vscode.ThemeIcon('server');
				// ` logs`: log access is set (ticket 6.2).
				item.contextValue = hasApi ? `cloudCluster${logs ? ' logs' : ''}` : c?.detailsUnread ? 'cloudCluster detailsUnread' : 'cloudCluster noPipelineApi';
				item.tooltip = c
					? `${c.name} (${c.id}): ${clusterDescription(c)}${c.detailError ? `. ${c.detailError}` : ''}${hasApi ? '' : c.detailsUnread ? '. Refresh to read them again.' : '. Pipelines cannot be deployed to it.'}`
					: node.id;
				if (c && logs) {
					item.tooltip += ` Its pipeline logs are read as ${logs.username} (${logs.mechanism}).`;
				}
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
				// ` logs` (ticket 6.2): its cluster has log access, so Show logs is inline.
				item.contextValue = `cloudPipeline state-${stateKey(p?.state)}${local.kind === 'ok' ? ' hasFile' : ''}${this.logAccess.logUsers.has(node.clusterId) ? ' logs' : ''}`;
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

	/** The deployed config of a pipeline, read-only (`redpanda-cloud:/<cluster>/<pipeline>/<name>.yaml`). */
	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.deployedConfigs.get(uri.toString()) ?? DEPLOYED_NOT_LOADED_TEXT;
	}

	// --- the deploy flow, the pipeline actions and the log access (`cloudDeploy.ts`, `cloudActions.ts`, `cloudLogs.ts`) ---

	/** Deploy to Redpanda Cloud: `uri` (default: the active editor's file), created or updated. Never throws. */
	deploy(uri?: vscode.Uri, only?: OnlyPipeline): Promise<DeployResult> {
		return this.deployFlow.deploy(uri, only);
	}

	/** Start, Stop or Delete pipeline…: `node` (a view row), else the palette's target. Never throws. */
	pipelineAction(action: PipelineAction, node?: CloudNode): Promise<PipelineActionResult> {
		return this.actions.pipelineAction(action, node);
	}

	/** Open deployed config, Compare, Deploy again or Copy pipeline ID on a pipeline row. Never throws. */
	rowAction(action: 'open' | 'compare' | 'deployAgain' | 'copyId', node?: CloudNode): Promise<RowActionResult> {
		return this.actions.rowAction(action, node);
	}

	/** Removes a cluster's stored log access (the test seam; no command removes it yet). */
	removeLogAccess(clusterId: string): Promise<void> {
		return this.logAccess.removeLogAccess(clusterId);
	}

	/** The secret storage's value of `key` (the test seam's NO_LEAK check; only in `ExtensionMode.Test`). */
	storedValue(key: string): Promise<string | undefined> {
		return this.logAccess.storedValue(key);
	}

	/** A cluster's stored log access without its password (the test seam). */
	storedLogAccess(clusterId: string): Promise<{ readonly username: string; readonly mechanism: SaslMechanism } | undefined> {
		return this.logAccess.storedLogAccess(clusterId);
	}

	/** Set up log access… on a cluster row (one at a time per cluster). Never throws. */
	setUpLogAccess(node?: CloudNode): Promise<LogAccessResult> {
		return this.logAccess.setUpLogAccess(node);
	}

	/** Show logs: a pipeline row's, or from the palette the mapped pipeline's, else a picked one's. Never throws. */
	showLogs(node?: CloudNode, options: LogsShowOptions = {}): Promise<ShowLogsResult> {
		return this.logAccess.showLogs(node, options);
	}

	/** Show logs around the error (ticket 6.5) on an Error pipeline's row. Never throws. */
	showLogsAroundError(node?: CloudNode): Promise<ShowLogsResult> {
		return this.logAccess.showLogsAroundError(node);
	}
}


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

