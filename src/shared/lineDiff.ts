// A line-level diff's counts (story 8.12): how many lines a change added and removed, as the assistant's
// file rows show them (+N/−N). Myers' greedy algorithm finds the shortest edit (D insertions and
// deletions) without keeping its path, so it needs O(N+M) memory; the common head and tail are trimmed
// first. Past `MAX_EDIT` edits it stops and counts by line multiset instead (an estimate for very
// different files). No vscode import.

export interface LineDiffCounts {
	readonly added: number;
	readonly removed: number;
}

/** The most edits Myers' search tries before the multiset estimate. */
export const MAX_EDIT = 4000;

/** A text's lines: none for an empty text; a final newline ends the last line, not a new one. */
export function linesOf(text: string): string[] {
	if (text === '') {
		return [];
	}
	const lines = text.split(/\r?\n/);
	if (lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/** The lines `after` added to `before` and removed from it (`before` `null`: a new file). */
export function lineDiff(before: string | null, after: string | null): LineDiffCounts {
	const a = linesOf(before ?? '');
	const b = linesOf(after ?? '');
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start++;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const x = a.slice(start, endA);
	const y = b.slice(start, endB);
	if (x.length === 0 || y.length === 0) {
		return { added: y.length, removed: x.length };
	}
	const d = editDistance(x, y);
	if (d === undefined) {
		return multisetCounts(x, y);
	}
	// D = added + removed, and M − N = added − removed.
	return { added: (d + y.length - x.length) / 2, removed: (d - y.length + x.length) / 2 };
}

/** The number of insertions and deletions of the shortest edit from `a` to `b`, or `undefined` past `MAX_EDIT`. */
function editDistance(a: readonly string[], b: readonly string[]): number | undefined {
	const n = a.length;
	const m = b.length;
	const max = Math.min(n + m, MAX_EDIT);
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	for (let d = 0; d <= max; d++) {
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				return d;
			}
		}
	}
	return undefined;
}

function multisetCounts(a: readonly string[], b: readonly string[]): LineDiffCounts {
	const left = new Map<string, number>();
	for (const line of a) {
		left.set(line, (left.get(line) ?? 0) + 1);
	}
	let common = 0;
	for (const line of b) {
		const c = left.get(line) ?? 0;
		if (c > 0) {
			left.set(line, c - 1);
			common++;
		}
	}
	return { added: b.length - common, removed: a.length - common };
}
