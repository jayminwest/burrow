/**
 * End-to-end integration tests against a real `burrow serve` subprocess
 * (pl-5b40 step 7 / acceptance #1, #3, #5, #6).
 *
 * Every other test in the server tree boots `startServer` in-process so the
 * route table, handlers, and HttpClient run in the same Bun event loop. Those
 * are great wire-shape tests but they don't exercise the actual CLI binary
 * lifecycle (arg parsing, env-driven path resolution, SIGINT/SIGTERM
 * shutdown, multi-process SQLite access). This file does — each test spawns
 * `bun src/cli/main.ts serve --json …` with `BURROW_DATA_DIR/CONFIG_DIR/
 * CACHE_DIR` pointed at fresh tmp dirs, parses the startup banner off
 * stdout, exercises the surface via `HttpClient`, then sends SIGTERM and
 * asserts a clean exit.
 *
 * Two specific contracts these tests lock that the in-process suites can't:
 *   1. SIGINT/SIGTERM shutdown completes within 1s (acceptance #1).
 *   2. NDJSON wire bytes from `GET /events?follow=0` match what the CLI's
 *      `renderNdjson` produces over the same input (acceptance #3 — the
 *      one-wire-shape promise that lets a single client lib target both).
 *
 * Pre-seeding goes through a second `Client` opened against the same DB —
 * SQLite WAL (`src/db/client.ts:configurePragmas`) makes that safe across
 * processes; drizzle migrations are idempotent so the order of opens
 * doesn't matter.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Burrow, RunEvent } from "../core/types.ts";
import { eventToEnvelope } from "../events/render.ts";
import { Client } from "../lib/client.ts";
import { HttpClient, HttpClientError } from "../lib/http-client.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_MAIN = resolve(REPO_ROOT, "src", "cli", "main.ts");

interface ServeBanner {
	url: string;
	transport: { kind: "tcp"; hostname: string; port: number } | { kind: "unix"; path: string };
	authMode: "bearer" | "none";
	pid: number;
}

interface ServeProc {
	proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	banner: ServeBanner;
	/** Captures every byte written to stderr, for debugging on failure. */
	readonly stderr: () => string;
	/** Captures every byte written to stdout *after* the banner line. */
	readonly stdout: () => string;
	/**
	 * Send `signal` (default SIGTERM), await `proc.exited`, and report the
	 * wall-clock elapsed. Acceptance #1 caps this at 1000ms.
	 */
	stop(signal?: NodeJS.Signals): Promise<{
		elapsedMs: number;
		exitCode: number;
		signalCode: NodeJS.Signals | null;
	}>;
}

async function spawnServe(opts: {
	dataDir: string;
	args?: readonly string[];
	envOverrides?: Record<string, string>;
}): Promise<ServeProc> {
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		BURROW_DATA_DIR: opts.dataDir,
		BURROW_CONFIG_DIR: opts.dataDir,
		BURROW_CACHE_DIR: opts.dataDir,
		// The default logger writes to stderr; keep the subprocess quiet so
		// banner parsing isn't fighting structured log lines.
		LOG_LEVEL: "fatal",
		...opts.envOverrides,
	};

	const proc = Bun.spawn(
		[process.execPath, "run", CLI_MAIN, "serve", "--json", ...(opts.args ?? [])],
		{
			env,
			stdout: "pipe",
			stderr: "pipe",
			cwd: REPO_ROOT,
		},
	);

	let stdoutBuf = "";
	let stderrBuf = "";
	const decoder = new TextDecoder();

	// Drain stderr in the background to avoid backpressure deadlocks. Any
	// startup failure ends up here, so the spawn helper surfaces it on
	// exit-before-banner.
	const drainStderr = async (): Promise<void> => {
		const reader = proc.stderr.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				stderrBuf += decoder.decode(value, { stream: true });
			}
		} finally {
			reader.releaseLock();
		}
	};
	void drainStderr();

	// Read stdout until the first newline. The banner is one JSON object
	// terminated by '\n'; everything after is post-startup output we capture
	// for debugging but don't block on.
	const stdoutReader = proc.stdout.getReader();
	let banner: ServeBanner | null = null;
	let preBanner = "";
	while (banner === null) {
		const { done, value } = await stdoutReader.read();
		if (done) {
			stdoutReader.releaseLock();
			throw new Error(`burrow serve exited before printing the banner. stderr:\n${stderrBuf}`);
		}
		preBanner += decoder.decode(value, { stream: true });
		const nl = preBanner.indexOf("\n");
		if (nl < 0) continue;
		const line = preBanner.slice(0, nl);
		preBanner = preBanner.slice(nl + 1);
		try {
			banner = JSON.parse(line) as ServeBanner;
		} catch {
			stdoutReader.releaseLock();
			throw new Error(
				`first stdout line was not JSON. line=${JSON.stringify(line)} stderr=${stderrBuf}`,
			);
		}
	}
	stdoutBuf = preBanner;

	// Continue draining stdout in the background.
	const drainStdout = async (): Promise<void> => {
		try {
			while (true) {
				const { done, value } = await stdoutReader.read();
				if (done) break;
				stdoutBuf += decoder.decode(value, { stream: true });
			}
		} finally {
			stdoutReader.releaseLock();
		}
	};
	void drainStdout();

	return {
		proc,
		banner,
		stderr: () => stderrBuf,
		stdout: () => stdoutBuf,
		stop: async (signal: NodeJS.Signals = "SIGTERM") => {
			const startedAt = Date.now();
			proc.kill(signal);
			const exitCode = await proc.exited;
			return {
				elapsedMs: Date.now() - startedAt,
				exitCode,
				signalCode: proc.signalCode,
			};
		},
	};
}

