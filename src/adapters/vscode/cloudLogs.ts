// The log access and the log entry points of the Cloud view (tickets 6.2, 6.3, 6.5, 6.6; AD-24): Set up log
// access…, Show logs (a row, the palette), Show logs around the error, the Error notification's way to the log,
// and the source the Pipeline Logs tab reads with (see `cloudView.ts` for the behaviour). Built by `CloudView`
// only; it reaches the view's account, cache, prompts and messages through `CloudContext`.
//
// Bug 52 (epic 6 retrospective): Forget log access (a cluster row with access, or the palette with a cluster
// pick) removes the cluster's record from the secret storage and memory, and an open tab on it shows No log
// access. `clear` (Disconnect, another account) drops the accesses held in memory; the stored records stay,
// so the same account reads them again. The tab's source reads the cluster's access as held now at each
// sign-in (none: No log access). The log passwords are kept in their own set (`passwords`), masked by
// substring from 4 characters as the other secrets, and under 4 where a whole row value equals one and by
// substring in a reader's error text (`maskError`); a password the cluster refused at the set-up's test read
// is masked only in that attempt's messages. A password newly kept masks the tab's rows again.

import * as path from 'path';
import type { CloudCluster } from '../cloud/controlPlane';
import type { CloudPipeline } from '../cloud/dataPlane';
import { isLogReadError, isSaslMechanism, type LogAccess, LOGS_TOPIC, SASL_MECHANISMS, type SaslMechanism } from '../logs/logReader';
import { newerVsCodeMessage, nodeSupported } from '../logs/runtime';
import { setUpRunningText, type LogsShowOptions, type LogSource } from './logsPanel';
import type { CloudContext, CloudNode, LogAccessResult, ShowLogsResult } from './cloudView';
import { IN_SEVERAL_FOLDERS, NOT_IN_WORKSPACE, pipelineStateDescription, reasonOf } from './cloudShared';
import { maskCredentials } from '../cloud/errors';

/** Ticket 6.5: the Error notification's way to the log. */
export const SHOW_LOGS_ACTION = 'Show logs';
/** Ticket 6.5: the palette pick's note on a pipeline whose cluster has no log access. */
export const NO_LOG_ACCESS_SET = 'no log access set';
/** The secret storage key of a cluster's log access (one JSON record: username, password, mechanism). */
export const LOG_ACCESS_PREFIX = 'redpandaConnect.cloud.logs.';
export const logAccessKey = (clusterId: string): string => `${LOG_ACCESS_PREFIX}${clusterId}`;
export const SET_UP_LOG_ACCESS_ACTION = 'Set up log access…';
export function noLogAccessMessage(cluster: string): string {
	return `Set up log access for ${cluster} first.`;
}
export function signInRefusedMessage(username: string, cluster: string): string {
	return `${username} could not sign in to ${cluster}.`;
}

/** Bug 52: the cluster row's and the palette's command. */
export const FORGET_LOG_ACCESS_COMMAND = 'redpandaConnect.cloud.forgetLogAccess';
export function logAccessForgottenMessage(cluster: string): string {
	return `Removed the log access to ${cluster}.`;
}
export const NO_CLUSTER_WITH_LOG_ACCESS = 'No cluster has log access set.';

const LOGS_NOT_STARTED = { kind: 'notStarted' } as const;

/** How Forget log access ended (the command's result, for tests). */
export type ForgetLogAccessResult = { readonly kind: 'notStarted' } | { readonly kind: 'forgotten'; readonly clusterId: string };

/** Each cluster's log access, Set up log access…, Show logs and the Error notification's way to the log. */
export class CloudLogs {
	/** Ticket 6.2: each cluster's log access as stored (never its password), read with the clusters. */
	readonly logUsers = new Map<string, { readonly username: string; readonly mechanism: SaslMechanism }>();
	/** Ticket 6.6: each cluster's log access as last read or stored (in memory only), so a reader made later signs in with the newest. */
	private readonly logAccesses = new Map<string, LogAccess>();
	/** Ticket 6.6: the clusters whose Set up log access is running (a second one is ignored). */
	private readonly settingUpLogs = new Set<string>();
	/**
	 * Bug 52: every log access password held in this window (read, or stored after its test read), for
	 * masking; kept after Forget and Disconnect too, so rows shaped again later stay masked. A password the
	 * cluster refused at a test read is never added.
	 */
	private readonly kept = new Set<string>();

