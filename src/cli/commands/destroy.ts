/**
 * `burrow destroy <id>...` — tear down workspace + archive events (SPEC §14.4, §16).
 *
 * The per-id orchestration lives in `src/lib/destroy.ts:destroyBurrowFully`,
 * which the HTTP `DELETE /burrows/:id` handler also funnels through. This
 * command is the batch front-end: it loops over ids, captures per-id
 * outcomes (incl. `workspaceRemoved`), and renders them.
 */

import type { Client } from "../../lib/client.ts";
import { type DestroyBurrowFullyOutcome, destroyBurrowFully } from "../../lib/destroy.ts";
import type { RemoveWorkspaceOptions } from "../../provider/local/workspace.ts";

export interface DestroyCommandOptions {
	noArchive?: boolean;
	force?: boolean;
	keepWorkspace?: boolean;
	json?: boolean;
}

export interface DestroyCommandInput {
	client: Client;
	burrowIds: string[];
	options: DestroyCommandOptions;
	/** Test seam: override the workspace remover. */
	removeWorkspace?: (opts: RemoveWorkspaceOptions) => Promise<void>;
}

export interface DestroyCommandOutcome {
	id: string;
	ok: boolean;
	archive: DestroyBurrowFullyOutcome["archive"] | null;
	workspaceRemoved: boolean;
	error?: string;
}

export interface DestroyCommandResult {
	outcomes: DestroyCommandOutcome[];
}

export async function runDestroyCommand(input: DestroyCommandInput): Promise<DestroyCommandResult> {
	const outcomes: DestroyCommandOutcome[] = [];

	for (const id of input.burrowIds) {
		const outcome: DestroyCommandOutcome = {
			id,
			ok: false,
			archive: null,
			workspaceRemoved: false,
		};
		try {
			const full = await destroyBurrowFully(input.client, id, {
				archive: !input.options.noArchive,
				...(input.options.keepWorkspace !== undefined
					? { keepWorkspace: input.options.keepWorkspace }
					: {}),
				...(input.options.force !== undefined ? { force: input.options.force } : {}),
				...(input.removeWorkspace ? { removeWorkspace: input.removeWorkspace } : {}),
			});
			outcome.ok = true;
			outcome.workspaceRemoved = full.workspaceRemoved;
			outcome.archive = full.alreadyDestroyed ? null : full.archive;
		} catch (err) {
			outcome.error = err instanceof Error ? err.message : String(err);
		}
		outcomes.push(outcome);
	}

	return { outcomes };
}

export function renderDestroyResult(result: DestroyCommandResult): string {
	return result.outcomes
		.map((o) => {
			if (!o.ok) return `✗ ${o.id}: ${o.error ?? "failed"}`;
			const ws = o.workspaceRemoved ? "workspace removed" : "workspace kept";
			const archive = o.archive?.archived ? "archived" : "no archive";
			return `✓ ${o.id} destroyed (${ws}, ${archive})`;
		})
		.join("\n");
}
