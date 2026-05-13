/**
 * `POST /admin/drain` + drain-gated CRUD (pl-cb3e step 4 / burrow-79ad).
 *
 * Two layers of behaviour to lock down:
 *   1. The admin route itself: body validation, idempotency, echoes
 *      the new state.
 *   2. The drain gate: while drain is set, `POST /burrows` and
 *      `POST /burrows/:id/runs` return 503 `worker_draining`; reads,
 *      lifecycle endpoints, and streaming surfaces keep working;
 *      in-flight runs continue to terminal state.
 *
 * Tests boot a real `Client` + `RunDispatcher` so the dispatcher's drain
 * controller is the same instance the HTTP layer reads — exactly the
 * shape `runServeCommand` wires in production.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Burrow, Run } from "../core/types.ts";
import { Client } from "../lib/client.ts";
import { createLogger } from "../logging/logger.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../provider/types.ts";
import type { SpawnFn } from "../runner/dispatch.ts";
import { startRunDispatcher } from "../runner/dispatcher.ts";
import type { AgentRuntime, InstallCheckResult } from "../runtime/runtime.ts";
import { startServer } from "./server.ts";
import type { ServeHandle } from "./types.ts";

const silentLogger = createLogger({ level: "fatal" });

function mkTmp(): string {
	return mkdtempSync(join(tmpdir(), "burrow-admin-"));
}

function makeMockAgent(id: string): AgentRuntime {
	return {
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
}

function seedBurrow(client: Client, workspacePath = "/tmp/proj/.ws"): Burrow {
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
		projectRoot: "/tmp/proj",
		workspacePath,
		branch: "main",
		provider: "local",
		profile,
	});
}

interface FakeSpawnControl {
	calls: number;
	releaseExit?: () => void;
}

/**
 * Fake spawn that streams a single line of stdout and waits for the test
 * to release exit. Used for the in-flight-during-drain test so we can
 * keep a run "running" while flipping drain on, then complete it and
 * confirm it terminates normally.
 */
function controllableSpawn(control: FakeSpawnControl): SpawnFn {
	return async (_profile: SandboxProfile, _command: SpawnCommand): Promise<SpawnResult> => {
		control.calls += 1;
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
		control.releaseExit = () => resolveExit(0);
		return {
			pid: 9000,
			stdout,
			stderr,
			exited,
			cancel: () => resolveExit(130),
		};
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe("POST /admin/drain", () => {
	let dataDir: string;
	let configDir: string;
	let client: Client;
	let dispatcher: ReturnType<typeof startRunDispatcher>;
	let handle: ServeHandle;

	beforeEach(async () => {
		dataDir = mkTmp();
		configDir = mkTmp();
		client = await Client.open({ dataDir, configDir });
		for (const rt of client.agents.list()) client.agents.unregister(rt.id);
		client.agents.register(makeMockAgent("mock"));
		dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: controllableSpawn({ calls: 0 }),
		});
		dispatcher.start();
		handle = startServer(client, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			logger: silentLogger,
			admin: { drain: dispatcher.drain },
		});
	});

	afterEach(async () => {
		await handle.stop();
		await dispatcher.stop({ force: true });
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(configDir, { recursive: true, force: true });
	});

	test("flipping drain on returns 200 and echoes the new state", async () => {
		expect(dispatcher.drain.isDraining()).toBe(false);
		const res = await fetch(`${handle.url}/admin/drain`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ drain: true }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { drain: boolean };
		expect(body.drain).toBe(true);
		expect(dispatcher.drain.isDraining()).toBe(true);
	});

	test("flipping drain off restores acceptance and is idempotent", async () => {
		dispatcher.drain.setDrain(true);
		// First flip-off: 200, drain=false.
		const off1 = await fetch(`${handle.url}/admin/drain`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ drain: false }),
		});
		expect(off1.status).toBe(200);
		expect(((await off1.json()) as { drain: boolean }).drain).toBe(false);
		// Second identical call: still 200, no-op.
		const off2 = await fetch(`${handle.url}/admin/drain`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ drain: false }),
		});
		expect(off2.status).toBe(200);
		expect(dispatcher.drain.isDraining()).toBe(false);
	});

	test("missing 'drain' field → 400 validation_error", async () => {
		const res = await fetch(`${handle.url}/admin/drain`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.message).toContain("drain");
	});

	test("non-boolean 'drain' field → 400 (no string coercion)", async () => {
		const res = await fetch(`${handle.url}/admin/drain`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ drain: "true" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});

	test("empty body → 400", async () => {
		const res = await fetch(`${handle.url}/admin/drain`, { method: "POST" });
		expect(res.status).toBe(400);
	});

	test("GET /admin/drain → 405 method_not_allowed (path exists, wrong verb)", async () => {
		const res = await fetch(`${handle.url}/admin/drain`);
		expect(res.status).toBe(405);
	});
});

