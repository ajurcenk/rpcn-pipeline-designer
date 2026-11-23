// The metrics access of the Cloud view (ticket 7.4, AD-25): Set up metrics access… and Forget metrics
// access on a cluster row, as `cloudLogs.ts` does for the log access. Built by `CloudView` only; it reaches
// the view's account, cache, prompts and messages through `CloudContext`.
//
// A cluster's access is one record in the secret storage (`redpandaConnect.cloud.metrics.<cluster id>`:
// the Prometheus user and password), never in a setting, a file, argv, a message, a log line or a view
// item. Set up asks for the user (prefilled with the stored one, else `prometheus`) and the password,
// makes one test read of the cluster's Prometheus endpoint (`prometheus.url` of its details, never asked)
// and stores the two only once it is accepted. Escape at any step stores nothing. One set-up at a time
// per cluster. `clear` (Disconnect, another account) drops the users held in memory; the stored records
// stay, so the same account reads them again. The passwords held in this window join the Cloud view's
// mask; one the endpoint refused is masked only in that attempt's messages.
//
// Ticket 7.5 (AD-25): **Show metrics** on a pipeline row opens the Pipeline Metrics tab on that pipeline:
// its local file is found as the other row actions find it (its tag; a pick when it is in several
// folders; none: the tab shows it alone, rows by path), and the tab's feed reads the cluster's Prometheus
// endpoint (`prometheus.url` only) with the access held now (`accessOf`), following it as it is set,
// replaced or forgotten (`onDidChangeAccess`, fired only when it really changes). With no access the
// tab opens in its no-access state and an info message offers Set up metrics access…, as Show logs does.

import * as vscode from 'vscode';
import { errorText } from '../../shared/errorText';
import type { CloudCluster } from '../cloud/controlPlane';
import { maskCredentials } from '../cloud/errors';
import type { CloudPipeline } from '../cloud/dataPlane';
import { CLOUD_REFUSED_TEXT, cloudAddress, cloudMetricsSource, DEFAULT_PROMETHEUS_USER, isMetricsReadError, type MetricsSource, testCloudMetricsAccess } from '../metrics/source';
import type { CloudMetricsBinding } from './metricsFeed';
import type { CloudContext, CloudNode } from './cloudView';
import { CONNECT_ACTION, forgetAccess, rowCluster, SetUpGuard } from './cloudShared';

/** The secret storage key of a cluster's metrics access (one JSON record: username, password). */
export const METRICS_ACCESS_PREFIX = 'redpandaConnect.cloud.metrics.';
export const metricsAccessKey = (clusterId: string): string => `${METRICS_ACCESS_PREFIX}${clusterId}`;
export const SET_UP_METRICS_ACCESS_COMMAND = 'redpandaConnect.cloud.setUpMetricsAccess';
export const FORGET_METRICS_ACCESS_COMMAND = 'redpandaConnect.cloud.forgetMetricsAccess';
export const NO_CLUSTER_WITH_METRICS_ACCESS = 'No cluster has metrics access set.';
/** Ticket 7.5: a pipeline row's Show metrics. */
export const SHOW_CLOUD_METRICS_COMMAND = 'redpandaConnect.cloud.showMetrics';
export const SET_UP_METRICS_ACCESS_ACTION = 'Set up metrics access…';
/** Ticket 8: Show metrics while no service account is connected (the tab's mapped-pipeline button). */
export const NOT_CONNECTED_FOR_METRICS_MESSAGE = 'No Redpanda Cloud service account is connected. Connect one to show a pipeline\'s metrics.';

/** Ticket 7.5: Show metrics on a pipeline whose cluster has no metrics access. */
export function noMetricsAccessMessage(cluster: string): string {
	return `${cluster} has no metrics access set, so its pipelines' metrics can't be read. Set it up to read them.`;
}

export function metricsAccessSetMessage(cluster: string): string {
	return `Metrics access for ${cluster} is set.`;
}
export function metricsRefusedMessage(cluster: string): string {
	return `The Prometheus endpoint of ${cluster} ${CLOUD_REFUSED_TEXT}.`;
}
export function metricsUnreachableMessage(cluster: string, reason: string): string {
	return `Could not read the Prometheus endpoint of ${cluster}: ${reason}`;
}
export function noPrometheusEndpointMessage(cluster: string): string {
	return `${cluster} serves no Prometheus endpoint, so its pipeline metrics can't be read.`;
}
export function metricsAccessForgottenMessage(cluster: string): string {
	return `Removed the metrics access to ${cluster}.`;
}

