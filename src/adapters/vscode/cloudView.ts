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
// a dirty config first (as Run does; an untitled one is refused), asks for a cluster and a name (the
// file's name without its extension), creates a new pipeline from the saved file's text unchanged
// with the tracer's resources and a tag naming the file, and follows its state in a progress
// notification until it is Running, Error, Stopped or Completed (at most 3 minutes). A config the
// cluster rejects shows each `LintHint`'s line and text. The file is never changed.
//
// Every message, log line and view item masks the client secret, the token and Authorization values.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { type CloudCall, type CloudCluster, clusterTypeText, cloudProviderText, listClusters } from '../cloud/controlPlane';
import {
	CONFIG_TAG, type CloudPipeline, createPipeline, FINAL_STATES, getPipeline, listPipelines, pipelineStateText,
} from '../cloud/dataPlane';
import { asCloudError, CloudError, describeCloudError, hintLines, maskCredentials } from '../cloud/errors';
import { defaultFetch, type FetchLike } from '../cloud/http';
import { type ServiceAccount, TokenCache } from '../cloud/token';
import type { SecretStore } from './secrets';

export const CLOUD_VIEW_ID = 'redpandaConnect.cloud';
export const CONNECT_COMMAND = 'redpandaConnect.cloud.connect';
export const DISCONNECT_COMMAND = 'redpandaConnect.cloud.disconnect';
export const DEPLOY_COMMAND = 'redpandaConnect.cloud.deploy';
export const CLOUD_REFRESH_COMMAND = 'redpandaConnect.cloud.refresh';
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
	error(message: string, ...actions: string[]): Thenable<string | undefined>;
	info(message: string, ...actions: string[]): Thenable<string | undefined>;
	progress<T>(title: string, task: (report: (message: string) => void) => Promise<T>): Thenable<T>;
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
	error: (message, ...actions) => vscode.window.showErrorMessage(message, ...actions),
	info: (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
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
}

/** How a deploy ended (the command's result, for tests). */
export type DeployResult =
	| { readonly kind: 'notStarted' }
	| { readonly kind: 'rejected'; readonly message: string; readonly hints: readonly string[] }
	| { readonly kind: 'failed'; readonly message: string; readonly pipelineId?: string }
	| { readonly kind: 'final'; readonly state: string; readonly pipelineId: string; readonly error?: string }
	| { readonly kind: 'timedOut'; readonly pipelineId: string };

type Loaded<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'error'; readonly message: string };

export interface CloudViewOptions {
	readonly store: SecretStore;
	readonly log: (line: string) => void;
	readonly endpoints?: CloudEndpoints;
	readonly ui?: CloudUi;
	readonly fetch?: FetchLike;
	/** Whether a URI is a detected Redpanda Connect config. */
	readonly isDetected: (uri: vscode.Uri) => boolean;
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
	readonly tokens: TokenCache;
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
			await Promise.allSettled([this.options.store.delete(CLIENT_ID_KEY), this.options.store.delete(CLIENT_SECRET_KEY)]);
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
			await this.options.store.delete(CLIENT_ID_KEY);
			await this.options.store.delete(CLIENT_SECRET_KEY);
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
				const state = p ? pipelineStateText(p.state) : 'Unknown';
				const reason = p?.state === 'STATE_ERROR' ? ` (${p.error ?? NO_REASON})` : '';
				const item = new vscode.TreeItem(p?.displayName ?? node.id, vscode.TreeItemCollapsibleState.None);
				item.id = `pipeline:${node.clusterId}:${node.id}`;
				item.description = `${state}${reason}`;
				item.iconPath = new vscode.ThemeIcon(stateIcon(p?.state));
				item.contextValue = `cloudPipeline state-${(p?.state ?? 'unknown').replace(/^STATE_/, '').toLowerCase()}`;
				const config = p?.tags[CONFIG_TAG];
				item.tooltip = `${p?.displayName ?? node.id} (${node.id}): ${state}${reason}${config ? `. Deployed from ${config}.` : '.'}`;
				item.accessibilityInformation = { label: `Pipeline ${p?.displayName ?? node.id}, ${state}${reason}` };
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

	/** Deploy to Redpanda Cloud: `uri` (default: the active editor's file) as a new pipeline. Never throws. */
	async deploy(uri?: vscode.Uri): Promise<DeployResult> {
		try {
			return await this.deployFile(uri);
		} catch (err) {
			const message = this.mask(reasonOf(err));
			this.log(`Redpanda Cloud: deploy failed: ${message}`);
			void this.showError(`Deploy failed: ${message}`);
			return { kind: 'failed', message };
		}
	}

