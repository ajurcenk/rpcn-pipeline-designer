// Composition root (AD-15): creates the single "Redpanda Connect" output channel
// and wires the adapters. Activated on `onLanguage:yaml`.

import * as vscode from 'vscode';
import { BinaryState, RedpandaConnect } from './adapters/redpandaConnect/binary';

export const OUTPUT_CHANNEL_NAME = 'Redpanda Connect';

/** Returned from `activate`; used by integration tests. */
export interface ExtensionApi {
	/** The single owner of `binaryState` (AD-9). */
	readonly redpandaConnect: RedpandaConnect;
	/** Resolves with the state after the activation-time resolution. */
	readonly activationResolved: Promise<BinaryState>;
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

	const redpandaConnect = new RedpandaConnect({ log });
	context.subscriptions.push(redpandaConnect);

	return {
		redpandaConnect,
		activationResolved: redpandaConnect.refresh(),
		outputLines: () => [...lines],
	};
}

export function deactivate() {}
