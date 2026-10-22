// Which processor a test panel follows across document changes (ticket 4.10, AD-1). Pure, no
// `vscode`. Each panel keeps its processor's map range, mapped through every change's descriptors
// (`mapRange`, all in pre-change coordinates): its start stays left of an insertion at it, its end
// stays right of one. While the document parses, all panels of the document are matched together,
// one panel per processor (`matchProcessors`); while it doesn't (`parses`), only the ranges map:
//   0. a panel reset to its samples link (its document was closed unsaved) takes the processor of
//      that link: its label, else its path;
//   1. overlap: each panel takes the processor of its kind whose range overlaps its mapped range
//      most relative to their union, the best first (ties: the nearer starts);
//   2. label: a panel with no overlap takes the unclaimed processor with its label;
//   3. removed panels (and those that found nothing above) take the unclaimed processor with their
//      last label, else an unclaimed one of the same kind and Bloblang nearest their last path;
//   4. otherwise: none (the panel is removed).
// Every step keeps to the panel's side of the kinds (ticket 22): a `generate` input mapping and a
// `mapping` / `mutation` processor never match each other, by range, label or path (`sameSide`);
// a processor whose kind changed between `mapping` and `mutation` is still found by its label.

import type { BloblangKind, BloblangProcessor } from './bloblangProcessors';
import type { ParsedYaml } from './yamlPath';

/** One change of a document, in the coordinates of the text before the event (VS Code's `rangeOffset`, `rangeLength`, `text`). */
export interface TextChange {
	readonly offset: number;
	readonly length: number;
	readonly text: string;
}

/** UTF-16 offsets `[start, end)`. */
export type OffsetRange = readonly [number, number];

/**
 * `offset` after `changes` (all in pre-change coordinates, not overlapping). A change wholly before
 * it shifts it by the change's growth; a change that contains it moves it to the change's start
 * (`left`) or its new end (not `left`). An insertion exactly at it is at a boundary, not containing
 * it: it stays before the inserted text, either way (a range never grows by an insertion at its end).
 */
export function mapOffset(offset: number, changes: readonly TextChange[], left = true): number {
	let delta = 0;
	for (const c of [...changes].sort((a, b) => a.offset - b.offset)) {
		const end = c.offset + c.length;
		if (end < offset || (end === offset && c.length > 0)) {
			delta += c.text.length - c.length;
		} else if (c.offset < offset) {
			return c.offset + delta + (left ? 0 : c.text.length);
		} else {
			break;
		}
	}
	return offset + delta;
}

/** `range` after `changes`: its start stays left, its end stays right of a change containing it. */
export function mapRange(range: OffsetRange, changes: readonly TextChange[]): OffsetRange {
	const start = mapOffset(range[0], changes, true);
	return [start, Math.max(start, mapOffset(range[1], changes, false))];
}

/** Whether `parsed` has no YAML errors: only then are panels matched again (as the graph, AD-17). */
export function parses(parsed: ParsedYaml | undefined): parsed is ParsedYaml {
	return parsed !== undefined && parsed.docs.every((d) => d.errors.length === 0);
}

/** What a panel knows of the processor it follows. */
export interface TrackedProcessor {
	/** Its last path (reset: its samples link's path). */
	readonly path: string;
	/** Its last label (reset: its samples link's label). */
	readonly label?: string;
	readonly kind: BloblangKind;
	/** Its last Bloblang. */
	readonly source: string;
	/** Its map range, mapped through the changes since; `undefined`: reset to its samples link (matched by it). */
	readonly range: OffsetRange | undefined;
	/** Whether the panel is in the removed state. */
	readonly removed: boolean;
}

/**
 * The processor each of `tracked` follows now in `processors` (the document's, in document order,
 * from a text that parses); `undefined`: none (the panel is, or stays, removed). One processor per
 * panel. Never throws.
 */
