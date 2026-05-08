/**
 * Bun.serve wrapper. Owns the request → auth → router → handler → response
 * pipeline plus the server lifecycle (start/stop). Two transport modes —
 * unix socket (primary for the warren-in-same-container deploy) and
 * localhost TCP (cross-container opt-in). Auth is an opaque `AuthProvider`
 * the caller injects; the dispatch layer never inspects token values.
 *
 * `/healthz` is the one auth-exempt route — liveness probes can't carry a
 * token. Everything else (mirrored Client routes + streaming surfaces)
 * goes through `auth.authorize` before pattern matching.
 */

import { existsSync, unlinkSync } from "node:fs";
import type { Client } from "../lib/client.ts";
import { createLogger, type Logger } from "../logging/logger.ts";
import { type AuthDenied, type AuthProvider, NO_AUTH } from "./auth.ts";
import { methodNotAllowed, notFound, renderError } from "./errors.ts";
import { jsonResponse } from "./response.ts";
import { matchRoute, pathExists } from "./router.ts";
import { buildRoutesWithHealth } from "./routes.ts";
import type { Route, RouteContext, ServeHandle, ServeOptions, Transport } from "./types.ts";

// `Bun.serve()` returns Server<unknown>; we never use WebSocketData on this server.
type ServeServer = ReturnType<typeof Bun.serve>;

/**
 * Pathnames exempt from auth. Liveness probes can't authenticate, and the
 * health endpoint reveals nothing sensitive (just `{ ok: true }`). The
 * OpenAPI HTML viewer (burrow-d3ea) is also exempt so a human can land on
 * it without a token; the actual spec at `/openapi.json` IS auth-required,
 * which is the layer that protects the route shape.
 */
const AUTH_EXEMPT_PATHS = new Set<string>(["/healthz", "/openapi.html"]);

const DEFAULT_TRANSPORT: Transport = { kind: "tcp", hostname: "127.0.0.1", port: 0 };

/**
 * Boot a Bun server. `client` is the same `Client` a library caller would
 * hold; the server never opens its own — keeping the lifetime explicit on
 * the caller side mirrors how the CLI commands work.
 *
 * `client` may be null for routing-only tests; with a null client every
 * mirrored route returns 501 (the step-1 scaffold behaviour) — only the
 * /healthz route and any explicitly-passed `opts.routes` actually run.
 */
export function startServer(client: Client | null, opts: ServeOptions = {}): ServeHandle {
	const logger = opts.logger ?? createLogger();
	const routes: readonly Route[] = opts.routes ?? buildRoutesWithHealth(client);
	const auth = opts.auth ?? NO_AUTH;
	const transport = opts.transport ?? DEFAULT_TRANSPORT;

	const fetchHandler = (request: Request): Promise<Response> =>
		handleRequest(request, routes, auth, logger);

	const server =
		transport.kind === "unix"
			? bindUnix(transport.path, fetchHandler)
			: bindTcp(transport.hostname, transport.port, fetchHandler);

	const resolvedTransport: Transport =
		transport.kind === "unix"
			? transport
			: {
					kind: "tcp",
					hostname: server.hostname ?? transport.hostname,
					port: server.port ?? transport.port,
				};

	return {
		transport: resolvedTransport,
		url: formatUrl(resolvedTransport),
		stop: async () => {
			server.stop(true);
			if (resolvedTransport.kind === "unix") {
				// Bun normally cleans up the socket inode itself, but be
				// defensive — a stale socket file blocks the next bind.
				try {
					if (existsSync(resolvedTransport.path)) unlinkSync(resolvedTransport.path);
				} catch {
					// Ignore: race with Bun's own cleanup is fine.
				}
			}
		},
	};
}

function bindTcp(
	hostname: string,
	port: number,
	fetch: (req: Request) => Promise<Response>,
): ServeServer {
	return Bun.serve({ hostname, port, fetch });
}

function bindUnix(path: string, fetch: (req: Request) => Promise<Response>): ServeServer {
	// A leftover socket inode from a crashed previous run blocks bind() with
	// EADDRINUSE. Removing it is the conventional posture for unix-socket
	// servers; if the path is held by a *live* process, bind still fails.
	if (existsSync(path)) {
		try {
			unlinkSync(path);
		} catch {
			// Let Bun.serve produce the canonical error if the path can't be cleared.
		}
	}
	return Bun.serve({ unix: path, fetch });
}

function formatUrl(transport: Transport): string {
	return transport.kind === "unix"
		? `unix://${transport.path}`
		: `http://${transport.hostname}:${transport.port}`;
}

async function handleRequest(
	request: Request,
	routes: readonly Route[],
	auth: AuthProvider,
	logger: Logger,
): Promise<Response> {
	const url = new URL(request.url);

	if (!AUTH_EXEMPT_PATHS.has(url.pathname)) {
		const result = auth.authorize(request);
		if (!result.ok) return denyResponse(result);
	}

	const match = matchRoute(routes, request.method, url.pathname);
	if (!match) {
		const rendered = pathExists(routes, url.pathname)
			? methodNotAllowed(request.method, url.pathname)
			: notFound(url.pathname);
		return jsonResponse(rendered.status, rendered.envelope);
	}

	const ctx: RouteContext = {
		request,
		url,
		params: match.params,
		logger,
	};

	try {
		return await match.route.handler(ctx);
	} catch (err) {
		const rendered = renderError(err);
		logger.error(
			{
				err,
				route: `${match.route.method} ${match.route.pattern}`,
				status: rendered.status,
			},
			"server: handler threw",
		);
		return jsonResponse(rendered.status, rendered.envelope);
	}
}

function denyResponse(result: AuthDenied): Response {
	const envelope = {
		error: { code: result.code, message: result.message },
	};
	const init: ResponseInit = {};
	if (result.challenge !== undefined) {
		init.headers = { "www-authenticate": result.challenge };
	}
	return jsonResponse(result.status, envelope, init);
}
