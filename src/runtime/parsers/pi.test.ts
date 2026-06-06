import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeExtensionUiDecline } from "../pi-chat.ts";
import { parsePiEvents } from "./pi.ts";

const GOLDEN_DIR = join(import.meta.dir, "__golden__");

describe("parsePiEvents", () => {
	test("empty / whitespace lines yield no events", () => {
		expect(parsePiEvents("")).toEqual([]);
		expect(parsePiEvents("   ")).toEqual([]);
		expect(parsePiEvents("\t\n")).toEqual([]);
	});

	test("invalid JSON falls back to a text event with parseError", () => {
		const events = parsePiEvents("{ not json");
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("text");
		expect(events[0]?.stream).toBe("stdout");
		expect(events[0]?.payload).toMatchObject({ parseError: "invalid JSON" });
	});

	test("primitive JSON values become text events on stdout", () => {
		const num = parsePiEvents("42");
		expect(num).toHaveLength(1);
		expect(num[0]?.kind).toBe("text");
		expect(num[0]?.stream).toBe("stdout");
		expect(num[0]?.payload).toEqual({ text: "42" });

		const nul = parsePiEvents("null");
		expect(nul[0]?.kind).toBe("text");
	});

	test("top-level JSON arrays degrade to text events (do not flow through as payload)", () => {
		const line = '[{"type":"message_end"}]';
		const events = parsePiEvents(line);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("text");
		expect(events[0]?.stream).toBe("stdout");
		expect(events[0]?.payload).toEqual({ text: line });
		// guard against the pre-fix bug: array must not be cast through as payload
		expect(Array.isArray(events[0]?.payload)).toBe(false);
	});

	test("response (RPC ack) becomes a state_change on the system stream", () => {
		const events = parsePiEvents(
			JSON.stringify({ type: "response", command: "prompt", success: true }),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
		expect(events[0]?.payload).toMatchObject({ type: "response", success: true });
	});

	test("agent_start / agent_end / turn_start / turn_end map to state_change/system", () => {
		for (const type of ["agent_start", "agent_end", "turn_start", "turn_end"]) {
			const events = parsePiEvents(JSON.stringify({ type }));
			expect(events).toHaveLength(1);
			expect(events[0]?.kind).toBe("state_change");
			expect(events[0]?.stream).toBe("system");
			expect(events[0]?.payload).toMatchObject({ type });
		}
	});

	test("message_start (any role) is a lifecycle state_change on system", () => {
		for (const role of ["user", "assistant", "toolResult"]) {
			const events = parsePiEvents(
				JSON.stringify({ type: "message_start", message: { role, content: [] } }),
			);
			expect(events).toHaveLength(1);
			expect(events[0]?.kind).toBe("state_change");
			expect(events[0]?.stream).toBe("system");
		}
	});

	test("message_update is telemetry on system (best-effort streaming)", () => {
		const events = parsePiEvents(
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "hel" },
				message: { role: "assistant", content: [{ type: "text", text: "hel" }] },
			}),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("telemetry");
		expect(events[0]?.stream).toBe("system");
	});

	test("assistant message_end expands content blocks into text/thinking/tool_use", () => {
		const events = parsePiEvents(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "reasoning..." },
						{ type: "text", text: "hello" },
						{
							type: "toolCall",
							id: "toolu_01",
							name: "ls",
							arguments: { path: "." },
						},
					],
				},
			}),
		);
		expect(events.map((e) => e.kind)).toEqual(["thinking", "text", "tool_use"]);
		expect(events.map((e) => e.stream)).toEqual(["stdout", "stdout", "stdout"]);
		expect(events[0]?.payload).toEqual({ text: "reasoning..." });
		expect(events[1]?.payload).toEqual({ text: "hello" });
		expect(events[2]?.payload).toMatchObject({ type: "toolCall", name: "ls" });
	});

	test("empty-text thinking blocks in message_end are dropped (parity with claude-code)", () => {
		const events = parsePiEvents(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "", thinkingSignature: "sig" },
						{ type: "text", text: "after" },
					],
				},
			}),
		);
		expect(events.map((e) => e.kind)).toEqual(["text"]);
	});

	test("empty-thinking-only assistant message_end yields zero events", () => {
		const events = parsePiEvents(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "" }],
				},
			}),
		);
		expect(events).toEqual([]);
	});

	test("toolResult message_end becomes a single tool_result on stdout", () => {
		const msg = {
			role: "toolResult",
			toolCallId: "toolu_01",
			toolName: "ls",
			content: [{ type: "text", text: "a.txt\nb.txt" }],
			isError: false,
		};
		const events = parsePiEvents(JSON.stringify({ type: "message_end", message: msg }));
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("tool_result");
		expect(events[0]?.stream).toBe("stdout");
		expect(events[0]?.payload).toEqual(msg);
	});

	test("user message_end is a lifecycle state_change (prompt already known)", () => {
		const events = parsePiEvents(
			JSON.stringify({
				type: "message_end",
				message: { role: "user", content: [{ type: "text", text: "hi" }] },
			}),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
	});

	test("tool_execution_start and tool_execution_end map to state_change/system", () => {
		const start = parsePiEvents(
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "toolu_01",
				toolName: "ls",
				args: { path: "." },
			}),
		);
		expect(start[0]?.kind).toBe("state_change");
		expect(start[0]?.stream).toBe("system");

		const end = parsePiEvents(
			JSON.stringify({
				type: "tool_execution_end",
				toolCallId: "toolu_01",
				toolName: "ls",
				result: { content: [{ type: "text", text: "ok" }] },
				isError: false,
			}),
		);
		expect(end[0]?.kind).toBe("state_change");
		expect(end[0]?.stream).toBe("system");
	});

	test("queue_update is telemetry on system", () => {
		const events = parsePiEvents(JSON.stringify({ type: "queue_update", queuedCommands: 1 }));
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("telemetry");
		expect(events[0]?.stream).toBe("system");
	});

	test("compaction_start / compaction_end map to state_change/system", () => {
		for (const type of ["compaction_start", "compaction_end"]) {
			const events = parsePiEvents(JSON.stringify({ type, reason: "context_limit" }));
			expect(events[0]?.kind).toBe("state_change");
			expect(events[0]?.stream).toBe("system");
		}
	});

	test("auto_retry_start / auto_retry_end are telemetry on system", () => {
		for (const type of ["auto_retry_start", "auto_retry_end"]) {
			const events = parsePiEvents(JSON.stringify({ type, attempt: 2 }));
			expect(events[0]?.kind).toBe("telemetry");
			expect(events[0]?.stream).toBe("system");
		}
	});

	test("extension_error is state_change on system", () => {
		const events = parsePiEvents(
			JSON.stringify({
				type: "extension_error",
				extensionId: "ext.foo",
				error: "boom",
			}),
		);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
	});

	test("extension_ui_request is state_change on system (defensive — --no-extensions blocks it)", () => {
		const events = parsePiEvents(
			JSON.stringify({
				type: "extension_ui_request",
				extensionId: "ext.foo",
				prompt: "approve?",
			}),
		);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
	});

	test("extension_ui_request preserves id + method in payload so pi-chat can echo id", () => {
		// pi 0.77 always tags dialog requests with a freshly-generated UUID id;
		// the host (pi-chat runtime) must echo that exact id back in its
		// extension_ui_response. The parser must therefore preserve id + method
		// verbatim in the state_change payload.
		const envelope = {
			type: "extension_ui_request",
			id: "840f272d-bc3d-4039-b132-83c4fb70360b",
			method: "confirm",
			title: "burrow-fixture",
			message: "approve this fixture run?",
			timeout: 1500,
		};
		const events = parsePiEvents(JSON.stringify(envelope));
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
		expect(events[0]?.payload).toEqual(envelope);
	});

	test("auto-answer extension_ui_response wire shape matches pi-chat's encoder", () => {
		// Lock the wire shape pi-chat's autoRespondToEvent hook writes back to
		// pi's stdin for any extension_ui_request envelope flowing through the
		// parser. Trailing LF is mandatory — pi reads stdin as LF-framed JSONL
		// (mx-2b9f83). V1 always cancels; allowlisting confirmed:true is out of
		// scope (burrow-f375).
		const envelope = {
			type: "extension_ui_request",
			id: "840f272d-bc3d-4039-b132-83c4fb70360b",
			method: "confirm",
		};
		const blob = encodeExtensionUiDecline(envelope);
		expect(blob.endsWith("\n")).toBe(true);
		const parsed = JSON.parse(blob.trim()) as Record<string, unknown>;
		expect(parsed).toEqual({
			type: "extension_ui_response",
			id: envelope.id,
			cancelled: true,
		});
	});

	test("tool_execution_update (pi 0.77 vocab delta) is telemetry on system", () => {
		// pi 0.77 added tool_execution_update between tool_execution_start and
		// tool_execution_end to stream incremental progress. Treat it as
		// best-effort telemetry, mirroring the message_update collapse rule.
		const events = parsePiEvents(
			JSON.stringify({
				type: "tool_execution_update",
				toolCallId: "toolu_01",
				toolName: "bash",
				update: { stdout: "partial..." },
			}),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("telemetry");
		expect(events[0]?.stream).toBe("system");
		expect(events[0]?.payload).toMatchObject({ type: "tool_execution_update" });
	});

	test("unknown envelope types are preserved as state_change (additive vocab)", () => {
		const events = parsePiEvents(JSON.stringify({ type: "future_event_kind", payload: { a: 1 } }));
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
		expect(events[0]?.payload).toMatchObject({ type: "future_event_kind" });
	});

	test("envelope without a type field still maps to state_change/system", () => {
		const events = parsePiEvents(JSON.stringify({ no_type: true }));
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
	});

	test("LF-only splitting invariant: U+2028 inside a JSON string survives parse", () => {
		// Pi's RPC framing is strict LF-only. If the run loop's reader ever
		// regresses to Node readline (which also splits on U+2028/U+2029),
		// JSON strings containing those code points would tear. This test
		// locks the contract at the parser layer — a single JSON object with
		// an embedded U+2028 in a string parses cleanly without throwing.
		const text = "before after";
		const line = JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text }] },
		});
		const events = parsePiEvents(line);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("text");
		expect(events[0]?.payload).toEqual({ text });
	});

	test("malformed message_end (no message) falls back to state_change", () => {
		const events = parsePiEvents(JSON.stringify({ type: "message_end" }));
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
	});

	test("assistant message_end with non-array content falls back to state_change", () => {
		const events = parsePiEvents(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: "oops" },
			}),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("state_change");
	});

	test("unknown assistant block type still surfaces as a text event (don't drop)", () => {
		const events = parsePiEvents(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "exotic_future", payload: { x: 1 } }],
				},
			}),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("text");
		expect(events[0]?.payload).toMatchObject({ block: { type: "exotic_future" } });
	});

	describe("golden fixture: pi-v0.77.0-anthropic-success.jsonl", () => {
		const lines = readFileSync(join(GOLDEN_DIR, "pi-v0.77.0-anthropic-success.jsonl"), "utf8")
			.split("\n")
			.filter((l) => l.length > 0);

		test("every line parses without throwing", () => {
			for (const line of lines) {
				expect(() => parsePiEvents(line)).not.toThrow();
			}
		});

		test("first line is the RPC ack and maps to state_change/system", () => {
			const first = parsePiEvents(lines[0] ?? "");
			expect(first[0]?.kind).toBe("state_change");
			expect(first[0]?.stream).toBe("system");
			expect(first[0]?.payload).toMatchObject({
				type: "response",
				command: "prompt",
			});
		});

		test("assistant message_end expands to thinking + text events with 'ack' content", () => {
			const events = lines.flatMap((line) => {
				const env = JSON.parse(line) as { type?: string; message?: { role?: string } };
				if (env.type !== "message_end" || env.message?.role !== "assistant") return [];
				return parsePiEvents(line);
			});
			expect(events.map((e) => e.kind)).toEqual(["thinking", "text"]);
			expect(events[1]?.payload).toEqual({ text: "ack" });
		});

		test("agent_end appears exactly once on the system stream", () => {
			const agentEnds = lines.flatMap((line) => {
				const env = JSON.parse(line) as { type?: string };
				if (env.type !== "agent_end") return [];
				return parsePiEvents(line);
			});
			expect(agentEnds).toHaveLength(1);
			expect(agentEnds[0]?.kind).toBe("state_change");
			expect(agentEnds[0]?.stream).toBe("system");
		});

		test("no parseError fallbacks on any line", () => {
			for (const line of lines) {
				const events = parsePiEvents(line);
				for (const ev of events) {
					if (ev.kind === "text" && ev.stream === "stdout") {
						const p = ev.payload as { parseError?: unknown };
						expect(p.parseError).toBeUndefined();
					}
				}
			}
		});
	});

	describe("golden fixture: pi-v0.77.0-anthropic-tools.jsonl", () => {
		const lines = readFileSync(join(GOLDEN_DIR, "pi-v0.77.0-anthropic-tools.jsonl"), "utf8")
			.split("\n")
			.filter((l) => l.length > 0);

		test("every line parses without throwing", () => {
			for (const line of lines) {
				expect(() => parsePiEvents(line)).not.toThrow();
			}
		});

		test("emits at least one tool_use event from the assistant turn", () => {
			const toolUses = lines
				.flatMap((line) => parsePiEvents(line))
				.filter((e) => e.kind === "tool_use");
			expect(toolUses.length).toBeGreaterThanOrEqual(1);
			expect(toolUses[0]?.payload).toMatchObject({ type: "toolCall", name: "ls" });
		});

		test("emits at least one tool_result event from the toolResult message_end", () => {
			const toolResults = lines
				.flatMap((line) => parsePiEvents(line))
				.filter((e) => e.kind === "tool_result");
			expect(toolResults.length).toBeGreaterThanOrEqual(1);
			expect(toolResults[0]?.stream).toBe("stdout");
			expect(toolResults[0]?.payload).toMatchObject({
				role: "toolResult",
				toolName: "ls",
			});
		});

		test("tool_execution_start/end land on system as state_change", () => {
			const execEvents = lines.flatMap((line) => {
				const env = JSON.parse(line) as { type?: string };
				if (env.type !== "tool_execution_start" && env.type !== "tool_execution_end") {
					return [];
				}
				return parsePiEvents(line);
			});
			expect(execEvents.length).toBeGreaterThanOrEqual(2);
			for (const ev of execEvents) {
				expect(ev.kind).toBe("state_change");
				expect(ev.stream).toBe("system");
			}
		});
	});

	describe("golden fixture: pi-v0.77.0-anthropic-extension-ui.jsonl", () => {
		const lines = readFileSync(join(GOLDEN_DIR, "pi-v0.77.0-anthropic-extension-ui.jsonl"), "utf8")
			.split("\n")
			.filter((l) => l.length > 0);

		test("every line parses without throwing", () => {
			for (const line of lines) {
				expect(() => parsePiEvents(line)).not.toThrow();
			}
		});

		test("contains at least one extension_ui_request envelope mapped to state_change/system", () => {
			const uiReqEvents = lines.flatMap((line) => {
				const env = JSON.parse(line) as { type?: string };
				if (env.type !== "extension_ui_request") return [];
				return parsePiEvents(line);
			});
			expect(uiReqEvents.length).toBeGreaterThanOrEqual(1);
			for (const ev of uiReqEvents) {
				expect(ev.kind).toBe("state_change");
				expect(ev.stream).toBe("system");
				const payload = ev.payload as Record<string, unknown>;
				expect(typeof payload.id).toBe("string");
				expect((payload.id as string).length).toBeGreaterThan(0);
				expect(typeof payload.method).toBe("string");
			}
		});

		test("pi-chat's encodeExtensionUiDecline echoes the fixture's request id verbatim", () => {
			const envelope = lines
				.map((l) => JSON.parse(l) as Record<string, unknown>)
				.find((e) => e.type === "extension_ui_request");
			expect(envelope).toBeDefined();
			if (!envelope) return;
			const blob = encodeExtensionUiDecline(envelope);
			expect(blob.endsWith("\n")).toBe(true);
			const parsed = JSON.parse(blob.trim()) as Record<string, unknown>;
			expect(parsed).toEqual({
				type: "extension_ui_response",
				id: envelope.id,
				cancelled: true,
			});
		});

		test("agent_end still appears (auto-decline does not abort the run)", () => {
			const last = lines[lines.length - 1] ?? "";
			const obj = JSON.parse(last) as { type?: string };
			expect(obj.type).toBe("agent_end");
		});
	});
});
