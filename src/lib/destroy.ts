/**
 * Per-id orchestration for the SPEC §14.4 destroy flow.
 *
 * Composes the three side-effects in the right order:
 *   1. Stop the burrow if it is still active.
 *   2. Remove the workspace (worktree + branch) unless `keepWorkspace`.
 *   3. Archive + prune live rows + mark destroyed (delegates to
 *      `destroyBurrowStorage`).
 *
 * Both the `bw destroy` CLI command and the HTTP `DELETE /burrows/:id`
 * handler funnel through this helper so the cleanup contract is identical
 * across surfaces. Pre-fix (burrow-a79f), only the CLI did workspace
 * teardown — the HTTP path archived the row but left the worktree + branch
 * on disk.
 */

import type { Burrow } from "../core/types.ts";
import { type DestroyBurrowResult, destroyBurrowStorage } from "../events/destroy.ts";
import {
	extractWorkspaceSource,
	type RemoveWorkspaceOptions,
	removeMaterializedWorkspace,
} from "../provider/local/workspace.ts";
import type { Client } from "./client.ts";

export interface DestroyBurrowFullyOptions {
	archive?: boolean;
	keepWorkspace?: boolean;
	force?: boolean;
	/** Test seam: override the workspace remover. */
	removeWorkspace?: (opts: RemoveWorkspaceOptions) => Promise<void>;
	/**
	 * Coordinate with the run dispatcher (burrow-4855). Invoked after the
	 * burrow is stopped but before its workspace is removed and its rows are
	 * pruned, so any in-flight run on this burrow is aborted + drained first.
	 * Wired by the `RunDispatcher` via `client.burrows.setOnDestroy`; the
	 * library-only / inline paths leave it unset (no loop to drain).
	 */
	drainRuns?: (burrowId: string) => Promise<void>;
}

export interface DestroyBurrowFullyOutcome {
	archive: DestroyBurrowResult;
	workspaceRemoved: boolean;
	alreadyDestroyed: boolean;
}

export async function destroyBurrowFully(
	client: Client,
	burrowId: string,
	options: DestroyBurrowFullyOptions = {},
): Promise<DestroyBurrowFullyOutcome> {
	const burrow = client.burrows.get(burrowId);
	if (burrow.state === "destroyed") {
		return {
			archive: {
				burrowId,
				archived: null,
				deletedEvents: 0,
				deletedMessages: 0,
				deletedRuns: 0,
			},
			workspaceRemoved: false,
			alreadyDestroyed: true,
		};
	}
	if (burrow.state === "active") {
		client.burrows.stop(burrowId);
	}
	// Stop first (so no fresh run starts), then drain any in-flight run on
	// this burrow before touching its workspace/rows (burrow-4855). Without
	// this, pruneLiveRows can delete a running run's row mid-flight, crashing
	// finalize and leaking the run's sandbox.
	await options.drainRuns?.(burrowId);
	const remover = options.removeWorkspace ?? removeMaterializedWorkspace;
	const workspaceRemoved = options.keepWorkspace
		? false
		: await tryRemoveWorkspace(burrow, remover, options.force);
	const archive = await destroyBurrowStorage({
		db: client.db,
		burrowId,
		archiveRoot: client.paths.archiveDir,
		...(options.archive !== undefined ? { archive: options.archive } : {}),
	});
	return { archive, workspaceRemoved, alreadyDestroyed: false };
}

async function tryRemoveWorkspace(
	burrow: Burrow,
	remover: (opts: RemoveWorkspaceOptions) => Promise<void>,
	force: boolean | undefined,
): Promise<boolean> {
	const source = extractWorkspaceSource(burrow);
	if (!source) return false;
	try {
		await remover({
			workspacePath: burrow.workspacePath,
			source,
			...(force !== undefined ? { force } : {}),
		});
		return true;
	} catch {
		return false;
	}
}
