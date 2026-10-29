// Composition root (AD-15): creates the single "Redpanda Connect" output channel
// and wires the adapters. Activated on `onLanguage:yaml`.

import * as vscode from 'vscode';
import { BinaryState, LogLine, RedpandaConnect } from './adapters/redpandaConnect/binary';
import { BinaryNotifier } from './adapters/redpandaConnect/notify';
import { EnvSettingFiles, envSettingContent, setActiveEnvSettingFiles } from './adapters/redpandaConnect/envSetting';
import { SchemaStore } from './adapters/redpandaConnect/schema';
import { registerSchemaContributor, SchemaContributor } from './adapters/redhatYaml/contributor';
import { DetectionRegistry } from './adapters/vscode/detection';
import { LintDiagnostics } from './adapters/vscode/diagnostics';
import { BloblangDiagnostics } from './adapters/vscode/bloblangDiagnostics';
import { parseMapping } from './adapters/redpandaConnect/bloblang';
import { LintQuickFix } from './adapters/vscode/quickFix';
import { GapCompletionProvider } from './adapters/vscode/completion';
import { BloblangProvider } from './adapters/vscode/bloblang';
import { SnippetCompletionProvider } from './adapters/vscode/snippets';
import { forgetDocument } from './adapters/vscode/parseCache';
import { RunController } from './adapters/vscode/run';
import { lintFile } from './adapters/redpandaConnect/lint';
import { GraphPanels } from './adapters/graphPanel/panels';
import { BloblangPanels } from './adapters/bloblangPanel/panels';
import { BloblangLensProvider } from './adapters/vscode/bloblangLens';
import { SecretVariables } from './adapters/vscode/secrets';
import { EnvHoverProvider } from './adapters/vscode/envHover';
import { DEFAULT_LICENSE_README_URL, EnvironmentView, LICENSE_README_ANCHOR } from './adapters/vscode/environmentView';
import { activeSecretValues, setActiveSecretValues } from './adapters/redpandaConnect/secretEnv';
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
	/** Live Bloblang syntax diagnostics (4.5); tests read its diagnostics and count its parses. */
	readonly bloblangDiagnostics: Pick<BloblangDiagnostics, 'diagnostics' | 'parseCount' | 'inFlight' | 'onDidParse' | 'onDidChangeDiagnostics'>;
	/** Run and Stop (2.7). */
	readonly run: RunController;
	/** The pipeline graph panels, one per file (3.1); tests use `panelFor` as their seam. */
	readonly graphPanels: GraphPanels;
	/** The Bloblang test panels, one per mapping (4.2); tests use `panelFor` as their seam. */
	readonly bloblangPanels: BloblangPanels;
	/** The "▷ Test mapping" CodeLens (4.2); tests hear its refreshes (4.16). */
	readonly bloblangLens: Pick<BloblangLensProvider, 'onDidChangeCodeLenses'>;
	/** The Red Hat YAML schema contributor's callbacks (AD-11). */
	readonly schemaContributor: SchemaContributor;
	/** Resolves with whether the `rpcn-schema` contributor was registered with Red Hat YAML. Never rejects. */
	readonly contributorRegistered: Promise<boolean>;
	/**
	 * Secret environment variables (ticket 30): set, remove and clear without the input boxes. Only
	 * in `ExtensionMode.Test`: elsewhere any extension could read the values through it.
	 */
	readonly secrets?: Pick<SecretVariables, 'set' | 'remove' | 'clear' | 'reload' | 'settled' | 'recordedKeys' | 'values' | 'onDidChange'>;
	/**
	 * The Environment view (ticket 31): its items, the config it shows, its refreshes, and its prompts
	 * and settings write to replace. Only in `ExtensionMode.Test`, as `secrets`: its items carry values.
	 */
	readonly environment?: Pick<EnvironmentView, 'items' | 'model' | 'modelFor' | 'configUri' | 'visible' | 'message' | 'refresh' | 'onDidRefresh' | 'ui' | 'writeSetting'
		| 'license' | 'licenseState' | 'licenseDefaultPath' | 'openExternal'>;
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

/**
 * Sets where the `redpandaConnect.env` env files go (ticket 29) and removes the ones no longer
 * current: those of no value this window's settings hold (the window's and each folder's). Only
 * here, since a command may still be starting on an older file.
 */
