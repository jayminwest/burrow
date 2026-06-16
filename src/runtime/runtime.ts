/**
 * Harness-agnostic agent runtime contract (SPEC §12).
 *
 * Every runtime — built-in or declarative — is wrapped by an `AgentRuntime`.
 * The run loop calls `prepareWorkspace` once per spawn, hands the runtime a
 * `SpawnContext` to render an argv via `buildSpawnCommand`, then feeds each
 * stdout line back through `parseEvents` to produce the structured events
 * persisted to the `events` table (SPEC §14.1).
 *
 * Spawn-per-turn runtimes (claude-code, sapling) override `encodeInboxMessage`
 * to inject pending steering messages alongside the user prompt; one-shot
 * runtimes (codex) leave it unset and let the inbox layer queue messages for
 * the next *run* (SPEC §13.3).
 */

import type { Burrow, Message, Run, RunEvent } from "../core/types.ts";
import type { SpawnCommand } from "../provider/types.ts";

export interface InstallCheckResult {
	installed: boolean;
	version?: string;
	hint?: string;
	/**
	 * Absolute path to the resolved binary on the host. Surfaced to `burrow up`
	 * so its directory can be added to `SandboxProfile.toolchainPaths` (SPEC
	 * §8.4, §19) — without that, the sandbox PATH lookup fails for any agent
	 * binary that isn't already under `/usr/bin` or `/bin`.
	 */
	path?: string;
}

/**
 * Per-run agent frontmatter resolved by an upstream caller (e.g. warren's
 * `rendered_agent_json.frontmatter` — operator overrides + project defaults
 * + agent frontmatter all flatten through this shape). Built-in runtimes
 * that accept provider / model flags honor these to override their pinned
 * defaults, and the pi runtime accepts an allowlisted `pi` option bag for
 * CLI flags such as extension loading and project approval. Empty or
 * whitespace-only strings are treated as unset (fall back to the runtime
 * default). Sourced from `Run.metadataJson.frontmatter` by the dispatcher
 * (burrow-b5b4).
 */
export interface PiFrontmatterOptions {
	/** Opt in to pi extension discovery by eliding --no-extensions. */
	extensions?: boolean;
	/** Trust project-local .pi settings/resources for this non-interactive run. */
	approve?: boolean;
	/** Disable all tools by default. Maps to --no-tools. */
	noTools?: boolean;
	/** Disable built-in tools while leaving extension/custom tools available. */
	noBuiltinTools?: boolean;
	/** Comma-separated or array-form allowlist for --tools. */
	tools?: string | readonly string[];
	/** Comma-separated or array-form denylist for --exclude-tools. */
	excludeTools?: string | readonly string[];
	/** Extra extension paths to load with repeated --extension flags. */
	extension?: string | readonly string[];
	/** Extra skill paths to load with repeated --skill flags. */
	skill?: string | readonly string[];
	/** Extra prompt template paths to load with repeated --prompt-template flags. */
	promptTemplate?: string | readonly string[];
	/** Extra theme paths to load with repeated --theme flags. */
	theme?: string | readonly string[];
}

export interface AgentFrontmatter {
	provider?: string;
	model?: string;
	pi?: PiFrontmatterOptions;
}

export interface SpawnContext {
	burrow: Burrow;
	run: Run;
	prompt: string;
	/** Steering messages to deliver as part of this turn (SPEC §13.2). */
	pendingMessages: Message[];
	/** Resolved env that will be exported into the sandbox. */
	envResolved: Record<string, string>;
	/**
	 * Workspace path on the host. Sandbox bind-mounts this to /workspace, so
	 * the agent only ever sees `/workspace`; runtime code that writes setup
	 * files (e.g. .claude/settings.local.json) operates on the host path.
	 */
	workspacePath: string;
	/**
	 * Optional per-run agent frontmatter override. Runtimes that accept
	 * provider / model flags substitute these for their built-in defaults
	 * when set; runtimes that don't care simply ignore the field.
	 */
	frontmatter?: AgentFrontmatter;
}

export interface ResumeContext extends SpawnContext {
	/** The prior run we're continuing from. Always in a terminal state. */
	priorRun: Run;
}

export interface ParseContext {
	burrow: Burrow;
	run: Run;
}

export interface PrepareContext {
	burrow: Burrow;
	run: Run;
	workspacePath: string;
}

export interface ExtractMetadataContext {
	burrow: Burrow;
	run: Run;
	workspacePath: string;
}

/**
 * Context handed to a function-form `AgentRuntime.envPassthrough` (burrow-6f3f).
 * Intentionally narrow — only the per-run frontmatter is needed to pick a
 * provider-conditional key set, so the type doesn't pull in the rest of
 * `SpawnContext` and is callable from both `burrow up` (base names with an
 * empty frontmatter) and the dispatcher (real frontmatter from the run).
 */
export interface EnvPassthroughContext {
	frontmatter?: AgentFrontmatter;
}

/**
 * Partial event shape produced by `parseEvents`. The run-loop layer fills in
 * `id`, `seq`, `burrowId`, `runId`, and `ts` when persisting.
 */
export type RuntimeEvent = Omit<RunEvent, "id" | "seq" | "burrowId" | "runId" | "ts"> & {
	ts?: Date;
};

export interface AgentRuntime {
	id: string;
	displayName: string;
	supportsResume: boolean;

	buildSpawnCommand(ctx: SpawnContext): SpawnCommand;
	parseEvents(line: string, ctx: ParseContext): RuntimeEvent[];

	buildResumeCommand?(ctx: ResumeContext): SpawnCommand;
	encodeInboxMessage?(messages: Message[]): { stdin: string };
	prepareWorkspace?(ctx: PrepareContext): Promise<void>;

