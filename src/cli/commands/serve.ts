/**
 * `burrow serve` — run the HTTP API server (SPEC §27, pl-5b40 step 5).
 *
 * Thin CLI shim over `startServer` (src/server/server.ts). Resolves transport
 * (unix socket primary, TCP opt-in), pulls auth from `--no-auth` or the
 * `BURROW_API_TOKEN` env, and waits on the AbortController the CLI wires to
 * SIGINT/SIGTERM. On signal: `handle.stop()` (force-closes connections via
 * Bun.serve.stop(true)) before withClient closes the Client — acceptance #1
 * is "SIGINT closes cleanly within 1s".
 *
 * Default transport is unix at `<paths.cacheDir>/burrow.sock` because the
 * single-host / warren-in-same-container deploy is the canonical posture
 * (SPEC §27). `--port` opts into TCP for cross-container reach. `--socket`
 * and `--port`/`--bind-host` are mutually exclusive — picking one transport
 * keeps the bound URL unambiguous in the startup banner.
 *
 * Non-loopback bind safety (pl-cb3e step 2 / burrow-b160): `--bind-host`
 * defaults to `127.0.0.1`. When the resolved bind host is anything other
 * than loopback (`localhost`, `127.0.0.0/8`, `::1`) AND `--no-auth` is set,
 * startup refuses — exposing burrow on a routable interface without bearer
 * auth would be a footgun. The operator must set `BURROW_API_TOKEN` to
 * expose the API over non-loopback TCP.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ValidationError } from "../../core/errors.ts";
import type { RecoverySweepResult } from "../../db/recovery.ts";
import type { Client } from "../../lib/client.ts";
import type { Logger } from "../../logging/logger.ts";
import {
	type RunDispatcherHandle,
	type RunDispatcherOptions,
	startRunDispatcher,
} from "../../runner/dispatcher.ts";
import { resolveAuth } from "../../server/auth.ts";
import { startServer } from "../../server/server.ts";
import { SidecarRegistry } from "../../server/sidecars.ts";
import type { Transport } from "../../server/types.ts";

export interface ServeCommandOptions {
	socket?: string;
	/** TCP bind interface — defaults to `127.0.0.1`. Non-loopback values
	 * additionally require bearer auth (see runServeCommand). */
	bindHost?: string;
	/** Commander hands ports through as strings; we parse them ourselves. */
	port?: string;
	noAuth?: boolean;
	json?: boolean;
}

export interface ServeCommandInput {
	client: Client;
	options: ServeCommandOptions;
	/** Required — the CLI wires SIGINT/SIGTERM here so shutdown is cooperative. */
	signal: AbortSignal;
	stdout: NodeJS.WritableStream;
	/**
	 * Override the default unix socket path (tests). The CLI default is
	 * `<client.paths.cacheDir>/burrow.sock` — derived inside runServeCommand
	 * so tests don't have to thread cacheDir through.
	 */
	defaultSocketPath?: string;
	/** Override env for `resolveAuth` (tests). Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Logger override (tests). Defaults to `client.logger`. */
	logger?: Logger;
	/**
	 * Test seams forwarded to the in-process `RunDispatcher` (spawn, proxy
	 * starter, install check). Production callers leave this unset; tests
	 * set `spawn` to a fake implementation so HTTP-driven runs don't shell
	 * out to bwrap/sandbox-exec on the host.
	 */
	dispatcherOptions?: Pick<RunDispatcherOptions, "spawn" | "startProxy" | "installCheck">;
}

export interface ServeCommandSummary {
	/** Same string `startServer` published — `unix://…` or `http://…`. */
	url: string;
	/** Resolved transport (TCP entry has the actual bound port if 0 was passed). */
	transport: Transport;
	authMode: "bearer" | "none";
	/**
	 * Crash-recovery summary from the in-process `RunDispatcher`. Captures
	 * the rows the startup sweep flipped to terminal so callers (and tests)
	 * can confirm the dispatcher actually booted.
	 */
	recovered: RecoverySweepResult;
}

