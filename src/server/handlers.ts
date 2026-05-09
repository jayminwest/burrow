/**
 * Handlers for the HTTP API. CRUD adapters (pl-5b40 step 2) are thin
 * wrappers around `Client` methods so the Library API stays the source of
 * truth. Streaming handlers (pl-5b40 step 3) bridge the existing async
 * generators (`Client.events.tail`, `Client.runs.stream`, `streamSnapshots`)
 * onto NDJSON over chunked HTTP — the wire bytes match `burrow events
 * --json` and `burrow watch --json` exactly so a single client library can
 * target both faces (acceptance pl-5b40 #3 / SPEC §26.5).
 *
 * `handlerFor(client, method, pattern)` returns the bound handler for an
 * implemented route, or `null` so the caller can fall back to the 501 stub.
 * Keeping the dispatch table here (rather than baking handler refs into
 * `routes.ts`) keeps the locked route ordering — the contract step 7 tests
 * lock against — in one file.
 *
 * Streaming cleanup follows the CLI follow-path convention (mx-b3423b):
 * `request.signal` propagates to a per-stream AbortController, the source
 * generator returns cleanly on abort, and `ReadableStream.cancel` aborts
 * back into the generator if the consumer cancels first. No timers leak
 * because every source generator already tears down its `setInterval` /
 * abort listener in a `finally`.
 */

import { NotFoundError, ValidationError } from "../core/errors.ts";
import type { Burrow, RunEvent } from "../core/types.ts";
import { type StreamSnapshotsOptions, streamSnapshots } from "../dashboard/stream.ts";
import type { DashboardSnapshot } from "../dashboard/types.ts";
import {
	BURROW_KINDS,
	BURROW_STATES,
	type BurrowKind,
	type BurrowState,
	MESSAGE_PRIORITIES,
	MESSAGE_STATES,
	type MessagePriority,
	type MessageState,
} from "../db/schema.ts";
import { eventToEnvelope } from "../events/render.ts";
import type {
	BurrowUpInput,
	Client,
	EventTailFilter,
	InboxListFilter,
	RunCreateInput,
	RunListFilter,
} from "../lib/client.ts";
import { NETWORK_POLICIES, type NetworkPolicy } from "../provider/types.ts";
import type { AgentRuntime, InstallCheckResult } from "../runtime/runtime.ts";
import { jsonResponse, ndjsonResponse } from "./response.ts";
import type { RouteContext, RouteHandler } from "./types.ts";

interface BurrowListFilterShape {
	kind?: BurrowKind;
	state?: BurrowState;
	projectRoot?: string;
}

async function readJsonBody(ctx: RouteContext): Promise<Record<string, unknown>> {
	const raw = await ctx.request.text();
	if (raw.length === 0) {
		throw new ValidationError("request body is empty; expected a JSON object");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new ValidationError(
			`request body must be JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ValidationError("request body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

/**
 * Variant of `readJsonBody` for endpoints whose body is optional (e.g.
 * `POST /runs/:id/cancel` accepts a bare POST or `{reason}`). Returns
 * `null` when the request has no body, otherwise behaves like
 * `readJsonBody` (still 400 on malformed JSON / non-object payloads).
 */
async function readJsonBodyOrEmpty(ctx: RouteContext): Promise<Record<string, unknown> | null> {
	const raw = await ctx.request.text();
	if (raw.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new ValidationError(
			`request body must be JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ValidationError("request body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new ValidationError(`field '${key}' is required and must be a non-empty string`);
	}
	return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new ValidationError(`field '${key}' must be a string`);
	}
	return value;
}

function optionalStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) {
		throw new ValidationError(`field '${key}' must be an array of strings`);
	}
	const out: string[] = [];
	for (let i = 0; i < value.length; i++) {
		const entry = value[i];
		if (typeof entry !== "string" || entry.length === 0) {
			throw new ValidationError(`field '${key}[${i}]' must be a non-empty string`);
		}
		out.push(entry);
	}
	return out;
}

function requireParam(ctx: RouteContext, key: string): string {
	const value = ctx.params[key];
	if (value === undefined || value.length === 0) {
		throw new ValidationError(`route param '${key}' is missing`);
	}
	return value;
}

