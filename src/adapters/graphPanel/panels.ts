// The graph panel registry (tickets 3.1, 3.6, AD-1, AD-6): one WebviewPanel per file, beside the
// editor, keyed by `uri.toString()`. The webview posts `ready` (again whenever it is recreated,
// since `retainContextWhenHidden` is off) and gets a fresh `snapshot`. On every change to a file
// with an open panel the host sends the complete `model`, or, while the YAML does not parse, only
// `parseError`; the webview keeps the last valid graph under a banner. The snapshot carries the
// panel's last valid model (or `null`) and the current `parseError`. Navigation (ticket 3.7, AD-8):
// the host tracks each file's driving editor (the text editor for it the user last moved the cursor
// in or focused, from the editor objects the events carry; never `window.activeTextEditor`, which
// 1.100 leaves `undefined` or wrong while a webview has focus). A `nodeActivated` (click or
// keyboard) selects that node's YAML range in the driving editor and reveals it centred, and
// `bannerClicked` selects the parse error the same way. On every cursor move in a driving editor
// and after every model, the host sends `selection` with `nodeAt` of the cursor, only when it
// changed, and none while the YAML does not parse; it never moves the cursor or reveals the panel
// for a `selection`. Nothing edits the text (AD-19). The model is built with the ComponentCatalog
// of the current schema (AD-20, ticket 3.3), derived once per schema object. Node status (ticket 3.8, AD-17): each panel's NodeStatusService part maps the
// file's diagnostics (`LintDiagnostics.diagnosticsFor`: Red Hat's plus the deduplicated lint ones)
// to nodes with `nodeStatusOf` (through `nodeAt` only) and sends `nodeStatus` after every model and
// whenever those diagnostics change, only when the mapped status changed; while the YAML does not
// parse the status is frozen (nothing is sent, the snapshot carries the last one) and the next
// valid model recomputes it. Host status and empty states (ticket 3.9, AD-9, AD-20): the snapshot
// carries the real `hostStatus {binary, schema}`, and each panel gets a `hostStatus` whenever it
// changes. With no schema (the binary is not `ok`, the schema is loading, or generation failed)
// the host sends no model: `model: null` in the snapshot and no `model` messages, and no parse
// error either (the webview drops both on a `hostStatus` without a schema, so a banner never
// outlives the YAML it reports). When a schema arrives, each open panel gets `hostStatus`, then the
// model, the selection and the node status (or the parse error), with no `ready` needed. The webview's Install guide, Set path and
// Retry buttons post intents that run the binary warning's own actions (`BinaryActions`).
// Keyboard (ticket 3.11): Esc on the graph container posts `focusEditorRequested`, which focuses the
// file's driving editor without touching its cursor or selection; with no editor, nothing happens.

import * as path from 'path';
import * as vscode from 'vscode';
import type { BinaryActions } from '../redpandaConnect/notify';
import type { DetectionRegistry } from '../vscode/detection';
import type { LintDiagnostics } from '../vscode/diagnostics';
import { GraphPanel, type GraphPanelHandle } from './graphPanel';
import { graphHtml } from './html';
import { catalogueOf, hostStatusOf, type GraphBinary, type GraphSchema } from './status';
import { hasTextTab, isTextTabOf, openDocument, renamedKey, until, within, type Rename } from './tabs';

export { MAX_POSTED, type GraphPanelHandle } from './graphPanel';
export { hostStatusOf, statusDiagnostics, type GraphBinary, type GraphSchema } from './status';
export { renamedKey, type Rename } from './tabs';

export const SHOW_GRAPH_COMMAND = 'redpandaConnect.showGraph';
export const HIDE_GRAPH_COMMAND = 'redpandaConnect.hideGraph';
/** `fsPath`s of files with an open graph panel, for the editor-title toggle (`resourcePath in …`). */
export const GRAPH_OPEN_PATHS_KEY = 'redpandaConnect.graphOpenPaths';
/** The `workspaceState` key of the hidden files (`uri.toString()`s): Hide graph, until Show graph. */
export const HIDDEN_GRAPHS_STATE = 'redpandaConnect.hiddenGraphs';
/** How long the lock sequence waits for the panel's group to become active before it skips the lock. */
const LOCK_WAIT_MS = 1_000;
export const GRAPH_VIEW_TYPE = 'redpandaConnect.graph';

