// The Environment view (ticket 31): a tree in the Redpanda Connect Activity Bar container showing,
// for the active detected config (the last one while another editor is active), its variables by
// source: the `redpandaConnect.env` setting, the `redpandaConnect.envFile` file, the secrets
// (`redpandaConnect.secretEnv`, ticket 30) and VS Code's environment (the names the config uses
// only), which one the commands get, which ones are overridden (crossed out), and the variables the
// config uses that nothing sets ("Missing"), each with an action that sets it as a plain or a
// secret variable. The precedence and states come from `environmentModel.ts` (pure).
//
// The view only reads: how variables reach the commands does not change (tickets 29 and 30). Its
// actions write through the same places the user would: one key of `redpandaConnect.env` at the
// level it came from (a new one at the folder level in a multi-root workspace, the workspace level
// with one folder, the user level without one), and ticket 30's `SecretVariables` for secrets. The
// env file is read for display only (`envFileRead.ts`, the binary's own rules) and never edited.
//
// Secret, env-file and VS Code environment values are masked until "Show value" for that row;
// "Hide value" and every refresh mask them again. No value goes into a log line or a message.
// Refreshes on: the active editor, the config's edits (debounced like the live check), a change of
// `env`, `secretEnv` or `envFile`, a secret, the workspace folders, and the env file on disk.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { readEnvFile } from '../../core/envFileRead';
import { envUsage } from '../../core/envUsage';
import { describeArgsFailure, envFileFor } from '../redpandaConnect/args';
import { isValidEnvName, validateEnvSetting } from '../redpandaConnect/envSetting';
import { declaredSecretNames, secretNameProblem, WINDOW_SCOPE } from '../redpandaConnect/secretEnv';
import { BLOBLANG_DEBOUNCE_MS } from './bloblangDiagnostics';
import type { DetectionRegistry } from './detection';
import {
	type EnvironmentInputs, type EnvironmentModel, environmentModel, type EnvironmentVariable, type EnvSource, type SettingLevel,
} from './environmentModel';
import type { Scope, SecretVariables } from './secrets';

export const ENVIRONMENT_VIEW_ID = 'redpandaConnect.environment';
export const ADD_VARIABLE_COMMAND = 'redpandaConnect.environment.add';
export const EDIT_VARIABLE_COMMAND = 'redpandaConnect.environment.edit';
export const REMOVE_VARIABLE_COMMAND = 'redpandaConnect.environment.remove';
export const SHOW_VALUE_COMMAND = 'redpandaConnect.environment.showValue';
export const HIDE_VALUE_COMMAND = 'redpandaConnect.environment.hideValue';
export const OPEN_ENV_FILE_COMMAND = 'redpandaConnect.environment.openEnvFile';
export const REFRESH_VIEW_COMMAND = 'redpandaConnect.environment.refresh';
/**
 * Sets a missing variable, by name (ticket 32's test panel button calls it too): `(name | item,
 * configUri?)`; resolves with the name a value was set for (a secret's prefilled name can be
 * edited), `undefined` when none was.
 */
export const SET_MISSING_COMMAND = 'redpandaConnect.setMissingVariable';

/** What a masked value shows. */
export const VIEW_MASK = '••••••••';
export const NO_CONFIG_MESSAGE = 'Open a Redpanda Connect config to see its environment variables.';
const ENV_SETTING_KEY = 'redpandaConnect.env';

export const SOURCE_LABELS: Readonly<Record<EnvSource, string>> = {
	setting: 'Settings (redpandaConnect.env)',
	envFile: 'Env file',
	extension: 'Set by the extension',
	secret: 'Secrets',
	process: 'VS Code environment',
};
/** How a row's source is named in its state and its screen-reader label. */
const SOURCE_NAMES: Readonly<Record<EnvSource, string>> = {
	setting: 'redpandaConnect.env',
	envFile: 'the env file',
	extension: 'the extension (every command gets NO_COLOR=1)',
	secret: 'a secret',
	process: "VS Code's environment",
};
const ROW_SOURCE_NAMES: Readonly<Record<EnvSource, string>> = {
	setting: 'setting redpandaConnect.env',
	envFile: 'env file',
	extension: 'set by the extension',
	secret: 'secret',
	process: 'VS Code environment',
};

