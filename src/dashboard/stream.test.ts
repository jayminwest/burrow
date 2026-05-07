/**
 * Tests for `streamSnapshots` — the live snapshot generator that drives
 * the TUI and `burrow watch --json`. Acceptance criteria covered map to
 * pl-2085 (#7 coalescing, #8 leak-free, #9 concurrent CLI tail).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RunEvent } from "../core/types.ts";
import { type BurrowDb, openDatabase } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { tailAll } from "../events/poll.ts";
import { appendAndPublish } from "../events/publish.ts";
import { EventBus } from "../events/tail.ts";
import { streamSnapshots } from "./stream.ts";
import type { DashboardSnapshot } from "./types.ts";

const NOW = new Date("2026-05-07T19:00:00.000Z");

function makeSyntheticEvent(burrowId: string, seq: number): RunEvent {
	return {
		id: seq,
		burrowId,
		runId: null,
		seq,
		kind: "tool_use",
		stream: "stdout",
		payload: { i: seq },
		ts: new Date(seq * 1000),
	};
}

function seedBurrow(repos: Repos, name = "alpha") {
	return repos.burrows.create({
		kind: "project",
		name,
		projectRoot: "/work/proj",
		workspacePath: "/work/proj/.burrow/ws",
		branch: "main",
		provider: "local",
		profile: {},
		now: new Date(1000),
	});
}

describe("streamSnapshots", () => {
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

	test("emits initial snapshot synchronously on subscribe", async () => {
		seedBurrow(repos, "alpha");
		const ac = new AbortController();
		const stream = streamSnapshots(repos, bus, {
			signal: ac.signal,
			now: () => NOW,
			pollIntervalMs: 0,
		});
		const first = await stream.next();
		ac.abort();
		await stream.return();

		expect(first.done).toBe(false);
		const snap = first.value as DashboardSnapshot;
		expect(snap.type).toBe("snapshot");
		expect(snap.ts).toBe(NOW.toISOString());
		expect(snap.burrows).toHaveLength(1);
		expect(snap.burrows[0]?.name).toBe("alpha");
	});

	test("emitInitial=false skips the leading frame", async () => {
		seedBurrow(repos);
		const ac = new AbortController();
		const stream = streamSnapshots(repos, bus, {
			signal: ac.signal,
			emitInitial: false,
			pollIntervalMs: 0,
			coalesceMs: 0,
		});
		// abort before any wake fires; stream should yield nothing
		ac.abort();
		const result = await stream.next();
		expect(result.done).toBe(true);
	});

	test("a bus event triggers a coalesced trailing emission", async () => {
		const burrow = seedBurrow(repos);
		const ac = new AbortController();
		const stream = streamSnapshots(repos, bus, {
			signal: ac.signal,
			coalesceMs: 10,
			pollIntervalMs: 0,
		});
		const initial = await stream.next();
		expect(initial.done).toBe(false);

		// Append + publish a real event so the snapshot reflects it.
		appendAndPublish({
			repo: repos.events,
			bus,
			burrowId: burrow.id,
			kind: "tool_use",
			stream: "stdout",
			payload: { from: "test" },
			ts: new Date(2000),
		});

		const next = await stream.next();
		ac.abort();
		await stream.return();
		expect(next.done).toBe(false);
		const snap = next.value as DashboardSnapshot;
		expect(snap.burrows[0]?.eventTail).toHaveLength(1);
		expect(snap.burrows[0]?.lastEventSeq).toBe(1);
	});

	test("coalesces a burst of 100 events into ≤2 emissions (pl-2085 #7)", async () => {
		seedBurrow(repos);
		const ac = new AbortController();
		const stream = streamSnapshots(repos, bus, {
			signal: ac.signal,
			coalesceMs: 30,
			pollIntervalMs: 0,
			emitInitial: false,
		});

		const seen: DashboardSnapshot[] = [];
		const consumer = (async () => {
			for await (const snap of stream) {
				seen.push(snap);
			}
		})();

		// Burst 100 synthetic events as fast as possible.
		const id = repos.burrows.listAll()[0]?.id ?? "missing";
		for (let i = 1; i <= 100; i++) {
			bus.publish(makeSyntheticEvent(id, i));
		}

		// Wait long enough for the trailing window + any redundant emission.
		await new Promise((r) => setTimeout(r, 120));
		ac.abort();
		await consumer;

		expect(seen.length).toBeGreaterThanOrEqual(1);
		expect(seen.length).toBeLessThanOrEqual(2);
	});

	test("polling fallback yields snapshots when no bus events fire (pl-2085 #9)", async () => {
		seedBurrow(repos);
		const ac = new AbortController();
		const stream = streamSnapshots(repos, bus, {
			signal: ac.signal,
			coalesceMs: 0,
			pollIntervalMs: 5,
			emitInitial: false,
		});

		const seen: DashboardSnapshot[] = [];
		const consumer = (async () => {
			for await (const snap of stream) {
				seen.push(snap);
				if (seen.length >= 3) ac.abort();
			}
		})();

		await consumer;
		expect(seen.length).toBeGreaterThanOrEqual(3);
		// Same burrow surfaces in every snapshot.
		expect(seen.every((s) => s.burrows.length === 1)).toBe(true);
	});

	test("abort signal stops emissions and runs cleanup (pl-2085 #8)", async () => {
		seedBurrow(repos);
		const ac = new AbortController();
		const stream = streamSnapshots(repos, bus, {
			signal: ac.signal,
			coalesceMs: 5,
			pollIntervalMs: 5,
		});
		await stream.next(); // consume initial
		expect(bus.listenerCount()).toBe(1);
		ac.abort();
		const result = await stream.next();
		expect(result.done).toBe(true);
		expect(bus.listenerCount()).toBe(0);
	});

	test("opening + closing 100 streams leaves zero residual listeners (pl-2085 #8)", async () => {
		seedBurrow(repos);
		expect(bus.listenerCount()).toBe(0);

		for (let i = 0; i < 100; i++) {
			const ac = new AbortController();
			const stream = streamSnapshots(repos, bus, {
				signal: ac.signal,
				coalesceMs: 0,
				pollIntervalMs: 0,
			});
			await stream.next();
			ac.abort();
			await stream.return();
		}

		expect(bus.listenerCount()).toBe(0);
	});

	test("consumer breaking out of for-await tears down listeners", async () => {
		seedBurrow(repos);
		const stream = streamSnapshots(repos, bus, {
			coalesceMs: 0,
			pollIntervalMs: 5,
		});
		let count = 0;
		for await (const _ of stream) {
			count++;
			if (count >= 1) break;
		}
		expect(bus.listenerCount()).toBe(0);
	});

	test("aborting before the first .next() yields nothing and detaches", async () => {
		seedBurrow(repos);
		const ac = new AbortController();
		ac.abort();
		const stream = streamSnapshots(repos, bus, { signal: ac.signal });
		const result = await stream.next();
		expect(result.done).toBe(true);
		expect(bus.listenerCount()).toBe(0);
	});

	test("each emission calls opts.now() fresh", async () => {
		seedBurrow(repos);
		const stampA = new Date("2026-05-07T19:00:00.000Z");
		const stampB = new Date("2026-05-07T19:00:01.000Z");
		const stamps = [stampA, stampB];
		let i = 0;
		const ac = new AbortController();
		const stream = streamSnapshots(repos, bus, {
			signal: ac.signal,
			coalesceMs: 0,
			pollIntervalMs: 0,
			now: () => stamps[i++] ?? stampB,
		});
		const first = (await stream.next()).value as DashboardSnapshot;
		// Trigger a second emission via bus.
		const id = repos.burrows.listAll()[0]?.id ?? "missing";
		bus.publish(makeSyntheticEvent(id, 1));
		const second = (await stream.next()).value as DashboardSnapshot;
		ac.abort();
		await stream.return();
		expect(first.ts).toBe(stampA.toISOString());
		expect(second.ts).toBe(stampB.toISOString());
	});

	test("does not starve a concurrent burrow events --follow tail (pl-2085 #9)", async () => {
		const burrow = seedBurrow(repos);
		const ac = new AbortController();

		const snapStream = streamSnapshots(repos, bus, {
			signal: ac.signal,
			coalesceMs: 5,
			pollIntervalMs: 5,
			emitInitial: false,
		});
		const tailGen = tailAll(repos, { signal: ac.signal, pollIntervalMs: 5 });

		const snaps: DashboardSnapshot[] = [];
		const tailEvents: number[] = [];

		const snapConsumer = (async () => {
			for await (const snap of snapStream) snaps.push(snap);
		})();
		const tailConsumer = (async () => {
			for await (const event of tailGen) tailEvents.push(event.seq);
		})();

		// Drive a few writes; both consumers should see them.
		for (let i = 1; i <= 5; i++) {
			appendAndPublish({
				repo: repos.events,
				bus,
				burrowId: burrow.id,
				kind: "k",
				stream: "stdout",
				payload: { i },
				ts: new Date(i * 1000),
			});
			await new Promise((r) => setTimeout(r, 10));
		}
		await new Promise((r) => setTimeout(r, 30));
		ac.abort();
		await Promise.all([snapConsumer, tailConsumer]);

		expect(tailEvents).toEqual([1, 2, 3, 4, 5]);
		expect(snaps.length).toBeGreaterThanOrEqual(1);
		// The latest snapshot reflects every event.
		const latest = snaps[snaps.length - 1];
		expect(latest?.burrows[0]?.lastEventSeq).toBe(5);
	});
});
