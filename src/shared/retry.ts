// The waits before a lost read is tried again, shared by the Pipeline Logs panel (ticket 6.6) and the Cloud
// metrics feed (ticket 7.5, AD-25), moved here from `logsProtocol.ts` by the epic 7 refactor sweep (7.10).
// Pure; imports nothing (AD-15).

/** A lost connection is tried again after these waits, then every last one (ticket 6.6, the user's decision of 2026-11-06). */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 30_000, 60_000];

/** The wait before try `attempt` (1 for the first after the loss). */
export function retryDelayMs(attempt: number, delays: readonly number[] = RETRY_DELAYS_MS): number {
	return delays[Math.min(Math.max(attempt, 1), delays.length) - 1];
}