export type EnvironmentNode =
	| { readonly kind: 'group'; readonly source: EnvSource | 'missing' }
	| { readonly kind: 'variable'; readonly variable: EnvironmentVariable }
	| { readonly kind: 'missing'; readonly name: string }
	| { readonly kind: 'note'; readonly id: string; readonly text: string; readonly warning: boolean };

/** One shown item, flattened (the test seam). */
export interface EnvironmentItem {
	/** The group's source (`missing` for the Missing group); for a group itself, its own. */
	readonly group: EnvSource | 'missing';
	readonly node: EnvironmentNode;
	/** The label as text (without the strikethrough). */
	readonly label: string;
	/** Whether the label is crossed out (an overridden or ignored variable). */
	readonly crossedOut: boolean;
	readonly description: string;
	readonly contextValue: string;
	readonly accessibility: string;
}

/** The prompts and messages (tests replace them). */
export interface EnvironmentUi {
	input(options: vscode.InputBoxOptions): Thenable<string | undefined>;
	/** Plain or secret, for `name` (a new variable when `undefined`). */
	pickKind(name: string | undefined): Thenable<'plain' | 'secret' | undefined>;
	error(message: string): void;
	info(message: string): void;
}

export const defaultEnvironmentUi: EnvironmentUi = {
	input: (options) => vscode.window.showInputBox(options),
	pickKind: async (name) => {
		const items: (vscode.QuickPickItem & { kind_: 'plain' | 'secret' })[] = [
			{ label: 'Plain variable', description: 'in redpandaConnect.env (settings.json, plain text)', kind_: 'plain' },
			{ label: 'Secret variable', description: "in VS Code's secret storage on this machine", kind_: 'secret' },
		];
		const picked = await vscode.window.showQuickPick(items, { title: name ? `Set ${name} as` : 'Add a variable as' });
		return picked?.kind_;
	},
	error: (message) => void vscode.window.showErrorMessage(message),
	info: (message) => void vscode.window.showInformationMessage(message),
};

/** Writes the `redpandaConnect.env` value of one level (tests replace it). */
export type EnvSettingWriter = (config: vscode.WorkspaceConfiguration, value: Record<string, unknown> | undefined, target: vscode.ConfigurationTarget) => Thenable<void>;

const defaultWriter: EnvSettingWriter = (config, value, target) => config.update('env', value, target);

export const SETTING_TARGETS: Readonly<Record<SettingLevel, vscode.ConfigurationTarget>> = {
	user: vscode.ConfigurationTarget.Global,
	workspace: vscode.ConfigurationTarget.Workspace,
	folder: vscode.ConfigurationTarget.WorkspaceFolder,
};

/**
 * Where a new plain variable goes: the folder's settings with more than one workspace folder, the
 * workspace's with one, the user's when the config is in no folder (or none is open).
 */
export function newVariableLevel(folder: Scope, folderCount: number): SettingLevel {
	return !folder || folderCount === 0 ? 'user' : folderCount > 1 ? 'folder' : 'workspace';
}

/**
 * Sets (or, with `undefined`, removes) one key of `redpandaConnect.env` at `level` for `resource`,
 * keeping the level's other keys. Throws what the settings write throws.
 */
export async function writeEnvSettingKey(
	resource: vscode.Uri | undefined, name: string, value: string | undefined, level: SettingLevel, write: EnvSettingWriter = defaultWriter,
): Promise<void> {
	const config = vscode.workspace.getConfiguration('redpandaConnect', resource);
	const inspected = config.inspect<unknown>('env');
	const raw = level === 'user' ? inspected?.globalValue : level === 'workspace' ? inspected?.workspaceValue : inspected?.workspaceFolderValue;
	const next: Record<string, unknown> = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
	if (value === undefined) {
		delete next[name];
	} else {
		next[name] = value;
	}
	await write(config, Object.keys(next).length > 0 ? next : undefined, SETTING_TARGETS[level]);
}

/** `text` crossed out (a combining long stroke after each character). */
function strike(text: string): string {
	return [...text].map((c) => `${c}\u0336`).join('');
}