	/**
	 * Post-spawn hook called by the dispatcher once the agent process exits
	 * successfully. Returns key/value pairs to merge into `runs.metadataJson`
	 * — e.g. the resume token (`session_id`) the next `buildResumeCommand`
	 * call will read off `priorRun.metadataJson`. Implementations may inspect
	 * the workspace filesystem (pi's session files) or scan persisted events
	 * (claude-code's `system/init` envelope).
	 *
	 * Best-effort: failures and `undefined` returns are swallowed so a
	 * runtime that can't recover a session id never fails an otherwise
	 * successful run.
	 */
	extractMetadata?(ctx: ExtractMetadataContext): Promise<Record<string, unknown> | undefined>;

	/**
	 * Host paths the runtime needs read-only inside the sandbox to authenticate
	 * (SPEC §17.4). `burrow up` calls this for every declared agent and folds
	 * the result into `SandboxProfile.readOnlyMounts`. Implementations should
	 * filter to paths that exist on the host so a fresh user environment with
	 * no credential cache contributes nothing instead of failing the mount.
	 */
	credentialPaths?(): Promise<string[]>;

	/**
	 * If defined, the dispatcher holds the child's stdin open after writing
	 * the prompt and closes it only when this predicate returns true for a
	 * persisted event (or when the process exits, as a fallback). Runtimes
	 * whose CLI exits the instant stdin closes mid-inference (e.g. pi
	 * v0.74.0 — mx-d9b3ad) MUST set this; runtimes that rely on stdin EOF
	 * to flush their final output (e.g. claude-code `--print`) MUST NOT.
	 *
	 * The predicate is invoked once per parser-emitted event after the
	 * event is persisted. The first event that returns true triggers
	 * `SpawnResult.closeStdin()`; subsequent events are ignored on the
	 * stdin-close path (the call is idempotent regardless).
	 */
	shouldCloseStdinOnEvent?(event: RuntimeEvent): boolean;

	/**
	 * Mid-run steering encoder (SPEC §13.5). Called by the dispatcher when
	 * an inbox message arrives while the agent is still running so the
	 * message can be delivered without waiting for the next spawn. The
	 * returned `stdin` string is written verbatim to the child's stdin
	 * via `SpawnResult.writeStdin`; runtimes own their own line
	 * termination (e.g. trailing `\n` for NDJSON-RPC).
	 *
	 * Only effective when the runtime also declares
	 * `shouldCloseStdinOnEvent` (so the dispatcher actually holds stdin
	 * open) and the spawn result exposes `writeStdin`. Runtimes that
	 * close stdin at spawn time (claude-code `--print`, sapling
	 * `--prompt`) leave this unset — their pending messages continue to
	 * flow through `pendingMessages` at the *next* spawn (SPEC §13.2).
	 *
	 * Returning `undefined` declines mid-stream delivery for this message
	 * (e.g. shape doesn't match an open turn); the message stays `unread`
	 * and the next tick / next spawn picks it up.
	 */
	encodeSteeringMessage?(message: Message): { stdin: string } | undefined;

	/**
	 * Optional auto-reply hook (burrow-aea0). Invoked by the dispatcher once
	 * per parser-emitted event *after* the event is persisted, before the
	 * `shouldCloseStdinOnEvent` predicate is checked. If the hook returns
	 * `{stdin}`, the dispatcher writes that string verbatim to the still-open
	 * child stdin via `SpawnResult.writeStdin` — the runtime owns its own
	 * framing (e.g. trailing `\n` for NDJSON-RPC). Returning `undefined`
	 * declines (the dispatcher does nothing for this event).
	 *
	 * Generic and runtime-agnostic: the canonical use case is replying to a
	 * mid-run request envelope the runtime emitted (e.g. pi-chat's
	 * `extension_ui_request` → cancelled `extension_ui_response`). Only
	 * effective when the runtime also declares `shouldCloseStdinOnEvent` (so
	 * stdin is actually held open) and the spawn result exposes
	 * `writeStdin`; otherwise the hook is silently skipped.
	 *
	 * Best-effort: write failures are swallowed so an auto-reply hiccup
	 * never fails an otherwise successful run.
	 */
	autoRespondToEvent?(event: RuntimeEvent): { stdin: string } | undefined;

	/**
	 * Host env var names this runtime needs forwarded into the sandbox for its
	 * CLI to authenticate or configure itself. `burrow up` unions every
	 * effective agent's list with the project's `[env]`-derived passthrough
	 * names onto `SandboxProfile.envPassthrough`. Names listed here only
	 * forward when the host process actually sets them — same dropping
	 * behavior as project-declared passthrough (`resolveSandboxEnv`).
	 *
	 * This is the runtime-level escape hatch for env names that are an
	 * intrinsic part of the runtime's contract (e.g. `ANTHROPIC_API_KEY` for
	 * `claude-code`); per-project keys still belong in `burrow.toml [env]`.
	 *
	 * Function form (burrow-6f3f): runtimes that multiplex over providers
	 * (e.g. `pi --provider <name>`) can declare a callback that returns the
	 * effective passthrough set for a given run's frontmatter. `burrow up`
	 * invokes it with an empty frontmatter to bake the runtime's *base*
	 * names into `profile.envPassthrough` (respecting per-agent
	 * `forwardCredentials = false`); the run dispatcher re-invokes it with
	 * the run's actual `frontmatter` and unions the returned names onto the
	 * profile passthrough used for that spawn. The function must be pure
	 * (no side effects, no host env reads) so up-time and dispatch-time
	 * callers agree on the base set.
	 */
	envPassthrough?: readonly string[] | ((ctx: EnvPassthroughContext) => readonly string[]);

	installCheck(): Promise<InstallCheckResult>;
}
