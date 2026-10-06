// SchemaStore: the single owner of the generated, transformed and cached config schema
// (AD-10). Consumers (the Red Hat YAML contributor in epic 2, the ComponentCatalog in
// epic 3) read `current` and listen to `onDidChange`; they never spawn or cache anything.
//
// Triggers: every `binaryState` change to `ok`, and `refresh()` (the `Refresh schema`
// command), which re-resolves the binary and regenerates even on a cache hit.
// Cache: `<globalStorageUri>/schema-<hash(path + version + TRANSFORM_VERSION)>.json`,
// reused without spawning when it parses. Windows share globalStorage and may resolve
// different binaries, so every use (cache hit or write) refreshes the file's mtime, and
// after a successful write only `schema-<16 hex>.json` files unused for more than 30 days
// are removed. Processes are spawned only through `./version` (AD-9).

import * as fs from 'fs';
import * as vscode from 'vscode';
import {
	JsonObject, parseCachedSchema, parseDocs, parseRawSchema, SCHEMA_FILE_PATTERN, schemaFileName, schemaHash,
	transformSchema,
} from '../../core/schema';
import type { BinaryState, LogLine } from './binary';
import { DEFAULT_LIST_TIMEOUT_MS, ListFormat, ProcessOutcome, runList } from './version';

export interface SchemaSnapshot {
	/** The cache file holding `json`; its name changes with binary path, version and transform version. */
	readonly uri: vscode.Uri;
	/** The transformed schema. Treat as read-only. */
	readonly json: JsonObject;
	/** The binary (`binaryState.ok.path`) and version it was generated from. */
	readonly path: string;
	readonly version: string;
}

/** What the store needs from the `binaryState` owner (`RedpandaConnect`). */
export interface SchemaBinarySource {
	readonly state: BinaryState;
	readonly onDidChange: vscode.Event<BinaryState>;
	refresh(): PromiseLike<BinaryState>;
}

export interface SchemaStoreOptions {
	readonly binary: SchemaBinarySource;
	/** `ExtensionContext.globalStorageUri`; created on the first write. */
	readonly storageUri: vscode.Uri;
	readonly log: LogLine;
	/** Per `list --format …` run. */
	readonly timeoutMs?: number;
	/** Clock in ms (tests); defaults to `Date.now`. Used for cache-file mtimes and the cleanup cutoff. */
	readonly now?: () => number;
}

/** Cache files unused (mtime not refreshed) for longer than this are removed after a successful write. */
export const STALE_CACHE_MS = 30 * 24 * 60 * 60 * 1000;

type OkState = Extract<BinaryState, { kind: 'ok' }>;

interface Target {
	readonly key: string;
	readonly path: string;
	readonly version: string;
	readonly invocation: readonly string[];
}

interface Run {
	readonly key: string;
	/** Skips the cache read (`Refresh schema`). */
	readonly force: boolean;
	promise: Promise<SchemaSnapshot | undefined>;
}

function targetOf(state: OkState): Target {
	return {
		key: schemaHash(state.path, state.version),
		path: state.path,
		version: state.version,
		invocation: state.invocation,
	};
}

export class SchemaStore implements vscode.Disposable {
	private snapshot: SchemaSnapshot | undefined;
	private inFlight: Run | undefined;
	/** > 0 while `refresh()` re-resolves the binary: state changes it causes regenerate without the cache. */
	private refreshing = 0;
	private disposed = false;
	private readonly emitter = new vscode.EventEmitter<SchemaSnapshot | undefined>();
	private readonly subscriptions: vscode.Disposable[] = [];

	/** Fires with the new `current` whenever it changes (including to `undefined`). */
	readonly onDidChange: vscode.Event<SchemaSnapshot | undefined> = this.emitter.event;

	constructor(private readonly options: SchemaStoreOptions) {
		this.subscriptions.push(
			this.emitter,
			options.binary.onDidChange(() => { void this.request(this.refreshing > 0); }),
		);
		if (options.binary.state.kind === 'ok') {
			void this.request(false);
		}
	}

	/** The current schema; `undefined` while `binaryState` is not `ok` or no schema could be produced. */
	get current(): SchemaSnapshot | undefined {
		return this.snapshot;
	}

	/** Resolves once the generation in progress (if any) has finished, with `current`. */
	async settled(): Promise<SchemaSnapshot | undefined> {
		while (this.inFlight) {
			await this.inFlight.promise;
		}
		return this.snapshot;
	}

