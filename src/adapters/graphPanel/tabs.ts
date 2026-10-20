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

/** How long an announced rename stays pending when it is never reported (ticket 4.13). */
export const PENDING_RENAME_MS = 30_000;

/**
 * Renames announced by `onWillRenameFiles` and not reported yet, for the graph and test-panel
 * registries (ticket 4.13). An entry goes when its rename is reported (`report`), or `expiryMs`
 * after its announcement, whichever comes first: a rename that is announced and never reported (it
 * failed, or was cancelled) does not keep its files' tab closes from counting. Expired entries are
 * dropped whenever the registry reads or changes the set (`all`, `prune`), and handed to `onExpired`.
 */
export class PendingRenames {
	private entries: { readonly rename: Rename; readonly at: number }[] = [];

	constructor(
		private readonly expiryMs: number = PENDING_RENAME_MS,
		/** The clock (test seam): `Date.now` in production. */
		private readonly now: () => number = Date.now,
		/** Hears the renames that expired unreported, once each. */
		private readonly onExpired?: (expired: readonly Rename[]) => void,
	) {}

	/** `renames` are announced now. */
	announce(renames: readonly Rename[]): void {
		this.prune();
		const at = this.now();
		this.entries.push(...renames.map((rename) => ({ rename, at })));
	}

	/** `renames` were reported: their entries go. */
	report(renames: readonly Rename[]): void {
		this.prune();
		this.entries = this.entries.filter(({ rename: p }) => !renames.some((r) => r.from === p.from && r.to === p.to));
	}

	/** The pending renames, in announcement order, after the expired ones are dropped. */
	get all(): readonly Rename[] {
		this.prune();
		return this.entries.map((e) => e.rename);
	}

	/** Whether a pending rename renames `key` (the file itself, or a folder holding it). */
	renaming(key: string): boolean {
		return this.all.some((r) => key === r.from || within(key, r.from));
	}

	/** Whether a pending rename creates `key` (the file itself, or a folder holding it). */
	creating(key: string): boolean {
		return this.all.some((r) => key === r.to || within(key, r.to));
	}

	/** Drops the entries announced `expiryMs` ago or more, and tells `onExpired`. */
	prune(): void {
		const now = this.now();
		const expired = this.entries.filter((e) => now - e.at >= this.expiryMs);
		if (expired.length === 0) {
			return;
		}
		this.entries = this.entries.filter((e) => now - e.at < this.expiryMs);
		this.onExpired?.(expired.map((e) => e.rename));
	}
}
