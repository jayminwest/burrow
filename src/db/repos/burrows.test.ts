import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { type BurrowDb, openDatabase } from "../client.ts";
import { createRepos, type Repos } from "./index.ts";

describe("BurrowsRepo", () => {
	let db: BurrowDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => db.close());

	test("creates a project burrow with generated id", () => {
		// SQLite `mode: 'timestamp'` truncates to whole seconds, so we pass an
		// already-floored `now` to keep the round-trip equality assertion stable.
		const now = new Date(Math.floor(Date.now() / 1000) * 1000);
		const row = repos.burrows.create({
			kind: "project",
			projectRoot: "/repo",
			workspacePath: "/repo/.workspace",
			branch: "main",
			provider: "local",
			profile: { network: "none" },
			now,
		});
		expect(row.id).toMatch(/^bur_/);
		expect(row.state).toBe("active");
		expect(repos.burrows.get(row.id)).toEqual(row);
	});

	test("rejects task burrow without parentId", () => {
		expect(() =>
			repos.burrows.create({
				kind: "task",
				projectRoot: "/repo",
				workspacePath: "/repo/.workspace",
				branch: "task/x",
				provider: "local",
				profile: {},
			}),
		).toThrow(ValidationError);
	});

	test("require throws NotFoundError for missing id", () => {
		expect(() => repos.burrows.require("bur_doesnotexist0")).toThrow(NotFoundError);
	});

	test("listByState filters by state and optional kind", () => {
		const a = repos.burrows.create({
			kind: "project",
			projectRoot: "/a",
			workspacePath: "/a/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const b = repos.burrows.create({
			kind: "task",
			parentId: a.id,
			projectRoot: "/a",
			workspacePath: "/a/ws-task",
			branch: "task/b",
			provider: "local",
			profile: {},
		});
		repos.burrows.markStopped(b.id);
		const active = repos.burrows.listByState("active");
		expect(active.map((r) => r.id)).toEqual([a.id]);
		const stoppedTasks = repos.burrows.listByState("stopped", "task");
		expect(stoppedTasks.map((r) => r.id)).toEqual([b.id]);
	});

	test("transitions follow the state machine", () => {
		const a = repos.burrows.create({
			kind: "project",
			projectRoot: "/a",
			workspacePath: "/a/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		repos.burrows.markStopped(a.id);
		repos.burrows.markActive(a.id);
		const destroyed = repos.burrows.markDestroyed(a.id);
		expect(destroyed.state).toBe("destroyed");
		expect(destroyed.destroyedAt).toBeInstanceOf(Date);
		expect(() => repos.burrows.markActive(a.id)).toThrow(/illegal burrow transition/);
	});

	test("deleteDestroyed removes only destroyed rows and returns their ids", () => {
		const live = repos.burrows.create({
			kind: "project",
			projectRoot: "/a",
			workspacePath: "/a/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const gone = repos.burrows.create({
			kind: "project",
			projectRoot: "/b",
			workspacePath: "/b/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		repos.burrows.markDestroyed(gone.id);

		const pruned = repos.burrows.deleteDestroyed();
		expect(pruned).toEqual([gone.id]);
		expect(repos.burrows.get(gone.id)).toBeNull();
		expect(repos.burrows.get(live.id)?.state).toBe("active");

		expect(repos.burrows.deleteDestroyed()).toEqual([]);
	});
});
