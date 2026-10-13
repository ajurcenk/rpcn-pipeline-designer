// The Bloblang test panel registry (ticket 4.2, AD-1, AD-5, AD-21): one WebviewPanel per mapping,
// keyed by the file's `uri.toString()` plus the processor's path, titled `Bloblang: <label, else
// path>`. It opens beside the YAML without taking focus (entry 10 settles the group); a second Test
// mapping on the same processor reveals it. The webview posts `ready` (again whenever it is
// recreated, since `retainContextWhenHidden` is off) and gets a `snapshot` of the processor, and
// a new snapshot whenever an edit changes the processor's kind or Bloblang. Each `run {content, meta}`
// runs the processor's current Bloblang, read from the open document then, on the content through the
// AD-21 test run, and the panel gets the `result`. Runs are single flight per panel: an input that
// arrives during a run waits (only the latest one), and only the latest input's result is posted.
// Untitled files never run. Content only (ticket 4.4 settles the full protocol): the snapshot carries
// the binary's status and no samples; the run's metadata, the other webview messages, samples and
// the live parse come later (4.5, 4.7–4.9).

import * as path from 'path';
import * as vscode from 'vscode';
import { bloblangProcessorAt, bloblangProcessorByPath, bloblangProcessors, type BloblangProcessor } from '../../core/bloblangProcessors';
import {
	parseBloblangWebviewMessage, type BinaryStatus, type BloblangHostMessage, type BloblangProcessorKind,
} from '../../shared/bloblangProtocol';
import { webviewHtml } from '../graphPanel/html';
import type { BinaryState } from '../redpandaConnect/binary';
import { runMappingTest, type MappingTestDependencies, type MappingTestOutcome } from '../redpandaConnect/bloblang';
import type { DetectionRegistry } from '../vscode/detection';
import { parsedDocument } from '../vscode/parseCache';

export const TEST_MAPPING_COMMAND = 'redpandaConnect.testMapping';
export const BLOBLANG_VIEW_TYPE = 'redpandaConnect.bloblang';
/** Shown when Test mapping finds no mapping or mutation processor at the cursor. */
export const NO_MAPPING_AT_CURSOR = 'Put the cursor in a mapping or mutation processor.';
/** Shown when the CodeLens's processor is not in the open, detected document any more. */
export const NO_LONGER_THERE = 'That mapping or mutation processor is no longer there.';
/** Shown when Test mapping is used on an untitled file. */
export const SAVE_TO_TEST = 'Save the file to test its mappings.';
/** How many of a panel's posted messages `posted` keeps (test seam). */
export const MAX_BLOBLANG_POSTED = 50;

/** The tab title of a processor's panel. */
export function bloblangTitle(processor: Pick<BloblangProcessor, 'label' | 'path'>): string {
	return `Bloblang: ${processor.label ?? processor.path}`;
}

/** One mapping's panel, as seen by tests (the host-side seam). */
export interface BloblangPanelHandle {
	readonly uri: vscode.Uri;
	readonly path: string;
	readonly panel: vscode.WebviewPanel;
	/** The last MAX_BLOBLANG_POSTED messages posted to the webview, in order. */
	readonly posted: readonly BloblangHostMessage[];
	/** Handles `message` as if the webview had posted it; resolves once its reply is posted. */
	receive(message: unknown): Promise<void>;
}

/** Runs one test (the AD-21 adapter in production). */
export type MappingTestRunner = (
	state: BinaryState,
	kind: BloblangProcessorKind,
	source: string,
	content: string,
	storageDir: string,
	deps: MappingTestDependencies,
) => Promise<MappingTestOutcome>;

export interface BloblangPanelsOptions {
	readonly extensionUri: vscode.Uri;
	readonly log: (line: string) => void;
	/** The current binary (AD-9): `RedpandaConnect` in production. */
	readonly binary: { readonly state: BinaryState };
	/** Where temporary test configs are written: the extension's global storage. */
	readonly storageDir: string;
	/** Which files are Redpanda Connect configs (AD-18): only their processors are tested. */
	readonly detection: Pick<DetectionRegistry, 'isDetected'>;
	/** Test seam: the test runner; `undefined`: `runMappingTest`. */
	readonly run?: MappingTestRunner;
	/** Shows an information message; `undefined`: `window.showInformationMessage`. */
	readonly showMessage?: (message: string) => void;
}