function parseEnum<T extends string>(
	raw: string | null | undefined,
	label: string,
	members: readonly T[],
): T | undefined {
	if (raw === null || raw === undefined) return undefined;
	if (!(members as readonly string[]).includes(raw)) {
		throw new ValidationError(`unknown ${label} '${raw}' — expected one of: ${members.join(", ")}`);
	}
	return raw as T;
}

function parseLimit(raw: string | null): number | undefined {
	if (raw === null) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1) {
		throw new ValidationError(`limit must be a positive integer; got '${raw}'`);
	}
	return n;
}

function parsePositiveInt(raw: string | null, label: string): number | undefined {
	if (raw === null) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1 || String(n) !== raw) {
		throw new ValidationError(`${label} must be a positive integer; got '${raw}'`);
	}
	return n;
}

function parseNonNegativeInt(raw: string | null, label: string): number | undefined {
	if (raw === null) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0 || String(n) !== raw) {
		throw new ValidationError(`${label} must be a non-negative integer; got '${raw}'`);
	}
	return n;
}

/**
 * Streaming routes accept their boolean toggle as 'true'/'false' OR '1'/'0'
 * so curl users can write `?follow=1` / `?once=1` (CLI muscle memory)
 * without surprises. Used by `?follow=` on /events and /runs/:id/stream and
 * by `?once=` / `?follow=` on /watch — every streaming endpoint takes the
 * same input grammar.
 */
function parseStreamBool(raw: string | null, label: string): boolean | undefined {
	if (raw === null) return undefined;
	if (raw === "true" || raw === "1") return true;
	if (raw === "false" || raw === "0") return false;
	throw new ValidationError(`${label} must be 'true'/'1' or 'false'/'0'; got '${raw}'`);
}

function parseBoolean(raw: string | null, label: string): boolean | undefined {
	if (raw === null) return undefined;
	if (raw === "true") return true;
	if (raw === "false") return false;
	throw new ValidationError(`${label} must be 'true' or 'false'; got '${raw}'`);
}

/**
 * Split `?kinds=tool_use,error` (CSV) and repeated `?kinds=...&kinds=...`
 * params into the same list `EventTailFilter.kinds` expects. Mirrors the
 * CLI's `normalizeKindFilter` (src/cli/commands/events.ts) so HTTP and CLI
 * accept the same `--kind` syntax.
 */
function parseKindFilter(values: string[]): string[] | undefined {
	const set = new Set<string>();
	for (const raw of values) {
		for (const piece of raw.split(",")) {
			const trimmed = piece.trim();
			if (trimmed) set.add(trimmed);
		}
	}
	return set.size === 0 ? undefined : [...set];
}

/* ----------------------------------------------------------------------- */
/* Burrows (§15.1)                                                         */
/* ----------------------------------------------------------------------- */

function listBurrows(client: Client): RouteHandler {
	return (ctx) => {
		const filter: BurrowListFilterShape = {};
		const kind = parseEnum(ctx.url.searchParams.get("kind"), "kind", BURROW_KINDS);
		const state = parseEnum(ctx.url.searchParams.get("state"), "state", BURROW_STATES);
		const projectRoot = ctx.url.searchParams.get("projectRoot");
		if (kind !== undefined) filter.kind = kind;
		if (state !== undefined) filter.state = state;
		if (projectRoot !== null) filter.projectRoot = projectRoot;
		return jsonResponse(200, client.burrows.list(filter));
	};
}

function getBurrow(client: Client): RouteHandler {
	return (ctx): Response => {
		const id = requireParam(ctx, "id");
		const burrow: Burrow = client.burrows.get(id);
		return jsonResponse(200, burrow);
	};
}

function destroyBurrow(client: Client): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const opts: { archive?: boolean } = {};
		const archive = parseBoolean(ctx.url.searchParams.get("archive"), "archive");
		if (archive !== undefined) opts.archive = archive;
		const result = await client.burrows.destroy(id, opts);
		return jsonResponse(200, result);
	};
}

function stopBurrow(client: Client): RouteHandler {
	return (ctx) => {
		const id = requireParam(ctx, "id");
		return jsonResponse(200, client.burrows.stop(id));
	};
}