/** A cluster's metrics access as stored. */
export interface MetricsAccess {
	readonly username: string;
	readonly password: string;
}

const NOT_STARTED = { kind: 'notStarted' } as const;

/** How Set up metrics access… ended (the command's result, for tests). */
export type MetricsAccessResult =
	| { readonly kind: 'notStarted' }
	| { readonly kind: 'stored'; readonly username: string }
	/** The test read failed (`refused`: a 401 or 403): nothing stored. */
	| { readonly kind: 'failed'; readonly refused: boolean; readonly message: string };

/** Ticket 7.5: how Show metrics ended (the command's result, for tests). */
export type ShowMetricsResult =
	| { readonly kind: 'notStarted' }
	/** The tab shows the pipeline in its no-access state (Set up metrics access… was not chosen, or failed). */
	| { readonly kind: 'noAccess'; readonly pipelineId: string; readonly file: string | undefined }
	| { readonly kind: 'shown'; readonly pipelineId: string; readonly file: string | undefined };

/** Bug 58: Show metrics' node: a pipeline row, or the Pipeline Metrics tab's request with its token. */
export type ShowMetricsNode = CloudNode & { readonly request?: number };

/** How Forget metrics access ended (the command's result, for tests). */
export type ForgetMetricsAccessResult = { readonly kind: 'notStarted' } | { readonly kind: 'forgotten'; readonly clusterId: string };

/** Each cluster's metrics access, Set up metrics access… and Forget metrics access. */
export class CloudMetricsAccess {
	/** Each cluster's Prometheus user as stored (never its password), read with the clusters. */
	readonly metricsUsers = new Map<string, string>();
	/** Each cluster's access as last read or stored (in memory only), for the Cloud source (entry 5). */
	private readonly accesses = new Map<string, MetricsAccess>();
	/** Ticket 8: a cluster's Set up metrics access started or ended (its id), for the Pipeline Metrics tab's buttons. */
	private readonly settingUpChanged = new vscode.EventEmitter<string>();
	/** The clusters whose Set up metrics access is running (a second one is ignored). */
	private readonly settingUp = new SetUpGuard('metrics access', (line) => this.ctx.log(line), (clusterId) => this.settingUpChanged.fire(clusterId));
	/** Every metrics password held in this window, for masking; a refused one is never added. */
	private readonly kept = new Set<string>();
	private readonly changed = new vscode.EventEmitter<string>();
	/** Ticket 7.5: a cluster's access held in memory was set, replaced or dropped (its id); not fired when it stays the same. */
	readonly onDidChangeAccess = this.changed.event;

	constructor(private readonly ctx: CloudContext) {}

	/**
	 * Keeps `access` for `clusterId` (none: drops it); fires the change when it differs from what was held,
	 * or always with `always` (a successful Set up: a refused tab reads again even with the same values).
	 */
	private hold(clusterId: string, access: MetricsAccess | undefined, always = false): void {
		const before = this.accesses.get(clusterId);
		if (access) {
			this.metricsUsers.set(clusterId, access.username);
			this.accesses.set(clusterId, access);
		} else {
			this.metricsUsers.delete(clusterId);
			this.accesses.delete(clusterId);
		}
		if (always || before?.username !== access?.username || before?.password !== access?.password) {
			this.changed.fire(clusterId);
		}
	}

	dispose(): void {
		this.changed.dispose();
		this.settingUpChanged.dispose();
	}

	/** Ticket 8: whether a Set up metrics access… of `clusterId` runs now (from any entry point). */
	isSettingUp(clusterId: string): boolean {
		return this.settingUp.has(clusterId);
	}

	/**
	 * Reads `clusterId`'s metrics access from the secret storage; keeps its user for the rows.
	 * `undefined`: none, or not a valid record. A failed read keeps what is held (said in the output
	 * channel); `current` false once the read is done (an account change meanwhile): nothing held changes.
	 */
	async readAccess(clusterId: string, current: () => boolean = () => true): Promise<MetricsAccess | undefined> {
		let text: string | undefined;
		try {
			text = await this.ctx.options.store.get(metricsAccessKey(clusterId));
		} catch (err) {
			this.ctx.log(`Redpanda Cloud: could not read the secret storage: ${this.maskError(errorText(err))}`);
			return this.accesses.get(clusterId);
		}
		if (!current()) {
			return undefined;
		}
		const access = parseMetricsAccess(text);
		if (access) {
			this.kept.add(access.password);
		}
		this.hold(clusterId, access);
		return access;
	}