function tcpBanner(banner: ServeBanner): { kind: "tcp"; hostname: string; port: number } {
	if (banner.transport.kind !== "tcp") {
		throw new Error(`expected tcp transport, got ${banner.transport.kind}`);
	}
	return banner.transport;
}

function seedBurrow(client: Client, branch = "main"): Burrow {
	return client.repos.burrows.create({
		kind: "project",
		projectRoot: "/tmp/proj",
		workspacePath: "/tmp/proj/.ws",
		branch,
		provider: "local",
		profile: {},
	});
}

function appendEvent(
	client: Client,
	burrowId: string,
	kind: string,
	payload: unknown,
	tsMs: number,
): RunEvent {
	const row = client.repos.events.append({
		burrowId,
		kind,
		stream: "stdout",
		payload,
		ts: new Date(tsMs),
	});
	return {
		id: row.id,
		burrowId: row.burrowId,
		runId: row.runId,
		seq: row.seq,
		kind: row.kind,
		stream: row.stream,
		payload: row.payloadJson,
		ts: row.ts,
	};
}

describe("burrow serve subprocess (TCP, no auth)", () => {
	let dataDir: string;
	let client: Client;
	let serve: ServeProc;
	let http: HttpClient;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-int-tcp-"));
		// Open a Client first so migrations run against a known-good schema.
		// The subprocess will reuse the migrated DB (idempotent re-run).
		client = await Client.open({ dataDir, configDir: dataDir, cacheDir: dataDir });
		serve = await spawnServe({
			dataDir,
			args: ["--port", "0", "--no-auth"],
		});
		http = new HttpClient({ transport: tcpBanner(serve.banner) });
	});

	afterEach(async () => {
		try {
			await serve.stop();
		} catch {
			// ignore — already stopped by a test that asserts on exit
		}
		await http.close();
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("startup banner reflects the bound transport and auth mode", () => {
		expect(serve.banner.authMode).toBe("none");
		expect(serve.banner.transport.kind).toBe("tcp");
		const { hostname, port } = tcpBanner(serve.banner);
		expect(hostname).toBe("127.0.0.1");
		expect(port).toBeGreaterThan(0);
		expect(serve.banner.url).toBe(`http://${hostname}:${port}`);
		expect(serve.banner.pid).toBe(serve.proc.pid);
	});

	test("/healthz over real subprocess returns 200 ok", async () => {
		const res = await fetch(`${serve.banner.url}/healthz`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	test("HttpClient reads burrows seeded into the shared SQLite DB", async () => {
		const a = seedBurrow(client);
		const b = seedBurrow(client, "task/x");
		const rows = await http.burrows.list();
		expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
		// Date rehydration crossed the process boundary.
		expect(rows[0]?.createdAt).toBeInstanceOf(Date);
	});

	test("inbox round-trip: send via HTTP, observe via in-test Client", async () => {
		const burrow = seedBurrow(client);
		const sent = await http.inbox.send({
			burrowId: burrow.id,
			body: "ping",
			priority: "high",
		});
		expect(sent.priority).toBe("high");
		// The subprocess wrote to SQLite; the in-test Client sees it.
		const persisted = client.repos.messages.listByBurrow(burrow.id);
		expect(persisted.map((m) => m.id)).toEqual([sent.id]);
	});

	test("HTTP-backed Client + in-process Client share the same destroy outcome", async () => {
		// Acceptance #6: full HTTP-driven loop touches every namespace. The CLI
		// `client.burrows.create` analogue isn't exposed yet (POST /burrows is
		// 501), so create stays in-process; everything else flows over HTTP.
		const burrow = seedBurrow(client);
		await http.inbox.send({ burrowId: burrow.id, body: "before destroy" });
		appendEvent(client, burrow.id, "tool_use", { tool: "Bash" }, 1000);

		const tailed: number[] = [];
		for await (const event of http.events.replay(burrow.id)) {
			tailed.push(event.seq);
		}
		expect(tailed).toEqual([1]);

		const destroy = await http.burrows.destroy(burrow.id, { archive: false });
		expect(destroy.burrowId).toBe(burrow.id);
		expect(client.burrows.tryGet(burrow.id)?.state).toBe("destroyed");
	});

	test("SIGTERM shuts the server down cleanly within 1s (acceptance #1)", async () => {
		const result = await serve.stop("SIGTERM");
		// SIGTERM is wired through commander → makeAbortController in cli/main.ts;
		// the AbortController triggers `handle.stop()` which force-closes the
		// listener. A clean shutdown exits 0 (no uncaught error).
		expect(result.elapsedMs).toBeLessThan(1000);
		expect(result.exitCode).toBe(0);
	});

	test("SIGINT also shuts down cleanly within 1s", async () => {
		const result = await serve.stop("SIGINT");
		expect(result.elapsedMs).toBeLessThan(1000);
		expect(result.exitCode).toBe(0);
	});
});

describe("burrow serve subprocess (wire-shape parity)", () => {
	let dataDir: string;
	let client: Client;
	let serve: ServeProc;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-int-wire-"));
		client = await Client.open({ dataDir, configDir: dataDir, cacheDir: dataDir });
		serve = await spawnServe({
			dataDir,
			args: ["--port", "0", "--no-auth"],
		});
	});

	afterEach(async () => {
		try {
			await serve.stop();
		} catch {
			// ignore
		}
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("GET /events?follow=0 NDJSON bytes match `eventToEnvelope` exactly (acceptance #3)", async () => {
		const burrow = seedBurrow(client);
		const seeded = [
			appendEvent(client, burrow.id, "tool_use", { tool: "Bash", input: "ls" }, 1000),
			appendEvent(client, burrow.id, "text", { text: "hi" }, 2000),
			appendEvent(client, burrow.id, "state_change", { from: "queued", to: "running" }, 3000),
		];

		const url = `${serve.banner.url}/burrows/${burrow.id}/events?follow=0`;
		const res = await fetch(url);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/ndjson/i);
		const body = await res.text();

		// Build the exact same NDJSON the CLI's `renderNdjson` would emit and
		// compare byte-for-byte. This is the SPEC §27 contract: "one wire shape
		// across CLI and HTTP" — divergence here means a consumer would have to
		// branch on transport.
		const expected = seeded.map((e) => `${JSON.stringify(eventToEnvelope(e))}\n`).join("");
		expect(body).toBe(expected);
	});

	test("replay-from-seq + follow yields seq>since with no duplicates and no gaps (acceptance #4)", async () => {
		const burrow = seedBurrow(client);
		// Pre-seed seqs 1..3, then start a follow stream from since=1; while
		// the stream is live, append seqs 4..5. The contract is: emit 2..5 in
		// order, no duplicates, no gaps, no replay of seq 1.
		appendEvent(client, burrow.id, "tool_use", { i: 1 }, 1000);
		appendEvent(client, burrow.id, "tool_use", { i: 2 }, 2000);
		appendEvent(client, burrow.id, "tool_use", { i: 3 }, 3000);

		const http = new HttpClient({ transport: tcpBanner(serve.banner) });
		try {
			const ctrl = new AbortController();
			const seen: number[] = [];
			const consumer = (async (): Promise<void> => {
				for await (const event of http.events.tail({
					burrowId: burrow.id,
					since: 1,
					signal: ctrl.signal,
					pollIntervalMs: 25,
				})) {
					seen.push(event.seq);
					if (seen.length === 4) {
						ctrl.abort();
						return;
					}
				}
			})();

			// Wait for the replay portion (seq 2,3) to land before injecting more.
			await waitFor(() => seen.length >= 2, 2000);
			appendEvent(client, burrow.id, "tool_use", { i: 4 }, 4000);
			appendEvent(client, burrow.id, "tool_use", { i: 5 }, 5000);

			try {
				await consumer;
			} catch (err) {
				// AbortError is the expected unwind path; fall through to assert
				// on `seen`.
				if (!(err instanceof Error)) throw err;
			}
			expect(seen).toEqual([2, 3, 4, 5]);
		} finally {
			await http.close();
		}
	});
});

describe("burrow serve subprocess (auth)", () => {
	let dataDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-int-auth-"));
		client = await Client.open({ dataDir, configDir: dataDir, cacheDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("BURROW_API_TOKEN gates every non-healthz route (acceptance #5)", async () => {
		const serve = await spawnServe({
			dataDir,
			args: ["--port", "0"],
			envOverrides: { BURROW_API_TOKEN: "s3cr3t" },
		});
		try {
			expect(serve.banner.authMode).toBe("bearer");

			const denied = new HttpClient({ transport: tcpBanner(serve.banner) });
			await expect(denied.burrows.list()).rejects.toBeInstanceOf(HttpClientError);
			await denied.close();

			// healthz is exempt — no token required.
			const healthRes = await fetch(`${serve.banner.url}/healthz`);
			expect(healthRes.status).toBe(200);

			const allowed = new HttpClient({
				transport: tcpBanner(serve.banner),
				token: "s3cr3t",
			});
			expect(await allowed.burrows.list()).toEqual([]);
			await allowed.close();
		} finally {
			await serve.stop();
		}
	});

	test("--no-auth bypasses bearer entirely even with BURROW_API_TOKEN set", async () => {
		// Acceptance #5 contract: --no-auth wins. Loopback-only escape hatch.
		const serve = await spawnServe({
			dataDir,
			args: ["--port", "0", "--no-auth"],
			envOverrides: { BURROW_API_TOKEN: "ignored" },
		});
		try {
			expect(serve.banner.authMode).toBe("none");
			const http = new HttpClient({ transport: tcpBanner(serve.banner) });
			expect(await http.burrows.list()).toEqual([]);
			await http.close();
		} finally {
			await serve.stop();
		}
	});

	test("BURROW_API_TOKEN never appears in stderr log output (mx-4dd333 redact)", async () => {
		const serve = await spawnServe({
			dataDir,
			args: ["--port", "0"],
			envOverrides: { BURROW_API_TOKEN: "s3cr3t-canary", LOG_LEVEL: "trace" },
		});
		try {
			// Make a denied + an allowed request so any "auth: token=…" log line
			// would have plenty of opportunity to appear.
			await fetch(`${serve.banner.url}/burrows`).then((r) => r.text());
			await fetch(`${serve.banner.url}/burrows`, {
				headers: { authorization: "Bearer s3cr3t-canary" },
			}).then((r) => r.text());
		} finally {
			await serve.stop();
		}
		// Canary token must not survive the redact pipeline (createLogger config).
		expect(serve.stderr()).not.toContain("s3cr3t-canary");
		expect(serve.stdout()).not.toContain("s3cr3t-canary");
	});
});

describe("burrow serve subprocess (unix transport)", () => {
	let dataDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-int-unix-"));
		client = await Client.open({ dataDir, configDir: dataDir, cacheDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("--socket binds the requested path and HttpClient reaches it", async () => {
		const sockPath = join(dataDir, "explicit.sock");
		const serve = await spawnServe({
			dataDir,
			args: ["--socket", sockPath, "--no-auth"],
		});
		try {
			expect(serve.banner.transport).toEqual({ kind: "unix", path: sockPath });
			expect(serve.banner.url).toBe(`unix://${sockPath}`);

			const http = new HttpClient({ transport: serve.banner.transport });
			const burrow = seedBurrow(client);
			const fetched = await http.burrows.get(burrow.id);
			expect(fetched.id).toBe(burrow.id);
			expect(fetched.createdAt).toBeInstanceOf(Date);
			await http.close();
		} finally {
			const result = await serve.stop("SIGTERM");
			expect(result.elapsedMs).toBeLessThan(1000);
			expect(result.exitCode).toBe(0);
		}
	});

	test("default unix socket lives at <cacheDir>/burrow.sock", async () => {
		// No --socket / --port → unix transport at the documented default
		// (acceptance criterion: SPEC §27, mx-8e4e40).
		const serve = await spawnServe({ dataDir, args: ["--no-auth"] });
		try {
			expect(serve.banner.transport).toEqual({
				kind: "unix",
				path: join(dataDir, "burrow.sock"),
			});
		} finally {
			await serve.stop();
		}
	});
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(`waitFor timed out after ${timeoutMs}ms`);
		}
		await new Promise((r) => setTimeout(r, 10));
	}
}
