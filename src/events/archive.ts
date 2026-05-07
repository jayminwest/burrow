/**
 * On-destroy NDJSON archiver (SPEC §14.4).
 *
 * `burrow destroy` writes a complete audit trail under
 * `${dataDir}/archive/<burrowId>/` so months later a team can grep across
 * the directory to reconstruct what an agent did. We export three files:
 *
 *   - `events.jsonl`   — every row from `events` for the burrow, ordered by seq.
 *                        One JSON envelope per line, matching the live tail
 *                        envelope (SPEC §14.1) so consumers don't need a
 *                        second parser.
 *   - `messages.jsonl` — every steering message ever queued at the burrow
 *                        (delivered, failed, or unread), ordered by createdAt.
 *   - `runs.json`      — one summary blob with the burrow row + every run.
 *
 * The CLI command and library API delete live rows after a successful
 * archive; this module is purely the export step. We intentionally read
 * straight from the repos (not raw drizzle) so a future schema migration
 * keeps the archive shape stable through the same row-mapper.
 */

import { existsSync, mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { eventRowToEvent } from "../core/types.ts";
import type { Repos } from "../db/repos/index.ts";
import type { BurrowRow, MessageRow, RunRow } from "../db/schema.ts";

export interface ArchiveBurrowInput {
	repos: Repos;
	burrowId: string;
	/** Root archive directory — usually `paths.archiveDir`. One sub-dir per burrow. */
	archiveRoot: string;
	/** Override page size for chunked reads. Default 1000. */
	batchSize?: number;
}

export interface ArchiveBurrowResult {
	burrowId: string;
	directory: string;
	eventsPath: string;
	messagesPath: string;
	runsPath: string;
	eventCount: number;
	messageCount: number;
	runCount: number;
}

export interface RunsArchive {
	burrow: BurrowRow;
	runs: RunRow[];
	exportedAt: string;
}

const DEFAULT_BATCH = 1000;

/**
 * Write events/messages/runs for one burrow into `<archiveRoot>/<burrowId>/`.
 * Throws if the burrow doesn't exist; otherwise creates the directory and
 * (over)writes the three files. Returns the file paths and counts so the
 * destroy command can print a confirmation summary.
 */
export async function archiveBurrow(input: ArchiveBurrowInput): Promise<ArchiveBurrowResult> {
	const burrow = input.repos.burrows.require(input.burrowId);
	const directory = join(input.archiveRoot, burrow.id);
	mkdirSync(directory, { recursive: true });

	const eventsPath = join(directory, "events.jsonl");
	const messagesPath = join(directory, "messages.jsonl");
	const runsPath = join(directory, "runs.json");

	const eventCount = await writeEventsJsonl(input.repos, burrow.id, eventsPath, input.batchSize);
	const messageCount = await writeMessagesJsonl(input.repos, burrow.id, messagesPath);
	const runs = input.repos.runs.listByBurrow(burrow.id, Number.MAX_SAFE_INTEGER);
	await writeRunsJson(burrow, runs, runsPath);

	return {
		burrowId: burrow.id,
		directory,
		eventsPath,
		messagesPath,
		runsPath,
		eventCount,
		messageCount,
		runCount: runs.length,
	};
}

async function writeEventsJsonl(
	repos: Repos,
	burrowId: string,
	path: string,
	batchSize: number = DEFAULT_BATCH,
): Promise<number> {
	ensureParent(path);
	const handle = await open(path, "w");
	try {
		let cursor = 0;
		let total = 0;
		while (true) {
			const rows = repos.events.listByBurrow(burrowId, {
				sinceSeq: cursor,
				limit: batchSize,
			});
			if (rows.length === 0) break;
			let chunk = "";
			for (const row of rows) {
				chunk += `${JSON.stringify(eventRowToEnvelope(row))}\n`;
			}
			await handle.write(chunk);
			total += rows.length;
			const last = rows[rows.length - 1];
			if (!last) break;
			cursor = last.seq;
			if (rows.length < batchSize) break;
		}
		return total;
	} finally {
		await handle.close();
	}
}

async function writeMessagesJsonl(repos: Repos, burrowId: string, path: string): Promise<number> {
	ensureParent(path);
	const messages = repos.messages.listByBurrow(burrowId).sort(byCreatedAtAsc);
	const handle = await open(path, "w");
	try {
		let chunk = "";
		for (const m of messages) chunk += `${JSON.stringify(messageRowToEnvelope(m))}\n`;
		if (chunk.length > 0) await handle.write(chunk);
		return messages.length;
	} finally {
		await handle.close();
	}
}

async function writeRunsJson(burrow: BurrowRow, runs: RunRow[], path: string): Promise<void> {
	ensureParent(path);
	const archive: RunsArchive = {
		burrow,
		runs: [...runs].sort(byQueuedAtAsc),
		exportedAt: new Date().toISOString(),
	};
	const handle = await open(path, "w");
	try {
		await handle.write(`${JSON.stringify(archive, null, 2)}\n`);
	} finally {
		await handle.close();
	}
}

function ensureParent(path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function byCreatedAtAsc(a: MessageRow, b: MessageRow): number {
	return a.createdAt.getTime() - b.createdAt.getTime();
}

function byQueuedAtAsc(a: RunRow, b: RunRow): number {
	return a.queuedAt.getTime() - b.queuedAt.getTime();
}

function eventRowToEnvelope(row: import("../db/schema.ts").EventRow): {
	type: "event";
	ts: string;
	burrowId: string;
	runId: string | null;
	seq: number;
	kind: string;
	stream: string;
	payload: unknown;
} {
	const event = eventRowToEvent(row);
	return {
		type: "event",
		ts: event.ts.toISOString(),
		burrowId: event.burrowId,
		runId: event.runId,
		seq: event.seq,
		kind: event.kind,
		stream: event.stream,
		payload: event.payload,
	};
}

function messageRowToEnvelope(row: MessageRow): {
	type: "message";
	id: string;
	burrowId: string;
	fromActor: string;
	body: string;
	priority: string;
	state: string;
	deliveredAtRunId: string | null;
	createdAt: string;
	deliveredAt: string | null;
} {
	return {
		type: "message",
		id: row.id,
		burrowId: row.burrowId,
		fromActor: row.fromActor,
		body: row.body,
		priority: row.priority,
		state: row.state,
		deliveredAtRunId: row.deliveredAtRunId,
		createdAt: row.createdAt.toISOString(),
		deliveredAt: row.deliveredAt?.toISOString() ?? null,
	};
}