	/** The cluster's access held now (none: not set, forgotten, or dropped by a disconnect). */
	accessOf(clusterId: string): MetricsAccess | undefined {
		return this.accesses.get(clusterId);
	}

	/** The metrics passwords held in this window (for the Cloud view's mask). */
	passwords(): readonly string[] {
		return [...this.kept];
	}

	/** An error text: the Cloud view's mask, and the metrics passwords under 4 characters by substring too (as `CloudLogs.maskError`). */
	maskError(text: string): string {
		return maskCredentials(this.ctx.mask(text), this.passwords(), 1);
	}

	/** Disconnect, another service account: the accesses held in memory are dropped; the stored records stay. */
	clear(): void {
		for (const clusterId of [...this.accesses.keys()]) {
			this.hold(clusterId, undefined);
		}
		this.metricsUsers.clear();
	}

	/** Removes a cluster's metrics access: its record in the secret storage and memory. Throws when the secret storage does. */
	async removeAccess(clusterId: string): Promise<void> {
		this.ctx.writing++;
		try {
			await this.ctx.removeStored(metricsAccessKey(clusterId));
		} finally {
			this.ctx.writing--;
		}
		this.hold(clusterId, undefined);
		this.ctx.fire();
	}

	/** A cluster's stored metrics user, without its password (the test seam). */
	async storedAccess(clusterId: string): Promise<{ readonly username: string } | undefined> {
		const access = parseMetricsAccess(await this.ctx.options.store.get(metricsAccessKey(clusterId)));
		return access ? { username: access.username } : undefined;
	}

	/**
	 * Forget metrics access: on a cluster row, that cluster's; from the palette (no node), one picked from
	 * the clusters with metrics access (connected first). Escape: nothing changes. Never throws.
	 */
	forgetAccess(node?: CloudNode): Promise<ForgetMetricsAccessResult> {
		return forgetAccess(this.ctx, node, {
			what: 'metrics access',
			userOf: (clusterId) => this.metricsUsers.get(clusterId),
			settingUp: (clusterId) => this.settingUp.has(clusterId),
			key: metricsAccessKey,
			remove: (clusterId) => this.removeAccess(clusterId),
			noneSet: NO_CLUSTER_WITH_METRICS_ACCESS,
			forgotten: metricsAccessForgottenMessage,
			mask: (text) => this.maskError(text),
		});
	}

	/**
	 * Set up metrics access… on a cluster row: the user, the password (a password box), one test read;
	 * stored only once it is accepted. Escape at any step: nothing stored or sent. Never throws. One at a
	 * time per cluster; another request while one runs is ignored.
	 */
	setUpAccess(node?: CloudNode): Promise<MetricsAccessResult> {
		return this.settingUp.guard(node, NOT_STARTED, () => this.setUpAccessNow(node));
	}

