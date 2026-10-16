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
