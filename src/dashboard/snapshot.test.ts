/**
 * Synthetic-DB tests for `buildSnapshot`. Spins up an in-memory SQLite via
 * `openDatabase({path: ':memory:'})`, seeds rows through the real repos,
 * and asserts the projection. Timestamps are seeded at whole seconds so
 * drizzle's `mode: 'timestamp'` (unix-second) round-trip stays stable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type BurrowDb, openDatabase } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { buildSnapshot, DEFAULT_RUNS_PER_CARD } from "./snapshot.ts";
import { DASHBOARD_SNAPSHOT_VERSION, DEFAULT_EVENT_TAIL_CAP } from "./types.ts";

const NOW = new Date("2026-05-07T19:00:00.000Z");

function seedBurrow(
	repos: Repos,
	overrides: { kind?: "project" | "task"; parentId?: string; name?: string; createdAt?: Date } = {},
) {
	return repos.burrows.create({
		kind: overrides.kind ?? "project",
		parentId: overrides.parentId,
		name: overrides.name,
		projectRoot: "/work/proj",
		workspacePath: "/work/proj/.burrow/ws",
		branch: "main",
		provider: "local",
		profile: {},
		now: overrides.createdAt,
	});
}

describe("buildSnapshot", () => {
	let db: BurrowDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => db.close());

	test("empty repos yields an empty snapshot envelope", () => {
		const snap = buildSnapshot(repos, { now: NOW });
		expect(snap).toEqual({
			type: "snapshot",
			version: DASHBOARD_SNAPSHOT_VERSION,
			ts: NOW.toISOString(),
			burrows: [],
		});
	});

	test("envelope ts comes from options.now (deterministic for tests)", () => {
		const fixed = new Date("2026-01-02T03:04:05.678Z");
		const snap = buildSnapshot(repos, { now: fixed });
		expect(snap.ts).toBe(fixed.toISOString());
	});

	test("envelope ts defaults to now when options.now omitted", () => {
		const before = Date.now();
		const snap = buildSnapshot(repos);
		const after = Date.now();
		const ts = Date.parse(snap.ts);
		expect(ts).toBeGreaterThanOrEqual(before);
		expect(ts).toBeLessThanOrEqual(after);
	});

	test("burrow with no runs or events maps to a bare card", () => {
		const burrow = seedBurrow(repos, { name: "alpha", createdAt: new Date(1000) });
		const snap = buildSnapshot(repos, { now: NOW });
		expect(snap.burrows).toHaveLength(1);
		const card = snap.burrows[0];
		expect(card).toBeDefined();
		if (!card) return;
		expect(card.id).toBe(burrow.id);
		expect(card.parentId).toBeNull();
		expect(card.kind).toBe("project");
		expect(card.name).toBe("alpha");
		expect(card.state).toBe("active");
		expect(card.runs).toEqual([]);
		expect(card.activeRun).toBeNull();
		expect(card.eventTail).toEqual([]);
		expect(card.lastEventSeq).toBeNull();
		expect(card.destroyedAt).toBeNull();
		expect(card.createdAt).toBe(new Date(1000).toISOString());
		expect(card.updatedAt).toBe(new Date(1000).toISOString());
	});

	test("task burrow surfaces parentId; destroyed burrow surfaces destroyedAt", () => {
		const parent = seedBurrow(repos, { createdAt: new Date(1000) });
		const child = seedBurrow(repos, {
			kind: "task",
			parentId: parent.id,
			createdAt: new Date(2000),
		});
		const destroyedAt = new Date(3000);
		repos.burrows.markDestroyed(child.id, destroyedAt);

		const snap = buildSnapshot(repos, { now: NOW });
		const childCard = snap.burrows.find((c) => c.id === child.id);
		expect(childCard).toBeDefined();
		if (!childCard) return;
		expect(childCard.kind).toBe("task");
		expect(childCard.parentId).toBe(parent.id);
		expect(childCard.state).toBe("destroyed");
		expect(childCard.destroyedAt).toBe(destroyedAt.toISOString());
		expect(childCard.updatedAt).toBe(destroyedAt.toISOString());
	});

	test("multiple burrows preserve listAll's updated-at-desc order", () => {
		const a = seedBurrow(repos, { name: "a", createdAt: new Date(1000) });
		const b = seedBurrow(repos, { name: "b", createdAt: new Date(2000) });
		const c = seedBurrow(repos, { name: "c", createdAt: new Date(3000) });

		const snap = buildSnapshot(repos, { now: NOW });
		expect(snap.burrows.map((card) => card.id)).toEqual([c.id, b.id, a.id]);
	});

	test("runs are newest-first and shaped as RunSummary (no prompt/metadata)", () => {
		const burrow = seedBurrow(repos);
		const r1 = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "first",
			metadata: { trace: 1 },
			now: new Date(1000),
		});
		const r2 = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "second",
			now: new Date(2000),
		});

		const snap = buildSnapshot(repos, { now: NOW });
		const card = snap.burrows[0];
		expect(card).toBeDefined();
		if (!card) return;
		expect(card.runs.map((r) => r.id)).toEqual([r2.id, r1.id]);
		const summary = card.runs[0];
		expect(summary).toBeDefined();
		if (!summary) return;
		expect(Object.keys(summary).sort()).toEqual([
			"agentId",
			"burrowId",
			"completedAt",
			"errorMessage",
			"exitCode",
			"id",
			"queuedAt",
			"startedAt",
			"state",
		]);
		expect(summary.state).toBe("queued");
		expect(summary.queuedAt).toBe(new Date(2000).toISOString());
		expect(summary.startedAt).toBeNull();
		expect(summary.completedAt).toBeNull();
	});

	test("activeRun prefers running over queued", () => {
		const burrow = seedBurrow(repos);
		const queued = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "q",
			now: new Date(3000),
		});
		const running = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "r",
			now: new Date(1000),
		});
		repos.runs.markRunning(running.id, new Date(2000));

		const snap = buildSnapshot(repos, { now: NOW });
		const card = snap.burrows[0];
		expect(card).toBeDefined();
		if (!card) return;
		expect(card.activeRun?.id).toBe(running.id);
		expect(card.activeRun?.state).toBe("running");
		expect(card.activeRun?.startedAt).toBe(new Date(2000).toISOString());
		// activeRun is also present in runs[]
		expect(card.runs.some((r) => r.id === running.id)).toBe(true);
		// runs newest-first (queued at 3000) > (running at 1000)
		expect(card.runs[0]?.id).toBe(queued.id);
	});

	test("activeRun falls back to queued when nothing is running", () => {
		const burrow = seedBurrow(repos);
		const old = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "x",
			prompt: "old",
			now: new Date(1000),
		});
		repos.runs.markRunning(old.id, new Date(2000));
		repos.runs.finalize(old.id, { state: "succeeded", now: new Date(3000) });
		const queued = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "x",
			prompt: "queued",
			now: new Date(4000),
		});

		const snap = buildSnapshot(repos, { now: NOW });
		const card = snap.burrows[0];
		expect(card?.activeRun?.id).toBe(queued.id);
		expect(card?.activeRun?.state).toBe("queued");
	});

	test("activeRun is null when every run is terminal", () => {
		const burrow = seedBurrow(repos);
		const run = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "x",
			prompt: "p",
			now: new Date(1000),
		});
		repos.runs.markRunning(run.id, new Date(2000));
		repos.runs.finalize(run.id, {
			state: "succeeded",
			exitCode: 0,
			now: new Date(3000),
		});

		const snap = buildSnapshot(repos, { now: NOW });
		const card = snap.burrows[0];
		expect(card?.activeRun).toBeNull();
		expect(card?.runs[0]?.state).toBe("succeeded");
		expect(card?.runs[0]?.exitCode).toBe(0);
		expect(card?.runs[0]?.completedAt).toBe(new Date(3000).toISOString());
	});

	test("runs are capped at runsLimit (newest first)", () => {
		const burrow = seedBurrow(repos);
		const ids: string[] = [];
		for (let i = 1; i <= 5; i++) {
			const r = repos.runs.enqueue({
				burrowId: burrow.id,
				agentId: "x",
				prompt: `p${i}`,
				now: new Date(i * 1000),
			});
			ids.push(r.id);
		}
		const snap = buildSnapshot(repos, { now: NOW, runsLimit: 2 });
		const card = snap.burrows[0];
		expect(card?.runs).toHaveLength(2);
		// newest two, in newest-first order
		expect(card?.runs.map((r) => r.id)).toEqual(ids.slice(-2).reverse());
	});

	test("runs default cap is DEFAULT_RUNS_PER_CARD when caller omits runsLimit", () => {
		const burrow = seedBurrow(repos);
		const total = DEFAULT_RUNS_PER_CARD + 5;
		for (let i = 1; i <= total; i++) {
			repos.runs.enqueue({
				burrowId: burrow.id,
				agentId: "x",
				prompt: `p${i}`,
				now: new Date(i * 1000),
			});
		}
		const snap = buildSnapshot(repos, { now: NOW });
		expect(snap.burrows[0]?.runs).toHaveLength(DEFAULT_RUNS_PER_CARD);
	});

	test("eventTail is oldest-first within window and capped at eventTailCap", () => {
		const burrow = seedBurrow(repos);
		for (let i = 1; i <= 10; i++) {
			repos.events.append({
				burrowId: burrow.id,
				kind: "tool_use",
				stream: "stdout",
				payload: { i },
				ts: new Date(i * 1000),
			});
		}
		const snap = buildSnapshot(repos, { now: NOW, eventTailCap: 3 });
		const card = snap.burrows[0];
		expect(card?.eventTail.map((e) => e.seq)).toEqual([8, 9, 10]);
		// oldest-first within the window: ts 8000, 9000, 10000
		expect(card?.eventTail.map((e) => e.ts)).toEqual([
			new Date(8000).toISOString(),
			new Date(9000).toISOString(),
			new Date(10000).toISOString(),
		]);
		expect(card?.lastEventSeq).toBe(10);
	});

	test("eventTail returns every event when count <= cap", () => {
		const burrow = seedBurrow(repos);
		for (let i = 1; i <= 3; i++) {
			repos.events.append({
				burrowId: burrow.id,
				kind: "kind",
				stream: "stdout",
				payload: { i },
				ts: new Date(i * 1000),
			});
		}
		const snap = buildSnapshot(repos, { now: NOW, eventTailCap: 100 });
		expect(snap.burrows[0]?.eventTail.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(snap.burrows[0]?.lastEventSeq).toBe(3);
	});

	test("EventTailEntry omits the row id and exposes payload as `payload`", () => {
		const burrow = seedBurrow(repos);
		const run = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "x",
			prompt: "p",
			now: new Date(1000),
		});
		repos.events.append({
			burrowId: burrow.id,
			runId: run.id,
			kind: "tool_result",
			stream: "stderr",
			payload: { ok: true, items: [1, 2, 3] },
			ts: new Date(2000),
		});

		const snap = buildSnapshot(repos, { now: NOW });
		const entry = snap.burrows[0]?.eventTail[0];
		expect(entry).toBeDefined();
		if (!entry) return;
		expect(Object.keys(entry).sort()).toEqual([
			"burrowId",
			"kind",
			"payload",
			"runId",
			"seq",
			"stream",
			"ts",
		]);
		expect(entry.burrowId).toBe(burrow.id);
		expect(entry.runId).toBe(run.id);
		expect(entry.stream).toBe("stderr");
		expect(entry.kind).toBe("tool_result");
		expect(entry.ts).toBe(new Date(2000).toISOString());
		expect(entry.payload).toEqual({ ok: true, items: [1, 2, 3] });
	});

	test("event tail and run history are isolated per burrow", () => {
		const a = seedBurrow(repos, { name: "a", createdAt: new Date(1000) });
		const b = seedBurrow(repos, { name: "b", createdAt: new Date(2000) });

		repos.events.append({
			burrowId: a.id,
			kind: "k",
			stream: "stdout",
			payload: { from: "a" },
			ts: new Date(3000),
		});
		repos.events.append({
			burrowId: b.id,
			kind: "k",
			stream: "stdout",
			payload: { from: "b" },
			ts: new Date(4000),
		});

		const snap = buildSnapshot(repos, { now: NOW });
		const cardA = snap.burrows.find((c) => c.id === a.id);
		const cardB = snap.burrows.find((c) => c.id === b.id);
		expect(cardA?.eventTail).toHaveLength(1);
		expect(cardA?.eventTail[0]?.payload).toEqual({ from: "a" });
		expect(cardB?.eventTail).toHaveLength(1);
		expect(cardB?.eventTail[0]?.payload).toEqual({ from: "b" });
	});

	test("snapshot is JSON-serializable end-to-end (timestamps are ISO strings)", () => {
		const burrow = seedBurrow(repos, { createdAt: new Date(1000) });
		const run = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "x",
			prompt: "p",
			now: new Date(1000),
		});
		repos.runs.markRunning(run.id, new Date(2000));
		repos.events.append({
			burrowId: burrow.id,
			runId: run.id,
			kind: "tool_use",
			stream: "stdout",
			payload: { tool: "Bash" },
			ts: new Date(3000),
		});

		const snap = buildSnapshot(repos, { now: NOW });
		const restored = JSON.parse(JSON.stringify(snap));
		expect(restored).toEqual(snap);
		// nullable fields must round-trip as nulls (not undefined)
		const card = restored.burrows[0];
		expect(card.parentId).toBeNull();
		expect(card.destroyedAt).toBeNull();
		expect(card.runs[0].completedAt).toBeNull();
	});

	test("default eventTailCap is DEFAULT_EVENT_TAIL_CAP", () => {
		const burrow = seedBurrow(repos);
		const total = DEFAULT_EVENT_TAIL_CAP + 3;
		for (let i = 1; i <= total; i++) {
			repos.events.append({
				burrowId: burrow.id,
				kind: "k",
				stream: "stdout",
				payload: { i },
				ts: new Date(i * 1000),
			});
		}
		const snap = buildSnapshot(repos, { now: NOW });
		const card = snap.burrows[0];
		expect(card?.eventTail).toHaveLength(DEFAULT_EVENT_TAIL_CAP);
		expect(card?.lastEventSeq).toBe(total);
		expect(card?.eventTail[0]?.seq).toBe(total - DEFAULT_EVENT_TAIL_CAP + 1);
	});
});
