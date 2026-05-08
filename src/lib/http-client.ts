/**
 * HTTP-backed mirror of `Client` (SPEC §15, plan pl-5b40 step 6). Same
 * namespace fields (burrows / runs / inbox / events / agents) and same
 * method shapes as the in-process `Client` so consumers — warren, future
 * UIs, anything that holds a `Client` reference — can swap transports
 * without touching call sites.
 *
 * Wire shape contract: every JSON payload matches the in-process return
 * value with `Date` fields rehydrated (createdAt, updatedAt, queuedAt,
 * startedAt, completedAt, deliveredAt, destroyedAt, ts). Streaming surfaces
 * (events tail, run stream) consume the same NDJSON envelope `burrow
 * events --json` emits — see `eventToEnvelope` in src/events/render.ts.
 *
 * Transport: `{ kind: 'unix', path }` is the canonical
 * single-host / single-container shape (matches `burrow serve` defaults);
 * `{ kind: 'tcp', hostname, port }` is the cross-container alternative.
 * Unix sockets reach Bun's `fetch` via the `unix` option (URL stays
 * `http://localhost/<route>`); TCP just uses the hostname/port directly.
 *
 * Auth: a single bearer token rendered into every outbound `Authorization`
 * header. Mirrors the V1 single-user posture (SPEC §3.2). Never logged.
 *
 * Errors: the `{ error: { code, message, hint } }` envelope thrown by
 * `src/server/errors.ts` is rehydrated back into the matching
 * `BurrowError` subclass so callers can keep using `instanceof
 * NotFoundError` against the HTTP-backed client.
 */

import {
	AgentNotInstalled,
	AgentRuntimeError,
	BurrowError,
	CredentialError,
	NotFoundError,
	SandboxError,
	SecretResolutionError,
	ToolchainMismatch,
	ValidationError,
	WorkspaceMaterializationError,
} from "../core/errors.ts";
import type {
	Burrow,
	BurrowKind,
	BurrowState,
	Message,
	MessagePriority,
	MessageState,
	Run,
	RunEvent,
	RunState,
} from "../core/types.ts";
import type { DestroyBurrowResult } from "../events/destroy.ts";
import type { EventEnvelope } from "../events/render.ts";
import type { InstallCheckResult } from "../runtime/runtime.ts";
import type { ErrorEnvelope, Transport } from "../server/types.ts";

export interface HttpClientOptions {
	/** Bind target — must match what `burrow serve` is listening on. */
	transport: Transport;
	/** Bearer token. Required when the server is started without `--no-auth`. */
	token?: string;
	/** Override the global fetch (tests / instrumentation). */
	fetch?: typeof fetch;
}

export interface HttpBurrowListFilter {
	kind?: BurrowKind;
	state?: BurrowState;
	projectRoot?: string;
}

export interface HttpRunListFilter {
	burrowId?: string;
	state?: RunState | RunState[];
	limit?: number;
}

export interface HttpInboxListFilter {
	state?: MessageState;
}

export interface HttpInboxSendInput {
	burrowId: string;
	body: string;
	priority?: MessagePriority;
	fromActor?: string;
}

export interface HttpRunCreateInput {
	burrowId: string;
	agentId: string;
	prompt: string;
	metadata?: unknown;
}

export interface HttpEventTailFilter {
	burrowId?: string;
	kinds?: string[];
	since?: number;
	signal?: AbortSignal;
	pollIntervalMs?: number;
	once?: boolean;
	limit?: number;
}

export interface HttpRunStreamOptions {
	signal?: AbortSignal;
	pollIntervalMs?: number;
	limit?: number;
}

export interface HttpAgentSummary {
	id: string;
	displayName: string;
	supportsResume: boolean;
	spawnPerTurn: boolean;
}

export interface HttpAgentDetail extends HttpAgentSummary {
	install: InstallCheckResult;
}

interface RequestOptions {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	path: string;
	query?: URLSearchParams;
	jsonBody?: unknown;
	signal?: AbortSignal;
	/** Stream consumers don't want the response body parsed eagerly. */
	stream?: boolean;
	/** Treat 404 as a soft miss — return null rather than throw. */
	allow404?: boolean;
}

