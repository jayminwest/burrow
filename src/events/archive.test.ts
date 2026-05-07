import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BurrowDb, openDatabase } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { BurrowRow } from "../db/schema.ts";
import { archiveBurrow } from "./archive.ts";

describe("archiveBurrow", () => {
	let db: BurrowDb;
	let repos: Repos;
	let burrow: BurrowRow;
	let archiveRoot: string;

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
		archiveRoot = mkdtempSync(join(tmpdir(), "burrow-archive-"));
	});

	afterEach(() => {
		db.close();
		rmSync(archiveRoot, { recursive: true, force: true });
	});

	test("writes events.jsonl ordered by seq with the SPEC envelope", async () => {
		for (let i = 0; i < 3; i++) {
			repos.events.append({
				burrowId: burrow.id,
				kind: "tool_use",
				stream: "stdout",
				payload: { i },
				ts: new Date((i + 1) * 1000),
			});
		}
		const result = await archiveBurrow({ repos, burrowId: burrow.id, archiveRoot });
		const lines = readFileSync(result.eventsPath, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(3);
		const first = JSON.parse(lines[0] as string);
		expect(first.type).toBe("event");
		expect(first.burrowId).toBe(burrow.id);
		expect(first.seq).toBe(1);
		expect(first.payload).toEqual({ i: 0 });
		expect(result.eventCount).toBe(3);
	});

	test("writes messages.jsonl with createdAt ascending", async () => {
		const m1 = repos.messages.send({
			burrowId: burrow.id,
			fromActor: "user",
			body: "first",
			now: new Date(1000),
		});
		const m2 = repos.messages.send({
			burrowId: burrow.id,
			fromActor: "user",
			body: "second",
			now: new Date(2000),
		});
		const result = await archiveBurrow({ repos, burrowId: burrow.id, archiveRoot });
		const lines = readFileSync(result.messagesPath, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		const order = lines.map((l) => JSON.parse(l).id);
		expect(order).toEqual([m1.id, m2.id]);
		expect(result.messageCount).toBe(2);
	});

	test("writes runs.json with the burrow row plus every run, sorted by queuedAt", async () => {
		const r1 = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "p1",
			now: new Date(1000),
		});
		const r2 = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "p2",
			now: new Date(2000),
		});
		const result = await archiveBurrow({ repos, burrowId: burrow.id, archiveRoot });
		const json = JSON.parse(readFileSync(result.runsPath, "utf8")) as {
			burrow: { id: string };
			runs: Array<{ id: string }>;
			exportedAt: string;
		};
		expect(json.burrow.id).toBe(burrow.id);
		expect(json.runs.map((r) => r.id)).toEqual([r1.id, r2.id]);
		expect(json.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(result.runCount).toBe(2);
	});

	test("creates the per-burrow directory under archiveRoot", async () => {
		const result = await archiveBurrow({ repos, burrowId: burrow.id, archiveRoot });
		expect(result.directory).toBe(join(archiveRoot, burrow.id));
		expect(result.eventsPath).toBe(join(result.directory, "events.jsonl"));
		expect(result.messagesPath).toBe(join(result.directory, "messages.jsonl"));
		expect(result.runsPath).toBe(join(result.directory, "runs.json"));
	});

	test("empty burrow archive still produces all three files", async () => {
		const result = await archiveBurrow({ repos, burrowId: burrow.id, archiveRoot });
		expect(readFileSync(result.eventsPath, "utf8")).toBe("");
		expect(readFileSync(result.messagesPath, "utf8")).toBe("");
		const json = JSON.parse(readFileSync(result.runsPath, "utf8"));
		expect(json.runs).toEqual([]);
	});

	test("paginates large event sets via batchSize", async () => {
		for (let i = 0; i < 7; i++) {
			repos.events.append({
				burrowId: burrow.id,
				kind: "k",
				stream: "stdout",
				payload: { i },
				ts: new Date((i + 1) * 1000),
			});
		}
		const result = await archiveBurrow({
			repos,
			burrowId: burrow.id,
			archiveRoot,
			batchSize: 3,
		});
		expect(result.eventCount).toBe(7);
		const lines = readFileSync(result.eventsPath, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(7);
		const seqs = lines.map((l) => JSON.parse(l).seq);
		expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});
});
