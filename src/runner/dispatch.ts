/**
 * `dispatchRun` — drive an already-claimed run to a terminal `RunOutcome`.
 *
 * Two callers share this logic:
 *   1. `burrow prompt` (src/cli/commands/prompt.ts) — inline from the CLI,
 *      with events tee'd to stdout.
 *   2. The HTTP server's run dispatcher (src/runner/dispatcher.ts) — the
 *      `RunLoop` handler `burrow serve` runs so HTTP-enqueued runs actually
 *      execute.
 *
 * Pre/post conditions:
 *   - The caller has already enqueued + claimed the run (state=`running`,
 *     `startedAt` populated). `dispatchRun` does NOT call enqueue/claim.
 *   - The caller is responsible for finalizing the run (`runs.finalize` or
 *     `RunLoop` does it). `dispatchRun` returns the `RunOutcome` that should
 *     be passed to `finalize`; it never writes the terminal state itself.
 *
 * Anything bracketing-the-spawn lives here: pendingMessage claim, codex
 * prompt-file write, network proxy lifecycle, stdout/stderr→events stream.
 * Stays in lockstep with `prompt.ts`'s historical inline driver — the bug
 * `burrow-7b97` fix lifted that body out so the daemonized HTTP path
 * doesn't have to reimplement it.
 */

import type { Burrow, Run, RunEvent } from "../core/types.ts";
import type { Repos } from "../db/repos/index.ts";
import { appendAndPublish } from "../events/publish.ts";
import type { EventBus } from "../events/tail.ts";
import type { Client } from "../lib/client.ts";
import { runSandboxed } from "../provider/local/sandbox.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../provider/types.ts";
import { type ProxyHandle, type StartProxyOptions, startProxy } from "../proxy/server.ts";
import { composeCodexPrompt, writeCodexPromptFile } from "../runtime/codex.ts";
import type {
	AgentFrontmatter,
	AgentRuntime,
	InstallCheckResult,
	RuntimeEvent,
} from "../runtime/runtime.ts";
import type { RunOutcome } from "./run-loop.ts";

/**
 * How often the mid-run steering loop polls the messages table for newly
 * arrived inbox rows. Bounded by SQLite latency, not a network hop, so a
 * short interval is cheap; tunable mostly for tests.
 */
const MID_RUN_INBOX_POLL_MS = 200;

export type SpawnFn = (profile: SandboxProfile, command: SpawnCommand) => Promise<SpawnResult>;
export type StartProxyFn = (opts: StartProxyOptions) => Promise<ProxyHandle>;

export interface DispatchRunInput {
	client: Client;
	/** Run row already claimed (state=running). */
	run: Run;
	signal?: AbortSignal;
	/**
	 * Called for every event after it's persisted + published. The CLI uses
	 * it to render NDJSON / pretty output to stdout. The server path leaves
	 * it unset — events flow over `/runs/:id/stream` to HTTP consumers.
	 */
	onEvent?: (event: RunEvent) => void;
	/**
	 * Called once after the per-run inbox claim. Surfaces the count back
	 * to callers that report it in their result envelope (e.g. the prompt
	 * CLI's `PromptCommandResult.messagesDelivered`).
	 */
	onMessagesClaimed?: (count: number) => void;
	/** Test seam: alternate sandboxed-spawn implementation. */
	spawn?: SpawnFn;
	/** Test seam: alternate proxy starter (default: src/proxy/server.ts). */
	startProxy?: StartProxyFn;
	/** Test seam: skip the runtime's installCheck. */
	installCheck?: (rt: AgentRuntime) => Promise<InstallCheckResult>;
	/** Test seam: override the mid-run inbox poll cadence (ms). */
	midRunInboxPollMs?: number;
}

