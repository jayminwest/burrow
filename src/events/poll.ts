/**
 * SQLite-backed event tailer (SPEC §14.3 — "SQLite is the source of truth
 * on disconnect / replay"). Async generator that yields events past
 * `sinceSeq` in monotonic order. Used by the CLI when its process doesn't
 * own the run loop (i.e. always in V1, until `serve` lands), so live tail
 * is just a poll loop on the events table — no daemon, no IPC.
 *
 * `tailBurrow` watches one burrow's seq column. `tailAll` interleaves every
 * active burrow's events by `ts`. Both honour an AbortSignal so callers
 * (CLI handlers, the chat command, tests) can stop without leaking timers.
 *
 * Cancellation is cooperative: the generator wakes either when fresh rows
 * land or when the signal aborts. Pollers default to 200ms; tests that
 * want determinism pass `pollIntervalMs: 0` and feed events synchronously.
 */

import type { RunEvent } from "../core/types.ts";
import { eventRowToEvent } from "../core/types.ts";
import type { Repos } from "../db/repos/index.ts";

export interface TailOptions {
	signal?: AbortSignal;
	/** Skip rows with seq <= sinceSeq. Defaults to 0 (replay everything). */
	sinceSeq?: number;
	/** Polling interval in ms when the table is idle. Default 200. */
	pollIntervalMs?: number;
	/** Stop after the first batch (for `--no-follow` mode). Default false. */
	once?: boolean;
}

export interface TailAllOptions extends Omit<TailOptions, "sinceSeq"> {
	/** Restrict to specific burrow ids (default: all active burrows). */
	burrowIds?: string[];
	/** Per-burrow starting seq. Missing entries default to 0. */
	sinceSeq?: Record<string, number>;
}

const DEFAULT_POLL_MS = 200;

export async function* tailBurrow(
	repos: Repos,
	burrowId: string,
	opts: TailOptions = {},
): AsyncGenerator<RunEvent, void, void> {
	const interval = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
	let cursor = opts.sinceSeq ?? 0;
	while (true) {
		if (opts.signal?.aborted) return;
		const rows = repos.events.listByBurrow(burrowId, { sinceSeq: cursor });
		for (const row of rows) {
			yield eventRowToEvent(row);
			cursor = row.seq;
		}
		if (opts.once) return;
		if (await sleepOrAbort(interval, opts.signal)) return;
	}
}

export async function* tailAll(
	repos: Repos,
	opts: TailAllOptions = {},
): AsyncGenerator<RunEvent, void, void> {
	const interval = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
	const cursors = new Map<string, number>(
		Object.entries(opts.sinceSeq ?? {}).map(([id, seq]) => [id, seq]),
	);
	while (true) {
		if (opts.signal?.aborted) return;
		const burrowIds = opts.burrowIds ?? activeBurrowIds(repos);
		const fresh: RunEvent[] = [];
		for (const burrowId of burrowIds) {
			const cursor = cursors.get(burrowId) ?? 0;
			const rows = repos.events.listByBurrow(burrowId, { sinceSeq: cursor });
			for (const row of rows) fresh.push(eventRowToEvent(row));
			const last = rows[rows.length - 1];
			if (last) cursors.set(burrowId, last.seq);
		}
		fresh.sort(byTimestampThenBurrow);
		for (const event of fresh) yield event;
		if (opts.once) return;
		if (await sleepOrAbort(interval, opts.signal)) return;
	}
}

function activeBurrowIds(repos: Repos): string[] {
	return repos.burrows.listByState("active").map((b) => b.id);
}

function byTimestampThenBurrow(a: RunEvent, b: RunEvent): number {
	const dt = a.ts.getTime() - b.ts.getTime();
	if (dt !== 0) return dt;
	if (a.burrowId !== b.burrowId) return a.burrowId < b.burrowId ? -1 : 1;
	return a.seq - b.seq;
}

/** Returns true if the signal aborted before the timer fired. */
function sleepOrAbort(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
	if (ms <= 0) return Promise.resolve(signal?.aborted ?? false);
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(false);
		}, ms);
		const onAbort = () => {
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