function resumeBurrow(client: Client): RouteHandler {
	return (ctx) => {
		const id = requireParam(ctx, "id");
		return jsonResponse(200, client.burrows.resume(id));
	};
}

/**
 * `POST /burrows` — provision a project burrow (SPEC §15.1, §16). The body
 * mirrors `BurrowUpInput`: `projectRoot` is required, the rest are optional
 * overrides for `burrow.toml` defaults. Heavy lifting (doctor, secrets,
 * worktree, sandbox profile build) lives in `client.burrows.up()`; we only
 * shape the wire-side validation here. Returns 201 with the new `Burrow`.
 */
function createBurrow(client: Client): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const input: BurrowUpInput = {
			projectRoot: requireString(body, "projectRoot"),
		};
		const name = optionalString(body, "name");
		if (name !== undefined) input.name = name;
		const branch = optionalString(body, "branch");
		if (branch !== undefined) input.branch = branch;
		const baseBranch = optionalString(body, "baseBranch");
		if (baseBranch !== undefined) input.baseBranch = baseBranch;
		const originUrl = optionalString(body, "originUrl");
		if (originUrl !== undefined) input.originUrl = originUrl;
		const networkRaw = optionalString(body, "network");
		const network = parseEnum<NetworkPolicy>(networkRaw ?? null, "network", NETWORK_POLICIES);
		if (network !== undefined) input.network = network;
		const provider = optionalString(body, "provider");
		if (provider !== undefined) input.provider = provider;
		const agents = optionalStringArray(body, "agents");
		if (agents !== undefined) input.agents = agents;
		const burrow = await client.burrows.up(input);
		return jsonResponse(201, burrow);
	};
}

/* ----------------------------------------------------------------------- */
/* Runs (§15.2)                                                            */
/* ----------------------------------------------------------------------- */

function listRunsByBurrow(client: Client): RouteHandler {
	return (ctx) => {
		const burrowId = requireParam(ctx, "id");
		const filter: RunListFilter = { burrowId };
		const limit = parseLimit(ctx.url.searchParams.get("limit"));
		if (limit !== undefined) filter.limit = limit;
		return jsonResponse(200, client.runs.list(filter));
	};
}

function createRun(client: Client): RouteHandler {
	return async (ctx) => {
		const burrowId = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const input: RunCreateInput = {
			burrowId,
			agentId: requireString(body, "agentId"),
			prompt: requireString(body, "prompt"),
		};
		if (body.metadata !== undefined) input.metadata = body.metadata;
		return jsonResponse(201, client.runs.create(input));
	};
}

function getRun(client: Client): RouteHandler {
	return (ctx) => {
		const id = requireParam(ctx, "id");
		return jsonResponse(200, client.runs.get(id));
	};
}

/**
 * `POST /runs/:id/cancel` — graceful cancellation. Body is optional; when
 * present, accepts `{reason?: string}` which lands in the run's
 * `errorMessage` and the emitted `run_cancelled` event payload. Idempotent:
 * a run that's already terminal (succeeded/failed/cancelled) returns its
 * current row with status 200, not a 4xx — callers can retry without
 * special-casing.
 */
function cancelRun(client: Client): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const opts: { reason?: string } = {};
		const body = await readJsonBodyOrEmpty(ctx);
		if (body !== null) {
			const reason = optionalString(body, "reason");
			if (reason !== undefined) opts.reason = reason;
		}
		return jsonResponse(200, client.runs.cancel(id, opts));
	};
}

/**
 * `DELETE /runs/:id` — record removal post-completion. Hard-deletes the
 * run row, but only when the run is in a terminal state (callers should
 * `POST /runs/:id/cancel` first if the run is still in flight). Returns
 * 204 No Content on success; 400 if the run is non-terminal; 404 if the
 * id doesn't exist. Distinct from `POST /cancel` (state transition) — this
 * endpoint is for cleanup of finished runs.
 */
function deleteRun(client: Client): RouteHandler {
	return (ctx) => {
		const id = requireParam(ctx, "id");
		client.runs.delete(id);
		return new Response(null, { status: 204 });
	};
}

