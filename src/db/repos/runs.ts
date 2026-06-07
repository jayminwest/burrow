/**
 * Repository for the `runs` table.
 *
 * The run loop calls `enqueue` (insert queued), `markRunning` when it claims
 * a run, and `finalize` to write the terminal state. `claimQueued` is the
 * crash-aware dispatch helper: it transitions queued → running atomically so
 * two concurrent loops can't grab the same row.
 */

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { NotFoundError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import {
	assertRunTransition,
	RUN_TERMINAL_STATES,
	type RunState,
} from "../../core/state-machine.ts";
import type { DrizzleDb } from "../client.ts";
import { events, type RunRow, runs } from "../schema.ts";

export interface EnqueueRunInput {
	id?: string;
	burrowId: string;
	agentId: string;
	prompt: string;
	resumeOfRunId?: string | null;
	metadata?: unknown;
	now?: Date;
}

export interface FinalizeRunInput {
	state: Extract<RunState, "succeeded" | "failed" | "cancelled">;
	exitCode?: number | null;
	errorMessage?: string | null;
	now?: Date;
}

export class RunsRepo {
	constructor(private readonly db: DrizzleDb) {}

	enqueue(input: EnqueueRunInput): RunRow {
		const now = input.now ?? new Date();
		const row: RunRow = {
			id: input.id ?? generateId("run"),
			burrowId: input.burrowId,
			agentId: input.agentId,
			prompt: input.prompt,
			resumeOfRunId: input.resumeOfRunId ?? null,
			state: "queued",
			exitCode: null,
			errorMessage: null,
			metadataJson: input.metadata ?? null,
			queuedAt: now,
			startedAt: null,
			completedAt: null,
		};
		this.db.insert(runs).values(row).run();
		return row;
	}

	get(id: string): RunRow | null {
		return this.db.select().from(runs).where(eq(runs.id, id)).get() ?? null;
	}

	require(id: string): RunRow {
		const row = this.get(id);
		if (!row) throw new NotFoundError(`run not found: ${id}`);
		return row;
	}

	listByBurrow(burrowId: string, limit = 50): RunRow[] {
		return this.db
			.select()
			.from(runs)
			.where(eq(runs.burrowId, burrowId))
			.orderBy(desc(runs.queuedAt))
			.limit(limit)
			.all();
	}

	listByState(state: RunState | RunState[]): RunRow[] {
		const where = Array.isArray(state) ? inArray(runs.state, state) : eq(runs.state, state);
		return this.db.select().from(runs).where(where).orderBy(asc(runs.queuedAt)).all();
	}

	listQueuedByBurrow(burrowId: string): RunRow[] {
		return this.db
			.select()
			.from(runs)
			.where(and(eq(runs.burrowId, burrowId), eq(runs.state, "queued")))
			.orderBy(asc(runs.queuedAt))
			.all();
	}

	markRunning(id: string, now: Date = new Date()): RunRow {
		const current = this.require(id);
		assertRunTransition(current.state, "running");
		this.db.update(runs).set({ state: "running", startedAt: now }).where(eq(runs.id, id)).run();
		return { ...current, state: "running", startedAt: now };
	}

	/**
	 * Merge a partial object into `metadataJson`. Existing keys are
	 * overwritten by matching patch keys; unrelated keys are preserved.
	 * Used by the dispatcher's `extractMetadata` hook to record resume
	 * tokens (e.g. `session_id`) without disturbing other metadata the
	 * row might already carry.
	 */
	patchMetadata(id: string, patch: Record<string, unknown>): RunRow {
		const current = this.require(id);
		const existing =
			current.metadataJson !== null && typeof current.metadataJson === "object"
				? (current.metadataJson as Record<string, unknown>)
				: {};
		const merged = { ...existing, ...patch };
		this.db.update(runs).set({ metadataJson: merged }).where(eq(runs.id, id)).run();
		return { ...current, metadataJson: merged };
	}

	/**
	 * Write a terminal state onto a run row. Returns `null` when the row no
	 * longer exists — under a concurrent `burrow destroy`, `pruneLiveRows`
	 * can delete a run between claim and finalize (burrow-4855), and the run
	 * loop must tolerate the vanished row rather than throwing
	 * `NotFoundError` on the cleanup path.
	 */
	finalize(id: string, input: FinalizeRunInput): RunRow | null {
		const current = this.get(id);
		if (!current) return null;
		assertRunTransition(current.state, input.state);
		const now = input.now ?? new Date();
		const patch: Partial<RunRow> = {
			state: input.state,
			completedAt: now,
			exitCode: input.exitCode ?? null,
			errorMessage: input.errorMessage ?? null,
		};
		this.db.update(runs).set(patch).where(eq(runs.id, id)).run();
		return { ...current, ...patch };
	}

	/**
	 * Atomically transitions a specific run from `queued` to `running`. Returns
	 * the claimed row, or null if the row no longer exists or is in a state
	 * other than `queued` (e.g. cancelled by an external operation between
	 * enqueue and execute). The transaction prevents two run-loop ticks from
	 * both claiming the same row.
	 */
	claimById(runId: string, now: Date = new Date()): RunRow | null {
		return this.db.transaction((tx) => {
			const row = tx.select().from(runs).where(eq(runs.id, runId)).get();
			if (!row || row.state !== "queued") return null;
			tx.update(runs)
				.set({ state: "running", startedAt: now })
				.where(and(eq(runs.id, runId), eq(runs.state, "queued")))
				.run();
			return { ...row, state: "running" as const, startedAt: now };
		});
	}

	/**
	 * Crash-recovery sweep (SPEC §10.2). Marks every `running` row failed with
	 * a generic error message and the supplied timestamp. Returns the IDs of
	 * the rows that were touched.
	 */
	failAllRunning(message: string, now: Date = new Date()): string[] {
		const stuck = this.db.select({ id: runs.id }).from(runs).where(eq(runs.state, "running")).all();
		if (stuck.length === 0) return [];
		this.db
			.update(runs)
			.set({ state: "failed", errorMessage: message, completedAt: now })
			.where(eq(runs.state, "running"))
			.run();
		return stuck.map((r) => r.id);
	}

	/** Useful for tests: runs that have been finalized (any terminal). */
	listTerminal(): RunRow[] {
		return this.listByState([...RUN_TERMINAL_STATES] as RunState[]);
	}

	/**
	 * Hard-delete a run row plus the events that referenced it (the
	 * `events.run_id` foreign key would otherwise block the delete).
	 * Atomic: SQLite's single-writer model + the explicit transaction
	 * guarantee a partial delete can't strand events behind a removed run.
	 * Callers must pre-check terminal state — the repo only enforces FK
	 * cleanup, not state semantics.
	 */
	delete(id: string): void {
		this.db.transaction((tx) => {
			tx.delete(events).where(eq(events.runId, id)).run();
			tx.delete(runs).where(eq(runs.id, id)).run();
		});
	}
}
