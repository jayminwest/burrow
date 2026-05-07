/**
 * Unit + golden tests for the pure renderer (`src/dashboard/tui-render.ts`).
 *
 * Coverage:
 *   - Frame invariants at 80×24, 120×40, and 60×20: exact line count, exact
 *     column width per line, header + footer presence, separator placement.
 *   - List-mode selection cursor follows `state.selectedBurrowId`.
 *   - Detail-mode content (id, branch, workspace, active run, event tail).
 *   - Detail-mode scrolling shifts the visible event window by offset.
 *   - Empty snapshots and "term too small" fall back deterministically.
 *   - Purity: same input ⇒ identical string; renderer never mutates inputs.
 *   - Resize: re-rendering at a different `termSize` produces a frame of the
 *     new size while preserving semantic content (selected burrow, mode).
 *   - One full hand-crafted golden frame for the 80×24 list view.
 */

import { describe, expect, test } from "bun:test";
import { MIN_COLUMNS, MIN_ROWS, renderSnapshot, type TermSize } from "./tui-render.ts";
import { initialViewState, type ViewState } from "./tui-state.ts";
import {
	type BurrowCard,
	DASHBOARD_SNAPSHOT_VERSION,
	type DashboardSnapshot,
	type EventTailEntry,
	type RunSummary,
} from "./types.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function run(burrowId: string, idSuffix: string, state: RunSummary["state"]): RunSummary {
	const isTerminal = state === "succeeded" || state === "failed" || state === "cancelled";
	return {
		id: `run_${idSuffix}`,
		burrowId,
		agentId: "claude-code",
		state,
		exitCode: state === "succeeded" ? 0 : null,
		errorMessage: null,
		queuedAt: "2026-05-07T18:59:00.000Z",
		startedAt: state === "queued" ? null : "2026-05-07T18:59:01.000Z",
		completedAt: isTerminal ? "2026-05-07T19:00:00.000Z" : null,
	};
}

function event(burrowId: string, seq: number, kind = "tool_use"): EventTailEntry {
	return {
		burrowId,
		runId: "run_1",
		seq,
		kind,
		stream: "stdout",
		ts: `2026-05-07T19:00:${String(seq).padStart(2, "0")}.000Z`,
		payload: { seq },
	};
}

function card(id: string, eventCount = 0): BurrowCard {
	const tail = Array.from({ length: eventCount }, (_, i) => event(id, i + 1));
	return {
		id,
		parentId: null,
		kind: "project",
		name: id,
		state: "active",
		projectRoot: `/work/${id}`,
		workspacePath: `/work/${id}/.burrow/workspaces/${id}`,
		branch: `burrow/${id}`,
		provider: "local",
		createdAt: "2026-05-07T18:00:00.000Z",
		updatedAt: "2026-05-07T19:00:00.000Z",
		destroyedAt: null,
		runs: [run(id, "1", "running")],
		activeRun: run(id, "1", "running"),
		eventTail: tail,
		lastEventSeq: tail.length === 0 ? null : tail.length,
	};
}

function snap(...cards: BurrowCard[]): DashboardSnapshot {
	return {
		type: "snapshot",
		version: DASHBOARD_SNAPSHOT_VERSION,
		ts: "2026-05-07T19:00:00.000Z",
		burrows: cards,
	};
}

const TERM_SMALL: TermSize = { columns: 60, rows: 20 };
const TERM_STD: TermSize = { columns: 80, rows: 24 };
const TERM_WIDE: TermSize = { columns: 120, rows: 40 };

function frameLines(out: string): string[] {
	return out.split("\n");
}

/* -------------------------------------------------------------------------- */
/* Frame invariants                                                            */
/* -------------------------------------------------------------------------- */

