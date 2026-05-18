/**
 * Top-level library entry (SPEC §15).
 *
 * `Client.open()` is the single async constructor: it resolves paths, opens
 * the SQLite database (running migrations), boots an `AgentRegistry` with the
 * built-ins, and wires an in-process `EventBus`. The client owns these
 * resources and tears them down via `close()`.
 *
 * The five SPEC namespaces (burrows / runs / inbox / events / agents) are
 * surfaced as instance fields. Each is a thin wrapper over the lower-level
 * primitives (repos, helpers in src/events/*, src/inbox/*) so callers don't
 * have to learn the internal layering — and so cross-cutting concerns like
 * "publish the destroy event before pruning" land in one place.
 *
 * Consumers:
 *   - The CLI in src/cli/main.ts opens a Client per invocation.
 *   - Library users (overstory, greenhouse) hold a long-lived Client.
 *   - Tests open Client.open({ dataDir, configDir }) against tmp dirs.
 */

import { runUpCommand, type UpCommandInput } from "../cli/commands/up.ts";
import { resolvePaths } from "../config/paths.ts";
import { ValidationError } from "../core/errors.ts";
import { RUN_TERMINAL_STATES } from "../core/state-machine.ts";
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
import { type BurrowDb, openDatabase } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { DestroyBurrowResult } from "../events/destroy.ts";
import { type TailAllOptions, type TailOptions, tailAll, tailBurrow } from "../events/poll.ts";
import { appendAndPublish } from "../events/publish.ts";
import { EventBus, type Subscription } from "../events/tail.ts";
import { Inbox } from "../inbox/inbox.ts";
import { createLogger, type Logger } from "../logging/logger.ts";
import type { RemoveWorkspaceOptions } from "../provider/local/workspace.ts";
import type { NetworkPolicy } from "../provider/types.ts";
import { AgentRegistry } from "../runtime/registry.ts";
import type { AgentRuntime } from "../runtime/runtime.ts";
import type { AgentConfig } from "../schemas/agent-config.ts";
import { destroyBurrowFully } from "./destroy.ts";

export interface ClientOpenOptions {
	dataDir?: string;
	configDir?: string;
	cacheDir?: string;
	/** Override the SQLite path. Defaults to `${dataDir}/db.sqlite`. */
	dbPath?: string;
	/** Pre-resolved logger; one is created if omitted. */
	logger?: Logger;
}

export interface BurrowListFilter {
	kind?: BurrowKind;
	state?: BurrowState;
	projectRoot?: string;
}

export interface RunListFilter {
	burrowId?: string;
	state?: RunState | RunState[];
	limit?: number;
}

export interface InboxListFilter {
	state?: MessageState;
}

export interface InboxSendInput {
	burrowId: string;
	body: string;
	priority?: MessagePriority;
	fromActor?: string;
}

export interface RunCreateInput {
	burrowId: string;
	agentId: string;
	prompt: string;
	metadata?: unknown;
}

/**
 * Public surface for `client.burrows.up()` (SPEC §15.1). Mirrors the wire
 * shape accepted by `POST /burrows` so warren and other HTTP consumers can
 * pass the same fields they post over the wire. The heavy lifting
 * (burrow.toml load, doctor, secrets, worktree materialization, sandbox
 * profile build) lives in `runUpCommand` — this is a thin pass-through.
 */
export interface BurrowUpInput {
	projectRoot: string;
	name?: string;
	branch?: string;
	baseBranch?: string;
	originUrl?: string;
	network?: NetworkPolicy;
	provider?: string;
	/**
	 * Built-in runtimes the caller wants enabled as `[[agents]]` patch rows
	 * for this burrow (warren-8526 / burrow-55e3). Each id is appended to the
	 * project's `burrow.toml [[agents]]` (deduped); the merged list feeds
	 * toolchain bin-dir + credential-path collection so the sandbox can
	 * actually exec the runtime's binary.
	 */
	agents?: readonly string[];
	/**
	 * Env var overrides forwarded into `resolveEnv` and baked into the
	 * sandbox profile (warren-a346 / burrow-59cd). Wins over
	 * `[env].defaults`, `[secrets]`, the secret store, and the host env —
	 * see `src/cli/commands/up.ts` step 4. The HTTP handler reads these
	 * from `body.env` on `POST /burrows`.
	 */
	envOverrides?: Record<string, string>;
}