export function activateEnvSetting(storageDir: string, log: (line: string) => void): vscode.Disposable {
	const files = EnvSettingFiles.in(storageDir, log);
	setActiveEnvSettingFiles(files);
	const scopes = [undefined, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)];
	const current = scopes
		.map((scope) => envSettingContent(vscode.workspace.getConfiguration('redpandaConnect', scope).get<unknown>('env', {})))
		.filter((c): c is string => c !== undefined);
	const failed = files.sweep(current);
	if (failed.length > 0) {
		log(`redpandaConnect.env: could not remove ${failed.length} old env file(s) in ${files.dir}.`);
	}
	return new vscode.Disposable(() => setActiveEnvSettingFiles(undefined));
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
	const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	context.subscriptions.push(channel);

	const lines: string[] = [];
	// Ticket 30: every loaded secret value is masked in the output channel (text from the binary may quote one).
	const log = (raw: string) => {
		const line = activeSecretValues()?.mask(raw) ?? raw;
		lines.push(line);
		channel.appendLine(line);
	};

	// `redpandaConnect.env` (ticket 29): the commands write its env file under global storage.
	context.subscriptions.push(activateEnvSetting(context.globalStorageUri.fsPath, log));
	// `redpandaConnect.secretEnv` (ticket 30): the values, loaded from the secret storage, for every command.
	const secrets = new SecretVariables({ store: context.secrets, memento: context.globalState, log });
	setActiveSecretValues(secrets.values);
	context.subscriptions.push(secrets, ...secrets.registerCommands(), new vscode.Disposable(() => setActiveSecretValues(undefined)));

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

	// Live Bloblang parse errors (4.5, AD-21): their own collection; lint hides its duplicate.
	const bloblangDiagnostics = new BloblangDiagnostics({
		detection,
		binary: redpandaConnect,
		parse: (source, uri) => parseMapping(redpandaConnect.state, source, context.globalStorageUri.fsPath, { resource: uri }),
		log,
		secretsChanged: secrets.onDidChange,
	});
	const lintDiagnostics = new LintDiagnostics({
		detection,
		lint: (doc) => lintFile(redpandaConnect.state, doc.uri.fsPath),
		log,
		bloblangErrors: bloblangDiagnostics,
	});
	context.subscriptions.push(lintDiagnostics, bloblangDiagnostics);
	context.subscriptions.push(...registerEditorProviders(() => schemaStore.current?.json, detection));

	const run = new RunController({ binary: redpandaConnect, detection, log });
	context.subscriptions.push(run, ...run.registerCommands());

	const graphPanels = new GraphPanels({
		extensionUri: context.extensionUri,
		log,
		binary: redpandaConnect,
		schema: schemaStore,
		diagnostics: lintDiagnostics,
		// The same actions as the binary warning's (built on `createVsCodeNotifier(log)`).
		actions: redpandaConnect.actions,
		detection,
		memento: context.workspaceState,
		autoOpen: () => vscode.workspace.getConfiguration('redpandaConnect').get<boolean>('autoOpenGraph', true) !== false,
	});
	context.subscriptions.push(graphPanels, ...graphPanels.registerCommands());

	// Test mapping (4.2, AD-21): a CodeLens per mapping / mutation processor and one panel per mapping.
	const bloblangPanels = new BloblangPanels({
		extensionUri: context.extensionUri,
		log,
		binary: redpandaConnect,
		// The graph's actions (4.15): the no-binary state's buttons.
		actions: redpandaConnect.actions,
		storageDir: context.globalStorageUri.fsPath,
		detection,
		// 4.17: a new test panel goes below the file's graph.
		graphColumn: (uri) => graphPanels.panelFor(uri)?.panel.viewColumn,
		// Bug 19: a placement waits for the file's graph lock sequence.
		graphSettled: async (uri) => {
			await graphPanels.panelFor(uri)?.lockSettled;
		},
	});
	// The lens counts each processor's samples (4.16) through the panels' store; it disposes its watchers.
	const bloblangLens = new BloblangLensProvider(detection, bloblangPanels.samples);
	context.subscriptions.push(
		bloblangPanels,
		...bloblangPanels.registerCommands(),
		bloblangLens,
		vscode.languages.registerCodeLensProvider({ language: 'yaml' }, bloblangLens),
	);

	// The Environment view (ticket 31): reads the four sources for the active config; writes through the settings and `secrets`.
	// Ticket 38: its License group's check runs the binary with the config's command line, its temporary config in global storage.
	const environment = new EnvironmentView({
		detection,
		secrets,
		log,
		binaryState: () => redpandaConnect.state,
		storageDir: context.globalStorageUri.fsPath,
		licenseReadmeUrl: licenseReadmeUrl(context.extension.packageJSON as { repository?: { url?: unknown } }),
	});
	context.subscriptions.push(environment, ...environment.register());
	// The variable hover (ticket 34), beside the Bloblang and YAML hovers: the view's model for the hovered config, read on each hover.
	context.subscriptions.push(vscode.languages.registerHoverProvider({ language: 'yaml' }, new EnvHoverProvider({
		isDetected: (uri) => detection.isDetected(uri),
		modelFor: (uri) => environment.modelFor(uri),
	})));

	return {
		redpandaConnect,
		activationResolved: redpandaConnect.refresh(),
		schemaStore,
		detection,
		lintDiagnostics,
		bloblangDiagnostics,
		run,
		graphPanels,
		bloblangPanels,
		bloblangLens,
		schemaContributor,
		contributorRegistered,
		...(context.extensionMode === vscode.ExtensionMode.Test ? { secrets, environment } : {}),
		outputLines: () => [...lines],
	};
}

/** Ticket 38: the README's license section, from `package.json`'s repository (else the default). */
export function licenseReadmeUrl(packageJson: { repository?: { url?: unknown } } | undefined): string {
	const url = packageJson?.repository?.url;
	return typeof url === 'string' && /^https:\/\//.test(url)
		? `${url.replace(/\.git$/, '').replace(/\/+$/, '')}#${LICENSE_README_ANCHOR}`
		: DEFAULT_LICENSE_README_URL;
}

export function deactivate() {}