	constructor(private readonly ctx: CloudContext) {}

	/**
	 * Reads `clusterId`'s log access from the secret storage (its password then masked); keeps its
	 * username and mechanism for the rows. `undefined`: none, or not a valid record. Bug 52: a failed read
	 * keeps what is held (said in the output channel); `current` false once the read is done (an account
	 * change meanwhile): nothing held changes.
	 */
	async readLogAccess(clusterId: string, current: () => boolean = () => true): Promise<LogAccess | undefined> {
		let text: string | undefined;
		try {
			text = await this.ctx.options.store.get(logAccessKey(clusterId));
		} catch (err) {
			this.ctx.log(`Redpanda Cloud: could not read the secret storage: ${reasonOf(err)}`);
			return this.logAccesses.get(clusterId);
		}
		if (!current()) {
			return undefined;
		}
		const access = parseLogAccess(text);
		if (access) {
			this.keep(access.password);
			this.logUsers.set(clusterId, { username: access.username, mechanism: access.mechanism });
			this.logAccesses.set(clusterId, access);
		} else {
			const had = this.logAccesses.delete(clusterId);
			this.logUsers.delete(clusterId);
			if (had) {
				// Bug 52: removed (in another window): an open tab on the cluster stops, No log access.
				this.ctx.options.logs?.revoke?.((s) => s.clusterId === clusterId);
			}
		}
		return access;
	}

	/** Bug 52: the log access passwords held in this window (for the Cloud view's mask). */
	passwords(): readonly string[] {
		return [...this.kept];
	}

	/** A log access password held from now on; a new one masks the tab's rows again. */
	private keep(password: string): void {
		if (!this.kept.has(password)) {
			this.kept.add(password);
			this.ctx.options.logs?.remask?.();
		}
	}

	/** Bug 52: a reader's error text: the Cloud view's mask, and the log passwords under 4 characters by substring too. */
	maskError(text: string): string {
		return maskCredentials(this.ctx.mask(text), this.passwords(), 1);
	}

	/**
	 * Bug 52 (Disconnect, another service account): the accesses held in memory are dropped and not used
	 * again; the stored records stay (Forget log access removes them), so the same account reads them again.
	 */
	clear(): void {
		this.logUsers.clear();
		this.logAccesses.clear();
	}

	/**
	 * Removes a cluster's log access: its record in the secret storage and memory; an open tab on the
	 * cluster stops and shows No log access. Throws when the secret storage does (nothing else changed then).
	 */
	async removeLogAccess(clusterId: string): Promise<void> {
		this.ctx.writing++;
		try {
			await this.ctx.removeStored(logAccessKey(clusterId));
		} finally {
			this.ctx.writing--;
		}
		this.logUsers.delete(clusterId);
		this.logAccesses.delete(clusterId);
		this.ctx.fire();
		this.ctx.options.logs?.revoke?.((s) => s.clusterId === clusterId);
	}

