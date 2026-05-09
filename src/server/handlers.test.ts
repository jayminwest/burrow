/**
 * End-to-end tests for the HTTP API handlers (pl-5b40 steps 2 + 3).
 *
 * Each test boots a real `Client` against tmp dirs, starts the server on an
 * ephemeral port, and exercises the route via `fetch`. The Library API is
 * the source of truth — these tests verify the HTTP envelope (status,
 * payload shape, NDJSON wire bytes) rather than re-asserting business
 * logic that lives in `src/lib/client.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Burrow, Run } from "../core/types.ts";
import type { DashboardSnapshot } from "../dashboard/types.ts";
import type { EventEnvelope } from "../events/render.ts";
import { Client } from "../lib/client.ts";
import { createLogger } from "../logging/logger.ts";
import type { AgentRuntime, InstallCheckResult } from "../runtime/runtime.ts";
import { startServer } from "./server.ts";
import type { ServeHandle } from "./types.ts";

const silentLogger = createLogger({ level: "fatal" });

function mkTmp(): string {
	return mkdtempSync(join(tmpdir(), "burrow-server-"));
}

function makeMockAgent(id: string, opts: { spawnPerTurn?: boolean } = {}): AgentRuntime {
	const runtime: AgentRuntime = {
		id,
		displayName: `mock ${id}`,
		supportsResume: false,
		buildSpawnCommand: () => ({ argv: ["true"] }),
		parseEvents: () => [],
		installCheck: async (): Promise<InstallCheckResult> => ({
			installed: true,
			version: "0.0.0-mock",
		}),
	};
	if (opts.spawnPerTurn) {
		runtime.encodeInboxMessage = () => ({ stdin: "" });
	}
	return runtime;
}

function seedBurrow(
	client: Client,
	overrides: Partial<Parameters<typeof client.repos.burrows.create>[0]> = {},
): Burrow {
	return client.repos.burrows.create({
		kind: "project",
		projectRoot: "/tmp/proj",
		workspacePath: "/tmp/proj/.ws",
		branch: "main",
		provider: "local",
		profile: {},
		...overrides,
	});
}

describe("server handlers", () => {
	let dataDir: string;
	let configDir: string;
	let client: Client;
	let handle: ServeHandle;

	beforeEach(async () => {
		dataDir = mkTmp();
		configDir = mkTmp();
		client = await Client.open({ dataDir, configDir });
		// Replace built-in agents (which shell out in installCheck) with mocks
		// keyed by stable ids the tests assert on.
		for (const rt of client.agents.list()) client.agents.unregister(rt.id);
		client.agents.register(makeMockAgent("mock-agent", { spawnPerTurn: true }));
		client.agents.register(makeMockAgent("mock-oneshot"));
		handle = startServer(client, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			logger: silentLogger,
		});
	});

	afterEach(async () => {
		await handle.stop();
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(configDir, { recursive: true, force: true });
	});

	/* ------------------------------------------------------------------- */
	/* Burrows                                                             */
	/* ------------------------------------------------------------------- */

	test("GET /burrows lists all burrows", async () => {
		const a = seedBurrow(client);
		const b = seedBurrow(client, { kind: "task", parentId: a.id, branch: "task/x" });
		const res = await fetch(`${handle.url}/burrows`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Burrow[];
		expect(body.map((row) => row.id).sort()).toEqual([a.id, b.id].sort());
	});

	test("GET /burrows?kind=task filters by kind", async () => {
		const project = seedBurrow(client);
		const task = seedBurrow(client, { kind: "task", parentId: project.id, branch: "task/x" });
		const res = await fetch(`${handle.url}/burrows?kind=task`);
		const body = (await res.json()) as Burrow[];
		expect(body.map((row) => row.id)).toEqual([task.id]);
	});

	test("GET /burrows?state=invalid → 400", async () => {
		const res = await fetch(`${handle.url}/burrows?state=bogus`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});

	test("GET /burrows/:id returns the burrow", async () => {
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Burrow;
		expect(body.id).toBe(burrow.id);
	});

	test("GET /burrows/:id for unknown id → 404", async () => {
		const res = await fetch(`${handle.url}/burrows/bur_nope`);
		expect(res.status).toBe(404);
	});

	test("POST /burrows/:id/stop transitions active → stopped", async () => {
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/stop`, { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Burrow;
		expect(body.state).toBe("stopped");
	});

	test("POST /burrows/:id/resume transitions stopped → active", async () => {
		const burrow = seedBurrow(client);
		client.burrows.stop(burrow.id);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/resume`, { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Burrow;
		expect(body.state).toBe("active");
	});

	test("DELETE /burrows/:id transitions the burrow to destroyed", async () => {
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}?archive=false`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { burrowId: string };
		expect(body.burrowId).toBe(burrow.id);
		const row = client.burrows.tryGet(burrow.id);
		expect(row?.state).toBe("destroyed");
	});

	test("DELETE /burrows/:id removes the workspace (burrow-a79f)", async () => {
		// Pre-fix the API path archived the row but skipped workspace teardown,
		// leaking worktrees + branches. Verify the cleanup hook now fires.
		const burrow = seedBurrow(client, {
			providerState: {
				workspaceSource: { kind: "worktree", branch: "burrow/x", hostClonePath: "/host" },
			},
		});
		const removed: Array<{ workspacePath: string; branch: string }> = [];
		client.burrows.setDestroyOverrides({
			removeWorkspace: async (opts) => {
				removed.push({ workspacePath: opts.workspacePath, branch: opts.source.branch });
			},
		});
		const res = await fetch(`${handle.url}/burrows/${burrow.id}?archive=false`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
		expect(removed).toEqual([{ workspacePath: burrow.workspacePath, branch: "burrow/x" }]);
		expect(client.burrows.tryGet(burrow.id)?.state).toBe("destroyed");
	});

	test("POST /burrows provisions a project burrow (201)", async () => {
		const projectRoot = mkTmp();
		client.burrows.setUpOverrides({
			skipDoctor: true,
			materializer: async (opts) => ({
				workspacePath: opts.workspacePath,
				source: { kind: "worktree", branch: opts.branch, hostClonePath: "/host" },
				identity: null,
			}),
		});
		const res = await fetch(`${handle.url}/burrows`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				projectRoot,
				name: "web",
				branch: "feature/x",
				network: "none",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as Burrow;
		expect(body.id.startsWith("bur_")).toBe(true);
		expect(body.kind).toBe("project");
		expect(body.name).toBe("web");
		expect(body.branch).toBe("feature/x");
		expect(body.projectRoot).toBe(projectRoot);
		// Persisted row matches what came back over the wire.
		expect(client.burrows.get(body.id).id).toBe(body.id);
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("POST /burrows forwards `agents` onto the burrow profile (burrow-55e3)", async () => {
		// Wire-through for warren-8526: the HTTP body's `agents` array must
		// reach runUpCommand so a built-in runtime gets enabled even when the
		// project clone has no burrow.toml. Mock agent's installCheck returns a
		// resolved path so we can assert the bin dir lands on toolchainPaths.
		const projectRoot = mkTmp();
		client.agents.register({
			id: "wired-claude",
			displayName: "Wired Claude",
			supportsResume: false,
			buildSpawnCommand: () => ({ argv: ["claude"] }),
			parseEvents: () => [],
			installCheck: async () => ({
				installed: true,
				version: "2.1",
				path: "/usr/local/bin/claude",
			}),
		});
		client.burrows.setUpOverrides({
			skipDoctor: true,
			materializer: async (opts) => ({
				workspacePath: opts.workspacePath,
				source: { kind: "worktree", branch: opts.branch, hostClonePath: "/host" },
				identity: null,
			}),
		});
		const res = await fetch(`${handle.url}/burrows`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectRoot, agents: ["wired-claude"] }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as Burrow;
		const profile = client.burrows.get(body.id).profileJson as { toolchainPaths: string[] };
		expect(profile.toolchainPaths).toContain("/usr/local/bin");
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("POST /burrows with non-string entry in `agents` → 400", async () => {
		const res = await fetch(`${handle.url}/burrows`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectRoot: "/repos/web", agents: ["claude-code", 42] }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});

	test("POST /burrows without projectRoot → 400", async () => {
		const res = await fetch(`${handle.url}/burrows`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "web" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});

	test("POST /burrows with unknown network → 400", async () => {
		const res = await fetch(`${handle.url}/burrows`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectRoot: "/repos/web", network: "bogus" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});

	test("POST /burrows with non-JSON body → 400", async () => {
		const res = await fetch(`${handle.url}/burrows`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not json",
		});
		expect(res.status).toBe(400);
	});

	/* ------------------------------------------------------------------- */
	/* Runs                                                                */
	/* ------------------------------------------------------------------- */

	test("POST /burrows/:id/runs enqueues a run", async () => {
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agentId: "mock-agent", prompt: "hello" }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as Run;
		expect(body.burrowId).toBe(burrow.id);
		expect(body.agentId).toBe("mock-agent");
		expect(body.state).toBe("queued");
	});

	test("POST /burrows/:id/runs without prompt → 400", async () => {
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agentId: "mock-agent" }),
		});
		expect(res.status).toBe(400);
	});

	test("POST /burrows/:id/runs with non-JSON body → 400", async () => {
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/runs`, {
			method: "POST",
			body: "not json",
		});
		expect(res.status).toBe(400);
	});

	test("GET /burrows/:id/runs lists runs for a burrow", async () => {
		const burrow = seedBurrow(client);
		const r1 = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "a" });
		const r2 = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "b" });
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/runs`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Run[];
		expect(body.map((r) => r.id).sort()).toEqual([r1.id, r2.id].sort());
	});

	test("GET /runs/:id returns the run", async () => {
		const burrow = seedBurrow(client);
		const run = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "x" });
		const res = await fetch(`${handle.url}/runs/${run.id}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Run;
		expect(body.id).toBe(run.id);
	});

	test("POST /runs/:id/cancel marks the run cancelled", async () => {
		const burrow = seedBurrow(client);
		const run = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "x" });
		const res = await fetch(`${handle.url}/runs/${run.id}/cancel`, { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Run;
		expect(body.state).toBe("cancelled");
	});

	test("POST /runs/:id/cancel records the optional reason", async () => {
		const burrow = seedBurrow(client);
		const run = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "x" });
		const res = await fetch(`${handle.url}/runs/${run.id}/cancel`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ reason: "warren rolled the deploy back" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Run;
		expect(body.state).toBe("cancelled");
		expect(body.errorMessage).toBe("warren rolled the deploy back");
	});

	test("POST /runs/:id/cancel emits a run_cancelled event on the stream", async () => {
		const burrow = seedBurrow(client);
		const run = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "x" });
		await fetch(`${handle.url}/runs/${run.id}/cancel`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ reason: "user-requested" }),
		});
		const events = client.repos.events.listByBurrow(burrow.id);
		const cancel = events.find((e) => e.kind === "run_cancelled");
		expect(cancel).toBeDefined();
		expect(cancel?.runId).toBe(run.id);
		expect(cancel?.payloadJson).toEqual({ reason: "user-requested" });
	});

	test("POST /runs/:id/cancel is idempotent on terminal runs", async () => {
		const burrow = seedBurrow(client);
		const run = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "x" });
		const first = await fetch(`${handle.url}/runs/${run.id}/cancel`, { method: "POST" });
		expect(first.status).toBe(200);
		const second = await fetch(`${handle.url}/runs/${run.id}/cancel`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ reason: "second call ignored" }),
		});
		expect(second.status).toBe(200);
		const body = (await second.json()) as Run;
		expect(body.state).toBe("cancelled");
		// Idempotent: the original cancel reason wins; second cancel doesn't
		// re-stamp the row or emit a second event.
		expect(body.errorMessage).toBe("cancelled via Client.runs.cancel");
		const cancelEvents = client.repos.events
			.listByBurrow(burrow.id)
			.filter((e) => e.kind === "run_cancelled");
		expect(cancelEvents).toHaveLength(1);
	});

	test("POST /runs/:id/cancel for unknown id → 404", async () => {
		const res = await fetch(`${handle.url}/runs/run_nope/cancel`, { method: "POST" });
		expect(res.status).toBe(404);
	});

	test("DELETE /runs/:id removes a terminal run row (204)", async () => {
		const burrow = seedBurrow(client);
		const run = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "x" });
		client.runs.cancel(run.id);
		const res = await fetch(`${handle.url}/runs/${run.id}`, { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(client.runs.tryGet(run.id)).toBeNull();
	});

	test("DELETE /runs/:id rejects a non-terminal run (400)", async () => {
		const burrow = seedBurrow(client);
		const run = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "x" });
		const res = await fetch(`${handle.url}/runs/${run.id}`, { method: "DELETE" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
		// Row still present.
		expect(client.runs.tryGet(run.id)?.id).toBe(run.id);
	});

	test("DELETE /runs/:id for unknown id → 404", async () => {
		const res = await fetch(`${handle.url}/runs/run_nope`, { method: "DELETE" });
		expect(res.status).toBe(404);
	});

	/* ------------------------------------------------------------------- */
	/* Inbox                                                               */
	/* ------------------------------------------------------------------- */

	test("POST /burrows/:id/inbox enqueues a message", async () => {
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/inbox`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ body: "stop and write tests", priority: "high" }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; priority: string; body: string };
		expect(body.priority).toBe("high");
		expect(body.body).toBe("stop and write tests");
	});

	test("POST /burrows/:id/inbox with empty body → 400", async () => {
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/inbox`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ body: "" }),
		});
		expect(res.status).toBe(400);
	});

	test("GET /burrows/:id/inbox lists messages with state filter", async () => {
		const burrow = seedBurrow(client);
		client.inbox.send({ burrowId: burrow.id, body: "first" });
		client.inbox.send({ burrowId: burrow.id, body: "second" });
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/inbox?state=unread`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; body: string }[];
		expect(body.map((m) => m.body).sort()).toEqual(["first", "second"]);
	});

	test("DELETE /messages/:id returns 204 and removes the row", async () => {
		const burrow = seedBurrow(client);
		const message = client.inbox.send({ burrowId: burrow.id, body: "drop me" });
		const res = await fetch(`${handle.url}/messages/${message.id}`, { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(client.inbox.list(burrow.id).map((m) => m.id)).toEqual([]);
	});

	test("DELETE /messages/:id for unknown id → 404", async () => {
		const res = await fetch(`${handle.url}/messages/msg_missing`, { method: "DELETE" });
		expect(res.status).toBe(404);
	});

	/* ------------------------------------------------------------------- */
	/* Agents                                                              */
	/* ------------------------------------------------------------------- */

	test("GET /agents returns registered runtimes with install status", async () => {
		const res = await fetch(`${handle.url}/agents`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			id: string;
			displayName: string;
			supportsResume: boolean;
			spawnPerTurn: boolean;
			install: InstallCheckResult;
		}[];
		const ids = body.map((a) => a.id).sort();
		expect(ids).toEqual(["mock-agent", "mock-oneshot"]);
		const spawnPerTurn = body.find((a) => a.id === "mock-agent");
		expect(spawnPerTurn?.spawnPerTurn).toBe(true);
		const oneshot = body.find((a) => a.id === "mock-oneshot");
		expect(oneshot?.spawnPerTurn).toBe(false);
		expect(spawnPerTurn?.install.installed).toBe(true);
	});

	test("GET /agents/:id returns one runtime", async () => {
		const res = await fetch(`${handle.url}/agents/mock-agent`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; install: InstallCheckResult };
		expect(body.id).toBe("mock-agent");
		expect(body.install.installed).toBe(true);
	});

	test("GET /agents/:id for unknown id → 404", async () => {
		const res = await fetch(`${handle.url}/agents/nope`);
		expect(res.status).toBe(404);
	});

	/* ------------------------------------------------------------------- */
	/* Streaming: events tail (§14.2)                                      */
	/* ------------------------------------------------------------------- */

	test("GET /burrows/:id/events?follow=0 drains current rows as NDJSON", async () => {
		const burrow = seedBurrow(client);
		client.repos.events.append({
			burrowId: burrow.id,
			kind: "tool_use",
			stream: "stdout",
			payload: { tool: "Bash" },
			ts: new Date(1000),
		});
		client.repos.events.append({
			burrowId: burrow.id,
			kind: "text",
			stream: "stdout",
			payload: { text: "hi" },
			ts: new Date(2000),
		});

		const res = await fetch(`${handle.url}/burrows/${burrow.id}/events?follow=0`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/x-ndjson");
		const lines = parseNdjson(await res.text());
		expect(lines.length).toBe(2);
		const envelopes = lines as EventEnvelope[];
		expect(envelopes[0]?.type).toBe("event");
		expect(envelopes[0]?.kind).toBe("tool_use");
		expect(envelopes[0]?.seq).toBe(1);
		expect(envelopes[1]?.kind).toBe("text");
		expect(envelopes[1]?.seq).toBe(2);
	});

	test("GET /burrows/:id/events?since=N replays only seq>N", async () => {
		const burrow = seedBurrow(client);
		for (let i = 1; i <= 5; i += 1) {
			client.repos.events.append({
				burrowId: burrow.id,
				kind: "tool_use",
				stream: "stdout",
				payload: { i },
				ts: new Date(1000 * i),
			});
		}
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/events?follow=0&since=2`);
		const lines = parseNdjson(await res.text()) as EventEnvelope[];
		expect(lines.map((l) => l.seq)).toEqual([3, 4, 5]);
	});

	test("GET /burrows/:id/events?kinds=tool_use,error filters in-stream", async () => {
		const burrow = seedBurrow(client);
		client.repos.events.append({
			burrowId: burrow.id,
			kind: "tool_use",
			stream: "stdout",
			payload: {},
			ts: new Date(1000),
		});
		client.repos.events.append({
			burrowId: burrow.id,
			kind: "text",
			stream: "stdout",
			payload: {},
			ts: new Date(2000),
		});
		client.repos.events.append({
			burrowId: burrow.id,
			kind: "error",
			stream: "stderr",
			payload: {},
			ts: new Date(3000),
		});
		const res = await fetch(
			`${handle.url}/burrows/${burrow.id}/events?follow=0&kinds=tool_use,error`,
		);
		const kinds = (parseNdjson(await res.text()) as EventEnvelope[]).map((e) => e.kind);
		expect(kinds).toEqual(["tool_use", "error"]);
	});

	test("GET /burrows/:id/events?follow=1&limit=N tails then closes", async () => {
		const burrow = seedBurrow(client);
		for (let i = 1; i <= 3; i += 1) {
			client.repos.events.append({
				burrowId: burrow.id,
				kind: "tool_use",
				stream: "stdout",
				payload: { i },
				ts: new Date(1000 * i),
			});
		}
		const res = await fetch(
			`${handle.url}/burrows/${burrow.id}/events?follow=1&limit=2&pollIntervalMs=10`,
		);
		const lines = parseNdjson(await res.text()) as EventEnvelope[];
		expect(lines.map((l) => l.seq)).toEqual([1, 2]);
	});

	test("GET /burrows/:id/events for unknown id → 404", async () => {
		const res = await fetch(`${handle.url}/burrows/bur_nope/events?follow=0`);
		expect(res.status).toBe(404);
	});

	test("GET /burrows/:id/events?since=-1 → 400", async () => {
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/events?since=-1`);
		expect(res.status).toBe(400);
	});

	test("GET /burrows/:id/events stream cancels cleanly on client disconnect", async () => {
		const burrow = seedBurrow(client);
		client.repos.events.append({
			burrowId: burrow.id,
			kind: "tool_use",
			stream: "stdout",
			payload: {},
			ts: new Date(1000),
		});
		const ctrl = new AbortController();
		const res = await fetch(
			`${handle.url}/burrows/${burrow.id}/events?follow=1&pollIntervalMs=50`,
			{ signal: ctrl.signal },
		);
		expect(res.body).not.toBeNull();
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const first = await reader.read();
		expect(first.done).toBe(false);
		ctrl.abort();
		// Reader rejects with the abort error; that's the contract — the
		// server-side generator's `finally` releases the polling timer.
		await expect(reader.read()).rejects.toThrow();
	});

	/* ------------------------------------------------------------------- */
	/* Streaming: run stream (§15.2)                                       */
	/* ------------------------------------------------------------------- */

	test("GET /runs/:id/stream filters to one runId", async () => {
		const burrow = seedBurrow(client);
		const run = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "x" });
		client.repos.events.append({
			burrowId: burrow.id,
			runId: run.id,
			kind: "tool_use",
			stream: "stdout",
			payload: { match: true },
			ts: new Date(1000),
		});
		client.repos.events.append({
			burrowId: burrow.id,
			runId: null,
			kind: "tool_use",
			stream: "stdout",
			payload: { match: false },
			ts: new Date(2000),
		});
		const res = await fetch(`${handle.url}/runs/${run.id}/stream?limit=1&pollIntervalMs=10`);
		const lines = parseNdjson(await res.text()) as EventEnvelope[];
		expect(lines.length).toBe(1);
		expect(lines[0]?.runId).toBe(run.id);
		expect((lines[0]?.payload as { match: boolean }).match).toBe(true);
	});

	test("GET /runs/:id/stream for unknown id → 404", async () => {
		const res = await fetch(`${handle.url}/runs/run_nope/stream`);
		expect(res.status).toBe(404);
	});

	/* ------------------------------------------------------------------- */
	/* Streaming: watch snapshot (§26)                                     */
	/* ------------------------------------------------------------------- */

	test("GET /watch?once=true emits one DashboardSnapshot and closes", async () => {
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/watch?once=true&pollIntervalMs=0&coalesceMs=0`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/x-ndjson");
		const lines = parseNdjson(await res.text()) as DashboardSnapshot[];
		expect(lines.length).toBe(1);
		const snap = lines[0];
		expect(snap?.type).toBe("snapshot");
		expect(snap?.version).toBe(1);
		expect(snap?.burrows.map((b) => b.id)).toEqual([burrow.id]);
	});

	test("GET /watch?once=1 (curl muscle memory) emits one snapshot and closes", async () => {
		seedBurrow(client);
		const res = await fetch(`${handle.url}/watch?once=1&pollIntervalMs=0&coalesceMs=0`);
		expect(res.status).toBe(200);
		const lines = parseNdjson(await res.text()) as DashboardSnapshot[];
		expect(lines.length).toBe(1);
	});

	test("GET /watch?follow=0 (alias) emits one snapshot and closes", async () => {
		seedBurrow(client);
		const res = await fetch(`${handle.url}/watch?follow=0&pollIntervalMs=0&coalesceMs=0`);
		expect(res.status).toBe(200);
		const lines = parseNdjson(await res.text()) as DashboardSnapshot[];
		expect(lines.length).toBe(1);
	});

	test("GET /watch?once and ?follow specified together → 400", async () => {
		const res = await fetch(`${handle.url}/watch?once=1&follow=0`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.message).toMatch(/either '\?once' or '\?follow'/);
	});

	test("GET /watch?once=bogus → 400 mentions accepted forms", async () => {
		const res = await fetch(`${handle.url}/watch?once=bogus`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toMatch(/once must be 'true'\/'1' or 'false'\/'0'/);
	});

	test("GET /watch?runsLimit=0 → 400", async () => {
		const res = await fetch(`${handle.url}/watch?runsLimit=0`);
		expect(res.status).toBe(400);
	});
});

function parseNdjson(body: string): unknown[] {
	return body
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l));
}