export async function dispatchRun(input: DispatchRunInput): Promise<RunOutcome> {
	const { client, run, signal } = input;
	const repos = client.repos;
	const burrow = repos.burrows.require(run.burrowId);

	// Agent and burrow validity checks return failed-with-message rather
	// than throwing — the run loop's catch path collapses everything to a
	// generic "failed" so a structured message here is more useful to
	// debug.
	const runtime = client.agents.get(run.agentId);
	if (!runtime) {
		return { state: "failed", errorMessage: `agent '${run.agentId}' is not registered` };
	}
	if (burrow.state !== "active") {
		return {
			state: "failed",
			errorMessage: `burrow ${burrow.id} is in state '${burrow.state}'; cannot dispatch`,
		};
	}

	const installCheckFn = input.installCheck ?? ((rt) => rt.installCheck());
	const install = await installCheckFn(runtime);
	if (!install.installed) {
		return {
			state: "failed",
			errorMessage: install.hint
				? `agent '${runtime.id}' is not installed: ${install.hint}`
				: `agent '${runtime.id}' is not installed`,
		};
	}

	const profile = burrow.profileJson as SandboxProfile;
	const pendingMessages = client.inbox.raw.claimForRun(burrow.id, run.id);
	input.onMessagesClaimed?.(pendingMessages.length);

	if (runtime.prepareWorkspace) {
		await runtime.prepareWorkspace({
			burrow,
			run,
			workspacePath: burrow.workspacePath,
		});
	}

	if (runtime.id === "codex") {
		await writeCodexPromptFile(
			burrow.workspacePath,
			run.id,
			composeCodexPrompt(run.prompt, pendingMessages),
		);
	}

	const frontmatter = readFrontmatter(run.metadataJson);
	const command = runtime.buildSpawnCommand({
		burrow,
		run,
		prompt: run.prompt,
		pendingMessages,
		envResolved: profile.setEnv ?? {},
		workspacePath: burrow.workspacePath,
		...(frontmatter ? { frontmatter } : {}),
	});

	// Function-form `envPassthrough` (burrow-6f3f): re-resolve with the
	// run's actual frontmatter so a runtime that multiplexes over providers
	// (e.g. pi --provider <name>) can opt the matching provider key into
	// passthrough per-run. The base names landed on `profile.envPassthrough`
	// at `burrow up` time via the same function called with an empty
	// frontmatter — that path also gates on per-agent
	// `forwardCredentials = false`, so an agent that opted out has no base
	// names in `profile.envPassthrough` here and we still skip the union.
	const dispatchProfile = applyRuntimeEnvPassthrough(profile, runtime, frontmatter);

	const spawn = input.spawn ?? runSandboxed;
	const startProxyFn = input.startProxy ?? startProxy;

	const useStdinHold = runtime.shouldCloseStdinOnEvent !== undefined;

	let proxy: ProxyHandle | null = null;
	let runProfile: SandboxProfile = dispatchProfile;
	let runCommand: SpawnCommand = useStdinHold ? { ...command, holdStdin: true } : command;
	if (dispatchProfile.network === "restricted") {
		try {
			proxy = await startProxyFn({ allowedDomains: dispatchProfile.allowedDomains });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { state: "failed", errorMessage: `failed to start network proxy: ${message}` };
		}
		runProfile = { ...dispatchProfile, proxyAddress: { host: "127.0.0.1", port: proxy.port } };
		runCommand = {
			...command,
			env: {
				...(command.env ?? {}),
				HTTP_PROXY: proxy.url,
				HTTPS_PROXY: proxy.url,
				http_proxy: proxy.url,
				https_proxy: proxy.url,
				NO_PROXY: "",
				no_proxy: "",
			},
		};
	}

	let proc: SpawnResult;
	try {
		proc = await spawn(runProfile, runCommand);
	} catch (err) {
		await proxy?.stop();
		const errorMessage = err instanceof Error ? err.message : String(err);
		return { state: "failed", errorMessage };
	}

	let cancelled = false;
	const onAbort = (): void => {
		if (cancelled) return;
		cancelled = true;
		proc.cancel();
	};
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	const persistEvents = (events: RuntimeEvent[]): void => {
		for (const ev of events) {
			const persisted = appendAndPublish({
				repo: repos.events,
				bus: client.bus,
				burrowId: burrow.id,
				runId: run.id,
				kind: ev.kind,
				stream: ev.stream,
				payload: ev.payload,
				...(ev.ts !== undefined ? { ts: ev.ts } : {}),
			});
			input.onEvent?.(persisted);
		}
	};

	let stdinClosed = false;

	// Mid-run steering (SPEC §13.5, burrow-250d). Only runtimes that
	// hold stdin open *and* encode per-message stdin payloads can have
	// inbox messages delivered without waiting for the next spawn. The
	// loop below polls the messages table on a short tick, writes any
	// newly-arrived rows to the still-open stdin via the runtime's
	// encoder, and marks them delivered against this run. Failures
	// (writeStdin rejects, encoder returns undefined) leave the message
	// `unread` so the next tick or the next spawn retries.
	const midRunAbort = new AbortController();
	const midRunPollMs = input.midRunInboxPollMs ?? MID_RUN_INBOX_POLL_MS;
	const midRunSupported =
		useStdinHold &&
		typeof runtime.encodeSteeringMessage === "function" &&
		typeof proc.writeStdin === "function";
	let midRunLoop: Promise<void> = Promise.resolve();
	if (midRunSupported) {
		const writeStdin = proc.writeStdin as (chunk: string) => Promise<void>;
		midRunLoop = runMidRunSteeringLoop({
			repos,
			bus: client.bus,
			burrow,
			runId: run.id,
			runtime,
			writeStdin,
			isStdinClosed: () => stdinClosed,
			signal: midRunAbort.signal,
			intervalMs: midRunPollMs,
			onEvent: input.onEvent,
		}).catch(() => {
			// Mid-run delivery is best-effort; never fail an otherwise
			// successful run on a write or DB hiccup.
		});
	}

	const closeStdinIfNeeded = async (events: RuntimeEvent[]): Promise<void> => {
		if (stdinClosed || !useStdinHold || !proc.closeStdin) return;
		const trigger = runtime.shouldCloseStdinOnEvent;
		if (!trigger) return;
		for (const ev of events) {
			if (trigger(ev)) {
				stdinClosed = true;
				await proc.closeStdin();
				return;
			}
		}
	};

	const consumeStdout = async (): Promise<void> => {
		for await (const line of readLines(proc.stdout)) {
			if (line.length === 0) continue;
			const events = runtime.parseEvents(line, { burrow, run });
			persistEvents(events);
			await closeStdinIfNeeded(events);
		}
	};

	const consumeStderr = async (): Promise<void> => {
		for await (const line of readLines(proc.stderr)) {
			if (line.length === 0) continue;
			persistEvents([{ kind: "stderr", stream: "stderr", payload: { line } }]);
		}
	};

	let exitCode: number;
	let runtimeError: unknown;
	try {
		[exitCode] = await Promise.all([
			proc.exited,
			consumeStdout().catch((err) => {
				runtimeError = err;
			}),
			consumeStderr().catch((err) => {
				runtimeError = runtimeError ?? err;
			}),
		]);
	} finally {
		if (signal) signal.removeEventListener("abort", onAbort);
		// Stop the steering loop *before* tearing down stdin so its final
		// poll tick can't race the closeStdin defensive path below.
		midRunAbort.abort();
		await midRunLoop;
		// Bound proxy teardown to spawn lifetime — a hung CONNECT tunnel
		// can't pin the run.
		await proxy?.stop();
		// Defensive: if the child exited before the runtime emitted its
		// stdin-close trigger event, drop the dangling write side so the
		// host process doesn't keep an orphaned pipe FD. closeStdin is
		// idempotent (mx-d9b3ad).
		if (useStdinHold && !stdinClosed && proc.closeStdin) {
			stdinClosed = true;
			await proc.closeStdin().catch(() => {});
		}
	}

	if (cancelled) {
		return { state: "cancelled", exitCode, errorMessage: "cancelled via signal" };
	}
	if (runtimeError) {
		const message = runtimeError instanceof Error ? runtimeError.message : String(runtimeError);
		return { state: "failed", exitCode, errorMessage: `event stream failed: ${message}` };
	}
	if (exitCode === 0) {
		// Best-effort metadata extraction (e.g. pi session_id for resume).
		// Failures here never fail an otherwise-successful run — the next
		// run just won't have a resume token to fall back on.
		if (runtime.extractMetadata) {
			try {
				const patch = await runtime.extractMetadata({
					burrow,
					run,
					workspacePath: burrow.workspacePath,
				});
				if (patch && Object.keys(patch).length > 0) {
					repos.runs.patchMetadata(run.id, patch);
				}
			} catch {
				// swallow — extraction is advisory.
			}
		}
		return { state: "succeeded", exitCode };
	}
	return { state: "failed", exitCode, errorMessage: `agent exited with code ${exitCode}` };
}

