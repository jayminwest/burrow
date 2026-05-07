/**
 * `burrow watch` — multi-burrow live dashboard (post-V1, pl-2085 step 7).
 *
 * Two faces against the same `DashboardSnapshot` view-model:
 *   - **TUI** (default when stdout is a TTY): drives `runTui` against the
 *     project DB + in-process `EventBus`, alt-screen + raw-mode UI.
 *   - **NDJSON** (`--json`, or default when stdout is not a TTY): emits one
 *     `DashboardSnapshot` per line — the same wire shape `burrow serve` will
 *     eventually WebSocket-stream. `--once` collapses the stream to the
 *     first snapshot and exits, useful for scripted readers.
 *
 * Mirrors the auto-pick TTY/JSON convention used by `burrow events` and
 * `burrow logs` (mx-aed4e0). Long-running follow paths (the TUI itself, and
 * NDJSON without `--once`) are torn down by the CLI's SIGINT/SIGTERM
 * AbortController.
 */

import { ValidationError } from "../../core/errors.ts";
import { streamSnapshots } from "../../dashboard/stream.ts";
import { runTui, type TuiQuitReason, type TuiStdin, type TuiStdout } from "../../dashboard/tui.ts";
import type { TermSize } from "../../dashboard/tui-render.ts";
import type { Client } from "../../lib/client.ts";

export interface WatchCommandOptions {
	/** Force NDJSON mode. Default behaviour: NDJSON when stdout is not a TTY. */
	json?: boolean;
	/** NDJSON only: emit the first snapshot and exit. Ignored in TUI mode. */
	once?: boolean;
	/** Forwarded to {@link streamSnapshots}. */
	coalesceMs?: number;
	/** Forwarded to {@link streamSnapshots}. */
	pollIntervalMs?: number;
	/** Forwarded to {@link streamSnapshots}. */
	runsLimit?: number;
	/** Forwarded to {@link streamSnapshots}. */
	eventTailCap?: number;
	/** TUI only: SIGWINCH debounce window. */
	resizeDebounceMs?: number;
}

export interface WatchCommandInput {
	client: Client;
	options: WatchCommandOptions;
	stdout: NodeJS.WritableStream & TuiStdout;
	/** Defaults to `process.stdin` inside the TUI runtime; ignored in NDJSON. */
	stdin?: TuiStdin;
	/** Cooperative abort. CLI wires SIGINT/SIGTERM here. */
	signal?: AbortSignal;
	/** TTY hint — defaults to checking process.stdout when omitted. */
	isTty?: boolean;
	/** Injected resize subscriber (TUI only). */
	onResize?: (handler: () => void) => () => void;
	/** Injected initial term size (TUI only). */
	initialTermSize?: TermSize;
}

export interface WatchCommandSummary {
	mode: "tui" | "json";
	/** NDJSON: number of snapshots written. TUI: 0. */
	emitted: number;
	/** TUI only. */
	framesRendered?: number;
	/** TUI only. */
	quitReason?: TuiQuitReason;
	/** NDJSON only. */
	stoppedReason?: "once" | "abort" | "drained";
}

export function parseNonNegative(raw: string | undefined, flag: string): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0 || String(n) !== raw) {
		throw new ValidationError(`${flag} expects a non-negative integer, got '${raw}'`);
	}
	return n;
}

export function parsePositive(raw: string | undefined, flag: string): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0 || String(n) !== raw) {
		throw new ValidationError(`${flag} expects a positive integer, got '${raw}'`);
	}
	return n;
}

export async function runWatchCommand(input: WatchCommandInput): Promise<WatchCommandSummary> {
	const json = resolveJsonMode(input.options.json, input.isTty);
	if (json) return runJsonMode(input);
	return runTuiMode(input);
}

async function runJsonMode(input: WatchCommandInput): Promise<WatchCommandSummary> {
	const streamOpts: Parameters<typeof streamSnapshots>[2] = {};
	if (input.signal) streamOpts.signal = input.signal;
	if (input.options.coalesceMs !== undefined) streamOpts.coalesceMs = input.options.coalesceMs;
	if (input.options.pollIntervalMs !== undefined)
		streamOpts.pollIntervalMs = input.options.pollIntervalMs;
	if (input.options.runsLimit !== undefined) streamOpts.runsLimit = input.options.runsLimit;
	if (input.options.eventTailCap !== undefined)
		streamOpts.eventTailCap = input.options.eventTailCap;

	let emitted = 0;
	let stoppedReason: "once" | "abort" | "drained" = "drained";
	const stream = streamSnapshots(input.client.repos, input.client.bus, streamOpts);
	for await (const snapshot of stream) {
		input.stdout.write(`${JSON.stringify(snapshot)}\n`);
		emitted += 1;
		if (input.options.once) {
			stoppedReason = "once";
			await stream.return();
			break;
		}
	}
	if (stoppedReason !== "once") {
		stoppedReason = input.signal?.aborted ? "abort" : "drained";
	}
	return { mode: "json", emitted, stoppedReason };
}

async function runTuiMode(input: WatchCommandInput): Promise<WatchCommandSummary> {
	const tuiOpts: Parameters<typeof runTui>[0] = {
		repos: input.client.repos,
		bus: input.client.bus,
	};
	if (input.signal) tuiOpts.signal = input.signal;
	if (input.stdin) tuiOpts.stdin = input.stdin;
	tuiOpts.stdout = input.stdout;
	if (input.onResize) tuiOpts.onResize = input.onResize;
	if (input.initialTermSize) tuiOpts.initialTermSize = input.initialTermSize;
	if (input.options.resizeDebounceMs !== undefined)
		tuiOpts.resizeDebounceMs = input.options.resizeDebounceMs;
	if (input.options.coalesceMs !== undefined) tuiOpts.coalesceMs = input.options.coalesceMs;
	if (input.options.pollIntervalMs !== undefined)
		tuiOpts.pollIntervalMs = input.options.pollIntervalMs;
	if (input.options.runsLimit !== undefined) tuiOpts.runsLimit = input.options.runsLimit;
	if (input.options.eventTailCap !== undefined) tuiOpts.eventTailCap = input.options.eventTailCap;

	const summary = await runTui(tuiOpts);
	return {
		mode: "tui",
		emitted: 0,
		framesRendered: summary.framesRendered,
		quitReason: summary.quitReason,
	};
}

function resolveJsonMode(flag: boolean | undefined, tty: boolean | undefined): boolean {
	if (flag !== undefined) return flag;
	if (tty === undefined) return !process.stdout.isTTY;
	return !tty;
}
