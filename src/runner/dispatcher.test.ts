/**
 * `RunDispatcher` integration tests — exercises the wiring that closes
 * `burrow-7b97`: HTTP-enqueued runs (the `client.runs.create` path) flow
 * into the in-process executor instead of sitting at `state=queued`
 * forever.
 *
 * Tests stub spawn + installCheck so they don't shell out to the host.
 * Real Client + repos so the queue / claim / finalize transitions are
 * exercised against actual SQLite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BurrowRow } from "../db/schema.ts";
import { Client } from "../lib/client.ts";
import { createLogger } from "../logging/logger.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../provider/types.ts";
import { parsePiEvents } from "../runtime/parsers/pi.ts";
import { PI_DEFAULT_MODEL, PI_FORCED_ARGV, PI_SESSION_DIR, piRuntime } from "../runtime/pi.ts";
import type { AgentRuntime } from "../runtime/runtime.ts";
import type { SpawnFn } from "./dispatch.ts";
import { startRunDispatcher } from "./dispatcher.ts";

const silentLogger = createLogger({ level: "fatal" });

interface CollectedSpawn {
	profile: SandboxProfile;
	command: SpawnCommand;
}

interface FakeSpawnOpts {
	stdoutLines?: string[];
	exitCode?: number;
	calls?: CollectedSpawn[];
}

function fakeSpawn(opts: FakeSpawnOpts = {}): SpawnFn {
	return async (profile, command) => {
		opts.calls?.push({ profile, command });
		const encoder = new TextEncoder();
		const blob = (opts.stdoutLines ?? []).map((l) => `${l}\n`).join("");
		const stdout = new ReadableStream<Uint8Array>({
			start(controller) {
				if (blob.length > 0) controller.enqueue(encoder.encode(blob));
				controller.close();
			},
		});
		const stderr = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
		let resolveExit!: (n: number) => void;
		const exited = new Promise<number>((r) => {
			resolveExit = r;
		});
		const result: SpawnResult = {
			pid: 1234,
			stdout,
			stderr,
			exited,
			cancel: () => resolveExit(130),
		};
		queueMicrotask(() => resolveExit(opts.exitCode ?? 0));
		return result;
	};
}

function fakeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
	return {
		id: "fake",
		displayName: "Fake",
		supportsResume: false,
		buildSpawnCommand: () => ({ argv: ["fake"] }),
		parseEvents: (line) => [{ kind: "text", stream: "stdout", payload: { text: line } }],
		installCheck: async () => ({ installed: true }),
		...overrides,
	};
}

function seedActiveBurrow(client: Client, workspacePath = "/ws"): BurrowRow {
	const profile: SandboxProfile = {
		workspace: workspacePath,
		readOnlyMounts: [],
		network: "none",
		allowedDomains: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: [],
	};
	return client.repos.burrows.create({
		kind: "project",
		projectRoot: "/repo",
		workspacePath,
		branch: "main",
		provider: "local",
		profile,
	});
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("waitFor timed out");
		}
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe("startRunDispatcher", () => {
	let dataDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-dispatcher-"));
		client = await Client.open({ dataDir, configDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("client.runs.create after start() drives the run to terminal", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ stdoutLines: ["hello"] }),
		});
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "fake",
			prompt: "p",
		});

		// Synchronously after create the loop has only just been notified;
		// the row is still queued. Wait for the loop to transition it.
		await waitFor(() => client.runs.get(run.id).state === "succeeded");
		await dispatcher.stop();

		const finalized = client.runs.get(run.id);
		expect(finalized.state).toBe("succeeded");
		expect(finalized.exitCode).toBe(0);
		expect(finalized.startedAt).not.toBeNull();
		expect(finalized.completedAt).not.toBeNull();
	});

	test("startup recovery sweeps stale running rows from a prior process", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());

		// Simulate a crashed previous process: enqueue then mark running
		// without finalizing.
		const stuck = client.repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "fake",
			prompt: "stuck",
		});
		client.repos.runs.markRunning(stuck.id);
		expect(client.repos.runs.require(stuck.id).state).toBe("running");

		const dispatcher = startRunDispatcher(client, { logger: silentLogger, spawn: fakeSpawn() });
		const { recovered } = dispatcher.start();
		await dispatcher.stop();

		expect(recovered.failedRunIds).toEqual([stuck.id]);
		expect(client.repos.runs.require(stuck.id).state).toBe("failed");
	});

	test("queued rows already in the DB at start() are picked up", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());

		// Pre-existing queued run (e.g. enqueued by an earlier process or
		// by the library directly before the dispatcher was wired).
		const pre = client.repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "fake",
			prompt: "pre",
		});
		expect(client.repos.runs.require(pre.id).state).toBe("queued");

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ stdoutLines: ["ok"] }),
		});
		dispatcher.start();
		await waitFor(() => client.runs.get(pre.id).state === "succeeded");
		await dispatcher.stop();

		expect(client.runs.get(pre.id).state).toBe("succeeded");
	});

	test("stop() unhooks the create callback so library callers don't dangle", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());

		const dispatcher = startRunDispatcher(client, { logger: silentLogger, spawn: fakeSpawn() });
		dispatcher.start();
		await dispatcher.stop();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "fake",
			prompt: "after-stop",
		});
		// Loop is stopped — row should stay queued.
		await new Promise((r) => setTimeout(r, 30));
		expect(client.runs.get(run.id).state).toBe("queued");
	});

	test("agent not registered → run finalizes failed with a clear error", async () => {
		const burrow = seedActiveBurrow(client);
		// Note: agent NOT registered.

		const dispatcher = startRunDispatcher(client, { logger: silentLogger, spawn: fakeSpawn() });
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "ghost",
			prompt: "p",
		});
		await waitFor(() => client.runs.get(run.id).state === "failed");
		await dispatcher.stop();

		const finalized = client.runs.get(run.id);
		expect(finalized.state).toBe("failed");
		expect(finalized.errorMessage).toContain("ghost");
		expect(finalized.errorMessage).toContain("not registered");
	});

	test("stopped burrow → enqueued run finalizes failed without spawning", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());
		client.repos.burrows.markStopped(burrow.id);

		const calls: CollectedSpawn[] = [];
		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ calls }),
		});
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "fake",
			prompt: "p",
		});
		await waitFor(() => client.runs.get(run.id).state === "failed");
		await dispatcher.stop();

		expect(calls).toHaveLength(0);
		expect(client.runs.get(run.id).errorMessage).toContain("stopped");
	});

	test("isIdle is true once all enqueued runs have finalized", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ stdoutLines: ["ok"] }),
		});
		dispatcher.start();

		client.runs.create({ burrowId: burrow.id, agentId: "fake", prompt: "1" });
		client.runs.create({ burrowId: burrow.id, agentId: "fake", prompt: "2" });

		await waitFor(() => dispatcher.isIdle());
		await dispatcher.stop();
	});
});

// piRuntime end-to-end via golden fixtures (burrow-56bb / pl-5198 step 5).
//
// Drives a full enqueue → claim → spawn → parse → persist roundtrip with the
// REAL `piRuntime` registered and the captured `pi --mode rpc` stdout
// (src/runtime/parsers/__golden__/) replayed via `fakeSpawn`. The parser
// tests in src/runtime/parsers/pi.test.ts already cover envelope-by-envelope
// kind mapping; this layer asserts the dispatcher pipeline itself —
// argv contract, single RPC prompt line on stdin, every parser-emitted event
// reaches the events table in order, and the run finalizes succeeded.
//
// Note (burrow-5db3): real pi v0.74.0 exits the instant stdin closes
// (mx-d9b3ad), so end-to-end runs against the actual binary need the
// dispatcher stdin-hold contract before they produce assistant content.
// That hazard is orthogonal to this test — fakeSpawn streams the captured
// stdout regardless of stdin lifecycle, so the dispatcher pipeline is
// exercised against the same trace pi would emit if stdin-hold were wired.
const GOLDEN_DIR = join(import.meta.dir, "..", "runtime", "parsers", "__golden__");

function readFixtureLines(name: string): string[] {
	return readFileSync(join(GOLDEN_DIR, name), "utf8")
		.split("\n")
		.filter((l) => l.length > 0);
}

describe("startRunDispatcher · piRuntime end-to-end (golden fixtures)", () => {
	let dataDir: string;
	let workspaceDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-dispatcher-pi-"));
		// Real workspace dir so piRuntime.prepareWorkspace (creates
		// .pi/sessions/) and .extractMetadata (reads from it) have a host
		// filesystem to work against. The fakeSpawn replaces the actual
		// pi binary, but the per-burrow workspace must exist for the
		// dispatcher's pre/post-spawn hooks.
		workspaceDir = mkdtempSync(join(tmpdir(), "burrow-dispatcher-pi-ws-"));
		client = await Client.open({ dataDir, configDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(workspaceDir, { recursive: true, force: true });
	});

	test("success fixture: argv pinned, RPC prompt on stdin, every parser event persisted", async () => {
		const burrow = seedActiveBurrow(client, workspaceDir);
		client.agents.register(piRuntime);

		const lines = readFixtureLines("pi-v0.74.0-anthropic-success.jsonl");
		const calls: CollectedSpawn[] = [];

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ stdoutLines: lines, calls }),
			installCheck: async () => ({ installed: true, version: "0.74.0", path: "/usr/local/bin/pi" }),
		});
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "pi",
			prompt: "Reply with exactly the single word: ack.",
		});
		await waitFor(() => client.runs.get(run.id).state === "succeeded");
		await dispatcher.stop();

		// Run finalized cleanly.
		const finalized = client.runs.get(run.id);
		expect(finalized.state).toBe("succeeded");
		expect(finalized.exitCode).toBe(0);
		expect(finalized.errorMessage).toBeNull();

		// Spawn contract: forced argv prefix + pinned model, RPC prompt line on stdin.
		expect(calls).toHaveLength(1);
		const command = calls[0]?.command;
		expect(command).toBeDefined();
		const argv = command?.argv ?? [];
		expect(argv.slice(0, PI_FORCED_ARGV.length)).toEqual([...PI_FORCED_ARGV]);
		const modelIdx = argv.indexOf("--model");
		expect(modelIdx).toBeGreaterThan(-1);
		expect(argv[modelIdx + 1]).toBe(PI_DEFAULT_MODEL);
		expect(typeof command?.stdin).toBe("string");
		expect(JSON.parse(command?.stdin as string)).toEqual({
			type: "prompt",
			message: "Reply with exactly the single word: ack.",
		});

		// Pipeline fidelity: every parser-emitted event landed in the table,
		// in fixture order, scoped to this run.
		const expected = lines.flatMap(parsePiEvents);
		const persisted = client.repos.events
			.listByBurrow(burrow.id)
			.filter((row) => row.runId === run.id);
		expect(persisted.map((r) => r.kind)).toEqual(expected.map((e) => e.kind));
		expect(persisted.map((r) => r.stream)).toEqual(expected.map((e) => e.stream));

		// Spot-check the high-value content: the assistant 'ack' text reaches
		// the events table verbatim.
		const textEvents = persisted.filter((r) => r.kind === "text");
		expect(textEvents.length).toBeGreaterThanOrEqual(1);
		expect(textEvents.at(-1)?.payloadJson).toEqual({ text: "ack" });

		// Thinking block survives the pipeline (non-empty, so not dropped).
		const thinking = persisted.filter((r) => r.kind === "thinking");
		expect(thinking.length).toBeGreaterThanOrEqual(1);

		// agent_end lifecycle envelope persisted as state_change/system.
		const agentEnd = persisted.find((r) => {
			if (r.kind !== "state_change") return false;
			const payload = r.payloadJson as { type?: string } | null;
			return payload?.type === "agent_end";
		});
		expect(agentEnd).toBeDefined();
	});

	test("tools fixture: tool_use + tool_result events flow through dispatcher", async () => {
		const burrow = seedActiveBurrow(client, workspaceDir);
		client.agents.register(piRuntime);

		const lines = readFixtureLines("pi-v0.74.0-anthropic-tools.jsonl");

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ stdoutLines: lines }),
			installCheck: async () => ({ installed: true, version: "0.74.0", path: "/usr/local/bin/pi" }),
		});
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "pi",
			prompt: "List the files and stop.",
		});
		await waitFor(() => client.runs.get(run.id).state === "succeeded");
		await dispatcher.stop();

		expect(client.runs.get(run.id).state).toBe("succeeded");

		const persisted = client.repos.events
			.listByBurrow(burrow.id)
			.filter((row) => row.runId === run.id);

		// Whole-pipeline fidelity vs. the parser as source-of-truth.
		const expected = lines.flatMap(parsePiEvents);
		expect(persisted.map((r) => r.kind)).toEqual(expected.map((e) => e.kind));

		// tool_use carries the camelCase pi block verbatim — name + arguments
		// must reach the events table for downstream consumers (greenhouse,
		// warren UI) to render the tool invocation.
		const toolUses = persisted.filter((r) => r.kind === "tool_use");
		expect(toolUses.length).toBeGreaterThanOrEqual(1);
		expect(toolUses[0]?.payloadJson).toMatchObject({
			type: "toolCall",
			name: "ls",
		});

		// tool_result mapped from the role=toolResult message_end, on the
		// stdout stream (matching claude-code's tool_result placement).
		const toolResults = persisted.filter((r) => r.kind === "tool_result");
		expect(toolResults.length).toBeGreaterThanOrEqual(1);
		expect(toolResults[0]?.stream).toBe("stdout");
		expect(toolResults[0]?.payloadJson).toMatchObject({
			role: "toolResult",
			toolName: "ls",
		});

		// tool_execution_start/end land on system as state_change (lossy
		// collapse — full envelope preserved in payload).
		const execStart = persisted.find((r) => {
			if (r.kind !== "state_change") return false;
			const payload = r.payloadJson as { type?: string } | null;
			return payload?.type === "tool_execution_start";
		});
		expect(execStart).toBeDefined();
	});

	test("post-spawn extractMetadata writes session_id to Run.metadataJson (burrow-4d8b)", async () => {
		const burrow = seedActiveBurrow(client, workspaceDir);
		client.agents.register(piRuntime);

		// Simulate the on-disk shape pi v0.74.0 produces during a run: a
		// `<ts>_<uuid>.jsonl` whose first line is the canonical session
		// envelope. The dispatcher's extractMetadata hook reads this file
		// after spawn exits and patches the run row.
		const sessionDir = join(workspaceDir, PI_SESSION_DIR);
		await mkdir(sessionDir, { recursive: true });
		const sessionId = "019e220f-5d8c-768e-bef3-bb1d6c9a2921";
		writeFileSync(
			join(sessionDir, `2026-05-13T15-58-12-877Z_${sessionId}.jsonl`),
			`${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`,
		);

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ stdoutLines: [] }),
			installCheck: async () => ({ installed: true, version: "0.74.0", path: "/usr/local/bin/pi" }),
		});
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "pi",
			prompt: "Reply with exactly the single word: ack.",
		});
		await waitFor(() => client.runs.get(run.id).state === "succeeded");
		await dispatcher.stop();

		const finalized = client.runs.get(run.id);
		expect(finalized.metadataJson).toEqual({ session_id: sessionId });
	});

	test("resume run: buildResumeCommand pins --session <id> from prior run metadata", async () => {
		const burrow = seedActiveBurrow(client, workspaceDir);
		client.agents.register(piRuntime);

		// Prime a "prior" succeeded run carrying a session id, then dispatch
		// a follow-up run via buildResumeCommand directly. The dispatcher
		// itself doesn't yet auto-route to resume on the spawn path
		// (separate scope) — what we assert here is that the runtime
		// surfaces the right argv shape when given the prior run.
		const priorRun = client.repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "pi",
			prompt: "p1",
		});
		client.repos.runs.markRunning(priorRun.id);
		client.repos.runs.patchMetadata(priorRun.id, {
			session_id: "019e220f-5d8c-768e-bef3-bb1d6c9a2921",
		});
		client.repos.runs.finalize(priorRun.id, { state: "succeeded", exitCode: 0 });

		const updated = client.repos.runs.require(priorRun.id);
		expect(updated.metadataJson).toEqual({
			session_id: "019e220f-5d8c-768e-bef3-bb1d6c9a2921",
		});

		const resumeCmd = piRuntime.buildResumeCommand?.({
			burrow,
			run: { ...updated, id: "run_next", state: "queued" },
			priorRun: updated,
			prompt: "p2",
			pendingMessages: [],
			envResolved: {},
			workspacePath: workspaceDir,
		});
		const sessionIdx = resumeCmd?.argv.indexOf("--session") ?? -1;
		expect(sessionIdx).toBeGreaterThan(-1);
		expect(resumeCmd?.argv[sessionIdx + 1]).toBe("019e220f-5d8c-768e-bef3-bb1d6c9a2921");
		// session-dir stays pinned so the new run reads from the same per-burrow
		// storage the prior run wrote into.
		const sessionDirIdx = resumeCmd?.argv.indexOf("--session-dir") ?? -1;
		expect(sessionDirIdx).toBeGreaterThan(-1);
		expect(resumeCmd?.argv[sessionDirIdx + 1]).toBe(PI_SESSION_DIR);
		// Argv is consistent with the locked spawn prefix so the regression
		// guard in pi.test.ts and this e2e check stay aligned.
		expect(resumeCmd?.argv.slice(0, PI_FORCED_ARGV.length)).toEqual([...PI_FORCED_ARGV]);
		// Pinned model is still present on resume — bumping the resume
		// model independently of spawn would split fixtures.
		const modelIdx = resumeCmd?.argv.indexOf("--model") ?? -1;
		expect(modelIdx).toBeGreaterThan(-1);
		expect(resumeCmd?.argv[modelIdx + 1]).toBe(PI_DEFAULT_MODEL);
	});
});

// stdin-hold contract for runtimes that exit on stdin EOF mid-inference
// (burrow-5db3, mx-d9b3ad). The dispatcher must propagate `holdStdin` on the
// spawn command and call `SpawnResult.closeStdin()` only after the runtime's
// shouldCloseStdinOnEvent predicate matches a persisted event.
describe("startRunDispatcher · stdin-hold contract (burrow-5db3)", () => {
	let dataDir: string;
	let workspaceDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-dispatcher-stdin-"));
		workspaceDir = mkdtempSync(join(tmpdir(), "burrow-dispatcher-stdin-ws-"));
		client = await Client.open({ dataDir, configDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(workspaceDir, { recursive: true, force: true });
	});

	interface StdinSpawnCapture {
		holdStdin?: boolean;
		closeStdinCalls: number;
		closeStdinCalledBeforeExit: boolean;
	}

	// Spawn fake that withholds process exit until `closeStdin` is invoked.
	// Mirrors pi v0.74.0's "stdin EOF → process exit" semantics so the
	// dispatcher's close-on-trigger path is exercised end-to-end against
	// scripted stdout.
	function holdingSpawn(stdoutLines: string[], capture: StdinSpawnCapture): SpawnFn {
		return async (_profile, command) => {
			capture.holdStdin = command.holdStdin;
			const encoder = new TextEncoder();
			const blob = stdoutLines.map((l) => `${l}\n`).join("");
			const stdout = new ReadableStream<Uint8Array>({
				start(controller) {
					if (blob.length > 0) controller.enqueue(encoder.encode(blob));
					controller.close();
				},
			});
			const stderr = new ReadableStream<Uint8Array>({
				start(c) {
					c.close();
				},
			});
			let resolveExit!: (n: number) => void;
			const exited = new Promise<number>((r) => {
				resolveExit = r;
			});
			let exited_ = false;
			const closeStdin = async (): Promise<void> => {
				capture.closeStdinCalls += 1;
				if (capture.closeStdinCalls === 1) {
					capture.closeStdinCalledBeforeExit = !exited_;
				}
				exited_ = true;
				resolveExit(0);
			};
			return {
				pid: 4242,
				stdout,
				stderr,
				exited,
				cancel: () => {
					exited_ = true;
					resolveExit(130);
				},
				closeStdin,
			};
		};
	}

	test("piRuntime: holdStdin propagates to spawn and stdin closes on agent_end", async () => {
		const burrow = seedActiveBurrow(client, workspaceDir);
		client.agents.register(piRuntime);

		// Minimal pi trace: ack + lifecycle envelopes through agent_end.
		// The trigger predicate fires on agent_end and only then does the
		// fake spawn resolve the process exit. If holdStdin weren't wired,
		// the fake would hang forever (closeStdin never invoked → exit
		// promise never resolves → test times out).
		const trace = [
			JSON.stringify({ type: "response", command: "prompt", success: true }),
			JSON.stringify({ type: "agent_start" }),
			JSON.stringify({ type: "turn_start" }),
			JSON.stringify({ type: "agent_end" }),
		];
		const capture: StdinSpawnCapture = {
			closeStdinCalls: 0,
			closeStdinCalledBeforeExit: false,
		};

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: holdingSpawn(trace, capture),
			installCheck: async () => ({ installed: true, version: "0.74.0", path: "/usr/local/bin/pi" }),
		});
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "pi",
			prompt: "Reply with: ack.",
		});
		await waitFor(() => client.runs.get(run.id).state === "succeeded", 2000);
		await dispatcher.stop();

		expect(capture.holdStdin).toBe(true);
		expect(capture.closeStdinCalls).toBe(1);
		expect(capture.closeStdinCalledBeforeExit).toBe(true);
	});

	test("non-holdStdin runtime: holdStdin not set; closeStdin never called", async () => {
		const burrow = seedActiveBurrow(client);
		// fakeRuntime declares no shouldCloseStdinOnEvent — the dispatcher
		// must leave the existing write-and-close-at-spawn semantics in
		// place (i.e. no holdStdin flag, no closeStdin invocation).
		client.agents.register(fakeRuntime());
		const capture: StdinSpawnCapture = {
			closeStdinCalls: 0,
			closeStdinCalledBeforeExit: false,
		};

		// Non-holding spawn: resolves exit immediately so consumeStdout
		// finishes naturally. closeStdin is exposed but should never be
		// invoked by the dispatcher when the runtime doesn't opt in.
		const spawnFn: SpawnFn = async (_profile, command) => {
			capture.holdStdin = command.holdStdin;
			const encoder = new TextEncoder();
			const stdout = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(encoder.encode("hello\n"));
					c.close();
				},
			});
			const stderr = new ReadableStream<Uint8Array>({
				start(c) {
					c.close();
				},
			});
			let resolveExit!: (n: number) => void;
			const exited = new Promise<number>((r) => {
				resolveExit = r;
			});
			queueMicrotask(() => resolveExit(0));
			return {
				pid: 4243,
				stdout,
				stderr,
				exited,
				cancel: () => resolveExit(130),
				closeStdin: async () => {
					capture.closeStdinCalls += 1;
				},
			};
		};

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: spawnFn,
		});
		dispatcher.start();
		const run = client.runs.create({ burrowId: burrow.id, agentId: "fake", prompt: "p" });
		await waitFor(() => client.runs.get(run.id).state === "succeeded");
		await dispatcher.stop();

		expect(capture.holdStdin).toBeUndefined();
		expect(capture.closeStdinCalls).toBe(0);
	});

	test("holdStdin runtime without trigger event: stdin closed defensively in finally", async () => {
		const burrow = seedActiveBurrow(client);
		// Runtime opts into stdin-hold but the predicate never matches the
		// scripted stdout. The dispatcher must still close stdin in its
		// finally block once the child exits — otherwise the parent leaks
		// an orphaned write FD on every "agent died without emitting its
		// terminal envelope" run.
		const runtime = fakeRuntime({
			id: "holdy",
			shouldCloseStdinOnEvent: () => false,
		});
		client.agents.register(runtime);
		const capture: StdinSpawnCapture = {
			closeStdinCalls: 0,
			closeStdinCalledBeforeExit: false,
		};

		const spawnFn: SpawnFn = async (_profile, command) => {
			capture.holdStdin = command.holdStdin;
			const encoder = new TextEncoder();
			const stdout = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(encoder.encode("line\n"));
					c.close();
				},
			});
			const stderr = new ReadableStream<Uint8Array>({
				start(c) {
					c.close();
				},
			});
			let resolveExit!: (n: number) => void;
			const exited = new Promise<number>((r) => {
				resolveExit = r;
			});
			// Child exits independently of stdin lifecycle here — the
			// agent crashed / completed without emitting its stdin-close
			// trigger. Dispatcher must still drop the dangling FD.
			queueMicrotask(() => resolveExit(0));
			return {
				pid: 4244,
				stdout,
				stderr,
				exited,
				cancel: () => resolveExit(130),
				closeStdin: async () => {
					capture.closeStdinCalls += 1;
				},
			};
		};

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: spawnFn,
		});
		dispatcher.start();
		const run = client.runs.create({ burrowId: burrow.id, agentId: "holdy", prompt: "p" });
		await waitFor(() => client.runs.get(run.id).state === "succeeded");
		await dispatcher.stop();

		expect(capture.holdStdin).toBe(true);
		expect(capture.closeStdinCalls).toBe(1);
	});
});
