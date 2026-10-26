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

/** What the batch `renames` does to a key: where it ends (`undefined`: never moved), and whether its content survives. */
export interface RenameFate {
	readonly to: string | undefined;
	readonly destroyed: boolean;
}

/**
 * `key` through the batch `renames`, applied in order (ticket 17): a rename that moves the key's
 * current place moves it (as `renamedThrough`); one that lands on its current place (the file
 * itself, or a folder holding it) without moving it destroys its content, which later renames
 * still carry along.
 */
export function renameFate(key: string, renames: readonly Rename[]): RenameFate {
	let current = key;
	let moved = false;
	let destroyed = false;
	for (const rename of renames) {
		const to = renamedKey(current, [rename]);
		if (to !== undefined) {
			current = to;
			moved = true;
		} else if (current === rename.to || within(current, rename.to)) {
			destroyed = true;
		}
	}
	return { to: moved ? current : undefined, destroyed };
}

/**
 * Per new name, the one of `keys` the batch `renames` moves there and whose content survives
 * (at most one: each later arrival destroys the one there). A moved key that was destroyed wins
 * nowhere; keys the batch leaves alone are not in it. The result does not depend on the order of
 * `keys`, nor on which other keys are passed.
 */
export function renameWinners(keys: Iterable<string>, renames: readonly Rename[]): Map<string, string> {
	const winners = new Map<string, string>();
	for (const key of keys) {
		const { to, destroyed } = renameFate(key, renames);
		if (to !== undefined && !destroyed) {
			winners.set(to, key);
		}
	}
	return winners;
}

/**
 * Whether the batch `renames` overwrites `key` (ticket 17): a rename lands on it (the file itself, or
 * a folder holding it) and it is not moved, so its content is gone.
 */
export function overwrittenBy(key: string, renames: readonly Rename[]): boolean {
	const { to, destroyed } = renameFate(key, renames);
	return to === undefined && destroyed;
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

/** How recently a file must have been created and saved for its new tab to be a Save As (ticket 12). */
export const SAVE_AS_WINDOW_MS = 2_000;
/** How soon after the new tab opened the source's tab must close for a Save As (ticket 12). */
export const SAVE_AS_CLOSE_MS = 1_000;

/** When a file was last created and last saved (`Date.now()`), by `uri.toString()`. */
export interface CreatedAndSaved {
	readonly created?: number;
	readonly saved?: number;
}

/** A tab that opened and may be a Save As of its source (ticket 12), as `uri.toString()`s. */
export interface SaveAsCandidate {
	/** The new file, whose tab opened. */
	readonly to: string;
	/** The file of the next tab in its group when it opened. */
	readonly from: string;
	/** When the new tab opened (`Date.now()`). */
	readonly openedAt: number;
}

/**
 * Whether the text tab of `opened` that just opened (at `now`) is a candidate Save As of `next`, the
 * tab just after it in its group (ticket 12): VS Code reports no Save As, but the new file is created
 * and saved, then its tab opens at the old tab's place (so the old tab is the next one), which closes
 * in a later event. A candidate when `opened` was created and saved within `SAVE_AS_WINDOW_MS` before
 * `now`, and `next` is a text tab of another URI (`undefined`: no next tab, or not a text one).
 */
export function isSaveAsCandidate(
	opened: string,
	next: string | undefined,
	recent: ReadonlyMap<string, CreatedAndSaved>,
	now: number,
): boolean {
	if (next === undefined || next === opened) {
		return false;
	}
	const at = recent.get(opened);
	const fresh = (t: number | undefined) => t !== undefined && t <= now && now - t <= SAVE_AS_WINDOW_MS;
	return at !== undefined && fresh(at.created) && fresh(at.saved);
}

/** Whether `candidate` can no longer be confirmed at `now`: its source's close came too late. */
export function saveAsExpired(candidate: SaveAsCandidate, now: number): boolean {
	return now - candidate.openedAt > SAVE_AS_CLOSE_MS;
}

/**
 * Whether the close of a text tab of `closed` at `now` confirms `candidate` (ticket 12): it is the
 * candidate's source, it closed within `SAVE_AS_CLOSE_MS` after the new tab opened, and the new tab
 * is still open (`toOpen`). A file merely opened beside another leaves its neighbour open.
 */
export function confirmsSaveAs(candidate: SaveAsCandidate, closed: string, now: number, toOpen: boolean): boolean {
	return closed === candidate.from && toOpen && now >= candidate.openedAt && !saveAsExpired(candidate, now);
}
