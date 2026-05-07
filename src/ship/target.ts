/**
 * `ShipTarget` interface — the load-bearing seam for `burrow ship` (SPEC §22 Phase 9).
 *
 * V1 ships three built-ins: tarball (offline, sync, no auth), docker (streaming
 * build events, long-running), and fly (real-world deploy that composes docker).
 * The interface is deliberately the smallest one that makes adding a new target
 * mechanical — define `id`, validate the config, and yield a typed event stream.
 *
 * Targets are pure consumers of `ShipContext`: they receive a workspace, the
 * resolved [ship] config, and an AbortSignal. They never reach into the
 * client/db/registry — that's the CLI's job (see commands/ship.ts).
 */

import type { Burrow } from "../core/types.ts";
import type { Logger } from "../logging/logger.ts";
import type { BurrowToml, BurrowTomlShip } from "../schemas/burrow-toml.ts";

/** A single planned step. `command` is shown in dry-run for transparency. */
export interface ShipPlanStep {
	description: string;
	command?: string[];
	cwd?: string;
}

/** What a target *would* do, surfaced as `--dry-run` JSON or pretty output. */
export interface ShipPlan {
	target: string;
	artifact: string;
	steps: ShipPlanStep[];
	notes?: string[];
}

/** Per-step output and final artifact. The CLI/Client renders these as NDJSON or pretty. */
export type ShipEvent =
	| { kind: "plan"; plan: ShipPlan }
	| { kind: "step.start"; index: number; description: string; command?: string[] }
	| { kind: "step.stdout"; index: number; line: string }
	| { kind: "step.stderr"; index: number; line: string }
	| { kind: "step.end"; index: number; exitCode: number }
	| { kind: "artifact"; path: string; metadata?: Record<string, string> }
	| { kind: "done"; artifact: string };

/** Result of `installCheck()` — used by `burrow ship` to refuse early on missing tools. */
export interface ShipInstallCheck {
	ok: boolean;
	binary?: string;
	path?: string;
	detail?: string;
}

/**
 * Read-only context every target receives. Targets must not mutate fields here —
 * if a target needs scratch space, it allocates its own under `os.tmpdir()`.
 */
export interface ShipContext {
	/** Workspace root on the host. Build steps run with this as cwd. */
	workspace: string;
	/** Optional burrow metadata; absent when shipping from cwd without a burrow. */
	burrow?: Burrow;
	/** Loaded [ship] block. Each target reads only its own sub-section. */
	ship: BurrowTomlShip;
	/** Whole burrow.toml (rare; some targets cross-read [project] for naming). */
	toml?: BurrowToml | null;
	/** Resolved env to layer on every spawned step. */
	env?: Record<string, string>;
	/** When true, target.execute should yield `plan` only, no side-effects. */
	dryRun?: boolean;
	/** ISO timestamp of the ship invocation; targets bake it into artifact names. */
	now: Date;
	/** Cooperative cancellation — propagates SIGINT/SIGTERM from the CLI. */
	signal?: AbortSignal;
	logger?: Logger;
}

/**
 * The interface every ship target implements.
 *
 * Lifecycle:
 *   1. CLI loads burrow.toml + selects target by id.
 *   2. CLI calls `validate(ctx)` — synchronous, throws ValidationError on bad config.
 *   3. CLI calls `installCheck(ctx)` — asynchronous tool probe.
 *   4. CLI calls `plan(ctx)` to emit a ShipPlan; for `--dry-run` it stops here.
 *   5. Otherwise CLI iterates `execute(ctx)` and renders/persists each event.
 *
 * Invariants:
 *   - `execute` yields exactly one `done` event as the last item on success.
 *   - Step indices are 0-based and contiguous; the same index appears in start/stdout/stderr/end.
 *   - On AbortSignal, `execute` cleans up the in-flight child and returns (no `done`).
 */
export interface ShipTarget {
	readonly id: string;
	readonly description: string;
	validate(ctx: ShipContext): void;
	installCheck(ctx: ShipContext): Promise<ShipInstallCheck>;
	plan(ctx: ShipContext): Promise<ShipPlan>;
	execute(ctx: ShipContext): AsyncGenerator<ShipEvent, void, void>;
}
