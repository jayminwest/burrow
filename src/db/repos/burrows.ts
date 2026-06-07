/**
 * Repository for the `burrows` table.
 *
 * Wraps drizzle queries so the rest of the system speaks in domain verbs
 * (`create`, `markStopped`, `markDestroyed`) instead of column updates. State
 * transitions are validated up front so an invalid move fails before we
 * touch the row.
 */

import { and, desc, eq } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import { assertBurrowTransition, type BurrowState } from "../../core/state-machine.ts";
import type { DrizzleDb } from "../client.ts";
import { type BurrowKind, type BurrowRow, burrows } from "../schema.ts";

export interface CreateBurrowInput {
	id?: string;
	parentId?: string | null;
	kind: BurrowKind;
	name?: string | null;
	projectRoot: string;
	workspacePath: string;
	branch: string;
	provider: string;
	providerState?: unknown;
	profile: unknown;
	now?: Date;
}

export class BurrowsRepo {
	constructor(private readonly db: DrizzleDb) {}

	create(input: CreateBurrowInput): BurrowRow {
		if (input.kind === "task" && !input.parentId) {
			throw new ValidationError("task burrows require a parentId");
		}
		const now = input.now ?? new Date();
		const row: BurrowRow = {
			id: input.id ?? generateId("burrow"),
			parentId: input.parentId ?? null,
			kind: input.kind,
			name: input.name ?? null,
			projectRoot: input.projectRoot,
			workspacePath: input.workspacePath,
			branch: input.branch,
			provider: input.provider,
			providerStateJson: input.providerState ?? null,
			profileJson: input.profile,
			state: "active",
			createdAt: now,
			updatedAt: now,
			destroyedAt: null,
		};
		this.db.insert(burrows).values(row).run();
		return row;
	}

	get(id: string): BurrowRow | null {
		return this.db.select().from(burrows).where(eq(burrows.id, id)).get() ?? null;
	}

	require(id: string): BurrowRow {
		const row = this.get(id);
		if (!row) {
			throw new NotFoundError(`burrow not found: ${id}`, {
				recoveryHint: "run `burrow list` to see known ids",
			});
		}
		return row;
	}

	listByState(state: BurrowState, kind?: BurrowKind): BurrowRow[] {
		const where = kind
			? and(eq(burrows.state, state), eq(burrows.kind, kind))
			: eq(burrows.state, state);
		return this.db.select().from(burrows).where(where).orderBy(desc(burrows.updatedAt)).all();
	}

	listAll(): BurrowRow[] {
		return this.db.select().from(burrows).orderBy(desc(burrows.updatedAt)).all();
	}

	private transition(id: string, to: BurrowState, now: Date): BurrowRow {
		const current = this.require(id);
		assertBurrowTransition(current.state, to);
		const patch: Partial<BurrowRow> = {
			state: to,
			updatedAt: now,
		};
		if (to === "destroyed") patch.destroyedAt = now;
		this.db.update(burrows).set(patch).where(eq(burrows.id, id)).run();
		return { ...current, ...patch };
	}

	markStopped(id: string, now: Date = new Date()): BurrowRow {
		return this.transition(id, "stopped", now);
	}

	markActive(id: string, now: Date = new Date()): BurrowRow {
		return this.transition(id, "active", now);
	}

	markDestroyed(id: string, now: Date = new Date()): BurrowRow {
		return this.transition(id, "destroyed", now);
	}

	/**
	 * Delete every burrow row already in the terminal `destroyed` state and
	 * return their ids. Destroyed burrows have had their events/messages/runs
	 * archived and pruned, so the row is dead weight; without this sweep they
	 * accumulate forever (one per ephemeral run). Run from startup recovery so
	 * within-session idempotency (state === "destroyed") still holds.
	 */
	deleteDestroyed(): string[] {
		const rows = this.db
			.select({ id: burrows.id })
			.from(burrows)
			.where(eq(burrows.state, "destroyed"))
			.all();
		if (rows.length === 0) return [];
		this.db.delete(burrows).where(eq(burrows.state, "destroyed")).run();
		return rows.map((r) => r.id);
	}
}
