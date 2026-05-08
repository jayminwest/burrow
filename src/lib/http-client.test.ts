/**
 * End-to-end tests for the HTTP-backed Client mirror (pl-5b40 step 6).
 *
 * Each test boots a real `Client` against tmp dirs, starts `burrow serve`
 * on an ephemeral TCP port (or a unix socket where the test target requires
 * it), and exercises the surface through `HttpClient`. The acceptance
 * contract is shape parity with `src/lib/client.ts` — wire-level tests
 * already live in `src/server/handlers.test.ts`, these tests assert that
 * the rehydrated payloads match the in-process Client's return types
 * (Date instances, BurrowError subclasses, etc.).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { createLogger } from "../logging/logger.ts";
import type { AgentRuntime, InstallCheckResult } from "../runtime/runtime.ts";
import { bearerAuth } from "../server/auth.ts";
import { startServer } from "../server/server.ts";
import type { ServeHandle } from "../server/types.ts";
import { Client } from "./client.ts";
import { HttpClient, HttpClientError } from "./http-client.ts";

const silentLogger = createLogger({ level: "fatal" });

function mkTmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
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

function seedBurrow(client: Client, branch = "main") {
	return client.repos.burrows.create({
		kind: "project",
		projectRoot: "/tmp/proj",
		workspacePath: "/tmp/proj/.ws",
		branch,
		provider: "local",
		profile: {},
	});
}

describe("HttpClient (TCP transport)", () => {
	let dataDir: string;
	let configDir: string;
	let client: Client;
	let handle: ServeHandle;
	let http: HttpClient;

	beforeEach(async () => {
		dataDir = mkTmp("burrow-httpclient-");
		configDir = mkTmp("burrow-httpclient-cfg-");
		client = await Client.open({ dataDir, configDir });
		for (const rt of client.agents.list()) client.agents.unregister(rt.id);
		client.agents.register(makeMockAgent("mock-agent", { spawnPerTurn: true }));
		client.agents.register(makeMockAgent("mock-oneshot"));

		handle = startServer(client, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			logger: silentLogger,
		});
		if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
		http = new HttpClient({ transport: handle.transport });
	});

	afterEach(async () => {
		await http.close();
		await handle.stop();
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(configDir, { recursive: true, force: true });
	});

	/* ------------------------------------------------------------------- */
	/* Burrows                                                             */
	/* ------------------------------------------------------------------- */

	test("burrows.list rehydrates Date fields", async () => {
		const a = seedBurrow(client);
		const b = seedBurrow(client, "task/x");
		const rows = await http.burrows.list();
		expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
		const first = rows[0];
		expect(first?.createdAt).toBeInstanceOf(Date);
		expect(first?.updatedAt).toBeInstanceOf(Date);
	});

	test("burrows.list filters by kind", async () => {
		const project = seedBurrow(client);
		const task = client.repos.burrows.create({
			kind: "task",
			parentId: project.id,
			projectRoot: "/r",
			workspacePath: "/r/.task",
			branch: "task/y",
			provider: "local",
			profile: {},
		});
		const rows = await http.burrows.list({ kind: "task" });
		expect(rows.map((r) => r.id)).toEqual([task.id]);
	});

	test("burrows.get returns rehydrated burrow", async () => {
		const burrow = seedBurrow(client);
		const fetched = await http.burrows.get(burrow.id);
		expect(fetched.id).toBe(burrow.id);
		expect(fetched.createdAt).toBeInstanceOf(Date);
		// SQLite stores timestamps as whole seconds, so compare against a
		// re-read row to avoid the millisecond truncation of the in-memory
		// create result (mx-9c4605).
		const persisted = client.burrows.get(burrow.id);
		expect(fetched.createdAt.getTime()).toBe(persisted.createdAt.getTime());
	});

	test("burrows.get throws NotFoundError for unknown id", async () => {
		await expect(http.burrows.get("bur_nope")).rejects.toBeInstanceOf(NotFoundError);
	});

	test("burrows.tryGet returns null for unknown id", async () => {
		expect(await http.burrows.tryGet("bur_nope")).toBeNull();
		const burrow = seedBurrow(client);
		const row = await http.burrows.tryGet(burrow.id);
		expect(row?.id).toBe(burrow.id);
	});

	test("burrows.stop / resume round-trips state", async () => {
		const burrow = seedBurrow(client);
		const stopped = await http.burrows.stop(burrow.id);
		expect(stopped.state).toBe("stopped");
		const resumed = await http.burrows.resume(burrow.id);
		expect(resumed.state).toBe("active");
	});

	test("burrows.destroy returns the destroy summary", async () => {
		const burrow = seedBurrow(client);
		const result = await http.burrows.destroy(burrow.id, { archive: false });
		expect(result.burrowId).toBe(burrow.id);
		expect(result.archived).toBeNull();
		expect(client.burrows.tryGet(burrow.id)?.state).toBe("destroyed");
	});

	/* ------------------------------------------------------------------- */
	/* Runs                                                                */
	/* ------------------------------------------------------------------- */

	test("runs.create + get round-trips with Date fields", async () => {
		const burrow = seedBurrow(client);
		const run = await http.runs.create({
			burrowId: burrow.id,
			agentId: "mock-agent",
			prompt: "hello",
		});
		expect(run.state).toBe("queued");
		expect(run.queuedAt).toBeInstanceOf(Date);
		const fetched = await http.runs.get(run.id);
		expect(fetched.id).toBe(run.id);
		// SQLite drops sub-second precision (mx-9c4605); compare against a
		// re-read row rather than the in-memory create result.
		const persisted = client.runs.get(run.id);
		expect(fetched.queuedAt.getTime()).toBe(persisted.queuedAt.getTime());
	});

	test("runs.list requires burrowId over HTTP", async () => {
		expect(() => http.runs.list({})).toThrow(ValidationError);
	});

	test("runs.list per-burrow returns the runs", async () => {
		const burrow = seedBurrow(client);
		const a = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "a" });
		const b = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "b" });
		const rows = await http.runs.list({ burrowId: burrow.id });
		expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
	});

	test("runs.cancel marks the run cancelled", async () => {
		const burrow = seedBurrow(client);
		const run = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "x" });
		const cancelled = await http.runs.cancel(run.id);
		expect(cancelled.state).toBe("cancelled");
	});

	test("runs.tryGet returns null for unknown id", async () => {
		expect(await http.runs.tryGet("run_nope")).toBeNull();
	});

	/* ------------------------------------------------------------------- */
	/* Inbox                                                               */
	/* ------------------------------------------------------------------- */

	test("inbox.send + list + cancel + count", async () => {
		const burrow = seedBurrow(client);
		const sent = await http.inbox.send({ burrowId: burrow.id, body: "do it", priority: "high" });
		expect(sent.priority).toBe("high");
		expect(sent.createdAt).toBeInstanceOf(Date);
		expect(await http.inbox.count(burrow.id)).toBe(1);
		const listed = await http.inbox.list(burrow.id);
		expect(listed.map((m) => m.id)).toEqual([sent.id]);
		await http.inbox.cancel(sent.id);
		expect(await http.inbox.count(burrow.id)).toBe(0);
	});

	test("inbox.send rejects empty body via ValidationError", async () => {
		const burrow = seedBurrow(client);
		await expect(http.inbox.send({ burrowId: burrow.id, body: "" })).rejects.toBeInstanceOf(
			ValidationError,
		);
	});

	test("inbox.pending returns only unread", async () => {
		const burrow = seedBurrow(client);
		const m = client.inbox.send({ burrowId: burrow.id, body: "first" });
		const pending = await http.inbox.pending(burrow.id);
		expect(pending.map((p) => p.id)).toEqual([m.id]);
	});

	/* ------------------------------------------------------------------- */
	/* Events streaming                                                    */
	/* ------------------------------------------------------------------- */

	test("events.replay yields persisted rows with Date ts", async () => {
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
		const seen: { kind: string; seq: number; tsMs: number }[] = [];
		for await (const event of http.events.replay(burrow.id)) {
			expect(event.ts).toBeInstanceOf(Date);
			seen.push({ kind: event.kind, seq: event.seq, tsMs: event.ts.getTime() });
		}
		expect(seen).toEqual([
			{ kind: "tool_use", seq: 1, tsMs: 1000 },
			{ kind: "text", seq: 2, tsMs: 2000 },
		]);
	});

	test("events.tail with since= replays only seq>since", async () => {
		const burrow = seedBurrow(client);
		for (let i = 1; i <= 4; i += 1) {
			client.repos.events.append({
				burrowId: burrow.id,
				kind: "tool_use",
				stream: "stdout",
				payload: { i },
				ts: new Date(1000 * i),
			});
		}
		const seen: number[] = [];
		for await (const event of http.events.tail({ burrowId: burrow.id, since: 2, once: true })) {
			seen.push(event.seq);
		}
		expect(seen).toEqual([3, 4]);
	});

	test("events.tail with kinds filter and limit", async () => {
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
		const kinds: string[] = [];
		for await (const event of http.events.tail({
			burrowId: burrow.id,
			kinds: ["tool_use", "error"],
			limit: 2,
			once: true,
		})) {
			kinds.push(event.kind);
		}
		expect(kinds).toEqual(["tool_use", "error"]);
	});

	test("events.tail aborts cleanly on signal", async () => {
		const burrow = seedBurrow(client);
		client.repos.events.append({
			burrowId: burrow.id,
			kind: "tool_use",
			stream: "stdout",
			payload: {},
			ts: new Date(1000),
		});
		const ctrl = new AbortController();
		const iter = http.events.tail({
			burrowId: burrow.id,
			signal: ctrl.signal,
			pollIntervalMs: 50,
		});
		const first = await iter.next();
		expect(first.done).toBe(false);
		ctrl.abort();
		// The next read either yields done=true once the abort propagates or
		// rejects with AbortError. Either resolution proves the stream tore
		// down rather than hanging — that's the contract.
		try {
			const next = await iter.next();
			expect(next.done).toBe(true);
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
		}
	});

	test("events.tail without burrowId throws ValidationError synchronously", () => {
		expect(() => http.events.tail({})).toThrow(ValidationError);
	});

	/* ------------------------------------------------------------------- */
	/* Run stream                                                          */
	/* ------------------------------------------------------------------- */

	test("runs.stream filters to the requested runId", async () => {
		const burrow = seedBurrow(client);
		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "mock-agent",
			prompt: "x",
		});
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
		const seen: string[] = [];
		for await (const event of http.runs.stream(run.id, { limit: 1, pollIntervalMs: 10 })) {
			seen.push((event.payload as { match: boolean }).match ? "yes" : "no");
		}
		expect(seen).toEqual(["yes"]);
	});

	/* ------------------------------------------------------------------- */
	/* Agents                                                              */
	/* ------------------------------------------------------------------- */

	test("agents.list returns registered runtimes with install info", async () => {
		const detail = await http.agents.list();
		const ids = detail.map((d) => d.id).sort();
		expect(ids).toEqual(["mock-agent", "mock-oneshot"]);
		const mock = detail.find((d) => d.id === "mock-agent");
		expect(mock?.spawnPerTurn).toBe(true);
		expect(mock?.install.installed).toBe(true);
	});

	test("agents.get returns null for unknown id", async () => {
		expect(await http.agents.get("nope")).toBeNull();
		const detail = await http.agents.get("mock-agent");
		expect(detail?.id).toBe("mock-agent");
	});

	test("agents.has reflects the registry", async () => {
		expect(await http.agents.has("mock-agent")).toBe(true);
		expect(await http.agents.has("nope")).toBe(false);
	});
});