/* ----------------------------------------------------------------------- */
/* Inbox (§15.3)                                                           */
/* ----------------------------------------------------------------------- */

function listInbox(client: Client): RouteHandler {
	return (ctx) => {
		const burrowId = requireParam(ctx, "id");
		const filter: InboxListFilter = {};
		const state = parseEnum<MessageState>(
			ctx.url.searchParams.get("state"),
			"state",
			MESSAGE_STATES,
		);
		if (state !== undefined) filter.state = state;
		return jsonResponse(200, client.inbox.list(burrowId, filter));
	};
}

function sendInbox(client: Client): RouteHandler {
	return async (ctx) => {
		const burrowId = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const messageBody = requireString(body, "body");
		const priority = parseEnum<MessagePriority>(
			optionalString(body, "priority") ?? null,
			"priority",
			MESSAGE_PRIORITIES,
		);
		const fromActor = optionalString(body, "fromActor");
		const input: Parameters<Client["inbox"]["send"]>[0] = { burrowId, body: messageBody };
		if (priority !== undefined) input.priority = priority;
		if (fromActor !== undefined) input.fromActor = fromActor;
		return jsonResponse(201, client.inbox.send(input));
	};
}

function cancelMessage(client: Client): RouteHandler {
	return (ctx) => {
		const id = requireParam(ctx, "id");
		client.inbox.cancel(id);
		return new Response(null, { status: 204 });
	};
}

/* ----------------------------------------------------------------------- */
/* Agents (§15.5)                                                          */
/* ----------------------------------------------------------------------- */

interface AgentSummary {
	id: string;
	displayName: string;
	supportsResume: boolean;
	spawnPerTurn: boolean;
}

interface AgentDetail extends AgentSummary {
	install: InstallCheckResult;
}

function summarizeAgent(rt: AgentRuntime): AgentSummary {
	return {
		id: rt.id,
		displayName: rt.displayName,
		supportsResume: rt.supportsResume,
		spawnPerTurn: typeof rt.encodeInboxMessage === "function",
	};
}

function listAgents(client: Client): RouteHandler {
	return async () => {
		const runtimes = client.agents.list();
		const detailed: AgentDetail[] = await Promise.all(
			runtimes.map(async (rt) => ({
				...summarizeAgent(rt),
				install: await rt.installCheck(),
			})),
		);
		return jsonResponse(200, detailed);
	};
}

function getAgent(client: Client): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const rt = client.agents.get(id);
		if (!rt) {
			throw new NotFoundError(`agent runtime not registered: ${id}`, {
				recoveryHint: "GET /agents to see what's available",
			});
		}
		const install = await rt.installCheck();
		const detail: AgentDetail = { ...summarizeAgent(rt), install };
		return jsonResponse(200, detail);
	};
}

/* ----------------------------------------------------------------------- */
/* Streaming (§14.2 events tail, §15.2 run stream, §26 watch)              */
/* ----------------------------------------------------------------------- */

/**
 * Bridge `request.signal` (server sees it abort on client disconnect) onto
 * a fresh AbortController whose signal is passed to the source generator.
 * The dedicated controller also lets `ReadableStream.cancel` propagate
 * back into the generator if the consumer cancels first — both directions
 * end up in the same `finally` block inside the generator.
 */
function bridgeAbort(reqSignal: AbortSignal): AbortController {
	const ctrl = new AbortController();
	if (reqSignal.aborted) {
		ctrl.abort();
		return ctrl;
	}
	reqSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
	return ctrl;
}

/**
 * Wrap an async iterable in a ReadableStream<Uint8Array> for `Response`
 * bodies. `encode` produces one NDJSON line (with trailing '\n') per
 * yielded value; the encoder turns that into the bytes Bun ships down the
 * chunked response. `pull` is one-shot per call so backpressure is
 * preserved — the generator's next() only runs when the consumer asks for
 * more bytes.
 */
function asNdjsonStream<T>(
	source: AsyncIterable<T>,
	encode: (value: T) => string,
	ctrl: AbortController,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const iterator = source[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await iterator.next();
				if (done) {
					controller.close();
					return;
				}
				controller.enqueue(encoder.encode(encode(value)));
			} catch (err) {
				if (ctrl.signal.aborted) {
					controller.close();
					return;
				}
				controller.error(err);
			}
		},
		async cancel() {
			ctrl.abort();
			try {
				await iterator.return?.(undefined);
			} catch {
				// Swallow — the generator may already be torn down.
			}
		},
	});
}

