import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type BurrowDb, openDatabase } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { BurrowRow } from "../db/schema.ts";
import { tailAll, tailBurrow } from "./poll.ts";

describe("tailBurrow", () => {
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

	test("once mode replays everything past sinceSeq and stops", async () => {
		for (let i = 0; i < 5; i++) {
			repos.events.append({
				burrowId: burrow.id,
				kind: "k",
				stream: "stdout",
				payload: { i },
			});
		}
		const seen: number[] = [];
		for await (const event of tailBurrow(repos, burrow.id, { sinceSeq: 2, once: true })) {
			seen.push(event.seq);
		}
		expect(seen).toEqual([3, 4, 5]);
	});

	test("follow mode picks up new events written after subscription starts", async () => {
		repos.events.append({ burrowId: burrow.id, kind: "k", stream: "stdout", payload: { i: 1 } });

		const ac = new AbortController();
		const seen: number[] = [];
		const consumer = (async () => {
			for await (const event of tailBurrow(repos, burrow.id, {
				signal: ac.signal,
				pollIntervalMs: 5,
			})) {
				seen.push(event.seq);
				if (seen.length >= 3) ac.abort();
			}
		})();

		await new Promise((r) => setTimeout(r, 20));
		repos.events.append({ burrowId: burrow.id, kind: "k", stream: "stdout", payload: { i: 2 } });
		repos.events.append({ burrowId: burrow.id, kind: "k", stream: "stdout", payload: { i: 3 } });

		await consumer;
		expect(seen).toEqual([1, 2, 3]);
	});

	test("aborting before any rows yields nothing", async () => {
		const ac = new AbortController();
		ac.abort();
		const seen: number[] = [];
		for await (const event of tailBurrow(repos, burrow.id, { signal: ac.signal })) {
			seen.push(event.seq);
		}
		expect(seen).toEqual([]);
	});
});

describe("tailAll", () => {
	let db: BurrowDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => db.close());

	test("interleaves events from multiple active burrows by ts", async () => {
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
			kind: "k",
			stream: "stdout",
			payload: { who: "a" },
			ts: new Date(1000),
		});
		repos.events.append({
			burrowId: b.id,
			kind: "k",
			stream: "stdout",
			payload: { who: "b" },
			ts: new Date(2000),
		});
		repos.events.append({
			burrowId: a.id,
			kind: "k",
			stream: "stdout",
			payload: { who: "a2" },
			ts: new Date(3000),
		});

		const seen: string[] = [];
		for await (const event of tailAll(repos, { once: true })) {
			seen.push(`${event.burrowId}:${event.seq}`);
		}
		expect(seen).toEqual([`${a.id}:1`, `${b.id}:1`, `${a.id}:2`]);
	});

	test("skips destroyed burrows from the active set", async () => {
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
		repos.burrows.markDestroyed(b.id);

		const seen: string[] = [];
		for await (const event of tailAll(repos, { once: true })) {
			seen.push(event.burrowId);
		}
		expect(seen).toEqual([a.id]);
	});

	test("burrowIds override is honoured even for non-active burrows", async () => {
		const a = repos.burrows.create({
			kind: "project",
			projectRoot: "/a",
			workspacePath: "/a/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		repos.events.append({ burrowId: a.id, kind: "k", stream: "stdout", payload: {} });
		repos.burrows.markStopped(a.id);
		const seen: string[] = [];
		for await (const event of tailAll(repos, { once: true, burrowIds: [a.id] })) {
			seen.push(event.burrowId);
		}
		expect(seen).toEqual([a.id]);
	});
});
