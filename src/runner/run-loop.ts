/**
 * Per-burrow run loop (SPEC §5.1).
 *
 * Each burrow has its own p-queue with concurrency 1, so runs against a
 * single burrow execute strictly FIFO while distinct burrows run in parallel
 * (capped by `globalConcurrency`). The actual agent spawn is delegated to a
 * `RunHandler` injected by the caller — Phase 4 supplies the implementation
 * that drives `BurrowProvider` + `AgentRuntime`.
 *
 * `start()` performs the crash-recovery sweep, then re-enqueues any runs
 * still sitting in `queued` (e.g. because the previous process died after
 * insert but before the handler took them). `stop()` waits for in-flight
 * handlers to finish (or, if `force`, cancels them via the AbortSignal).
 */

import PQueue from "p-queue";
import { type RecoverySweepResult, runStartupRecovery } from "../db/recovery.ts";
import type { Repos } from "../db/repos/index.ts";
import type { RunRow } from "../db/schema.ts";
import type { Logger } from "../logging/logger.ts";

export interface RunOutcome {
	state: "succeeded" | "failed" | "cancelled";
	exitCode?: number | null;
	errorMessage?: string | null;
}

export interface RunHandlerContext {
	run: RunRow;
	signal: AbortSignal;
	repos: Repos;
}

export type RunHandler = (ctx: RunHandlerContext) => Promise<RunOutcome>;

export interface RunLoopOptions {
	repos: Repos;
	handler: RunHandler;
	logger?: Logger;
	/** Hard cap on concurrent burrows being driven at once. */
	globalConcurrency?: number;
}

interface BurrowQueue {
	queue: PQueue;
	abort: AbortController;
}

export class RunLoop {
	private readonly repos: Repos;
	private readonly handler: RunHandler;
	private readonly logger: Logger | undefined;
	private readonly burrowQueues = new Map<string, BurrowQueue>();
	private readonly globalQueue: PQueue;
	private started = false;
	private stopped = false;

	constructor(opts: RunLoopOptions) {
		this.repos = opts.repos;
		this.handler = opts.handler;
		this.logger = opts.logger;
		this.globalQueue = new PQueue({ concurrency: opts.globalConcurrency ?? 8 });
	}

	/**
	 * Sweep crashed state, then re-enqueue any leftover queued runs. Idempotent.
	 */
	start(): { recovered: RecoverySweepResult } {
		if (this.started) {
			return { recovered: { failedRunIds: [], resetMessageIds: [], prunedBurrowIds: [] } };
		}
		this.started = true;
		const recovered = runStartupRecovery(this.repos);
		if (
			recovered.failedRunIds.length > 0 ||
			recovered.resetMessageIds.length > 0 ||
			recovered.prunedBurrowIds.length > 0
		) {
			this.logger?.warn(
				{
					failedRunIds: recovered.failedRunIds,
					resetMessageIds: recovered.resetMessageIds,
					prunedBurrowIds: recovered.prunedBurrowIds,
				},
				"crash-recovery sweep applied",
			);
		}
		const queued = this.repos.runs.listByState("queued");
		for (const run of queued) this.enqueue(run.id);
		return { recovered };
	}

	/**
	 * Schedule execution of a run that has already been inserted as `queued`.
	 * Safe to call multiple times for the same id; the claim transaction in
	 * RunsRepo prevents double-execution.
	 */
	enqueue(runId: string): Promise<void> {
		if (this.stopped) {
			throw new Error("RunLoop is stopped; cannot enqueue new runs");
		}
		const run = this.repos.runs.get(runId);
		if (!run) {
			this.logger?.warn({ runId }, "enqueue called for unknown run");
			return Promise.resolve();
		}
		if (run.state !== "queued") {
			return Promise.resolve();
		}
		const burrowQueue = this.queueFor(run.burrowId);
		return this.globalQueue.add(() =>
			burrowQueue.queue.add(() => this.execute(runId, burrowQueue.abort.signal)),
		) as Promise<void>;
	}

