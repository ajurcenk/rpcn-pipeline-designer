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

import { errorText } from '../../shared/errorText';
import type { CloudCluster } from '../cloud/controlPlane';
import { maskCredentials } from '../cloud/errors';
import { CLOUD_REFUSED_TEXT, DEFAULT_PROMETHEUS_USER, isMetricsReadError, testCloudMetricsAccess } from '../metrics/source';
import type { CloudContext, CloudNode } from './cloudView';

/** The secret storage key of a cluster's metrics access (one JSON record: username, password). */
export const METRICS_ACCESS_PREFIX = 'redpandaConnect.cloud.metrics.';
export const metricsAccessKey = (clusterId: string): string => `${METRICS_ACCESS_PREFIX}${clusterId}`;
export const SET_UP_METRICS_ACCESS_COMMAND = 'redpandaConnect.cloud.setUpMetricsAccess';
export const FORGET_METRICS_ACCESS_COMMAND = 'redpandaConnect.cloud.forgetMetricsAccess';
export const NO_CLUSTER_WITH_METRICS_ACCESS = 'No cluster has metrics access set.';

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

/** How Forget metrics access ended (the command's result, for tests). */
export type ForgetMetricsAccessResult = { readonly kind: 'notStarted' } | { readonly kind: 'forgotten'; readonly clusterId: string };

/** Each cluster's metrics access, Set up metrics access… and Forget metrics access. */
export class CloudMetricsAccess {
	/** Each cluster's Prometheus user as stored (never its password), read with the clusters. */
	readonly metricsUsers = new Map<string, string>();
	/** Each cluster's access as last read or stored (in memory only), for the Cloud source (entry 5). */
	private readonly accesses = new Map<string, MetricsAccess>();
	/** The clusters whose Set up metrics access is running (a second one is ignored). */
	private readonly settingUp = new Set<string>();
	/** Every metrics password held in this window, for masking; a refused one is never added. */
	private readonly kept = new Set<string>();

	constructor(private readonly ctx: CloudContext) {}

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
			this.metricsUsers.set(clusterId, access.username);
			this.accesses.set(clusterId, access);
		} else {
			this.metricsUsers.delete(clusterId);
			this.accesses.delete(clusterId);
		}
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
		this.metricsUsers.clear();
		this.accesses.clear();
	}

	/** Removes a cluster's metrics access: its record in the secret storage and memory. Throws when the secret storage does. */
	async removeAccess(clusterId: string): Promise<void> {
		this.ctx.writing++;
		try {
			await this.ctx.removeStored(metricsAccessKey(clusterId));
		} finally {
			this.ctx.writing--;
		}
		this.metricsUsers.delete(clusterId);
		this.accesses.delete(clusterId);
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
	async forgetAccess(node?: CloudNode): Promise<ForgetMetricsAccessResult> {
		try {
			let cluster: CloudCluster | undefined;
			if (node === undefined) {
				if (!(await this.ctx.connectedFirst())) {
					return NOT_STARTED;
				}
				await this.ctx.loadClusters(false);
				const clusters = this.ctx.clusters;
				if (clusters?.kind !== 'ok') {
					if (clusters?.kind === 'error') {
						void this.ctx.showError(`Could not list the Redpanda Cloud clusters: ${clusters.message}`);
					}
					return NOT_STARTED;
				}
				const offered = clusters.value.filter((c) => this.metricsUsers.has(c.id));
				if (offered.length === 0) {
					void this.ctx.showInfo(NO_CLUSTER_WITH_METRICS_ACCESS);
					return NOT_STARTED;
				}
				cluster = await this.ctx.ui.pickCluster(offered, 'Forget metrics access: the cluster', 'The cluster whose metrics access to remove');
				if (!cluster) {
					return NOT_STARTED;
				}
			} else if (node.kind === 'cluster') {
				cluster = this.ctx.clusterById(node.id);
				if (!cluster) {
					void this.ctx.showInfo('That cluster is no longer in the Cloud view. Refresh the view to read the clusters again.');
					return NOT_STARTED;
				}
			} else {
				void this.ctx.showInfo('Choose a cluster in the Cloud view.');
				return NOT_STARTED;
			}
			const user = this.metricsUsers.get(cluster.id);
			if (!user && (await this.ctx.options.store.get(metricsAccessKey(cluster.id))) === undefined) {
				void this.ctx.showInfo(`${cluster.name} has no metrics access set.`);
				return NOT_STARTED;
			}
			await this.removeAccess(cluster.id);
			this.ctx.log(`Redpanda Cloud: removed the metrics access to ${cluster.name}${user ? ` (${user})` : ''}.`);
			void this.ctx.showInfo(metricsAccessForgottenMessage(cluster.name));
			return { kind: 'forgotten', clusterId: cluster.id };
		} catch (err) {
			const message = this.maskError(errorText(err));
			this.ctx.log(`Redpanda Cloud: Forget metrics access failed: ${message}`);
			void this.ctx.showError(`Could not remove the metrics access from the secret storage: ${message}`);
			return NOT_STARTED;
		}
	}

	/**
	 * Set up metrics access… on a cluster row: the user, the password (a password box), one test read;
	 * stored only once it is accepted. Escape at any step: nothing stored or sent. Never throws. One at a
	 * time per cluster; another request while one runs is ignored.
	 */
	async setUpAccess(node?: CloudNode): Promise<MetricsAccessResult> {
		const clusterId = node?.kind === 'cluster' ? node.id : undefined;
		if (clusterId !== undefined && this.settingUp.has(clusterId)) {
			this.ctx.log('Redpanda Cloud: Set up metrics access is already running for that cluster; this request was ignored.');
			return NOT_STARTED;
		}
		if (clusterId !== undefined) {
			this.settingUp.add(clusterId);
		}
		try {
			return await this.setUpAccessNow(node);
		} finally {
			if (clusterId !== undefined) {
				this.settingUp.delete(clusterId);
			}
		}
	}

	private async setUpAccessNow(node?: CloudNode): Promise<MetricsAccessResult> {
		try {
			if (node?.kind !== 'cluster') {
				void this.ctx.showInfo('Choose a cluster in the Cloud view.');
				return NOT_STARTED;
			}
			const cluster = this.ctx.clusterById(node.id);
			if (!cluster) {
				void this.ctx.showInfo('That cluster is no longer in the Cloud view. Refresh the view to read the clusters again.');
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
			this.metricsUsers.set(cluster.id, username);
			this.accesses.set(cluster.id, access);
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