async function* takeAtMost<T>(source: AsyncIterable<T>, n: number): AsyncGenerator<T, void, void> {
	if (n <= 0) return;
	let count = 0;
	for await (const value of source) {
		yield value;
		count += 1;
		if (count >= n) return;
	}
}

const eventToNdjsonLine = (e: RunEvent): string => `${JSON.stringify(eventToEnvelope(e))}\n`;
const snapshotToNdjsonLine = (s: DashboardSnapshot): string => `${JSON.stringify(s)}\n`;

/**
 * GET /burrows/:id/events — per-burrow event tail. `?follow=1` keeps the
 * connection open and live-tails (default); `?follow=0` drains current
 * rows (replay) and closes. `?since=<seq>` emits seq>since in order, then
 * (when follow=1) switches to live tail with no duplicates and no gaps —
 * the cursor advances past every yielded row before the next poll
 * (acceptance pl-5b40 #4). `?kinds=tool_use,error` filters in-stream;
 * `?limit=N` caps and closes.
 */
function eventsTailHandler(client: Client): RouteHandler {
	return (ctx) => {
		const id = requireParam(ctx, "id");
		client.burrows.get(id);
		const follow = parseStreamBool(ctx.url.searchParams.get("follow"), "follow") ?? true;
		const since = parseNonNegativeInt(ctx.url.searchParams.get("since"), "since");
		const kinds = parseKindFilter([
			...ctx.url.searchParams.getAll("kinds"),
			...ctx.url.searchParams.getAll("kind"),
		]);
		const limit = parseLimit(ctx.url.searchParams.get("limit"));
		const pollIntervalMs = parseNonNegativeInt(
			ctx.url.searchParams.get("pollIntervalMs"),
			"pollIntervalMs",
		);

		const ctrl = bridgeAbort(ctx.request.signal);
		const filter: EventTailFilter = { burrowId: id, signal: ctrl.signal };
		if (since !== undefined) filter.since = since;
		if (kinds !== undefined) filter.kinds = kinds;
		if (pollIntervalMs !== undefined) filter.pollIntervalMs = pollIntervalMs;
		if (!follow) filter.once = true;

		const source = client.events.tail(filter);
		const capped = limit !== undefined ? takeAtMost(source, limit) : source;
		return ndjsonResponse(asNdjsonStream(capped, eventToNdjsonLine, ctrl));
	};
}

/**
 * GET /runs/:id/stream — single-run event tail. Same envelope as the
 * events route; underlying `Client.runs.stream` filters the burrow-level
 * stream down to the requested runId. Always follows (no `once` mode in
 * the Library API today); consumers stop via `?limit=N` or by cancelling.
 */
function runStreamHandler(client: Client): RouteHandler {
	return (ctx) => {
		const id = requireParam(ctx, "id");
		client.runs.get(id);
		const limit = parseLimit(ctx.url.searchParams.get("limit"));
		const pollIntervalMs = parseNonNegativeInt(
			ctx.url.searchParams.get("pollIntervalMs"),
			"pollIntervalMs",
		);

		const ctrl = bridgeAbort(ctx.request.signal);
		const opts: { signal: AbortSignal; pollIntervalMs?: number } = {
			signal: ctrl.signal,
		};
		if (pollIntervalMs !== undefined) opts.pollIntervalMs = pollIntervalMs;

		const source = client.runs.stream(id, opts);
		const capped = limit !== undefined ? takeAtMost(source, limit) : source;
		return ndjsonResponse(asNdjsonStream(capped, eventToNdjsonLine, ctrl));
	};
}

