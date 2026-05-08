/**
 * Bun.serve wrapper. Owns the request → router → handler → response pipeline
 * and the server lifecycle (start/stop). Auth, unix-socket transport, and
 * graceful-shutdown semantics land in steps 4-5 of pl-5b40 — this skeleton
 * binds localhost TCP only.
 */

import type { Client } from "../lib/client.ts";
import { createLogger, type Logger } from "../logging/logger.ts";
import { methodNotAllowed, notFound, renderError } from "./errors.ts";
import { jsonResponse } from "./response.ts";
import { matchRoute, pathExists } from "./router.ts";
import { buildRoutesWithHealth } from "./routes.ts";
import type { Route, RouteContext, ServeHandle, ServeOptions } from "./types.ts";

/**
 * Boot a Bun server bound to localhost TCP. `client` is the same `Client` a
 * library caller would hold; the server never opens its own — keeping the
 * lifetime explicit on the caller side mirrors how the CLI commands work.
 *
 * `client` may be null for routing-only tests; with a null client every
 * mirrored route returns 501 (the step-1 scaffold behaviour) — only the
 * /healthz route and any explicitly-passed `opts.routes` actually run.
 */
export function startServer(client: Client | null, opts: ServeOptions = {}): ServeHandle {
	const logger = opts.logger ?? createLogger();
	const routes: readonly Route[] = opts.routes ?? buildRoutesWithHealth(client);
	const hostname = opts.hostname ?? "127.0.0.1";
	const port = opts.port ?? 0;

	const server = Bun.serve({
		hostname,
		port,
		fetch: async (request) => handleRequest(request, routes, logger),
	});

	const resolvedPort = server.port ?? port;
	const resolvedHost = server.hostname ?? hostname;

	return {
		hostname: resolvedHost,
		port: resolvedPort,
		url: `http://${resolvedHost}:${resolvedPort}`,
		stop: async () => {
			server.stop(true);
		},
	};
}

async function handleRequest(
	request: Request,
	routes: readonly Route[],
	logger: Logger,
): Promise<Response> {
	const url = new URL(request.url);
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
