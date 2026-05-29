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
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
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

	test("DELETE /burrows/:id accepts ?archive=0 (1/0 boolean grammar, burrow-8ce9)", async () => {
		// Aligns with the streaming endpoints' parseStreamBool grammar so curl
		// users can write `?archive=0` / `?archive=1` interchangeably with
		// `?archive=false` / `?archive=true`.
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}?archive=0`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
		expect(client.burrows.tryGet(burrow.id)?.state).toBe("destroyed");
	});

	test("DELETE /burrows/:id rejects ?archive=yes with 400 (burrow-8ce9)", async () => {
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}?archive=yes`, {
			method: "DELETE",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: { message?: string } };
		expect(body.error?.message).toContain("archive");
		expect(client.burrows.tryGet(burrow.id)?.state).not.toBe("destroyed");
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
	/* Workspace files (R-07, burrow-30c7)                                 */
	/* ------------------------------------------------------------------- */

	test("POST /burrows with `seed` writes files into the workspace before 201", async () => {
		const projectRoot = mkTmp();
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
		const res = await fetch(`${handle.url}/burrows`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				projectRoot,
				seed: {
					files: [
						{ path: ".canopy/agent.json", contents: '{"id":"x"}' },
						{ path: ".mulch/expertise/seed.jsonl", contents: "row\n" },
					],
				},
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as Burrow;
		const canopy = await readFile(join(body.workspacePath, ".canopy/agent.json"), "utf8");
		const mulch = await readFile(join(body.workspacePath, ".mulch/expertise/seed.jsonl"), "utf8");
		expect(canopy).toBe('{"id":"x"}');
		expect(mulch).toBe("row\n");
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("POST /burrows with seed path '..' → 400 and rolls back the burrow", async () => {
		const projectRoot = mkTmp();
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
		const before = client.burrows.list().length;
		const res = await fetch(`${handle.url}/burrows`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				projectRoot,
				seed: { files: [{ path: "../escape.txt", contents: "x" }] },
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
		// Rollback: the freshly-provisioned burrow is destroyed before we
		// return so the caller doesn't observe a partial-seed workspace.
		const active = client.burrows.list({ state: "active" });
		expect(active.length).toBe(before);
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("POST /burrows/:id/files writes files into the workspace", async () => {
		const ws = mkTmp();
		const burrow = seedBurrow(client, { workspacePath: ws });
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/files`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				files: [
					{ path: "notes.md", contents: "# hi", mode: 0o600 },
					{ path: "sub/nested.txt", contents: "deep" },
				],
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { written: number };
		expect(body.written).toBe(2);
		expect(await readFile(join(ws, "notes.md"), "utf8")).toBe("# hi");
		expect(await readFile(join(ws, "sub/nested.txt"), "utf8")).toBe("deep");
		rmSync(ws, { recursive: true, force: true });
	});

	test("POST /burrows/:id/files supports base64-encoded binary contents", async () => {
		const ws = mkTmp();
		const burrow = seedBurrow(client, { workspacePath: ws });
		const bytes = new Uint8Array([0, 1, 2, 254, 255]);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/files`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				files: [
					{
						path: "blob.bin",
						contents: Buffer.from(bytes).toString("base64"),
						encoding: "base64",
					},
				],
			}),
		});
		expect(res.status).toBe(200);
		const written = await readFile(join(ws, "blob.bin"));
		expect(Array.from(written)).toEqual(Array.from(bytes));
		rmSync(ws, { recursive: true, force: true });
	});

	test("POST /burrows/:id/files rejects '..' traversal with 400 and no partial writes", async () => {
		const ws = mkTmp();
		const burrow = seedBurrow(client, { workspacePath: ws });
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/files`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				files: [
					{ path: "ok.txt", contents: "first" },
					{ path: "../escape.txt", contents: "bad" },
				],
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
		// All-or-nothing: the prior valid entry was rejected with the bad one.
		await expect(readFile(join(ws, "ok.txt"))).rejects.toThrow();
		rmSync(ws, { recursive: true, force: true });
	});

	test("POST /burrows/:id/files rejects writes to .git/", async () => {
		const ws = mkTmp();
		const burrow = seedBurrow(client, { workspacePath: ws });
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/files`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ files: [{ path: ".git/HEAD", contents: "x" }] }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toMatch(/reserved/);
		rmSync(ws, { recursive: true, force: true });
	});

	test("POST /burrows/:id/files rejects symlink escape", async () => {
		const ws = mkTmp();
		const burrow = seedBurrow(client, { workspacePath: ws });
		await symlink("/etc", join(ws, "escape"));
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/files`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ files: [{ path: "escape/passwd", contents: "x" }] }),
		});
		expect(res.status).toBe(400);
		rmSync(ws, { recursive: true, force: true });
	});

	test("POST /burrows/:id/files for unknown id → 404", async () => {
		const res = await fetch(`${handle.url}/burrows/bur_nope/files`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ files: [{ path: "x.txt", contents: "x" }] }),
		});
		expect(res.status).toBe(404);
	});

	test("POST /burrows/:id/files with empty files[] → 400", async () => {
		const ws = mkTmp();
		const burrow = seedBurrow(client, { workspacePath: ws });
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/files`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ files: [] }),
		});
		expect(res.status).toBe(400);
		rmSync(ws, { recursive: true, force: true });
	});

	test("GET /burrows/:id/files?path= returns the file as utf-8 by default", async () => {
		const ws = mkTmp();
		const burrow = seedBurrow(client, { workspacePath: ws });
		await mkdir(join(ws, ".mulch"), { recursive: true });
		await writeFile(join(ws, ".mulch/records.jsonl"), "row\n", "utf8");
		const res = await fetch(
			`${handle.url}/burrows/${burrow.id}/files?path=${encodeURIComponent(".mulch/records.jsonl")}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { path: string; contents: string; encoding: string };
		expect(body.path).toBe(".mulch/records.jsonl");
		expect(body.contents).toBe("row\n");
		expect(body.encoding).toBe("utf-8");
		rmSync(ws, { recursive: true, force: true });
	});

	test("GET /burrows/:id/files?encoding=base64 round-trips binary bytes", async () => {
		const ws = mkTmp();
		const burrow = seedBurrow(client, { workspacePath: ws });
		const bytes = new Uint8Array([0, 1, 2, 254, 255]);
		await writeFile(join(ws, "blob.bin"), bytes);
		const res = await fetch(
			`${handle.url}/burrows/${burrow.id}/files?path=blob.bin&encoding=base64`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { contents: string; encoding: string };
		expect(body.encoding).toBe("base64");
		expect(Array.from(Buffer.from(body.contents, "base64"))).toEqual(Array.from(bytes));
		rmSync(ws, { recursive: true, force: true });
	});

	test("GET /burrows/:id/files for missing path → 404", async () => {
		const ws = mkTmp();
		const burrow = seedBurrow(client, { workspacePath: ws });
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/files?path=ghost.txt`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_found");
		rmSync(ws, { recursive: true, force: true });
	});

	test("GET /burrows/:id/files for unknown burrow → 404", async () => {
		const res = await fetch(`${handle.url}/burrows/bur_nope/files?path=x.txt`);
		expect(res.status).toBe(404);
	});

	/* ------------------------------------------------------------------- */
	/* Workspace file listing (burrow-18ca)                                */
	/* ------------------------------------------------------------------- */

	test("GET /burrows/:id/files (no path) lists workspace files recursively", async () => {
		const ws = mkTmp();
		const burrow = seedBurrow(client, { workspacePath: ws });
		await mkdir(join(ws, "sub", "deeper"), { recursive: true });
		await writeFile(join(ws, "top.txt"), "hello");
		await writeFile(join(ws, "sub", "mid.txt"), "mid");
		await writeFile(join(ws, "sub", "deeper", "leaf.txt"), "leaf");
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/files`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			files: { path: string; mode: number; size: number }[];
		};
		const paths = body.files.map((f) => f.path);
		expect(paths).toEqual(["sub/deeper/leaf.txt", "sub/mid.txt", "top.txt"]);
		const top = body.files.find((f) => f.path === "top.txt");
		expect(top?.size).toBe(5);
		expect(typeof top?.mode).toBe("number");
		rmSync(ws, { recursive: true, force: true });
	});

	test("GET /burrows/:id/files?prefix= scopes the listing to a subtree", async () => {
		const ws = mkTmp();
		const burrow = seedBurrow(client, { workspacePath: ws });
		await mkdir(join(ws, ".mulch", "expertise"), { recursive: true });
		await writeFile(join(ws, ".mulch", "expertise", "a.jsonl"), "x\n");
		await writeFile(join(ws, ".mulch", "expertise", "b.jsonl"), "y\n");
		await writeFile(join(ws, "ignored.txt"), "z");
		const res = await fetch(
			`${handle.url}/burrows/${burrow.id}/files?prefix=${encodeURIComponent(".mulch/expertise")}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { files: { path: string }[] };
		expect(body.files.map((f) => f.path)).toEqual([
			".mulch/expertise/a.jsonl",
			".mulch/expertise/b.jsonl",
		]);
		rmSync(ws, { recursive: true, force: true });
	});

	test("GET /burrows/:id/files (no path) excludes reserved entries from the top-level listing", async () => {
		const ws = mkTmp();
		const burrow = seedBurrow(client, { workspacePath: ws });
		await mkdir(join(ws, ".git", "objects"), { recursive: true });
		await writeFile(join(ws, ".git", "HEAD"), "ref: x");
		await writeFile(join(ws, ".gitconfig.burrow"), "[user]\nname=x");
		await writeFile(join(ws, "real.txt"), "ok");
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/files`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { files: { path: string }[] };
		const paths = body.files.map((f) => f.path);
		expect(paths).toEqual(["real.txt"]);
		expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
		rmSync(ws, { recursive: true, force: true });
	});

	test("GET /burrows/:id/files lists in-workspace symlinks without traversing them", async () => {
		const ws = mkTmp();
		const burrow = seedBurrow(client, { workspacePath: ws });
		await mkdir(join(ws, "real"), { recursive: true });
		await writeFile(join(ws, "real", "f.txt"), "x");
		await symlink("real", join(ws, "alias"));
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/files`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { files: { path: string }[] };
		const paths = body.files.map((f) => f.path);
		expect(paths).toContain("real/f.txt");
		expect(paths).toContain("alias");
		// Symlink is listed but not recursed — no "alias/f.txt" entry.
		expect(paths.some((p) => p.startsWith("alias/"))).toBe(false);
		rmSync(ws, { recursive: true, force: true });
	});

	test("GET /burrows/:id/files?prefix=.. rejects with 400", async () => {
		const ws = mkTmp();
		const burrow = seedBurrow(client, { workspacePath: ws });
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/files?prefix=..`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
		rmSync(ws, { recursive: true, force: true });
	});

	test("GET /burrows/:id/files?prefix=.git rejects (reserved entry)", async () => {
		const ws = mkTmp();
		const burrow = seedBurrow(client, { workspacePath: ws });
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/files?prefix=.git`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.message).toMatch(/reserved/);
		rmSync(ws, { recursive: true, force: true });
	});

	test("GET /burrows/:id/files?prefix= with non-existent dir → 404", async () => {
		const ws = mkTmp();
		const burrow = seedBurrow(client, { workspacePath: ws });
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/files?prefix=does/not/exist`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_found");
		rmSync(ws, { recursive: true, force: true });
	});

	test("GET /burrows/:id/files (no path) on unknown burrow → 404", async () => {
		const res = await fetch(`${handle.url}/burrows/bur_nope/files`);
		expect(res.status).toBe(404);
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

	test("GET /burrows/:id/events?limit=10abc → 400 (rejects trailing garbage)", async () => {
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/events?follow=0&limit=10abc`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: { message?: string } };
		expect(body.error?.message).toContain("limit must be a positive integer");
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