/**
 * GET /watch — DashboardSnapshot stream. Wire bytes match `burrow watch
 * --json` exactly (src/cli/commands/watch.ts runJsonMode), the wire shape
 * SPEC §26.5 pre-committed for `burrow serve`. Forwards
 * `coalesceMs`/`pollIntervalMs`/`runsLimit`/`eventTailCap` through to
 * `streamSnapshots`. `?once=1` collapses the stream to the first yielded
 * snapshot for one-shot consumers and CI scripts; `?follow=0` is the
 * inverse alias so the streaming-param grammar matches /events and
 * /runs/:id/stream (mx-b3423b: same `'true'|'false'|'1'|'0'` shape across
 * every streaming endpoint). Specifying both `?once` and `?follow` is a
 * 400 — they are inverses, so accepting both is ambiguous.
 */
function watchHandler(client: Client): RouteHandler {
	return (ctx) => {
		const onceRaw = ctx.url.searchParams.get("once");
		const followRaw = ctx.url.searchParams.get("follow");
		if (onceRaw !== null && followRaw !== null) {
			throw new ValidationError(
				"specify either '?once' or '?follow' on /watch (they are inverses), not both",
			);
		}
		let once = false;
		if (onceRaw !== null) {
			once = parseStreamBool(onceRaw, "once") ?? false;
		} else if (followRaw !== null) {
			const follow = parseStreamBool(followRaw, "follow");
			if (follow !== undefined) once = !follow;
		}
		const coalesceMs = parseNonNegativeInt(ctx.url.searchParams.get("coalesceMs"), "coalesceMs");
		const pollIntervalMs = parseNonNegativeInt(
			ctx.url.searchParams.get("pollIntervalMs"),
			"pollIntervalMs",
		);
		const runsLimit = parsePositiveInt(ctx.url.searchParams.get("runsLimit"), "runsLimit");
		const eventTailCap = parseNonNegativeInt(
			ctx.url.searchParams.get("eventTailCap"),
			"eventTailCap",
		);

		const ctrl = bridgeAbort(ctx.request.signal);
		const opts: StreamSnapshotsOptions = { signal: ctrl.signal };
		if (coalesceMs !== undefined) opts.coalesceMs = coalesceMs;
		if (pollIntervalMs !== undefined) opts.pollIntervalMs = pollIntervalMs;
		if (runsLimit !== undefined) opts.runsLimit = runsLimit;
		if (eventTailCap !== undefined) opts.eventTailCap = eventTailCap;

		const source = streamSnapshots(client.repos, client.bus, opts);
		const capped = once ? takeAtMost(source, 1) : source;
		return ndjsonResponse(asNdjsonStream(capped, snapshotToNdjsonLine, ctrl));
	};
}

/* ----------------------------------------------------------------------- */
/* Dispatch                                                                */
/* ----------------------------------------------------------------------- */

/**
 * Resolve a method+pattern pair to its bound handler. Every route in the
 * canonical table now has a real handler; `null` is reserved for unknown
 * method/pattern pairs (routes.ts falls back to the 501 stub for those, so
 * an out-of-table call still rejects cleanly).
 */
export function handlerFor(client: Client, method: string, pattern: string): RouteHandler | null {
	const key = `${method} ${pattern}`;
	switch (key) {
		case "GET /burrows":
			return listBurrows(client);
		case "POST /burrows":
			return createBurrow(client);
		case "GET /burrows/:id":
			return getBurrow(client);
		case "DELETE /burrows/:id":
			return destroyBurrow(client);
		case "POST /burrows/:id/stop":
			return stopBurrow(client);
		case "POST /burrows/:id/resume":
			return resumeBurrow(client);
		case "GET /burrows/:id/runs":
			return listRunsByBurrow(client);
		case "POST /burrows/:id/runs":
			return createRun(client);
		case "GET /runs/:id":
			return getRun(client);
		case "DELETE /runs/:id":
			return deleteRun(client);
		case "POST /runs/:id/cancel":
			return cancelRun(client);
		case "GET /burrows/:id/inbox":
			return listInbox(client);
		case "POST /burrows/:id/inbox":
			return sendInbox(client);
		case "DELETE /messages/:id":
			return cancelMessage(client);
		case "GET /agents":
			return listAgents(client);
		case "GET /agents/:id":
			return getAgent(client);
		case "GET /burrows/:id/events":
			return eventsTailHandler(client);
		case "GET /runs/:id/stream":
			return runStreamHandler(client);
		case "GET /watch":
			return watchHandler(client);
		default:
			return null;
	}
}
