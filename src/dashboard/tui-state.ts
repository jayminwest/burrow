/**
 * Pure view-state reducer for the `burrow watch` TUI (SPEC §26).
 *
 * The TUI runtime (`src/dashboard/tui.ts`) is the only impure piece of the
 * dashboard stack: it owns the alt-screen entry/exit, raw-mode stdin, resize
 * listener, and snapshot-stream consumer. Everything between a keypress and a
 * rendered frame is pure:
 *
 * ```text
 *   raw stdin bytes      ──translate──▶  KeyName
 *                                          │
 *                                          ▼
 *   snapshot ────▶ ViewState ──reduce──▶ ViewState ──renderSnapshot──▶ frame
 * ```
 *
 * The reducer takes the current `ViewState`, a `KeyName`, and the latest
 * `DashboardSnapshot` (used for clamping selection / scroll bounds and for
 * resolving the focused burrow on `enter`) and returns the next `ViewState`.
 * The snapshot is a *context* parameter, not state — the reducer never mutates
 * it and never holds a reference past the call.
 *
 * Selection is **id-based**, not index-based, so a snapshot that reorders
 * `burrows[]` between ticks doesn't silently jump the cursor. A separate
 * {@link syncToSnapshot} re-validates the selection when a burrow disappears
 * (re-pinning to the first remaining burrow, or `null` if the list is empty).
 *
 * Detail-pane scrolling is expressed as a backwards offset from the newest
 * event in the focused burrow's `eventTail`: `0` means "live tail at bottom",
 * positive values scroll back through history. The reducer clamps to
 * `[0, eventTail.length]` based on the snapshot; the renderer applies a
 * tighter clamp once it knows the actual viewport height.
 */

import type { DashboardSnapshot } from "./types.ts";

/**
 * Number of lines a single PgUp/PgDn moves the detail-pane scroll offset.
 * Deliberately a fixed constant rather than a function of terminal height —
 * the reducer is termSize-unaware on purpose, and the renderer is free to
 * over-render past the visible window. Round-number and small enough that
 * a second press feels responsive.
 */
export const DETAIL_SCROLL_PAGE_SIZE = 10 as const;

/**
 * Top-level mode. `list` shows the multi-burrow list with j/k navigation;
 * `detail` focuses the selected burrow's run history + event tail and
 * routes PgUp/PgDn to scroll.
 */
export type ViewMode = "list" | "detail";

/**
 * Logical key name produced by the TUI runtime's stdin translator. The
 * reducer is byte-agnostic — the runtime decides whether `\x1b[B` becomes
 * `down`, `\x03` becomes `q` (Ctrl+C as quit), etc. Unknown key names are
 * a type error at the call site; the reducer treats every member here as
 * a defined transition.
 *
 * Adding a new key is a strictly additive change: extend the union and
 * the `reduce` switch picks up the missing-case lint immediately.
 */
export type KeyName = "q" | "j" | "k" | "down" | "up" | "enter" | "esc" | "pageDown" | "pageUp";

/**
 * The complete TUI view-state. Every field is serializable so the runtime
 * can snapshot it for tests, time-travel debugging, or future replay.
 *
 * The reducer is the only function permitted to construct a new ViewState
 * — callers should never hand-edit fields.
 */
export interface ViewState {
	/** Top-level mode; see {@link ViewMode}. */
	mode: ViewMode;
	/**
	 * Id of the currently selected burrow, or `null` when the snapshot has
	 * no burrows. Id-based (not index) so reordered snapshots don't shift
	 * the cursor.
	 */
	selectedBurrowId: string | null;
	/**
	 * Lines scrolled back from the newest event in the focused burrow's
	 * `eventTail`. `0` = bottom (live tail). Always in `[0, eventTail.length]`.
	 */
	detailScrollOffset: number;
	/**
	 * Set to `true` by `q` (or Ctrl+C, translated by the runtime). The
	 * runtime's snapshot-stream consumer checks this on every tick and
	 * tears down the alt screen when set. Once true, never resets.
	 */
	quit: boolean;
}

/**
 * Initial view-state for a fresh `burrow watch` session. Selects the first
 * burrow in the snapshot (if any) so j/k navigation is immediately
 * meaningful; otherwise leaves selection null.
 */
export function initialViewState(snapshot: DashboardSnapshot): ViewState {
	const first = snapshot.burrows[0];
	return {
		mode: "list",
		selectedBurrowId: first ? first.id : null,
		detailScrollOffset: 0,
		quit: false,
	};
}

