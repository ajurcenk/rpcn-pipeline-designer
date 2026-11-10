// Ticket 46: the variables a local Run would stop on, shown before it runs.
//
// A Warning at each `${NAME}` without a default (`requiredReferences`, the binary's own rules) that
// no local source sets (`unsetNames`: the Environment view's four sources and precedence; an empty
// value is set), in every open detected config. A `${secrets.NAME}` is always warned (only Redpanda
// Cloud sets it) and has no quick fix (nor has a name the settings cannot take, such as `${1A}`);
// any other gets "Set NAME…", which runs the Environment view's
// `SET_MISSING_COMMAND` (plain or secret, for the config's folder). Lint keeps
// `--skip-env-var-check` (AD-9): these Warnings are their own collection, not lint's, so the graph
// never shows them (AD-17). The Warnings follow the text (debounced like the live check), the
// `env`, `secretEnv` and `envFile` settings, the secrets, the workspace folders and each open
// config's env file on disk, without a save or a reopen. Names only: never a value.
//
// Run's check (`forRun`) is the same over the config and the files `redpandaConnect.resourceFiles`
// passes with it, against the config's sources; the resource files' names are not shown on the
// config.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isCloudSecretName, requiredReferences } from '../../core/envUsage';
import { isEnvName } from '../../shared/bloblangProtocol';
import { expandResourceEntry } from '../redpandaConnect/resourceGlob';
import { BLOBLANG_DEBOUNCE_MS } from './bloblangDiagnostics';
import { type EnvironmentInputs, unsetNames } from './environmentModel';
import { SET_MISSING_COMMAND } from './environmentView';

export const UNSET_COLLECTION = 'redpanda-connect-unset-variables';
/** The Warnings' source (not lint's, so lint's quick fixes and the graph leave them alone). */
export const UNSET_SOURCE = 'Redpanda Connect environment';

const SHOWN_SCHEMES: readonly string[] = ['file', 'untitled'];
/** When a new env file watcher's configs are read again, in case a change came before its watch was live. */
const WATCH_SETTLE_MS: readonly number[] = [500, 2_000, 5_000];

/** A Warning's message: the name only. */
export function unsetMessage(name: string): string {
	return isCloudSecretName(name)
		? `${name} is not set: a local Run stops on it and cannot set it; only Redpanda Cloud does.`
		: `${name} is not set: a local Run stops on it. Deploy reads it from the cluster's secrets.`;
}

/** The quick fix's title. */
export const setTitle = (name: string) => `Set ${name}…`;

export interface UnsetVariablesOptions {
	readonly detection: {
		isDetected(uri: string | vscode.Uri): boolean;
		readonly onDidChangeDetection: vscode.Event<{ readonly uri: string; readonly detected: boolean }>;
	};
	/** The four sources for a config, read now (`EnvironmentView.inputsAt`). */
	readonly inputsFor: (uri: vscode.Uri) => EnvironmentInputs;
	/** The absolute `redpandaConnect.resourceFiles` paths a Run of `uri` passes (none when unusable). */
	readonly resourceFilesFor: (uri: vscode.Uri) => readonly string[];
	readonly secretsChanged: vscode.Event<unknown>;
	readonly log: (line: string) => void;
	readonly debounceMs?: number;
}

export class UnsetVariables implements vscode.CodeActionProvider, vscode.Disposable {
	static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

	private readonly collection = vscode.languages.createDiagnosticCollection(UNSET_COLLECTION);
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly timers = new Map<string, NodeJS.Timeout>();
	/** Each shown config's env file (`undefined`: none). */
	private readonly envFiles = new Map<string, string | undefined>();
	private readonly watchers = new Map<string, vscode.Disposable>();
	private readonly updateEmitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly debounceMs: number;

	/** Fires after a config's Warnings are recomputed (the test seam). */
	readonly onDidUpdate: vscode.Event<vscode.Uri> = this.updateEmitter.event;