/**
 * Internal transport-level dispatcher. Owns base URL composition, the
 * `{unix}` fetch option for unix-socket transports, and the bearer header.
 * Every namespace client routes through here so retry/auth/error policy
 * lands in one place.
 */
class HttpTransportClient {
	private readonly baseUrl: string;
	private readonly unixPath: string | null;
	private readonly token: string | null;
	private readonly fetchImpl: typeof fetch;

	constructor(opts: HttpClientOptions) {
		if (opts.transport.kind === "unix") {
			this.baseUrl = "http://localhost";
			this.unixPath = opts.transport.path;
		} else {
			this.baseUrl = `http://${opts.transport.hostname}:${opts.transport.port}`;
			this.unixPath = null;
		}
		this.token = opts.token ?? null;
		this.fetchImpl = opts.fetch ?? fetch;
	}

	async request<T>(opts: RequestOptions & { stream?: false; allow404?: false }): Promise<T>;
	async request<T>(opts: RequestOptions & { allow404: true }): Promise<T | null>;
	async request(opts: RequestOptions & { stream: true }): Promise<Response>;
	async request<T>(opts: RequestOptions): Promise<T | Response | null> {
		const res = await this.send(opts);
		if (opts.stream) {
			if (!res.ok) {
				await this.throwForStatus(res);
			}
			return res;
		}
		if (res.status === 404 && opts.allow404) {
			// Drain so the connection can return to the pool.
			await res.body?.cancel().catch(() => {});
			return null;
		}
		if (!res.ok) {
			await this.throwForStatus(res);
		}
		if (res.status === 204) return undefined as T;
		// Server contract: every 2xx body is JSON.
		return (await res.json()) as T;
	}

	private async send(opts: RequestOptions): Promise<Response> {
		const url = this.buildUrl(opts.path, opts.query);
		const headers: Record<string, string> = {};
		if (this.token !== null) headers.authorization = `Bearer ${this.token}`;
		const init: RequestInit & { unix?: string } = {
			method: opts.method,
			headers,
		};
		if (opts.jsonBody !== undefined) {
			headers["content-type"] = "application/json";
			init.body = JSON.stringify(opts.jsonBody);
		}
		if (opts.signal) init.signal = opts.signal;
		if (this.unixPath !== null) init.unix = this.unixPath;
		return this.fetchImpl(url, init);
	}

	private buildUrl(path: string, query?: URLSearchParams): string {
		if (!path.startsWith("/")) {
			throw new Error(`HttpClient: path must start with '/' (got '${path}')`);
		}
		const qs = query !== undefined && query.size > 0 ? `?${query.toString()}` : "";
		return `${this.baseUrl}${path}${qs}`;
	}

	private async throwForStatus(res: Response): Promise<never> {
		let envelope: ErrorEnvelope | null = null;
		try {
			envelope = (await res.json()) as ErrorEnvelope;
		} catch {
			// Body wasn't JSON — fall through to a generic error below.
		}
		throw rehydrateError(res.status, envelope);
	}
}

/**
 * Burrows namespace (SPEC §15.1) over HTTP. Mirrors `BurrowsClient` shape
 * by shape: `list`/`get`/`tryGet`/`stop`/`resume`/`destroy`. Every method
 * is async since a network round-trip can't be sync; the in-process
 * surface uses sync repo calls but consumers already `await` the
 * destroy() path so promoting the rest to async is the only honest mirror.
 */
export class HttpBurrowsClient {
	constructor(private readonly transport: HttpTransportClient) {}

	async list(filter: HttpBurrowListFilter = {}): Promise<Burrow[]> {
		const query = new URLSearchParams();
		if (filter.kind !== undefined) query.set("kind", filter.kind);
		if (filter.state !== undefined) query.set("state", filter.state);
		if (filter.projectRoot !== undefined) query.set("projectRoot", filter.projectRoot);
		const rows = await this.transport.request<unknown[]>({
			method: "GET",
			path: "/burrows",
			query,
		});
		return rows.map(reviveBurrow);
	}

