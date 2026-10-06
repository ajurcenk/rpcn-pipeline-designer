// Composition root (AD-15): creates the single "Redpanda Connect" output channel
// and wires the adapters. Activated on `onLanguage:yaml`.

import * as vscode from 'vscode';
import { BinaryState, LogLine, RedpandaConnect } from './adapters/redpandaConnect/binary';
import { BinaryNotifier } from './adapters/redpandaConnect/notify';

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

/** The VS Code side of the binary-missing notification: non-modal warning, browser, picker, user setting. */
export function createVsCodeNotifier(log: LogLine): BinaryNotifier {
	return {
		showWarning: (message, actions) => vscode.window.showWarningMessage(message, ...actions),
		openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
		pickBinary: async () => {
			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				openLabel: 'Set path',
				title: 'Redpanda Connect binary (rpk or redpanda-connect)',
			});
			const uri = picked?.[0];
			if (!uri) {
				return undefined;
			}
			if (uri.scheme !== 'file') {
				log(`Set path: only local files are supported; ignoring ${uri.toString()}.`);
				return undefined;
			}
			return uri.fsPath;
		},
		setBinaryPath: async (binaryPath) => {
			await vscode.workspace.getConfiguration('redpandaConnect')
				.update('binaryPath', binaryPath, vscode.ConfigurationTarget.Global);
			// `machine-overridable`: a workspace or folder value silently wins over the user value.
			const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
			const inspected = vscode.workspace.getConfiguration('redpandaConnect', folder).inspect<string>('binaryPath');
			const override = inspected?.workspaceFolderValue !== undefined
				? { scope: 'folder', value: inspected.workspaceFolderValue }
				: inspected?.workspaceValue !== undefined
					? { scope: 'workspace', value: inspected.workspaceValue }
					: undefined;
			if (override) {
				log(`Set path: saved "${binaryPath}" to the user setting redpandaConnect.binaryPath, but the `
					+ `${override.scope} value "${override.value}" overrides it.`);
			}
		},
	};
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
	const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	context.subscriptions.push(channel);

	const lines: string[] = [];
	const log = (line: string) => {
		lines.push(line);
		channel.appendLine(line);
	};

	const redpandaConnect = new RedpandaConnect({ log, notifier: createVsCodeNotifier(log) });
	context.subscriptions.push(redpandaConnect);

	return {
		redpandaConnect,
		activationResolved: redpandaConnect.refresh(),
		outputLines: () => [...lines],
	};
}

export function deactivate() {}
