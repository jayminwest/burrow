/**
 * Crash-recovery sweep (SPEC §10.2).
 *
 * On startup the run loop is the only writer for runs/messages, so any row
 * left in `running` or `delivered` came from a previous process that didn't
 * exit cleanly (`kill -9`, OOM, panic). This sweep:
 *
 *   1. Marks every `runs.state = 'running'` failed with a generic message.
 *   2. Resets `messages.state = 'delivered'` rows whose target run is
 *      missing or non-terminal back to `unread` so they re-deliver next turn.
 *
 * That's the entire crash-recovery story; there is intentionally no jobs
 * table to reconcile.
 */

import type { Repos } from "./repos/index.ts";

export const CRASH_ERROR_MESSAGE = "process exited unexpectedly";

export interface RecoverySweepResult {
	failedRunIds: string[];
	resetMessageIds: string[];
	prunedBurrowIds: string[];
}

export function runStartupRecovery(repos: Repos, now: Date = new Date()): RecoverySweepResult {
	// Reset orphan deliveries first: the predicate keys off `runs.state IN
	// ('queued', 'running')`, and `failAllRunning` flips every running row to
	// terminal. If we did the sweep in the other order, the messages would
	// look like they were delivered to a (newly) failed run and stay stuck.
	const resetMessageIds = repos.messages.resetDeliveredOrphans();
	const failedRunIds = repos.runs.failAllRunning(CRASH_ERROR_MESSAGE, now);
	// Reap fully-archived destroyed burrows so their rows stop accumulating.
	const prunedBurrowIds = repos.burrows.deleteDestroyed();
	return { failedRunIds, resetMessageIds, prunedBurrowIds };
}
