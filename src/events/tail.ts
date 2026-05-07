/**
 * In-memory event pub/sub keyed by burrow id (SPEC §14.3).
 *
 * The bus is a single-process primitive: in-process subscribers (library
 * callers, the run loop, the same-process CLI) get pushes synchronously as
 * the run loop publishes, so chat + logs --follow inside one Bun process
 * runs without polling. Cross-process subscribers — today's CLI, when the
 * run loop lives elsewhere — get the same shape via `pollTail` (see
 * ./poll.ts), which streams from SQLite. Both share the `RunEvent` envelope
 * defined in core/types.ts.
 *
 * No buffering, no backpressure: listeners are called inline. Subscribers
 * that need to fan out to async work should hand off to a queue themselves.
 * SPEC explicitly says SQLite is the source of truth on disconnect — the
 * bus is best-effort delivery to currently-connected listeners, never the
 * primary store.
 */

import type { RunEvent } from "../core/types.ts";

export type EventListener = (event: RunEvent) => void;

export interface Subscription {
	/** Stop receiving events. Idempotent. */
	unsubscribe(): void;
}

export class EventBus {
	private readonly perBurrow = new Map<string, Set<EventListener>>();
	private readonly all = new Set<EventListener>();
	private closed = false;

	/**
	 * Subscribe to events for one burrow. Returns a handle the caller uses to
	 * detach; double-unsubscribe is a no-op so cleanup paths can be defensive.
	 */
	subscribe(burrowId: string, listener: EventListener): Subscription {
		this.assertOpen();
		let set = this.perBurrow.get(burrowId);
		if (!set) {
			set = new Set();
			this.perBurrow.set(burrowId, set);
		}
		set.add(listener);
		return {
			unsubscribe: () => {
				const current = this.perBurrow.get(burrowId);
				if (!current) return;
				current.delete(listener);
				if (current.size === 0) this.perBurrow.delete(burrowId);
			},
		};
	}

	/**
	 * Subscribe to events from every burrow. Used by `burrow events --follow`
	 * (cross-burrow tail). The same listener function will not be called twice
	 * if it's also subscribed per-burrow — those are independent sets.
	 */
	subscribeAll(listener: EventListener): Subscription {
		this.assertOpen();
		this.all.add(listener);
		return {
			unsubscribe: () => {
				this.all.delete(listener);
			},
		};
	}

	/**
	 * Publish to per-burrow subscribers and wildcard subscribers. Listener
	 * exceptions are caught so one bad listener can't poison the rest — bus
	 * is best-effort.
	 */
	publish(event: RunEvent): void {
		if (this.closed) return;
		const set = this.perBurrow.get(event.burrowId);
		if (set) {
			for (const listener of set) safeInvoke(listener, event);
		}
		for (const listener of this.all) safeInvoke(listener, event);
	}

	/**
	 * Drop every subscriber. Subsequent publishes are silently ignored — that
	 * way late-arriving inserts during teardown don't crash the process.
	 */
	close(): void {
		this.closed = true;
		this.perBurrow.clear();
		this.all.clear();
	}

	/** Visible for tests. */
	listenerCount(burrowId?: string): number {
		if (burrowId === undefined) {
			let total = this.all.size;
			for (const set of this.perBurrow.values()) total += set.size;
			return total;
		}
		return (this.perBurrow.get(burrowId)?.size ?? 0) + this.all.size;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("EventBus is closed");
	}
}

function safeInvoke(listener: EventListener, event: RunEvent): void {
	try {
		listener(event);
	} catch {
		// Swallow — bus delivery is best-effort.
	}
}