	constructor(private readonly options: UnsetVariablesOptions) {
		this.debounceMs = options.debounceMs ?? BLOBLANG_DEBOUNCE_MS;
		const affects = (e: vscode.ConfigurationChangeEvent) => ['env', 'secretEnv', 'envFile'].some((k) => e.affectsConfiguration(`redpandaConnect.${k}`));
		this.subscriptions.push(
			this.collection,
			this.updateEmitter,
			options.detection.onDidChangeDetection((change) => this.update(vscode.Uri.parse(change.uri))),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (e.contentChanges.length > 0 && options.detection.isDetected(e.document.uri)) {
					this.schedule(e.document.uri);
				}
			}),
			// A URI detected for the session (Show graph) stays detected after a close: no detection change on a reopen.
			vscode.workspace.onDidOpenTextDocument((doc) => this.update(doc.uri)),
			vscode.workspace.onDidCloseTextDocument((doc) => this.forget(doc.uri)),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (affects(e)) {
					this.updateAll();
				}
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.updateAll()),
			options.secretsChanged(() => this.updateAll()),
		);
		this.updateAll();
	}

	/** The Warnings shown for `uri` (the test seam). */
	diagnosticsFor(uri: vscode.Uri): readonly vscode.Diagnostic[] {
		return this.collection.get(uri) ?? [];
	}

	/**
	 * The names a Run of `uri` would stop on, each once, in order: the config's, then each resource
	 * file's, against the config's sources. Reads now: the config as Run saved it, the resource files
	 * from disk (Run saves only the config; the binary reads the disk), each `resourceFiles` entry
	 * expanded as the binary expands a glob. Never throws (none on a failure, logged).
	 */
	forRun(uri: vscode.Uri): string[] {
		try {
			const names = requiredReferences(textOf(uri)).map((r) => r.name);
			for (const entry of this.options.resourceFilesFor(uri)) {
				for (const file of expandResourceEntry(entry)) {
					names.push(...requiredReferences(diskText(file)).map((r) => r.name));
				}
			}
			const unset = unsetNames(this.options.inputsFor(uri), names);
			return [...new Set(names.filter((n) => unset.has(n)))];
		} catch (err) {
			this.options.log(`Run ${path.basename(uri.fsPath)}: could not check its environment variables: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
		const actions: vscode.CodeAction[] = [];
		const seen = new Set<string>();
		for (const diagnostic of context.diagnostics) {
			if (diagnostic.source !== UNSET_SOURCE) {
				continue;
			}
			const name = nameAt(doc.getText(diagnostic.range));
			if (!name || !settable(name) || seen.has(name)) {
				continue;
			}
			seen.add(name);
			const action = new vscode.CodeAction(setTitle(name), vscode.CodeActionKind.QuickFix);
			action.diagnostics = [diagnostic];
			action.command = { title: setTitle(name), command: SET_MISSING_COMMAND, arguments: [name, doc.uri] };
			actions.push(action);
		}
		return actions;
	}

	dispose(): void {
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();
		for (const watcher of this.watchers.values()) {
			watcher.dispose();
		}
		this.watchers.clear();
		for (const d of this.subscriptions.splice(0)) {
			d.dispose();
		}
	}

	private schedule(uri: vscode.Uri): void {
		const key = uri.toString();
		clearTimeout(this.timers.get(key));
		this.timers.set(key, setTimeout(() => {
			this.timers.delete(key);
			this.update(uri);
		}, this.debounceMs));
	}

	private updateAll(): void {
		const keys = new Set([...vscode.workspace.textDocuments.map((d) => d.uri.toString()), ...this.envFiles.keys()]);
		for (const key of keys) {
			this.update(vscode.Uri.parse(key), false);
		}
		this.reconcileWatchers();
	}

	/** Recomputes `uri`'s Warnings (none unless it is an open detected config). */
	private update(uri: vscode.Uri, watch = true): void {
		const key = uri.toString();
		clearTimeout(this.timers.get(key));
		this.timers.delete(key);
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
		// A file or an untitled config (not a pipeline read from Redpanda Cloud, which a local Run never runs).
		if (!doc || !SHOWN_SCHEMES.includes(uri.scheme) || !this.options.detection.isDetected(uri)) {
			this.collection.delete(uri);
			this.envFiles.delete(key);
		} else {
			try {
				const inputs = this.options.inputsFor(uri);
				const text = doc.getText();
				const references = requiredReferences(text);
				const unset = unsetNames(inputs, references.map((r) => r.name));
				this.collection.set(uri, references.filter((r) => unset.has(r.name)).map((r) => {
					const diagnostic = new vscode.Diagnostic(new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)), unsetMessage(r.name), vscode.DiagnosticSeverity.Warning);
					diagnostic.source = UNSET_SOURCE;
					return diagnostic;
				}));
				this.envFiles.set(key, inputs.envFile?.path);
			} catch (err) {
				this.options.log(`Unset variables of ${path.basename(uri.fsPath)}: ${err instanceof Error ? err.message : String(err)}`);
				this.collection.delete(uri);
			}
		}
		if (watch) {
			this.reconcileWatchers();
		}
		this.updateEmitter.fire(uri);
	}

	private forget(uri: vscode.Uri): void {
		const key = uri.toString();
		clearTimeout(this.timers.get(key));
		this.timers.delete(key);
		this.collection.delete(uri);
		this.envFiles.delete(key);
		this.reconcileWatchers();
	}

	/** One watcher per env file an open config reads; a change recomputes those configs. */
	private reconcileWatchers(): void {
		const wanted = new Set([...this.envFiles.values()].filter((p): p is string => !!p));
		for (const [file, watcher] of this.watchers) {
			if (!wanted.has(file)) {
				watcher.dispose();
				this.watchers.delete(file);
			}
		}
		for (const file of wanted) {
			if (this.watchers.has(file)) {
				continue;
			}
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
			const changed = () => {
				for (const [key, envFile] of [...this.envFiles]) {
					if (envFile === file) {
						this.update(vscode.Uri.parse(key));
					}
				}
			};
			// The watch starts asynchronously (in the main process; its own request for a folder outside the
			// workspace): a write just after the setting changed comes before it is live and fires nothing.
			// So the configs are read again once the watch has had time to start.
			const settle = WATCH_SETTLE_MS.map((ms) => setTimeout(changed, ms));
			this.watchers.set(file, vscode.Disposable.from(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed),
				new vscode.Disposable(() => settle.forEach(clearTimeout))));
		}
	}
}

/** Whether a quick fix can set `name`: a name the settings and secrets take (`secrets.A`, `a.b` and `1A` cannot). */
export function settable(name: string): boolean {
	return isEnvName(name);
}

/** `${NAME}`'s name, from the text a Warning covers. */
function nameAt(text: string): string | undefined {
	return /^\$\{([0-9A-Za-z_.]+)\}$/.exec(text)?.[1];
}

/** A file's text on disk (`''` when unreadable: the binary fails on it by itself). */
function diskText(file: string): string {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return '';
	}
}

/** A file's text: the open document's, else the file on disk (`''` when unreadable). */
function textOf(uri: vscode.Uri): string {
	const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
	if (open) {
		return open.getText();
	}
	try {
		return uri.scheme === 'file' ? fs.readFileSync(uri.fsPath, 'utf8') : '';
	} catch {
		return '';
	}
}
