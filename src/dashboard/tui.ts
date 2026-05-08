/**
 * TUI runtime for `burrow watch` (SPEC §26).
 *
 * This is the only impure piece of the dashboard stack: it owns alt-screen
 * entry/exit, raw-mode stdin, the SIGWINCH resize listener, and the snapshot
 * stream consumer. Everything between a keypress and a frame is pure
 * (`tui-state.ts` reduces; `tui-render.ts` renders).
 *
 * ```text
 *   stdin bytes ─translate─▶ KeyName ─reduce─▶ ViewState ┐
 *                                                        ├─renderSnapshot─▶ frame ─▶ stdout
 *                       streamSnapshots ─▶ DashboardSnapshot ┘
 * ```
 *
 * ### Lifecycle
 *
 *   1. Enter alt-screen + hide cursor.
 *   2. Set stdin raw, attach `data` listener for keypress translation.
 *   3. Subscribe to SIGWINCH (debounced) for redraws on resize.
 *   4. Consume `streamSnapshots(repos, bus)`; render every coalesced frame.
 *   5. Exit on `q` / Ctrl+C / external `signal` abort / stream end.
 *   6. `finally`: detach stdin listener, restore raw mode, dispose resize,
 *      show cursor, exit alt-screen. Symmetric teardown is the contract
 *      the integration tests pin (acceptance §pl-2085#6).
 *
 * ### Wake sources for redraw
 *
 *   - **New snapshot** from the stream → re-`syncToSnapshot` and render.
 *   - **Keypress** → reduce; render only if `ViewState` actually changed.
 *   - **Resize (SIGWINCH)** → debounced trailing-edge render against the
 *     latest `termSize`. Per pl-2085 risk #2, debouncing avoids torn
 *     output during rapid resize storms.
 *
 * ### Cooperative shutdown
 *
 * The runtime owns an internal `AbortController`. The external
 * `opts.signal` (typically wired to SIGINT/SIGTERM by the CLI) propagates
 * into it; pressing `q` (or Ctrl+C in raw mode, which the OS does *not*
 * translate to SIGINT) also aborts it. Either path tears the stream down
 * via the same `finally` block, so cleanup is single-source.
 *
 * ### Testability
 *
 * `stdin`, `stdout`, `onResize`, and `initialTermSize` are all injectable.
 * Tests pass fakes to drive keypresses, capture the rendered ANSI stream,
 * and trigger resize synchronously without touching `process.*`.
 */

import type { Repos } from "../db/repos/index.ts";
import type { EventBus } from "../events/tail.ts";
import { streamSnapshots } from "./stream.ts";
import { renderSnapshot, type TermSize } from "./tui-render.ts";
import {
	initialViewState,
	type KeyName,
	reduce,
	syncToSnapshot,
	type ViewState,
} from "./tui-state.ts";
import type { DashboardSnapshot } from "./types.ts";

/** Enter the alternate screen buffer (DECSET 1049). Pairs with {@link ALT_SCREEN_EXIT}. */
export const ALT_SCREEN_ENTER = "\x1b[?1049h";
/** Exit the alternate screen buffer (DECRST 1049), restoring the prior terminal contents. */
export const ALT_SCREEN_EXIT = "\x1b[?1049l";
/** Hide the cursor (DECRST 25). */
export const CURSOR_HIDE = "\x1b[?25l";
/** Show the cursor (DECSET 25). */
export const CURSOR_SHOW = "\x1b[?25h";
/** Move cursor home (1,1). Sent before each frame so we overwrite without scrolling. */
export const CURSOR_HOME = "\x1b[H";

/**
 * SIGWINCH debounce window. Trailing-edge: a burst of resize events
 * collapses into one render after the user stops dragging.
 */
export const DEFAULT_RESIZE_DEBOUNCE_MS = 50;

/**
 * Fallback `TermSize` used when `stdout` does not expose `columns`/`rows`
 * (e.g. piped, or a fake stream in tests that didn't set them). 80×24 is
 * the historical default and fits {@link MIN_COLUMNS}/{@link MIN_ROWS}.
 */
const DEFAULT_TERM_SIZE: TermSize = { columns: 80, rows: 24 };

