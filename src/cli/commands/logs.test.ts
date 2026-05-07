import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { ValidationError } from "../../core/errors.ts";
import { type BurrowDb, openDatabase } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { BurrowRow } from "../../db/schema.ts";
import { parseLimit, parseSince, runLogsCommand } from "./logs.ts";

class CollectStream extends Writable {
	chunks: string[] = [];
	override _write(
		chunk: Buffer | string,
		_enc: BufferEncoding,
		cb: (err?: Error | null) => void,
	): void {
		this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		cb();
	}
	get text(): string {
		return this.chunks.join("");
	}
	get lines(): string[] {
		return this.text.split("\n").filter((l) => l.length > 0);
	}
}

describe("parseSince", () => {
	test("returns 0 by default", () => {
		expect(parseSince(undefined)).toBe(0);
	});
	test("accepts non-negative integers", () => {
		expect(parseSince("0")).toBe(0);
		expect(parseSince("5")).toBe(5);
	});
	test("rejects negatives, floats, junk", () => {
		expect(() => parseSince("-1")).toThrow(ValidationError);
		expect(() => parseSince("1.5")).toThrow(ValidationError);
		expect(() => parseSince("abc")).toThrow(ValidationError);
	});
});

describe("parseLimit", () => {
	test("undefined returns undefined (no limit)", () => {
		expect(parseLimit(undefined)).toBeUndefined();
	});
	test("rejects 0 and negatives", () => {
		expect(() => parseLimit("0")).toThrow(ValidationError);
		expect(() => parseLimit("-3")).toThrow(ValidationError);
	});
	test("accepts positive integers", () => {
		expect(parseLimit("3")).toBe(3);
	});
});

describe("runLogsCommand", () => {
	let db: BurrowDb;
	let repos: Repos;
	let burrow: BurrowRow;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		burrow = repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
	});

	afterEach(() => db.close());

	test("once mode emits NDJSON envelopes for every event past since", async () => {
		for (let i = 0; i < 3; i++) {
			repos.events.append({
				burrowId: burrow.id,
				kind: "tool_use",
				stream: "stdout",
				payload: { i },
				ts: new Date((i + 1) * 1000),
			});
		}
		const stdout = new CollectStream();
		const summary = await runLogsCommand({
			db,
			burrowId: burrow.id,
			options: { since: "1", json: true },
			stdout,
			isTty: false,
		});
		expect(summary.emitted).toBe(2);
		expect(summary.stoppedReason).toBe("drained");
		const lines = stdout.lines.map((l) => JSON.parse(l));
		expect(lines.map((l) => l.seq)).toEqual([2, 3]);
		expect(lines[0].type).toBe("event");
	});

	test("limit caps emission and reports stoppedReason='limit'", async () => {
		for (let i = 0; i < 5; i++) {
			repos.events.append({
				burrowId: burrow.id,
				kind: "k",
				stream: "stdout",
				payload: { i },
			});
		}
		const stdout = new CollectStream();
		const summary = await runLogsCommand({
			db,
			burrowId: burrow.id,
			options: { json: true, limit: "2" },
			stdout,
			isTty: false,
		});
		expect(summary.emitted).toBe(2);
		expect(summary.stoppedReason).toBe("limit");
		expect(stdout.lines).toHaveLength(2);
	});

	test("pretty mode emits one human line per event when isTty=true", async () => {
		repos.events.append({
			burrowId: burrow.id,
			kind: "tool_use",
			stream: "stdout",
			payload: { tool: "Bash" },
		});
		const stdout = new CollectStream();
		await runLogsCommand({
			db,
			burrowId: burrow.id,
			options: {},
			stdout,
			isTty: true,
		});
		expect(stdout.text).toContain("tool_use");
		expect(stdout.text).toContain("tool=Bash");
	});

	test("--follow keeps streaming until the abort signal fires", async () => {
		repos.events.append({
			burrowId: burrow.id,
			kind: "k",
			stream: "stdout",
			payload: { i: 1 },
		});
		const stdout = new CollectStream();
		const ac = new AbortController();
		const consumer = runLogsCommand({
			db,
			burrowId: burrow.id,
			options: { follow: true, json: true, pollIntervalMs: 5 },
			stdout,
			signal: ac.signal,
			isTty: false,
		});
		await new Promise((r) => setTimeout(r, 20));
		repos.events.append({
			burrowId: burrow.id,
			kind: "k",
			stream: "stdout",
			payload: { i: 2 },
		});
		await new Promise((r) => setTimeout(r, 30));
		ac.abort();
		const summary = await consumer;
		expect(summary.emitted).toBeGreaterThanOrEqual(2);
		expect(summary.stoppedReason).toBe("abort");
	});

	test("throws on unknown burrow id", async () => {
		const stdout = new CollectStream();
		await expect(
			runLogsCommand({
				db,
				burrowId: "bur_missing",
				options: { json: true },
				stdout,
				isTty: false,
			}),
		).rejects.toThrow(/burrow not found/);
	});
});