	private async deployFile(uri: vscode.Uri | undefined): Promise<DeployResult> {
		const notStarted: DeployResult = { kind: 'notStarted' };
		const doc = uri
			? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) ?? (uri.scheme === 'file' ? await vscode.workspace.openTextDocument(uri) : undefined)
			: vscode.window.activeTextEditor?.document;
		if (!doc) {
			void this.showInfo('Open a Redpanda Connect config to deploy it.');
			return notStarted;
		}
		if (doc.isUntitled) {
			void this.showInfo(DEPLOY_UNTITLED_MESSAGE);
			return notStarted;
		}
		if (doc.uri.scheme !== 'file') {
			void this.showInfo(DEPLOY_NOT_ON_DISK_MESSAGE);
			return notStarted;
		}
		if (!this.options.isDetected(doc.uri)) {
			void this.showInfo(DEPLOY_NOT_DETECTED_MESSAGE);
			return notStarted;
		}
		const file = path.basename(doc.uri.fsPath);
		await this.ready;
		if (!this.account) {
			const choice = await this.showInfo(NOT_CONNECTED_MESSAGE, CONNECT_ACTION);
			if (choice !== CONNECT_ACTION || !(await this.connect())) {
				return notStarted;
			}
		}
		this.requested = true;
		await this.loadClusters(false);
		if (this.clusters?.kind !== 'ok') {
			// The failure was shown when it was read; a failure kept from before is shown again.
			if (this.clusters?.kind === 'error') {
				void this.showError(`Could not list the Redpanda Cloud clusters: ${this.clusters.message}`);
			}
			return notStarted;
		}
		const targets = this.clusters.value.filter((c) => this.dataplaneUrlOf(c));
		if (targets.length === 0) {
			const unread = this.clusters.value.filter((c) => c.detailsUnread);
			void this.showError(unread.length > 0
				? `Could not read the details of ${unread.map((c) => `${c.name} (${c.detailsUnread})`).join(', ')}, so no cluster to deploy to is known. Refresh the Cloud view to try again.`
				: 'No cluster of this organization offers the pipeline API: deploy needs a BYOC or Dedicated cluster with a Data Plane address.');
			return notStarted;
		}
		const cluster = await this.ui.pickCluster(targets, `Deploy ${file} to Redpanda Cloud`);
		if (!cluster) {
			return notStarted;
		}
		const name = (await this.ui.input({
			title: `Deploy ${file} to ${cluster.name}`,
			prompt: 'The pipeline name. A new pipeline is created every time.',
			value: path.basename(file, path.extname(file)),
			ignoreFocusOut: true,
			validateInput: (text) => (text.trim() ? undefined : 'Enter a pipeline name.'),
		}))?.trim();
		if (!name) {
			return notStarted;
		}
		// As Run: a dirty config is saved first; the saved file's text is sent unchanged.
		if (doc.isDirty && !(await doc.save())) {
			this.log(`Redpanda Cloud: ${file} could not be saved; not deployed.`);
			void this.showError(`${file} could not be saved, so it was not deployed.`);
			return notStarted;
		}
		const configYaml = await fs.promises.readFile(doc.uri.fsPath, 'utf8');
		const dp = this.dataplaneUrlOf(cluster)!;
		const tags = { [CONFIG_TAG]: vscode.workspace.asRelativePath(doc.uri, false) };
		const result = await this.ui.progress(`Deploying ${name} to ${cluster.name}`, (report) =>
			this.createAndFollow(cluster, dp, { displayName: name, configYaml, tags }, report));
		this.report(file, name, cluster, result);
		return result;
	}

	private async createAndFollow(
		cluster: CloudCluster, dp: string, create: { displayName: string; configYaml: string; tags: Record<string, string> }, report: (message: string) => void,
	): Promise<DeployResult> {
		report('creating the pipeline…');
		let current: CloudPipeline;
		try {
			current = await createPipeline(this.call(), dp, create);
		} catch (err) {
			const error = asCloudError(err);
			if (error.hints.length > 0 || error.status === 400) {
				return { kind: 'rejected', message: error.message, hints: hintLines(error.hints) };
			}
			return { kind: 'failed', message: describeCloudError(error) };
		}
		// A list never read is read in full now (it holds the new pipeline), not replaced by it alone.
		if (this.pipelines.get(cluster.id)?.kind !== 'ok') {
			await this.loadPipelines(cluster.id, true);
		}
		this.upsertPipeline(cluster.id, current);
		this.fire();
		const deadline = Date.now() + this.timeoutMs;
		let failures = 0;
		while (!FINAL_STATES.includes(current.state)) {
			if (Date.now() >= deadline) {
				return { kind: 'timedOut', pipelineId: current.id };
			}
			report(`${pipelineStateText(current.state)}…`);
			await sleep(this.pollMs);
			try {
				current = await getPipeline(this.call(), dp, current.id);
				failures = 0;
				this.upsertPipeline(cluster.id, current);
			} catch (err) {
				const error = asCloudError(err);
				this.log(`Redpanda Cloud: could not read the state of ${create.displayName}: ${error.message}`);
				if (error.status === 404 || ++failures >= MAX_POLL_FAILURES) {
					return { kind: 'failed', message: `could not read its state: ${error.message}`, pipelineId: current.id };
				}
			}
		}
		return { kind: 'final', state: current.state, pipelineId: current.id, ...(current.error ? { error: current.error } : {}) };
	}

	/** The deploy's outcome as a message and a log line. */
	private report(file: string, name: string, cluster: CloudCluster, result: DeployResult): void {
		const on = `on ${cluster.name}`;
		switch (result.kind) {
			case 'rejected': {
				const hints = result.hints.length > 0 ? `: ${result.hints.join('; ')}` : '';
				this.log(`Redpanda Cloud: ${cluster.name} rejected ${file}: ${result.message}`);
				result.hints.forEach((h) => this.log(`  ${file}: ${h}`));
				void this.showError(`${cluster.name} rejected ${file} (${result.message})${hints}. No pipeline was created.`);
				return;
			}
			case 'failed':
				this.log(`Redpanda Cloud: deploying ${file} as ${name} ${on} failed: ${result.message}`);
				void this.showError(`Deploying ${file} as ${name} ${on} failed: ${result.message}`);
				return;
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
				this.log(`Redpanda Cloud: pipeline ${name} (${result.pipelineId}) ${on} is ${state}.`);
				void this.showInfo(`Pipeline ${name} is ${state.toLowerCase()} ${on}.`);
				return;
			}
			case 'notStarted':
				return;
		}
	}
}

function stateIcon(state: string | undefined): string {
	switch (state) {
		case 'STATE_RUNNING':
			return 'pass';
		case 'STATE_STARTING':
		case 'STATE_STOPPING':
			return 'sync~spin';
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
