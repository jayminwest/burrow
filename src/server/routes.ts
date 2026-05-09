/**
 * Route table for `burrow serve`. Every route in the canonical table is
 * wired to a real handler via `handlerFor`; the 501 stub is now reserved
 * for router-only tests (`buildRoutes(null)`) and out-of-table fallbacks.
 *
 * The shape and ordering here is the contract: tests in step 7 lock the
 * route list against this file.
 *
 * Routes mirror `Client` (src/lib/client.ts) namespaces 1:1:
 *   §15.1 BurrowsClient   → /burrows
 *   §15.2 RunsClient      → /burrows/:burrowId/runs, /runs/:id
 *   §15.3 InboxClient     → /burrows/:burrowId/inbox, /messages/:id
 *   §15.4 EventsClient    → /burrows/:burrowId/events
 *   §15.5 AgentsClient    → /agents
 *   §26   Dashboard       → /watch
 */

import type { Client } from "../lib/client.ts";
import { notImplemented } from "./errors.ts";
import { handlerFor } from "./handlers.ts";
import { openApiHtmlHandler, openApiJsonHandler } from "./openapi/handlers.ts";
import { jsonResponse } from "./response.ts";
import type { Route, RouteHandler } from "./types.ts";

/**
 * Build the canonical route table. When `client` is null (router-only tests
 * and the existing scaffold tests) every route returns 501; when a real
 * `Client` is provided, every canonical route now has a bound handler and
 * the 501 stub only fires for unknown method/pattern pairs.
 */
export function buildRoutes(client: Client | null): Route[] {
	return ROUTE_TABLE.map((entry) => {
		const handler =
			client === null
				? stubHandler(entry.method, entry.pattern)
				: (handlerFor(client, entry.method, entry.pattern) ??
					stubHandler(entry.method, entry.pattern));
		return {
			method: entry.method,
			pattern: entry.pattern,
			handler,
		};
	});
}

/**
 * Health check — exempt from auth (when step 4 lands) and always returns a
 * concrete response so a serving process can be liveness-probed without a
 * token. Wired here in step 1 since it's the one route that doesn't depend
 * on the Library API.
 *
 * `/openapi.json` and `/openapi.html` (burrow-d3ea) are stitched on at the
 * same level — they don't need a `Client` either, so they're folded into
 * the same out-of-band route list rather than the mirrored CRUD table.
 */
const metaRoutes: readonly Route[] = [
	{
		method: "GET",
		pattern: "/healthz",
		handler: () => jsonResponse(200, { ok: true }),
	},
	{
		method: "GET",
		pattern: "/openapi.json",
		handler: openApiJsonHandler,
	},
	{
		method: "GET",
		pattern: "/openapi.html",
		handler: openApiHtmlHandler,
	},
];

export function buildRoutesWithHealth(client: Client | null): Route[] {
	return [...metaRoutes, ...buildRoutes(client)];
}

interface RouteEntry {
	readonly method: Route["method"];
	readonly pattern: string;
}

const ROUTE_TABLE: readonly RouteEntry[] = [
	{ method: "GET", pattern: "/burrows" },
	{ method: "POST", pattern: "/burrows" },
	{ method: "GET", pattern: "/burrows/:id" },
	{ method: "DELETE", pattern: "/burrows/:id" },
	{ method: "POST", pattern: "/burrows/:id/stop" },
	{ method: "POST", pattern: "/burrows/:id/resume" },
	{ method: "POST", pattern: "/burrows/:id/files" },
	{ method: "GET", pattern: "/burrows/:id/files" },

	{ method: "GET", pattern: "/burrows/:id/runs" },
	{ method: "POST", pattern: "/burrows/:id/runs" },
	{ method: "GET", pattern: "/runs/:id" },
	{ method: "DELETE", pattern: "/runs/:id" },
	{ method: "POST", pattern: "/runs/:id/cancel" },
	{ method: "GET", pattern: "/runs/:id/stream" },

	{ method: "GET", pattern: "/burrows/:id/inbox" },
	{ method: "POST", pattern: "/burrows/:id/inbox" },
	{ method: "DELETE", pattern: "/messages/:id" },

	{ method: "GET", pattern: "/burrows/:id/events" },

	{ method: "GET", pattern: "/agents" },
	{ method: "GET", pattern: "/agents/:id" },

	{ method: "GET", pattern: "/watch" },
];

export const ROUTE_PATTERNS: readonly RouteEntry[] = ROUTE_TABLE;

function stubHandler(method: string, pattern: string): RouteHandler {
	return () => {
		const { status, envelope } = notImplemented(`${method} ${pattern}`);
		return jsonResponse(status, envelope);
	};
}
