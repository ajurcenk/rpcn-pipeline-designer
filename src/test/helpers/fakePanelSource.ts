// A fake of the VS Code API the graph and Bloblang test panel registries reach (story 55), for
// their unit tests: workspace and window events the test fires, tab groups and editors it sets,
// and webview panels that record what the registry does to them. `vscode.Uri`, `ViewColumn` and
// `TabInputText` come from the real module (unit tests run in the extension host).

import * as vscode from 'vscode';
import type { BloblangPanelsSource } from '../../adapters/bloblangPanel/panels';
import type { GraphPanelsSource } from '../../adapters/graphPanel/panels';

/** `base` with a live getter per entry of `getters`: what the real API reads each time is read each time. */
function live<T extends object, G extends Record<string, () => unknown>>(base: T, getters: G): T & { readonly [K in keyof G]: ReturnType<G[K]> } {
	for (const [name, get] of Object.entries(getters)) {
		Object.defineProperty(base, name, { get, enumerable: true });
	}
	return base as T & { readonly [K in keyof G]: ReturnType<G[K]> };
}

/** A webview that records what is posted to it and never posts anything itself. */
export class FakeWebview implements vscode.Webview {
	html = '';
	options: vscode.WebviewOptions = {};
	readonly cspSource = 'fake-csp';
	readonly posted: unknown[] = [];
	private readonly received = new vscode.EventEmitter<unknown>();
	readonly onDidReceiveMessage = this.received.event;

	postMessage(message: unknown): Thenable<boolean> {
		this.posted.push(message);
		return Promise.resolve(true);
	}

	asWebviewUri(uri: vscode.Uri): vscode.Uri {
		return uri;
	}

	dispose(): void {
		this.received.dispose();
	}
}

/** A webview panel that records its reveals and fires `onDidDispose` once, on its first `dispose`. */
export class FakeWebviewPanel implements vscode.WebviewPanel {
	readonly webview = new FakeWebview();
	readonly options: vscode.WebviewPanelOptions = {};
	iconPath: vscode.WebviewPanel['iconPath'];
	active = false;
	visible = true;
	viewColumn: vscode.ViewColumn | undefined;
	/** The `reveal` calls, in order. */
	readonly reveals: { readonly column: vscode.ViewColumn | undefined; readonly preserveFocus: boolean | undefined }[] = [];
	disposed = false;
	private readonly disposeEmitter = new vscode.EventEmitter<void>();
	private readonly viewStateEmitter = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
	readonly onDidDispose = this.disposeEmitter.event;
	readonly onDidChangeViewState = this.viewStateEmitter.event;

	constructor(readonly viewType: string, public title: string, column: vscode.ViewColumn) {
		this.viewColumn = column;
	}

	reveal(column?: vscode.ViewColumn, preserveFocus?: boolean): void {
		this.reveals.push({ column, preserveFocus });
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.disposeEmitter.fire();
		this.disposeEmitter.dispose();
		this.viewStateEmitter.dispose();
		this.webview.dispose();
	}
}

/** A tab group the test fills with text tabs. */
export class FakeTabGroup implements vscode.TabGroup {
	/** Set by `FakeTabGroups`: only its first group starts active. */
	isActive = false;
	activeTab: vscode.Tab | undefined;
	readonly tabs: vscode.Tab[] = [];

	constructor(readonly viewColumn: vscode.ViewColumn) {}

	/** Adds a text tab of `uri` (the active one) and returns it. */
	addText(uri: vscode.Uri): vscode.Tab {
		const tab: vscode.Tab = {
			label: uri.path.split('/').pop() ?? '',
			group: this,
			input: new vscode.TabInputText(uri),
			isActive: true,
			isDirty: false,
			isPinned: false,
			isPreview: false,
		};
		this.tabs.push(tab);
		this.activeTab = tab;
		return tab;
	}

