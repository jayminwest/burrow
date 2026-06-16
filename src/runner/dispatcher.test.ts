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

	test("drain controller starts off and round-trips set/get (burrow-79ad)", async () => {
		const dispatcher = startRunDispatcher(client, { logger: silentLogger, spawn: fakeSpawn() });
		dispatcher.start();
		try {
			expect(dispatcher.drain.isDraining()).toBe(false);
			dispatcher.drain.setDrain(true);
			expect(dispatcher.drain.isDraining()).toBe(true);
			dispatcher.drain.setDrain(false);
			expect(dispatcher.drain.isDraining()).toBe(false);
		} finally {
			await dispatcher.stop();
		}
	});

	test("drain set mid-flight does not stop the dispatcher from draining in-flight runs (burrow-79ad)", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ stdoutLines: ["ok"] }),
		});
		dispatcher.start();
		// The drain bit gates HTTP-layer creation; the dispatcher itself
		// keeps executing whatever has already been enqueued. Verify a run
		// inserted *after* drain is set still finalizes when enqueued via
		// the library API (the gate only sits on the HTTP createRun path).
		dispatcher.drain.setDrain(true);
		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "fake",
			prompt: "p",
		});
		await waitFor(() => client.runs.get(run.id).state === "succeeded");
		await dispatcher.stop();
		expect(client.runs.get(run.id).state).toBe("succeeded");
	});

	test("destroy drains an in-flight run before pruning (burrow-4855)", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());
		// Don't touch the real worktree; we only care about the run drain.
		client.burrows.setDestroyOverrides({ removeWorkspace: async () => {} });

		let cancelled = false;
		let started = false;
		// A spawn that blocks until cancelled — models a long-running agent.
		const blockingSpawn: SpawnFn = async () => {
			started = true;
			let resolveExit!: (n: number) => void;
			const exited = new Promise<number>((r) => {
				resolveExit = r;
			});
			const empty = new ReadableStream<Uint8Array>({
				start(c) {
					c.close();
				},
			});
			return {
				pid: 999,
				stdout: empty,
				stderr: new ReadableStream<Uint8Array>({
					start(c) {
						c.close();
					},
				}),
				exited,
				cancel: () => {
					cancelled = true;
					resolveExit(130);
				},
			};
		};

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: blockingSpawn,
		});
		dispatcher.start();

		const run = client.runs.create({ burrowId: burrow.id, agentId: "fake", prompt: "p" });
		await waitFor(() => started && client.runs.get(run.id).state === "running");

		// Destroy must wait for the in-flight run to drain (abort → cancel)
		// before pruning, and must not throw "run not found".
		const result = await client.burrows.destroy(burrow.id, { archive: false });

		expect(cancelled).toBe(true);
		expect(result.burrowId).toBe(burrow.id);
		expect(client.burrows.tryGet(burrow.id)?.state).toBe("destroyed");
		// The run row was pruned as part of destroy.
		expect(client.runs.tryGet(run.id)).toBeNull();
		expect(dispatcher.isIdle()).toBe(true);

		await dispatcher.stop();
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

