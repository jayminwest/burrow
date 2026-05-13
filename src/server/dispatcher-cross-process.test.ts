/**
 * Cross-process e2e for the `burrow serve` dispatcher (SPEC §27, plan pl-cb3e
 * step 1). Locks the burrow-7b97 contract — HTTP-enqueued runs are driven to a
 * terminal state by the dispatcher inside the serving process — against a real
 * OS-subprocess boundary. The in-process variant at
 * `src/cli/commands/serve.test.ts:285` exercises the same wiring inside one
 * Bun event loop; this file proves the same loop survives when:
 *   1. the listener and dispatcher live in a different process from the caller,
 *   2. SQLite WAL is the only shared state between the two,
 *   3. `RunsClient.setOnCreated` fires off the HTTP create path (not just an
 *      in-process `client.runs.create()` invocation),
 *   4. shutdown closes the listener and finalizes the in-flight run cleanly.
 *
 * This is the contract warren leans on when fanning runs out to a per-host
 * worker pool (warren counterpart plan to pl-cb3e); the test guards against a
 * regression where the dispatcher silently fails to hook into HTTP creates
 * across the process boundary.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Run } from "../core/types.ts";
import { Client } from "../lib/client.ts";
import type { SandboxProfile } from "../provider/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "dispatcher-cross-process.fixture.ts");
const FAKE_AGENT_ID = "x-fixture-noop";

interface FixtureBanner {
	url: string;
	transport: { kind: "tcp"; hostname: string; port: number } | { kind: "unix"; path: string };
	authMode: "bearer" | "none";
	pid: number;
}

interface FixtureProc {
	proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	banner: FixtureBanner;
	readonly stderr: () => string;
	stop(signal?: NodeJS.Signals): Promise<{ exitCode: number }>;
}

async function spawnFixture(dataDir: string): Promise<FixtureProc> {
	const proc = Bun.spawn([process.execPath, "run", FIXTURE, dataDir, "0"], {
		env: {
			...(process.env as Record<string, string>),
			LOG_LEVEL: "fatal",
		},
		stdout: "pipe",
		stderr: "pipe",
	});

	let stderrBuf = "";
	const decoder = new TextDecoder();

	void (async () => {
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
	})();

	const stdoutReader = proc.stdout.getReader();
	let banner: FixtureBanner | null = null;
	let buf = "";
	while (banner === null) {
		const { done, value } = await stdoutReader.read();
		if (done) {
			stdoutReader.releaseLock();
			throw new Error(`fixture exited before banner. stderr:\n${stderrBuf}`);
		}
		buf += decoder.decode(value, { stream: true });
		const nl = buf.indexOf("\n");
		if (nl < 0) continue;
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		banner = JSON.parse(line) as FixtureBanner;
	}
	// Drain remaining stdout so the subprocess doesn't backpressure.
	void (async () => {
		try {
			while (true) {
				const { done } = await stdoutReader.read();
				if (done) break;
			}
		} finally {
			stdoutReader.releaseLock();
		}
	})();

	return {
		proc,
		banner,
		stderr: () => stderrBuf,
		stop: async (signal: NodeJS.Signals = "SIGTERM") => {
			proc.kill(signal);
			const exitCode = await proc.exited;
			return { exitCode };
		},
	};
}

function tcpBanner(banner: FixtureBanner): { hostname: string; port: number } {
	if (banner.transport.kind !== "tcp") {
		throw new Error(`expected tcp transport, got ${banner.transport.kind}`);
	}
	return banner.transport;
}

describe("burrow serve dispatcher (cross-process)", () => {
	let dataDir: string;
	let client: Client;
	let fixture: FixtureProc;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-xproc-"));
		// Open a Client first so migrations land before the subprocess opens
		// the same DB. SQLite WAL makes cross-process visibility safe.
		client = await Client.open({ dataDir, configDir: dataDir, cacheDir: dataDir });
		fixture = await spawnFixture(dataDir);
	});

	afterEach(async () => {
		try {
			await fixture.stop();
		} catch {
			// already stopped by a test
		}
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("POST /runs over TCP is driven to `succeeded` by the subprocess dispatcher (burrow-7b97)", async () => {
		const profile: SandboxProfile = {
			workspace: "/ws",
			readOnlyMounts: [],
			network: "none",
			allowedDomains: [],
			envPassthrough: [],
			setEnv: {},
			toolchainPaths: [],
		};
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/repo",
			workspacePath: "/ws",
			branch: "main",
			provider: "local",
			profile,
		});

		const { hostname, port } = tcpBanner(fixture.banner);
		const baseUrl = `http://${hostname}:${port}`;

		const res = await fetch(`${baseUrl}/burrows/${burrow.id}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agentId: FAKE_AGENT_ID, prompt: "hello" }),
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as Run;
		expect(created.burrowId).toBe(burrow.id);
		expect(["queued", "running", "succeeded"]).toContain(created.state);

		// The run row is written by the subprocess; the in-test Client reads it
		// over WAL. Polling is necessary because no in-process event signal
		// crosses the process boundary.
		await waitFor(() => {
			const r = client.runs.tryGet(created.id);
			return r !== null && (r.state === "succeeded" || r.state === "failed");
		}, 5000);

		const finalized = client.runs.get(created.id);
		expect(finalized.state).toBe("succeeded");
		expect(finalized.exitCode).toBe(0);
		expect(finalized.startedAt).not.toBeNull();
		expect(finalized.completedAt).not.toBeNull();

		const stopped = await fixture.stop("SIGTERM");
		expect(stopped.exitCode).toBe(0);
	});
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(`waitFor predicate did not become true within ${timeoutMs}ms`);
		}
		await new Promise((r) => setTimeout(r, 20));
	}
}
