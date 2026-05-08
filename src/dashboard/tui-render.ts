/**
 * Pure renderer for the `burrow watch` TUI dashboard (SPEC §26).
 *
 * `renderSnapshot(snapshot, viewState, termSize)` returns the next frame as a
 * single string of `\n`-joined lines. The renderer is the *pure* leaf of the
 * dashboard stack:
 *
 * ```text
 *   raw stdin bytes ─translate─▶ KeyName
 *                                   │
 *                                   ▼
 *   snapshot ─▶ ViewState ─reduce─▶ ViewState ─renderSnapshot─▶ frame
 * ```
 *
 * The runtime (`src/dashboard/tui.ts`, step 6) is the only impure piece — it
 * owns alt-screen entry/exit, raw mode, the resize listener, and the cursor.
 * `renderSnapshot` never reads a global, never throws, and given identical
 * `(snapshot, viewState, termSize)` always produces the identical string.
 *
 * ## Output shape
 *
 * The returned string is exactly `termSize.rows` lines (separated by `\n`,
 * no trailing newline). Each line is padded to exactly `termSize.columns`
 * visible characters. This lets the runtime blit the whole frame after a
 * single `cursor home` without per-line clears, and it keeps golden tests
 * trivially comparable.
 *
 * Lines are pure text — no ANSI escapes. Color is intentionally deferred so
 * the renderer stays trivially golden-testable; the runtime can wrap the
 * frame with color codes once it has confirmed stdout is a TTY.
 *
 * ## Frame layout
 *
 * Every frame has the same outer shape:
 *
 * ```text
 *   row 0           title bar
 *   row 1           ── separator ──────
 *   rows 2..rows-3  body (list or detail, depending on viewState.mode)
 *   row rows-2      ── separator ──────
 *   row rows-1      keybind footer
 * ```
 *
 * For terminals smaller than {@link MIN_COLUMNS} × {@link MIN_ROWS} we emit
 * a single-line "term too small" frame (still padded to the requested size)
 * rather than risk a broken layout.
 */

import type { ViewState } from "./tui-state.ts";
import type { BurrowCard, DashboardSnapshot, EventTailEntry } from "./types.ts";

/**
 * Terminal dimensions in characters. The runtime reads this from
 * `process.stdout` (or its resize signal) and threads it through unchanged.
 */
export interface TermSize {
	columns: number;
	rows: number;
}

export interface RenderOptions {
	/**
	 * Reserved for future ANSI styling. Currently unused — the renderer
	 * always emits plain text so golden tests stay deterministic. The
	 * runtime may layer color over the result in a follow-up step.
	 */
	color?: boolean;
}

/** Minimum terminal width we attempt a full layout at. Below this we fall back. */
export const MIN_COLUMNS = 20;
/** Minimum terminal height we attempt a full layout at. Below this we fall back. */
export const MIN_ROWS = 5;

const ELLIPSIS = "…";

/** Pure: same `(snapshot, viewState, termSize)` ⇒ same string. */
export function renderSnapshot(
	snapshot: DashboardSnapshot,
	state: ViewState,
	termSize: TermSize,
	_options: RenderOptions = {},
): string {
	if (termSize.rows < MIN_ROWS || termSize.columns < MIN_COLUMNS) {
		return renderTooSmall(termSize);
	}

	const cols = termSize.columns;
	const rows = termSize.rows;

	const lines: string[] = [];
	lines.push(renderHeader(snapshot, state, cols));
	lines.push(separator(cols));

	const bodyRows = rows - 4;
	const body =
		state.mode === "list"
			? renderListBody(snapshot, state, cols, bodyRows)
			: renderDetailBody(snapshot, state, cols, bodyRows);
	lines.push(...body);

	lines.push(separator(cols));
	lines.push(renderFooter(state, cols));

	return lines.join("\n");
}

function renderTooSmall(size: TermSize): string {
	const cols = Math.max(size.columns, 1);
	const rows = Math.max(size.rows, 1);
	// Short enough to survive `fit` at any width >= MIN_COLUMNS - 1 = 19.
	const msg = "term too small";
	const lines: string[] = [];
	for (let i = 0; i < rows; i++) {
		lines.push(i === 0 ? fit(msg, cols) : pad("", cols));
	}
	return lines.join("\n");
}