// Resume routing + eligibility validation (burrow-c386 / pl-a456 step 3).
//
// When a run carries `resumeOfRunId`, the dispatcher validates the resume
// is actually possible before doing any work, then routes the spawn through
// `buildResumeCommand(priorRun)` instead of `buildSpawnCommand`. Each failure
// mode collapses to a structured `failed` outcome (never a throw) so the run
// loop surfaces the reason instead of a generic crash.
describe("startRunDispatcher · resume routing (burrow-c386)", () => {
	let dataDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-dispatcher-resume-"));
		client = await Client.open({ dataDir, configDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	function seedTerminalRun(burrowId: string, agentId = "fake"): string {
		const prior = client.repos.runs.enqueue({ burrowId, agentId, prompt: "prior" });
		client.repos.runs.markRunning(prior.id);
		client.repos.runs.finalize(prior.id, { state: "succeeded", exitCode: 0 });
		return prior.id;
	}

	test("happy path: resume run routes to buildResumeCommand with priorRun", async () => {
		const burrow = seedActiveBurrow(client);
		let resumePriorId: string | undefined;
		let spawnCalled = false;
		client.agents.register(
			fakeRuntime({
				supportsResume: true,
				buildSpawnCommand: () => {
					spawnCalled = true;
					return { argv: ["fake-spawn"] };
				},
				buildResumeCommand: (ctx) => {
					resumePriorId = ctx.priorRun.id;
					return { argv: ["fake-resume"] };
				},
			}),
		);
		const priorId = seedTerminalRun(burrow.id);

		const calls: CollectedSpawn[] = [];
		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ calls, stdoutLines: ["ok"] }),
		});
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "fake",
			prompt: "resume me",
			resumeOfRunId: priorId,
		});
		await waitFor(() => client.runs.get(run.id).state === "succeeded");
		await dispatcher.stop();

		expect(resumePriorId).toBe(priorId);
		expect(spawnCalled).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.command.argv).toEqual(["fake-resume"]);
	});

	test("agent without buildResumeCommand → failed (does not support resume)", async () => {
		const burrow = seedActiveBurrow(client);
		// fakeRuntime() has no buildResumeCommand.
		client.agents.register(fakeRuntime());
		const priorId = seedTerminalRun(burrow.id);

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
			resumeOfRunId: priorId,
		});
		await waitFor(() => client.runs.get(run.id).state === "failed");
		await dispatcher.stop();

		expect(calls).toHaveLength(0);
		expect(client.runs.get(run.id).errorMessage).toContain("does not support resume");
	});

	test("missing prior run → failed (resume target does not exist)", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime({ buildResumeCommand: () => ({ argv: ["r"] }) }));

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
			resumeOfRunId: "run_ghost",
		});
		await waitFor(() => client.runs.get(run.id).state === "failed");
		await dispatcher.stop();

		expect(calls).toHaveLength(0);
		const msg = client.runs.get(run.id).errorMessage ?? "";
		expect(msg).toContain("run_ghost");
		expect(msg).toContain("does not exist");
	});

	test("prior run in another burrow → failed (cross-burrow resume rejected)", async () => {
		const burrowA = seedActiveBurrow(client, "/ws-a");
		const burrowB = seedActiveBurrow(client, "/ws-b");
		client.agents.register(fakeRuntime({ buildResumeCommand: () => ({ argv: ["r"] }) }));
		const priorInB = seedTerminalRun(burrowB.id);

		const calls: CollectedSpawn[] = [];
		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ calls }),
		});
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrowA.id,
			agentId: "fake",
			prompt: "p",
			resumeOfRunId: priorInB,
		});
		await waitFor(() => client.runs.get(run.id).state === "failed");
		await dispatcher.stop();

		expect(calls).toHaveLength(0);
		expect(client.runs.get(run.id).errorMessage).toContain(burrowB.id);
	});

	test("prior run not yet terminal → failed (non-terminal state rejected)", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime({ buildResumeCommand: () => ({ argv: ["r"] }) }));

		const calls: CollectedSpawn[] = [];
		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ calls }),
		});
		// Start before seeding the running prior so the startup recovery
		// sweep (which fails stale running rows) can't move it to terminal.
		dispatcher.start();

		// Prior run left in `running` state (no finalize).
		const prior = client.repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "fake",
			prompt: "prior",
		});
		client.repos.runs.markRunning(prior.id);

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "fake",
			prompt: "p",
			resumeOfRunId: prior.id,
		});
		await waitFor(() => client.runs.get(run.id).state === "failed");
		await dispatcher.stop();

		expect(calls).toHaveLength(0);
		const msg = client.runs.get(run.id).errorMessage ?? "";
		expect(msg).toContain("non-terminal");
		expect(msg).toContain("running");
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

	test("function-form envPassthrough resolves per-run frontmatter (burrow-6f3f)", async () => {
		// Warren's multi-provider override path (warren-fe96) stores
		// `frontmatter.provider` on `Run.metadataJson`. The dispatcher must
		// re-invoke pi's function-form envPassthrough with that frontmatter
		// and union the matching provider key onto the per-spawn profile —
		// otherwise the sandbox never sees `OPENAI_API_KEY` (or the gemini /
		// groq / mistral / deepseek equivalents) and pi's first API call
		// fails on auth.
		const burrow = seedActiveBurrow(client, workspaceDir);
		client.agents.register(piRuntime);
		const calls: CollectedSpawn[] = [];

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ stdoutLines: [], calls }),
			installCheck: async () => ({ installed: true, version: "0.74.0", path: "/usr/local/bin/pi" }),
		});
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "pi",
			prompt: "p",
			metadata: { frontmatter: { provider: "openai", model: "gpt-4o" } },
		});
		await waitFor(() => client.runs.get(run.id).state === "succeeded");
		await dispatcher.stop();

		expect(calls).toHaveLength(1);
		const passthrough = calls[0]?.profile.envPassthrough ?? [];
		// OPENAI_API_KEY is the per-run delta — without dispatch-time
		// augmentation it would never reach the sandbox.
		expect(passthrough).toContain("OPENAI_API_KEY");
		// Anthropic base stays available too so a follow-up run that flips
		// back to anthropic doesn't have to recreate the burrow.
		expect(passthrough).toContain("ANTHROPIC_API_KEY");
		expect(passthrough).toContain("ANTHROPIC_AUTH_TOKEN");
		expect(passthrough).toContain("ANTHROPIC_BASE_URL");
		// Other providers' keys MUST NOT leak when only openai was selected.
		for (const leak of ["GEMINI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY"]) {
			expect(passthrough).not.toContain(leak);
		}
	});

	test("frontmatter.pi options reach pi argv through run metadata", async () => {
		const burrow = seedActiveBurrow(client, workspaceDir);
		client.agents.register(piRuntime);
		const calls: CollectedSpawn[] = [];

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ stdoutLines: [], calls }),
			installCheck: async () => ({ installed: true, version: "0.78.1", path: "/usr/local/bin/pi" }),
		});
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "pi",
			prompt: "p",
			metadata: {
				frontmatter: {
					provider: "openai",
					model: "gpt-4o",
					pi: {
						extensions: true,
						approve: true,
						tools: ["read", "my_extension_tool"],
					},
				},
			},
		});
		await waitFor(() => client.runs.get(run.id).state === "succeeded");
		await dispatcher.stop();

		expect(calls).toHaveLength(1);
		const argv = calls[0]?.command.argv ?? [];
		expect(argv).not.toContain("--no-extensions");
		expect(argv).toContain("--approve");
		const toolsIdx = argv.indexOf("--tools");
		expect(argv[toolsIdx + 1]).toBe("read,my_extension_tool");
		const providerIdx = argv.indexOf("--provider");
		expect(argv[providerIdx + 1]).toBe("openai");
		const modelIdx = argv.indexOf("--model");
		expect(argv[modelIdx + 1]).toBe("gpt-4o");
	});

	test("frontmatter.pi drops unknown and invalid values before argv rendering", async () => {
		const burrow = seedActiveBurrow(client, workspaceDir);
		client.agents.register(piRuntime);
		const calls: CollectedSpawn[] = [];

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ stdoutLines: [], calls }),
			installCheck: async () => ({ installed: true, version: "0.78.1", path: "/usr/local/bin/pi" }),
		});
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "pi",
			prompt: "p",
			metadata: {
				frontmatter: {
					pi: {
						extensions: "true",
						approve: 1,
						tools: ["read", 7, "my_extension_tool"],
						unsafeArgv: ["--no-offline"],
					},
				},
			},
		});
		await waitFor(() => client.runs.get(run.id).state === "succeeded");
		await dispatcher.stop();

		expect(calls).toHaveLength(1);
		const argv = calls[0]?.command.argv ?? [];
		expect(argv).toContain("--no-extensions");
		expect(argv).not.toContain("--approve");
		expect(argv).not.toContain("unsafeArgv");
		expect(argv).not.toContain("--no-offline");
		const toolsIdx = argv.indexOf("--tools");
		expect(argv[toolsIdx + 1]).toBe("read,my_extension_tool");
	});

	test("no frontmatter override → dispatch profile envPassthrough unchanged (burrow-6f3f)", async () => {
		// The default-provider path (no frontmatter) must not mutate the
		// profile envPassthrough — the up-time bake already covered the
		// anthropic base. `applyRuntimeEnvPassthrough` returns the profile
		// by reference so a profile mid-spawn isn't gratuitously copied.
		const burrow = seedActiveBurrow(client, workspaceDir);
		client.agents.register(piRuntime);
		const calls: CollectedSpawn[] = [];

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ stdoutLines: [], calls }),
			installCheck: async () => ({ installed: true, version: "0.74.0", path: "/usr/local/bin/pi" }),
		});
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "pi",
			prompt: "p",
		});
		await waitFor(() => client.runs.get(run.id).state === "succeeded");
		await dispatcher.stop();

		// seedActiveBurrow seeds envPassthrough: []; the dispatcher adds the
		// anthropic triple here because the up-time bake didn't run (the
		// test seeds the profile directly), so the function-form delta is
		// the full base set. Either way: no openai key leaks.
		const passthrough = calls[0]?.profile.envPassthrough ?? [];
		expect(passthrough).not.toContain("OPENAI_API_KEY");
		expect(passthrough).not.toContain("GEMINI_API_KEY");
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

