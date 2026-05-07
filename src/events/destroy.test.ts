import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BurrowDb, openDatabase } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { BurrowRow } from "../db/schema.ts";
import { destroyBurrowStorage } from "./destroy.ts";

describe("destroyBurrowStorage", () => {
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
		archiveRoot = mkdtempSync(join(tmpdir(), "burrow-destroy-"));
	});

	afterEach(() => {
		db.close();
		rmSync(archiveRoot, { recursive: true, force: true });
	});

	test("archives and deletes live rows, then marks the burrow destroyed", async () => {
		repos.events.append({
			burrowId: burrow.id,
			kind: "k",
			stream: "stdout",
			payload: {},
		});
		repos.messages.send({ burrowId: burrow.id, fromActor: "user", body: "hi" });
		repos.runs.enqueue({ burrowId: burrow.id, agentId: "claude-code", prompt: "p" });

		const result = await destroyBurrowStorage({
			db,
			burrowId: burrow.id,
			archiveRoot,
		});

		expect(result.archived).not.toBeNull();
		expect(result.deletedEvents).toBe(1);
		expect(result.deletedMessages).toBe(1);
		expect(result.deletedRuns).toBe(1);

		const after = repos.burrows.require(burrow.id);
		expect(after.state).toBe("destroyed");
		expect(after.destroyedAt).not.toBeNull();
		expect(repos.events.listByBurrow(burrow.id)).toEqual([]);
		expect(repos.messages.listByBurrow(burrow.id)).toEqual([]);
		expect(repos.runs.listByBurrow(burrow.id)).toEqual([]);

		expect(existsSync(result.archived?.eventsPath ?? "")).toBe(true);
		const lines = readFileSync(result.archived?.eventsPath ?? "", "utf8")
			.trimEnd()
			.split("\n");
		expect(lines).toHaveLength(1);
	});

	test("archive=false skips export but still prunes and marks destroyed", async () => {
		repos.events.append({
			burrowId: burrow.id,
			kind: "k",
			stream: "stdout",
			payload: {},
		});
		const result = await destroyBurrowStorage({
			db,
			burrowId: burrow.id,
			archiveRoot,
			archive: false,
		});
		expect(result.archived).toBeNull();
		expect(repos.events.listByBurrow(burrow.id)).toEqual([]);
		expect(repos.burrows.require(burrow.id).state).toBe("destroyed");
		expect(existsSync(join(archiveRoot, burrow.id))).toBe(false);
	});

	test("throws on unknown burrow id", async () => {
		await expect(
			destroyBurrowStorage({ db, burrowId: "bur_missing", archiveRoot }),
		).rejects.toThrow(/burrow not found/);
	});
});