describe("HttpClient (auth + transport)", () => {
	let dataDir: string;
	let configDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkTmp("burrow-httpclient-auth-");
		configDir = mkTmp("burrow-httpclient-auth-cfg-");
		client = await Client.open({ dataDir, configDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(configDir, { recursive: true, force: true });
	});

	test("missing bearer token rejects every non-healthz route", async () => {
		const handle = startServer(client, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth("s3cr3t"),
			logger: silentLogger,
		});
		try {
			if (handle.transport.kind !== "tcp") throw new Error("expected tcp");
			const http = new HttpClient({ transport: handle.transport });
			await expect(http.burrows.list()).rejects.toBeInstanceOf(HttpClientError);
			// /healthz stays open without a token.
			await expect(http.healthz()).resolves.toBeUndefined();
		} finally {
			await handle.stop();
		}
	});

	test("valid bearer token authorizes every route", async () => {
		const handle = startServer(client, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth("s3cr3t"),
			logger: silentLogger,
		});
		try {
			if (handle.transport.kind !== "tcp") throw new Error("expected tcp");
			const http = new HttpClient({ transport: handle.transport, token: "s3cr3t" });
			const burrows = await http.burrows.list();
			expect(burrows).toEqual([]);
		} finally {
			await handle.stop();
		}
	});

	test("unix socket transport reaches the server end-to-end", async () => {
		const sockPath = join(tmpdir(), `burrow-httpclient-${process.pid}-${Date.now()}.sock`);
		const handle = startServer(client, {
			transport: { kind: "unix", path: sockPath },
			logger: silentLogger,
		});
		try {
			const http = new HttpClient({ transport: handle.transport });
			const burrow = client.repos.burrows.create({
				kind: "project",
				projectRoot: "/r",
				workspacePath: "/r/.ws",
				branch: "main",
				provider: "local",
				profile: {},
			});
			const fetched = await http.burrows.get(burrow.id);
			expect(fetched.id).toBe(burrow.id);
			expect(fetched.createdAt).toBeInstanceOf(Date);
		} finally {
			await handle.stop();
		}
	});
});
