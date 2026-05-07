/**
 * Claude Code stream-json parser.
 *
 * Claude Code emits one JSON object per line in the shape:
 *   {"type":"system","subtype":"init", ...}
 *   {"type":"assistant","message":{"role":"assistant","content":[...]}}
 *   {"type":"user","message":{"role":"user","content":[{"type":"tool_result", ...}]}}
 *   {"type":"result","subtype":"success", "is_error":false, "result":"...", "usage":{...}}
 *
 * We map these to the stable burrow event taxonomy (SPEC §14.1):
 *   - `assistant` text  → `text`
 *   - `assistant` thinking → `thinking`
 *   - `assistant` tool_use → `tool_use` (one per content block)
 *   - `user` tool_result → `tool_result`
 *   - `system` → `state_change`
 *   - `result` → `state_change`
 *   - everything else → `text` carrying the raw envelope
 *
 * A single Claude Code line can produce multiple events when the assistant
 * message has multiple content blocks (e.g. text + tool_use), so the parser
 * returns an array and lets the run loop persist them in order.
 */

import type { RuntimeEvent } from "../runtime.ts";

interface ClaudeContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	[key: string]: unknown;
}

interface ClaudeMessage {
	role?: string;
	content?: ClaudeContentBlock[];
}

interface ClaudeEnvelope {
	type?: string;
	subtype?: string;
	message?: ClaudeMessage;
	[key: string]: unknown;
}

export function parseJsonlClaude(line: string): RuntimeEvent[] {
	const trimmed = line.trim();
	if (trimmed.length === 0) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return [
			{
				kind: "text",
				stream: "stdout",
				payload: { text: line, parseError: "invalid JSON" },
			},
		];
	}

	if (parsed === null || typeof parsed !== "object") {
		return [{ kind: "text", stream: "stdout", payload: { text: line } }];
	}

	const env = parsed as ClaudeEnvelope;

	if (env.type === "system") {
		return [{ kind: "state_change", stream: "system", payload: env }];
	}
	if (env.type === "result") {
		return [{ kind: "state_change", stream: "system", payload: env }];
	}

	if (env.type === "assistant" && env.message?.content) {
		return env.message.content.map((block) => mapAssistantBlock(block, env));
	}

	if (env.type === "user" && env.message?.content) {
		return env.message.content
			.filter((block) => block.type === "tool_result")
			.map((block) => ({
				kind: "tool_result" as const,
				stream: "stdout" as const,
				payload: block,
			}));
	}

	return [{ kind: "text", stream: "stdout", payload: env }];
}

function mapAssistantBlock(block: ClaudeContentBlock, envelope: ClaudeEnvelope): RuntimeEvent {
	if (block.type === "text") {
		return { kind: "text", stream: "stdout", payload: { text: block.text ?? "" } };
	}
	if (block.type === "thinking") {
		return {
			kind: "thinking",
			stream: "stdout",
			payload: { text: block.thinking ?? "" },
		};
	}
	if (block.type === "tool_use") {
		return { kind: "tool_use", stream: "stdout", payload: block };
	}
	// Unknown block kinds still surface — better to record them than drop.
	return {
		kind: "text",
		stream: "stdout",
		payload: { block, envelopeType: envelope.type },
	};
}
