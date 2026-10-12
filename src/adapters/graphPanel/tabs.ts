// Tab, document and rename helpers of the graph registry (ticket 3.10; split out of panels.ts in ticket 3.12).

import * as vscode from 'vscode';

/** A rename of a file or a folder, as `uri.toString()`s. */
export interface Rename {
	readonly from: string;
	readonly to: string;
}

export function within(key: string, folder: string): boolean {
	return key.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
}

/**
 * `key` after the first of `renames` that renames it (the file itself, or a folder holding it);
 * `undefined` when none does.
 */
export function renamedKey(key: string, renames: readonly Rename[]): string | undefined {
	for (const { from, to } of renames) {
		if (key === from) {
			return to;
		}
		if (within(key, from)) {
			const prefix = from.endsWith('/') ? from : `${from}/`;
			return `${to.endsWith('/') ? to : `${to}/`}${key.slice(prefix.length)}`;
		}
	}
	return undefined;
}

/**
 * `key` after the whole batch `renames`, applied in order (F7): each rename that renames the key
 * as it stands then moves it, so a chain (`b→c, a→b`) and a swap through a temporary name
 * (`a→t, b→a, t→b`) put each file at its own new name. `undefined` when none renames it.
 */
export function renamedThrough(key: string, renames: readonly Rename[]): string | undefined {
	let current = key;
	let moved = false;
	for (const rename of renames) {
		const to = renamedKey(current, [rename]);
		if (to !== undefined) {
			current = to;
			moved = true;
		}
	}
	return moved ? current : undefined;
}

/** Polls `predicate` until it holds or `timeoutMs` passes; whether it held. */
export async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			return false;
		}
		await new Promise((r) => setTimeout(r, 20));
	}
	return true;
}

/** Whether a tab group holds a text tab of `key`. */
export function hasTextTab(key: string): boolean {
	return vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => isTextTabOf(t, key)));
}

export function isTextTabOf(tab: vscode.Tab | undefined, key: string): boolean {
	return tab?.input instanceof vscode.TabInputText && tab.input.uri.toString() === key;
}

/** The open text document of `key` (a `uri.toString()`), if any. */
export function openDocument(key: string): vscode.TextDocument | undefined {
	return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
}