// Mid-run steering (burrow-250d, SPEC §13.5): when a runtime opts into
// stdin-hold AND defines encodeSteeringMessage, the dispatcher polls the
// messages table while the run is in flight, writes newly-arrived rows
// through SpawnResult.writeStdin, and marks them delivered against the
// active run. Runtimes without encodeSteeringMessage stay on the
// next-spawn delivery path even when they hold stdin.
describe("startRunDispatcher · mid-run steering (burrow-250d)", () => {
	let dataDir: string;
	let workspaceDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-dispatcher-midrun-"));
		workspaceDir = mkdtempSync(join(tmpdir(), "burrow-dispatcher-midrun-ws-"));
		await mkdir(join(workspaceDir, PI_SESSION_DIR), { recursive: true });
		client = await Client.open({ dataDir, configDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(workspaceDir, { recursive: true, force: true });
	});

	interface MidRunCapture {
		writes: string[];
		closeStdinCalls: number;
		writeStdinCalled: boolean;
	}

	// Spawn fake that emits a "running" stdout marker, then idles until
	// the test pushes an inbox message and writeStdin is observed; on
	// the next tick after we record the write, it emits agent_end so
	// the dispatcher's trigger predicate fires and the run finalizes.
	function midRunSpawn(capture: MidRunCapture): SpawnFn {
		return async (_profile, command) => {
			const encoder = new TextEncoder();
			// Two-stage stdout: initial marker, then agent_end after the
			// test has dropped a message into stdin.
			let pushAgentEnd: (() => void) | null = null;
			const stdout = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							`${JSON.stringify({ type: "response", command: "prompt", success: true })}\n`,
						),
					);
					controller.enqueue(encoder.encode(`${JSON.stringify({ type: "turn_start" })}\n`));
					pushAgentEnd = () => {
						controller.enqueue(encoder.encode(`${JSON.stringify({ type: "agent_end" })}\n`));
						controller.close();
					};
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
			void command; // command is unused — we only assert writes through writeStdin

			return {
				pid: 5555,
				stdout,
				stderr,
				exited,
				cancel: () => resolveExit(130),
				closeStdin: async () => {
					capture.closeStdinCalls += 1;
					resolveExit(0);
				},
				writeStdin: async (chunk: string) => {
					capture.writeStdinCalled = true;
					capture.writes.push(chunk);
					// Once we've observed the mid-run write, push agent_end
					// on the next microtask so the dispatcher's trigger
					// predicate fires and the run finalizes.
					queueMicrotask(() => pushAgentEnd?.());
				},
			};
		};
	}

	test("inbox.send during a held-stdin pi run reaches the agent via writeStdin and emits inbox_delivered", async () => {
		const burrow = seedActiveBurrow(client, workspaceDir);
		client.agents.register(piRuntime);

		const capture: MidRunCapture = {
			writes: [],
			closeStdinCalls: 0,
			writeStdinCalled: false,
		};
		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: midRunSpawn(capture),
			installCheck: async () => ({ installed: true, version: "0.74.0", path: "/usr/local/bin/pi" }),
		});
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "pi",
			prompt: "Reply with: ack.",
		});

		// Wait for the run to actually start so the held-stdin spawn has
		// been constructed and the mid-run poll loop is alive.
		await waitFor(() => client.runs.get(run.id).state === "running", 2000);

		// Send a steering message mid-run. The dispatcher's poll loop
		// should pick it up within ~200 ms, encode it via
		// piRuntime.encodeSteeringMessage, and write the bytes to the
		// fake spawn's writeStdin sink.
		const message = client.inbox.send({
			burrowId: burrow.id,
			body: "switch to writing tests",
			priority: "high",
		});

		await waitFor(() => capture.writeStdinCalled, 2000);
		await waitFor(() => client.runs.get(run.id).state === "succeeded", 2000);
		await dispatcher.stop();

		// Wire shape: a single pi RPC prompt envelope with the [STEERING]
		// tag, terminated by \n so pi's NDJSON read loop frames it.
		expect(capture.writes).toHaveLength(1);
		const chunk = capture.writes[0] ?? "";
		expect(chunk.endsWith("\n")).toBe(true);
		const parsed = JSON.parse(chunk.trimEnd()) as { type: string; message: string };
		expect(parsed.type).toBe("prompt");
		expect(parsed.message).toContain("[STEERING]");
		expect(parsed.message).toContain("priority: high");
		expect(parsed.message).toContain("switch to writing tests");

		// Row is marked delivered against THIS run, not the next one.
		const stored = client.repos.messages.require(message.id);
		expect(stored.state).toBe("delivered");
		expect(stored.deliveredAtRunId).toBe(run.id);

		// inbox_delivered system event was appended with mid_run mode.
		const events = client.repos.events.listByBurrow(burrow.id, { limit: 100 });
		const delivered = events.find((e) => e.kind === "inbox_delivered");
		expect(delivered).toBeDefined();
		expect(delivered?.stream).toBe("system");
		const payload = delivered?.payloadJson as {
			messageId: string;
			priority: string;
			mode: string;
		};
		expect(payload.messageId).toBe(message.id);
		expect(payload.priority).toBe("high");
		expect(payload.mode).toBe("mid_run");
	});

	test("runtime without encodeSteeringMessage skips mid-run delivery (messages stay unread)", async () => {
		const burrow = seedActiveBurrow(client);
		// Mirror pi's stdin-hold posture (so the dispatcher would *try*
		// mid-run) but omit encodeSteeringMessage — messages must remain
		// unread; writeStdin must not be called.
		const heldRuntime = fakeRuntime({
			id: "held-no-encoder",
			shouldCloseStdinOnEvent: (ev) => ev.kind === "text",
		});
		client.agents.register(heldRuntime);

		const capture: MidRunCapture = {
			writes: [],
			closeStdinCalls: 0,
			writeStdinCalled: false,
		};
		// Spawn emits a single "text" line so the trigger predicate fires
		// and the run finalizes — but we also need the loop alive long
		// enough for a poll tick to happen if it were going to.
		const spawnFn: SpawnFn = async () => {
			const encoder = new TextEncoder();
			let resolveExit!: (n: number) => void;
			const exited = new Promise<number>((r) => {
				resolveExit = r;
			});
			let triggerClose: (() => void) | null = null;
			const stdout = new ReadableStream<Uint8Array>({
				start(c) {
					triggerClose = () => {
						c.enqueue(encoder.encode("trigger\n"));
						c.close();
					};
				},
			});
			const stderr = new ReadableStream<Uint8Array>({
				start(c) {
					c.close();
				},
			});
			// Stay alive ~300 ms so the dispatcher's 200 ms poll tick would
			// have fired if the runtime opted in.
			setTimeout(() => triggerClose?.(), 300);
			return {
				pid: 5556,
				stdout,
				stderr,
				exited,
				cancel: () => resolveExit(130),
				closeStdin: async () => {
					capture.closeStdinCalls += 1;
					resolveExit(0);
				},
				writeStdin: async (chunk: string) => {
					capture.writeStdinCalled = true;
					capture.writes.push(chunk);
				},
			};
		};

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: spawnFn,
		});
		dispatcher.start();
		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "held-no-encoder",
			prompt: "p",
		});
		await waitFor(() => client.runs.get(run.id).state === "running", 2000);

		const message = client.inbox.send({
			burrowId: burrow.id,
			body: "should not be delivered mid-run",
		});

		await waitFor(() => client.runs.get(run.id).state === "succeeded", 2000);
		await dispatcher.stop();

		expect(capture.writeStdinCalled).toBe(false);
		// Row never reached the agent during this run.
		const stored = client.repos.messages.require(message.id);
		expect(stored.state).toBe("unread");
	});
});

