// Shared helpers of the integration suites (split out of extension.test.ts in ticket 2.12).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BinaryState, RedpandaConnect } from '../../adapters/redpandaConnect/binary';
import { BinaryNotifier, MISSING_MESSAGE, NOTIFICATION_ACTIONS } from '../../adapters/redpandaConnect/notify';
import { createVsCodeNotifier, REFRESH_NO_BINARY_LINE, type ExtensionApi } from '../../extension';
import { GapCompletionProvider } from '../../adapters/vscode/completion';
import { SchemaSnapshot, SchemaStore } from '../../adapters/redpandaConnect/schema';
import { schemaFileName } from '../../core/schema';
import {
	connectScript, fixtureBodies, makeTempDir, readCounter, REPO_ROOT, SCHEMA_FIXTURES, toolPath, versionScript, writeFakeBinary,
} from '../helpers/fakeBinary';

export const EXTENSION_ID = 'ajurcenk.rpcn-pipeline-designer';

/** Output lines without the schema store's (`Schema…`), which interleave with binary resolution. */
export const binaryLines = (api: ExtensionApi) => api.outputLines().filter((l) => !l.startsWith('Schema'));

export async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return true;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	return predicate();
}

export async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return true;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return predicate();
}

/**
 * Whether `doc` is the active editor in `column` and that column's group is the active tab group
 * (bug 19): the two signals VS Code reports separately, so a group activated late can leave the
 * editor active while another group is.
 */
export function focusedIn(doc: vscode.TextDocument, column: vscode.ViewColumn): boolean {
	const active = vscode.window.activeTextEditor;
	return active?.document === doc && active.viewColumn === column && vscode.window.tabGroups.activeTabGroup.viewColumn === column;
}

/**
 * Runs `command`, which acts on the active editor (`undo`, `workbench.action.revertAndCloseActiveEditor`),
 * against `doc` (bug 19): shows it (with `show`, else in its visible editor's column), waits until it
 * is the active editor and its tab the active group's active tab, and checks it still is a moment
 * later, as a focus change already on its way can take it; then runs the command (up to three
 * tries). `column`: the group it must be active in (a file shown in two groups), shown there.
 * Throws when `doc` does not stay active.
 */
export async function runOnEditor(
	doc: vscode.TextDocument, command: string, show?: () => Thenable<unknown>, inColumn?: vscode.ViewColumn,
): Promise<void> {
	const column = inColumn ?? vscode.window.visibleTextEditors.find((e) => e.document === doc)?.viewColumn;
	const key = doc.uri.toString();
	// The active group's active tab is the document's (a text or diff tab): a diff editor's
	// `activeTextEditor` has no `viewColumn`.
	const active = () => {
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		const tabOf = input instanceof vscode.TabInputText ? input.uri.toString() === key
			: input instanceof vscode.TabInputTextDiff ? input.modified.toString() === key || input.original.toString() === key : false;
		return tabOf && vscode.window.activeTextEditor?.document === doc
			&& (inColumn === undefined || vscode.window.tabGroups.activeTabGroup.viewColumn === inColumn);
	};
	for (let attempt = 0; attempt < 3; attempt++) {
		await (show ? show() : vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus: false }));
		if (await waitFor(active, 5_000)) {
			await new Promise((r) => setTimeout(r, 100));
			if (active()) {
				await vscode.commands.executeCommand(command);
				return;
			}
		}
	}
	assert.fail(`${doc.uri.path} did not stay the active editor for ${command}`);
}