/** The tab title of a file's graph panel. */
export function graphTitle(uri: vscode.Uri): string {
	return `Graph: ${path.posix.basename(uri.path)}`;
}

/** What the graph needs of the file's diagnostics (AD-17): the deduplicated set and its change event. */
export type GraphDiagnostics = Pick<LintDiagnostics, 'diagnosticsFor' | 'onDidChangeDiagnostics'>;

export interface GraphPanelsOptions {
	readonly extensionUri: vscode.Uri;
	readonly log: (line: string) => void;
	/** The binary state and its changes (AD-9): `RedpandaConnect` in production. */
	readonly binary: GraphBinary;
	/** The current transformed schema (AD-10) and its changes: `SchemaStore` in production. */
	readonly schema: GraphSchema;
	/** The files' diagnostics for node status (AD-17): `LintDiagnostics` in production. */
	readonly diagnostics: GraphDiagnostics;
	/**
	 * The binary warning's actions, run by the empty state's buttons (AD-9): `RedpandaConnect.actions`
	 * in production. `undefined`: the buttons do nothing.
	 */
	readonly actions: BinaryActions | undefined;
	/**
	 * Which files are Redpanda Connect configs (AD-18), for auto-open; Show graph marks its file.
	 * `DetectionRegistry` in production. `undefined`: nothing auto-opens and nothing is marked.
	 */
	readonly detection?: GraphDetection;
	/** Where the per-file Hide is kept (`workspaceState` in production). `undefined`: kept in memory only. */
	readonly memento?: vscode.Memento;
	/** Reads `redpandaConnect.autoOpenGraph`. `undefined`: nothing auto-opens. */
	readonly autoOpen?: () => boolean;
	/** Sets a context key (`setContext`); `undefined`: VS Code's `setContext` command. */
	readonly setContext?: (key: string, value: unknown) => void;
}

/** What the graph needs of detection (ticket 3.10). */
export type GraphDetection = Pick<DetectionRegistry, 'isDetected' | 'markDetected'>;

/**
 * All open graph panels, one per file (AD-1). Ticket 3.10 (AD-18, spike 3.14): the first time a
 * visible text editor shows a file in the session (editors visible at activation included), its
 * graph opens beside it when the file is detected, `autoOpen` is on, the file is not hidden and
 * not untitled. Every new panel goes into the column of an open graph panel, else into an empty
 * group beside the YAML (a group a reload left locked), else beside the YAML; its group is locked
 * and focus goes back to the YAML editor (best effort, logged). Hide graph closes the panel and
 * stores a per-file Hide in the memento, which suppresses auto-open until Show graph clears it;
 * closing the panel by its own × is not a Hide. Closing the file's last text tab closes its
 * graph. A rename re-keys the panel, its title, the driving editor, the Hide and the session memory.
 */
export class GraphPanels implements vscode.Disposable {
	private readonly panels = new Map<string, GraphPanel>();
	/**
	 * Each file's driving editor (AD-1, AD-8): the text editor for it the user last moved the
	 * cursor in or focused, by `uri.toString()`, tracked for every file so that a panel opened
	 * later has one. Entries whose editor is no longer visible are dropped.
	 */
	private readonly driving = new Map<string, vscode.TextEditor>();
	/** The text editor last focused (from `onDidChangeActiveTextEditor`), for any file. */
	private focused: vscode.TextEditor | undefined;
	/** Files a visible text editor has shown in this session (`uri.toString()`): auto-open is once. */
	private readonly seen = new Set<string>();
	/** Hidden files (`uri.toString()`), read from the memento once and written on every change. */
	private readonly hidden: Set<string>;
	/** Renames announced by `onWillRenameFiles` and not done yet: their files' tabs closing is no close. */
	private pendingRenames: Rename[] = [];
	/** Panel creations (and their lock sequences) run one at a time: the lock acts on the active group. */
	private queue: Promise<unknown> = Promise.resolve();
	private disposed = false;
	private readonly subscriptions: vscode.Disposable[];