function renderHeader(snapshot: DashboardSnapshot, state: ViewState, cols: number): string {
	const time = snapshot.ts.slice(11, 19);
	const n = snapshot.burrows.length;
	const count = `${n} burrow${n === 1 ? "" : "s"}`;
	const focusedSuffix =
		state.mode === "detail" && state.selectedBurrowId !== null
			? ` › ${state.selectedBurrowId}`
			: "";
	const text = `burrow watch${focusedSuffix}   ${count}   ${time}`;
	return fit(text, cols);
}

function renderFooter(state: ViewState, cols: number): string {
	const help =
		state.mode === "list"
			? "[j/k] move   [enter] focus   [q] quit"
			: "[esc] back   [PgUp/PgDn] scroll   [q] quit";
	return fit(help, cols);
}

function separator(cols: number): string {
	return "─".repeat(cols);
}

/* -------------------------------------------------------------------------- */
/* List mode                                                                  */
/* -------------------------------------------------------------------------- */

interface ListColumns {
	idW: number;
	stateW: number;
	kindW: number;
	activeW: number;
	eventW: number;
}

function listColumns(cols: number): ListColumns {
	const idW = 12;
	const stateW = 8;
	const kindW = 7;
	// activeW must hold "running claude-code" (19) without truncation at standard widths.
	const activeW = 20;
	// 2 (cursor) + idW + 2 + stateW + 2 + kindW + 2 + activeW + 2 = 57 fixed.
	const fixed = 2 + idW + 2 + stateW + 2 + kindW + 2 + activeW + 2;
	const eventW = Math.max(0, cols - fixed);
	return { idW, stateW, kindW, activeW, eventW };
}

function renderListBody(
	snapshot: DashboardSnapshot,
	state: ViewState,
	cols: number,
	rows: number,
): string[] {
	if (rows <= 0) return [];
	const out: string[] = [];

	if (snapshot.burrows.length === 0) {
		out.push(fit("  No burrows yet. Run `burrow up` to create one.", cols));
		while (out.length < rows) out.push(pad("", cols));
		return out;
	}

	const c = listColumns(cols);
	out.push(formatListRow("  ", "ID", "STATE", "KIND", "ACTIVE", "LAST EVENT", c, cols));

	const visible = Math.min(snapshot.burrows.length, Math.max(0, rows - 1));
	for (let i = 0; i < visible; i++) {
		const card = snapshot.burrows[i];
		if (!card) continue;
		const cursor = card.id === state.selectedBurrowId ? "> " : "  ";
		const lastEvt = card.eventTail.at(-1);
		const lastEvtText = lastEvt ? `${lastEvt.ts.slice(11, 19)} ${lastEvt.kind}` : "—";
		const activeText = card.activeRun ? `${card.activeRun.state} ${card.activeRun.agentId}` : "—";
		out.push(
			formatListRow(cursor, card.id, card.state, card.kind, activeText, lastEvtText, c, cols),
		);
	}

	while (out.length < rows) out.push(pad("", cols));
	if (out.length > rows) out.length = rows;
	return out;
}

function formatListRow(
	cursor: string,
	id: string,
	stateText: string,
	kind: string,
	active: string,
	lastEvt: string,
	c: ListColumns,
	cols: number,
): string {
	const parts: string[] = [
		cursor,
		fit(id, c.idW),
		"  ",
		fit(stateText, c.stateW),
		"  ",
		fit(kind, c.kindW),
		"  ",
		fit(active, c.activeW),
		"  ",
	];
	if (c.eventW > 0) parts.push(fit(lastEvt, c.eventW));
	const joined = parts.join("");
	// Belt-and-braces: ensure exact column width regardless of arithmetic above.
	return pad(joined, cols);
}

/* -------------------------------------------------------------------------- */
/* Detail mode                                                                */
/* -------------------------------------------------------------------------- */

