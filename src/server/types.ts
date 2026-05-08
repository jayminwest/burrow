/**
 * HTTP server wire shapes and route plumbing (SPEC §27, plan pl-5b40).
 *
 * The HTTP layer is a thin envelope over the existing `Client` (src/lib/client.ts).
 * Routes mirror the Client namespaces 1:1 so the Library API stays the source of
 * truth and the wire shape can't drift. CRUD payloads are plain JSON; streaming
 * surfaces (events tail, watch snapshot) emit NDJSON over chunked HTTP and reuse
 * the same envelope as `burrow events --json` / `burrow watch --json`.
 *
 * This file declares the seams; pl-5b40 step 1 wired the routing scaffold,
 * step 2 filled in CRUD adapters, step 3 added the streaming handlers.
 */

import type { Logger } from "../logging/logger.ts";

/**
 * Error envelope rendered for every non-2xx response. Mirrors the shape of
 * `BurrowError` (code/message/hint) so the same JSON consumers use against the
 * `--json` CLI surface can decode HTTP error responses without a second parser.
 */
export interface ErrorEnvelope {
	error: {
		code: string;
		message: string;
		hint?: string;
	};
}

/**
 * Compiled route pattern. `paramNames` is the ordered list of `:foo` segments
 * captured by `regex` so the router can build a `RouteContext.params` object
 * without re-parsing the pattern at request time.
 */
export interface RoutePattern {
	method: HttpMethod;
	pattern: string;
	regex: RegExp;
	paramNames: readonly string[];
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Anything a handler needs from the dispatch step. `client` is null only in
 * unit tests for the router itself — server.ts always wires a real `Client`.
 */
export interface RouteContext {
	readonly request: Request;
	readonly url: URL;
	readonly params: Readonly<Record<string, string>>;
	readonly logger: Logger;
}

export type RouteHandler = (ctx: RouteContext) => Response | Promise<Response>;

export interface Route {
	readonly method: HttpMethod;
	readonly pattern: string;
	readonly handler: RouteHandler;
}

export interface ServeOptions {
	/** Localhost TCP port. 0 = ephemeral (used by tests). */
	port?: number;
	/** Bind host. Defaults to 127.0.0.1 — loopback only until step 4 lands. */
	hostname?: string;
	/** Override the route table (tests); defaults to `buildRoutes(client)`. */
	routes?: readonly Route[];
	/** Pre-resolved logger; one is created if omitted. */
	logger?: Logger;
}

export interface ServeHandle {
	readonly hostname: string;
	readonly port: number;
	readonly url: string;
	stop(): Promise<void>;
}