// Auto-reply hook (burrow-aea0, pl-1ee7 step 3): when a stdin-holding
// runtime defines `autoRespondToEvent`, the dispatcher feeds every
// parser-emitted event through the hook *after* persistence and writes
// any returned reply to the open stdin via `SpawnResult.writeStdin`.
// The canonical consumer is pi-chat declining an `extension_ui_request`,
// but the hook is generic — this test uses a fake runtime to lock the
// contract independently of any built-in runtime's parser.
describe("startRunDispatcher · auto-reply hook (burrow-aea0)", () => {
	let dataDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-dispatcher-autoreply-"));
		client = await Client.open({ dataDir, configDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	interface AutoReplyCapture {
		holdStdin?: boolean;
		writes: string[];
		closeStdinCalls: number;
	}

	// Spawn fake that emits a scripted set of stdout lines and stays alive
	// until closeStdin is called. Each line goes through parseEvents and
	// then through the runtime's autoRespondToEvent hook — we capture
	// every writeStdin chunk to assert ordering + content.
	function scriptedHoldingSpawn(stdoutLines: string[], capture: AutoReplyCapture): SpawnFn {
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
			return {
				pid: 7777,
				stdout,
				stderr,
				exited,
				cancel: () => resolveExit(130),
				closeStdin: async () => {
					capture.closeStdinCalls += 1;
					resolveExit(0);
				},
				writeStdin: async (chunk: string) => {
					capture.writes.push(chunk);
				},
			};
		};
	}

	test("autoRespondToEvent writes its reply to the held stdin, on the matching event only", async () => {
		const burrow = seedActiveBurrow(client);
		// Parser emits one event per stdout line, kind == payload.kind.
		// The runtime auto-replies only when the event kind is `request`;
		// the `end` line trips the stdin-close trigger.
		const runtime = fakeRuntime({
			id: "autoreply",
			parseEvents: (line) => {
				const payload = JSON.parse(line) as { kind: string; id?: string };
				return [{ kind: payload.kind, stream: "stdout", payload }];
			},
			shouldCloseStdinOnEvent: (ev) => ev.kind === "end",
			autoRespondToEvent: (ev) => {
				if (ev.kind !== "request") return undefined;
				const payload = ev.payload as { id?: string };
				return {
					stdin: `${JSON.stringify({ type: "response", id: payload.id ?? null, cancelled: true })}\n`,
				};
			},
		});
		client.agents.register(runtime);

		const lines = [
			JSON.stringify({ kind: "text", text: "hi" }),
			JSON.stringify({ kind: "request", id: "req-1" }),
			JSON.stringify({ kind: "text", text: "bye" }),
			JSON.stringify({ kind: "request", id: "req-2" }),
			JSON.stringify({ kind: "end" }),
		];
		const capture: AutoReplyCapture = { writes: [], closeStdinCalls: 0 };

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: scriptedHoldingSpawn(lines, capture),
		});
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "autoreply",
			prompt: "p",
		});
		await waitFor(() => client.runs.get(run.id).state === "succeeded", 2000);
		await dispatcher.stop();

		// Stdin-hold contract propagated.
		expect(capture.holdStdin).toBe(true);
		// One reply per `request` event, in stdout order, and nothing for
		// `text` / `end`.
		expect(capture.writes).toHaveLength(2);
		expect(JSON.parse(capture.writes[0]?.trimEnd() ?? "")).toEqual({
			type: "response",
			id: "req-1",
			cancelled: true,
		});
		expect(JSON.parse(capture.writes[1]?.trimEnd() ?? "")).toEqual({
			type: "response",
			id: "req-2",
			cancelled: true,
		});
		expect(capture.writes[0]?.endsWith("\n")).toBe(true);
		expect(capture.writes[1]?.endsWith("\n")).toBe(true);
		// stdin closed exactly once on the `end` trigger.
		expect(capture.closeStdinCalls).toBe(1);
	});

	test("runtime without autoRespondToEvent skips the hook (no writeStdin)", async () => {
		const burrow = seedActiveBurrow(client);
		// Holds stdin (so writeStdin exists and would be called if the hook
		// were defined), but defines no autoRespondToEvent — dispatcher
		// must leave writeStdin untouched.
		const runtime = fakeRuntime({
			id: "no-autoreply",
			shouldCloseStdinOnEvent: (ev) => ev.kind === "text",
		});
		client.agents.register(runtime);

		const capture: AutoReplyCapture = { writes: [], closeStdinCalls: 0 };
		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: scriptedHoldingSpawn(["trigger"], capture),
		});
		dispatcher.start();
		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "no-autoreply",
			prompt: "p",
		});
		await waitFor(() => client.runs.get(run.id).state === "succeeded", 2000);
		await dispatcher.stop();

		expect(capture.writes).toHaveLength(0);
		expect(capture.closeStdinCalls).toBe(1);
	});

	test("non-holdStdin runtime: autoRespondToEvent is silently ignored", async () => {
		const burrow = seedActiveBurrow(client);
		// Defines autoRespondToEvent but NOT shouldCloseStdinOnEvent. The
		// dispatcher requires stdin-hold to be effective; otherwise the
		// hook is dead code (no writeStdin available, stdin already closed).
		let hookCalled = false;
		const runtime = fakeRuntime({
			id: "autoreply-no-hold",
			autoRespondToEvent: (_ev) => {
				hookCalled = true;
				return { stdin: "should-not-write\n" };
			},
		});
		client.agents.register(runtime);

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ stdoutLines: ["anything"] }),
		});
		dispatcher.start();
		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "autoreply-no-hold",
			prompt: "p",
		});
		await waitFor(() => client.runs.get(run.id).state === "succeeded");
		await dispatcher.stop();

		expect(hookCalled).toBe(false);
	});
});
