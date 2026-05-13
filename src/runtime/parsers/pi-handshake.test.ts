/**
 * Golden RPC-handshake compatibility lock for pi v0.74.0
 * (burrow-988b, plan pl-5198 step 7).
 *
 * Why: pi is pre-1.0. A silent reshape of the JSONL stream across a
 * minor bump would slip through the parser-layer unit tests, which
 * map envelope-by-envelope but never compare the full trace as a
 * whole. This test canonicalizes the volatile-field list documented
 * in src/runtime/parsers/__golden__/README.md (timestamp, responseId,
 * request_id, thinkingSignature, toolCallId — plus the `id` field
 * inside `type:"toolCall"` content blocks, which carries the same
 * toolCallId value) and compares the resulting canonical JSONL to a
 * checked-in golden. Renamed keys, new fields, or restructured
 * envelopes show up as a reviewable diff — that's the cue to update
 * the parser, the goldens, and the pinned pi version in
 * .devcontainer/Dockerfile in a single coordinated change.
 *
 * Regenerating the golden when pi changes intentionally:
 *
 *   1. Regenerate the input fixture per the procedure in
 *      src/runtime/parsers/__golden__/README.md.
 *   2. Re-run with the update flag:
 *
 *        BURROW_UPDATE_PI_GOLDEN=1 \
 *          bun test src/runtime/parsers/pi-handshake.test.ts
 *
 *      This rewrites the canonical goldens with the current fixture.
 *   3. Review the diff; bump the pinned pi version in
 *      .devcontainer/Dockerfile and the parser in lockstep.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GOLDEN_DIR = join(import.meta.dir, "__golden__");
const UPDATE_GOLDEN = process.env.BURROW_UPDATE_PI_GOLDEN === "1";

const VOLATILE_PLACEHOLDERS: Readonly<Record<string, unknown>> = {
	timestamp: 0,
	responseId: "<responseId>",
	request_id: "<request_id>",
	thinkingSignature: "<thinkingSignature>",
	toolCallId: "<toolCallId>",
};

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value === null || typeof value !== "object") return value;
	const obj = value as Record<string, unknown>;
	const isToolCall = obj.type === "toolCall";
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(obj).sort()) {
		if (k in VOLATILE_PLACEHOLDERS) {
			out[k] = VOLATILE_PLACEHOLDERS[k];
		} else if (k === "id" && isToolCall) {
			out[k] = "<toolCallId>";
		} else {
			out[k] = canonicalize(obj[k]);
		}
	}
	return out;
}

function canonicalizeJsonl(raw: string): string {
	const lines = raw.split("\n").filter((l) => l.length > 0);
	const canonical = lines.map((l) => JSON.stringify(canonicalize(JSON.parse(l))));
	return `${canonical.join("\n")}\n`;
}

const FIXTURES = ["pi-v0.74.0-anthropic-success", "pi-v0.74.0-anthropic-tools"] as const;

describe("pi v0.74.0 RPC handshake (golden wire-shape lock)", () => {
	for (const name of FIXTURES) {
		describe(name, () => {
			const fixturePath = join(GOLDEN_DIR, `${name}.jsonl`);
			const goldenPath = join(GOLDEN_DIR, `${name}.canonical.jsonl`);
			const fixture = readFileSync(fixturePath, "utf8");

			test("canonicalized fixture matches the checked-in golden", () => {
				const actual = canonicalizeJsonl(fixture);
				if (UPDATE_GOLDEN) writeFileSync(goldenPath, actual);
				const expected = readFileSync(goldenPath, "utf8");
				expect(actual).toBe(expected);
			});

			test("fixture is LF-terminated JSONL with one JSON object per non-empty line", () => {
				expect(fixture.endsWith("\n")).toBe(true);
				const lines = fixture.split("\n");
				expect(lines[lines.length - 1]).toBe("");
				for (const line of lines.slice(0, -1)) {
					expect(line.length).toBeGreaterThan(0);
					const obj = JSON.parse(line) as unknown;
					expect(typeof obj).toBe("object");
					expect(obj).not.toBeNull();
					expect(Array.isArray(obj)).toBe(false);
				}
			});

			test("first envelope is the RPC ack: {type:'response',command:'prompt',success:true}", () => {
				const firstLine = fixture.split("\n")[0] ?? "";
				const obj = JSON.parse(firstLine) as Record<string, unknown>;
				expect(obj.type).toBe("response");
				expect(obj.command).toBe("prompt");
				expect(obj.success).toBe(true);
			});

			test("last envelope is agent_end (end-of-run marker)", () => {
				const lines = fixture.split("\n").filter((l) => l.length > 0);
				const last = lines[lines.length - 1] ?? "";
				const obj = JSON.parse(last) as Record<string, unknown>;
				expect(obj.type).toBe("agent_end");
			});
		});
	}

	test("canonicalization scrubs every documented volatile field across both fixtures", () => {
		const volatileKeys = new Set(Object.keys(VOLATILE_PLACEHOLDERS));
		for (const name of FIXTURES) {
			const raw = readFileSync(join(GOLDEN_DIR, `${name}.jsonl`), "utf8");
			const canonical = canonicalizeJsonl(raw);
			for (const line of canonical.split("\n").filter((l) => l.length > 0)) {
				const obj = JSON.parse(line) as unknown;
				assertScrubbed(obj, volatileKeys);
			}
		}
	});
});

function assertScrubbed(value: unknown, volatileKeys: ReadonlySet<string>): void {
	if (Array.isArray(value)) {
		for (const v of value) assertScrubbed(v, volatileKeys);
		return;
	}
	if (value === null || typeof value !== "object") return;
	const obj = value as Record<string, unknown>;
	for (const [k, v] of Object.entries(obj)) {
		if (volatileKeys.has(k)) {
			expect(v).toEqual(VOLATILE_PLACEHOLDERS[k]);
		}
		if (k === "id" && obj.type === "toolCall") {
			expect(v).toBe("<toolCallId>");
		}
		assertScrubbed(v, volatileKeys);
	}
}
