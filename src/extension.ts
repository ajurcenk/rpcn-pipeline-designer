// Composition root (AD-15): creates the single "Redpanda Connect" output channel
// and wires the adapters. Activated on `onLanguage:yaml`.

import * as vscode from 'vscode';
import { BinaryState, LogLine, RedpandaConnect } from './adapters/redpandaConnect/binary';
import { BinaryNotifier } from './adapters/redpandaConnect/notify';
import { SchemaStore } from './adapters/redpandaConnect/schema';
import { registerSchemaContributor, SchemaContributor } from './adapters/redhatYaml/contributor';
import { DetectionRegistry } from './adapters/vscode/detection';
import { LintDiagnostics } from './adapters/vscode/diagnostics';
import { LintQuickFix } from './adapters/vscode/quickFix';
import { GapCompletionProvider } from './adapters/vscode/completion';
import { BloblangProvider } from './adapters/vscode/bloblang';
import { SnippetCompletionProvider } from './adapters/vscode/snippets';
import { forgetDocument } from './adapters/vscode/parseCache';
import { RunController } from './adapters/vscode/run';
import { lintFile } from './adapters/redpandaConnect/lint';
import type { JsonObject } from './core/schema';

const OUTPUT_CHANNEL_NAME = 'Redpanda Connect';
export const REFRESH_SCHEMA_COMMAND = 'redpandaConnect.refreshSchema';

/** Logged when Refresh Schema finds no usable binary (2.8, retro A1). */
export const REFRESH_NO_BINARY_LINE = 'Refresh Schema: no usable Redpanda Connect binary, so there is no schema. Completion, hover and lint need one.';

/**
 * Refresh Schema (2.8): re-resolves the binary and regenerates the schema. With no usable binary
 * the user gets visible feedback: one log line and the binary warning again (same actions as at
 * activation). Open files follow the new schema without reopening (AD-10, AD-11).
 */
export async function refreshSchema(deps: {
	readonly schemaStore: { refresh(): Promise<unknown> };
	readonly binary: { readonly state: BinaryState; showBinaryWarning(): boolean };
	readonly log: (line: string) => void;
}): Promise<void> {
	await deps.schemaStore.refresh();
	if (deps.binary.state.kind !== 'ok') {
		deps.log(REFRESH_NO_BINARY_LINE);
		deps.binary.showBinaryWarning();
	}
}

/** Returned from `activate`; used by integration tests. */
export interface ExtensionApi {
	/** The single owner of `binaryState` (AD-9). */
	readonly redpandaConnect: RedpandaConnect;
	/** Resolves with the state after the activation-time resolution. */
	readonly activationResolved: Promise<BinaryState>;
	/** The single owner of the generated schema (AD-10). */
	readonly schemaStore: SchemaStore;
	/** Which open YAML documents are Redpanda Connect configs (AD-18). */
	readonly detection: DetectionRegistry;
	/** Lint on save (2.4); epic 3 reads `diagnosticsFor` / `onDidChangeDiagnostics`. */
	readonly lintDiagnostics: Pick<LintDiagnostics, 'diagnosticsFor' | 'onDidChangeDiagnostics'>;
	/** Run and Stop (2.7). */
	readonly run: RunController;
	/** The Red Hat YAML schema contributor's callbacks (AD-11). */
	readonly schemaContributor: SchemaContributor;
	/** Resolves with whether the `rpcn-schema` contributor was registered with Red Hat YAML. Never rejects. */
	readonly contributorRegistered: Promise<boolean>;
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

/**
 * The editor features on YAML documents (2.5, 2.14, 2.16, 2.19, 2.10): Quick Fixes on lint findings, completion
 * where Red Hat returns none, Bloblang completion and hover, and pipeline snippets. All share one parse per
 * document version (`parseCache`), which is dropped when the document closes.
 */
function registerEditorProviders(schema: () => JsonObject | undefined, detection: DetectionRegistry): vscode.Disposable[] {
	const yaml: vscode.DocumentSelector = { language: 'yaml' };
	const isDetected = (uri: vscode.Uri) => detection.isDetected(uri);
	const bloblang = new BloblangProvider({ schema, isDetected });
	return [
		vscode.languages.registerCodeActionsProvider(yaml, new LintQuickFix(schema), {
			providedCodeActionKinds: LintQuickFix.providedCodeActionKinds,
		}),
		vscode.languages.registerCompletionItemProvider(yaml, new GapCompletionProvider({ schema, isDetected })),
		vscode.languages.registerCompletionItemProvider(yaml, bloblang, ...BloblangProvider.triggerCharacters),
		vscode.languages.registerHoverProvider(yaml, bloblang),
		vscode.languages.registerCompletionItemProvider(yaml, new SnippetCompletionProvider(isDetected)),
		vscode.workspace.onDidCloseTextDocument((doc) => forgetDocument(doc.uri)),
	];
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

	// Subscribed before the first resolution, so activation's `unresolved` → `ok` generates (or reads the cache).
	const schemaStore = new SchemaStore({ binary: redpandaConnect, storageUri: context.globalStorageUri, log });
	context.subscriptions.push(
		schemaStore,
		vscode.commands.registerCommand(REFRESH_SCHEMA_COMMAND, () => refreshSchema({ schemaStore, binary: redpandaConnect, log })),
	);

	const detection = new DetectionRegistry();
	context.subscriptions.push(detection);
	const schemaContributor = new SchemaContributor(schemaStore, detection);
	const contributorRegistered = registerSchemaContributor({ contributor: schemaContributor, log });

	const lintDiagnostics = new LintDiagnostics({
		detection,
		lint: (doc) => lintFile(redpandaConnect.state, doc.uri.fsPath),
		log,
	});
	context.subscriptions.push(lintDiagnostics);
	context.subscriptions.push(...registerEditorProviders(() => schemaStore.current?.json, detection));

	const run = new RunController({ binary: redpandaConnect, detection, log });
	context.subscriptions.push(run, ...run.registerCommands());

	return {
		redpandaConnect,
		activationResolved: redpandaConnect.refresh(),
		schemaStore,
		detection,
		lintDiagnostics,
		run,
		schemaContributor,
		contributorRegistered,
		outputLines: () => [...lines],
	};
}

export function deactivate() {}
