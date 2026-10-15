// The saved samples' storage (ticket 4.9, AD-22): each config's samples file beside it, read and
// written through `vscode.workspace.fs` (the model is `src/core/samples.ts`). The host is the only
// writer: each change reads the file, applies the change and writes it, or deletes it once it has no
// entry left; a file that can't be read is never overwritten. Reads and writes of one config run one
// at a time, in the order they were asked for. While a config has an open panel (`watch`), a watcher
// on its samples file and the saves of VS Code reload it; `onDidChange` fires for the config when the
// file's bytes differ from the last ones the store read or wrote, so its own writes are not outside
// edits. Untitled configs have no samples file. Ticket 4.16: `relink` moves an unlabelled entry to a
// new label, and `onDidWrite` fires after each of the store's own writes (the CodeLens's count).
// Ticket 4.10: `relink` moves an entry between any two links (label or path), and `relinkAll` applies
// a save's moves of all of a config's panels in one write.

import * as path from 'path';
import * as vscode from 'vscode';
import {
	applySampleChange, parseSamplesFile, relinkAll, relinkSamples, samplesFileName, serializeSamplesFile, type RelinkMove, type SampleChange,
	type SampleRef, type SamplesFile,
} from '../../core/samples';

/** A config's samples file as read: its value (`undefined`: no file), or why it can't be read. */
export type SamplesState =
	| { readonly kind: 'ok'; readonly file: SamplesFile | undefined }
	| { readonly kind: 'unreadable'; readonly reason: string };

/**
 * What an update did: wrote (or deleted) the file, changed nothing, found it unreadable, or failed to
 * write (or delete) it, and why.
 */
export type SamplesUpdate = 'written' | 'unchanged' | 'unreadable' | { readonly failed: string };

/**
 * What a save's relink did (4.10): which moves applied, whether the file was written, and why
 * nothing applied when the file can't be read or written.
 */
export interface RelinkAllOutcome {
	readonly applied: readonly boolean[];
	/** Per move: whether its samples link had an entry to move. */
	readonly hadEntry: readonly boolean[];
	readonly written?: true;
	readonly error?: string;
}

/**
 * What a relink did (4.16, 4.10): wrote the file, found no entry to relink, found the target link already used,
 * failed to write (and why), or found the file unreadable (and why).
 */
export type RelinkOutcome = 'written' | 'unchanged' | 'taken' | { readonly failed: string } | { readonly unreadable: string };

/** The samples file of `config`; `undefined` for an untitled config. */
export function samplesUri(config: vscode.Uri): vscode.Uri | undefined {
	if (config.scheme === 'untitled') {
		return undefined;
	}
	return config.with({ path: path.posix.join(path.posix.dirname(config.path), samplesFileName(path.posix.basename(config.path))) });
}

/** The file's text, or `null` when there is no file. Throws on any other failure. */
async function readText(uri: vscode.Uri): Promise<string | null> {
	try {
		return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
	} catch (e) {
		if (e instanceof vscode.FileSystemError && e.code === 'FileNotFound') {
			return null;
		}
		throw e;
	}
}

interface Watched {
	count: number;
	readonly watcher: vscode.FileSystemWatcher;
	readonly subscriptions: vscode.Disposable[];
}

