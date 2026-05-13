#!/usr/bin/env bun
/**
 * Test-only fixture: a `burrow serve` subprocess that registers an in-process
 * fake agent runtime + spawn implementation, then runs the production
 * `runServeCommand` against the supplied data dir + TCP port. Used by
 * `dispatcher-cross-process.test.ts` to lock the SPEC §27 / burrow-7b97
 * contract: an HTTP-enqueued run is driven all the way to `succeeded` by the
 * dispatcher inside a separate OS process (the warren cross-host topology).
 *
 * Not part of the public surface — kept out of the published bundle by name.
 * The CLI in src/cli/main.ts intentionally does NOT import this; injecting a
 * fake agent across the process boundary requires a fixture entry point that
 * does so via library calls before invoking `runServeCommand`.
 *
 * Argv: `bun dispatcher-cross-process.fixture.ts <dataDir> <port>`
 *   - dataDir: pre-migrated SQLite location; the parent test seeds the burrow
 *     row before spawning so the subprocess sees it via SQLite WAL.
 *   - port: TCP port (use 0 for ephemeral). The fixture emits the resolved
 *     `{url,transport,authMode,pid}` envelope on stdout so the parent can
 *     read the bound port.
 */

import { runServeCommand } from "../cli/commands/serve.ts";
import { Client } from "../lib/client.ts";
import { createLogger } from "../logging/logger.ts";
import type { SpawnResult } from "../provider/types.ts";
import type { SpawnFn } from "../runner/dispatch.ts";
import type { AgentRuntime } from "../runtime/runtime.ts";

const FAKE_AGENT_ID = "x-fixture-noop";

const fakeRuntime: AgentRuntime = {
	id: FAKE_AGENT_ID,
	displayName: "Fixture Noop",
	supportsResume: false,
	buildSpawnCommand: () => ({ argv: ["x-fixture-noop"] }),
	parseEvents: () => [],
	installCheck: async () => ({ installed: true }),
};

const fakeSpawn: SpawnFn = async () => {
	const empty = (): ReadableStream<Uint8Array> =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
	let resolveExit!: (n: number) => void;
	const exited = new Promise<number>((r) => {
		resolveExit = r;
	});
	const result: SpawnResult = {
		pid: 1,
		stdout: empty(),
		stderr: empty(),
		exited,
		cancel: () => resolveExit(130),
	};
	queueMicrotask(() => resolveExit(0));
	return result;
};

async function main(): Promise<void> {
	const [, , dataDir, portRaw] = process.argv;
	if (!dataDir || portRaw === undefined) {
		process.stderr.write("usage: dispatcher-cross-process.fixture.ts <dataDir> <port>\n");
		process.exit(2);
	}

	const logger = createLogger({ level: "fatal" });
	const client = await Client.open({
		dataDir,
		configDir: dataDir,
		cacheDir: dataDir,
		logger,
	});
	client.agents.register(fakeRuntime);

	const ac = new AbortController();
	const onSig = (): void => ac.abort();
	process.on("SIGINT", onSig);
	process.on("SIGTERM", onSig);

	try {
		await runServeCommand({
			client,
			options: { port: portRaw, noAuth: true, json: true },
			signal: ac.signal,
			stdout: process.stdout,
			logger,
			dispatcherOptions: { spawn: fakeSpawn },
		});
	} finally {
		process.off("SIGINT", onSig);
		process.off("SIGTERM", onSig);
		await client.close();
	}
}

void main();