/**
 * Test seams forwarded into `runUpCommand`. Production callers leave this
 * unset; tests pass a fake materializer + `skipDoctor: true` so the up flow
 * doesn't shell out to git or the host toolchain. Set via
 * `BurrowsClient.setUpOverrides()` because `up()` is reached through the
 * HTTP handler which has no body channel for these.
 */
export type BurrowUpOverrides = Omit<UpCommandInput, "client" | "projectRoot" | "options">;

/**
 * Test seam forwarded into `destroyBurrowFully`. Production callers leave
 * this unset — the helper falls back to `removeMaterializedWorkspace`. Tests
 * inject a stub via `BurrowsClient.setDestroyOverrides()` so handler tests
 * can verify cleanup without hitting `git worktree`.
 */
export interface BurrowDestroyOverrides {
	removeWorkspace?: (opts: RemoveWorkspaceOptions) => Promise<void>;
}

export interface EventTailFilter {
	burrowId?: string;
	burrowIds?: string[];
	kinds?: string[];
	since?: number | Record<string, number>;
	signal?: AbortSignal;
	pollIntervalMs?: number;
	once?: boolean;
}

/**
 * Burrows namespace (SPEC §15.1).
 */
export class BurrowsClient {
	private upOverrides: BurrowUpOverrides | null = null;
	private destroyOverrides: BurrowDestroyOverrides | null = null;

	constructor(
		private readonly client: Client,
		private readonly repos: Repos,
	) {}

	/**
	 * Provision a project burrow (SPEC §15.1, §16 `burrow up`). Loads
	 * `burrow.toml` from `projectRoot`, runs `burrow doctor`, resolves
	 * env/secrets, materializes the workspace worktree, and inserts the
	 * burrow row with the resolved sandbox profile. Returns the freshly
	 * created `Burrow`.
	 *
	 * Overrides for tests (materializer, skipDoctor, …) are picked up from
	 * `setUpOverrides()`. The HTTP handler in `src/server/handlers.ts` does
	 * not expose those fields on the wire — the seam exists so handler tests
	 * can drive a deterministic up flow without git or doctor side effects.
	 */
	async up(input: BurrowUpInput): Promise<Burrow> {
		const options: UpCommandInput["options"] = {};
		if (input.name !== undefined) options.name = input.name;
		if (input.branch !== undefined) options.branch = input.branch;
		if (input.baseBranch !== undefined) options.baseBranch = input.baseBranch;
		if (input.originUrl !== undefined) options.originUrl = input.originUrl;
		if (input.network !== undefined) options.network = input.network;
		if (input.provider !== undefined) options.provider = input.provider;
		if (input.agents !== undefined) options.agents = input.agents;
		const upInput: UpCommandInput = {
			client: this.client,
			projectRoot: input.projectRoot,
			options,
			...(this.upOverrides ?? {}),
		};
		// Wire-level envOverrides (HTTP body.env / burrow-be5b) fills in only
		// when no test-seam override already set them, so setUpOverrides()
		// keeps winning for handler tests.
		if (input.envOverrides !== undefined && upInput.envOverrides === undefined) {
			upInput.envOverrides = input.envOverrides;
		}
		const result = await runUpCommand(upInput);
		return result.burrow;
	}

	/** Test seam — see `BurrowUpOverrides`. Set to `null` to clear. */
	setUpOverrides(overrides: BurrowUpOverrides | null): void {
		this.upOverrides = overrides;
	}

	/** Test seam — see `BurrowDestroyOverrides`. Set to `null` to clear. */
	setDestroyOverrides(overrides: BurrowDestroyOverrides | null): void {
		this.destroyOverrides = overrides;
	}