interface MidRunSteeringInput {
	repos: Repos;
	bus: EventBus;
	burrow: Burrow;
	runId: string;
	runtime: AgentRuntime;
	writeStdin: (chunk: string) => Promise<void>;
	/** Read-only view of the dispatcher's stdinClosed latch. */
	isStdinClosed: () => boolean;
	signal: AbortSignal;
	intervalMs: number;
	onEvent?: (event: RunEvent) => void;
}

/**
 * Poll the inbox while a stdin-holding run is in flight; deliver each
 * arrived message to the agent through `writeStdin`. Marks rows
 * `delivered` *after* the write succeeds so a write failure leaves them
 * `unread` for the next tick / next spawn (parity with the recovery sweep
 * for orphaned in-flight rows — SPEC §10.2). Emits a `inbox_delivered`
 * system event so consumers tailing the run can correlate the message id
 * with the moment it reached the agent.
 */
async function runMidRunSteeringLoop(input: MidRunSteeringInput): Promise<void> {
	const encode = input.runtime.encodeSteeringMessage;
	if (!encode) return;
	const { repos, bus, burrow, runId, writeStdin, signal } = input;

	while (!signal.aborted && !input.isStdinClosed()) {
		const pending = repos.messages.listPending(burrow.id);
		for (const msg of pending) {
			if (signal.aborted || input.isStdinClosed()) return;
			const encoded = encode(msg);
			if (!encoded) continue; // runtime declined — leave row unread
			try {
				await writeStdin(encoded.stdin);
			} catch {
				// Sink closed underneath us. Leave the row unread so the
				// next run (or the post-finalize re-claim) delivers it.
				return;
			}
			repos.messages.markDelivered(msg.id, runId);
			const persisted = appendAndPublish({
				repo: repos.events,
				bus,
				burrowId: burrow.id,
				runId,
				kind: "inbox_delivered",
				stream: "system",
				payload: {
					messageId: msg.id,
					priority: msg.priority,
					mode: "mid_run",
				},
			});
			input.onEvent?.(persisted);
		}
		await sleepUntil(input.intervalMs, signal);
	}
}

