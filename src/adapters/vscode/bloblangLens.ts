// "▷ Test mapping" CodeLens (ticket 4.2): one lens on the key line of every `mapping` / `mutation`
// processor of a detected config (AD-18), from the shared parse (`parseCache`). It runs Test mapping
// on that processor; untitled files get none (they never run). Lenses refresh when detection changes.

import * as vscode from 'vscode';
import { bloblangProcessors } from '../../core/bloblangProcessors';
import { TEST_MAPPING_COMMAND } from '../bloblangPanel/panels';
import type { DetectionRegistry } from './detection';
import { parsedDocument } from './parseCache';

export const TEST_MAPPING_LENS_TITLE = '▷ Test mapping';

export class BloblangLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.changed.event;
	private readonly subscription: vscode.Disposable | undefined;

	constructor(private readonly detection: Pick<DetectionRegistry, 'isDetected'> & Partial<Pick<DetectionRegistry, 'onDidChangeDetection'>>) {
		this.subscription = detection.onDidChangeDetection?.(() => this.changed.fire());
	}

	provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
		if (doc.uri.scheme === 'untitled' || !this.detection.isDetected(doc.uri)) {
			return [];
		}
		return bloblangProcessors(parsedDocument(doc).parsed).map((p) => {
			const start = doc.positionAt(p.keyRange[0]);
			return new vscode.CodeLens(new vscode.Range(start, start), {
				title: TEST_MAPPING_LENS_TITLE,
				command: TEST_MAPPING_COMMAND,
				arguments: [doc.uri, p.path],
			});
		});
	}

	dispose(): void {
		this.subscription?.dispose();
		this.changed.dispose();
	}
}
