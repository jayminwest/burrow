/**
 * Helper that appends an event to SQLite and immediately publishes it on the
 * in-memory bus (SPEC §14.3 — "the run loop publishes to subscribers on
 * insert"). Keeping the two-step in one place stops callers from forgetting
 * to publish, while still letting them write directly through `repos.events`
 * when they don't care about live subscribers.
 *
 * Append happens inside `EventsRepo.append` (transactional, monotonic seq).
 * Publish happens after the row is committed, with the bus tolerating
 * duplicate or absent listeners — see ./tail.ts.
 */

import { eventRowToEvent, type RunEvent } from "../core/types.ts";
import type { AppendEventInput, EventsRepo } from "../db/repos/events.ts";
import type { EventBus } from "./tail.ts";

export interface AppendAndPublishInput extends AppendEventInput {
	repo: EventsRepo;
	bus?: EventBus;
}

export function appendAndPublish(input: AppendAndPublishInput): RunEvent {
	const { repo, bus, ...append } = input;
	const row = repo.append(append);
	const event = eventRowToEvent(row);
	bus?.publish(event);
	return event;
}
