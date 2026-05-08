/**
 * Pure builder for {@link DashboardSnapshot} (SPEC §26).
 *
 * `buildSnapshot(repos)` is the load-bearing seam between the durable domain
 * (rows in SQLite) and the dashboard view-model that the TUI today and
 * `burrow serve` tomorrow both consume. It is deliberately a synchronous,
 * pure projection over `Repos`: same inputs ⇒ same output (modulo the
 * snapshot timestamp, which the caller can pin via `options.now` for tests).
 *
 * Per SPEC §26.4 the projection trims and caps:
 *
 *   - Each {@link BurrowCard} carries up to {@link DEFAULT_RUNS_PER_CARD}
 *     runs (newest-first), enough for the renderer to show recent history
 *     without dragging multi-MB prompt blobs into a snapshot emitted on
 *     every coalesce window.
 *   - Each card carries up to {@link DEFAULT_EVENT_TAIL_CAP} events
 *     (oldest-first within the window). The SQLite event store remains the
 *     source of truth for full replay (SPEC §14.3).
 *   - `Run.prompt` and `Run.metadataJson` are dropped from the wire shape
 *     (see {@link RunSummary}'s JSDoc). Re-add them as optional fields if a
 *     consumer ever needs them — it's an additive change.
 *
 * The builder coalesces nicely (step 3, `streamSnapshots`) because rebuilding
 * from scratch is cheap at V1 scale: a handful of indexed SQLite reads per
 * burrow. Diffing snapshots was rejected in pl-2085's risks.
 */

import type { Repos } from "../db/repos/index.ts";
import type { BurrowRow, EventRow, RunRow } from "../db/schema.ts";
import {
	type BurrowCard,
	DASHBOARD_SNAPSHOT_VERSION,
	type DashboardSnapshot,
	DEFAULT_EVENT_TAIL_CAP,
	type EventTailEntry,
	type RunSummary,
} from "./types.ts";

/**
 * Default cap on the per-burrow run history held in a snapshot. Matches
 * the "typically the last ~20 runs" wording in {@link BurrowCard}'s JSDoc.
 * Kept smaller than the event tail because runs carry derived UI rows
 * (one per card) rather than streaming history.
 */
export const DEFAULT_RUNS_PER_CARD = 20 as const;

export interface BuildSnapshotOptions {
	/**
	 * Snapshot timestamp. Defaults to `new Date()`. Tests pass an explicit
	 * value so the envelope's `ts` field is deterministic.
	 */
	now?: Date;
	/**
	 * Cap on `BurrowCard.runs` length, newest-first. Defaults to
	 * {@link DEFAULT_RUNS_PER_CARD}.
	 */
	runsLimit?: number;
	/**
	 * Cap on `BurrowCard.eventTail` length, oldest-first within the window.
	 * Defaults to {@link DEFAULT_EVENT_TAIL_CAP}.
	 */
	eventTailCap?: number;
}

/**
 * Build a {@link DashboardSnapshot} from current repo state. Pure: returns
 * a fresh object; never mutates `repos`. Order of `burrows[]` mirrors
 * `BurrowsRepo.listAll()` (updated-at desc) — the renderer applies its own
 * sort if it wants something different.
 */
export function buildSnapshot(repos: Repos, options: BuildSnapshotOptions = {}): DashboardSnapshot {
	const now = options.now ?? new Date();
	const runsLimit = options.runsLimit ?? DEFAULT_RUNS_PER_CARD;
	const eventTailCap = options.eventTailCap ?? DEFAULT_EVENT_TAIL_CAP;

	const burrows = repos.burrows
		.listAll()
		.map((row) => buildCard(row, repos, runsLimit, eventTailCap));

	return {
		type: "snapshot",
		version: DASHBOARD_SNAPSHOT_VERSION,
		ts: now.toISOString(),
		burrows,
	};
}

function buildCard(
	row: BurrowRow,
	repos: Repos,
	runsLimit: number,
	eventTailCap: number,
): BurrowCard {
	const runs = repos.runs.listByBurrow(row.id, runsLimit).map(toRunSummary);
	const activeRun = pickActiveRun(runs);
	const eventTail = repos.events.listTail(row.id, eventTailCap).map(toEventTailEntry);
	const lastEventSeq = eventTail.length > 0 ? (eventTail[eventTail.length - 1]?.seq ?? null) : null;

	return {
		id: row.id,
		parentId: row.parentId,
		kind: row.kind,
		name: row.name,
		state: row.state,
		projectRoot: row.projectRoot,
		workspacePath: row.workspacePath,
		branch: row.branch,
		provider: row.provider,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		destroyedAt: row.destroyedAt ? row.destroyedAt.toISOString() : null,
		runs,
		activeRun,
		eventTail,
		lastEventSeq,
	};
}

function toRunSummary(row: RunRow): RunSummary {
	return {
		id: row.id,
		burrowId: row.burrowId,
		agentId: row.agentId,
		state: row.state,
		exitCode: row.exitCode,
		errorMessage: row.errorMessage,
		queuedAt: row.queuedAt.toISOString(),
		startedAt: row.startedAt ? row.startedAt.toISOString() : null,
		completedAt: row.completedAt ? row.completedAt.toISOString() : null,
	};
}

function toEventTailEntry(row: EventRow): EventTailEntry {
	return {
		burrowId: row.burrowId,
		runId: row.runId,
		seq: row.seq,
		kind: row.kind,
		stream: row.stream,
		ts: row.ts.toISOString(),
		payload: row.payloadJson,
	};
}

/**
 * Prefer the most recent `running` run; fall back to the most recent
 * `queued` run. `runs` is newest-first (per `RunsRepo.listByBurrow`), so
 * `find` returns the desired entry without re-sorting. Returns null when
 * the burrow has no in-flight or queued work.
 */
function pickActiveRun(runs: RunSummary[]): RunSummary | null {
	return runs.find((r) => r.state === "running") ?? runs.find((r) => r.state === "queued") ?? null;
}
