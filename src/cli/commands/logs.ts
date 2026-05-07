/**
 * `burrow logs <id>` — per-burrow event tail (SPEC §14.2).
 *
 * Two modes against the same store:
 *   - default: dump events past `--since SEQ` (or all) and exit.
 *   - `--follow`: dump, then keep yielding fresh rows until the signal aborts.
 *
 * Output shape: NDJSON when `--json` is set or stdout isn't a TTY (so piping
 * stays machine-readable), pretty single-line otherwise. Polling against
 * SQLite is the V1 transport — see SPEC §14.3 — because the run loop
 * generally lives in another process. When the same process owns the run
 * loop (library API), callers can subscribe to `EventBus` directly instead
 * of using this command.
 */

import { ValidationError } from "../../core/errors.ts";
import type { BurrowDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import { tailBurrow } from "../../events/poll.ts";
import { renderNdjson, renderPretty } from "../../events/render.ts";

export interface LogsCommandOptions {
	follow?: boolean;
	since?: string;
	json?: boolean;
	limit?: string;
	pollIntervalMs?: number;
}

export interface LogsCommandInput {
	db: BurrowDb;
	burrowId: string;
	options: LogsCommandOptions;
	stdout: NodeJS.WritableStream;
	signal?: AbortSignal;
	/** TTY hint — defaults to checking process.stdout when omitted. */
	isTty?: boolean;
}

export interface LogsCommandSummary {
	emitted: number;
	stoppedReason: "limit" | "abort" | "drained";
}

export function parseSince(raw: string | undefined): number {
	if (raw === undefined) return 0;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0 || String(n) !== raw) {
		throw new ValidationError(`--since expects a non-negative integer seq, got '${raw}'`);
	}
	return n;
}

export function parseLimit(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0 || String(n) !== raw) {
		throw new ValidationError(`--limit expects a positive integer, got '${raw}'`);
	}
	return n;
}

export async function runLogsCommand(input: LogsCommandInput): Promise<LogsCommandSummary> {
	const repos = createRepos(input.db);
	repos.burrows.require(input.burrowId);

	const sinceSeq = parseSince(input.options.since);
	const limit = parseLimit(input.options.limit);
	const json = resolveJsonMode(input.options.json, input.isTty);
	const render = json ? renderNdjson : renderPretty;

	let emitted = 0;
	const tailOpts: Parameters<typeof tailBurrow>[2] = {
		sinceSeq,
		once: !input.options.follow,
	};
	if (input.signal) tailOpts.signal = input.signal;
	if (input.options.pollIntervalMs !== undefined)
		tailOpts.pollIntervalMs = input.options.pollIntervalMs;

	for await (const event of tailBurrow(repos, input.burrowId, tailOpts)) {
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