	async get(id: string): Promise<Burrow> {
		const row = await this.transport.request<unknown>({
			method: "GET",
			path: `/burrows/${encodeURIComponent(id)}`,
		});
		return reviveBurrow(row);
	}

	async tryGet(id: string): Promise<Burrow | null> {
		const row = await this.transport.request<unknown>({
			method: "GET",
			path: `/burrows/${encodeURIComponent(id)}`,
			allow404: true,
		});
		return row === null ? null : reviveBurrow(row);
	}

	async stop(id: string): Promise<Burrow> {
		const row = await this.transport.request<unknown>({
			method: "POST",
			path: `/burrows/${encodeURIComponent(id)}/stop`,
		});
		return reviveBurrow(row);
	}

	async resume(id: string): Promise<Burrow> {
		const row = await this.transport.request<unknown>({
			method: "POST",
			path: `/burrows/${encodeURIComponent(id)}/resume`,
		});
		return reviveBurrow(row);
	}

	async destroy(id: string, opts: { archive?: boolean } = {}): Promise<DestroyBurrowResult> {
		const query = new URLSearchParams();
		if (opts.archive !== undefined) query.set("archive", opts.archive ? "true" : "false");
		return this.transport.request<DestroyBurrowResult>({
			method: "DELETE",
			path: `/burrows/${encodeURIComponent(id)}`,
			query,
		});
	}
}

/**
 * Runs namespace (SPEC §15.2). `list` only supports `burrowId` filtering
 * over HTTP — the global `state` filter has no exposed route since no
 * consumer needs it; revisit when one does.
 */
export class HttpRunsClient {
	constructor(private readonly transport: HttpTransportClient) {}

	async create(input: HttpRunCreateInput): Promise<Run> {
		const body: Record<string, unknown> = {
			agentId: input.agentId,
			prompt: input.prompt,
		};
		if (input.metadata !== undefined) body.metadata = input.metadata;
		const row = await this.transport.request<unknown>({
			method: "POST",
			path: `/burrows/${encodeURIComponent(input.burrowId)}/runs`,
			jsonBody: body,
		});
		return reviveRun(row);
	}

	async get(id: string): Promise<Run> {
		const row = await this.transport.request<unknown>({
			method: "GET",
			path: `/runs/${encodeURIComponent(id)}`,
		});
		return reviveRun(row);
	}

	async tryGet(id: string): Promise<Run | null> {
		const row = await this.transport.request<unknown>({
			method: "GET",
			path: `/runs/${encodeURIComponent(id)}`,
			allow404: true,
		});
		return row === null ? null : reviveRun(row);
	}

	async list(filter: HttpRunListFilter = {}): Promise<Run[]> {
		if (filter.burrowId === undefined) {
			throw new ValidationError("HttpRunsClient.list requires { burrowId } over HTTP", {
				recoveryHint: "the per-burrow runs route is GET /burrows/:id/runs",
			});
		}
		const query = new URLSearchParams();
		if (filter.limit !== undefined) query.set("limit", String(filter.limit));
		const rows = await this.transport.request<unknown[]>({
			method: "GET",
			path: `/burrows/${encodeURIComponent(filter.burrowId)}/runs`,
			query,
		});
		return rows.map(reviveRun);
	}

	async cancel(id: string): Promise<Run> {
		const row = await this.transport.request<unknown>({
			method: "POST",
			path: `/runs/${encodeURIComponent(id)}/cancel`,
		});
		return reviveRun(row);
	}

	stream(id: string, opts: HttpRunStreamOptions = {}): AsyncGenerator<RunEvent, void, void> {
		const query = new URLSearchParams();
		if (opts.pollIntervalMs !== undefined) query.set("pollIntervalMs", String(opts.pollIntervalMs));
		if (opts.limit !== undefined) query.set("limit", String(opts.limit));
		return streamRunEvents(this.transport, `/runs/${encodeURIComponent(id)}/stream`, query, {
			...(opts.signal !== undefined ? { signal: opts.signal } : {}),
		});
	}
}

/**
 * Inbox namespace (SPEC §15.3). The HTTP server returns nothing useful
 * from `pending`/`count` directly — but `list` already filters by state,
 * so we derive both client-side. Avoids inventing routes the in-process
 * Client doesn't have an analogue for.
 */