class BloblangPanel implements BloblangPanelHandle {
	readonly posted: BloblangHostMessage[] = [];
	/** The latest input waiting for the run in flight to end (single flight); `undefined`: none. */
	private pending: string | undefined;
	/** The run loop in flight, if any. */
	private loop: Promise<void> | undefined;
	/** The `kind` and source last sent in a snapshot, so that an edit elsewhere sends nothing. */
	private sentSource: string | undefined;
	private disposed = false;
	private readonly subscription: vscode.Disposable;

	constructor(
		readonly uri: vscode.Uri,
		readonly path: string,
		readonly panel: vscode.WebviewPanel,
		private readonly owner: BloblangPanels,
	) {
		this.subscription = panel.webview.onDidReceiveMessage((m) => this.receive(m));
	}

	async receive(message: unknown): Promise<void> {
		try {
			const msg = parseBloblangWebviewMessage(message);
			if (msg?.type === 'ready') {
				await this.postSnapshot();
			} else if (msg?.type === 'run') {
				// The panel sets no metadata yet (4.7): the run uses the content only.
				await this.run(msg.content);
			}
		} catch (e) {
			this.fail(e);
		}
	}

	/** The panel's document changed: a snapshot when the processor's kind or Bloblang changed. */
	async documentChanged(): Promise<void> {
		try {
			const processor = this.processor();
			if (JSON.stringify([processor?.kind ?? 'mapping', processor?.source ?? '']) !== this.sentSource) {
				await this.postSnapshot();
			}
		} catch (e) {
			this.fail(e);
		}
	}

	private async postSnapshot(): Promise<void> {
		const processor = this.processor();
		const kind = processor?.kind ?? 'mapping';
		const source = processor?.source ?? '';
		this.sentSource = JSON.stringify([kind, source]);
		await this.post({
			type: 'snapshot', title: this.panel.title, kind, source, binary: this.owner.binaryStatus(), samples: [], selected: null,
		});
	}

	/**
	 * Single flight: one run child per panel at a time. An input arriving while one runs replaces
	 * any input still waiting, and starts when the current run ends; only a run with no input
	 * waiting after it posts its result. A run that throws posts an `error` result.
	 */
	private async run(input: string): Promise<void> {
		this.pending = input;
		if (!this.loop) {
			this.loop = (async () => {
				try {
					while (this.pending !== undefined && !this.disposed) {
						const next = this.pending;
						this.pending = undefined;
						let outcome: MappingTestOutcome;
						try {
							outcome = await this.owner.runTest(this.uri, this.processor(), this.path, next);
						} catch (e) {
							this.fail(e);
							outcome = { result: { kind: 'error', message: e instanceof Error ? e.message : String(e) }, durationMs: 0, binary: null };
						}
						if (this.pending === undefined) {
							await this.post({ type: 'result', ...outcome });
						}
					}
				} finally {
					this.loop = undefined;
				}
			})();
		}
		await this.loop;
	}

