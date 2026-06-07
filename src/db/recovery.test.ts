import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type BurrowDb, openDatabase } from "./client.ts";
import { CRASH_ERROR_MESSAGE, runStartupRecovery } from "./recovery.ts";
import { createRepos, type Repos } from "./repos/index.ts";

describe("runStartupRecovery", () => {
	let db: BurrowDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => db.close());

	test("fails stuck running rows and resets orphan deliveries", () => {
		const burrow = repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});

		const stuckRun = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "stuck",
		});
		repos.runs.markRunning(stuckRun.id);

		const msg = repos.messages.send({ burrowId: burrow.id, fromActor: "u", body: "go" });
		repos.messages.markDelivered(msg.id, stuckRun.id);

		const result = runStartupRecovery(repos);
		expect(result.failedRunIds).toEqual([stuckRun.id]);
		expect(result.resetMessageIds).toEqual([msg.id]);
		expect(repos.runs.require(stuckRun.id).state).toBe("failed");
		expect(repos.runs.require(stuckRun.id).errorMessage).toBe(CRASH_ERROR_MESSAGE);
		expect(repos.messages.require(msg.id).state).toBe("unread");
	});

	test("is a no-op on a clean database", () => {
		const result = runStartupRecovery(repos);
		expect(result.failedRunIds).toEqual([]);
		expect(result.resetMessageIds).toEqual([]);
		expect(result.prunedBurrowIds).toEqual([]);
	});

	test("prunes destroyed burrow rows so they stop accumulating", () => {
		const burrow = repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		repos.burrows.markDestroyed(burrow.id);

		const result = runStartupRecovery(repos);
		expect(result.prunedBurrowIds).toEqual([burrow.id]);
		expect(repos.burrows.get(burrow.id)).toBeNull();
	});
});