function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Apply the function-form `AgentRuntime.envPassthrough` contract (burrow-6f3f)
 * to a per-spawn profile copy. Runtimes that declare a static array already
 * had their names baked into `profile.envPassthrough` at `burrow up` time;
 * function-form runtimes get re-resolved here with the run's actual
 * frontmatter so a provider override (e.g. `frontmatter.provider = "openai"`
 * for pi) folds the matching provider key into passthrough. The union is
 * deduped against the existing profile names so the static-form contribution
 * (the base set baked at up time) doesn't double-up. When the function
 * contributes no new names (static-form runtimes, identity case, base
 * already covered) the original profile is returned by reference — saves a
 * spread + array copy for the common no-override path.
 */
function applyRuntimeEnvPassthrough(
	profile: SandboxProfile,
	runtime: AgentRuntime,
	frontmatter: AgentFrontmatter | undefined,
): SandboxProfile {
	const passthrough = runtime.envPassthrough;
	if (typeof passthrough !== "function") return profile;
	const resolved = passthrough({ ...(frontmatter ? { frontmatter } : {}) });
	if (resolved.length === 0) return profile;
	const existing = new Set(profile.envPassthrough);
	const additions: string[] = [];
	for (const name of resolved) {
		if (name.length === 0 || existing.has(name)) continue;
		existing.add(name);
		additions.push(name);
	}
	if (additions.length === 0) return profile;
	return { ...profile, envPassthrough: [...profile.envPassthrough, ...additions] };
}

/**
 * Pull `frontmatter.{provider,model}` off `Run.metadataJson` if an upstream
 * caller (e.g. warren) stored it there (burrow-b5b4). Strings only; other
 * shapes are dropped silently. Returns `undefined` when no usable fields
 * remain so the dispatcher can omit the field from `SpawnContext` rather
 * than passing an empty object that just adds noise.
 */
function readFrontmatter(metadata: unknown): AgentFrontmatter | undefined {
	if (metadata === null || typeof metadata !== "object") return undefined;
	const raw = (metadata as Record<string, unknown>).frontmatter;
	if (raw === null || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const out: AgentFrontmatter = {};
	if (typeof obj.provider === "string") out.provider = obj.provider;
	if (typeof obj.model === "string") out.model = obj.model;
	return Object.keys(out).length > 0 ? out : undefined;
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string, void, void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx = buf.indexOf("\n");
			while (idx !== -1) {
				yield buf.slice(0, idx);
				buf = buf.slice(idx + 1);
				idx = buf.indexOf("\n");
			}
		}
		buf += decoder.decode();
		if (buf.length > 0) yield buf;
	} finally {
		reader.releaseLock();
	}
}