	/**
	 * Forget log access (bug 52): on a cluster row, that cluster's; from the palette (no node), one picked
	 * from the clusters with log access (connected first). Escape: nothing changes. Never throws.
	 */
	async forgetLogAccess(node?: CloudNode): Promise<ForgetLogAccessResult> {
		try {
			let cluster: CloudCluster | undefined;
			if (node === undefined) {
				if (!(await this.ctx.connectedFirst())) {
					return LOGS_NOT_STARTED;
				}
				await this.ctx.loadClusters(false);
				const clusters = this.ctx.clusters;
				if (clusters?.kind !== 'ok') {
					if (clusters?.kind === 'error') {
						void this.ctx.showError(`Could not list the Redpanda Cloud clusters: ${clusters.message}`);
					}
					return LOGS_NOT_STARTED;
				}
				const offered = clusters.value.filter((c) => this.logUsers.has(c.id));
				if (offered.length === 0) {
					void this.ctx.showInfo(NO_CLUSTER_WITH_LOG_ACCESS);
					return LOGS_NOT_STARTED;
				}
				cluster = await this.ctx.ui.pickCluster(offered, 'Forget log access: the cluster', 'The cluster whose log access to remove');
				if (!cluster) {
					return LOGS_NOT_STARTED;
				}
			} else if (node.kind === 'cluster') {
				cluster = this.ctx.clusterById(node.id);
				if (!cluster) {
					void this.ctx.showInfo('That cluster is no longer in the Cloud view. Refresh the view to read the clusters again.');
					return LOGS_NOT_STARTED;
				}
			} else {
				void this.ctx.showInfo('Choose a cluster in the Cloud view.');
				return LOGS_NOT_STARTED;
			}
			const user = this.logUsers.get(cluster.id)?.username;
			if (!user && (await this.ctx.options.store.get(logAccessKey(cluster.id))) === undefined) {
				void this.ctx.showInfo(`${cluster.name} has no log access set.`);
				return LOGS_NOT_STARTED;
			}
			await this.removeLogAccess(cluster.id);
			this.ctx.log(`Redpanda Cloud: removed the log access to ${cluster.name}${user ? ` (${user})` : ''}.`);
			void this.ctx.showInfo(logAccessForgottenMessage(cluster.name));
			return { kind: 'forgotten', clusterId: cluster.id };
		} catch (err) {
			const message = this.ctx.mask(reasonOf(err));
			this.ctx.log(`Redpanda Cloud: Forget log access failed: ${message}`);
			void this.ctx.showError(`Could not remove the log access from the secret storage: ${message}`);
			return LOGS_NOT_STARTED;
		}
	}

	/** The secret storage's value of `key` (the test seam's NO_LEAK check; only in `ExtensionMode.Test`). */
	async storedValue(key: string): Promise<string | undefined> {
		return this.ctx.options.store.get(key);
	}

	/** Ticket 6.2: on a Node too old for the client, the message (shown and logged); else `undefined`. */
	private logsNotSupported(): { readonly kind: 'notSupported'; readonly message: string } | undefined {
		if (nodeSupported(this.ctx.nodeVersion)) {
			return undefined;
		}
		const message = `${newerVsCodeMessage(this.ctx.nodeVersion)}.`;
		this.ctx.log(`Redpanda Cloud: ${message}`);
		void this.ctx.showError(message);
		return { kind: 'notSupported', message };
	}

	/** A cluster's stored log access without its password (the test seam). */
	async storedLogAccess(clusterId: string): Promise<{ readonly username: string; readonly mechanism: SaslMechanism } | undefined> {
		const access = parseLogAccess(await this.ctx.options.store.get(logAccessKey(clusterId)));
		return access ? { username: access.username, mechanism: access.mechanism } : undefined;
	}

	/**
	 * Set up log access… on a cluster row: the username, the password (a password box) and the
	 * mechanism; a test read; stored only once it passes. Escape at any step: nothing stored or sent.
	 * Never throws. Ticket 6.6: one at a time per cluster; another request while one runs is ignored.
	 */
	async setUpLogAccess(node?: CloudNode): Promise<LogAccessResult> {
		const clusterId = node?.kind === 'cluster' ? node.id : undefined;
		if (clusterId !== undefined && this.settingUpLogs.has(clusterId)) {
			this.ctx.log('Redpanda Cloud: Set up log access is already running for that cluster; this request was ignored.');
			return LOGS_NOT_STARTED;
		}
		if (clusterId !== undefined) {
			this.settingUpLogs.add(clusterId);
		}
		try {
			return await this.setUpLogAccessNow(node);
		} finally {
			if (clusterId !== undefined) {
				this.settingUpLogs.delete(clusterId);
			}
		}
	}