export function matchProcessors(processors: readonly BloblangProcessor[], tracked: readonly TrackedProcessor[]): (BloblangProcessor | undefined)[] {
	const found: (BloblangProcessor | undefined)[] = tracked.map(() => undefined);
	const claimed = new Set<BloblangProcessor>();
	const claim = (i: number, p: BloblangProcessor | undefined) => {
		if (p && found[i] === undefined && !claimed.has(p)) {
			found[i] = p;
			claimed.add(p);
		}
	};
	const free = (pick: (p: BloblangProcessor) => boolean) => processors.find((p) => !claimed.has(p) && pick(p));

	// 0. Reset to the samples link: by its label, else its path.
	tracked.forEach((t, i) => {
		if (t.range === undefined) {
			claim(i, t.label !== undefined ? free((p) => sameSide(p.kind, t.kind) && p.label === t.label) : free((p) => sameSide(p.kind, t.kind) && p.path === t.path));
		}
	});

	// 1. Overlap relative to the union (intersection / union), the best first (ties: the nearer
	// starts, then panel order, then document order).
	const pairs: { readonly i: number; readonly p: BloblangProcessor; readonly score: number; readonly gap: number; readonly order: number }[] = [];
	tracked.forEach((t, i) => {
		const r = t.range;
		if (t.removed || r === undefined) {
			return;
		}
		processors.forEach((p, order) => {
			const overlap = Math.min(r[1], p.range[1]) - Math.max(r[0], p.range[0]);
			if (p.kind === t.kind && overlap > 0) {
				const union = Math.max(r[1], p.range[1]) - Math.min(r[0], p.range[0]);
				pairs.push({ i, p, score: overlap / union, gap: Math.abs(r[0] - p.range[0]), order });
			}
		});
	});
	pairs.sort((a, b) => b.score - a.score || a.gap - b.gap || a.i - b.i || a.order - b.order);
	for (const { i, p } of pairs) {
		claim(i, p);
	}

	// 2. Label, for a live panel with no overlap.
	tracked.forEach((t, i) => {
		if (!t.removed && t.range !== undefined && t.label !== undefined && found[i] === undefined) {
			claim(i, free((p) => sameSide(p.kind, t.kind) && p.label === t.label));
		}
	});

	// 3. Removed panels, and those that found nothing: the last label, else the same kind and Bloblang nearest the last path.
	tracked.forEach((t, i) => {
		if (found[i] !== undefined) {
			return;
		}
		if (t.label !== undefined) {
			claim(i, free((p) => sameSide(p.kind, t.kind) && p.label === t.label));
		}
		if (found[i] === undefined) {
			const same = processors.filter((p) => !claimed.has(p) && p.kind === t.kind && p.source === t.source);
			claim(i, nearest(same, t.path));
		}
	});
	return found;
}

/** Whether an entry of kind `a` may follow one of kind `b`: both `generate`, or neither. */
function sameSide(a: BloblangKind, b: BloblangKind): boolean {
	return (a === 'generate') === (b === 'generate');
}

/** The processor of `processors` whose path is nearest `path`: the same list first, then the closest index; else the longest common prefix. */
function nearest(processors: readonly BloblangProcessor[], path: string): BloblangProcessor | undefined {
	let best: BloblangProcessor | undefined;
	let bestScore: readonly [number, number] | undefined;
	for (const p of processors) {
		const score = distance(p.path, path);
		if (!bestScore || score[0] < bestScore[0] || (score[0] === bestScore[0] && score[1] < bestScore[1])) {
			best = p;
			bestScore = score;
		}
	}
	return best;
}

/** How far path `a` is from `b`: `[0, index difference]` in the same list, else `[1, -common prefix length]`. */
function distance(a: string, b: string): readonly [number, number] {
	const split = (s: string) => {
		const m = /^(.*)\[(\d+)\]$/.exec(s);
		return m ? { list: m[1], index: Number(m[2]) } : { list: s, index: 0 };
	};
	const x = split(a);
	const y = split(b);
	if (x.list === y.list) {
		return [0, Math.abs(x.index - y.index)];
	}
	let common = 0;
	while (common < a.length && common < b.length && a[common] === b[common]) {
		common++;
	}
	return [1, -common];
}
