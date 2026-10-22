// Editor-group helpers shared by the graph and the Bloblang test panels (ticket 4.17, AD-1): the
// two panels' view types, what a group holds, and a new empty group below or above a given one.

import * as vscode from 'vscode';
import { until } from './tabs';

export const GRAPH_VIEW_TYPE = 'redpandaConnect.graph';
export const BLOBLANG_VIEW_TYPE = 'redpandaConnect.bloblang';

/** How long `newGroupNextTo` waits for each of its focus changes. */
const GROUP_WAIT_MS = 1_000;

/** The commands that focus the 1st to 8th editor group, in the order `ViewColumn` numbers them. */
const FOCUS_GROUP_COMMANDS = [
	'workbench.action.focusFirstEditorGroup',
	'workbench.action.focusSecondEditorGroup',
	'workbench.action.focusThirdEditorGroup',
	'workbench.action.focusFourthEditorGroup',
	'workbench.action.focusFifthEditorGroup',
	'workbench.action.focusSixthEditorGroup',
	'workbench.action.focusSeventhEditorGroup',
	'workbench.action.focusEighthEditorGroup',
];

/** Whether `tab` is a webview panel of `viewType`. */
export function isViewTab(tab: vscode.Tab, viewType: string): boolean {
	return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(viewType);
}

/** Whether `tab` is a text editor (or a text diff). */
function isTextEditorTab(tab: vscode.Tab): boolean {
	return tab.input instanceof vscode.TabInputText || tab.input instanceof vscode.TabInputTextDiff;
}

/** Whether `group` holds a graph panel. */
export function holdsGraph(group: vscode.TabGroup): boolean {
	return group.tabs.some((t) => isViewTab(t, GRAPH_VIEW_TYPE));
}

/** Whether `group` holds test panels and nothing else (4.17: the graph opens above such a group). */
export function onlyTestPanels(group: vscode.TabGroup): boolean {
	return group.tabs.length > 0 && group.tabs.every((t) => isViewTab(t, BLOBLANG_VIEW_TYPE));
}

/** A test group (4.17): a group holding a test panel and no text editors or graph. */
export function isTestGroup(group: vscode.TabGroup): boolean {
	return group.tabs.some((t) => isViewTab(t, BLOBLANG_VIEW_TYPE)) && !group.tabs.some((t) => isTextEditorTab(t) || isViewTab(t, GRAPH_VIEW_TYPE));
}

/**
 * Creates an empty group below or above the group in `column` (`workbench.action.newGroupBelow` /
 * `newGroupAbove` with that group active) and resolves with its column, which is then the active
 * group; `undefined` when the group can't be made active or no group was created in time (focus
 * may have moved). Never throws.
 */
export async function newGroupNextTo(column: vscode.ViewColumn, direction: 'below' | 'above', waitMs = GROUP_WAIT_MS): Promise<vscode.ViewColumn | undefined> {
	try {
		const focus = FOCUS_GROUP_COMMANDS[column - 1];
		if (focus === undefined) {
			return undefined;
		}
		const groups = vscode.window.tabGroups;
		if (groups.activeTabGroup.viewColumn !== column) {
			await vscode.commands.executeCommand(focus);
			if (!await until(() => groups.activeTabGroup.viewColumn === column, waitMs)) {
				return undefined;
			}
		}
		const count = groups.all.length;
		await vscode.commands.executeCommand(direction === 'below' ? 'workbench.action.newGroupBelow' : 'workbench.action.newGroupAbove');
		const created = await until(() => groups.all.length > count && groups.activeTabGroup.tabs.length === 0, waitMs);
		return created ? groups.activeTabGroup.viewColumn : undefined;
	} catch {
		return undefined;
	}
}

/** How long `returnFocusTo` waits for focus to be back in the editor, per try. */
const FOCUS_WAIT_MS = 500;
/**
 * How long, once focus is back in the editor, `returnFocusTo` lets a late focus change arrive before
 * it re-checks. Bug 19: a webview group focused before (by `newGroupNextTo`) took the active group
 * back 50-75 ms after the return on 2 CPUs.
 */
const FOCUS_SETTLE_MS = 250;

/**
 * How `returnFocusTo` ended: `kept`, focus is in the editor; `declined`, focus was left where the
 * user (or a group other than the caller's) moved it; `missed`, focus was taken back from the
 * caller's groups and still did not stay.
 */
export type FocusReturn = 'kept' | 'declined' | 'missed';

/** How many times `returnFocusTo` takes focus back from the caller's groups (a group's echo, and a second one). */
const RETAKES = 2;

/**
 * Gives focus to `doc` in `column` and confirms it (4.13, bug 19; the bug-15 pattern): it waits up
 * to `FOCUS_WAIT_MS` for `doc` to be the active editor in that column *and* that column's group to
 * be the active group (VS Code reports the two separately), then `FOCUS_SETTLE_MS` more and checks
 * again. `through`: the groups the caller itself just moved focus through (the graph's group, a
 * test group focused to create a group next to it). A webview group focused that way echoes its
 * focus late and takes the active group back. Only when one of those groups is the active one, and
 * `mayRetake()`, is focus taken back (up to `RETAKES` times) and confirmed again.
 *
 * The user's moves are never overridden: when another editor becomes active during the window, it
 * becomes the target instead (an echo after it gives focus back to that editor, not the YAML), and
 * when another group is activated, nothing more is done. Throws what `showTextDocument` throws.
 */
export async function returnFocusTo(
	doc: vscode.TextDocument, column: vscode.ViewColumn, through: readonly vscode.ViewColumn[], mayRetake: () => boolean = () => true,
): Promise<FocusReturn> {
	const groups = vscode.window.tabGroups;
	/** The editor the user moved to during the window, if any. */
	let user: { readonly doc: vscode.TextDocument; readonly column: vscode.ViewColumn } | undefined;
	/** Another group was activated, not by this sequence. */
	let foreign = false;
	const target = () => user ?? { doc, column };
	const focused = () => {
		const { doc: d, column: c } = target();
		const active = vscode.window.activeTextEditor;
		return active?.document === d && active.viewColumn === c && groups.activeTabGroup.viewColumn === c;
	};
	const subscriptions = [
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor?.viewColumn !== undefined && !(editor.document === doc && editor.viewColumn === column)) {
				user = { doc: editor.document, column: editor.viewColumn };
			}
		}),
		groups.onDidChangeTabGroups(() => {
			const active = groups.activeTabGroup.viewColumn;
			if (active !== column && active !== user?.column && !through.includes(active)) {
				foreign = true;
			}
		}),
	];
	try {
		for (let attempt = 0; attempt <= RETAKES; attempt++) {
			if (attempt > 0 && (foreign || !through.includes(groups.activeTabGroup.viewColumn) || !mayRetake())) {
				return user || foreign || attempt === 1 ? 'declined' : 'missed';
			}
			const { doc: d, column: c } = target();
			await vscode.window.showTextDocument(d, { viewColumn: c, preserveFocus: false });
			if (await until(focused, FOCUS_WAIT_MS)) {
				await new Promise((r) => setTimeout(r, FOCUS_SETTLE_MS));
				if (focused()) {
					return user ? 'declined' : 'kept';
				}
			}
		}
		return user || foreign ? 'declined' : 'missed';
	} finally {
		subscriptions.forEach((d) => d.dispose());
	}
}
