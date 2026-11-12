// The deploy mapping beside a config (ticket 5.3; bug 47): `orders.yaml` → `orders.yaml.cloud.json`,
// committed with the config, naming the cluster and the pipeline a second Deploy updates. It holds ids
// (and their names, for reading) only: never a secret, a token or config text. Written only after a
// create or an update succeeded; the config itself is never changed. A mapping written before bug 47
// is `<stem>.cloud.json` (`orders.cloud.json`); it is still read when only one config beside it could
// own it (or its pipeline's tag says which), and never renamed. Also the pipeline's
// `rpcn-vscode/config` tag: made from the file's path (never a local absolute path) and resolved back
// to the workspace's files. No `vscode` import.

import * as path from 'path';

export interface DeployMapping {
	readonly clusterId: string;
	readonly pipelineId: string;
	/** For a reader of the file; the ids are what counts. */
	readonly clusterName?: string;
	readonly pipelineName?: string;
}

/** `<dir>/<file name>.cloud.json` for `<dir>/<file name>` (bug 47: each config its own mapping). */
export function sidecarPath(configPath: string): string {
	return path.join(path.dirname(configPath), `${path.basename(configPath)}.cloud.json`);
}

/** The stem of `orders.yaml` is `orders`; a name with no extension (or a dot file) is its own stem. */
function stemOf(base: string): string {
	const ext = path.extname(base);
	return ext && ext !== base ? base.slice(0, -ext.length) : base;
}

/** The mapping name before bug 47, `<dir>/<stem>.cloud.json`; `undefined` when it is the new name too. */
export function legacySidecarPath(configPath: string): string | undefined {
	const old = path.join(path.dirname(configPath), `${stemOf(path.basename(configPath))}.cloud.json`);
	return old === sidecarPath(configPath) ? undefined : old;
}

/**
 * The configs that could own the old `<stem>.cloud.json` of `configPath`: itself, the bare `<stem>`
 * (whose own mapping has that name) and `<stem>.yaml`, `<stem>.yml` beside it. Whether each is a file,
 * and whether two are one file on a case-insensitive file system, is the caller's to check.
 */
export function legacyOwnersOf(configPath: string): string[] {
	const dir = path.dirname(configPath);
	const stem = stemOf(path.basename(configPath));
	return [...new Set([configPath, path.join(dir, stem), path.join(dir, `${stem}.yaml`), path.join(dir, `${stem}.yml`)])];
}

/** A workspace folder: its name (the multi-root tag's first segment) and its path. */
export interface WorkspaceRoot {
	readonly name: string;
	readonly path: string;
}

/** Whether `file` is inside `folder` (not the folder itself). */
function isInside(folder: string, file: string): boolean {
	const rel = path.relative(folder, file);
	return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** The folder of `folders` holding `file` (the innermost when they nest), or `undefined`. */
export function folderOf(file: string, folders: readonly WorkspaceRoot[]): WorkspaceRoot | undefined {
	return folders.filter((f) => isInside(f.path, file)).sort((a, b) => b.path.length - a.path.length)[0];
}

/**
 * A folder's first tag segment(s) in a multi-root workspace: its name, or, when another open folder
 * has the same name, `<name>#<n>` (n: its place among the folders of that name, from 1), so each
 * folder's tags differ. A name may hold `/` (a custom `name` in a `.code-workspace`).
 */
export function folderLabel(folder: WorkspaceRoot, folders: readonly WorkspaceRoot[]): string {
	const same = folders.filter((f) => f.name === folder.name);
	return same.length > 1 ? `${folder.name}#${same.findIndex((f) => f.path === folder.path) + 1}` : folder.name;
}

/**
 * The `rpcn-vscode/config` tag of a config (bug 47): its path relative to its workspace folder,
 * `<folder label>/<path>` in a multi-root workspace (`folderLabel`), and its base name outside every
 * folder (no local absolute path, no user name). `/` separates the segments on every platform.
 */
export function configTag(file: string, folders: readonly WorkspaceRoot[]): string {
	const folder = folderOf(file, folders);
	if (!folder) {
		return path.basename(file);
	}
	const rel = path.relative(folder.path, file).split(path.sep).join('/');
	return folders.length > 1 ? `${folderLabel(folder, folders)}/${rel}` : rel;
}

/**
 * Whether `tag` names `file` (bug 47): for a file in a workspace folder, the tag resolves to it there
 * (`taggedConfigs`); for one outside every folder, the tag is its base name or its absolute path (what
 * a deploy before the fix sent), compared without looking in the workspace.
 */
export function tagNames(tag: string | undefined, file: string, folders: readonly WorkspaceRoot[]): boolean {
	if (!tag) {
		return false;
	}
	if (!folderOf(file, folders)) {
		return tag === path.basename(file) || (path.isAbsolute(tag) && path.resolve(tag) === path.resolve(file));
	}
	return taggedConfigs(tag, folders).some((c) => path.resolve(c) === path.resolve(file));
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

/**
 * The configs a pipeline's `rpcn-vscode/config` tag can name, only those inside one of `folders`. An
 * absolute tag (sent before bug 47): itself, when inside a folder. In a multi-root workspace, a tag
 * starting with a folder's label or name and `/` (the longest match first; `folderLabel`) names that
 * folder's file only. Otherwise (a tag written before bug 47, a one-folder workspace, or a folder
 * named differently here): the tag relative to every folder, and also, as a tag of another
 * workspace's folder, what follows its first segment (in a one-folder workspace only when that segment
 * is the folder's name). A tag climbing out with `..` gives none. Whether a file is there is the
 * caller's to check; more than one existing file is a tag the caller must not resolve alone.
 */
export function taggedConfigs(tag: string | undefined, folders: readonly WorkspaceRoot[]): string[] {
	if (!tag) {
		return [];
	}
	const out = new Set<string>();
	const add = (folder: WorkspaceRoot, rel: string) => {
		const config = path.resolve(folder.path, rel);
		if (rel && isInside(folder.path, config)) {
			out.add(config);
		}
	};
	if (path.isAbsolute(tag)) {
		folders.forEach((f) => add(f, tag));
		return [...out];
	}
	if (folders.length > 1) {
		const prefixes = folders.flatMap((f) => [...new Set([folderLabel(f, folders), f.name])]
			.filter((p) => p && tag.startsWith(`${p}/`)).map((p) => ({ folder: f, length: p.length })));
		const longest = Math.max(0, ...prefixes.map((p) => p.length));
		if (longest > 0) {
			prefixes.filter((p) => p.length === longest).forEach((p) => add(p.folder, tag.slice(longest + 1)));
			return [...out];
		}
	}
	folders.forEach((f) => add(f, tag));
	const slash = tag.indexOf('/');
	if (slash > 0) {
		const first = tag.slice(0, slash);
		const rest = tag.slice(slash + 1);
		folders.filter((f) => folders.length > 1 || f.name === first).forEach((f) => add(f, rest));
	}
	return [...out];
}
