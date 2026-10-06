// DetectionRegistry (AD-18): the only answer to "is this a Redpanda Connect file". Minimal
// form (ticket 2.1): tracks the open YAML documents, recomputes the pure predicate on open and
// on change, and drops an entry on close. Keyed by `uri.toString()` (AD-1).
// File patterns, template exclusion, resource files and `onDidChangeDetection` are ticket 2.2.

import * as vscode from 'vscode';
import { isRedpandaConnectConfig } from '../../core/detection';

/** The slice of `vscode.workspace` the registry listens to (tests pass a fake). */
export interface DetectionSource {
	readonly textDocuments: readonly vscode.TextDocument[];
	readonly onDidOpenTextDocument: vscode.Event<vscode.TextDocument>;
	readonly onDidChangeTextDocument: vscode.Event<vscode.TextDocumentChangeEvent>;
	readonly onDidCloseTextDocument: vscode.Event<vscode.TextDocument>;
}

const YAML_LANGUAGE_ID = 'yaml';

export class DetectionRegistry implements vscode.Disposable {
	/** `uri.toString()` → detected, for every open YAML document. */
	private readonly entries = new Map<string, boolean>();
	private readonly subscriptions: vscode.Disposable[] = [];

	constructor(source: DetectionSource = vscode.workspace) {
		this.subscriptions.push(
			source.onDidOpenTextDocument((doc) => this.update(doc)),
			source.onDidChangeTextDocument((event) => this.update(event.document)),
			source.onDidCloseTextDocument((doc) => { this.entries.delete(doc.uri.toString()); }),
		);
		for (const doc of source.textDocuments) {
			this.update(doc);
		}
	}

	/** Synchronous: is the open document with this URI (a `Uri` or its `toString()`) a Redpanda Connect config? */
	isDetected(uri: string | vscode.Uri): boolean {
		return this.entries.get(typeof uri === 'string' ? uri : uri.toString()) === true;
	}

	/** Whether the registry holds an entry (detected or not) for this URI. */
	has(uri: string | vscode.Uri): boolean {
		return this.entries.has(typeof uri === 'string' ? uri : uri.toString());
	}

	dispose(): void {
		for (const d of this.subscriptions.splice(0)) {
			d.dispose();
		}
		this.entries.clear();
	}

	private update(doc: vscode.TextDocument): void {
		const key = doc.uri.toString();
		if (doc.languageId !== YAML_LANGUAGE_ID) {
			// A language-mode change away from YAML: VS Code reports it as close + open.
			this.entries.delete(key);
			return;
		}
		this.entries.set(key, isRedpandaConnectConfig(doc.getText()));
	}
}
