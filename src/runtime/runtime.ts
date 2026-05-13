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
	 */
	envPassthrough?: readonly string[];

	installCheck(): Promise<InstallCheckResult>;
}