export class HttpInboxClient {
	constructor(private readonly transport: HttpTransportClient) {}

	async send(input: HttpInboxSendInput): Promise<Message> {
		const body: Record<string, unknown> = { body: input.body };
		if (input.priority !== undefined) body.priority = input.priority;
		if (input.fromActor !== undefined) body.fromActor = input.fromActor;
		const row = await this.transport.request<unknown>({
			method: "POST",
			path: `/burrows/${encodeURIComponent(input.burrowId)}/inbox`,
			jsonBody: body,
		});
		return reviveMessage(row);
	}

	async list(burrowId: string, filter: HttpInboxListFilter = {}): Promise<Message[]> {
		const query = new URLSearchParams();
		if (filter.state !== undefined) query.set("state", filter.state);
		const rows = await this.transport.request<unknown[]>({
			method: "GET",
			path: `/burrows/${encodeURIComponent(burrowId)}/inbox`,
			query,
		});
		return rows.map(reviveMessage);
	}

	async pending(burrowId: string): Promise<Message[]> {
		return this.list(burrowId, { state: "unread" });
	}

	async cancel(messageId: string): Promise<void> {
		await this.transport.request<undefined>({
			method: "DELETE",
			path: `/messages/${encodeURIComponent(messageId)}`,
		});
	}

	async count(burrowId: string, state?: MessageState): Promise<number> {
		const filter: HttpInboxListFilter = state !== undefined ? { state } : {};
		const rows = await this.list(burrowId, filter);
		return rows.length;
	}
}

/**
 * Events namespace (SPEC §15.4). `tail` and `replay` are the only
 * methods that have a meaningful HTTP equivalent — `subscribe` /
 * `subscribeAll` / `rawBus` are in-process pub/sub, intentionally absent
 * from the wire surface.
 */
export class HttpEventsClient {
	constructor(private readonly transport: HttpTransportClient) {}

	tail(filter: HttpEventTailFilter = {}): AsyncGenerator<RunEvent, void, void> {
		if (filter.burrowId === undefined) {
			throw new ValidationError("HttpEventsClient.tail requires { burrowId } over HTTP", {
				recoveryHint: "the global events tail route is not exposed by burrow serve",
			});
		}
		const query = new URLSearchParams();
		query.set("follow", filter.once === true ? "0" : "1");
		if (filter.since !== undefined) query.set("since", String(filter.since));
		if (filter.kinds !== undefined && filter.kinds.length > 0) {
			query.set("kinds", filter.kinds.join(","));
		}
		if (filter.pollIntervalMs !== undefined) {
			query.set("pollIntervalMs", String(filter.pollIntervalMs));
		}
		if (filter.limit !== undefined) query.set("limit", String(filter.limit));
		return streamRunEvents(
			this.transport,
			`/burrows/${encodeURIComponent(filter.burrowId)}/events`,
			query,
			{ ...(filter.signal !== undefined ? { signal: filter.signal } : {}) },
		);
	}

	replay(burrowId: string, since = 0): AsyncGenerator<RunEvent, void, void> {
		return this.tail({ burrowId, since, once: true });
	}
}

/**
 * Agents namespace (SPEC §15.5). HTTP can't ship live `AgentRuntime`
 * objects — the runtime methods (`buildSpawnCommand`, `parseEvents`,
 * `installCheck`) only exist in the server process. The HTTP namespace
 * exposes the read-only summary the server already serializes; mutating
 * the server's registry over the wire is intentionally out of scope.
 */
export class HttpAgentsClient {
	constructor(private readonly transport: HttpTransportClient) {}

	async list(): Promise<HttpAgentDetail[]> {
		return this.transport.request<HttpAgentDetail[]>({ method: "GET", path: "/agents" });
	}

	async get(id: string): Promise<HttpAgentDetail | null> {
		return this.transport.request<HttpAgentDetail>({
			method: "GET",
			path: `/agents/${encodeURIComponent(id)}`,
			allow404: true,
		});
	}

