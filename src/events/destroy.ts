/**
 * Library helper: archive a burrow and prune its live rows (SPEC §14.4).
 *
 * The full `burrow destroy` CLI command lands in Phase 7 with workspace
 * teardown wired through. This module isolates the storage half: archive
 * events/messages/runs, then delete them from the live tables and mark the
 * burrow `destroyed`. Workspace removal is the provider's job and is
 * performed by the destroy CLI before this helper runs.
 *
 * Steps (per SPEC §14.4):
 *   2. Export `events WHERE burrow_id = ?`         → events.jsonl
 *   3. Export messages                              → messages.jsonl
 *   4. Export runs summary                          → runs.json
 *   5. Workspace deletion (caller's responsibility)
 *   6. Delete live rows; set burrow.state='destroyed'
 *
 * `--no-archive` flag corresponds to `archive: false`.
 */

import { eq } from "drizzle-orm";
import type { BurrowDb } from "../db/client.ts";
import { createRepos } from "../db/repos/index.ts";
import { events, messages, runs } from "../db/schema.ts";
import { type ArchiveBurrowResult, archiveBurrow } from "./archive.ts";

export interface DestroyBurrowInput {
	db: BurrowDb;
	burrowId: string;
	archiveRoot: string;
	/** When false, skip the export. The burrow is still marked destroyed. */
	archive?: boolean;
	now?: Date;
}

export interface DestroyBurrowResult {
	burrowId: string;
	archived: ArchiveBurrowResult | null;
	deletedEvents: number;
	deletedMessages: number;
	deletedRuns: number;
}

export async function destroyBurrowStorage(
	input: DestroyBurrowInput,
): Promise<DestroyBurrowResult> {
	const repos = createRepos(input.db);
	repos.burrows.require(input.burrowId);

	let archived: ArchiveBurrowResult | null = null;
	if (input.archive !== false) {
		archived = await archiveBurrow({
			repos,
			burrowId: input.burrowId,
			archiveRoot: input.archiveRoot,
		});
	}

	const counts = pruneLiveRows(input.db, input.burrowId);
	repos.burrows.markDestroyed(input.burrowId, input.now);
	// Return the freed pages to the OS now rather than letting the freelist
	// accumulate across reaped runs. No-op unless auto_vacuum = INCREMENTAL.
	input.db.raw.exec("PRAGMA incremental_vacuum");

	return {
		burrowId: input.burrowId,
		archived,
		deletedEvents: counts.events,
		deletedMessages: counts.messages,
		deletedRuns: counts.runs,
	};
}

function pruneLiveRows(
	db: BurrowDb,
	burrowId: string,
): { events: number; messages: number; runs: number } {
	return db.drizzle.transaction((tx) => {
		const eventCount = tx.select().from(events).where(eq(events.burrowId, burrowId)).all().length;
		const messageCount = tx
			.select()
			.from(messages)
			.where(eq(messages.burrowId, burrowId))
			.all().length;
		const runCount = tx.select().from(runs).where(eq(runs.burrowId, burrowId)).all().length;
		tx.delete(events).where(eq(events.burrowId, burrowId)).run();
		tx.delete(messages).where(eq(messages.burrowId, burrowId)).run();
		tx.delete(runs).where(eq(runs.burrowId, burrowId)).run();
		return { events: eventCount, messages: messageCount, runs: runCount };
	});
}