/** One line of a value for the tree (line breaks shown as `⏎`). */
function oneLine(value: string): string {
	return value.replace(/\r?\n/g, '⏎');
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const keyOf = (v: { readonly source: EnvSource; readonly name: string }) => `${v.source}:${v.name}`;

export interface EnvironmentViewOptions {
	readonly detection: DetectionRegistry;
	readonly secrets: SecretVariables;
	readonly log: (line: string) => void;
	readonly ui?: EnvironmentUi;
	readonly debounceMs?: number;
}

export class EnvironmentView implements vscode.TreeDataProvider<EnvironmentNode>, vscode.Disposable {
	/** The prompts and messages; tests replace them. */
	ui: EnvironmentUi;
	/** The `redpandaConnect.env` write; tests replace it. */
	writeSetting: EnvSettingWriter = defaultWriter;
	private readonly changeEmitter = new vscode.EventEmitter<EnvironmentNode | undefined>();
	private readonly refreshEmitter = new vscode.EventEmitter<void>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private config: vscode.Uri | undefined;
	private cached: EnvironmentModel | undefined;
	private readonly revealed = new Set<string>();
	private timer: NodeJS.Timeout | undefined;
	private watcher: { readonly path: string; readonly disposable: vscode.Disposable } | undefined;
	private treeView: vscode.TreeView<EnvironmentNode> | undefined;
	private readonly debounceMs: number;

	readonly onDidChangeTreeData: vscode.Event<EnvironmentNode | undefined> = this.changeEmitter.event;
	/** Fires after each refresh (the test seam). */
	readonly onDidRefresh: vscode.Event<void> = this.refreshEmitter.event;

	constructor(private readonly options: EnvironmentViewOptions) {
		this.ui = options.ui ?? defaultEnvironmentUi;
		this.debounceMs = options.debounceMs ?? BLOBLANG_DEBOUNCE_MS;
		const affects = (e: vscode.ConfigurationChangeEvent) => ['env', 'secretEnv', 'envFile'].some((k) => e.affectsConfiguration(`redpandaConnect.${k}`));
		this.subscriptions.push(
			this.changeEmitter,
			this.refreshEmitter,
			vscode.window.onDidChangeActiveTextEditor((editor) => this.follow(editor?.document.uri)),
			options.detection.onDidChangeDetection((change) => {
				if (change.detected && vscode.window.activeTextEditor?.document.uri.toString() === change.uri) {
					this.follow(vscode.window.activeTextEditor.document.uri);
				} else if (!change.detected && this.config?.toString() === change.uri) {
					this.config = undefined;
					this.refresh();
				}
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (this.config && e.document.uri.toString() === this.config.toString() && e.contentChanges.length > 0) {
					this.schedule();
				}
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (affects(e)) {
					this.refresh();
				}
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
			options.secrets.onDidChange(() => this.refresh()),
		);
		const active = vscode.window.activeTextEditor?.document.uri;
		if (active && options.detection.isDetected(active)) {
			this.config = active;
			// Watched from the start: no change event may come before the env file changes on disk.
			this.watch(this.model()?.envFilePath);
		}
	}

	/** Creates the tree view and registers the commands. */
	register(): vscode.Disposable[] {
		this.treeView = vscode.window.createTreeView(ENVIRONMENT_VIEW_ID, { treeDataProvider: this });
		this.updateTitle();
		const command = (id: string, run: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, run as (...args: unknown[]) => unknown);
		return [
			this.treeView,
			command(ADD_VARIABLE_COMMAND, () => this.add()),
			command(EDIT_VARIABLE_COMMAND, (node: EnvironmentNode) => this.edit(node)),
			command(REMOVE_VARIABLE_COMMAND, (node: EnvironmentNode) => this.remove(node)),
			command(SHOW_VALUE_COMMAND, (node: EnvironmentNode) => this.setRevealed(node, true)),
			command(HIDE_VALUE_COMMAND, (node: EnvironmentNode) => this.setRevealed(node, false)),
			command(OPEN_ENV_FILE_COMMAND, () => this.openEnvFile()),
			command(REFRESH_VIEW_COMMAND, () => this.refresh()),
			command(SET_MISSING_COMMAND, (arg: EnvironmentNode | string, uri?: vscode.Uri) => this.setMissing(arg, uri)),
		];
	}

	/** The config the view shows, if any. */
	get configUri(): vscode.Uri | undefined {
		return this.config;
	}

	/** The view's message (shown instead of the tree), if any. */
	get message(): string | undefined {
		return this.config ? undefined : NO_CONFIG_MESSAGE;
	}

	/** The model for the config shown (computed on first need after each refresh). */
	model(): EnvironmentModel | undefined {
		if (!this.config) {
			return undefined;
		}
		this.cached ??= this.compute(this.config);
		return this.cached;
	}

	/** Re-reads everything; masks every revealed value again. */
	refresh(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.cached = undefined;
		this.revealed.clear();
		this.updateTitle();
		this.watch(this.config ? this.model()?.envFilePath : undefined);
		this.changeEmitter.fire(undefined);
		this.refreshEmitter.fire();
	}

	/** Every shown item, depth first (the test seam). */
	items(): EnvironmentItem[] {
		const out: EnvironmentItem[] = [];
		const walk = (nodes: readonly EnvironmentNode[], group: EnvSource | 'missing' | undefined) => {
			for (const node of nodes) {
				const g = node.kind === 'group' ? node.source : group!;
				const item = this.getTreeItem(node);
				const label = typeof item.label === 'string' ? item.label : item.label?.label ?? '';
				out.push({
					group: g,
					node,
					label: label.replace(/\u0336/g, ''),
					crossedOut: label.includes('\u0336'),
					description: typeof item.description === 'string' ? item.description : '',
					contextValue: item.contextValue ?? '',
					accessibility: item.accessibilityInformation?.label ?? label,
				});
				walk(this.getChildren(node), g);
			}
		};
		walk(this.getChildren(undefined), undefined);
		return out;
	}

	getChildren(node?: EnvironmentNode): EnvironmentNode[] {
		const model = this.model();
		if (!model) {
			return [];
		}
		if (!node) {
			const groups: EnvironmentNode[] = model.groups.map((g) => ({ kind: 'group', source: g.source }));
			return model.missing.length > 0 ? [{ kind: 'group', source: 'missing' }, ...groups] : groups;
		}
		if (node.kind !== 'group') {
			return [];
		}
		if (node.source === 'missing') {
			return model.missing.map((name) => ({ kind: 'missing', name }));
		}
		const variables = model.groups.find((g) => g.source === node.source)?.variables ?? [];
		const children: EnvironmentNode[] = [];
		if (node.source === 'envFile' && model.envFileNote) {
			children.push({ kind: 'note', id: 'envFile:note', text: model.envFileNote, warning: true });
		}
		children.push(...variables.map((variable): EnvironmentNode => ({ kind: 'variable', variable })));
		if (children.length === 0) {
			children.push({ kind: 'note', id: `${node.source}:none`, text: this.emptyText(node.source, model), warning: false });
		}
		return children;
	}

	getTreeItem(node: EnvironmentNode): vscode.TreeItem {
		switch (node.kind) {
			case 'group':
				return this.groupItem(node.source);
			case 'missing': {
				const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
				item.id = `missing:${node.name}`;
				item.description = 'missing: used by the config, set by no source';
				item.iconPath = new vscode.ThemeIcon('warning');
				item.contextValue = 'missing';
				item.tooltip = `${node.name} is used by the config without a default, and no source sets it.`;
				item.accessibilityInformation = { label: `${node.name}, missing: used by the config and set by no source` };
				return item;
			}
			case 'note': {
				const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
				item.id = node.id;
				item.iconPath = new vscode.ThemeIcon(node.warning ? 'warning' : 'info');
				item.tooltip = node.text;
				item.contextValue = 'note';
				item.accessibilityInformation = { label: node.text };
				return item;
			}
			case 'variable':
				return this.variableItem(node.variable);
		}
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.watcher?.disposable.dispose();
		this.subscriptions.forEach((s) => s.dispose());
	}

	// --- items ---

	private groupItem(source: EnvSource | 'missing'): vscode.TreeItem {
		const model = this.model();
		if (source === 'missing') {
			const count = model?.missing.length ?? 0;
			const item = new vscode.TreeItem('Missing', vscode.TreeItemCollapsibleState.Expanded);
			item.id = 'group:missing';
			item.description = `${count}`;
			item.iconPath = new vscode.ThemeIcon('warning');
			item.contextValue = 'group group-missing';
			item.accessibilityInformation = { label: `Missing: ${count} variable(s) the config uses that no source sets` };
			return item;
		}
		const count = model?.groups.find((g) => g.source === source)?.variables.length ?? 0;
		const item = new vscode.TreeItem(SOURCE_LABELS[source], vscode.TreeItemCollapsibleState.Expanded);
		item.id = `group:${source}`;
		const file = source === 'envFile' ? model?.envFilePath : undefined;
		item.description = file ? path.basename(file) : `${count}`;
		item.tooltip = file ?? SOURCE_LABELS[source];
		item.contextValue = `group group-${source}${file ? ' envFileSet' : ''}`;
		const problem = source === 'envFile' && model?.envFileNote ? `, ${model.envFileNote}` : '';
		item.accessibilityInformation = { label: `${SOURCE_LABELS[source]}${file ? `, ${file}` : ''}: ${count} variable(s)${problem}` };
		return item;
	}

	private variableItem(v: EnvironmentVariable): vscode.TreeItem {
		const masks = v.source !== 'setting' && v.source !== 'extension';
		const revealed = this.revealed.has(keyOf(v));
		const masked = masks && v.value !== undefined && !revealed;
		const shown = v.value === undefined ? 'no value' : masked ? VIEW_MASK : JSON.stringify(oneLine(v.value)).slice(1, -1) || '(empty)';
		const state = this.stateText(v);
		const crossed = v.state === 'overridden' || v.state === 'ignored';
		const item = new vscode.TreeItem(crossed ? strike(v.name) : v.name, vscode.TreeItemCollapsibleState.None);
		item.id = `var:${keyOf(v)}`;
		const where = v.level ? ` · ${v.level}` : v.line !== undefined ? ` · line ${v.line}` : '';
		item.description = `${shown} · ${state}${where}${v.referenced ? ' · in config' : ''}`;
		item.iconPath = new vscode.ThemeIcon(
			v.state === 'used' ? (v.source === 'secret' ? 'lock' : 'pass')
				: v.state === 'overridden' ? 'circle-slash'
					: v.state === 'ignored' ? 'error' : 'circle-large-outline',
		);
		item.tooltip = `${v.name} (${ROW_SOURCE_NAMES[v.source]}${v.level ? `, ${v.level} settings` : ''}): ${state}.${v.referenced ? ' The config uses it.' : ''}`;
		const tokens = ['variable', v.source === 'setting' ? 'plain' : v.source];
		if (v.source === 'secret' && v.value !== undefined) {
			tokens.push('hasValue');
		}
		if (masks && v.value !== undefined) {
			tokens.push(revealed ? 'revealed' : 'masked');
		}
		item.contextValue = tokens.join(' ');
		const valueText = v.value === undefined ? 'no value' : masked ? 'value masked' : `value ${shown}`;
		item.accessibilityInformation = {
			label: `${v.name}, ${ROW_SOURCE_NAMES[v.source]}, ${state}${v.referenced ? ', used by the config' : ''}, ${valueText}`,
		};
		return item;
	}

	private stateText(v: EnvironmentVariable): string {
		switch (v.state) {
			case 'used':
				return 'used';
			case 'overridden':
				return `overridden by ${SOURCE_NAMES[v.overriddenBy!]}`;
			case 'ignored':
				return 'not used: the binary rejects the file';
			case 'noValue':
				return v.overriddenBy ? `no value here, set by ${SOURCE_NAMES[v.overriddenBy]}` : 'no value on this machine';
		}
	}

	private emptyText(source: EnvSource, model: EnvironmentModel): string {
		switch (source) {
			case 'setting':
				return 'No variable is set in redpandaConnect.env.';
			case 'envFile':
				return model.envFilePath ? 'The file sets no variable.' : 'No env file is set (redpandaConnect.envFile).';
			case 'secret':
				return 'No secret variable is declared (redpandaConnect.secretEnv).';
			case 'process':
				return 'None of the config\'s variables is in VS Code\'s environment.';
			case 'extension':
				return 'None.';
		}
	}

	private updateTitle(): void {
		if (this.treeView) {
			this.treeView.message = this.message;
			this.treeView.description = this.config ? path.basename(this.config.fsPath) : undefined;
		}
	}

	// --- reading ---

	private compute(uri: vscode.Uri): EnvironmentModel {
		const config = vscode.workspace.getConfiguration('redpandaConnect', uri);
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		const inspected = config.inspect<unknown>('env');
		const has = (raw: unknown, name: string) => raw !== null && typeof raw === 'object' && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, name);
		const setting = validateEnvSetting(config.get<unknown>('env', {})).variables.map(([name, value]) => ({
			name,
			value,
			level: (has(inspected?.workspaceFolderValue, name) ? 'folder' : has(inspected?.workspaceValue, name) ? 'workspace' : 'user') as SettingLevel,
		}));
		const scope = folder ? folder.uri.toString() : WINDOW_SCOPE;
		const secrets = declaredSecretNames(config.get<unknown>('secretEnv', [])).names
			.map((name) => ({ name, value: this.options.secrets.values.get(scope, name) }));
		const resolved = envFileFor(uri);
		let envFile: EnvironmentInputs['envFile'];
		let envFileUnusable: string | undefined;
		if (resolved.kind === 'ok') {
			if (resolved.path) {
				try {
					envFile = { path: resolved.path, read: readEnvFile(fs.readFileSync(resolved.path, 'utf8')) };
				} catch (err) {
					envFile = { path: resolved.path, read: { error: (err as NodeJS.ErrnoException).code ?? reasonOf(err) } };
				}
			}
		} else {
			envFileUnusable = describeArgsFailure(resolved);
		}
		return environmentModel({
			setting,
			secrets,
			envFile,
			envFileUnusable,
			processEnv: process.env,
			usage: envUsage(this.textOf(uri)),
		});
	}

	private textOf(uri: vscode.Uri): string {
		const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
		if (open) {
			return open.getText();
		}
		try {
			return uri.scheme === 'file' ? fs.readFileSync(uri.fsPath, 'utf8') : '';
		} catch {
			return '';
		}
	}

	/** Follows the active editor: a detected config becomes the one shown. */
	private follow(uri: vscode.Uri | undefined): void {
		if (!uri || !this.options.detection.isDetected(uri) || uri.toString() === this.config?.toString()) {
			return;
		}
		this.config = uri;
		this.refresh();
	}

	private schedule(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.refresh();
		}, this.debounceMs);
	}

	/** Watches the env file on disk (`undefined`: none). */
	private watch(file: string | undefined): void {
		if (this.watcher?.path === file) {
			return;
		}
		this.watcher?.disposable.dispose();
		this.watcher = undefined;
		if (!file) {
			return;
		}
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
		const changed = () => this.refresh();
		this.watcher = {
			path: file,
			disposable: vscode.Disposable.from(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed)),
		};
	}

	// --- actions ---

	private target(uri?: vscode.Uri): { readonly uri: vscode.Uri; readonly folder: Scope } | undefined {
		const at = uri ?? this.config;
		if (!at) {
			this.ui.error('Open a Redpanda Connect config first: the variables are set for its folder.');
			return undefined;
		}
		return { uri: at, folder: vscode.workspace.getWorkspaceFolder(at) };
	}

	private async writePlain(uri: vscode.Uri, name: string, value: string | undefined, level: SettingLevel): Promise<boolean> {
		try {
			await writeEnvSettingKey(uri, name, value, level, this.writeSetting);
			return true;
		} catch (err) {
			const reason = value ? reasonOf(err).split(value).join('…') : reasonOf(err);
			this.options.log(`${ENV_SETTING_KEY}: could not ${value === undefined ? 'remove' : 'set'} ${name} in the ${level} settings: ${reason}`);
			this.ui.error(`Could not ${value === undefined ? 'remove' : 'set'} ${name} in ${ENV_SETTING_KEY} (${level} settings): ${reason}`);
			return false;
		} finally {
			this.refresh();
		}
	}

	private askValue(name: string, current?: string): Thenable<string | undefined> {
		return this.ui.input({
			title: `Value of ${name}`,
			prompt: `Saved in ${ENV_SETTING_KEY}, in plain text in settings.json.`,
			...(current !== undefined ? { value: current } : {}),
			ignoreFocusOut: true,
		});
	}

	/** The name set, `undefined` when nothing was. */
	private async setPlain(at: { readonly uri: vscode.Uri; readonly folder: Scope }, name: string): Promise<string | undefined> {
		const value = await this.askValue(name);
		if (value === undefined) {
			return undefined;
		}
		return await this.writePlain(at.uri, name, value, newVariableLevel(at.folder, vscode.workspace.workspaceFolders?.length ?? 0)) ? name : undefined;
	}

	/** The name set (the prefilled one can be edited), `undefined` when nothing was. */
	private async setSecret(at: { readonly uri: vscode.Uri; readonly folder: Scope }, name: string | undefined): Promise<string | undefined> {
		const set = await this.options.secrets.setCommand({ folder: at.folder, ...(name !== undefined ? { name } : {}) }, (o) => this.ui.input(o));
		this.refresh();
		return set;
	}

	/** "Add variable": plain or secret, then the name and the value. */
	async add(): Promise<boolean> {
		const at = this.target();
		if (!at) {
			return false;
		}
		const kind = await this.ui.pickKind(undefined);
		if (kind === 'secret') {
			return (await this.setSecret(at, undefined)) !== undefined;
		}
		if (kind !== 'plain') {
			return false;
		}
		const name = await this.ui.input({
			title: 'Add a plain variable',
			prompt: 'The variable name, as ${NAME} reads it.',
			placeHolder: 'TOPIC',
			ignoreFocusOut: true,
			validateInput: (text) => (isValidEnvName(text.trim()) ? undefined : 'A name must match [A-Za-z_][A-Za-z0-9_]*.'),
		});
		if (name === undefined || !isValidEnvName(name.trim())) {
			return false;
		}
		return (await this.setPlain(at, name.trim())) !== undefined;
	}

	/**
	 * Sets a missing variable: plain or secret, then its value (a secret's name is prefilled). The
	 * name a value was set for, `undefined` when none was.
	 */
	async setMissing(arg: EnvironmentNode | string | undefined, uri?: vscode.Uri): Promise<string | undefined> {
		const name = typeof arg === 'string' ? arg : arg?.kind === 'missing' ? arg.name : undefined;
		if (name === undefined || secretNameProblem(name)) {
			this.ui.error('Set a missing variable: no valid variable name was given.');
			return undefined;
		}
		const at = this.target(uri);
		if (!at) {
			return undefined;
		}
		const kind = await this.ui.pickKind(name);
		return kind === 'plain' ? this.setPlain(at, name) : kind === 'secret' ? this.setSecret(at, name) : undefined;
	}

	/** Edits a plain variable's value at its level, or sets a secret's value. */
	async edit(node: EnvironmentNode | undefined): Promise<boolean> {
		const v = node?.kind === 'variable' ? node.variable : undefined;
		const at = this.target();
		if (!v || !at || (v.source !== 'setting' && v.source !== 'secret')) {
			return false;
		}
		if (v.source === 'setting') {
			const value = await this.askValue(v.name, v.value);
			return value === undefined ? false : this.writePlain(at.uri, v.name, value, v.level ?? 'user');
		}
		const value = await this.ui.input({
			title: `Value of the secret variable ${v.name}`,
			prompt: 'Kept in the secret storage on this machine, never in a settings file.',
			password: true,
			ignoreFocusOut: true,
		});
		if (value === undefined) {
			return false;
		}
		const ok = await this.options.secrets.setAndTell(at.folder, v.name, value);
		this.refresh();
		return ok;
	}

	/** Removes a plain variable from its level, or a secret's value (its name stays declared). */
	async remove(node: EnvironmentNode | undefined): Promise<boolean> {
		const v = node?.kind === 'variable' ? node.variable : undefined;
		const at = this.target();
		if (!v || !at) {
			return false;
		}
		if (v.source === 'setting') {
			return this.writePlain(at.uri, v.name, undefined, v.level ?? 'user');
		}
		if (v.source !== 'secret') {
			return false;
		}
		const ok = await this.options.secrets.remove(at.folder, v.name);
		if (ok) {
			this.ui.info(`Secret variable ${v.name} is removed; the name stays in redpandaConnect.secretEnv.`);
		}
		this.refresh();
		return ok;
	}

	/** "Show value" / "Hide value" for one row. */
	setRevealed(node: EnvironmentNode | undefined, revealed: boolean): void {
		if (node?.kind !== 'variable') {
			return;
		}
		const key = keyOf(node.variable);
		if (revealed) {
			this.revealed.add(key);
		} else {
			this.revealed.delete(key);
		}
		// The whole tree: its nodes are rebuilt on each read, so this one is not the shown object.
		this.changeEmitter.fire(undefined);
	}

	/** Opens the env file in an editor. */
	async openEnvFile(): Promise<boolean> {
		const file = this.model()?.envFilePath;
		if (!file) {
			this.ui.info('No env file is set for this config (redpandaConnect.envFile).');
			return false;
		}
		try {
			await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
			return true;
		} catch (err) {
			this.ui.error(`Could not open the env file ${file}: ${reasonOf(err)}`);
			return false;
		}
	}
}