	constructor(private readonly options: GraphPanelsOptions) {
		const stored = options.memento?.get<unknown>(HIDDEN_GRAPHS_STATE);
		this.hidden = new Set(Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : []);
		// One subscription per event for all panels: an event goes to the panel of its file, if one
		// is open (OTHER_DOC, OTHER_FILE, CLOSED). Events with no content change (dirty state, save)
		// send nothing.
		this.subscriptions = [
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (e.contentChanges.length > 0) {
					void this.panels.get(e.document.uri.toString())?.changed(e.document);
				}
			}),
			// The editor objects these events carry, never `window.activeTextEditor` (spike 3.14).
			// A selection change with no kind is VS Code's own (the text moved, or a programmatic
			// set): it makes its editor the driving one only when that editor has focus, so a
			// second split editor whose cursor shifts with an edit does not take over.
			vscode.window.onDidChangeTextEditorSelection((e) => {
				if (e.kind !== undefined || e.textEditor === this.focused) {
					this.drive(e.textEditor);
				} else {
					this.follow(e.textEditor);
				}
			}),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor) {
					this.focused = editor;
					this.drive(editor);
				}
			}),
			// Node status (AD-17): only files with a panel.
			options.diagnostics.onDidChangeDiagnostics((uri) => {
				void this.panels.get(uri.toString())?.diagnosticsChanged();
			}),
			// Host status (ticket 3.9): every panel. A binary change to `ok` starts a generation (the
			// schema store subscribed first); the panels hear again once it settles, also when it
			// produced no schema (which fires no schema change).
			options.binary.onDidChange(() => {
				this.hostChanged();
				if (options.schema.loading) {
					void options.schema.settled().then(() => this.hostChanged(), () => this.hostChanged());
				}
			}),
			options.schema.onDidChange(() => this.hostChanged()),
			vscode.window.onDidChangeVisibleTextEditors((visible) => {
				for (const [key, editor] of [...this.driving]) {
					if (!visible.includes(editor)) {
						this.driving.delete(key);
					}
				}
				this.shown(visible);
			}),
			// TAB_CLOSE: whatever the event calls it (a close, a preview tab replaced), a panel whose
			// file had a text tab and has none left closes.
			vscode.window.tabGroups.onDidChangeTabs(() => this.tabsChanged()),
			vscode.workspace.onWillRenameFiles((e) => {
				this.pendingRenames.push(...e.files.map((f) => ({ from: f.oldUri.toString(), to: f.newUri.toString() })));
			}),
			vscode.workspace.onDidRenameFiles((e) => this.renamed(e.files)),
		];
		this.shown(vscode.window.visibleTextEditors);
		this.updateContext();
	}

	/** Every open panel hears that the binary state or the schema changed. */
	private hostChanged(): void {
		for (const graph of this.panels.values()) {
			void graph.hostChanged();
		}
	}

	/**
	 * `editor` becomes its file's driving editor, and that file's panel follows its cursor. An
	 * editor with no column (a diff side) is never a driving editor: a reveal could not target it.
	 */
	private drive(editor: vscode.TextEditor): void {
		if (editor.viewColumn === undefined) {
			return;
		}
		this.driving.set(editor.document.uri.toString(), editor);
		this.follow(editor);
	}

	/** The panel of `editor`'s file follows its cursor, if `editor` is the one navigation uses. */
	private follow(editor: vscode.TextEditor): void {
		const key = editor.document.uri.toString();
		if (this.editorFor(key) === editor) {
			void this.panels.get(key)?.cursorMoved(editor.document);
		}
	}

	/**
	 * The text editor navigation uses for a file: its driving editor while it is visible, else a
	 * visible editor for the file (DRIVING_CLOSED), else `undefined`. Editors with no column are
	 * skipped.
	 */
	private editorFor(key: string): vscode.TextEditor | undefined {
		const visible = vscode.window.visibleTextEditors.filter((e) => e.viewColumn !== undefined);
		const driving = this.driving.get(key);
		if (driving && visible.includes(driving)) {
			return driving;
		}
		return visible.find((e) => e.document.uri.toString() === key);
	}

	/**
	 * The visible editors changed (or the registry started): each file shown for the first time in
	 * the session is remembered, and its graph auto-opens if it should (AUTO, AUTO_ONCE, AUTO_OFF,
	 * TYPED, HIDDEN). A file a pending rename is creating takes over the old name's memory instead.
	 */
	private shown(visible: readonly vscode.TextEditor[]): void {
		for (const editor of visible) {
			const column = editor.viewColumn;
			const doc = editor.document;
			const key = doc.uri.toString();
			if (column === undefined || this.seen.has(key)) {
				continue;
			}
			this.seen.add(key);
			if (this.pendingRenames.some((r) => key === r.to || within(key, r.to))) {
				continue;
			}
			if (this.shouldAutoOpen(doc)) {
				void this.enqueue(() => this.open(doc.uri, { doc, column }, true));
			}
		}
	}

	private shouldAutoOpen(doc: vscode.TextDocument): boolean {
		const key = doc.uri.toString();
		if (doc.uri.scheme === 'untitled' || this.hidden.has(key) || this.panels.has(key)) {
			return false;
		}
		try {
			return this.options.autoOpen?.() === true && this.options.detection?.isDetected(doc.uri) === true;
		} catch (e) {
			this.options.log(`Graph auto-open: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
	}

	/** A panel whose file had a text tab and has none left closes (TAB_CLOSE); a renaming file is skipped. */
	private tabsChanged(): void {
		for (const graph of [...this.panels.values()]) {
			const key = graph.uri.toString();
			if (hasTextTab(key)) {
				graph.hadTab = true;
			} else if (graph.hadTab && !this.pendingRenames.some((r) => key === r.from || within(key, r.from))) {
				graph.panel.dispose();
			}
		}
	}

	/** RENAME: every map holding a renamed URI re-keys together; panels get their new title. */
	private renamed(files: readonly { readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri }[]): void {
		const renames = files.map((f) => ({ from: f.oldUri.toString(), to: f.newUri.toString() }));
		this.pendingRenames = this.pendingRenames.filter((p) => !renames.some((r) => r.from === p.from && r.to === p.to));
		for (const [key, graph] of [...this.panels]) {
			const to = renamedKey(key, renames);
			if (to === undefined) {
				continue;
			}
			this.panels.delete(key);
			if (this.panels.has(to)) {
				// A graph of the new name is open already: one panel per file.
				graph.panel.dispose();
				continue;
			}
			graph.uri = vscode.Uri.parse(to);
			graph.panel.title = graphTitle(graph.uri);
			this.panels.set(to, graph);
		}
		for (const [key, editor] of [...this.driving]) {
			const to = renamedKey(key, renames);
			if (to !== undefined) {
				this.driving.delete(key);
				this.driving.set(to, editor);
			}
		}
		for (const key of [...this.seen]) {
			const to = renamedKey(key, renames);
			if (to !== undefined) {
				this.seen.delete(key);
				this.seen.add(to);
			}
		}
		let hiddenChanged = false;
		for (const key of [...this.hidden]) {
			const to = renamedKey(key, renames);
			if (to !== undefined) {
				this.hidden.delete(key);
				this.hidden.add(to);
				hiddenChanged = true;
			}
		}
		if (hiddenChanged) {
			void this.storeHidden();
		}
		this.updateContext();
		this.tabsChanged();
	}

	registerCommands(): vscode.Disposable[] {
		return [
			vscode.commands.registerCommand(SHOW_GRAPH_COMMAND, (uri?: vscode.Uri) => this.show(uri)),
			vscode.commands.registerCommand(HIDE_GRAPH_COMMAND, (uri?: vscode.Uri) => this.hide(uri)),
		];
	}

	/**
	 * Show graph (SHOW): the file of `uri`, default the active tab's text file, loses its Hide, is
	 * marked detected and gets its panel opened (or revealed). Resolves once a new panel's lock
	 * sequence is done. Never throws.
	 */
	async show(uri?: vscode.Uri): Promise<GraphPanelHandle | undefined> {
		try {
			const target = uri instanceof vscode.Uri ? uri : this.activeUri();
			if (!target) {
				this.options.log('Show graph: no active editor.');
				return undefined;
			}
			if (this.hidden.delete(target.toString())) {
				await this.storeHidden();
			}
			this.options.detection?.markDetected(target);
			return await this.enqueue(() => this.open(target, undefined, false));
		} catch (e) {
			this.options.log(`Show graph: ${e instanceof Error ? e.message : String(e)}`);
			return undefined;
		}
	}

	/**
	 * Hide graph (HIDE): closes the panel of `uri` (default the active tab's text file, or the
	 * focused graph's file) and stores its Hide, which outlives a reload. Never throws.
	 */
	async hide(uri?: vscode.Uri): Promise<void> {
		try {
			const target = uri instanceof vscode.Uri ? uri : this.activeUri();
			if (!target) {
				this.options.log('Hide graph: no active editor.');
				return;
			}
			const key = target.toString();
			this.hidden.add(key);
			this.panels.get(key)?.panel.dispose();
			await this.storeHidden();
		} catch (e) {
			this.options.log(`Hide graph: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** Resolves once the panel creations queued so far (and their lock sequences) are done (test seam). */
	idle(): Promise<void> {
		return this.queue.then(() => undefined);
	}

	/** Whether the file of `uri` is hidden (test seam). */
	isHidden(uri: vscode.Uri): boolean {
		return this.hidden.has(uri.toString());
	}

	/**
	 * The command's file when it has no argument: the active tab's text file, else, when a graph
	 * has focus, its file. Never `window.activeTextEditor` (spike 3.14).
	 */
	private activeUri(): vscode.Uri | undefined {
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		if (input instanceof vscode.TabInputText) {
			return input.uri;
		}
		if (input instanceof vscode.TabInputWebview) {
			return [...this.panels.values()].find((g) => g.panel.active)?.uri;
		}
		return undefined;
	}

	private async storeHidden(): Promise<void> {
		try {
			await this.options.memento?.update(HIDDEN_GRAPHS_STATE, [...this.hidden]);
		} catch (e) {
			this.options.log(`Hide graph: could not store the hidden files: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private enqueue<T>(run: () => Promise<T>): Promise<T> {
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => undefined);
		return next;
	}

	/**
	 * Opens the graph of `target`, or reveals its open panel without focus (an auto-open leaves an
	 * open panel alone). `shownIn`: the document and column of the editor that showed it, else the
	 * column of a tab holding it. A new panel runs the lock sequence.
	 */
	private async open(
		target: vscode.Uri,
		shownIn: { readonly doc: vscode.TextDocument; readonly column: vscode.ViewColumn } | undefined,
		auto: boolean,
	): Promise<GraphPanelHandle | undefined> {
		const key = target.toString();
		const open = this.panels.get(key);
		if (open) {
			if (!auto) {
				open.panel.reveal(undefined, true);
			}
			return open;
		}
		// A queued auto-open whose file's tab closed meanwhile opens nothing.
		if (this.disposed || (auto && (!shownIn || !this.shouldAutoOpen(shownIn.doc) || !hasTextTab(key)))) {
			return undefined;
		}
		const yamlColumn = shownIn?.column ?? this.columnOf(key);
		const title = graphTitle(target);
		const panel = vscode.window.createWebviewPanel(
			GRAPH_VIEW_TYPE,
			title,
			{ viewColumn: this.graphColumn(yamlColumn), preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, 'dist')],
			},
		);
		// The closures read `graph.uri`, which a rename replaces.
		const graph: GraphPanel = new GraphPanel(
			target,
			panel,
			this.options.log,
			() => catalogueOf(this.options.schema.current?.json),
			() => this.editorFor(graph.uri.toString()),
			() => this.options.diagnostics.diagnosticsFor(graph.uri),
			() => hostStatusOf(this.options.binary.state, this.options.schema),
			() => this.options.actions,
		);
		graph.hadTab = hasTextTab(key);
		this.panels.set(key, graph);
		panel.onDidDispose(() => {
			graph.dispose();
			const current = graph.uri.toString();
			if (this.panels.get(current) === graph) {
				this.panels.delete(current);
				this.updateContext();
			}
		});
		panel.webview.html = graphHtml(panel.webview, this.options.extensionUri, title);
		this.updateContext();
		const doc = shownIn?.doc ?? openDocument(key);
		await this.lock(graph, yamlColumn, doc);
		return graph;
	}

	/**
	 * The column of a tab showing `key`: the active group's when its active tab is the file, else
	 * a group whose active tab is the file, else any group holding a tab of it.
	 */
	private columnOf(key: string): vscode.ViewColumn | undefined {
		const groups = vscode.window.tabGroups;
		if (isTextTabOf(groups.activeTabGroup.activeTab, key)) {
			return groups.activeTabGroup.viewColumn;
		}
		return (groups.all.find((g) => isTextTabOf(g.activeTab, key))
			?? groups.all.find((g) => g.tabs.some((t) => isTextTabOf(t, key))))?.viewColumn;
	}

	/**
	 * Where a new panel goes (one graph group, SECOND): the column of an open graph panel, else the
	 * empty group directly right of the YAML (the locked group a reload leaves), else beside the YAML.
	 */
	private graphColumn(yamlColumn: vscode.ViewColumn | undefined): vscode.ViewColumn {
		for (const graph of this.panels.values()) {
			const column = graph.panel.viewColumn;
			if (column !== undefined && column !== yamlColumn) {
				return column;
			}
		}
		if (yamlColumn === undefined) {
			return vscode.ViewColumn.Beside;
		}
		const empty = vscode.window.tabGroups.all.find((g) => g.tabs.length === 0 && g.viewColumn === yamlColumn + 1);
		if (empty) {
			return empty.viewColumn;
		}
		// `Beside` is beside the active group; an editor shown without focus may be in another one.
		return vscode.window.tabGroups.activeTabGroup.viewColumn === yamlColumn ? vscode.ViewColumn.Beside : (yamlColumn + 1) as vscode.ViewColumn;
	}

	/**
	 * The lock sequence (spike 3.14 rec. 1): the panel's group is made active (`reveal` with
	 * focus) and locked, then focus goes back to the YAML editor in its column, from the held
	 * document. Best effort: a failure is logged and the panel stays. The lock runs only once the
	 * panel's group is active, so that it never locks the YAML's group instead.
	 */
	private async lock(graph: GraphPanel, yamlColumn: vscode.ViewColumn | undefined, doc: vscode.TextDocument | undefined): Promise<void> {
		const name = path.posix.basename(graph.uri.path);
		try {
			graph.panel.reveal(undefined, false);
			const active = await until(
				() => graph.panel.active && vscode.window.tabGroups.activeTabGroup.viewColumn === graph.panel.viewColumn,
				LOCK_WAIT_MS,
			);
			// Only a group holding nothing but graphs is locked, never one of the user's editor groups.
			const onlyGraphs = vscode.window.tabGroups.activeTabGroup.tabs.every((t) =>
				t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith(GRAPH_VIEW_TYPE));
			if (active && onlyGraphs) {
				await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
			} else if (active) {
				this.options.log(`Graph ${name}: its group holds other editors, so it was not locked.`);
			} else {
				this.options.log(`Graph ${name}: its group did not become active, so it was not locked.`);
			}
		} catch (e) {
			this.options.log(`Graph ${name}: could not lock its group: ${e instanceof Error ? e.message : String(e)}`);
		}
		if (yamlColumn === undefined || !doc) {
			return;
		}
		try {
			// Only while focus is where the sequence put it: never over an editor the user opened since.
			if (!graph.panel.active) {
				return;
			}
			await vscode.window.showTextDocument(doc, { viewColumn: yamlColumn, preserveFocus: false });
		} catch (e) {
			this.options.log(`Graph ${name}: could not return focus to the YAML: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** `redpandaConnect.graphOpenPaths`: the `fsPath`s of the files with an open panel (TOGGLE). */
	private updateContext(): void {
		if (this.disposed) {
			return;
		}
		const paths = [...this.panels.keys()].map((k) => vscode.Uri.parse(k).fsPath);
		if (this.options.setContext) {
			this.options.setContext(GRAPH_OPEN_PATHS_KEY, paths);
		} else {
			void vscode.commands.executeCommand('setContext', GRAPH_OPEN_PATHS_KEY, paths);
		}
	}

	/** The open panel of `uri`, if any (test seam). */
	panelFor(uri: vscode.Uri): GraphPanelHandle | undefined {
		return this.panels.get(uri.toString());
	}

	/** How many graph panels are open. */
	get size(): number {
		return this.panels.size;
	}

	dispose(): void {
		this.disposed = true;
		this.subscriptions.forEach((d) => d.dispose());
		this.driving.clear();
		for (const graph of [...this.panels.values()]) {
			graph.panel.dispose();
		}
		this.panels.clear();
	}
}