	private async setUpLogAccessNow(node?: CloudNode): Promise<LogAccessResult> {
		try {
			const unsupported = this.logsNotSupported();
			if (unsupported) {
				return unsupported;
			}
			if (node?.kind !== 'cluster') {
				void this.ctx.showInfo('Choose a cluster in the Cloud view.');
				return LOGS_NOT_STARTED;
			}
			const cluster = this.ctx.clusterById(node.id);
			if (!cluster) {
				void this.ctx.showInfo('That cluster is no longer in the Cloud view. Refresh the view to read the clusters again.');
				return LOGS_NOT_STARTED;
			}
			if (!cluster.seedBrokers?.length) {
				void this.ctx.showError(`${cluster.name} gives no Kafka address, so its pipeline logs can't be read.`);
				return LOGS_NOT_STARTED;
			}
			const title = (step: number) => `Set up log access for ${cluster.name} (${step}/3)`;
			const nonEmpty = (what: string) => (text: string) => (text.trim() ? undefined : `Enter the ${what}.`);
			const username = (await this.ctx.ui.input({
				title: title(1),
				prompt: `A Redpanda user of ${cluster.name} that may read the ${LOGS_TOPIC} topic (Redpanda Cloud: the cluster's Security, Users).`,
				value: this.logUsers.get(cluster.id)?.username,
				ignoreFocusOut: true,
				validateInput: nonEmpty('username'),
			}))?.trim();
			if (!username) {
				return LOGS_NOT_STARTED;
			}
			const password = await this.ctx.ui.input({
				title: title(2),
				prompt: `The password of ${username}. It is kept in VS Code's secret storage on this machine only.`,
				password: true,
				ignoreFocusOut: true,
				validateInput: (text) => (text ? undefined : 'Enter the password.'),
			});
			if (!password) {
				return LOGS_NOT_STARTED;
			}
			// Bug 52: masked in this attempt's own messages (any length, by substring); kept for masking only
			// once the cluster did not refuse it.
			const attempt = (text: string) => maskCredentials(this.maskError(text), [password], 1);
			const mechanism = await this.ctx.ui.pickChoice(title(3), `The SASL mechanism ${username} was created with`, SASL_MECHANISMS);
			if (!isSaslMechanism(mechanism)) {
				return LOGS_NOT_STARTED;
			}
			const access: LogAccess = { username, password, mechanism };
			try {
				await this.ctx.ui.progress(`Testing log access to ${cluster.name}`, () => this.ctx.logReader({ brokers: cluster.seedBrokers!, access }).test());
			} catch (err) {
				const refused = isLogReadError(err) && err.kind === 'signIn';
				if (!refused) {
					// Not refused (the sign-in may have passed): it may be the real password, so it stays masked.
					this.keep(password);
				}
				// Only the cluster's text gets the short-password rule; the extension's words and the names stay.
				const reason = attempt(isLogReadError(err) || err instanceof Error ? err.message : String(err));
				const message = refused ? signInRefusedMessage(username, cluster.name) : `Could not read the pipeline logs of ${cluster.name}: ${reason}`;
				this.ctx.log(`Redpanda Cloud: the log access test of ${username} on ${cluster.name} failed: ${reason}; nothing was stored.`);
				void this.ctx.showError(message);
				return { kind: 'failed', refused, message: this.ctx.mask(message) };
			}
			this.keep(password);
			this.ctx.writing++;
			try {
				await this.ctx.options.store.store(logAccessKey(cluster.id), JSON.stringify(access));
			} catch (err) {
				void this.ctx.showError(`Could not store the log access in the secret storage: ${attempt(reasonOf(err))}`);
				return { kind: 'failed', refused: false, message: attempt(reasonOf(err)) };
			} finally {
				this.ctx.writing--;
			}
			this.logUsers.set(cluster.id, { username, mechanism });
			this.logAccesses.set(cluster.id, access);
			this.ctx.fire();
			this.ctx.log(`Redpanda Cloud: log access to ${cluster.name} set up for ${username} (${mechanism}).`);
			void this.ctx.showInfo(`Log access to ${cluster.name} is set up for ${username}.`);
			return { kind: 'stored', username };
		} catch (err) {
			const message = this.maskError(reasonOf(err));
			this.ctx.log(`Redpanda Cloud: Set up log access failed: ${message}`);
			void this.ctx.showError(`Set up log access failed: ${message}`);
			return LOGS_NOT_STARTED;
		}
	}

