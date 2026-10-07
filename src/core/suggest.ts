// Pure name suggestions for the unknown-field Quick Fix (2.5): optimal string alignment distance
// (Damerau–Levenshtein with adjacent transpositions), ties broken by name. The limit keeps short
// keys from being replaced wholesale (`id` → `jq`); limits and the preferred rule are the
// user's (2026-10-07, 2.5 review).

/** At most this many suggestions. */
export const MAX_SUGGESTIONS = 3;

export interface Suggestion {
	readonly name: string;
	readonly distance: number;
}

/** Edits allowed for a word of `length` characters: `min(3, max(1, ⌊length / 3⌋))`. */
export function maxDistance(length: number): number {
	return Math.min(3, Math.max(1, Math.floor(length / 3)));
}

/**
 * Up to 3 `candidates` closest to `word` within `maxDistance`, skipping `exclude` and `word`
 * itself. `ignoreCase` compares lower-cased (lint's option rule is case-insensitive).
 */
export function rankNames(
	word: string, candidates: readonly string[], exclude: readonly string[] = [], ignoreCase = false,
): Suggestion[] {
	const skip = new Set([...exclude, word]);
	const limit = maxDistance(word.length);
	const fold = (s: string) => (ignoreCase ? s.toLowerCase() : s);
	return [...new Set(candidates)]
		.filter((name) => !skip.has(name))
		.map((name) => ({ name, distance: editDistance(fold(word), fold(name)) }))
		.filter(({ distance }) => distance <= limit)
		.sort((a, b) => a.distance - b.distance || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.slice(0, MAX_SUGGESTIONS);
}

/** The names of `rankNames`. */
export function closestNames(word: string, candidates: readonly string[], exclude: readonly string[] = []): string[] {
	return rankNames(word, candidates, exclude).map((s) => s.name);
}

/** Whether the first suggestion is a clear winner: strictly closer than the second. */
export function hasClearWinner(ranked: readonly Suggestion[]): boolean {
	return ranked.length === 1 || (ranked.length > 1 && ranked[0].distance < ranked[1].distance);
}

/** Optimal string alignment distance between `a` and `b`. */
export function editDistance(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
			}
		}
	}
	return d[a.length][b.length];
}