export async function runServeCommand(input: ServeCommandInput): Promise<ServeCommandSummary> {
	const transport = resolveTransport(input.options, {
		socketPath: input.defaultSocketPath ?? defaultSocketPath(input.client),
	});

	if (
		transport.kind === "tcp" &&
		!isLoopbackHost(transport.hostname) &&
		(input.options.noAuth ?? false)
	) {
		throw new ValidationError(
			`--no-auth is not allowed when binding to a non-loopback host (--bind-host ${transport.hostname})`,
			{
				recoveryHint:
					"export BURROW_API_TOKEN=<token> and drop --no-auth, or bind to 127.0.0.1 / ::1 / localhost",
			},
		);
	}

	if (transport.kind === "unix") {
		// `Bun.serve({ unix })` doesn't mkdir-p the parent — a fresh install
		// where cacheDir doesn't exist yet would fail with ENOENT otherwise.
		await mkdir(dirname(transport.path), { recursive: true });
	}

	const auth = resolveAuth({
		noAuth: input.options.noAuth ?? false,
		env: input.env ?? process.env,
	});

	const logger = input.logger ?? input.client.logger;
	// Dispatcher boots BEFORE the HTTP listener so:
	//   1. crash-recovery's `failAllRunning` sweep finishes before the
	//      first request lands, so a client polling /runs/:id never sees a
	//      stale `running` row from the previous process.
	//   2. the create-time hook is installed before `client.runs.create`
	//      can be reached over HTTP — no run can sneak past the dispatcher.
	const dispatcherOptions: RunDispatcherOptions = { logger };
	if (input.dispatcherOptions?.spawn) dispatcherOptions.spawn = input.dispatcherOptions.spawn;
	if (input.dispatcherOptions?.startProxy)
		dispatcherOptions.startProxy = input.dispatcherOptions.startProxy;
	if (input.dispatcherOptions?.installCheck)
		dispatcherOptions.installCheck = input.dispatcherOptions.installCheck;
	const dispatcher: RunDispatcherHandle = startRunDispatcher(input.client, dispatcherOptions);
	const recovered = dispatcher.start().recovered;

	// Sidecar registry is server-scoped (R-08, SPEC §8.7): warren spawns
	// long-lived preview processes through `POST /burrows/:id/sidecars`,
	// and the per-burrow inbound port-forward + lifecycle invariants live
	// here. In-memory only — a worker restart drops sidecars.
	const sidecars = new SidecarRegistry({ client: input.client });

	let handle: Awaited<ReturnType<typeof startServer>>;
	try {
		// Wire the dispatcher's drain bit through to the HTTP layer so
		// `POST /admin/drain` can flip it and the burrow + run create
		// handlers consult it (pl-cb3e step 4 / burrow-79ad).
		handle = startServer(input.client, {
			transport,
			auth,
			logger,
			admin: { drain: dispatcher.drain },
			sidecars,
		});
	} catch (err) {
		await sidecars.shutdownAll().catch(() => undefined);
		await dispatcher.stop({ force: true });
		throw err;
	}

	const summary: ServeCommandSummary = {
		url: handle.url,
		transport: handle.transport,
		authMode: input.options.noAuth ? "none" : "bearer",
		recovered,
	};

	emitStartupBanner(summary, input);

	try {
		await waitForAbort(input.signal);
	} finally {
		// HTTP first so no new runs can be enqueued while the dispatcher
		// is draining; then sidecars (release inbound forwards / kill
		// long-lived processes before tearing down the dispatcher); then
		// dispatcher with `force` so in-flight handlers see the abort and
		// tear their spawned subprocess down.
		await handle.stop();
		await sidecars.shutdownAll().catch(() => undefined);
		await dispatcher.stop({ force: true });
	}

	return summary;
}

export function resolveTransport(
	opts: ServeCommandOptions,
	defaults: { socketPath: string },
): Transport {
	const tcpRequested = opts.bindHost !== undefined || opts.port !== undefined;
	const socketRequested = opts.socket !== undefined;
	if (tcpRequested && socketRequested) {
		throw new ValidationError("--socket cannot be combined with --bind-host/--port", {
			recoveryHint:
				"use --socket for unix transport, or --port (with optional --bind-host) for TCP",
		});
	}
	if (socketRequested) {
		return { kind: "unix", path: opts.socket as string };
	}
	if (tcpRequested) {
		if (opts.port === undefined) {
			throw new ValidationError("--bind-host requires --port", {
				recoveryHint:
					"pass --port <n> alongside --bind-host, or drop --bind-host to use the default 127.0.0.1",
			});
		}
		return {
			kind: "tcp",
			hostname: opts.bindHost ?? "127.0.0.1",
			port: parsePort(opts.port),
		};
	}
	return { kind: "unix", path: defaults.socketPath };
}

/**
 * Loopback predicate for the `--bind-host` safety check. Recognised forms:
 * `localhost`, the IPv4 loopback block `127.0.0.0/8`, and the IPv6 loopback
 * `::1` (with its canonical longhand `0:0:0:0:0:0:0:1`). Anything else
 * (including `0.0.0.0` and `::`, which bind every interface) is non-loopback.
 */
export function isLoopbackHost(host: string): boolean {
	if (host === "localhost") return true;
	if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
	return /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function parsePort(raw: string): number {
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0 || n > 65535 || String(n) !== raw) {
		throw new ValidationError(`--port expects an integer in [0, 65535], got '${raw}'`);
	}
	return n;
}

function defaultSocketPath(client: Client): string {
	return `${client.paths.cacheDir}/burrow.sock`;
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	await new Promise<void>((resolve) => {
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

function emitStartupBanner(summary: ServeCommandSummary, input: ServeCommandInput): void {
	if (input.options.json) {
		input.stdout.write(
			`${JSON.stringify({
				url: summary.url,
				transport: summary.transport,
				authMode: summary.authMode,
				pid: process.pid,
			})}\n`,
		);
		return;
	}
	const authLine =
		summary.authMode === "bearer" ? "bearer (BURROW_API_TOKEN)" : "disabled (--no-auth)";
	input.stdout.write(`burrow serve listening on ${summary.url}\n`);
	input.stdout.write(`  auth: ${authLine}\n`);
	input.stdout.write("  press Ctrl-C to stop\n");
}