export class SampleStore implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<vscode.Uri>();
	/** Fires with the config whose samples file changed outside the store. */
	readonly onDidChange = this.changed.event;
	private readonly wrote = new vscode.EventEmitter<vscode.Uri>();
	/** Fires with the config whose samples file the store wrote or deleted (4.16). */
	readonly onDidWrite = this.wrote.event;
	/** Per samples file: the text last read or written (`null`: no file). */
	private readonly seen = new Map<string, string | null>();
	/** Per samples file: the tail of its queue of reads and writes. */
	private readonly queues = new Map<string, Promise<unknown>>();
	/** Per config: its watcher and how many panels hold it. */
	private readonly watched = new Map<string, Watched>();
	private readonly saves: vscode.Disposable;

	constructor(private readonly log: (line: string) => void) {
		// A save in VS Code (also seen by the watcher, but not always outside a workspace folder).
		this.saves = vscode.workspace.onDidSaveTextDocument((doc) => {
			for (const key of this.watched.keys()) {
				const config = vscode.Uri.parse(key);
				if (samplesUri(config)?.toString() === doc.uri.toString()) {
					void this.reload(config);
				}
			}
		});
	}

	/** Reads `config`'s samples. Never throws: a failure is an unreadable file. */
	read(config: vscode.Uri): Promise<SamplesState> {
		const uri = samplesUri(config);
		if (!uri) {
			return Promise.resolve({ kind: 'ok', file: undefined });
		}
		return this.queued(uri, () => this.load(config, uri));
	}

	/**
	 * Applies `change` to `ref`'s samples of `config` and writes the file. The change is queued
	 * at once, so updates asked for in turn are applied in turn. Never throws: a failed write is
	 * logged and is `{failed}`.
	 */
	update(config: vscode.Uri, ref: SampleRef, change: SampleChange): Promise<SamplesUpdate> {
		const uri = samplesUri(config);
		if (!uri) {
			return Promise.resolve('unchanged');
		}
		return this.queued(uri, async (): Promise<SamplesUpdate> => {
			const state = await this.load(config, uri);
			if (state.kind === 'unreadable') {
				return 'unreadable';
			}
			const next = applySampleChange(state.file, ref, change);
			return next ? this.write(config, uri, next.file) : 'unchanged';
		});
	}

	/**
	 * Relinks the entry of `from` in `config`'s samples to `to` (4.16, 4.10), keeping its samples and
	 * `selected`. `'unchanged'`: `from` has no entry (no file is created); `'taken'`: `to` already has
	 * an entry (nothing is merged). Never throws, as `update`.
	 */
	relink(config: vscode.Uri, from: SampleRef, to: SampleRef): Promise<RelinkOutcome> {
		const uri = samplesUri(config);
		if (!uri) {
			return Promise.resolve('unchanged');
		}
		return this.queued(uri, async (): Promise<RelinkOutcome> => {
			const state = await this.load(config, uri);
			if (state.kind === 'unreadable') {
				return { unreadable: state.reason };
			}
			const next = relinkSamples(state.file, from, to);
			return next === 'none' ? 'unchanged' : next === 'taken' ? 'taken' : this.write(config, uri, next.file);
		});
	}

	/**
	 * A save's relink of `config`'s panels (4.10, `relinkAll`): the moves that apply, and the file
	 * written once when an entry moved. Never throws, as `update`: an unreadable file or a failed
	 * write applies no move and says why.
	 */
	relinkAll(config: vscode.Uri, moves: readonly RelinkMove[], held: readonly SampleRef[]): Promise<RelinkAllOutcome> {
		const uri = samplesUri(config);
		if (!uri) {
			return Promise.resolve({ applied: moves.map(() => false), hadEntry: moves.map(() => false) });
		}
		return this.queued(uri, async (): Promise<RelinkAllOutcome> => {
			const none = moves.map(() => false);
			const state = await this.load(config, uri);
			if (state.kind === 'unreadable') {
				return { applied: none, hadEntry: none, error: state.reason };
			}
			const plan = relinkAll(state.file, moves, held);
			if (!plan.file) {
				return { applied: plan.applied, hadEntry: plan.hadEntry };
			}
			const written = await this.write(config, uri, plan.file);
			return written === 'written'
				? { applied: plan.applied, hadEntry: plan.hadEntry, written: true }
				: { applied: none, hadEntry: plan.hadEntry, error: written.failed };
		});
	}

	/** Writes `file` (`undefined`: deletes the file); `onDidWrite` fires once it is written. */
	private async write(config: vscode.Uri, uri: vscode.Uri, file: SamplesFile | undefined): Promise<'written' | { readonly failed: string }> {
		try {
			if (file) {
				const text = serializeSamplesFile(file);
				await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
				this.seen.set(uri.toString(), text);
			} else {
				await vscode.workspace.fs.delete(uri, { useTrash: false });
				this.seen.set(uri.toString(), null);
			}
			this.wrote.fire(config);
			return 'written';
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			this.log(`Samples: ${path.posix.basename(uri.path)}: ${reason}`);
			// What is on disk now is unknown: the next read says.
			this.seen.delete(uri.toString());
			return { failed: reason };
		}
	}

	/** Watches `config`'s samples file until the returned disposable (one per panel) is disposed. */
	watch(config: vscode.Uri): vscode.Disposable {
		const uri = samplesUri(config);
		if (!uri) {
			return new vscode.Disposable(() => undefined);
		}
		const key = config.toString();
		let entry = this.watched.get(key);
		if (!entry) {
			const dir = uri.with({ path: path.posix.dirname(uri.path) });
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, path.posix.basename(uri.path)));
			const reload = () => void this.reload(config);
			entry = { count: 0, watcher, subscriptions: [watcher.onDidCreate(reload), watcher.onDidChange(reload), watcher.onDidDelete(reload)] };
			this.watched.set(key, entry);
		}
		entry.count++;
		const held = entry;
		let released = false;
		return new vscode.Disposable(() => {
			if (released) {
				return;
			}
			released = true;
			if (--held.count === 0 && this.watched.get(key) === held) {
				this.watched.delete(key);
				this.seen.delete(uri.toString());
				held.watcher.dispose();
				held.subscriptions.forEach((s) => s.dispose());
			}
		});
	}

	/** Reads `config`'s file again: `onDidChange` fires when it changed. */
	private async reload(config: vscode.Uri): Promise<void> {
		await this.read(config);
	}

	/** Reads and parses the file; fires `onDidChange` when its text differs from the last one seen. */
	private async load(config: vscode.Uri, uri: vscode.Uri): Promise<SamplesState> {
		const key = uri.toString();
		let text: string | null;
		try {
			text = await readText(uri);
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			return { kind: 'unreadable', reason };
		}
		const known = this.seen.has(key);
		const before = this.seen.get(key);
		this.seen.set(key, text);
		if (known && before !== text) {
			this.changed.fire(config);
		}
		if (text === null) {
			return { kind: 'ok', file: undefined };
		}
		const parsed = parseSamplesFile(text);
		return parsed.ok ? { kind: 'ok', file: parsed.file } : { kind: 'unreadable', reason: parsed.reason };
	}

	/** Runs `task` after every earlier task of `uri`. */
	private queued<T>(uri: vscode.Uri, task: () => Promise<T>): Promise<T> {
		const key = uri.toString();
		const run = (this.queues.get(key) ?? Promise.resolve()).then(task, task);
		const tail = run.catch(() => undefined);
		this.queues.set(key, tail);
		void tail.then(() => {
			if (this.queues.get(key) === tail) {
				this.queues.delete(key);
			}
		});
		return run;
	}

	dispose(): void {
		for (const entry of this.watched.values()) {
			entry.watcher.dispose();
			entry.subscriptions.forEach((s) => s.dispose());
		}
		this.watched.clear();
		this.saves.dispose();
		this.changed.dispose();
		this.wrote.dispose();
	}
}