	/**
	 * Show logs: on a pipeline row, the Pipeline Logs tab on that pipeline; from the palette (no node,
	 * ticket 6.5), the pipeline the active config maps to, else one picked from every cluster's. Read with
	 * its cluster's log access (none: offered first). Never throws.
	 */
	async showLogs(node?: CloudNode, options: LogsShowOptions = {}): Promise<ShowLogsResult> {
		try {
			const unsupported = this.logsNotSupported();
			if (unsupported) {
				return unsupported;
			}
			if (node === undefined) {
				if (!this.ctx.options.logs) {
					void this.ctx.showInfo('That pipeline is no longer in the Cloud view. Refresh the view to read the pipelines again.');
					return LOGS_NOT_STARTED;
				}
				const target = await this.logsTarget();
				return target ? await this.openLogs(target.cluster, target.pipeline, options) : LOGS_NOT_STARTED;
			}
			if (node.kind !== 'pipeline') {
				void this.ctx.showInfo('Choose a pipeline in the Cloud view.');
				return LOGS_NOT_STARTED;
			}
			const cluster = this.ctx.clusterById(node.clusterId);
			const pipeline = this.ctx.pipelineById(node.clusterId, node.id);
			if (!cluster || !pipeline || !this.ctx.options.logs) {
				void this.ctx.showInfo('That pipeline is no longer in the Cloud view. Refresh the view to read the pipelines again.');
				return LOGS_NOT_STARTED;
			}
			return await this.openLogs(cluster, pipeline, options);
		} catch (err) {
			const message = this.ctx.mask(reasonOf(err));
			this.ctx.log(`Redpanda Cloud: Show logs failed: ${message}`);
			void this.ctx.showError(`Show logs failed: ${message}`);
			return LOGS_NOT_STARTED;
		}
	}

	/** Show logs around the error (ticket 6.5) on an Error pipeline's row: the log around its newest ERROR record. Never throws. */
	showLogsAroundError(node?: CloudNode): Promise<ShowLogsResult> {
		if (node?.kind !== 'pipeline') {
			void this.ctx.showInfo('Choose a pipeline in the Cloud view.');
			return Promise.resolve(LOGS_NOT_STARTED);
		}
		return this.showLogs(node, { aroundError: true });
	}

	/**
	 * The Pipeline Logs tab on `pipeline`, read with its cluster's log access (none: the tab shows its No
	 * log access state, ticket 6.6, and Set up log access… is offered, then the log).
	 */
	private async openLogs(cluster: CloudCluster, pipeline: Pick<CloudPipeline, 'id' | 'displayName' | 'updateTime'>, options: LogsShowOptions): Promise<ShowLogsResult> {
		if (!this.ctx.options.logs) {
			return LOGS_NOT_STARTED;
		}
		let access = await this.readLogAccess(cluster.id);
		if (!access) {
			this.ctx.fire();
			// Ticket 6.6: the tab shows the pipeline in its No log access state (its own Set up log access…).
			await this.ctx.options.logs.show(this.logSource(cluster, pipeline, undefined), options);
			const choice = await this.ctx.showInfo(noLogAccessMessage(cluster.name), SET_UP_LOG_ACCESS_ACTION);
			if (choice !== SET_UP_LOG_ACCESS_ACTION || (await this.setUpLogAccess({ kind: 'cluster', id: cluster.id })).kind !== 'stored') {
				return { kind: 'noAccess' };
			}
			access = await this.readLogAccess(cluster.id);
			if (!access) {
				return { kind: 'noAccess' };
			}
		}
		const brokers = cluster.seedBrokers;
		if (!brokers?.length) {
			void this.ctx.showError(`${cluster.name} gives no Kafka address, so its pipeline logs can't be read.`);
			return LOGS_NOT_STARTED;
		}
		this.ctx.log(`Redpanda Cloud: showing the logs of pipeline ${pipeline.displayName} (${pipeline.id}) on ${cluster.name}${options.aroundError ? ' around its newest ERROR record' : ''}, read as ${access.username}.`);
		await this.ctx.options.logs.show(this.logSource(cluster, pipeline, access), options);
		return { kind: 'shown', pipelineId: pipeline.id };
	}