describe.each([
	["60×20 (narrow)", TERM_SMALL],
	["80×24 (standard)", TERM_STD],
	["120×40 (wide)", TERM_WIDE],
])("frame invariants @ %s", (_label, size) => {
	const ss = snap(card("alpha", 30), card("bravo", 5), card("charlie", 0));
	const list = initialViewState(ss);
	const detail: ViewState = { ...list, mode: "detail" };

	test("list mode emits exactly termSize.rows lines", () => {
		const lines = frameLines(renderSnapshot(ss, list, size));
		expect(lines.length).toBe(size.rows);
	});

	test("detail mode emits exactly termSize.rows lines", () => {
		const lines = frameLines(renderSnapshot(ss, detail, size));
		expect(lines.length).toBe(size.rows);
	});

	test("every line is exactly termSize.columns wide (list mode)", () => {
		const lines = frameLines(renderSnapshot(ss, list, size));
		for (const line of lines) {
			expect(line.length).toBe(size.columns);
		}
	});

	test("every line is exactly termSize.columns wide (detail mode)", () => {
		const lines = frameLines(renderSnapshot(ss, detail, size));
		for (const line of lines) {
			expect(line.length).toBe(size.columns);
		}
	});

	test("first line is the title bar", () => {
		const [first] = frameLines(renderSnapshot(ss, list, size));
		expect(first?.startsWith("burrow watch")).toBe(true);
	});

	test("second line and second-to-last line are separators", () => {
		const lines = frameLines(renderSnapshot(ss, list, size));
		const sep = "─".repeat(size.columns);
		expect(lines[1]).toBe(sep);
		expect(lines[size.rows - 2]).toBe(sep);
	});

	test("last line is the keybind footer", () => {
		const listFooter = frameLines(renderSnapshot(ss, list, size)).at(-1);
		const detailFooter = frameLines(renderSnapshot(ss, detail, size)).at(-1);
		expect(listFooter?.startsWith("[j/k] move")).toBe(true);
		expect(detailFooter?.startsWith("[esc] back")).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */
/* Header content                                                              */
/* -------------------------------------------------------------------------- */

describe("header", () => {
	test("includes burrow count and snapshot time", () => {
		const ss = snap(card("a"), card("b"));
		const out = renderSnapshot(ss, initialViewState(ss), TERM_STD);
		const header = frameLines(out)[0] ?? "";
		expect(header).toContain("2 burrows");
		expect(header).toContain("19:00:00");
	});

	test("singular when there is exactly one burrow", () => {
		const ss = snap(card("only"));
		const out = renderSnapshot(ss, initialViewState(ss), TERM_STD);
		const header = frameLines(out)[0] ?? "";
		expect(header).toContain("1 burrow ");
		expect(header).not.toContain("1 burrows");
	});

	test("detail mode shows the focused burrow id in the title", () => {
		const ss = snap(card("alpha"), card("bravo"));
		const state: ViewState = { ...initialViewState(ss), mode: "detail" };
		const header = frameLines(renderSnapshot(ss, state, TERM_STD))[0] ?? "";
		expect(header).toContain("› alpha");
	});
});

/* -------------------------------------------------------------------------- */
/* List-mode body                                                              */
/* -------------------------------------------------------------------------- */

describe("list mode", () => {
	test("renders a column-header row followed by one row per burrow", () => {
		const ss = snap(card("alpha"), card("bravo"));
		const lines = frameLines(renderSnapshot(ss, initialViewState(ss), TERM_STD));
		expect(lines[2]).toContain("ID");
		expect(lines[2]).toContain("STATE");
		expect(lines[2]).toContain("KIND");
		expect(lines[2]).toContain("ACTIVE");
		expect(lines[2]).toContain("LAST EVENT");
		expect(lines[3]).toContain("alpha");
		expect(lines[4]).toContain("bravo");
	});

	test("selection cursor `> ` precedes the selected burrow row", () => {
		const ss = snap(card("alpha"), card("bravo"), card("charlie"));
		const state: ViewState = { ...initialViewState(ss), selectedBurrowId: "bravo" };
		const lines = frameLines(renderSnapshot(ss, state, TERM_STD));
		const alphaRow = lines.find((l) => l.includes("alpha"));
		const bravoRow = lines.find((l) => l.includes("bravo"));
		const charlieRow = lines.find((l) => l.includes("charlie"));
		expect(bravoRow?.startsWith("> ")).toBe(true);
		expect(alphaRow?.startsWith("  ")).toBe(true);
		expect(charlieRow?.startsWith("  ")).toBe(true);
	});

	test("active run column shows state + agent id", () => {
		const ss = snap(card("alpha"));
		const lines = frameLines(renderSnapshot(ss, initialViewState(ss), TERM_STD));
		const alphaRow = lines.find((l) => l.includes("alpha")) ?? "";
		expect(alphaRow).toContain("running");
		expect(alphaRow).toContain("claude-code");
	});

	test("last-event column shows the newest event time + kind", () => {
		const ss = snap(card("alpha", 3));
		const lines = frameLines(renderSnapshot(ss, initialViewState(ss), TERM_STD));
		const alphaRow = lines.find((l) => l.includes("alpha")) ?? "";
		// Newest event seq=3 ⇒ ts "19:00:03"
		expect(alphaRow).toContain("19:00:03");
		expect(alphaRow).toContain("tool_use");
	});

	test("active=null and empty event tail render as `—`", () => {
		const c = card("alpha");
		c.activeRun = null;
		c.runs = [];
		const ss = snap(c);
		const lines = frameLines(renderSnapshot(ss, initialViewState(ss), TERM_STD));
		const alphaRow = lines.find((l) => l.includes("alpha")) ?? "";
		expect(alphaRow.match(/—/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
	});

	test("empty snapshot prints an explanatory message in the body", () => {
		const ss = snap();
		const lines = frameLines(renderSnapshot(ss, initialViewState(ss), TERM_STD));
		const bodyJoined = lines.slice(2, -2).join("\n");
		expect(bodyJoined).toContain("No burrows yet");
		expect(bodyJoined).toContain("burrow up");
	});

	test("clips body when there are more burrows than rows", () => {
		const cards = Array.from({ length: 100 }, (_, i) => card(`b${i.toString().padStart(3, "0")}`));
		const ss = snap(...cards);
		const lines = frameLines(renderSnapshot(ss, initialViewState(ss), TERM_STD));
		// Body capacity = rows - 4 (header, sep, sep, footer). Header row inside body
		// claims one more, so visible burrow rows = rows - 5 = 19 at 80×24.
		const visibleBurrows = lines.slice(2, -2).filter((l) => /b\d{3}/.test(l)).length;
		expect(visibleBurrows).toBe(TERM_STD.rows - 5);
	});
});

/* -------------------------------------------------------------------------- */
/* Detail-mode body                                                            */
/* -------------------------------------------------------------------------- */

describe("detail mode", () => {
	test("shows id/state/kind, branch, workspace, and active run", () => {
		const ss = snap(card("alpha", 5));
		const state: ViewState = { ...initialViewState(ss), mode: "detail" };
		const out = renderSnapshot(ss, state, TERM_STD);
		expect(out).toContain("Burrow: alpha");
		expect(out).toContain("state=active");
		expect(out).toContain("kind=project");
		expect(out).toContain("Branch: burrow/alpha");
		expect(out).toContain("Workspace: /work/alpha/.burrow/workspaces/alpha");
		expect(out).toContain("Active run: run_1 [running] claude-code");
		expect(out).toContain("started 18:59:01");
	});

	test("active run absent ⇒ shows historical-run summary", () => {
		const c = card("alpha");
		c.activeRun = null;
		c.runs = [run("alpha", "0", "succeeded"), run("alpha", "1", "failed")];
		const ss = snap(c);
		const state: ViewState = { ...initialViewState(ss), mode: "detail" };
		const out = renderSnapshot(ss, state, TERM_STD);
		expect(out).toContain("Active run: —");
		expect(out).toContain("(2 historical runs)");
	});

	test("event tail renders newest events at the bottom by default (offset=0)", () => {
		const ss = snap(card("alpha", 50));
		const state: ViewState = { ...initialViewState(ss), mode: "detail" };
		const out = renderSnapshot(ss, state, TERM_STD);
		// At 80×24, body=20, minus 6 fixed metadata/heading rows, ⇒ 14 events visible
		// ⇒ window is seq 37..50. Newest (seq=50) should be present, oldest seq=1 not.
		expect(out).toContain("seq 50");
		expect(out).not.toContain("seq 1 ");
	});

	test("scroll offset slides the window backwards through history", () => {
		const ss = snap(card("alpha", 50));
		const state: ViewState = {
			mode: "detail",
			selectedBurrowId: "alpha",
			detailScrollOffset: 20,
			quit: false,
		};
		const out = renderSnapshot(ss, state, TERM_STD);
		// Window ends at 50-20=30 ⇒ seq 17..30 visible
		expect(out).toContain("seq 30");
		expect(out).not.toContain("seq 50");
		expect(out).not.toContain("seq 1 ");
	});

	test("events heading reflects offset when scrolled", () => {
		const ss = snap(card("alpha", 50));
		const scrolled: ViewState = {
			mode: "detail",
			selectedBurrowId: "alpha",
			detailScrollOffset: 20,
			quit: false,
		};
		const liveTail: ViewState = { ...scrolled, detailScrollOffset: 0 };
		expect(renderSnapshot(ss, scrolled, TERM_STD)).toContain("offset 20");
		expect(renderSnapshot(ss, liveTail, TERM_STD)).not.toContain("offset");
	});

	test("burrow with empty event tail shows `(none yet)` heading and no entries", () => {
		const ss = snap(card("alpha", 0));
		const state: ViewState = { ...initialViewState(ss), mode: "detail" };
		const out = renderSnapshot(ss, state, TERM_STD);
		expect(out).toContain("Events: (none yet)");
		expect(out).not.toContain("seq 1");
	});

	test("selection lost (selectedBurrowId points at no burrow) shows fallback hint", () => {
		const ss = snap(card("alpha"));
		const state: ViewState = {
			mode: "detail",
			selectedBurrowId: "ghost",
			detailScrollOffset: 0,
			quit: false,
		};
		const out = renderSnapshot(ss, state, TERM_STD);
		expect(out).toContain("selection lost");
	});
});

/* -------------------------------------------------------------------------- */
/* Resize behavior                                                             */
/* -------------------------------------------------------------------------- */

describe("resize", () => {
	test("re-rendering at a new size yields a frame of that size", () => {
		const ss = snap(card("alpha", 20), card("bravo", 5));
		const state = initialViewState(ss);
		const small = renderSnapshot(ss, state, TERM_SMALL);
		const std = renderSnapshot(ss, state, TERM_STD);
		const wide = renderSnapshot(ss, state, TERM_WIDE);
		expect(frameLines(small).length).toBe(TERM_SMALL.rows);
		expect(frameLines(std).length).toBe(TERM_STD.rows);
		expect(frameLines(wide).length).toBe(TERM_WIDE.rows);
		expect(frameLines(small)[0]?.length).toBe(TERM_SMALL.columns);
		expect(frameLines(std)[0]?.length).toBe(TERM_STD.columns);
		expect(frameLines(wide)[0]?.length).toBe(TERM_WIDE.columns);
	});

	test("selection survives a resize", () => {
		const ss = snap(card("alpha"), card("bravo"));
		const state: ViewState = { ...initialViewState(ss), selectedBurrowId: "bravo" };
		for (const size of [TERM_SMALL, TERM_STD, TERM_WIDE]) {
			const lines = frameLines(renderSnapshot(ss, state, size));
			const bravoRow = lines.find((l) => l.includes("bravo"));
			expect(bravoRow?.startsWith("> ")).toBe(true);
		}
	});

	test("term smaller than minimum emits a `term too small` frame at the requested size", () => {
		const tiny: TermSize = { columns: MIN_COLUMNS - 1, rows: MIN_ROWS - 1 };
		const ss = snap(card("alpha"));
		const out = renderSnapshot(ss, initialViewState(ss), tiny);
		const lines = frameLines(out);
		expect(lines.length).toBe(tiny.rows);
		for (const line of lines) {
			expect(line.length).toBe(tiny.columns);
		}
		expect(lines[0]).toContain("too small");
	});

	test("term smaller than minimum still emits at least one row", () => {
		const tiny: TermSize = { columns: 5, rows: 1 };
		const out = renderSnapshot(snap(card("alpha")), initialViewState(snap(card("alpha"))), tiny);
		expect(frameLines(out).length).toBe(1);
	});
});

/* -------------------------------------------------------------------------- */
/* Purity                                                                      */
/* -------------------------------------------------------------------------- */

describe("purity", () => {
	test("identical inputs produce identical output", () => {
		const ss = snap(card("alpha", 30), card("bravo"), card("charlie", 5));
		const state = initialViewState(ss);
		const a = renderSnapshot(ss, state, TERM_STD);
		const b = renderSnapshot(ss, state, TERM_STD);
		expect(a).toBe(b);
	});

	test("never mutates the snapshot", () => {
		const ss = snap(card("alpha", 30), card("bravo"));
		const beforeIds = ss.burrows.map((b) => b.id);
		const beforeTailLen = ss.burrows[0]?.eventTail.length;
		renderSnapshot(ss, initialViewState(ss), TERM_STD);
		expect(ss.burrows.map((b) => b.id)).toEqual(beforeIds);
		expect(ss.burrows[0]?.eventTail.length).toBe(beforeTailLen);
	});

	test("never mutates the view state", () => {
		const ss = snap(card("alpha", 10));
		const state: ViewState = {
			mode: "detail",
			selectedBurrowId: "alpha",
			detailScrollOffset: 5,
			quit: false,
		};
		const frozen = Object.freeze({ ...state });
		// If render mutated it would throw on a frozen object.
		renderSnapshot(ss, frozen, TERM_STD);
		expect(frozen.detailScrollOffset).toBe(5);
		expect(frozen.mode).toBe("detail");
	});
});

/* -------------------------------------------------------------------------- */
/* Hand-crafted golden frame: 80×24 list view                                  */
/* -------------------------------------------------------------------------- */

describe("golden frame: 80×24 list", () => {
	test("matches a hand-crafted reference exactly", () => {
		const cards = [card("alpha", 3), card("bravo", 0), card("charlie", 1)];
		// Mark bravo as stopped + queued run for variety.
		const c1 = cards[1];
		if (c1) {
			c1.state = "stopped";
			c1.activeRun = run("bravo", "1", "queued");
			c1.runs = [c1.activeRun];
		}
		const ss = snap(...cards);
		const state: ViewState = { ...initialViewState(ss), selectedBurrowId: "bravo" };

		const out = renderSnapshot(ss, state, TERM_STD);
		const lines = frameLines(out);
		expect(lines.length).toBe(24);
		for (const l of lines) expect(l.length).toBe(80);

		// Spot-check by line index.
		expect(lines[0]).toBe(pad("burrow watch   3 burrows   19:00:00", 80));
		expect(lines[1]).toBe("─".repeat(80));
		// Row 2: column header (cursor pad, ID, STATE, KIND, ACTIVE, LAST EVENT).
		// Layout widths: cursor(2) id(12) gap(2) state(8) gap(2) kind(7) gap(2) active(20) gap(2) event(23) = 80.
		expect(lines[2]).toBe(
			"  ID            STATE     KIND     ACTIVE                LAST EVENT             ",
		);
		// Row 3: alpha (not selected)
		expect(lines[3]).toBe(
			"  alpha         active    project  running claude-code   19:00:03 tool_use      ",
		);
		// Row 4: bravo (selected) — note `> ` prefix
		expect(lines[4]).toBe(
			"> bravo         stopped   project  queued claude-code    —                      ",
		);
		// Row 5: charlie
		expect(lines[5]).toBe(
			"  charlie       active    project  running claude-code   19:00:01 tool_use      ",
		);
		// Trailing body filler is blank lines.
		for (let i = 6; i < 22; i++) {
			expect(lines[i]).toBe(" ".repeat(80));
		}
		expect(lines[22]).toBe("─".repeat(80));
		expect(lines[23]).toBe(pad("[j/k] move   [enter] focus   [q] quit", 80));
	});
});

function pad(s: string, width: number): string {
	if (s.length >= width) return s.slice(0, width);
	return s + " ".repeat(width - s.length);
}
