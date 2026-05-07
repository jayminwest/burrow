import { describe, expect, test } from "bun:test";
import { parseRawText } from "./raw-text.ts";

describe("parseRawText", () => {
	test("empty line emits nothing", () => {
		expect(parseRawText("")).toEqual([]);
	});

	test("non-empty line emits one text event verbatim", () => {
		const events = parseRawText("hello world");
		expect(events).toEqual([{ kind: "text", stream: "stdout", payload: { text: "hello world" } }]);
	});

	test("preserves leading/trailing whitespace inside content", () => {
		const events = parseRawText("  spaced  ");
		expect(events[0]?.payload).toEqual({ text: "  spaced  " });
	});
});