	/**
	 * What the Pipeline Logs tab reads `pipeline` with: its cluster's Kafka address and `access` (none:
	 * the tab's No log access state, nothing read). Ticket 6.6: `setUpAccess` runs Set up log access for
	 * the cluster (the tab's Set up log access…, Set up log access again… and Use another user…) and,
	 * once stored, gives the source with the new access.
	 */
	private logSource(cluster: CloudCluster, pipeline: Pick<CloudPipeline, 'id' | 'displayName' | 'updateTime'>, access: LogAccess | undefined): LogSource {
		const brokers = cluster.seedBrokers;
		const target = access && brokers?.length ? { brokers, access } : undefined;
		// Bug 52: the access held for the cluster now, read at each sign-in (Set up log access again, from the
		// row too, or another window's); none once it was forgotten, removed elsewhere or cleared by a disconnect.
		const current = () => {
			const now = this.logAccesses.get(cluster.id);
			return target && now ? { brokers: target.brokers, access: now } : undefined;
		};
		const accesses = this.logAccesses;
		return {
			title: `${pipeline.displayName} · ${cluster.name}`,
			pipelineId: pipeline.id,
			pipelineName: pipeline.displayName,
			clusterName: cluster.name,
			clusterId: cluster.id,
			get username() {
				return target ? accesses.get(cluster.id)?.username ?? target.access.username : undefined;
			},
			noAccess: !target,
			hasAccess: () => current() !== undefined,
			reader: () => {
				const now = current();
				if (!now) {
					throw new Error(noLogAccessMessage(cluster.name));
				}
				return this.ctx.logReader(now);
			},
			mask: (text) => this.ctx.mask(text),
			maskError: (text) => this.maskError(text),
			exact: () => this.passwords(),
			...(pipeline.updateTime !== undefined ? { deployedAt: pipeline.updateTime } : {}),
			lastDeploy: () => this.lastDeployOf(cluster.id, pipeline.id),
			setUpAccess: async () => {
				// Bug 51: one already running for the cluster (from its row, or another tab's request): the tab says so.
				if (this.settingUpLogs.has(cluster.id)) {
					this.ctx.log(`Redpanda Cloud: Set up log access is already running for ${cluster.name}; the Pipeline Logs tab's request was not started.`);
					return { refused: setUpRunningText(cluster.name) };
				}
				if ((await this.setUpLogAccess({ kind: 'cluster', id: cluster.id })).kind !== 'stored') {
					return undefined;
				}
				const fresh = await this.readLogAccess(cluster.id);
				const now = this.ctx.clusterById(cluster.id) ?? cluster;
				if (!fresh || !now.seedBrokers?.length) {
					return undefined;
				}
				this.ctx.log(`Redpanda Cloud: reading the logs of pipeline ${pipeline.displayName} (${pipeline.id}) on ${now.name} as ${fresh.username}.`);
				return this.logSource(now, this.ctx.pipelineById(now.id, pipeline.id) ?? pipeline, fresh);
			},
		};
	}

	/**
	 * Show pipeline logs from the palette (ticket 6.5): connected first (Connect offered); the pipeline
	 * the active config's `.cloud.json` maps to (read now), else, or when it is gone, one picked from
	 * every cluster's pipelines (sorted by cluster, then name). `undefined`: nothing to show (said so).
	 */
	private async logsTarget(): Promise<{ readonly cluster: CloudCluster; readonly pipeline: CloudPipeline } | undefined> {
		if (!(await this.ctx.connectedFirst())) {
			return undefined;
		}
		const target = await this.ctx.paletteTarget(() => this.ctx.activeConfig(), {
			pickAfterGone: 'Choose the pipeline whose logs to show.',
			byName: true,
			nothingTo: 'show the logs of',
			title: 'Show pipeline logs: the pipeline',
			describe: (c, pipeline) => {
				const local = this.ctx.localFileOf(pipeline);
				const from = local.kind === 'ok' ? path.basename(local.path) : local.kind === 'outside' ? NOT_IN_WORKSPACE
					: local.kind === 'ambiguous' ? IN_SEVERAL_FOLDERS : undefined;
				return [c.name, pipelineStateDescription(pipeline), ...(from ? [from] : []), ...(this.logUsers.has(c.id) ? [] : [NO_LOG_ACCESS_SET])].join(' · ');
			},
		});
		return target.kind === 'target' ? { cluster: target.cluster, pipeline: target.pipeline } : undefined;
	}