	/**
	 * `Refresh schema`: re-resolves the binary, then regenerates even when a cache file exists.
	 * Never rejects.
	 */
	async refresh(): Promise<SchemaSnapshot | undefined> {
		if (this.disposed) {
			return this.snapshot;
		}
		this.refreshing++;
		try {
			await this.options.binary.refresh();
		} catch (err) {
			this.options.log(`Schema refresh: binary resolution failed: ${errorText(err)}`);
		} finally {
			this.refreshing--;
		}
		return this.request(true);
	}

	dispose(): void {
		this.disposed = true;
		for (const d of this.subscriptions.splice(0)) {
			d.dispose();
		}
	}

	/**
	 * Single-flight: a request for the binary a run is already producing shares that run
	 * (a forced request shares only a forced run); any other request runs after it.
	 */
	private request(force: boolean): Promise<SchemaSnapshot | undefined> {
		if (this.disposed) {
			return Promise.resolve(this.snapshot);
		}
		const state = this.options.binary.state;
		if (state.kind !== 'ok') {
			this.set(undefined);
			return Promise.resolve(undefined);
		}
		const target = targetOf(state);
		const running = this.inFlight;
		if (running && running.key === target.key && (running.force || !force)) {
			return running.promise;
		}
		const previous = running?.promise ?? Promise.resolve(undefined);
		const run: Run = { key: target.key, force, promise: Promise.resolve(undefined) };
		run.promise = previous
			.then(() => this.generate(target, force))
			.finally(() => {
				if (this.inFlight === run) {
					this.inFlight = undefined;
				}
			});
		this.inFlight = run;
		return run.promise;
	}

	private async generate(target: Target, force: boolean): Promise<SchemaSnapshot | undefined> {
		let produced: SchemaSnapshot | undefined;
		try {
			produced = await this.produce(target, force);
		} catch (err) {
			// Not expected: every step handles its own failures.
			this.options.log(`Schema generation failed for Redpanda Connect ${target.version}: ${errorText(err)}`);
		}
		if (!this.stillWanted(target)) {
			// Disposed, or the binary changed meanwhile and the change listener has handled the new state.
			return this.snapshot;
		}
		if (produced) {
			this.set(produced);
		} else if (!(this.snapshot && this.snapshot.path === target.path && this.snapshot.version === target.version)) {
			this.set(undefined);
		}
		return this.snapshot;
	}

	private clock(): number {
		return (this.options.now ?? Date.now)();
	}

	/** False once disposed or once `binaryState` no longer names `target`: no more spawns for it. */
	private stillWanted(target: Target): boolean {
		const now = this.options.binary.state;
		return !this.disposed && now.kind === 'ok' && targetOf(now).key === target.key;
	}

	private set(next: SchemaSnapshot | undefined): void {
		if (next === this.snapshot) {
			return;
		}
		this.snapshot = next;
		this.emitter.fire(next);
	}

