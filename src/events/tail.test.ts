import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../core/types.ts";
import { EventBus } from "./tail.ts";

function makeEvent(burrowId: string, seq: number): RunEvent {
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

describe("EventBus", () => {
	test("delivers events only to listeners subscribed to that burrow", () => {
		const bus = new EventBus();
		const a: RunEvent[] = [];
		const b: RunEvent[] = [];
		bus.subscribe("bur_a", (e) => a.push(e));
		bus.subscribe("bur_b", (e) => b.push(e));
		bus.publish(makeEvent("bur_a", 1));
		bus.publish(makeEvent("bur_b", 1));
		expect(a.map((e) => e.burrowId)).toEqual(["bur_a"]);
		expect(b.map((e) => e.burrowId)).toEqual(["bur_b"]);
	});

	test("subscribeAll receives events for every burrow", () => {
		const bus = new EventBus();
		const seen: string[] = [];
		bus.subscribeAll((e) => seen.push(e.burrowId));
		bus.publish(makeEvent("bur_a", 1));
		bus.publish(makeEvent("bur_b", 1));
		bus.publish(makeEvent("bur_c", 1));
		expect(seen).toEqual(["bur_a", "bur_b", "bur_c"]);
	});

	test("unsubscribe stops further deliveries and is idempotent", () => {
		const bus = new EventBus();
		const seen: number[] = [];
		const sub = bus.subscribe("bur_a", (e) => seen.push(e.seq));
		bus.publish(makeEvent("bur_a", 1));
		sub.unsubscribe();
		sub.unsubscribe();
		bus.publish(makeEvent("bur_a", 2));
		expect(seen).toEqual([1]);
	});

	test("listener exception doesn't poison other listeners", () => {
		const bus = new EventBus();
		const seen: number[] = [];
		bus.subscribe("bur_a", () => {
			throw new Error("boom");
		});
		bus.subscribe("bur_a", (e) => seen.push(e.seq));
		bus.publish(makeEvent("bur_a", 7));
		expect(seen).toEqual([7]);
	});

	test("close() drops subscribers and silently ignores later publishes", () => {
		const bus = new EventBus();
		const seen: number[] = [];
		bus.subscribe("bur_a", (e) => seen.push(e.seq));
		bus.close();
		bus.publish(makeEvent("bur_a", 1));
		expect(seen).toEqual([]);
		expect(() => bus.subscribe("bur_a", () => {})).toThrow(/closed/);
	});

	test("listenerCount reports per-burrow + wildcard totals", () => {
		const bus = new EventBus();
		bus.subscribe("bur_a", () => {});
		bus.subscribe("bur_a", () => {});
		bus.subscribe("bur_b", () => {});
		bus.subscribeAll(() => {});
		expect(bus.listenerCount("bur_a")).toBe(3);
		expect(bus.listenerCount("bur_b")).toBe(2);
		expect(bus.listenerCount()).toBe(4);
	});

	test("subscribe/unsubscribe cleans up empty per-burrow buckets", () => {
		const bus = new EventBus();
		const sub = bus.subscribe("bur_a", () => {});
		sub.unsubscribe();
		expect(bus.listenerCount("bur_a")).toBe(0);
	});
});