	list(filter: BurrowListFilter = {}): Burrow[] {
		let rows = filter.state
			? this.repos.burrows.listByState(filter.state, filter.kind)
			: this.repos.burrows.listAll();
		if (filter.kind && !filter.state) {
			rows = rows.filter((b) => b.kind === filter.kind);
		}
		if (filter.projectRoot) {
			rows = rows.filter((b) => b.projectRoot === filter.projectRoot);
		}
		return rows;
	}

	get(id: string): Burrow {
		return this.repos.burrows.require(id);
	}

	tryGet(id: string): Burrow | null {
		return this.repos.burrows.get(id);
	}

	stop(id: string): Burrow {
		return this.repos.burrows.markStopped(id);
	}

	resume(id: string): Burrow {
		return this.repos.burrows.markActive(id);
	}

	/**
	 * Tear down a burrow end-to-end (SPEC §14.4): stop if active, remove the
	 * provider workspace (worktree + branch) unless `keepWorkspace`, then
	 * archive + prune live rows + mark destroyed. Returns the wire-shape
	 * `DestroyBurrowResult` (the storage half of the flow); the workspace
	 * step is a side effect.
	 *
	 * Already-destroyed burrows return a synthesized empty result (idempotent
	 * — no second archive, no workspace work).
	 */
	async destroy(
		id: string,
		opts: { archive?: boolean; keepWorkspace?: boolean; force?: boolean } = {},
	): Promise<DestroyBurrowResult> {
		const fullOpts = {
			...(opts.archive !== undefined ? { archive: opts.archive } : {}),
			...(opts.keepWorkspace !== undefined ? { keepWorkspace: opts.keepWorkspace } : {}),
			...(opts.force !== undefined ? { force: opts.force } : {}),
			...(this.destroyOverrides?.removeWorkspace
				? { removeWorkspace: this.destroyOverrides.removeWorkspace }
				: {}),
		};
		const outcome = await destroyBurrowFully(this.client, id, fullOpts);
		return outcome.archive;
	}
}

/**
 * Runs namespace (SPEC §15.2).
 */
export class RunsClient {
	private onCreated: ((runId: string) => void) | null = null;

	constructor(
		private readonly repos: Repos,
		private readonly bus: EventBus,
	) {}

	/**
	 * Register a hook called after every successful `create`. Used by the
	 * `RunDispatcher` (`burrow serve`'s in-process executor) to learn about
	 * HTTP-enqueued runs the moment they hit the DB. Single-callback —
	 * setting again replaces the previous registration; pass `null` to clear.
	 *
	 * Intentionally NOT an event-bus subscription: the bus only carries
	 * persisted `events` rows, and a queued-run notification is a control
	 * signal, not a tail-able timeline entry.
	 */
	setOnCreated(cb: ((runId: string) => void) | null): void {
		this.onCreated = cb;
	}

	create(input: RunCreateInput): Run {
		this.repos.burrows.require(input.burrowId);
		const run = this.repos.runs.enqueue({
			burrowId: input.burrowId,
			agentId: input.agentId,
			prompt: input.prompt,
			metadata: input.metadata,
		});
		this.onCreated?.(run.id);
		return run;
	}

	get(id: string): Run {
		return this.repos.runs.require(id);
	}

	tryGet(id: string): Run | null {
		return this.repos.runs.get(id);
	}

	list(filter: RunListFilter = {}): Run[] {
		if (filter.burrowId) {
			return this.repos.runs.listByBurrow(filter.burrowId, filter.limit ?? 50);
		}
		if (filter.state) {
			return this.repos.runs.listByState(filter.state);
		}
		return this.repos.runs.listTerminal();
	}

