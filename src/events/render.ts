/**
 * Event envelope serialization (SPEC §14.1) shared by `burrow logs`,
 * `burrow events`, and the on-destroy archiver. The NDJSON envelope is the
 * stable wire shape; the pretty renderer is best-effort human formatting
 * for TTY output and intentionally lossy.
 *
 * Envelope keys: `type`, `ts`, `burrowId`, `runId`, `seq`, `kind`, `stream`,
 * `payload`. Adding a new top-level key is a breaking change; adding a new
 * `kind` (with payload-specific shape) is additive — consumers ignore
 * unknown kinds per SPEC.
 */

import type { RunEvent } from "../core/types.ts";

export interface EventEnvelope {
	type: "event";
	ts: string;
	burrowId: string;
	runId: string | null;
	seq: number;
	kind: string;
	stream: string;
	payload: unknown;
}

export function eventToEnvelope(event: RunEvent): EventEnvelope {
	return {
		type: "event",
		ts: event.ts.toISOString(),
		burrowId: event.burrowId,
		runId: event.runId,
		seq: event.seq,
		kind: event.kind,
		stream: event.stream,
		payload: event.payload,
	};
}

export function renderNdjson(event: RunEvent): string {
	return `${JSON.stringify(eventToEnvelope(event))}\n`;
}

/**
 * Single-line human format. Drops the full payload in favour of a short
 * summary keyed off of `kind`. Designed for `burrow logs --follow` on a
 * TTY where the JSON is too noisy.
 */
export function renderPretty(event: RunEvent): string {
	const ts = event.ts.toISOString();
	const head = `[${ts}] ${event.burrowId}#${event.seq} ${event.kind}`;
	const body = summarisePayload(event.kind, event.payload);
	return body ? `${head}  ${body}\n` : `${head}\n`;
}

function summarisePayload(kind: string, payload: unknown): string {
	if (payload == null) return "";
	if (typeof payload === "string")
		return payload.length > 120 ? `${payload.slice(0, 117)}...` : payload;
	if (typeof payload !== "object") return String(payload);
	const obj = payload as Record<string, unknown>;
	switch (kind) {
		case "tool_use":
			return obj.tool ? `tool=${String(obj.tool)}` : compact(obj);
		case "tool_result":
			return obj.tool ? `tool=${String(obj.tool)} ok=${obj.ok ?? ""}` : compact(obj);
		case "thinking":
		case "text":
			return typeof obj.text === "string" ? truncate(obj.text, 120) : compact(obj);
		case "stderr":
			return typeof obj.line === "string" ? truncate(obj.line, 120) : compact(obj);
		case "state_change":
			return obj.from && obj.to ? `${obj.from} → ${obj.to}` : compact(obj);
		case "error":
			return typeof obj.message === "string" ? truncate(obj.message, 120) : compact(obj);
		default:
			return compact(obj);
	}
}

function compact(obj: Record<string, unknown>): string {
	const json = JSON.stringify(obj);
	return truncate(json, 120);
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}
