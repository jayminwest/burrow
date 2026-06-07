/**
 * `RunDispatcher` — the in-process run executor that `burrow serve` boots
 * alongside its HTTP listener (SPEC §27).
 *
 * Pre-fix history (`burrow-7b97`): `startServer` only mirrored the `Client`
 * wire surface. `POST /burrows/:id/runs` enqueued a row but nothing ever
 * dequeued it — runs sat at `state=queued` forever. This module closes that
 * gap: a single `RunLoop` driven by `dispatchRun`, hooked to
 * `RunsClient.setOnCreated` so HTTP-enqueued runs flow into the loop the
 * instant they're inserted.
 *
 * Lifecycle:
 *   1. `start()` runs the crash-recovery sweep and re-enqueues any rows
 *      already sitting in `queued` from a previous process. Idempotent.
 *   2. After `start()`, every `client.runs.create()` call (CLI library
 *      consumers AND HTTP) notifies the dispatcher and the loop schedules
 *      the run.
 *   3. `stop({force})` drains in-flight handlers (or aborts them with
 *      force=true) and unhooks the create-time callback.
 *
 * The dispatcher is opt-in: library consumers that want HTTP enqueue-only
 * semantics (or use `client` purely as a data layer) don't have to call
 * `startRunDispatcher`. The `Client` itself stays unchanged.
 */

import type { RecoverySweepResult } from "../db/recovery.ts";
import type { Client } from "../lib/client.ts";
import type { Logger } from "../logging/logger.ts";
import type { AgentRuntime, InstallCheckResult } from "../runtime/runtime.ts";
import { dispatchRun, type SpawnFn, type StartProxyFn } from "./dispatch.ts";
import { type RunHandler, RunLoop } from "./run-loop.ts";

export interface RunDispatcherOptions {
	logger?: Logger;
	/** Hard cap on concurrent burrows being driven at once. */
	globalConcurrency?: number;
	/** Test seam forwarded to `dispatchRun`. */
	spawn?: SpawnFn;
	/** Test seam forwarded to `dispatchRun`. */
	startProxy?: StartProxyFn;
	/** Test seam forwarded to `dispatchRun`. */
	installCheck?: (rt: AgentRuntime) => Promise<InstallCheckResult>;
}

export interface RunDispatcherHandle {
	/** Idempotent. Returns the recovery-sweep summary from the underlying RunLoop. */
	start(): { recovered: RecoverySweepResult };
	/** Drain in-flight handlers; with `force`, signals abort to every burrow queue. */
	stop(opts?: { force?: boolean; timeoutMs?: number }): Promise<void>;
	/**
	 * Drain (or abort) in-flight runs for a single burrow before it is
	 * destroyed (burrow-4855). Wired into `client.burrows.setOnDestroy` so a
	 * `DELETE /burrows/:id` waits for the burrow's runs to reach terminal
	 * state — tearing down their sandboxes — before the destroy flow prunes
	 * the rows out from under them.
	 */
	drainBurrow(burrowId: string, opts?: { force?: boolean; timeoutMs?: number }): Promise<void>;
	/**
	 * Visible for tests. True when the loop has nothing pending or in-flight.
	 * Useful as a synchronisation point for "wait for the last enqueued run
	 * to finish" without polling DB state.
	 */
	isIdle(): boolean;
	/**
	 * Drain controller (pl-cb3e step 4 / burrow-79ad). When flipped on
	 * (typically via `POST /admin/drain {drain: true}`) the HTTP layer
	 * starts rejecting new burrow + run creation with 503 `worker_draining`
	 * — but in-flight runs continue to terminal state. The dispatcher
	 * itself stays oblivious to the flag; it only owns the bit so a single
	 * source of truth survives across multiple HTTP listeners.
	 */
	drain: DrainController;
}

/**
 * Drain bit owned by the dispatcher. Read by the createBurrow / createRun
 * handlers (gated to 503 `worker_draining` when set), flipped by the
 * `/admin/drain` admin route. Plain mutable boolean — no events fire on
 * change; the next HTTP request observes the new value via `isDraining()`.
 */
export interface DrainController {
	isDraining(): boolean;
	setDrain(value: boolean): void;
}

export function startRunDispatcher(
	client: Client,
	opts: RunDispatcherOptions = {},
): RunDispatcherHandle {
	const handler: RunHandler = (ctx) => {
		const dispatchInput: Parameters<typeof dispatchRun>[0] = {
			client,
			run: ctx.run,
			signal: ctx.signal,
		};
		if (opts.spawn) dispatchInput.spawn = opts.spawn;
		if (opts.startProxy) dispatchInput.startProxy = opts.startProxy;
		if (opts.installCheck) dispatchInput.installCheck = opts.installCheck;
		return dispatchRun(dispatchInput);
	};

	const loopOpts: ConstructorParameters<typeof RunLoop>[0] = {
		repos: client.repos,
		handler,
	};
	if (opts.logger) loopOpts.logger = opts.logger;
	if (opts.globalConcurrency !== undefined) loopOpts.globalConcurrency = opts.globalConcurrency;
	const loop = new RunLoop(loopOpts);

	let started = false;
	let stopped = false;
	let draining = false;

	const drain: DrainController = {
		isDraining: () => draining,
		setDrain: (value) => {
			draining = value;
		},
	};

	return {
		drain,
		start() {
			if (started) {
				return { recovered: { failedRunIds: [], resetMessageIds: [], prunedBurrowIds: [] } };
			}
			started = true;
			// Wire create-time → enqueue BEFORE starting the loop so the
			// initial sweep in `loop.start()` and any concurrent
			// `client.runs.create()` calls that race the start can't fall
			// into a window where the loop is "running" but the hook isn't
			// installed yet.
			client.runs.setOnCreated((runId) => {
				if (stopped) return;
				// Fire-and-forget: enqueue returns a Promise that resolves
				// when the run is finalized, but `RunsClient.create`
				// returns synchronously to the HTTP handler. The loop's
				// own error path persists failures on the run row.
				loop.enqueue(runId).catch((err) => {
					opts.logger?.error({ err, runId }, "RunDispatcher: enqueue threw");
				});
			});
			// Coordinate destroy with the loop (burrow-4855): a destroy first
			// stops the burrow (so no new run starts) then awaits this hook,
			// which aborts + drains any in-flight run, before pruning rows.
			client.burrows.setOnDestroy((burrowId) => loop.drainBurrow(burrowId, { force: true }));
			return loop.start();
		},
		async stop(stopOpts = {}) {
			if (stopped) return;
			stopped = true;
			client.runs.setOnCreated(null);
			client.burrows.setOnDestroy(null);
			await loop.stop(stopOpts);
		},
		isIdle() {
			return loop.isIdle();
		},
		drainBurrow(burrowId, drainOpts) {
			return loop.drainBurrow(burrowId, drainOpts ?? {});
		},
	};
}