	/** The processor at this panel's path in the open document, now. */
	private processor(): BloblangProcessor | undefined {
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.uri.toString());
		return doc ? bloblangProcessorByPath(bloblangProcessors(parsedDocument(doc).parsed), this.path) : undefined;
	}

	private async post(message: BloblangHostMessage): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.posted.push(message);
		if (this.posted.length > MAX_BLOBLANG_POSTED) {
			this.posted.splice(0, this.posted.length - MAX_BLOBLANG_POSTED);
		}
		try {
			await this.panel.webview.postMessage(message);
		} catch (e) {
			this.fail(e);
		}
	}

	private fail(e: unknown): void {
		if (!this.disposed) {
			this.owner.log(`${this.panel.title}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	dispose(): void {
		this.disposed = true;
		this.subscription.dispose();
	}
}

/** All open Bloblang test panels, one per mapping processor. */
export class BloblangPanels implements vscode.Disposable {
	private readonly panels = new Map<string, BloblangPanel>();
	private readonly subscription: vscode.Disposable;

	constructor(private readonly options: BloblangPanelsOptions) {
		// The shown Bloblang follows edits, so it always matches what the next run uses.
		this.subscription = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.contentChanges.length === 0) {
				return;
			}
			const key = e.document.uri.toString();
			for (const entry of this.panels.values()) {
				if (entry.uri.toString() === key) {
					void entry.documentChanged();
				}
			}
		});
	}

	/** The binary's status, as the panel shows it. */
	binaryStatus(): BinaryStatus {
		return this.options.binary.state.kind;
	}

	/** Writes `line` to the output channel. */
	log(line: string): void {
		this.options.log(line);
	}

	registerCommands(): vscode.Disposable[] {
		return [
			vscode.commands.registerCommand(TEST_MAPPING_COMMAND, (uri?: unknown, processorPath?: unknown) => this.testMapping(uri, processorPath)),
		];
	}

	/**
	 * Test mapping: from the CodeLens, the processor at `processorPath` of `uri`; from the Command
	 * Palette (no arguments), the processor at the cursor of the active editor, else the message
	 * NO_MAPPING_AT_CURSOR. Never throws.
	 */
	async testMapping(uri?: unknown, processorPath?: unknown): Promise<BloblangPanelHandle | undefined> {
		try {
			if (uri instanceof vscode.Uri && typeof processorPath === 'string') {
				return await this.show(uri, processorPath);
			}
			const editor = vscode.window.activeTextEditor;
			const doc = editor?.document;
			if (doc?.uri.scheme === 'untitled') {
				this.tell(SAVE_TO_TEST);
				return undefined;
			}
			const processor = editor && doc && this.options.detection.isDetected(doc.uri)
				? bloblangProcessorAt(bloblangProcessors(parsedDocument(doc).parsed), doc.offsetAt(editor.selection.active))
				: undefined;
			if (!doc || !processor) {
				this.tell(NO_MAPPING_AT_CURSOR);
				return undefined;
			}
			return await this.show(doc.uri, processor.path);
		} catch (e) {
			this.log(`Test mapping: ${e instanceof Error ? e.message : String(e)}`);
			return undefined;
		}
	}

	private tell(message: string): void {
		this.log(`Test mapping: ${message}`);
		if (this.options.showMessage) {
			this.options.showMessage(message);
		} else {
			void vscode.window.showInformationMessage(message);
		}
	}

	/**
	 * Opens the panel of the processor at `processorPath` of `uri` beside the YAML without focus, or
	 * reveals its open panel. `undefined` (with the message) when the file is untitled, not detected,
	 * not open or has no such processor.
	 */
	async show(uri: vscode.Uri, processorPath: string): Promise<BloblangPanelHandle | undefined> {
		if (uri.scheme === 'untitled') {
			this.tell(SAVE_TO_TEST);
			return undefined;
		}
		const key = keyOf(uri, processorPath);
		const open = this.panels.get(key);
		if (open) {
			open.panel.reveal(undefined, true);
			return open;
		}
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
		const processor = doc && this.options.detection.isDetected(uri)
			? bloblangProcessorByPath(bloblangProcessors(parsedDocument(doc).parsed), processorPath)
			: undefined;
		if (!processor) {
			this.tell(NO_LONGER_THERE);
			return undefined;
		}
		const title = bloblangTitle(processor);
		const panel = vscode.window.createWebviewPanel(
			BLOBLANG_VIEW_TYPE,
			title,
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, 'dist')],
			},
		);
		const entry = new BloblangPanel(uri, processorPath, panel, this);
		this.panels.set(key, entry);
		panel.onDidDispose(() => {
			entry.dispose();
			if (this.panels.get(key) === entry) {
				this.panels.delete(key);
			}
		});
		panel.webview.html = webviewHtml(panel.webview, this.options.extensionUri, 'bloblang', title);
		return entry;
	}

	/** Runs `processor` (the one at `processorPath` of `uri`, now) on `input`. */
	async runTest(uri: vscode.Uri, processor: BloblangProcessor | undefined, processorPath: string, input: string): Promise<MappingTestOutcome> {
		const state = this.options.binary.state;
		if (!processor) {
			return {
				result: { kind: 'error', message: `There is no mapping or mutation processor at ${processorPath} in ${path.posix.basename(uri.path)} any more.` },
				durationMs: 0,
				binary: null,
			};
		}
		const cwd = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath);
		return (this.options.run ?? runMappingTest)(state, processor.kind, processor.source, input, this.options.storageDir, { cwd });
	}

	/** The open panel of the processor at `processorPath` of `uri`, if any (test seam). */
	panelFor(uri: vscode.Uri, processorPath: string): BloblangPanelHandle | undefined {
		return this.panels.get(keyOf(uri, processorPath));
	}

	/** How many Bloblang panels are open. */
	get size(): number {
		return this.panels.size;
	}

	dispose(): void {
		this.subscription.dispose();
		for (const entry of [...this.panels.values()]) {
			entry.panel.dispose();
		}
		this.panels.clear();
	}
}

function keyOf(uri: vscode.Uri, processorPath: string): string {
	return `${uri.toString()}#${processorPath}`;
}