	private async setUpAccessNow(node?: CloudNode): Promise<MetricsAccessResult> {
		try {
			const cluster = rowCluster(this.ctx, node);
			if (!cluster) {
				return NOT_STARTED;
			}
			const url = this.ctx.prometheusUrlOf(cluster);
			if (!url) {
				void this.ctx.showError(noPrometheusEndpointMessage(cluster.name));
				return NOT_STARTED;
			}
			const title = (step: number) => `Set up metrics access for ${cluster.name} (${step}/2)`;
			const username = (await this.ctx.ui.input({
				title: title(1),
				prompt: `The Prometheus user of ${cluster.name} (Redpanda Cloud: the cluster's Overview, Prometheus).`,
				value: this.metricsUsers.get(cluster.id) ?? DEFAULT_PROMETHEUS_USER,
				ignoreFocusOut: true,
				validateInput: (text) => (text.trim() ? undefined : 'Enter the user.'),
			}))?.trim();
			if (!username) {
				return NOT_STARTED;
			}
			const password = await this.ctx.ui.input({
				title: title(2),
				prompt: `Prometheus password for ${cluster.name} (user ${username}). Copy it from the cluster's Overview › Prometheus in the Cloud UI. `
					+ 'It is kept in VS Code\'s secret storage and checked with one read. Escape cancels.',
				password: true,
				ignoreFocusOut: true,
				validateInput: (text) => (text ? undefined : 'Enter the password.'),
			});
			if (!password) {
				return NOT_STARTED;
			}
			// Masked in this attempt's own messages (any length, by substring); kept for masking only once
			// the endpoint did not refuse it.
			const attempt = (text: string) => maskCredentials(this.maskError(text), [password], 1);
			try {
				await this.ctx.ui.progress(`Testing metrics access to ${cluster.name}`,
					() => testCloudMetricsAccess(url, username, password, { timeoutMs: this.ctx.metricsTimeoutMs }));
			} catch (err) {
				const refused = isMetricsReadError(err) && err.kind === 'refused';
				if (!refused) {
					// Not refused (it may never have been checked): it may be the real password, so it stays masked.
					this.kept.add(password);
				}
				const reason = attempt(isMetricsReadError(err) || err instanceof Error ? err.message : String(err));
				const message = refused ? metricsRefusedMessage(cluster.name) : metricsUnreachableMessage(cluster.name, reason);
				this.ctx.log(`Redpanda Cloud: the metrics access test of ${username} on ${cluster.name} failed: ${reason}; nothing was stored.`);
				void this.ctx.showError(message);
				return { kind: 'failed', refused, message: this.ctx.mask(message) };
			}
			this.kept.add(password);
			const access: MetricsAccess = { username, password };
			this.ctx.writing++;
			try {
				await this.ctx.options.store.store(metricsAccessKey(cluster.id), JSON.stringify(access));
			} catch (err) {
				void this.ctx.showError(`Could not store the metrics access in the secret storage: ${attempt(errorText(err))}`);
				return { kind: 'failed', refused: false, message: attempt(errorText(err)) };
			} finally {
				this.ctx.writing--;
			}
			this.hold(cluster.id, access, true);
			this.ctx.fire();
			this.ctx.log(`Redpanda Cloud: metrics access to ${cluster.name} set up for ${username}.`);
			void this.ctx.showInfo(metricsAccessSetMessage(cluster.name));
			return { kind: 'stored', username };
		} catch (err) {
			const message = this.maskError(errorText(err));
			this.ctx.log(`Redpanda Cloud: Set up metrics access failed: ${message}`);
			void this.ctx.showError(`Set up metrics access failed: ${message}`);
			return NOT_STARTED;
		}
	}

