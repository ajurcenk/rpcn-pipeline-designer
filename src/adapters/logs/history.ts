// The history rules of the Pipeline Logs panel (ticket 6.3, AD-24): pure. Which times a range of the
// menu reads, how long the window of Load older records is, how older rows join the kept ones under the
// cap, when the log's first record has been reached, and the menu's retention line. No `vscode` import.

import { DAY_MS, HOUR_MS, type LogsRange, MINUTE_MS, type RangeChoice } from '../../shared/logsProtocol';
import type { LogPositions } from './logReader';

/** The default range's look back, and the shortest window Load older reads. */
export const RECENT_MS = 15 * MINUTE_MS;

const LOOK_BACK: Readonly<Partial<Record<RangeChoice['kind'], number>>> = { recent: RECENT_MS, hour: HOUR_MS, day: DAY_MS, week: 7 * DAY_MS };

/**
 * The range `choice` reads, chosen at `now`: `deployTime` is the pipeline's last deploy (needed for
 * `deploy`); `recentMs` the default's look back. `undefined` for a choice that cannot be read: a custom
 * range whose To is before its From or whose From is in the future, or `deploy` without a time.
 */
export function rangeFor(choice: RangeChoice, now: number, deployTime?: number, recentMs = RECENT_MS): LogsRange | undefined {
	switch (choice.kind) {
		case 'live':
			return { kind: 'live', from: now, to: null };
		case 'recent':
			return { kind: 'recent', from: now - recentMs, to: null };
		case 'deploy':
			return deployTime !== undefined && Number.isFinite(deployTime) ? { kind: 'deploy', from: Math.min(deployTime, now), to: null } : undefined;
		case 'custom': {
			const { from, to } = choice;
			if (from === undefined || to === undefined || !Number.isFinite(from) || !Number.isFinite(to) || to < from || from > now) {
				return undefined;
			}
			return { kind: 'custom', from, to };
		}
		default:
			return { kind: choice.kind, from: now - (LOOK_BACK[choice.kind] ?? RECENT_MS), to: now };
	}
}

/**
 * How far back one Load older reads: the range's length, at least `RECENT_MS` (the live ranges' own:
 * 15 minutes for the default and for Live; since the last deploy, until it was chosen).
 */
export function olderWindowMs(range: LogsRange, chosenAt: number, recentMs = RECENT_MS): number {
	if (range.kind === 'live' || range.kind === 'recent') {
		return recentMs;
	}
	const end = range.to ?? chosenAt;
	return Math.max(end - range.from, recentMs);
}

/**
 * Older rows before the kept ones, at most `cap` in all. Of `older` (oldest first) its newest `cap`
 * are taken (`leftOut`: how many older ones were not); then, over the cap, the newest of the whole are
 * dropped (`newerDropped`), so what is shown stays one run of records ending where it ends.
 */
export function mergeOlder<T>(older: readonly T[], kept: readonly T[], cap: number): { readonly rows: T[]; readonly leftOut: number; readonly newerDropped: number } {
	const taken = older.slice(Math.max(0, older.length - cap));
	const all = [...taken, ...kept];
	const newerDropped = Math.max(0, all.length - cap);
	return { rows: all.slice(0, all.length - newerDropped), leftOut: older.length - taken.length, newerDropped };
}

/** Whether a read that started at `start` began at the log's first offset on every partition (nothing older is left). */
export function atLogStart(start: LogPositions, logStart: LogPositions): boolean {
	for (const [p, first] of logStart) {
		const at = start.get(p);
		if (at === undefined || at > first) {
			return false;
		}
	}
	return true;
}

/** "7 days", "6 hours", "90 minutes", "1 day". */
export function durationText(ms: number): string {
	const unit = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;
	if (ms >= DAY_MS && ms % DAY_MS === 0) {
		return unit(ms / DAY_MS, 'day');
	}
	if (ms >= HOUR_MS && ms % HOUR_MS === 0) {
		return unit(ms / HOUR_MS, 'hour');
	}
	if (ms >= DAY_MS) {
		return unit(Math.round((ms / DAY_MS) * 10) / 10, 'day');
	}
	if (ms >= HOUR_MS) {
		return unit(Math.round((ms / HOUR_MS) * 10) / 10, 'hour');
	}
	return unit(Math.max(1, Math.round(ms / MINUTE_MS)), 'minute');
}

/** Retention for the menu when DescribeConfigs is refused or fails. */
export const RETENTION_UNKNOWN = 'Only records within the topic\'s retention can be read; older ones are gone.';

/** The menu's retention line from the topic's `retention.ms` (`undefined`: not readable; `-1` or less: no time limit). */
export function retentionText(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms === 0) {
		return RETENTION_UNKNOWN;
	}
	if (ms < 0) {
		return 'The topic keeps its records with no time limit.';
	}
	return `Records older than ${durationText(ms)} are gone (the topic's retention).`;
}
