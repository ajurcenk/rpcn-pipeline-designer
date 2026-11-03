// The deploy mapping beside a config (ticket 5.3): `orders.yaml` → `orders.cloud.json`, committed
// with the config, naming the cluster and the pipeline a second Deploy updates. It holds ids (and
// their names, for reading) only: never a secret, a token or config text. Written only after a create
// or an update succeeded; the config itself is never changed. No `vscode` import.

import * as path from 'path';

export interface DeployMapping {
	readonly clusterId: string;
	readonly pipelineId: string;
	/** For a reader of the file; the ids are what counts. */
	readonly clusterName?: string;
	readonly pipelineName?: string;
}

/** `<dir>/<stem>.cloud.json` for `<dir>/<stem>.<ext>`. */
export function sidecarPath(configPath: string): string {
	const dir = path.dirname(configPath);
	const base = path.basename(configPath);
	const ext = path.extname(base);
	const stem = ext && ext !== base ? base.slice(0, -ext.length) : base;
	return path.join(dir, `${stem}.cloud.json`);
}

export type ParsedMapping =
	| { readonly kind: 'ok'; readonly mapping: DeployMapping }
	| { readonly kind: 'bad'; readonly reason: string };

/** Strict: a JSON object whose `clusterId` and `pipelineId` are non-empty strings. */
export function parseMapping(text: string): ParsedMapping {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (err) {
		return { kind: 'bad', reason: `it is not JSON (${err instanceof Error ? err.message : String(err)})` };
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return { kind: 'bad', reason: 'it is not a JSON object' };
	}
	const v = value as Record<string, unknown>;
	const missing = ['clusterId', 'pipelineId'].filter((k) => typeof v[k] !== 'string' || !(v[k] as string).trim());
	if (missing.length > 0) {
		return { kind: 'bad', reason: `it has no ${missing.join(' or ')}` };
	}
	const name = (k: string) => (typeof v[k] === 'string' && (v[k] as string) ? { [k]: v[k] as string } : {});
	return {
		kind: 'ok',
		mapping: {
			clusterId: (v.clusterId as string).trim(),
			pipelineId: (v.pipelineId as string).trim(),
			...name('clusterName'),
			...name('pipelineName'),
		},
	};
}

/** 2-space JSON with a trailing newline, the ids first. */
export function serializeMapping(m: DeployMapping): string {
	return `${JSON.stringify({
		clusterId: m.clusterId,
		pipelineId: m.pipelineId,
		...(m.clusterName ? { clusterName: m.clusterName } : {}),
		...(m.pipelineName ? { pipelineName: m.pipelineName } : {}),
	}, null, 2)}\n`;
}
