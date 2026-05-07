/**
 * Generic NDJSON parser. Each line is parsed as JSON; the resulting object's
 * `type` (or `kind`) field becomes the event kind, and the whole object is
 * carried in the payload. Lines that fail to parse fall back to a `text`
 * event so a single malformed line never aborts a run.
 *
 * Used by declarative adapters with `outputFormat: 'stream-json'` and by
 * built-ins that surface their own JSON shape unchanged (sapling).
 */

import type { RuntimeEvent } from "../runtime.ts";

export function parseStreamJson(line: string): RuntimeEvent[] {
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
		return [
			{
				kind: "text",
				stream: "stdout",
				payload: { text: line },
			},
		];
	}

	const obj = parsed as Record<string, unknown>;
	const kind = pickString(obj.type) ?? pickString(obj.kind) ?? "text";
	return [
		{
			kind,
			stream: "stdout",
			payload: obj,
		},
	];
}

function pickString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}