	/** Cache read (unless forced), else `list` + transform + write + cleanup. `undefined` on failure (logged once). */
	private async produce(target: Target, force: boolean): Promise<SchemaSnapshot | undefined> {
		const { storageUri, log } = this.options;
		const fileName = schemaFileName(target.path, target.version);
		const uri = vscode.Uri.joinPath(storageUri, fileName);
		const snapshotOf = (json: JsonObject): SchemaSnapshot => ({ uri, json, path: target.path, version: target.version });

		if (!force) {
			const cached = await readCache(uri);
			if (cached.kind === 'ok') {
				await touch(uri, this.clock());
				log(`Schema: using the cached schema for Redpanda Connect ${target.version} (${uri.fsPath}).`);
				return snapshotOf(cached.json);
			}
			if (cached.kind === 'corrupt') {
				log(`Schema: the cached schema ${uri.fsPath} is unreadable; regenerating.`);
			}
		}

		const failed = (detail: string) => {
			log(`Schema generation failed for Redpanda Connect ${target.version}: ${detail}`);
			return undefined;
		};

		if (!this.stillWanted(target)) {
			return undefined;
		}
		const schemaRun = await runList(target.invocation, 'jsonschema', this.options.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS);
		if (schemaRun.kind !== 'exited' || schemaRun.exitCode !== 0) {
			return failed(describeRun('jsonschema', schemaRun));
		}
		const raw = parseRawSchema(schemaRun.stdout);
		if (!raw) {
			return failed('list --format jsonschema printed no JSON schema');
		}

		if (!this.stillWanted(target)) {
			return undefined;
		}
		const docsRun = await runList(target.invocation, 'json-full', this.options.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS);
		let docs: JsonObject | undefined;
		if (docsRun.kind !== 'exited' || docsRun.exitCode !== 0) {
			log(`Schema: docs unavailable for Redpanda Connect ${target.version} (${describeRun('json-full', docsRun)}); `
				+ 'the schema has no descriptions or defaults.');
		} else {
			docs = parseDocs(docsRun.stdout);
			if (!docs) {
				log(`Schema: docs unavailable for Redpanda Connect ${target.version} (list --format json-full printed `
					+ 'invalid JSON); the schema has no descriptions or defaults.');
			}
		}

		const json = transformSchema(raw, docs);
		if (!this.stillWanted(target)) {
			return undefined;
		}
		try {
			await vscode.workspace.fs.createDirectory(storageUri);
			await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(json), 'utf8'));
		} catch (err) {
			return failed(`could not write ${uri.fsPath}: ${errorText(err)}`);
		}
		const now = this.clock();
		await touch(uri, now);
		if (!this.stillWanted(target)) {
			return undefined;
		}
		await removeStaleCacheFiles(storageUri, fileName, now - STALE_CACHE_MS, log);
		log(`Schema: generated for Redpanda Connect ${target.version} (${uri.fsPath}).`);
		return snapshotOf(json);
	}
}

type CacheRead = { kind: 'ok'; json: JsonObject } | { kind: 'missing' } | { kind: 'corrupt' };

async function readCache(uri: vscode.Uri): Promise<CacheRead> {
	let bytes: Uint8Array;
	try {
		bytes = await vscode.workspace.fs.readFile(uri);
	} catch {
		// Not there (or not readable): generate; a write problem is then reported once by the write.
		return { kind: 'missing' };
	}
	const json = parseCachedSchema(Buffer.from(bytes).toString('utf8'));
	return json ? { kind: 'ok', json } : { kind: 'corrupt' };
}

/** Sets the file's mtime to `nowMs` (marks it as in use). Best effort: failures are ignored. */
async function touch(uri: vscode.Uri, nowMs: number): Promise<void> {
	if (uri.scheme !== 'file') {
		return;
	}
	const time = new Date(nowMs);
	try {
		await fs.promises.utimes(uri.fsPath, time, time);
	} catch {
		// A missed touch only makes the file eligible for cleanup sooner.
	}
}

/**
 * Deletes the `schema-<16 hex>.json` files in `storageUri`, other than `keep`, whose mtime is
 * before `cutoffMs`. Files another window uses recently are kept. Failures are logged, never thrown.
 */
async function removeStaleCacheFiles(storageUri: vscode.Uri, keep: string, cutoffMs: number, log: LogLine): Promise<void> {
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(storageUri);
	} catch (err) {
		log(`Schema: could not list ${storageUri.fsPath} to remove old schemas: ${errorText(err)}`);
		return;
	}
	for (const [name, type] of entries) {
		if (name === keep || type !== vscode.FileType.File || !SCHEMA_FILE_PATTERN.test(name)) {
			continue;
		}
		const file = vscode.Uri.joinPath(storageUri, name);
		try {
			if ((await vscode.workspace.fs.stat(file)).mtime >= cutoffMs) {
				continue;
			}
			await vscode.workspace.fs.delete(file);
		} catch (err) {
			log(`Schema: could not remove the old schema ${name}: ${errorText(err)}`);
		}
	}
}

function describeRun(format: ListFormat, outcome: ProcessOutcome): string {
	const command = `list --format ${format}`;
	switch (outcome.kind) {
		case 'exited': {
			const exit = outcome.exitCode === null ? 'was killed' : `exited with code ${outcome.exitCode}`;
			const stderr = outcome.stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
			return stderr ? `${command} ${exit}: ${stderr}` : `${command} ${exit}`;
		}
		case 'timeout':
			return `${command} timed out after ${outcome.timeoutMs} ms`;
		case 'notFound':
			return `${command}: the binary no longer exists`;
		case 'spawnError':
			return `${command} could not start: ${outcome.message}`;
	}
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