	private queueFor(burrowId: string): BurrowQueue {
		let bq = this.burrowQueues.get(burrowId);
		if (!bq) {
			bq = { queue: new PQueue({ concurrency: 1 }), abort: new AbortController() };
			this.burrowQueues.set(burrowId, bq);
		}
		return bq;
	}

	private async execute(runId: string, signal: AbortSignal): Promise<void> {
		const claimed = this.repos.runs.claimById(runId);
		if (!claimed) return;

		const log = this.logger?.child({ burrowId: claimed.burrowId, runId: claimed.id });
		log?.info("run started");

		try {
			if (signal.aborted) {
				const finalized = this.repos.runs.finalize(claimed.id, {
					state: "cancelled",
					errorMessage: "run loop aborted",
				});
				if (finalized) log?.warn("run cancelled before handler invocation");
				else log?.warn("run vanished before cancel finalize (destroyed?)");
				return;
			}
			const outcome = await this.handler({ run: claimed, signal, repos: this.repos });
			const finalized = this.repos.runs.finalize(claimed.id, outcome);
			if (finalized) log?.info({ outcome }, "run finalized");
			else log?.warn({ outcome }, "run vanished before finalize (destroyed?)");
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			// finalize tolerates a pruned row (burrow-4855): a concurrent
			// destroy may have removed the run between claim and here.
			const finalized = this.repos.runs.finalize(claimed.id, {
				state: "failed",
				errorMessage,
			});
			if (finalized) log?.error({ err: errorMessage }, "run handler threw");
			else log?.warn({ err: errorMessage }, "run handler threw after run vanished (destroyed?)");
		}
	}

	/**
	 * Drain in-flight runs. With `force: true`, signals abort to every burrow
	 * queue so handlers can short-circuit and exit; runs that started but
	 * haven't finalized are left for the next startup recovery sweep.
	 */
	async stop(opts: { force?: boolean; timeoutMs?: number } = {}): Promise<void> {
		this.stopped = true;
		if (opts.force) {
			for (const bq of this.burrowQueues.values()) bq.abort.abort();
		}
		const drain = Promise.all([...this.burrowQueues.values()].map((bq) => bq.queue.onIdle())).then(
			() => this.globalQueue.onIdle(),
		);
		if (opts.timeoutMs) {
			await Promise.race([
				drain,
				new Promise<void>((resolve) => setTimeout(resolve, opts.timeoutMs)),
			]);
		} else {
			await drain;
		}
	}

	/**
	 * Drain (or abort) every run queued/in-flight for a single burrow
	 * (burrow-4855). Called by `burrow destroy` before it prunes the
	 * burrow's rows so an in-flight run can't have its row deleted mid-flight
	 * — which would leak the run's sandbox/workspace and crash the finalize
	 * path. With `force` (the destroy default) the burrow's AbortController
	 * fires so the handler short-circuits and tears its sandbox down, then we
	 * wait for the queue to idle. The queue entry is dropped afterwards so a
	 * stale aborted controller can't poison a (re-created) burrow id.
	 */
	async drainBurrow(
		burrowId: string,
		opts: { force?: boolean; timeoutMs?: number } = {},
	): Promise<void> {
		const bq = this.burrowQueues.get(burrowId);
		if (!bq) return;
		if (opts.force) bq.abort.abort();
		const idle = bq.queue.onIdle();
		if (opts.timeoutMs) {
			await Promise.race([idle, new Promise<void>((r) => setTimeout(r, opts.timeoutMs))]);
		} else {
			await idle;
		}
		// Only discard a fully-drained queue; a timeout race may have left
		// work behind, and dropping it would orphan the in-flight handler.
		if (bq.queue.size + bq.queue.pending === 0) {
			this.burrowQueues.delete(burrowId);
		}
	}

	/** Visible for tests: returns true when no work is pending or in-flight. */
	isIdle(): boolean {
		if (this.globalQueue.size + this.globalQueue.pending > 0) return false;
		for (const bq of this.burrowQueues.values()) {
			if (bq.queue.size + bq.queue.pending > 0) return false;
		}
		return true;
	}
}
