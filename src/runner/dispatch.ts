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

import type { Run, RunEvent } from "../core/types.ts";
import { appendAndPublish } from "../events/publish.ts";
import type { Client } from "../lib/client.ts";
import { runSandboxed } from "../provider/local/sandbox.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../provider/types.ts";
import { type ProxyHandle, type StartProxyOptions, startProxy } from "../proxy/server.ts";
import { composeCodexPrompt, writeCodexPromptFile } from "../runtime/codex.ts";
import type { AgentRuntime, InstallCheckResult, RuntimeEvent } from "../runtime/runtime.ts";
import type { RunOutcome } from "./run-loop.ts";

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

	const command = runtime.buildSpawnCommand({
		burrow,
		run,
		prompt: run.prompt,
		pendingMessages,
		envResolved: profile.setEnv ?? {},
		workspacePath: burrow.workspacePath,
	});

	const spawn = input.spawn ?? runSandboxed;
	const startProxyFn = input.startProxy ?? startProxy;

	const useStdinHold = runtime.shouldCloseStdinOnEvent !== undefined;

	let proxy: ProxyHandle | null = null;
	let runProfile: SandboxProfile = profile;
	let runCommand: SpawnCommand = useStdinHold ? { ...command, holdStdin: true } : command;
	if (profile.network === "restricted") {
		try {
			proxy = await startProxyFn({ allowedDomains: profile.allowedDomains });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { state: "failed", errorMessage: `failed to start network proxy: ${message}` };
		}
		runProfile = { ...profile, proxyAddress: { host: "127.0.0.1", port: proxy.port } };
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