/**
 * Re-validate `state` against a new snapshot. Called by the runtime each
 * time `streamSnapshots` yields. Three cases:
 *
 *  1. Selected burrow still exists — return state unchanged (referentially
 *     equal so React-style memoization downstream stays cheap).
 *  2. Selected burrow disappeared — pin selection to the first remaining
 *     burrow, drop back to list mode, reset scroll.
 *  3. List became empty — selection goes null; mode falls back to list.
 *
 * The detail-scroll offset is also clamped to the new `eventTail.length`
 * so a snapshot that trims the tail can't strand the viewport past the end.
 */
export function syncToSnapshot(state: ViewState, snapshot: DashboardSnapshot): ViewState {
	const burrows = snapshot.burrows;
	const selected = findBurrow(snapshot, state.selectedBurrowId);

	if (state.selectedBurrowId !== null && selected === null) {
		const fallback = burrows[0];
		return {
			mode: "list",
			selectedBurrowId: fallback ? fallback.id : null,
			detailScrollOffset: 0,
			quit: state.quit,
		};
	}

	if (state.selectedBurrowId === null && burrows.length > 0) {
		const first = burrows[0];
		return {
			mode: state.mode,
			selectedBurrowId: first ? first.id : null,
			detailScrollOffset: 0,
			quit: state.quit,
		};
	}

	if (selected !== null) {
		const max = selected.eventTail.length;
		if (state.detailScrollOffset > max) {
			return { ...state, detailScrollOffset: max };
		}
	}

	return state;
}

/**
 * Pure keypress reducer. Returns the next `ViewState` for the given key
 * against the current snapshot. Unknown action paths (e.g. `enter` with
 * no selection, `esc` while already in list mode, j/k in detail mode)
 * return the input state unchanged — referentially equal — so callers can
 * cheaply skip a re-render when nothing changed.
 *
 * The reducer never throws and never inspects anything beyond the three
 * arguments. The same (state, key, snapshot) always produces the same
 * output ViewState.
 */
export function reduce(state: ViewState, key: KeyName, snapshot: DashboardSnapshot): ViewState {
	if (state.quit) return state;

	switch (key) {
		case "q":
			return { ...state, quit: true };

		case "j":
		case "down":
			return moveSelection(state, snapshot, +1);

		case "k":
		case "up":
			return moveSelection(state, snapshot, -1);

		case "enter": {
			if (state.mode !== "list") return state;
			if (state.selectedBurrowId === null) return state;
			return { ...state, mode: "detail", detailScrollOffset: 0 };
		}

		case "esc": {
			if (state.mode !== "detail") return state;
			return { ...state, mode: "list", detailScrollOffset: 0 };
		}

		case "pageDown":
			return scrollDetail(state, snapshot, -DETAIL_SCROLL_PAGE_SIZE);

		case "pageUp":
			return scrollDetail(state, snapshot, +DETAIL_SCROLL_PAGE_SIZE);
	}
}

function moveSelection(state: ViewState, snapshot: DashboardSnapshot, delta: 1 | -1): ViewState {
	if (state.mode !== "list") return state;
	const burrows = snapshot.burrows;
	if (burrows.length === 0) return state;

	const currentIdx = burrows.findIndex((b) => b.id === state.selectedBurrowId);
	const startIdx = currentIdx === -1 ? 0 : currentIdx;
	const nextIdx = clamp(startIdx + delta, 0, burrows.length - 1);
	if (nextIdx === currentIdx) return state;

	const next = burrows[nextIdx];
	if (!next) return state;
	return { ...state, selectedBurrowId: next.id, detailScrollOffset: 0 };
}

function scrollDetail(state: ViewState, snapshot: DashboardSnapshot, delta: number): ViewState {
	if (state.mode !== "detail") return state;
	const focused = findBurrow(snapshot, state.selectedBurrowId);
	if (focused === null) return state;

	const max = focused.eventTail.length;
	const nextOffset = clamp(state.detailScrollOffset + delta, 0, max);
	if (nextOffset === state.detailScrollOffset) return state;
	return { ...state, detailScrollOffset: nextOffset };
}

function findBurrow(
	snapshot: DashboardSnapshot,
	id: string | null,
): DashboardSnapshot["burrows"][number] | null {
	if (id === null) return null;
	return snapshot.burrows.find((b) => b.id === id) ?? null;
}

function clamp(n: number, lo: number, hi: number): number {
	if (hi < lo) return lo;
	if (n < lo) return lo;
	if (n > hi) return hi;
	return n;
}