/**
 * Minimal stdin shape the runtime needs. `process.stdin` satisfies it; tests
 * pass a `PassThrough`-like object. `setRawMode`/`resume`/`pause` are
 * optional so non-TTY streams (or fakes) work without stubbing.
 */
export interface TuiStdin {
	on(event: "data", listener: (chunk: Buffer) => void): unknown;
	off(event: "data", listener: (chunk: Buffer) => void): unknown;
	setRawMode?(raw: boolean): unknown;
	isRaw?: boolean;
	resume?(): unknown;
	pause?(): unknown;
}

/** Minimal stdout shape the runtime needs. `process.stdout` satisfies it. */
export interface TuiStdout {
	write(data: string): unknown;
	columns?: number;
	rows?: number;
}

export type TuiQuitReason = "user" | "abort" | "stream-ended";

export interface TuiSummary {
	/** Total frames written to stdout (each `\x1b[H` + `renderSnapshot` blob). */
	framesRendered: number;
	/** Why the runtime exited. */
	quitReason: TuiQuitReason;
}

export interface RunTuiOptions {
	repos: Repos;
	bus: EventBus;
	/** Cooperative external abort (CLI wires SIGINT/SIGTERM here). */
	signal?: AbortSignal;
	/** Defaults to `process.stdin`. */
	stdin?: TuiStdin;
	/** Defaults to `process.stdout`. */
	stdout?: TuiStdout;
	/**
	 * Subscribe to terminal resize. Returns a dispose fn invoked during
	 * cleanup. Defaults to `process.on("SIGWINCH", ...)`.
	 */
	onResize?: (handler: () => void) => () => void;
	/**
	 * Initial term size. Defaults to `(stdout.columns, stdout.rows)`,
	 * falling back to {@link DEFAULT_TERM_SIZE} when unavailable.
	 */
	initialTermSize?: TermSize;
	/** Resize debounce window. Default {@link DEFAULT_RESIZE_DEBOUNCE_MS}. */
	resizeDebounceMs?: number;
	/** Forwarded to {@link streamSnapshots}. */
	coalesceMs?: number;
	/** Forwarded to {@link streamSnapshots}. */
	pollIntervalMs?: number;
	/** Forwarded to {@link streamSnapshots}. */
	runsLimit?: number;
	/** Forwarded to {@link streamSnapshots}. */
	eventTailCap?: number;
}

/**
 * Translate a raw stdin chunk into a {@link KeyName}, or `null` if the chunk
 * doesn't map to a key the reducer understands.
 *
 * Recognized sequences (covers the §pl-2085 step-4 reducer surface):
 *
 *   - `q`, `j`, `k`            → identity
 *   - `\r` / `\n`              → `enter`
 *   - `\x1b` (lone ESC)        → `esc`
 *   - `\x1b[A` / `\x1b[B`      → `up` / `down`
 *   - `\x1b[5~` / `\x1b[6~`    → `pageUp` / `pageDown`
 *   - `\x03` (Ctrl+C)          → `q` (raw mode swallows SIGINT)
 *
 * Pure: same bytes ⇒ same result. Anything else (uppercase, function keys,
 * paste chunks, modifier prefixes) returns `null`.
 */
export function translateKeyBytes(chunk: Buffer): KeyName | null {
	if (chunk.length === 0) return null;
	const s = chunk.toString("utf8");
	switch (s) {
		case "q":
			return "q";
		case "j":
			return "j";
		case "k":
			return "k";
		case "\r":
		case "\n":
			return "enter";
		case "\x03":
			return "q";
		case "\x1b":
			return "esc";
		case "\x1b[A":
			return "up";
		case "\x1b[B":
			return "down";
		case "\x1b[5~":
			return "pageUp";
		case "\x1b[6~":
			return "pageDown";
		default:
			return null;
	}
}

/**
 * Run the TUI until the user quits, the external `signal` aborts, or the
 * snapshot stream ends. Returns once teardown completes.
 */