	/**
	 * A deploy's, an update's or a start's Error (ticket 6.5): the message with **Show logs** (the
	 * default range, its ERROR records highlighted), or **Set up log access…** first when the cluster
	 * has none; no action where its logs cannot be read (no Kafka address, an old VS Code).
	 */
	showErrorWithLogs(message: string, cluster: CloudCluster, pipelineId: string, name: string): void {
		if (!this.ctx.options.logs || !cluster.seedBrokers?.length || !nodeSupported(this.ctx.nodeVersion)) {
			void this.ctx.showError(message);
			return;
		}
		const action = this.logUsers.has(cluster.id) ? SHOW_LOGS_ACTION : SET_UP_LOG_ACCESS_ACTION;
		this.ctx.errorFollowUp = Promise.resolve(this.ctx.showError(message, action)).then(async (choice): Promise<ShowLogsResult | undefined> => {
			if (choice !== action) {
				return undefined;
			}
			try {
				if (action === SET_UP_LOG_ACCESS_ACTION && (await this.setUpLogAccess({ kind: 'cluster', id: cluster.id })).kind !== 'stored') {
					return { kind: 'noAccess' };
				}
				const known = this.ctx.pipelineById(cluster.id, pipelineId);
				return await this.openLogs(this.ctx.clusterById(cluster.id) ?? cluster, known ?? { id: pipelineId, displayName: name }, { highlightErrors: true });
			} catch (err) {
				const reason = this.ctx.mask(reasonOf(err));
				this.ctx.log(`Redpanda Cloud: Show logs failed: ${reason}`);
				void this.ctx.showError(`Show logs failed: ${reason}`);
				return LOGS_NOT_STARTED;
			}
		});
	}

	/**
	 * Since the last deploy (ticket 6.3): the pipeline's `update_time`, read now from the Data Plane.
	 * `undefined` when it cannot be: the pipeline gone (said so), a failed read (shown by
	 * `readPipeline`), or an answer without the time (said so). Never throws.
	 */
	private async lastDeployOf(clusterId: string, pipelineId: string): Promise<number | undefined> {
		try {
			const cluster = this.ctx.clusterById(clusterId);
			const known = this.ctx.pipelineById(clusterId, pipelineId);
			const shown = known?.displayName ?? pipelineId;
			const dp = cluster ? this.ctx.dataplaneUrlOf(cluster) : undefined;
			if (!cluster || !dp) {
				void this.ctx.showInfo(`Pipeline ${shown} is no longer in the Cloud view, so its last deploy can't be read. Nothing was read.`);
				return undefined;
			}
			const read = await this.ctx.readPipeline(cluster, dp, pipelineId, shown);
			if (read.kind !== 'ok') {
				if (read.status === 404) {
					this.ctx.log(`Redpanda Cloud: pipeline ${shown} (${pipelineId}) is gone from ${cluster.name}.`);
					void this.ctx.showInfo(`Pipeline ${shown} is no longer on ${cluster.name}, so it has no last deploy. Nothing was read.`);
				}
				return undefined;
			}
			if (read.value.updateTime === undefined) {
				void this.ctx.showInfo(`Redpanda Cloud gives no deploy time for pipeline ${shown}. Nothing was read.`);
				return undefined;
			}
			this.ctx.log(`Redpanda Cloud: pipeline ${shown} was last deployed at ${new Date(read.value.updateTime).toISOString()}.`);
			return read.value.updateTime;
		} catch (err) {
			const message = this.ctx.mask(reasonOf(err));
			this.ctx.log(`Redpanda Cloud: reading the last deploy failed: ${message}`);
			void this.ctx.showError(`Could not read the last deploy: ${message}`);
			return undefined;
		}
	}
}

/** A stored log access record, or `undefined` when there is none or it is not one. */
function parseLogAccess(text: string | undefined): LogAccess | undefined {
	if (!text) {
		return undefined;
	}
	try {
		const v = JSON.parse(text) as Record<string, unknown>;
		return v && typeof v.username === 'string' && v.username && typeof v.password === 'string' && v.password && isSaslMechanism(v.mechanism)
			? { username: v.username, password: v.password, mechanism: v.mechanism } : undefined;
	} catch {
		return undefined;
	}
}