describe("drain-gated POST /burrows + POST /burrows/:id/runs", () => {
	let dataDir: string;
	let configDir: string;
	let client: Client;
	let dispatcher: ReturnType<typeof startRunDispatcher>;
	let handle: ServeHandle;
	let spawnControl: FakeSpawnControl;

	beforeEach(async () => {
		dataDir = mkTmp();
		configDir = mkTmp();
		client = await Client.open({ dataDir, configDir });
		for (const rt of client.agents.list()) client.agents.unregister(rt.id);
		client.agents.register(makeMockAgent("mock"));
		spawnControl = { calls: 0 };
		dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: controllableSpawn(spawnControl),
		});
		dispatcher.start();
		handle = startServer(client, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			logger: silentLogger,
			admin: { drain: dispatcher.drain },
		});
	});

	afterEach(async () => {
		await handle.stop();
		await dispatcher.stop({ force: true });
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(configDir, { recursive: true, force: true });
	});

	test("POST /burrows/:id/runs returns 503 worker_draining while draining", async () => {
		const burrow = seedBurrow(client);
		dispatcher.drain.setDrain(true);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agentId: "mock", prompt: "p" }),
		});
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: { code: string; message: string; hint?: string } };
		expect(body.error.code).toBe("worker_draining");
		expect(body.error.message).toMatch(/draining/);
		expect(body.error.hint).toContain("/admin/drain");
	});

	test("POST /burrows returns 503 worker_draining while draining", async () => {
		dispatcher.drain.setDrain(true);
		const res = await fetch(`${handle.url}/burrows`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectRoot: "/repos/web" }),
		});
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("worker_draining");
	});

	test("flipping drain off restores acceptance: subsequent POST /burrows/:id/runs succeeds", async () => {
		const burrow = seedBurrow(client);
		dispatcher.drain.setDrain(true);
		const denied = await fetch(`${handle.url}/burrows/${burrow.id}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agentId: "mock", prompt: "p" }),
		});
		expect(denied.status).toBe(503);
		await fetch(`${handle.url}/admin/drain`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ drain: false }),
		});
		const accepted = await fetch(`${handle.url}/burrows/${burrow.id}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agentId: "mock", prompt: "p" }),
		});
		expect(accepted.status).toBe(201);
		const run = (await accepted.json()) as Run;
		expect(run.id.startsWith("run_")).toBe(true);
	});

	test("reads + lifecycle pass through unchanged while draining (only creates are gated)", async () => {
		const burrow = seedBurrow(client);
		dispatcher.drain.setDrain(true);

		// GET /burrows/:id — still works
		const getRes = await fetch(`${handle.url}/burrows/${burrow.id}`);
		expect(getRes.status).toBe(200);

		// GET /burrows — still works
		const listRes = await fetch(`${handle.url}/burrows`);
		expect(listRes.status).toBe(200);

		// POST /burrows/:id/stop — lifecycle, not creation: still works
		const stopRes = await fetch(`${handle.url}/burrows/${burrow.id}/stop`, { method: "POST" });
		expect(stopRes.status).toBe(200);

		// POST /burrows/:id/resume — lifecycle: still works
		const resumeRes = await fetch(`${handle.url}/burrows/${burrow.id}/resume`, { method: "POST" });
		expect(resumeRes.status).toBe(200);

		// POST /burrows/:id/inbox — message send is steering for in-flight
		// runs, NOT new work; must remain accepted so operators can guide
		// runs that survive into the drain window.
		const inboxRes = await fetch(`${handle.url}/burrows/${burrow.id}/inbox`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ body: "ping" }),
		});
		expect(inboxRes.status).toBe(201);
	});

	test("in-flight runs continue to terminal state after drain is set mid-run", async () => {
		const burrow = seedBurrow(client);
		// Enqueue a run BEFORE drain. The fake spawn parks at exit until
		// `releaseExit()` is called, so we have a deterministic running
		// window in which to flip drain.
		const create = await fetch(`${handle.url}/burrows/${burrow.id}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agentId: "mock", prompt: "in-flight" }),
		});
		expect(create.status).toBe(201);
		const run = (await create.json()) as Run;

		// Wait for the dispatcher to pick the run up and reach the spawn.
		await waitFor(() => spawnControl.releaseExit !== undefined);

		// Flip drain ON while the run is in flight.
		dispatcher.drain.setDrain(true);

		// New POSTs are gated.
		const denied = await fetch(`${handle.url}/burrows/${burrow.id}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agentId: "mock", prompt: "denied" }),
		});
		expect(denied.status).toBe(503);

		// Release the in-flight spawn — it should still drive to terminal.
		spawnControl.releaseExit?.();
		await waitFor(() => client.runs.get(run.id).state === "succeeded", 2000);
		expect(client.runs.get(run.id).state).toBe("succeeded");
	});
});

describe("admin opt-out (no admin controls in ServeOptions)", () => {
	let dataDir: string;
	let configDir: string;
	let client: Client;
	let handle: ServeHandle;

	beforeEach(async () => {
		dataDir = mkTmp();
		configDir = mkTmp();
		client = await Client.open({ dataDir, configDir });
		for (const rt of client.agents.list()) client.agents.unregister(rt.id);
		client.agents.register(makeMockAgent("mock"));
		// No admin → no drain gate, no /admin/drain route.
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

	test("/admin/drain is unmounted → 404", async () => {
		const res = await fetch(`${handle.url}/admin/drain`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ drain: true }),
		});
		expect(res.status).toBe(404);
	});

	test("POST /burrows/:id/runs is not gated when admin is unconfigured", async () => {
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agentId: "mock", prompt: "p" }),
		});
		// 201 success, NOT 503 — without admin, drain doesn't exist.
		expect(res.status).toBe(201);
	});
});
