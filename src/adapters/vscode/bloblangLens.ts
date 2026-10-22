// "▷ Test mapping" CodeLens (ticket 4.2): one lens on the key line of every `mapping` / `mutation`
// processor of a detected config (AD-18), from the shared parse (`parseCache`). It runs Test mapping
// on that processor; untitled files get none (they never run). Lenses refresh when detection changes.
// A `generate` input's mapping gets none (ticket 22: `processorsOnly`).
// Ticket 4.16 (AD-22): each lens shows its processor's sample count, `▷ Test mapping · N samples`
// (`· 1 sample`; none, or a samples file that is missing or can't be read: no count), read through
// the panels' `SampleStore` with the panel's linking rule (the label, else the unlabelled path
// entry). Lenses also refresh after the store writes a samples file, on any create, change or delete
// of a `*.samples.json` (one workspace watcher, plus a folder watcher for a config outside every
// workspace folder while it is open), and on a VS Code save of one.

import * as path from 'path';
import * as vscode from 'vscode';
import { bloblangProcessors, processorsOnly } from '../../core/bloblangProcessors';
import { sampleCount, type SamplesFile } from '../../core/samples';
import { TEST_MAPPING_COMMAND } from '../bloblangPanel/panels';
import type { SampleStore } from '../bloblangPanel/sampleStore';
import type { DetectionRegistry } from './detection';
import { parsedDocument } from './parseCache';

export const TEST_MAPPING_LENS_TITLE = '▷ Test mapping';

/** The lens's title for a processor with `count` samples (4.16). */
export function testMappingLensTitle(count: number): string {
	return count <= 0 ? TEST_MAPPING_LENS_TITLE : `${TEST_MAPPING_LENS_TITLE} · ${count} ${count === 1 ? 'sample' : 'samples'}`;
}

const SAMPLES_GLOB = '**/*.samples.json';

export class BloblangLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.changed.event;
	private readonly subscriptions: vscode.Disposable[] = [];
	/** Per folder outside every workspace folder that holds a lensed config: its `*.samples.json` watcher. */
	private readonly folders = new Map<string, vscode.Disposable>();

	constructor(
		private readonly detection: Pick<DetectionRegistry, 'isDetected'> & Partial<Pick<DetectionRegistry, 'onDidChangeDetection'>>,
		/** The panels' samples files (4.16); `undefined`: no counts. */
		private readonly samples?: Pick<SampleStore, 'read' | 'onDidWrite' | 'onDidChange'>,
	) {
		const refresh = () => this.changed.fire();
		const detectionChanged = detection.onDidChangeDetection?.(refresh);
		if (detectionChanged) {
			this.subscriptions.push(detectionChanged);
		}
		if (samples) {
			const watcher = vscode.workspace.createFileSystemWatcher(SAMPLES_GLOB);
			this.subscriptions.push(
				samples.onDidWrite(refresh),
				samples.onDidChange(refresh),
				watcher,
				watcher.onDidCreate(refresh),
				watcher.onDidChange(refresh),
				watcher.onDidDelete(refresh),
				vscode.workspace.onDidSaveTextDocument((doc) => {
					if (doc.uri.path.endsWith('.samples.json')) {
						refresh();
					}
				}),
				vscode.workspace.onDidCloseTextDocument(() => this.pruneFolders()),
			);
		}
	}

	async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
		if (doc.uri.scheme === 'untitled' || !this.detection.isDetected(doc.uri)) {
			return [];
		}
		const processors = processorsOnly(bloblangProcessors(parsedDocument(doc).parsed));
		const file = processors.length > 0 ? await this.samplesOf(doc.uri) : undefined;
		return processors.map((p) => {
			const start = doc.positionAt(p.keyRange[0]);
			const count = sampleCount(file, p.label !== undefined ? { label: p.label, path: p.path } : { path: p.path });
			return new vscode.CodeLens(new vscode.Range(start, start), {
				title: testMappingLensTitle(count),
				command: TEST_MAPPING_COMMAND,
				arguments: [doc.uri, p.path],
			});
		});
	}

	/** `config`'s samples file; `undefined` with none, or when it can't be read. Never throws. */
	private async samplesOf(config: vscode.Uri): Promise<SamplesFile | undefined> {
		if (!this.samples) {
			return undefined;
		}
		this.watchFolder(config);
		try {
			const state = await this.samples.read(config);
			return state.kind === 'ok' ? state.file : undefined;
		} catch {
			return undefined;
		}
	}

	/** A config outside every workspace folder: a watcher on its folder's samples files (the glob misses it). */
	private watchFolder(config: vscode.Uri): void {
		if (config.scheme !== 'file' || vscode.workspace.getWorkspaceFolder(config)) {
			return;
		}
		const dir = config.with({ path: path.posix.dirname(config.path) });
		const key = dir.toString();
		if (this.folders.has(key)) {
			return;
		}
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '*.samples.json'));
		const refresh = () => this.changed.fire();
		const subscriptions = [watcher.onDidCreate(refresh), watcher.onDidChange(refresh), watcher.onDidDelete(refresh)];
		this.folders.set(key, new vscode.Disposable(() => {
			watcher.dispose();
			subscriptions.forEach((s) => s.dispose());
		}));
	}

	/** Drops the folder watchers with no open document left in their folder. */
	private pruneFolders(): void {
		const open = new Set(vscode.workspace.textDocuments.map((d) => d.uri.with({ path: path.posix.dirname(d.uri.path) }).toString()));
		for (const [key, watcher] of this.folders) {
			if (!open.has(key)) {
				watcher.dispose();
				this.folders.delete(key);
			}
		}
	}

	dispose(): void {
		this.subscriptions.forEach((s) => s.dispose());
		this.folders.forEach((w) => w.dispose());
		this.folders.clear();
		this.changed.dispose();
	}
}
