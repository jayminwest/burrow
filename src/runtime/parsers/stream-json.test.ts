import { describe, expect, test } from "bun:test";
import { parseStreamJson } from "./stream-json.ts";

describe("parseStreamJson", () => {
	test("blank lines yield no events", () => {
		expect(parseStreamJson("")).toEqual([]);
		expect(parseStreamJson("   ")).toEqual([]);
	});

	test("uses `type` as kind when present", () => {
		const events = parseStreamJson(JSON.stringify({ type: "tool_use", name: "Bash" }));
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("tool_use");
	});

	test("falls back to `kind` field when `type` is missing", () => {
		const events = parseStreamJson(JSON.stringify({ kind: "thinking", text: "..." }));
		expect(events[0]?.kind).toBe("thinking");
	});

	test("malformed JSON degrades to a text event with parseError", () => {
		const events = parseStreamJson("{nope");
		expect(events[0]?.kind).toBe("text");
		expect(events[0]?.payload).toMatchObject({ parseError: "invalid JSON" });
	});

	test("primitive JSON values become text events", () => {
		expect(parseStreamJson("42")[0]?.kind).toBe("text");
		expect(parseStreamJson('"hi"')[0]?.kind).toBe("text");
	});

	test("top-level JSON arrays degrade to text events (do not flow through as payload)", () => {
		const line = '[{"type":"tool_use","name":"Bash"}]';
		const events = parseStreamJson(line);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("text");
		expect(events[0]?.payload).toEqual({ text: line });
		// guard against the pre-fix bug: array must not be cast through as payload
		expect(Array.isArray(events[0]?.payload)).toBe(false);
	});
});
