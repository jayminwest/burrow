import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../core/types.ts";
import { eventToEnvelope, renderNdjson, renderPretty } from "./render.ts";

const event: RunEvent = {
	id: 1,
	burrowId: "bur_a",
	runId: "run_b",
	seq: 42,
	kind: "tool_use",
	stream: "stdout",
	payload: { tool: "Bash", input: { command: "bun test" } },
	ts: new Date("2026-05-07T19:00:00.000Z"),
};

describe("renderNdjson", () => {
	test("emits a SPEC §14.1 envelope terminated by a newline", () => {
		const line = renderNdjson(event);
		expect(line.endsWith("\n")).toBe(true);
		const parsed = JSON.parse(line.trimEnd());
		expect(parsed).toEqual({
			type: "event",
			ts: "2026-05-07T19:00:00.000Z",
			burrowId: "bur_a",
			runId: "run_b",
			seq: 42,
			kind: "tool_use",
			stream: "stdout",
			payload: { tool: "Bash", input: { command: "bun test" } },
		});
	});

	test("eventToEnvelope round-trips runId=null without coercing to undefined", () => {
		const env = eventToEnvelope({ ...event, runId: null });
		expect(env.runId).toBeNull();
		expect("runId" in env).toBe(true);
	});
});

describe("renderPretty", () => {
	test("includes a one-line header with ts, burrow#seq, and kind", () => {
		const out = renderPretty(event);
		expect(out).toContain("2026-05-07T19:00:00.000Z");
		expect(out).toContain("bur_a#42");
		expect(out).toContain("tool_use");
		expect(out.endsWith("\n")).toBe(true);
	});

	test("summarises tool_use payloads to tool=<name>", () => {
		expect(renderPretty(event)).toContain("tool=Bash");
	});

	test("renders state_change with from → to", () => {
		const sc: RunEvent = {
			...event,
			kind: "state_change",
			payload: { from: "queued", to: "running" },
		};
		expect(renderPretty(sc)).toContain("queued → running");
	});

	test("truncates long text payloads", () => {
		const long = "x".repeat(500);
		const ev: RunEvent = { ...event, kind: "text", payload: { text: long } };
		expect(renderPretty(ev).length).toBeLessThan(500);
	});

	test("falls back to compact JSON for unknown kinds", () => {
		const ev: RunEvent = { ...event, kind: "novel_kind", payload: { foo: 1, bar: "x" } };
		expect(renderPretty(ev)).toContain('"foo":1');
	});
});
