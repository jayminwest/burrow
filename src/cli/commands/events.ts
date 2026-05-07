/**
 * `burrow events` — cross-burrow event tail (SPEC §14.2).
 *
 * Subscribes to every active burrow (or a `--burrow` allow-list) and
 * interleaves their events by `ts`. Filters by `--kind` so a user can grep
 * for `tool_use`/`error`/etc without piping through `jq`. Default output is
 * NDJSON when stdout isn't a TTY; pretty when it is. Same polling story as
 * `logs` — the V1 daemon-less CLI watches SQLite.
 *
 * Acceptance criterion (plan pl-a253 #5): "burrow events --follow
 * interleaves events from all active burrows in real-time as NDJSON."
 */

import { ValidationError } from "../../core/errors.ts";
import type { BurrowDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import { tailAll } from "../../events/poll.ts";
import { renderNdjson, renderPretty } from "../../events/render.ts";

export interface EventsCommandOptions {
	follow?: boolean;
	burrow?: string[];
	kind?: string[];
	json?: boolean;
	limit?: string;
	pollIntervalMs?: number;
}

export interface EventsCommandInput {
	db: BurrowDb;
	options: EventsCommandOptions;
	stdout: NodeJS.WritableStream;
	signal?: AbortSignal;
	isTty?: boolean;
}

export interface EventsCommandSummary {
	emitted: number;
	stoppedReason: "limit" | "abort" | "drained";
}

export function parseLimit(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0 || String(n) !== raw) {
		throw new ValidationError(`--limit expects a positive integer, got '${raw}'`);
	}
	return n;
}

export function normalizeKindFilter(values: string[] | undefined): Set<string> | null {
	if (!values || values.length === 0) return null;
	const set = new Set<string>();
	for (const raw of values) {
		for (const piece of raw.split(",")) {
			const trimmed = piece.trim();
			if (trimmed) set.add(trimmed);
		}
	}
	return set.size === 0 ? null : set;
}

export async function runEventsCommand(input: EventsCommandInput): Promise<EventsCommandSummary> {
	const repos = createRepos(input.db);
	const limit = parseLimit(input.options.limit);
	const kinds = normalizeKindFilter(input.options.kind);
	const json = resolveJsonMode(input.options.json, input.isTty);
	const render = json ? renderNdjson : renderPretty;

	const tailOpts: Parameters<typeof tailAll>[1] = {
		once: !input.options.follow,
	};
	if (input.options.burrow && input.options.burrow.length > 0) {
		tailOpts.burrowIds = input.options.burrow;
		for (const id of input.options.burrow) repos.burrows.require(id);
	}
	if (input.signal) tailOpts.signal = input.signal;
	if (input.options.pollIntervalMs !== undefined)
		tailOpts.pollIntervalMs = input.options.pollIntervalMs;

	let emitted = 0;
	for await (const event of tailAll(repos, tailOpts)) {
		if (kinds && !kinds.has(event.kind)) continue;
		input.stdout.write(render(event));
		emitted += 1;
		if (limit && emitted >= limit) return { emitted, stoppedReason: "limit" };
	}
	return {
		emitted,
		stoppedReason: input.signal?.aborted ? "abort" : "drained",
	};
}

function resolveJsonMode(flag: boolean | undefined, tty: boolean | undefined): boolean {
	if (flag !== undefined) return flag;
	if (tty === undefined) return !process.stdout.isTTY;
	return !tty;
}
