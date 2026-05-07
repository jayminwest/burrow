import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { type BurrowDb, openDatabase } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { normalizeKindFilter, runEventsCommand } from "./events.ts";

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
	get lines(): string[] {
		return this.chunks
			.join("")
			.split("\n")
			.filter((l) => l.length > 0);
	}
}

describe("normalizeKindFilter", () => {
	test("returns null for empty input", () => {
		expect(normalizeKindFilter(undefined)).toBeNull();
		expect(normalizeKindFilter([])).toBeNull();
	});
	test("splits comma-joined values across multiple flags", () => {
		const set = normalizeKindFilter(["tool_use,error", "stderr"]);
		expect(set).not.toBeNull();
		expect([...(set ?? new Set())].sort()).toEqual(["error", "stderr", "tool_use"]);
	});
	test("dedupes whitespace + repeats", () => {
		const set = normalizeKindFilter(["tool_use,  tool_use", " error "]);
		expect([...(set ?? new Set())].sort()).toEqual(["error", "tool_use"]);
	});
});

describe("runEventsCommand", () => {
	let db: BurrowDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => db.close());

	test("interleaves events from multiple active burrows in NDJSON by ts", async () => {
		const a = repos.burrows.create({
			kind: "project",
			projectRoot: "/a",
			workspacePath: "/a/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const b = repos.burrows.create({
			kind: "project",
			projectRoot: "/b",
			workspacePath: "/b/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		repos.events.append({
			burrowId: a.id,
			kind: "tool_use",
			stream: "stdout",
			payload: {},
			ts: new Date(1000),
		});
		repos.events.append({
			burrowId: b.id,
			kind: "tool_use",
			stream: "stdout",
			payload: {},
			ts: new Date(2000),
		});
		repos.events.append({
			burrowId: a.id,
			kind: "tool_use",
			stream: "stdout",
			payload: {},
			ts: new Date(3000),
		});

		const stdout = new CollectStream();
		const summary = await runEventsCommand({
			db,
			options: { json: true },
			stdout,
			isTty: false,
		});
		expect(summary.emitted).toBe(3);
		const burrowOrder = stdout.lines.map((l) => JSON.parse(l).burrowId);
		expect(burrowOrder).toEqual([a.id, b.id, a.id]);
	});

	test("--kind filter drops events whose kind isn't in the set", async () => {
		const a = repos.burrows.create({
			kind: "project",
			projectRoot: "/a",
			workspacePath: "/a/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		repos.events.append({ burrowId: a.id, kind: "tool_use", stream: "stdout", payload: {} });
		repos.events.append({ burrowId: a.id, kind: "thinking", stream: "stdout", payload: {} });
		repos.events.append({ burrowId: a.id, kind: "error", stream: "stderr", payload: {} });

		const stdout = new CollectStream();
		await runEventsCommand({
			db,
			options: { json: true, kind: ["tool_use,error"] },
			stdout,
			isTty: false,
		});
		const kinds = stdout.lines.map((l) => JSON.parse(l).kind);
		expect(kinds.sort()).toEqual(["error", "tool_use"]);
	});

	test("--burrow allow-list restricts the active set", async () => {
		const a = repos.burrows.create({
			kind: "project",
			projectRoot: "/a",
			workspacePath: "/a/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const b = repos.burrows.create({
			kind: "project",
			projectRoot: "/b",
			workspacePath: "/b/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		repos.events.append({ burrowId: a.id, kind: "k", stream: "stdout", payload: {} });
		repos.events.append({ burrowId: b.id, kind: "k", stream: "stdout", payload: {} });

		const stdout = new CollectStream();
		await runEventsCommand({
			db,
			options: { json: true, burrow: [a.id] },
			stdout,
			isTty: false,
		});
		const burrowIds = stdout.lines.map((l) => JSON.parse(l).burrowId);
		expect(burrowIds).toEqual([a.id]);
	});
});