	async require(id: string): Promise<HttpAgentDetail> {
		return this.transport.request<HttpAgentDetail>({
			method: "GET",
			path: `/agents/${encodeURIComponent(id)}`,
		});
	}

	async has(id: string): Promise<boolean> {
		return (await this.get(id)) !== null;
	}
}

/**
 * Public top-level HTTP client (SPEC §15 mirror, plan pl-5b40 step 6).
 *
 * Construction is sync — there's no DB to migrate or socket to bind, just
 * URL composition and a token to capture. `close()` is a no-op today but
 * stays async so swapping back to the in-process `Client.close()` on the
 * caller side is a safe rename.
 */
export class HttpClient {
	readonly burrows: HttpBurrowsClient;
	readonly runs: HttpRunsClient;
	readonly inbox: HttpInboxClient;
	readonly events: HttpEventsClient;
	readonly agents: HttpAgentsClient;

	private readonly transport: HttpTransportClient;

	constructor(opts: HttpClientOptions) {
		this.transport = new HttpTransportClient(opts);
		this.burrows = new HttpBurrowsClient(this.transport);
		this.runs = new HttpRunsClient(this.transport);
		this.inbox = new HttpInboxClient(this.transport);
		this.events = new HttpEventsClient(this.transport);
		this.agents = new HttpAgentsClient(this.transport);
	}

	/** Mirrors `Client.open` so factory call sites can swap one for the other. */
	static async connect(opts: HttpClientOptions): Promise<HttpClient> {
		return new HttpClient(opts);
	}

	async close(): Promise<void> {
		// No persistent connection state today — bun's fetch tears down per-call.
	}

	/** Liveness probe — hits the auth-exempt /healthz route. */
	async healthz(): Promise<void> {
		await this.transport.request<{ ok: boolean }>({ method: "GET", path: "/healthz" });
	}
}

/* ----------------------------------------------------------------------- */
/* Streaming                                                                */
/* ----------------------------------------------------------------------- */

/**
 * Pump an NDJSON stream into `RunEvent`s. Handles per-chunk decoding,
 * line-buffering across chunks, and AbortSignal cleanup. The caller's
 * `signal` aborts the underlying fetch (closing the server-side
 * generator); a generator `return()` (consumer broke out of the loop)
 * cancels the reader and propagates back through the same fetch abort.
 */
async function* streamRunEvents(
	transport: HttpTransportClient,
	path: string,
	query: URLSearchParams,
	opts: { signal?: AbortSignal } = {},
): AsyncGenerator<RunEvent, void, void> {
	const ctrl = new AbortController();
	const onAbort = (): void => ctrl.abort();
	if (opts.signal !== undefined) {
		if (opts.signal.aborted) ctrl.abort();
		else opts.signal.addEventListener("abort", onAbort, { once: true });
	}

	let res: Response;
	try {
		res = await transport.request({
			method: "GET",
			path,
			query,
			signal: ctrl.signal,
			stream: true,
		});
	} catch (err) {
		if (opts.signal !== undefined) opts.signal.removeEventListener("abort", onAbort);
		throw err;
	}

	try {
		for await (const line of readNdjsonLines(res, ctrl.signal)) {
			const envelope = JSON.parse(line) as EventEnvelope;
			yield envelopeToRunEvent(envelope);
		}
	} finally {
		ctrl.abort();
		if (opts.signal !== undefined) opts.signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Iterate NDJSON lines off a fetch response. Skips blank lines (NDJSON
 * spec) and folds the trailing pre-EOL fragment so the last line emits
 * even when the server doesn't terminate with '\n'.
 */
async function* readNdjsonLines(
	res: Response,
	signal: AbortSignal,
): AsyncGenerator<string, void, void> {
	const body = res.body;
	if (body === null) return;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const onAbort = (): void => {
		reader.cancel().catch(() => {});
	};
	if (signal.aborted) {
		await reader.cancel().catch(() => {});
		return;
	}
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nl = buffer.indexOf("\n");
			while (nl >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (line.length > 0) yield line;
				nl = buffer.indexOf("\n");
			}
		}
		buffer += decoder.decode();
		if (buffer.length > 0) yield buffer;
	} finally {
		signal.removeEventListener("abort", onAbort);
		await reader.cancel().catch(() => {});
	}
}

