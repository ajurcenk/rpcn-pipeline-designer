// DetectionRegistry (AD-18): the only answer to "is this a Redpanda Connect file". Tracks the
// open YAML documents and recomputes the pure rule (`detect` in `src/core/detection.ts`) on
// open, on change and when `redpandaConnect.filePatterns` changes; drops an entry on close.
// Keyed by `uri.toString()` (AD-1). `markDetected` is the session mark epic 3's Show graph
// calls: a marked URI is detected until the window closes, open or not. `onDidChangeDetection`
// fires only when `isDetected(uri)` flips. Resource files are never detected for `--resources`:
// lint and run use the `redpandaConnect.resourceFiles` setting only (AD-9).

import * as vscode from 'vscode';
import { detect } from '../../core/detection';

/** The slice of `vscode.workspace` the registry listens to (tests pass a fake). */
export interface DetectionSource {
	readonly textDocuments: readonly vscode.TextDocument[];
	readonly onDidOpenTextDocument: vscode.Event<vscode.TextDocument>;
	readonly onDidChangeTextDocument: vscode.Event<vscode.TextDocumentChangeEvent>;
	readonly onDidCloseTextDocument: vscode.Event<vscode.TextDocument>;
	readonly onDidChangeConfiguration: vscode.Event<vscode.ConfigurationChangeEvent>;
}

/** Reads `redpandaConnect.filePatterns`; invalid entries are dropped. */
export type PatternReader = () => readonly string[];

/** Whether `doc` matches one of `patterns`. */
export type PatternMatcher = (doc: vscode.TextDocument, patterns: readonly string[]) => boolean;

/** Payload of `onDidChangeDetection`. */
export interface DetectionChange {
	readonly uri: string;
	readonly detected: boolean;
}

const YAML_LANGUAGE_ID = 'yaml';
const FILE_PATTERNS_SETTING = 'redpandaConnect.filePatterns';

/** The non-empty string entries of a `redpandaConnect.filePatterns` value; anything else is ignored. */
export function filePatternsFrom(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : [];
}

/** Reads `redpandaConnect.filePatterns` (BAD_SETTING: invalid entries dropped, never throws). */
export function readFilePatterns(): readonly string[] {
	return filePatternsFrom(vscode.workspace.getConfiguration('redpandaConnect').get('filePatterns'));
}

// A pattern matches relative to the workspace folder that contains the file, or as is against
// the file's absolute path. So `*.rpcn.yaml` matches only at a folder root, `**/*.rpcn.yaml`
// anywhere (also outside a folder), and an absolute pattern works without a folder. A pattern
// VS Code cannot match counts as no match.
export function matchesFilePattern(
	doc: vscode.TextDocument,
	patterns: readonly string[],
	folderOf: (uri: vscode.Uri) => vscode.WorkspaceFolder | undefined = (uri) => vscode.workspace.getWorkspaceFolder(uri),
): boolean {
	const folder = folderOf(doc.uri);
	return patterns.some((pattern) => {
		try {
			return (folder !== undefined && vscode.languages.match({ pattern: new vscode.RelativePattern(folder, pattern) }, doc) > 0)
				|| vscode.languages.match({ pattern }, doc) > 0;
		} catch {
			return false;
		}
	});
}

export class DetectionRegistry implements vscode.Disposable {
	/** `uri.toString()` → detected, for every open YAML document. */
	private readonly entries = new Map<string, boolean>();
	/** URIs marked detected for the session (`markDetected`). */
	private readonly marked = new Set<string>();
	/** `uri.toString()` → matched by `filePatterns`; only the setting changes it, so cached. */
	private readonly patternMatches = new Map<string, boolean>();
	private readonly changeEmitter = new vscode.EventEmitter<DetectionChange>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private patterns: readonly string[];

	/** Fires when `isDetected(uri)` changes value. */
	readonly onDidChangeDetection: vscode.Event<DetectionChange> = this.changeEmitter.event;

	constructor(
		private readonly source: DetectionSource = vscode.workspace,
		private readonly readPatterns: PatternReader = readFilePatterns,
		private readonly matches: PatternMatcher = matchesFilePattern,
	) {
		this.patterns = readPatterns();
		this.subscriptions.push(
			this.changeEmitter,
			source.onDidOpenTextDocument((doc) => this.update(doc)),
			source.onDidChangeTextDocument((event) => this.update(event.document)),
			source.onDidCloseTextDocument((doc) => {
				this.patternMatches.delete(doc.uri.toString());
				this.set(doc.uri.toString(), undefined);
			}),
			source.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration(FILE_PATTERNS_SETTING)) {
					this.patterns = this.readPatterns();
					this.patternMatches.clear();
					this.source.textDocuments.forEach((doc) => this.update(doc));
				}
			}),
		);
		for (const doc of source.textDocuments) {
			this.update(doc);
		}
	}

	/** Synchronous: is this URI (a `Uri` or its `toString()`) a Redpanda Connect file? */
	isDetected(uri: string | vscode.Uri): boolean {
		const key = keyOf(uri);
		return this.marked.has(key) || this.entries.get(key) === true;
	}

	/** Whether the registry holds an entry (detected or not) for this open URI. */
	has(uri: string | vscode.Uri): boolean {
		return this.entries.has(keyOf(uri));
	}

	/** Marks a URI detected for the rest of the window session (Show graph, epic 3). Idempotent. */
	markDetected(uri: string | vscode.Uri): void {
		const key = keyOf(uri);
		const before = this.isDetected(key);
		this.marked.add(key);
		if (!before) {
			this.changeEmitter.fire({ uri: key, detected: true });
		}
	}

	dispose(): void {
		for (const d of this.subscriptions.splice(0)) {
			d.dispose();
		}
		this.entries.clear();
		this.marked.clear();
		this.patternMatches.clear();
	}

	private update(doc: vscode.TextDocument): void {
		// A language-mode change away from YAML: VS Code reports it as close + open.
		this.set(doc.uri.toString(), doc.languageId === YAML_LANGUAGE_ID
			? detect(doc.getText(), this.matchedByPattern(doc))
			: undefined);
	}

	private matchedByPattern(doc: vscode.TextDocument): boolean {
		if (this.patterns.length === 0) {
			return false;
		}
		const key = doc.uri.toString();
		let matched = this.patternMatches.get(key);
		if (matched === undefined) {
			matched = this.matches(doc, this.patterns);
			this.patternMatches.set(key, matched);
		}
		return matched;
	}

	/** Sets (or, with `undefined`, drops) an entry and fires when `isDetected` flips. */
	private set(key: string, value: boolean | undefined): void {
		const before = this.isDetected(key);
		if (value === undefined) {
			this.entries.delete(key);
		} else {
			this.entries.set(key, value);
		}
		const after = this.isDetected(key);
		if (before !== after) {
			this.changeEmitter.fire({ uri: key, detected: after });
		}
	}
}

function keyOf(uri: string | vscode.Uri): string {
	return typeof uri === 'string' ? uri : uri.toString();
}
