/**
 * Live snapshot stream for the dashboard view-model (SPEC §26).
 *
 * `streamSnapshots(repos, bus, opts)` is the load-bearing seam between the
 * durable `Repos` state and the live TUI / `burrow watch --json` consumer.
 * The contract mirrors the §14.1 event tail: an async generator that yields
 * a stable wire shape ({@link DashboardSnapshot}) and stops cleanly on a
 * cooperative abort. The data shape is identical to what `burrow serve`
 * will eventually WebSocket-stream — same envelope, two faces.
 *
 * ### Wake sources
 *
 *   1. **EventBus** (push). Subscribing to {@link EventBus.subscribeAll}
 *      gets us a synchronous in-process push the moment the run loop
 *      appends + publishes an event. This is the steady-state path for
 *      agent output (tool_use / tool_result / token stdout).
 *   2. **Polling fallback** (pull). Burrow lifecycle (create / destroy /
 *      state transitions) and run lifecycle (enqueue / running / finalize)
 *      do *not* travel over the bus today — they're plain SQL writes. A
 *      coarse polling timer (default 1s) wakes the loop so those changes
 *      surface in the snapshot without waiting for the next event. The
 *      timer is also the only wake source if the caller passes a quiet
 *      bus (e.g. tests) or the run loop lives in another process.
 *
 * The signal also wakes the loop so abort-aware shutdown is immediate
 * (no waiting for the next coalesce window).
 *
 * ### Coalescing
 *
 * Wakes are folded through a sticky latch (`pendingWake`) and a trailing
 * timer of `coalesceMs` (default 100ms): the first wake arms the timer,
 * further wakes during the window are absorbed, and a single fresh
 * snapshot is yielded when the window closes. A burst of N events
 * therefore produces ≤2 emissions: one at the close of the burst's
 * window, plus at most one trailing emission that captures the last
 * wake set during the previous yield (acceptance §pl-2085#7).
 *
 * Rebuild-from-scratch is intentional: at V1 scale a snapshot is a few
 * indexed reads per burrow, and a fresh build keeps the wire envelope
 * self-contained — consumers never need to merge diffs. See pl-2085
 * risks for the rationale against diffing.
 *
 * ### Leak-free
 *
 * The bus subscription, polling timer, and abort listener are all torn
 * down in a single `finally` block, so the generator is safe to stop via
 * `break` / `return` / abort / consumer error (acceptance §pl-2085#8).
 */

import type { Repos } from "../db/repos/index.ts";
import type { EventBus } from "../events/tail.ts";
import { type BuildSnapshotOptions, buildSnapshot } from "./snapshot.ts";
import type { DashboardSnapshot } from "./types.ts";

/**
 * Default coalescing window. Chosen so a burst of agent output (typically
 * tens of events in a few ms) yields one snapshot and leaves the consumer
 * room to redraw at ~10Hz worst-case.
 */
export const DEFAULT_COALESCE_MS = 100;

/**
 * Default polling fallback interval. Burrow + run state changes don't go
 * over the bus, so we re-poll periodically to surface them. 1s is the
 * sweet spot between TUI freshness and SQLite read overhead at V1 scale;
 * pass a smaller value in tests for determinism, or `0` to disable.
 */
export const DEFAULT_POLL_FALLBACK_MS = 1000;

export interface StreamSnapshotsOptions {
	/** Cooperative abort. Closes the stream and tears down listeners. */
	signal?: AbortSignal;
	/**
	 * Trailing-edge coalescing window in ms. Default
	 * {@link DEFAULT_COALESCE_MS}. `0` disables coalescing — every wake
	 * yields a snapshot (useful in tests).
	 */
	coalesceMs?: number;
	/**
	 * Polling fallback interval in ms. Default
	 * {@link DEFAULT_POLL_FALLBACK_MS}. `0` disables polling entirely;
	 * the stream then only wakes on bus events or abort.
	 */
	pollIntervalMs?: number;
	/**
	 * Yield a snapshot of current state immediately on subscription.
	 * Default `true` — consumers always have a starting frame to render.
	 */
	emitInitial?: boolean;
	/** Forwarded to {@link buildSnapshot}. */
	runsLimit?: number;
	/** Forwarded to {@link buildSnapshot}. */
	eventTailCap?: number;
	/**
	 * Time source called once per yielded snapshot. Defaults to the
	 * builder's own `new Date()`. Tests pass an injected function for
	 * deterministic envelope `ts`.
	 */
	now?: () => Date;
}

/**
 * Yield a {@link DashboardSnapshot} per coalesced wake until aborted.
 * See module JSDoc for wake sources, coalescing semantics, and cleanup
 * guarantees.
 */
export async function* streamSnapshots(
	repos: Repos,
	bus: EventBus,
	opts: StreamSnapshotsOptions = {},
): AsyncGenerator<DashboardSnapshot, void, void> {
	const coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_FALLBACK_MS;
	const emitInitial = opts.emitInitial ?? true;
	const { signal } = opts;

	if (signal?.aborted) return;

	let pendingWake = false;
	let wakeResolver: (() => void) | null = null;
	const wake = (): void => {
		pendingWake = true;
		if (wakeResolver !== null) {
			const resolve = wakeResolver;
			wakeResolver = null;
			resolve();
		}
	};
	const waitForWake = (): Promise<void> => {
		if (pendingWake) {
			pendingWake = false;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			wakeResolver = resolve;
		});
	};

	const subscription = bus.subscribeAll(() => wake());
	const pollTimer = pollIntervalMs > 0 ? setInterval(wake, pollIntervalMs) : null;
	const onAbort = (): void => wake();
	if (signal) signal.addEventListener("abort", onAbort, { once: true });

	const buildOnce = (): DashboardSnapshot => buildSnapshot(repos, snapshotOpts(opts));

	try {
		if (emitInitial) {
			yield buildOnce();
		}
		while (!signal?.aborted) {
			await waitForWake();
			if (signal?.aborted) return;
			if (coalesceMs > 0) {
				if (await sleepOrAbort(coalesceMs, signal)) return;
			}
			// Reset right before sampling: any wake fired while the snapshot
			// is being built or yielded sets pendingWake again and is picked
			// up on the next iteration.
			pendingWake = false;
			yield buildOnce();
		}
	} finally {
		subscription.unsubscribe();
		if (pollTimer !== null) clearInterval(pollTimer);
		signal?.removeEventListener("abort", onAbort);
	}
}

function snapshotOpts(opts: StreamSnapshotsOptions): BuildSnapshotOptions {
	const out: BuildSnapshotOptions = {};
	if (opts.now !== undefined) out.now = opts.now();
	if (opts.runsLimit !== undefined) out.runsLimit = opts.runsLimit;
	if (opts.eventTailCap !== undefined) out.eventTailCap = opts.eventTailCap;
	return out;
}

/**
 * Resolves `false` after `ms` or `true` if the signal aborted first.
 * Mirrors the helper in `events/poll.ts` + `events/tail.ts` (kept local
 * so the dashboard module has no event-system dependency beyond
 * `EventBus`).
 */
function sleepOrAbort(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(false);
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		if (signal) {
			if (signal.aborted) {
				clearTimeout(timer);
				resolve(true);
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}