/* ----------------------------------------------------------------------- */
/* Wire ↔ in-process shape rehydration                                       */
/* ----------------------------------------------------------------------- */

function reviveBurrow(raw: unknown): Burrow {
	const row = raw as Record<string, unknown>;
	return {
		...row,
		createdAt: toDate(row.createdAt),
		updatedAt: toDate(row.updatedAt),
		destroyedAt:
			row.destroyedAt === null || row.destroyedAt === undefined ? null : toDate(row.destroyedAt),
	} as Burrow;
}

function reviveRun(raw: unknown): Run {
	const row = raw as Record<string, unknown>;
	return {
		...row,
		queuedAt: toDate(row.queuedAt),
		startedAt: row.startedAt === null || row.startedAt === undefined ? null : toDate(row.startedAt),
		completedAt:
			row.completedAt === null || row.completedAt === undefined ? null : toDate(row.completedAt),
	} as Run;
}

function reviveMessage(raw: unknown): Message {
	const row = raw as Record<string, unknown>;
	return {
		...row,
		createdAt: toDate(row.createdAt),
		deliveredAt:
			row.deliveredAt === null || row.deliveredAt === undefined ? null : toDate(row.deliveredAt),
	} as Message;
}

/**
 * Wire envelope drops `events.id` (the autoincrement row PK is server-only;
 * `seq` is the stable per-burrow ordering). Consumers of `RunEvent` over
 * HTTP get `id: 0` — they should be reading `seq` for ordering anyway.
 */
function envelopeToRunEvent(env: EventEnvelope): RunEvent {
	return {
		id: 0,
		burrowId: env.burrowId,
		runId: env.runId,
		seq: env.seq,
		kind: env.kind,
		stream: env.stream as RunEvent["stream"],
		payload: env.payload,
		ts: new Date(env.ts),
	};
}

function toDate(value: unknown): Date {
	if (value instanceof Date) return value;
	if (typeof value === "string" || typeof value === "number") return new Date(value);
	throw new ValidationError(`expected ISO timestamp; got ${JSON.stringify(value)}`);
}

/* ----------------------------------------------------------------------- */
/* Error envelope rehydration                                                */
/* ----------------------------------------------------------------------- */

/**
 * Map the server's `{error: {code, message, hint}}` envelope back into the
 * sister `BurrowError` subclass. The server's `renderError`
 * (src/server/errors.ts) is the dual of this — keep them aligned.
 */
function rehydrateError(status: number, envelope: ErrorEnvelope | null): Error {
	const code = envelope?.error.code ?? "internal_error";
	const message = envelope?.error.message ?? `HTTP ${status}`;
	const hint = envelope?.error.hint;
	const opts = hint !== undefined ? { recoveryHint: hint } : undefined;
	switch (code) {
		case "not_found":
			return new NotFoundError(message, opts);
		case "validation_error":
			return new ValidationError(message, opts);
		case "credential_error":
			return new CredentialError(message, opts);
		case "agent_not_installed":
			return new AgentNotInstalled(message, opts);
		case "agent_runtime_failed":
			return new AgentRuntimeError(message, opts);
		case "sandbox_error":
		case "bwrap_or_sb_missing":
			return new SandboxError(message, opts);
		case "workspace_materialization_failed":
			return new WorkspaceMaterializationError(message, opts);
		case "toolchain_mismatch":
			return new ToolchainMismatch(message, opts);
		case "secret_resolution_failed":
			return new SecretResolutionError(message, opts);
		default:
			return new HttpClientError(status, code, message, hint);
	}
}

/**
 * Fallback for codes the dispatcher doesn't recognize (e.g. `unauthorized`
 * 401, `not_implemented` 501, transport-only failures). Surfaces the
 * server's code so callers can switch on it; not a `BurrowError` subclass
 * because the in-process Client never throws these.
 */
export class HttpClientError extends Error {
	override readonly name = "HttpClientError";
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly hint?: string,
	) {
		super(message);
	}
}

/** Re-export so callers can use `instanceof BurrowError` without importing core. */
export { BurrowError };