	/**
	 * Ticket 7.5: Show metrics on a pipeline row: the Pipeline Metrics tab on that pipeline, with its
	 * local file (a pick when it is in several folders; none: the tab alone). No access: the tab in its
	 * no-access state, and Set up metrics access… offered. Never throws.
	 */
	async showMetrics(node?: ShowMetricsNode): Promise<ShowMetricsResult> {
		try {
			if (node?.kind !== 'pipeline') {
				void this.ctx.showInfo('Choose a pipeline in the Cloud view.');
				return NOT_STARTED;
			}
			await this.ctx.ready;
			if (!this.ctx.account) {
				// Ticket 8: from the Pipeline Metrics tab (a file's mapped pipeline) while not signed in.
				const choice = await this.ctx.showInfo(NOT_CONNECTED_FOR_METRICS_MESSAGE, CONNECT_ACTION);
				if (choice === CONNECT_ACTION) {
					await this.ctx.connect();
				}
				return NOT_STARTED;
			}
			// Bug 58: from the Pipeline Metrics tab, the cluster list may not be loaded yet (the account row never
			// expanded); as the palette target, it is read here. A first read that fails has shown its error.
			if (this.ctx.clusters?.kind !== 'ok') {
				const failedBefore = this.ctx.clusters?.kind === 'error';
				this.ctx.requested = true;
				await this.ctx.loadClusters(false);
				// Read again: the load changed it (TypeScript keeps the narrowing across the await).
				const after = (this.ctx as CloudContext).clusters;
				if (!failedBefore && after?.kind === 'error') {
					return NOT_STARTED;
				}
			}
			const cluster = this.ctx.clusterById(node.clusterId);
			// Ticket 8: from the Pipeline Metrics tab (a file's mapped pipeline), its cluster may not be expanded yet.
			if (cluster && !this.ctx.pipelineById(node.clusterId, node.id) && this.ctx.pipelines.get(node.clusterId)?.kind !== 'ok') {
				await this.ctx.loadPipelines(node.clusterId, false);
			}
			const pipeline = this.ctx.pipelineById(node.clusterId, node.id);
			const metrics = this.ctx.options.metrics;
			if (!cluster || !pipeline || !metrics || !this.ctx.account) {
				void this.ctx.showInfo('That pipeline is no longer in the Cloud view. Refresh the view to read the pipelines again.');
				return NOT_STARTED;
			}
			const url = this.ctx.prometheusUrlOf(cluster);
			if (!url) {
				void this.ctx.showError(noPrometheusEndpointMessage(cluster.name));
				return NOT_STARTED;
			}
			const file = await this.ctx.metricsFileOf(pipeline);
			if (file === null) {
				return NOT_STARTED;
			}
			// The access as stored now (another window may have set or forgotten it).
			const access = await this.readAccess(cluster.id);
			const binding = this.binding(cluster, pipeline, url, file === undefined ? undefined : vscode.Uri.file(file), node.request);
			this.ctx.log(`Redpanda Cloud: showing the metrics of pipeline ${pipeline.displayName} (${pipeline.id}) on ${cluster.name}`
				+ `${file ? `, mapped to ${file}` : ''}${access ? `, read as ${access.username}` : ', which has no metrics access set'}.`);
			await metrics.showCloud(binding);
			if (access) {
				return { kind: 'shown', pipelineId: pipeline.id, file };
			}
			const choice = await this.ctx.showInfo(noMetricsAccessMessage(cluster.name), SET_UP_METRICS_ACCESS_ACTION);
			if (choice !== SET_UP_METRICS_ACCESS_ACTION || (await this.setUpAccess({ kind: 'cluster', id: cluster.id })).kind !== 'stored') {
				return { kind: 'noAccess', pipelineId: pipeline.id, file };
			}
			// Stored: the tab's feed follows the access change and starts reading.
			return { kind: 'shown', pipelineId: pipeline.id, file };
		} catch (err) {
			const message = this.maskError(errorText(err));
			this.ctx.log(`Redpanda Cloud: Show metrics failed: ${message}`);
			void this.ctx.showError(`Show metrics failed: ${message}`);
			return NOT_STARTED;
		}
	}

	/** What the tab's feed reads the pipeline with: the endpoint and the cluster's access held now (none: no access). */
	private binding(cluster: CloudCluster, pipeline: CloudPipeline, url: string, file: vscode.Uri | undefined, request: number | undefined): CloudMetricsBinding {
		let cached: { readonly access: MetricsAccess; readonly source: MetricsSource } | undefined;
		const host = cloudAddress(url);
		return {
			clusterId: cluster.id,
			clusterName: cluster.name,
			pipelineId: pipeline.id,
			pipelineName: pipeline.displayName,
			host,
			file,
			// Bug 58: only a number (the node comes from a command's argument).
			...(typeof request === 'number' ? { request } : {}),
			source: () => {
				const access = this.accesses.get(cluster.id);
				if (!access) {
					cached = undefined;
					return undefined;
				}
				if (cached?.access !== access) {
					cached = {
						access,
						source: cloudMetricsSource(url, access.username, access.password, pipeline.id, { timeoutMs: this.ctx.metricsTimeoutMs }),
					};
				}
				return cached.source;
			},
			onDidChangeAccess: (listener, thisArgs, disposables) => this.changed.event((clusterId) => {
				if (clusterId === cluster.id) {
					listener.call(thisArgs, undefined);
				}
			}, undefined, disposables),
			mask: (text) => this.maskError(text),
			settingUp: () => this.settingUp.has(cluster.id),
			onDidChangeSettingUp: (listener, thisArgs, disposables) => this.settingUpChanged.event((clusterId) => {
				if (clusterId === cluster.id) {
					listener.call(thisArgs, undefined);
				}
			}, undefined, disposables),
		};
	}
}

/** A stored metrics access record, or `undefined` when there is none or it is not one. */
function parseMetricsAccess(text: string | undefined): MetricsAccess | undefined {
	if (!text) {
		return undefined;
	}
	try {
		const v = JSON.parse(text) as Record<string, unknown>;
		return v && typeof v.username === 'string' && v.username && typeof v.password === 'string' && v.password
			? { username: v.username, password: v.password } : undefined;
	} catch {
		return undefined;
	}
}
