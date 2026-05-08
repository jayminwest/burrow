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
	type MaterializedWorkspaceSource,
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

function extractWorkspaceSource(burrow: Burrow): MaterializedWorkspaceSource | null {
	const state = burrow.providerStateJson;
	if (!state || typeof state !== "object") return null;
	const candidate = (state as { workspaceSource?: unknown }).workspaceSource;
	if (!candidate || typeof candidate !== "object") return null;
	const c = candidate as { kind?: unknown; branch?: unknown };
	if ((c.kind !== "worktree" && c.kind !== "clone") || typeof c.branch !== "string") return null;
	return candidate as MaterializedWorkspaceSource;
}