function renderDetailBody(
	snapshot: DashboardSnapshot,
	state: ViewState,
	cols: number,
	rows: number,
): string[] {
	if (rows <= 0) return [];
	const out: string[] = [];

	const card = snapshot.burrows.find((b) => b.id === state.selectedBurrowId);
	if (!card) {
		out.push(fit("  (selection lost — press esc to return to the list)", cols));
		while (out.length < rows) out.push(pad("", cols));
		return out;
	}

	pushIfRoom(out, rows, fit(`Burrow: ${card.id}   state=${card.state}   kind=${card.kind}`, cols));
	pushIfRoom(out, rows, fit(`Branch: ${card.branch}`, cols));
	pushIfRoom(out, rows, fit(`Workspace: ${card.workspacePath}`, cols));
	pushIfRoom(out, rows, fit(detailRunLine(card), cols));
	pushIfRoom(out, rows, pad("", cols));

	if (out.length < rows) {
		const heading = formatEventsHeading(card, state);
		pushIfRoom(out, rows, fit(heading, cols));
	}

	const eventCapacity = Math.max(0, rows - out.length);
	const window = sliceEventWindow(card.eventTail, state.detailScrollOffset, eventCapacity);
	for (const e of window) {
		pushIfRoom(out, rows, fit(formatEventEntry(e), cols));
	}

	while (out.length < rows) out.push(pad("", cols));
	if (out.length > rows) out.length = rows;
	return out;
}

function detailRunLine(card: BurrowCard): string {
	if (card.activeRun) {
		const r = card.activeRun;
		const started = r.startedAt ? `   started ${r.startedAt.slice(11, 19)}` : "";
		return `Active run: ${r.id} [${r.state}] ${r.agentId}${started}`;
	}
	const n = card.runs.length;
	return `Active run: —   (${n} historical run${n === 1 ? "" : "s"})`;
}

function formatEventsHeading(card: BurrowCard, state: ViewState): string {
	const total = card.eventTail.length;
	const offset = state.detailScrollOffset;
	const offsetSuffix = offset > 0 ? `   offset ${offset}` : "";
	if (total === 0) return `Events: (none yet)${offsetSuffix}`;
	return `Events: ${total} total${offsetSuffix}`;
}

function formatEventEntry(e: EventTailEntry): string {
	const ts = e.ts.slice(11, 19);
	return `[${ts}]  seq ${e.seq}  ${e.stream}  ${e.kind}`;
}

/**
 * Pure: returns the slice of `tail` (oldest-first) the renderer should show
 * given a backwards `offset` from the newest event and a fixed capacity.
 *
 * `offset = 0` ⇒ live tail at bottom (last `capacity` entries).
 * `offset = N` ⇒ window ends at `tail.length - N`, so older entries scroll
 * into view as `offset` grows. The reducer (`tui-state.ts`) clamps `offset`
 * to `[0, tail.length]`, so `start` and `end` are always in range.
 */
function sliceEventWindow(
	tail: EventTailEntry[],
	offset: number,
	capacity: number,
): EventTailEntry[] {
	if (capacity <= 0 || tail.length === 0) return [];
	const end = Math.max(0, tail.length - offset);
	const start = Math.max(0, end - capacity);
	return tail.slice(start, end);
}

/* -------------------------------------------------------------------------- */
/* String helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Pad or truncate `s` so the returned string has exactly `width` BMP code
 * units. Truncation appends an ellipsis (`…`); padding appends spaces. The
 * dashboard never emits non-BMP characters, so `s.length` matches visible
 * width here.
 */
function fit(s: string, width: number): string {
	if (width <= 0) return "";
	if (s.length === width) return s;
	if (s.length < width) return s + " ".repeat(width - s.length);
	if (width === 1) return ELLIPSIS;
	return s.slice(0, width - 1) + ELLIPSIS;
}

function pad(s: string, width: number): string {
	if (width <= 0) return "";
	if (s.length === width) return s;
	if (s.length > width) return s.slice(0, width);
	return s + " ".repeat(width - s.length);
}

function pushIfRoom(out: string[], rows: number, line: string): void {
	if (out.length < rows) out.push(line);
}
