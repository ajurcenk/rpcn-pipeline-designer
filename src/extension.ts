// Composition root (AD-15): creates the single "Redpanda Connect" output channel
// and wires the adapters. Activated on `onLanguage:yaml`.

import * as vscode from 'vscode';
import { checkConfiguredBinaryVersion } from './adapters/redpandaConnect/version';

export const OUTPUT_CHANNEL_NAME = 'Redpanda Connect';

/** Returned from `activate`; used by integration tests. */
export interface ExtensionApi {
	/** Resolves once the activation-time version check has been logged. */
	readonly versionChecked: Promise<void>;
	/** Lines written to the output channel by this extension, in order. */
	outputLines(): readonly string[];
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
	const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	context.subscriptions.push(channel);

	const lines: string[] = [];
	const log = (line: string) => {
		lines.push(line);
		channel.appendLine(line);
	};

	const versionChecked = checkConfiguredBinaryVersion(log)
		.then(() => undefined)
		.catch((err: unknown) => log(`Redpanda Connect version check failed: ${err instanceof Error ? err.message : String(err)}`));

	return {
		versionChecked,
		outputLines: () => [...lines],
	};
}

export function deactivate() {}
