/**
 * Repository for the `events` table.
 *
 * Each event has an autoincrement `id` and a per-burrow monotonic `seq`. We
 * compute the next seq inside a transaction (SELECT MAX → INSERT) so under
 * SQLite's single-writer model two concurrent appends can't claim the same
 * seq for the same burrow.
 */

import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { DrizzleDb } from "../client.ts";
import { type EventRow, type EventStream, events } from "../schema.ts";

export interface AppendEventInput {
	burrowId: string;
	runId?: string | null;
	kind: string;
	stream: EventStream;
	payload: unknown;
	ts?: Date;
}

export class EventsRepo {
	constructor(private readonly db: DrizzleDb) {}

	append(input: AppendEventInput): EventRow {
		const ts = input.ts ?? new Date();
		return this.db.transaction((tx) => {
			const row = tx
				.select({ max: sql<number | null>`max(${events.seq})` })
				.from(events)
				.where(eq(events.burrowId, input.burrowId))
				.get();
			const nextSeq = (row?.max ?? 0) + 1;
			const inserted = tx
				.insert(events)
				.values({
					burrowId: input.burrowId,
					runId: input.runId ?? null,
					seq: nextSeq,
					kind: input.kind,
					stream: input.stream,
					payloadJson: input.payload,
					ts,
				})
				.returning()
				.get();
			return inserted;
		});
	}

	listByBurrow(burrowId: string, opts: { sinceSeq?: number; limit?: number } = {}): EventRow[] {
		const where =
			opts.sinceSeq !== undefined
				? and(eq(events.burrowId, burrowId), gt(events.seq, opts.sinceSeq))
				: eq(events.burrowId, burrowId);
		const q = this.db.select().from(events).where(where).orderBy(asc(events.seq));
		return opts.limit ? q.limit(opts.limit).all() : q.all();
	}

	/**
	 * Last N events for a burrow, returned in seq-ascending order
	 * (oldest-first within the window). Powers the dashboard view-model
	 * `eventTail` cap — `listByBurrow({limit})` returns the FIRST N which
	 * is the wrong end for live tail.
	 */
	listTail(burrowId: string, limit: number): EventRow[] {
		if (limit <= 0) return [];
		const rows = this.db
			.select()
			.from(events)
			.where(eq(events.burrowId, burrowId))
			.orderBy(desc(events.seq))
			.limit(limit)
			.all();
		return rows.reverse();
	}

	countByBurrow(burrowId: string): number {
		const row = this.db
			.select({ n: sql<number>`count(*)` })
			.from(events)
			.where(eq(events.burrowId, burrowId))
			.get();
		return row?.n ?? 0;
	}
}
