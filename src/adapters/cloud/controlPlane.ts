// The Control Plane's clusters (AD-23, ticket 5.2): `GET {cp}/v1/clusters?page_size=100`, following
// `next_page_token`, then `GET {cp}/v1/clusters/{id}` for each BYOC and Dedicated cluster, since only
// the single-cluster answer carries the Data Plane address (`dataplane_api.url`) and the Connect
// version (`redpanda_connect.version`). Serverless clusters are a separate list and out of scope.
// Ticket 6.2 (AD-24): the cluster's Kafka address (`kafka_api.seed_brokers`) is kept for its logs.
// No `vscode` import.

import { CloudError } from './errors';
import { type HttpOptions, joinUrl, requestJson } from './http';

/** What a call needs: the HTTP options and the token (requested or cached on demand). */
export interface CloudCall {
	readonly http: HttpOptions;
	readonly token: () => Promise<string>;
	/** Drops a token an API refused, so the next `token()` requests a new one. */
	readonly invalidate?: (token: string) => void;
}

/** The message when an API refuses the service account's new token too. */
export const TOKEN_REFUSED_MESSAGE = "Redpanda Cloud refused the service account's token. Connect the service account again";

/**
 * A request with the call's token. A 401 (the token was revoked or expired early) drops the token
 * and retries once with a new one; a second 401 is an `unauthorized` error that suggests connecting
 * again.
 */
export async function authorizedJson<T>(call: CloudCall, method: string, url: string, json?: unknown): Promise<T> {
	const send = async (token: string) => requestJson<T>(call.http, method, url, { token, ...(json !== undefined ? { json } : {}) });
	const first = await call.token();
	try {
		return await send(first);
	} catch (err) {
		if (!(err instanceof CloudError) || err.status !== 401 || !call.invalidate) {
			throw err;
		}
		call.invalidate(first);
	}
	try {
		return await send(await call.token());
	} catch (err) {
		if (err instanceof CloudError && err.status === 401) {
			throw new CloudError('unauthorized', `${TOKEN_REFUSED_MESSAGE} (${err.message})`, 401, err.code);
		}
		throw err;
	}
}

export type ClusterType = 'TYPE_BYOC' | 'TYPE_DEDICATED';
const SUPPORTED_TYPES: readonly string[] = ['TYPE_BYOC', 'TYPE_DEDICATED'];

export interface CloudCluster {
	readonly id: string;
	readonly name: string;
	readonly type: ClusterType;
	readonly state: string;
	readonly cloudProvider: string;
	readonly region: string;
	/** The Data Plane address; none: the cluster offers no pipeline API. */
	readonly dataplaneUrl?: string;
	readonly connectVersion?: string;
	/** Ticket 6.2: its Kafka API's seed brokers (`host:port`), where its logs topic is read; none: unknown. */
	readonly seedBrokers?: readonly string[];
	/** Why the cluster has no usable Data Plane address although it may have one (not https). */
	readonly detailError?: string;
	/** Why the cluster's details could not be read (`GET /v1/clusters/{id}` failed): its pipeline API is unknown. */
	readonly detailsUnread?: string;
}

/** At most this many list pages are followed. */
const MAX_PAGES = 20;

type RawCluster = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const sub = (v: unknown, key: string): unknown => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined);

/** `CLOUD_PROVIDER_AWS` → `AWS`, `TYPE_DEDICATED` → `Dedicated`. */
export function cloudProviderText(provider: string): string {
	const short = provider.replace(/^CLOUD_PROVIDER_/, '');
	return short === 'GCP' || short === 'AWS' ? short : short === 'AZURE' ? 'Azure' : short || 'unknown cloud';
}

export function clusterTypeText(type: ClusterType): string {
	return type === 'TYPE_BYOC' ? 'BYOC' : 'Dedicated';
}

/** The BYOC and Dedicated clusters of the organization, each with its details. */
export async function listClusters(call: CloudCall, controlPlaneUrl: string): Promise<CloudCluster[]> {
	const listed: RawCluster[] = [];
	let pageToken = '';
	for (let page = 0; page < MAX_PAGES; page++) {
		const query = `page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
		const body = await authorizedJson<{ clusters?: unknown; next_page_token?: unknown }>(
			call, 'GET', joinUrl(controlPlaneUrl, `/v1/clusters?${query}`));
		if (Array.isArray(body.clusters)) {
			listed.push(...body.clusters.filter((c): c is RawCluster => c !== null && typeof c === 'object'));
		}
		pageToken = str(body.next_page_token);
		if (!pageToken) {
			break;
		}
	}
	const supported = listed.filter((c) => SUPPORTED_TYPES.includes(str(c.type)) && str(c.id));
	return Promise.all(supported.map(async (c): Promise<CloudCluster> => {
		const base: CloudCluster = {
			id: str(c.id),
			name: str(c.name) || str(c.id),
			type: str(c.type) as ClusterType,
			state: str(c.state),
			cloudProvider: str(c.cloud_provider),
			region: str(c.region),
		};
		try {
			const got = await authorizedJson<{ cluster?: RawCluster }>(
				call, 'GET', joinUrl(controlPlaneUrl, `/v1/clusters/${encodeURIComponent(base.id)}`));
			const detail = got.cluster ?? {};
			const dataplaneUrl = str(sub(detail.dataplane_api, 'url'));
			const connectVersion = str(sub(detail.redpanda_connect, 'version'));
			const seeds = sub(detail.kafka_api, 'seed_brokers');
			const seedBrokers = Array.isArray(seeds) ? seeds.map(str).filter(Boolean) : [];
			return {
				...base,
				name: str(detail.name) || base.name,
				state: str(detail.state) || base.state,
				cloudProvider: str(detail.cloud_provider) || base.cloudProvider,
				region: str(detail.region) || base.region,
				...(dataplaneUrl ? { dataplaneUrl } : {}),
				...(connectVersion ? { connectVersion } : {}),
				...(seedBrokers.length > 0 ? { seedBrokers } : {}),
			};
		} catch (err) {
			if (err instanceof CloudError && err.kind === 'unauthorized') {
				throw err;
			}
			return { ...base, detailsUnread: err instanceof Error ? err.message : String(err) };
		}
	}));
}
