import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RunEvent } from "../core/types.ts";
import { type BurrowDb, openDatabase } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { appendAndPublish } from "./publish.ts";
import { EventBus } from "./tail.ts";

describe("appendAndPublish", () => {
	let db: BurrowDb;
	let repos: Repos;
	let bus: EventBus;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		bus = new EventBus();
	});

	afterEach(() => {
		bus.close();
		db.close();
	});

	test("inserts the row, then publishes the live envelope to the bus", () => {
		const burrow = repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const seen: RunEvent[] = [];
		bus.subscribe(burrow.id, (e) => seen.push(e));
		const ts = new Date(1_700_000_000_000);
		const published = appendAndPublish({
			repo: repos.events,
			bus,
			burrowId: burrow.id,
			kind: "tool_use",
			stream: "stdout",
			payload: { tool: "Bash" },
			ts,
		});
		expect(published.seq).toBe(1);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.seq).toBe(1);
		expect(seen[0]?.kind).toBe("tool_use");
		expect(repos.events.listByBurrow(burrow.id)).toHaveLength(1);
	});

	test("works without a bus — append still happens", () => {
		const burrow = repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const event = appendAndPublish({
			repo: repos.events,
			burrowId: burrow.id,
			kind: "text",
			stream: "stdout",
			payload: { text: "hi" },
		});
		expect(event.seq).toBe(1);
		expect(repos.events.listByBurrow(burrow.id)).toHaveLength(1);
	});
});
