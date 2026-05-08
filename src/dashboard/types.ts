/**
 * Dashboard view-model (SPEC §26). The view-model is the load-bearing seam
 * between the TUI today and `burrow serve` / web UI tomorrow: both faces
 * consume the same `DashboardSnapshot` shape, so building the contract now
 * keeps the future web frontend a thin wrapper instead of a rewrite.
 *
 * ### Wire shape
 *
 * ```jsonc
 * {
 *   "type": "snapshot",
 *   "version": 1,
 *   "ts": "2026-05-07T19:00:00.000Z",
 *   "burrows": [ /* BurrowCard[] *\/ ]
 * }
 * ```
 *
 * `burrow watch --json` emits one `DashboardSnapshot` per line (NDJSON),
 * exactly the shape `burrow serve` will eventually WebSocket-stream.
 *
 * ### Additive-only versioning (the lock)
 *
 * The envelope follows the same discipline as the §14.1 event envelope:
 *
 * 1. **Existing keys never change semantics or types.** Renaming or
 *    re-typing a field is a breaking change.
 * 2. **New keys may be added.** Consumers MUST ignore unknown top-level
 *    keys and unknown fields on `BurrowCard` / `RunSummary` /
 *    `EventTailEntry`.
 * 3. **`version` only bumps on a breaking change.** A v1 consumer reading
 *    a v1 snapshot with extra fields must keep working. Bumping `version`
 *    is the explicit "breaking" knob and should be avoided in V1.
 * 4. **Optional fields stay optional forever.** Promoting an optional
 *    field to required is breaking.
 * 5. **Enum members may be added; existing members never change.**
 *    Consumers MUST treat unknown `state` / `kind` / `stream` values as
 *    pass-through strings rather than crashing.
 *
 * The companion test (`types.test.ts`) pins the canonical key set per
 * interface — any field rename or removal trips the test, forcing an
 * intentional `version` bump.
 *
 * ### Why a separate file from `src/core/types.ts`
 *
 * Core types describe the durable domain (Burrow, Run, RunEvent, Message).
 * The dashboard view-model is a *projection* of that domain shaped for
 * presentation: derived state (`activeRun`), trimmed payloads
 * (`EventTailEntry` omits the row id), and a capped tail
 * (`eventTail`, default 500 entries — see SPEC §26.4). Keeping the
 * projection in its own module avoids leaking presentation concerns into
 * the core types and lets `burrow serve` grow alongside it.
 */

import type { BurrowKind, BurrowState, EventStream, RunState } from "../db/schema.ts";

export type { BurrowKind, BurrowState, EventStream, RunState };

/**
 * Schema version of the dashboard envelope. V1 is locked; bump only on a
 * breaking change (renamed/removed field, retyped field, removed enum
 * member). Adding fields and adding enum members do NOT bump the version.
 */
export const DASHBOARD_SNAPSHOT_VERSION = 1 as const;
export type DashboardSnapshotVersion = typeof DASHBOARD_SNAPSHOT_VERSION;

/**
 * Default cap on the per-burrow event tail held in a snapshot. Snapshots
 * are best-effort live state; the SQLite event store remains the source of
 * truth for replay (SPEC §14.3). 500 ≈ a few minutes of a chatty agent's
 * output without unbounded memory growth in a long-running watch session.
 */
export const DEFAULT_EVENT_TAIL_CAP = 500 as const;

/**
 * Top-level snapshot envelope. Every `DashboardSnapshot` is self-contained
 * — consumers do not need prior state to render. Snapshots are produced by
 * a pure builder (step 2: `buildSnapshot`) and streamed live (step 3:
 * `streamSnapshots`); both contracts are deliberately downstream of this
 * type.
 */
export interface DashboardSnapshot {
	/** Discriminator. Always the string `"snapshot"`. */
	type: "snapshot";
	/** Schema version; see {@link DASHBOARD_SNAPSHOT_VERSION}. */
	version: DashboardSnapshotVersion;
	/** Snapshot wall-clock timestamp, ISO-8601 with milliseconds. */
	ts: string;
	/**
	 * One card per known burrow. Order is not guaranteed by the envelope
	 * — the renderer applies its own sort (typically active before
	 * stopped, then by `updatedAt` desc).
	 */
	burrows: BurrowCard[];
}

/**
 * One burrow's view-model: identifying metadata, lifecycle state, recent
 * runs, and a capped event tail for the detail pane. Mirrors the
 * `burrows` row shape (SPEC §10) plus derived fields. All timestamps are
 * ISO-8601 strings (not `Date`) so the envelope round-trips through JSON
 * untouched.
 */
export interface BurrowCard {
	id: string;
	/** Parent burrow id when this card represents a forked task burrow. */
	parentId: string | null;
	kind: BurrowKind;
	/** Human-friendly name; null when the burrow was created without one. */
	name: string | null;
	state: BurrowState;
	projectRoot: string;
	workspacePath: string;
	branch: string;
	/** Provider id, e.g. `"local"`. */
	provider: string;
	/** ISO-8601 timestamp. */
	createdAt: string;
	/** ISO-8601 timestamp. */
	updatedAt: string;
	/** ISO-8601 timestamp; null until the burrow is destroyed. */
	destroyedAt: string | null;
	/**
	 * Recent runs for this burrow, newest first. Capped by the builder
	 * (typically the last ~20 runs); use the run history APIs for the
	 * full list.
	 */
	runs: RunSummary[];
	/**
	 * Currently running or queued run, if any. Always present in `runs`
	 * as well — exposed here so the renderer can highlight the active
	 * row without re-scanning.
	 */
	activeRun: RunSummary | null;
	/**
	 * Last N events for this burrow in seq order, oldest first. Capped
	 * at {@link DEFAULT_EVENT_TAIL_CAP} by default. The SQLite store
	 * remains source of truth for full replay.
	 */
	eventTail: EventTailEntry[];
	/**
	 * Highest event seq observed for this burrow at snapshot time, or
	 * null if the burrow has emitted no events. Lets a reconnecting
	 * consumer (web UI post-V1) replay missed events from
	 * `events.seq > lastEventSeq`.
	 */
	lastEventSeq: number | null;
}

/**
 * Lean summary of a single run. Keeps the wire small: the `prompt` and
 * `metadataJson` fields from the row are intentionally omitted because
 * prompts can be many KB and snapshots are emitted per-coalesce-window.
 * If the renderer or web UI later needs them, they can be added as new
 * optional fields without bumping {@link DASHBOARD_SNAPSHOT_VERSION}.
 */
export interface RunSummary {
	id: string;
	burrowId: string;
	agentId: string;
	state: RunState;
	exitCode: number | null;
	errorMessage: string | null;
	/** ISO-8601 timestamp. */
	queuedAt: string;
	/** ISO-8601 timestamp; null while the run is still queued. */
	startedAt: string | null;
	/** ISO-8601 timestamp; null while the run is still in flight. */
	completedAt: string | null;
}

/**
 * One entry in a burrow's event tail. Field set is a strict subset of the
 * §14.1 NDJSON event envelope minus the `type: "event"` discriminator
 * (the snapshot envelope already discriminates), so consumers familiar
 * with `burrow events --follow` parse this shape without surprise.
 *
 * `payload` is `unknown` for the same reason §14.1 leaves it open: the
 * shape varies per `kind`, and unknown kinds are forward-compatible.
 */
export interface EventTailEntry {
	burrowId: string;
	runId: string | null;
	seq: number;
	kind: string;
	stream: EventStream;
	/** ISO-8601 timestamp. */
	ts: string;
	payload: unknown;
}
