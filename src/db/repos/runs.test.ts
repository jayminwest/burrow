import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type BurrowDb, openDatabase } from "../client.ts";
import type { BurrowRow } from "../schema.ts";
import { createRepos, type Repos } from "./index.ts";

function seedBurrow(repos: Repos): BurrowRow {
	return repos.burrows.create({
		kind: "project",
		projectRoot: "/r",
		workspacePath: "/r/ws",
		branch: "main",
		provider: "local",
		profile: {},
	});
}

describe("RunsRepo", () => {
	let db: BurrowDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => db.close());

	test("enqueue inserts a queued run with prefixed id", () => {
		const burrow = seedBurrow(repos);
		const run = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "hello",
		});
		expect(run.id).toMatch(/^run_/);
		expect(run.state).toBe("queued");
		expect(run.queuedAt).toBeInstanceOf(Date);
	});

	test("claimById is atomic: concurrent calls only succeed once", () => {
		const burrow = seedBurrow(repos);
		const run = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "p",
		});
		const a = repos.runs.claimById(run.id);
		const b = repos.runs.claimById(run.id);
		expect(a?.state).toBe("running");
		expect(b).toBeNull();
	});

	test("claimById returns null for non-queued runs", () => {
		const burrow = seedBurrow(repos);
		const run = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "p",
		});
		repos.runs.markRunning(run.id);
		repos.runs.finalize(run.id, { state: "succeeded" });
		expect(repos.runs.claimById(run.id)).toBeNull();
	});

	test("finalize rejects illegal transitions", () => {
		const burrow = seedBurrow(repos);
		const run = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "p",
		});
		expect(() => repos.runs.finalize(run.id, { state: "succeeded" })).toThrow(
			/illegal run transition/,
		);
	});

	test("finalize returns null when the run row has vanished (burrow-4855)", () => {
		const burrow = seedBurrow(repos);
		const run = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "p",
		});
		repos.runs.markRunning(run.id);
		repos.runs.delete(run.id);
		expect(repos.runs.finalize(run.id, { state: "succeeded" })).toBeNull();
	});

	test("failAllRunning marks every running row failed and returns ids", () => {
		const burrow = seedBurrow(repos);
		const r1 = repos.runs.enqueue({ burrowId: burrow.id, agentId: "x", prompt: "1" });
		const r2 = repos.runs.enqueue({ burrowId: burrow.id, agentId: "x", prompt: "2" });
		const r3 = repos.runs.enqueue({ burrowId: burrow.id, agentId: "x", prompt: "3" });
		repos.runs.markRunning(r1.id);
		repos.runs.markRunning(r2.id);
		// r3 stays queued

		const swept = repos.runs.failAllRunning("crashed");
		expect(new Set(swept)).toEqual(new Set([r1.id, r2.id]));
		expect(repos.runs.require(r1.id).state).toBe("failed");
		expect(repos.runs.require(r1.id).errorMessage).toBe("crashed");
		expect(repos.runs.require(r2.id).state).toBe("failed");
		expect(repos.runs.require(r3.id).state).toBe("queued");
	});

	test("listByBurrow returns runs newest-first", async () => {
		const burrow = seedBurrow(repos);
		const r1 = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "x",
			prompt: "1",
			now: new Date(1000),
		});
		const r2 = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "x",
			prompt: "2",
			now: new Date(2000),
		});
		const list = repos.runs.listByBurrow(burrow.id);
		expect(list.map((r) => r.id)).toEqual([r2.id, r1.id]);
	});
});