	/**
	 * Graceful cancel (SPEC §15.2). Idempotent on already-terminal runs:
	 * returns the current row without re-finalizing or re-emitting an event,
	 * so callers can retry without worrying about state. The optional
	 * `reason` lands in `errorMessage` (when transitioning) and as the
	 * payload of the emitted `run_cancelled` event so consumers tailing
	 * `/runs/:id/stream` can correlate the cancel with its trigger.
	 */
	cancel(id: string, opts: { reason?: string } = {}): Run {
		const current = this.repos.runs.require(id);
		if (RUN_TERMINAL_STATES.has(current.state)) return current;
		const reason = opts.reason;
		const finalized = this.repos.runs.finalize(id, {
			state: "cancelled",
			errorMessage: reason ?? "cancelled via Client.runs.cancel",
		});
		appendAndPublish({
			repo: this.repos.events,
			bus: this.bus,
			burrowId: finalized.burrowId,
			runId: finalized.id,
			kind: "run_cancelled",
			stream: "system",
			payload: { reason: reason ?? null },
		});
		return finalized;
	}

	/**
	 * Hard-delete a run row. Only allowed when the run is in a terminal
	 * state (`succeeded`/`failed`/`cancelled`); throws `ValidationError` for
	 * `queued`/`running` to keep an in-flight row from being silently
	 * orphaned. Throws `NotFoundError` if no run with that id exists. Use
	 * `cancel()` first to terminate, then `delete()` to remove.
	 */
	delete(id: string): void {
		const current = this.repos.runs.require(id);
		if (!RUN_TERMINAL_STATES.has(current.state)) {
			throw new ValidationError(`run ${id} is ${current.state}; cancel it before deleting`, {
				recoveryHint: "POST /runs/:id/cancel transitions a run to terminal first",
			});
		}
		this.repos.runs.delete(id);
	}

	/**
	 * Tail one run's events as they're persisted. Filters the burrow-level
	 * stream down to the specified runId; honours the AbortSignal.
	 */
	async *stream(
		id: string,
		opts: { signal?: AbortSignal; pollIntervalMs?: number } = {},
	): AsyncGenerator<RunEvent, void, void> {
		const run = this.repos.runs.require(id);
		const tailOpts: TailOptions = { sinceSeq: 0 };
		if (opts.signal) tailOpts.signal = opts.signal;
		if (opts.pollIntervalMs !== undefined) tailOpts.pollIntervalMs = opts.pollIntervalMs;
		for await (const event of tailBurrow(this.repos, run.burrowId, tailOpts)) {
			if (event.runId === id) yield event;
		}
	}
}

/**
 * Inbox namespace (SPEC §15.3) — thin wrapper over the underlying Inbox so
 * the public client surface stays in one file.
 */
export class InboxClient {
	private readonly inbox: Inbox;

	constructor(repos: Repos) {
		this.inbox = new Inbox(repos);
	}

	send(input: InboxSendInput): Message {
		return this.inbox.send(input);
	}

	list(burrowId: string, filter: InboxListFilter = {}): Message[] {
		return this.inbox.list(burrowId, filter);
	}

	pending(burrowId: string): Message[] {
		return this.inbox.pending(burrowId);
	}

	cancel(messageId: string): void {
		this.inbox.cancel(messageId);
	}

	count(burrowId: string, state?: MessageState): number {
		return this.inbox.count(burrowId, state);
	}

	/** Underlying inbox for callers that need claimForRun (run-loop integration). */
	get raw(): Inbox {
		return this.inbox;
	}
}

/**
 * Events namespace (SPEC §15.4).
 */
export class EventsClient {
	constructor(
		private readonly repos: Repos,
		private readonly bus: EventBus,
	) {}

	tail(filter: EventTailFilter = {}): AsyncGenerator<RunEvent, void, void> {
		const kinds = filter.kinds && filter.kinds.length > 0 ? new Set(filter.kinds) : null;

		if (filter.burrowId) {
			const tailOpts: TailOptions = {
				sinceSeq: typeof filter.since === "number" ? filter.since : 0,
			};
			if (filter.signal) tailOpts.signal = filter.signal;
			if (filter.pollIntervalMs !== undefined) tailOpts.pollIntervalMs = filter.pollIntervalMs;
			if (filter.once !== undefined) tailOpts.once = filter.once;
			return filterKinds(tailBurrow(this.repos, filter.burrowId, tailOpts), kinds);
		}

		const tailOpts: TailAllOptions = {};
		if (filter.burrowIds && filter.burrowIds.length > 0) tailOpts.burrowIds = filter.burrowIds;
		if (filter.signal) tailOpts.signal = filter.signal;
		if (filter.pollIntervalMs !== undefined) tailOpts.pollIntervalMs = filter.pollIntervalMs;
		if (filter.once !== undefined) tailOpts.once = filter.once;
		if (filter.since && typeof filter.since === "object") {
			tailOpts.sinceSeq = filter.since;
		}
		return filterKinds(tailAll(this.repos, tailOpts), kinds);
	}