	/** Removes `tab`. */
	remove(tab: vscode.Tab): void {
		const index = this.tabs.indexOf(tab);
		if (index < 0) {
			return;
		}
		this.tabs.splice(index, 1);
		if (this.activeTab === tab) {
			this.activeTab = this.tabs[this.tabs.length - 1];
		}
	}
}

/** The fake's `tabGroups`: one group in column One unless the test adds more. */
export class FakeTabGroups implements vscode.TabGroups {
	readonly all: FakeTabGroup[] = [new FakeTabGroup(vscode.ViewColumn.One)];

	constructor() {
		this.all[0].isActive = true;
	}
	readonly tabsEmitter = new vscode.EventEmitter<vscode.TabChangeEvent>();
	readonly groupsEmitter = new vscode.EventEmitter<vscode.TabGroupChangeEvent>();
	readonly onDidChangeTabs = this.tabsEmitter.event;
	readonly onDidChangeTabGroups = this.groupsEmitter.event;

	get activeTabGroup(): FakeTabGroup {
		return this.all.find((g) => g.isActive) ?? this.all[0];
	}

	close(): Thenable<boolean> {
		return Promise.resolve(false);
	}
}

/** A minimal open text document of `uri` and `text`: what the registries read of one. */
export function fakeDocument(uri: vscode.Uri, text = ''): vscode.TextDocument {
	return { uri, version: 1, isDirty: false, isUntitled: uri.scheme === 'untitled', languageId: 'yaml', getText: () => text } as unknown as vscode.TextDocument;
}

/** A visible text editor of `document` in `column`. */
export function fakeEditor(document: vscode.TextDocument, column: vscode.ViewColumn = vscode.ViewColumn.One): vscode.TextEditor {
	return { document, viewColumn: column, selection: new vscode.Selection(0, 0, 0, 0), selections: [], visibleRanges: [] } as unknown as vscode.TextEditor;
}

/** What the fake's parts must be: both registries' slices at once, so a member added to a Source is missed here. */
type FakeWorkspace = GraphPanelsSource['workspace'] & BloblangPanelsSource['workspace'];
type FakeWindow = GraphPanelsSource['window'] & BloblangPanelsSource['window'];
type FakeCommands = GraphPanelsSource['commands'] & BloblangPanelsSource['commands'];

/** The fake API: both registries' Sources, with the events, state and records a test drives and reads. */
export class FakePanelSource {
	private readonly emitters: vscode.Disposable[] = [];
	private emitter<T>(): vscode.EventEmitter<T> {
		const e = new vscode.EventEmitter<T>();
		this.emitters.push(e);
		return e;
	}

	readonly changeText = this.emitter<vscode.TextDocumentChangeEvent>();
	readonly saveText = this.emitter<vscode.TextDocument>();
	readonly openText = this.emitter<vscode.TextDocument>();
	readonly closeText = this.emitter<vscode.TextDocument>();
	readonly createFiles = this.emitter<vscode.FileCreateEvent>();
	readonly willRename = this.emitter<vscode.FileWillRenameEvent>();
	readonly didRename = this.emitter<vscode.FileRenameEvent>();
	readonly selection = this.emitter<vscode.TextEditorSelectionChangeEvent>();
	readonly activeEditor = this.emitter<vscode.TextEditor | undefined>();
	readonly visibleEditors = this.emitter<readonly vscode.TextEditor[]>();

	readonly tabGroups = new FakeTabGroups();
	textDocuments: vscode.TextDocument[] = [];
	visibleTextEditors: vscode.TextEditor[] = [];
	activeTextEditor: vscode.TextEditor | undefined;
	/** The panels `createWebviewPanel` made, in order. */
	readonly created: FakeWebviewPanel[] = [];
	/** The commands `executeCommand` ran, with their arguments. */
	readonly commands: { readonly command: string; readonly args: readonly unknown[] }[] = [];
	/** The `fs.stat` answer: a file for the URIs in it, else the call fails. */
	readonly files = new Set<string>();

