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
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
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

function tcpBaseUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
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

	test("burrows.up provisions a project burrow with rehydrated dates", async () => {
		const projectRoot = mkTmp("burrow-httpclient-proj-");
		client.burrows.setUpOverrides({
			skipDoctor: true,
			materializer: async (opts) => ({
				workspacePath: opts.workspacePath,
				source: { kind: "worktree", branch: opts.branch, hostClonePath: "/host" },
				identity: null,
			}),
		});
		const burrow = await http.burrows.up({
			projectRoot,
			name: "web",
			branch: "feature/x",
		});
		expect(burrow.id.startsWith("bur_")).toBe(true);
		expect(burrow.kind).toBe("project");
		expect(burrow.name).toBe("web");
		expect(burrow.createdAt).toBeInstanceOf(Date);
		expect(client.burrows.get(burrow.id).id).toBe(burrow.id);
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("burrows.up forwards seed.files into the new workspace before resolving", async () => {
		const projectRoot = mkTmp("burrow-httpclient-proj-");
		client.burrows.setUpOverrides({
			skipDoctor: true,
			materializer: async (opts) => {
				await mkdir(opts.workspacePath, { recursive: true });
				return {
					workspacePath: opts.workspacePath,
					source: { kind: "worktree", branch: opts.branch, hostClonePath: "/host" },
					identity: null,
				};
			},
		});
		const burrow = await http.burrows.up({
			projectRoot,
			seed: {
				files: [
					{ path: ".canopy/agent.json", contents: '{"id":"x"}' },
					{ path: ".mulch/expertise/seed.jsonl", contents: "row\n" },
				],
			},
		});
		expect(await readFile(join(burrow.workspacePath, ".canopy/agent.json"), "utf8")).toBe(
			'{"id":"x"}',
		);
		expect(await readFile(join(burrow.workspacePath, ".mulch/expertise/seed.jsonl"), "utf8")).toBe(
			"row\n",
		);
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("burrows.up rejects bad seed paths and rolls the burrow back", async () => {
		const projectRoot = mkTmp("burrow-httpclient-proj-");
		client.burrows.setUpOverrides({
			skipDoctor: true,
			materializer: async (opts) => {
				await mkdir(opts.workspacePath, { recursive: true });
				return {
					workspacePath: opts.workspacePath,
					source: { kind: "worktree", branch: opts.branch, hostClonePath: "/host" },
					identity: null,
				};
			},
		});
		client.burrows.setDestroyOverrides({ removeWorkspace: async () => {} });
		const before = client.burrows.list({ state: "active" }).length;
		await expect(
			http.burrows.up({
				projectRoot,
				seed: { files: [{ path: "../escape.txt", contents: "x" }] },
			}),
		).rejects.toBeInstanceOf(ValidationError);
		// Rollback: no active burrow leaks past the failed seed write.
		expect(client.burrows.list({ state: "active" }).length).toBe(before);
		rmSync(projectRoot, { recursive: true, force: true });
	});

	/* ------------------------------------------------------------------- */
	/* body.env round-trip (burrow-5322 / pl-96ca step 2)                  */
	/* ------------------------------------------------------------------- */
	/* HttpBurrowsClient.up doesn't expose `env` yet, so these tests POST */
	/* raw bodies to /burrows to lock the route-handler contract added in */
	/* burrow-be5b: body.env → parseEnvMap → input.envOverrides →         */
	/* resolveEnv → SandboxProfile.setEnv.                                */

	test("POST /burrows threads body.env into the resolved SandboxProfile.setEnv", async () => {
		const projectRoot = mkTmp("burrow-httpclient-proj-");
		client.burrows.setUpOverrides({
			skipDoctor: true,
			materializer: async (opts) => ({
				workspacePath: opts.workspacePath,
				source: { kind: "worktree", branch: opts.branch, hostClonePath: "/host" },
				identity: null,
			}),
		});
		const baseUrl = tcpBaseUrl(handle);
		const res = await fetch(`${baseUrl}/burrows`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectRoot, env: { FOO: "bar", PLOT_ID: "p-1" } }),
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as { id: string };
		const persisted = client.burrows.get(created.id);
		// resolveEnv flattens overrides into the SandboxProfile.setEnv map
		// the runner hands to the sandbox provider — that's the contract
		// warren-a346 needs for PLOT_ID/PLOT_ACTOR to land in the sandbox.
		const setEnv = (persisted.profileJson as { setEnv?: Record<string, string> }).setEnv;
		expect(setEnv?.FOO).toBe("bar");
		expect(setEnv?.PLOT_ID).toBe("p-1");
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("POST /burrows without body.env leaves setEnv free of caller-injected keys", async () => {
		const projectRoot = mkTmp("burrow-httpclient-proj-");
		client.burrows.setUpOverrides({
			skipDoctor: true,
			materializer: async (opts) => ({
				workspacePath: opts.workspacePath,
				source: { kind: "worktree", branch: opts.branch, hostClonePath: "/host" },
				identity: null,
			}),
		});
		const baseUrl = tcpBaseUrl(handle);
		const res = await fetch(`${baseUrl}/burrows`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectRoot }),
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as { id: string };
		const persisted = client.burrows.get(created.id);
		const setEnv = (persisted.profileJson as { setEnv?: Record<string, string> }).setEnv ?? {};
		// Acceptance #3: missing body.env is byte-identical to today — no
		// FOO leaks in from a stale envOverrides assignment.
		expect(setEnv.FOO).toBeUndefined();
		expect(setEnv.PLOT_ID).toBeUndefined();
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("POST /burrows rejects body.env shaped as an array with the parseEnvMap validation envelope", async () => {
		const projectRoot = mkTmp("burrow-httpclient-proj-");
		client.burrows.setUpOverrides({
			skipDoctor: true,
			materializer: async (opts) => ({
				workspacePath: opts.workspacePath,
				source: { kind: "worktree", branch: opts.branch, hostClonePath: "/host" },
				identity: null,
			}),
		});
		const baseUrl = tcpBaseUrl(handle);
		const before = client.burrows.list({ state: "active" }).length;
		const res = await fetch(`${baseUrl}/burrows`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectRoot, env: ["FOO=bar"] }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.message).toBe("field 'env' must be a JSON object of string→string");
		// Validation fires before client.burrows.up() — no half-provisioned row.
		expect(client.burrows.list({ state: "active" }).length).toBe(before);
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("POST /burrows rejects body.env with a non-string value", async () => {
		const projectRoot = mkTmp("burrow-httpclient-proj-");
		client.burrows.setUpOverrides({
			skipDoctor: true,
			materializer: async (opts) => ({
				workspacePath: opts.workspacePath,
				source: { kind: "worktree", branch: opts.branch, hostClonePath: "/host" },
				identity: null,
			}),
		});
		const baseUrl = tcpBaseUrl(handle);
		const res = await fetch(`${baseUrl}/burrows`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectRoot, env: { COUNT: 42 } }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.message).toBe("field 'env.COUNT' must be a string");
		rmSync(projectRoot, { recursive: true, force: true });
	});

	/* ------------------------------------------------------------------- */
	/* Workspace files (R-07)                                              */
	/* ------------------------------------------------------------------- */

	test("files.write writes utf-8 entries and returns the count", async () => {
		const ws = mkTmp("burrow-httpclient-ws-");
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/tmp/proj",
			workspacePath: ws,
			branch: "main",
			provider: "local",
			profile: {},
		});
		const result = await http.files.write(burrow.id, [
			{ path: "notes.md", contents: "# hi", mode: 0o600 },
			{ path: "sub/nested.txt", contents: "deep" },
		]);
		expect(result.written).toBe(2);
		expect(await readFile(join(ws, "notes.md"), "utf8")).toBe("# hi");
		expect(await readFile(join(ws, "sub/nested.txt"), "utf8")).toBe("deep");
		rmSync(ws, { recursive: true, force: true });
	});

	test("files.write supports base64-encoded binary contents", async () => {
		const ws = mkTmp("burrow-httpclient-ws-");
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/tmp/proj",
			workspacePath: ws,
			branch: "main",
			provider: "local",
			profile: {},
		});
		const bytes = new Uint8Array([0, 1, 2, 254, 255]);
		await http.files.write(burrow.id, [
			{
				path: "blob.bin",
				contents: Buffer.from(bytes).toString("base64"),
				encoding: "base64",
			},
		]);
		const written = await readFile(join(ws, "blob.bin"));
		expect(Array.from(written)).toEqual(Array.from(bytes));
		rmSync(ws, { recursive: true, force: true });
	});

	test("files.write rehydrates ValidationError on traversal escape", async () => {
		const ws = mkTmp("burrow-httpclient-ws-");
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/tmp/proj",
			workspacePath: ws,
			branch: "main",
			provider: "local",
			profile: {},
		});
		await expect(
			http.files.write(burrow.id, [
				{ path: "ok.txt", contents: "first" },
				{ path: "../escape.txt", contents: "bad" },
			]),
		).rejects.toBeInstanceOf(ValidationError);
		// All-or-nothing: the prior valid entry was rejected with the bad one.
		await expect(readFile(join(ws, "ok.txt"))).rejects.toThrow();
		rmSync(ws, { recursive: true, force: true });
	});

	test("files.write rejects symlink escape from within the workspace", async () => {
		const ws = mkTmp("burrow-httpclient-ws-");
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/tmp/proj",
			workspacePath: ws,
			branch: "main",
			provider: "local",
			profile: {},
		});
		await symlink("/etc", join(ws, "escape"));
		await expect(
			http.files.write(burrow.id, [{ path: "escape/passwd", contents: "x" }]),
		).rejects.toBeInstanceOf(ValidationError);
		rmSync(ws, { recursive: true, force: true });
	});

	test("files.read returns utf-8 contents by default", async () => {
		const ws = mkTmp("burrow-httpclient-ws-");
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/tmp/proj",
			workspacePath: ws,
			branch: "main",
			provider: "local",
			profile: {},
		});
		await mkdir(join(ws, ".mulch"), { recursive: true });
		await writeFile(join(ws, ".mulch/records.jsonl"), "row\n", "utf8");
		const out = await http.files.read(burrow.id, ".mulch/records.jsonl");
		expect(out.path).toBe(".mulch/records.jsonl");
		expect(out.contents).toBe("row\n");
		expect(out.encoding).toBe("utf-8");
		rmSync(ws, { recursive: true, force: true });
	});

	test("files.read with encoding=base64 round-trips binary bytes", async () => {
		const ws = mkTmp("burrow-httpclient-ws-");
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/tmp/proj",
			workspacePath: ws,
			branch: "main",
			provider: "local",
			profile: {},
		});
		const bytes = new Uint8Array([0, 1, 2, 254, 255]);
		await writeFile(join(ws, "blob.bin"), bytes);
		const out = await http.files.read(burrow.id, "blob.bin", { encoding: "base64" });
		expect(out.encoding).toBe("base64");
		expect(Array.from(Buffer.from(out.contents, "base64"))).toEqual(Array.from(bytes));
		rmSync(ws, { recursive: true, force: true });
	});

	test("files.read throws NotFoundError when the file is missing", async () => {
		const ws = mkTmp("burrow-httpclient-ws-");
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/tmp/proj",
			workspacePath: ws,
			branch: "main",
			provider: "local",
			profile: {},
		});
		await expect(http.files.read(burrow.id, "ghost.txt")).rejects.toBeInstanceOf(NotFoundError);
		rmSync(ws, { recursive: true, force: true });
	});

	test("files.write on unknown burrow throws NotFoundError", async () => {
		await expect(
			http.files.write("bur_nope", [{ path: "x.txt", contents: "x" }]),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("files.list returns recursive workspace entries", async () => {
		const ws = mkTmp("burrow-httpclient-ws-");
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/tmp/proj",
			workspacePath: ws,
			branch: "main",
			provider: "local",
			profile: {},
		});
		await mkdir(join(ws, ".mulch", "expertise"), { recursive: true });
		await writeFile(join(ws, ".mulch/expertise/a.jsonl"), "row\n");
		await writeFile(join(ws, "top.txt"), "hi");
		const result = await http.files.list(burrow.id);
		expect(result.files.map((f) => f.path)).toEqual([".mulch/expertise/a.jsonl", "top.txt"]);
		const a = result.files.find((f) => f.path === ".mulch/expertise/a.jsonl");
		expect(a?.size).toBe(4);
		expect(typeof a?.mode).toBe("number");
		rmSync(ws, { recursive: true, force: true });
	});

	test("files.list with prefix scopes the walk", async () => {
		const ws = mkTmp("burrow-httpclient-ws-");
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/tmp/proj",
			workspacePath: ws,
			branch: "main",
			provider: "local",
			profile: {},
		});
		await mkdir(join(ws, ".mulch", "expertise"), { recursive: true });
		await writeFile(join(ws, ".mulch/expertise/a.jsonl"), "x");
		await writeFile(join(ws, "other.txt"), "ignored");
		const result = await http.files.list(burrow.id, { prefix: ".mulch/expertise" });
		expect(result.files.map((f) => f.path)).toEqual([".mulch/expertise/a.jsonl"]);
		rmSync(ws, { recursive: true, force: true });
	});

	test("files.list rehydrates ValidationError on bad prefix", async () => {
		const ws = mkTmp("burrow-httpclient-ws-");
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/tmp/proj",
			workspacePath: ws,
			branch: "main",
			provider: "local",
			profile: {},
		});
		await expect(http.files.list(burrow.id, { prefix: ".." })).rejects.toBeInstanceOf(
			ValidationError,
		);
		rmSync(ws, { recursive: true, force: true });
	});

	test("files.list rehydrates NotFoundError on missing prefix dir", async () => {
		const ws = mkTmp("burrow-httpclient-ws-");
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/tmp/proj",
			workspacePath: ws,
			branch: "main",
			provider: "local",
			profile: {},
		});
		await expect(http.files.list(burrow.id, { prefix: "does/not/exist" })).rejects.toBeInstanceOf(
			NotFoundError,
		);
		rmSync(ws, { recursive: true, force: true });
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

	test("runs.cancel forwards the optional reason", async () => {
		const burrow = seedBurrow(client);
		const run = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "x" });
		const cancelled = await http.runs.cancel(run.id, { reason: "deploy rolled back" });
		expect(cancelled.state).toBe("cancelled");
		expect(cancelled.errorMessage).toBe("deploy rolled back");
	});

	test("runs.cancel is idempotent over HTTP", async () => {
		const burrow = seedBurrow(client);
		const run = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "x" });
		await http.runs.cancel(run.id);
		const second = await http.runs.cancel(run.id);
		expect(second.state).toBe("cancelled");
	});

	test("runs.delete removes a terminal run", async () => {
		const burrow = seedBurrow(client);
		const run = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "x" });
		await http.runs.cancel(run.id);
		await http.runs.delete(run.id);
		expect(client.runs.tryGet(run.id)).toBeNull();
	});

	test("runs.delete on non-terminal run throws ValidationError", async () => {
		const burrow = seedBurrow(client);
		const run = client.runs.create({ burrowId: burrow.id, agentId: "mock-agent", prompt: "x" });
		await expect(http.runs.delete(run.id)).rejects.toBeInstanceOf(ValidationError);
		expect(client.runs.tryGet(run.id)?.id).toBe(run.id);
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

	test("events.tail surfaces ValidationError on malformed NDJSON line", async () => {
		// Inject a fake fetch that hands back a hand-rolled NDJSON body: one
		// well-formed envelope followed by a garbage line. The contract under
		// test is that the second line raises a typed ValidationError instead
		// of leaking SyntaxError out of the for-await loop (sd burrow-db13).
		const valid = JSON.stringify({
			seq: 1,
			burrowId: "b1",
			runId: null,
			kind: "text",
			stream: "stdout",
			payload: { text: "ok" },
			ts: new Date(1000).toISOString(),
		});
		const body = `${valid}\n{not json\n`;
		const fakeFetch = (async () =>
			new Response(body, {
				status: 200,
				headers: { "content-type": "application/x-ndjson" },
			})) as unknown as typeof fetch;
		const client = new HttpClient({
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 1 },
			fetch: fakeFetch,
		});
		const iter = client.events.tail({ burrowId: "b1", once: true });
		const first = await iter.next();
		expect(first.done).toBe(false);
		expect(first.value?.kind).toBe("text");
		let caught: unknown;
		try {
			await iter.next();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ValidationError);
		expect((caught as ValidationError).message).toContain("malformed NDJSON");
		expect((caught as ValidationError).cause).toBeInstanceOf(SyntaxError);
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