export async function runTui(opts: RunTuiOptions): Promise<TuiSummary> {
	const stdin = opts.stdin ?? (process.stdin as unknown as TuiStdin);
	const stdout = opts.stdout ?? (process.stdout as unknown as TuiStdout);
	const resizeDebounceMs = opts.resizeDebounceMs ?? DEFAULT_RESIZE_DEBOUNCE_MS;

	let termSize = opts.initialTermSize ?? readTermSize(stdout);
	let snapshot: DashboardSnapshot | null = null;
	let state: ViewState | null = null;
	let frames = 0;
	let userQuit = false;

	// Internal abort merges (a) external signal, and (b) a 'q' / Ctrl+C
	// keypress, into a single signal handed to streamSnapshots. Either path
	// tears the stream down through the same finally block.
	const internalAbort = new AbortController();
	const propagateExternal = (): void => internalAbort.abort();
	if (opts.signal) {
		if (opts.signal.aborted) internalAbort.abort();
		else opts.signal.addEventListener("abort", propagateExternal, { once: true });
	}

	const writeFrame = (): void => {
		if (snapshot === null || state === null) return;
		const frame = renderSnapshot(snapshot, state, termSize);
		stdout.write(`${CURSOR_HOME}${frame}`);
		frames += 1;
	};

	const onKey = (key: KeyName): void => {
		if (snapshot === null || state === null) return;
		const next = reduce(state, key, snapshot);
		if (next === state) return;
		state = next;
		if (state.quit) {
			userQuit = true;
			internalAbort.abort();
			return;
		}
		writeFrame();
	};

	const onChunk = (chunk: Buffer): void => {
		const key = translateKeyBytes(chunk);
		if (key !== null) onKey(key);
	};

	let resizeTimer: ReturnType<typeof setTimeout> | null = null;
	const onResize = (): void => {
		if (resizeTimer !== null) clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => {
			resizeTimer = null;
			termSize = readTermSize(stdout);
			writeFrame();
		}, resizeDebounceMs);
	};

	const wasRaw = stdin.isRaw === true;

	stdout.write(`${ALT_SCREEN_ENTER}${CURSOR_HIDE}`);
	if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
	stdin.resume?.();
	stdin.on("data", onChunk);
	const disposeResize = (opts.onResize ?? defaultOnResize)(onResize);

	try {
		const streamOpts: Parameters<typeof streamSnapshots>[2] = {
			signal: internalAbort.signal,
		};
		if (opts.coalesceMs !== undefined) streamOpts.coalesceMs = opts.coalesceMs;
		if (opts.pollIntervalMs !== undefined) streamOpts.pollIntervalMs = opts.pollIntervalMs;
		if (opts.runsLimit !== undefined) streamOpts.runsLimit = opts.runsLimit;
		if (opts.eventTailCap !== undefined) streamOpts.eventTailCap = opts.eventTailCap;

		const stream = streamSnapshots(opts.repos, opts.bus, streamOpts);

		for await (const snap of stream) {
			snapshot = snap;
			state = state === null ? initialViewState(snap) : syncToSnapshot(state, snap);
			writeFrame();
			if (state.quit || internalAbort.signal.aborted) break;
		}
	} finally {
		stdin.off("data", onChunk);
		if (typeof stdin.setRawMode === "function") stdin.setRawMode(wasRaw);
		stdin.pause?.();
		disposeResize();
		if (resizeTimer !== null) {
			clearTimeout(resizeTimer);
			resizeTimer = null;
		}
		stdout.write(`${CURSOR_SHOW}${ALT_SCREEN_EXIT}`);
		if (opts.signal) opts.signal.removeEventListener("abort", propagateExternal);
	}

	const externalAborted = opts.signal?.aborted === true;
	const quitReason: TuiQuitReason = userQuit ? "user" : externalAborted ? "abort" : "stream-ended";

	return { framesRendered: frames, quitReason };
}

function readTermSize(stdout: TuiStdout): TermSize {
	const cols =
		typeof stdout.columns === "number" && stdout.columns > 0
			? stdout.columns
			: DEFAULT_TERM_SIZE.columns;
	const rows =
		typeof stdout.rows === "number" && stdout.rows > 0 ? stdout.rows : DEFAULT_TERM_SIZE.rows;
	return { columns: cols, rows };
}

function defaultOnResize(handler: () => void): () => void {
	process.on("SIGWINCH", handler);
	return () => {
		process.off("SIGWINCH", handler);
	};
}