	readonly workspace = live({
		onDidChangeTextDocument: this.changeText.event,
		onDidSaveTextDocument: this.saveText.event,
		onDidOpenTextDocument: this.openText.event,
		onDidCloseTextDocument: this.closeText.event,
		onDidCreateFiles: this.createFiles.event,
		onWillRenameFiles: this.willRename.event,
		onDidRenameFiles: this.didRename.event,
		openTextDocument: (uri?: unknown) => {
			const doc = uri instanceof vscode.Uri ? this.textDocuments.find((d) => d.uri.toString() === uri.toString()) : undefined;
			return doc ? Promise.resolve(doc) : Promise.reject(new Error(`no document ${String(uri)}`));
		},
		applyEdit: () => Promise.resolve(false),
		getWorkspaceFolder: () => undefined,
		fs: {
			stat: (uri: vscode.Uri) => (this.files.has(uri.toString())
				? Promise.resolve({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 })
				: Promise.reject(vscode.FileSystemError.FileNotFound(uri))),
		},
	} satisfies Omit<FakeWorkspace, 'textDocuments'>, { textDocuments: (): readonly vscode.TextDocument[] => this.textDocuments }) satisfies FakeWorkspace;

	readonly window = live({
		onDidChangeTextEditorSelection: this.selection.event,
		onDidChangeActiveTextEditor: this.activeEditor.event,
		onDidChangeVisibleTextEditors: this.visibleEditors.event,
		tabGroups: this.tabGroups,
		createWebviewPanel: (viewType: string, title: string, show: vscode.ViewColumn | { readonly viewColumn: vscode.ViewColumn }) => {
			const column = typeof show === 'object' ? show.viewColumn : show;
			const panel = new FakeWebviewPanel(viewType, title, column);
			this.created.push(panel);
			return panel;
		},
		showTextDocument: (document: vscode.TextDocument | vscode.Uri, options?: vscode.ViewColumn | vscode.TextDocumentShowOptions) => {
			const doc = document instanceof vscode.Uri ? this.textDocuments.find((d) => d.uri.toString() === document.toString()) : document;
			if (!doc) {
				return Promise.reject(new Error(`no document ${document.toString()}`));
			}
			return Promise.resolve(fakeEditor(doc, typeof options === 'object' ? options.viewColumn : options));
		},
	} satisfies Omit<FakeWindow, 'visibleTextEditors' | 'activeTextEditor'>, {
		visibleTextEditors: (): readonly vscode.TextEditor[] => this.visibleTextEditors,
		activeTextEditor: (): vscode.TextEditor | undefined => this.activeTextEditor,
	}) satisfies FakeWindow;

	readonly commandsApi = {
		executeCommand: <T>(command: string, ...args: unknown[]): Thenable<T> => {
			this.commands.push({ command, args });
			return Promise.resolve(undefined as T);
		},
	} satisfies FakeCommands;

	/** The fake as the graph registry's Source. */
	get graph(): GraphPanelsSource {
		return { workspace: this.workspace, window: this.window, commands: this.commandsApi };
	}

	/** The fake as the Bloblang registry's Source. */
	get bloblang(): BloblangPanelsSource {
		return { workspace: this.workspace, window: this.window, commands: this.commandsApi };
	}

	/** Announces and reports the rename of `from` to `to`, as VS Code does (will, then did). */
	async rename(from: vscode.Uri, to: vscode.Uri): Promise<void> {
		const files = [{ oldUri: from, newUri: to }];
		const waits: Thenable<unknown>[] = [];
		this.willRename.fire({ files, waitUntil: (t: Thenable<unknown>) => waits.push(t), token: new vscode.CancellationTokenSource().token });
		await Promise.all(waits);
		this.didRename.fire({ files });
	}

	/** Fires a tab change that closed `closed`. */
	tabsClosed(closed: readonly vscode.Tab[]): void {
		this.tabGroups.tabsEmitter.fire({ opened: [], closed, changed: [] });
	}

	dispose(): void {
		this.emitters.forEach((e) => e.dispose());
		this.tabGroups.tabsEmitter.dispose();
		this.tabGroups.groupsEmitter.dispose();
	}
}