	/** Replay one burrow's persisted events; equivalent to `tail({ once: true })`. */
	replay(burrowId: string, since = 0): AsyncGenerator<RunEvent, void, void> {
		return tailBurrow(this.repos, burrowId, { sinceSeq: since, once: true });
	}

	/**
	 * Subscribe to in-process pushes. The bus only delivers events published
	 * within this Client's process — cross-process callers must use `tail()`
	 * which polls SQLite.
	 */
	subscribe(burrowId: string, listener: (event: RunEvent) => void): Subscription {
		return this.bus.subscribe(burrowId, listener);
	}

	subscribeAll(listener: (event: RunEvent) => void): Subscription {
		return this.bus.subscribeAll(listener);
	}

	/** Underlying bus — exposed so the run-loop integration can publish. */
	get rawBus(): EventBus {
		return this.bus;
	}
}

/**
 * Agents namespace (SPEC §15.5).
 */
export class AgentsClient {
	constructor(private readonly registry: AgentRegistry) {}

	register(adapter: AgentRuntime | AgentConfig): AgentRuntime {
		return this.registry.register(adapter);
	}

	list(): AgentRuntime[] {
		return this.registry.list();
	}

	get(id: string): AgentRuntime | undefined {
		return this.registry.get(id);
	}

	require(id: string): AgentRuntime {
		return this.registry.require(id);
	}

	has(id: string): boolean {
		return this.registry.has(id);
	}

	unregister(id: string): boolean {
		return this.registry.unregister(id);
	}

	/** The underlying registry — required by `prepareTurnInjection`. */
	get raw(): AgentRegistry {
		return this.registry;
	}
}

/**
 * Public top-level client (SPEC §15).
 */
export class Client {
	readonly burrows: BurrowsClient;
	readonly runs: RunsClient;
	readonly inbox: InboxClient;
	readonly events: EventsClient;
	readonly agents: AgentsClient;

	private constructor(
		readonly db: BurrowDb,
		readonly repos: Repos,
		readonly registry: AgentRegistry,
		readonly bus: EventBus,
		readonly paths: ReturnType<typeof resolvePaths>,
		readonly logger: Logger,
	) {
		this.burrows = new BurrowsClient(this, repos);
		this.runs = new RunsClient(repos, bus);
		this.inbox = new InboxClient(repos);
		this.events = new EventsClient(repos, bus);
		this.agents = new AgentsClient(registry);
	}

	static async open(opts: ClientOpenOptions = {}): Promise<Client> {
		const paths = resolvePaths({
			...(opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {}),
			...(opts.configDir !== undefined ? { configDir: opts.configDir } : {}),
			...(opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {}),
		});
		const dbPath = opts.dbPath ?? paths.dbPath;
		if (dbPath.length === 0) {
			throw new ValidationError("Client.open requires a non-empty dbPath");
		}
		const db = await openDatabase({ path: dbPath });
		const repos = createRepos(db);
		const registry = new AgentRegistry();
		const bus = new EventBus();
		const logger = opts.logger ?? createLogger();
		return new Client(db, repos, registry, bus, paths, logger);
	}

	async close(): Promise<void> {
		this.bus.close();
		this.db.close();
	}
}

async function* filterKinds(
	source: AsyncGenerator<RunEvent, void, void>,
	kinds: Set<string> | null,
): AsyncGenerator<RunEvent, void, void> {
	if (!kinds) {
		for await (const event of source) yield event;
		return;
	}
	for await (const event of source) {
		if (kinds.has(event.kind)) yield event;
	}
}
