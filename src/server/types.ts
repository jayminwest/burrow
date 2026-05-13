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
import type { DrainController } from "../runner/dispatcher.ts";
import type { AuthProvider } from "./auth.ts";

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

/**
 * Wire-level binding for `burrow serve`. Unix socket is the canonical
 * single-host / single-container deploy (filesystem-permission-controlled,
 * no port allocation); localhost TCP is the opt-in alternative for
 * cross-container reach. Anything beyond loopback is out of V1 scope.
 */
export type Transport =
	| { readonly kind: "unix"; readonly path: string }
	| { readonly kind: "tcp"; readonly hostname: string; readonly port: number };

export interface ServeOptions {
	/**
	 * Bind target. Defaults to ephemeral TCP `127.0.0.1:0` (used by unit
	 * tests). The CLI (`burrow serve`, step 5) defaults to a unix socket.
	 */
	transport?: Transport;
	/**
	 * Auth strategy. Defaults to `NO_AUTH` for tests; the CLI plugs in a
	 * bearer-token provider via `resolveAuth({ token | noAuth })` so a real
	 * `burrow serve` always either authenticates or explicitly opts out.
	 */
	auth?: AuthProvider;
	/** Override the route table (tests); defaults to `buildRoutes(client)`. */
	routes?: readonly Route[];
	/** Pre-resolved logger; one is created if omitted. */
	logger?: Logger;
	/**
	 * Admin controls (pl-cb3e step 4 / burrow-79ad). When provided, mounts
	 * `POST /admin/drain` AND wraps the burrow + run create handlers so they
	 * return 503 `worker_draining` while drain is set. Wired by the CLI's
	 * `runServeCommand` from the in-process dispatcher; library callers that
	 * skip the dispatcher leave this unset and the admin surface stays off.
	 */
	admin?: AdminControls;
}

export interface AdminControls {
	drain: DrainController;
}

export interface ServeHandle {
	readonly transport: Transport;
	/**
	 * Best-effort URL string for logging.
	 *  - tcp  → `http://127.0.0.1:1234`
	 *  - unix → `unix:///tmp/burrow.sock`
	 *
	 * Not parseable by `fetch()` for unix sockets (Bun fetch takes the path
	 * via the `unix` option instead) — purely a human-readable hint.
	 */
	readonly url: string;
	stop(): Promise<void>;
}
