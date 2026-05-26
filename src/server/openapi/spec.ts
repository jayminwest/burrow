/**
 * OpenAPI 3.1 document for `burrow serve` (burrow-d3ea).
 *
 * Built once at startup from the Zod schema registry in `./schemas.ts` and
 * the route table in `../routes.ts` so external consumers (warren, custom
 * dashboards, generated clients) get a stable, typed wire contract without
 * re-deriving it from `--help` output. The shape is locked by the golden
 * test in `./spec.test.ts` (mx-1785cc pattern) — any change to a route or
 * response schema deliberately trips the test until the golden is updated.
 *
 * Component schemas come from Zod's draft-2020-12 emitter, which is exactly
 * what OpenAPI 3.1 takes for `components.schemas` (no extra dep needed —
 * Zod 4 ships `z.toJSONSchema` natively).
 */

import { z } from "zod";
import { VERSION } from "../../index.ts";
import {
	AgentDetailSchema,
	BurrowSchema,
	CancelRunBodySchema,
	CreateBurrowBodySchema,
	CreateRunBodySchema,
	CreateSidecarBodySchema,
	componentRegistry,
	DashboardSnapshotSchema,
	DestroyBurrowResultSchema,
	DrainBodySchema,
	DrainStateSchema,
	ErrorEnvelopeSchema,
	EventEnvelopeSchema,
	HealthResponseSchema,
	ListFilesResponseSchema,
	MessageSchema,
	QueryEnums,
	RunSchema,
	SendInboxBodySchema,
	SidecarLogsSchema,
	SidecarSchema,
	WorkspaceFileEntrySchema,
	WorkspaceFileSchema,
	WriteFilesBodySchema,
	WriteFilesResponseSchema,
} from "./schemas.ts";

export type OpenApiDocument = Record<string, unknown>;

const COMPONENT_REF_BASE = "#/components/schemas";

interface OperationDef {
	operationId: string;
	summary: string;
	tags: readonly string[];
	parameters?: readonly ParameterDef[];
	requestBody?: { schemaName: string; description?: string; required?: boolean };
	responses: Record<string, ResponseDef>;
	authRequired?: boolean;
}

interface ParameterDef {
	name: string;
	in: "path" | "query";
	required?: boolean;
	description?: string;
	schema: Record<string, unknown>;
}

interface ResponseDef {
	description: string;
	contentType?: "application/json" | "application/x-ndjson";
	schemaName?: string;
	itemSchemaName?: string;
	isArray?: boolean;
	/** Render the response schema as `{ oneOf: [...] }` over the named components. */
	oneOfSchemaNames?: readonly string[];
}

/* ----------------------------------------------------------------------- */
/* Common parameter primitives                                              */
/* ----------------------------------------------------------------------- */

const burrowIdParam: ParameterDef = {
	name: "id",
	in: "path",
	required: true,
	description: "Burrow id, e.g. `bur_a3f9`.",
	schema: { type: "string", pattern: "^bur_" },
};

const runIdParam: ParameterDef = {
	name: "id",
	in: "path",
	required: true,
	description: "Run id, e.g. `run_2c4d`.",
	schema: { type: "string", pattern: "^run_" },
};

const messageIdParam: ParameterDef = {
	name: "id",
	in: "path",
	required: true,
	description: "Message id.",
	schema: { type: "string" },
};

const agentIdParam: ParameterDef = {
	name: "id",
	in: "path",
	required: true,
	description: "Agent runtime id (e.g. `claude-code`, `sapling`, `codex`, `pi`).",
	schema: { type: "string" },
};

const sidecarIdParam: ParameterDef = {
	name: "sidecarId",
	in: "path",
	required: true,
	description: "Sidecar id, e.g. `sc_a4b0`.",
	schema: { type: "string", pattern: "^sc_" },
};

const limitParam: ParameterDef = {
	name: "limit",
	in: "query",
	description: "Maximum rows to return; positive integer.",
	schema: { type: "integer", minimum: 1 },
};

const followStreamParam: ParameterDef = {
	name: "follow",
	in: "query",
	description:
		"When true (default), keep the connection open and live-tail; when false, drain current rows and close. Accepts `true`/`false` or `1`/`0`.",
	schema: { type: "string", enum: ["true", "false", "1", "0"] },
};

const sinceParam: ParameterDef = {
	name: "since",
	in: "query",
	description: "Emit only events with `seq > since`. Non-negative integer.",
	schema: { type: "integer", minimum: 0 },
};

const kindsParam: ParameterDef = {
	name: "kinds",
	in: "query",
	description:
		"Comma-separated list of event kinds to include. Repeated `?kinds=` parameters merge.",
	schema: { type: "string" },
};

const pollIntervalMsParam: ParameterDef = {
	name: "pollIntervalMs",
	in: "query",
	description: "Override the live-tail poll interval (ms).",
	schema: { type: "integer", minimum: 0 },
};

/* ----------------------------------------------------------------------- */
/* Operations                                                               */
/* ----------------------------------------------------------------------- */

interface PathOperation {
	method: "get" | "post" | "delete";
	pattern: string;
	op: OperationDef;
}

const OPERATIONS: readonly PathOperation[] = [
	{
		method: "get",
		pattern: "/healthz",
		op: {
			operationId: "health",
			summary:
				"Liveness probe. Auth-exempt; returns `{ ok: true }` whenever the server is reachable.",
			tags: ["meta"],
			authRequired: false,
			responses: {
				"200": {
					description: "Server is healthy.",
					contentType: "application/json",
					schemaName: "HealthResponse",
				},
			},
		},
	},
	{
		method: "get",
		pattern: "/openapi.json",
		op: {
			operationId: "openApiJson",
			summary:
				"Return this OpenAPI 3.1 document. Auth-required (same posture as the rest of the API).",
			tags: ["meta"],
			responses: {
				"200": {
					description: "OpenAPI 3.1 document describing the burrow serve API.",
					contentType: "application/json",
				},
			},
		},
	},
	{
		method: "get",
		pattern: "/openapi.html",
		op: {
			operationId: "openApiHtml",
			summary:
				"Render this spec in a browser via Scalar API Reference. Auth-exempt for human exploration; the spec it renders comes from `/openapi.json` which IS auth-required.",
			tags: ["meta"],
			authRequired: false,
			responses: {
				"200": {
					description: "HTML page that loads `/openapi.json` into a documentation UI.",
				},
			},
		},
	},
	{
		method: "get",
		pattern: "/burrows",
		op: {
			operationId: "listBurrows",
			summary: "List burrows. Filterable by kind / state / projectRoot.",
			tags: ["burrows"],
			parameters: [
				{
					name: "kind",
					in: "query",
					schema: { type: "string", enum: [...QueryEnums.burrowKind] },
				},
				{
					name: "state",
					in: "query",
					schema: { type: "string", enum: [...QueryEnums.burrowState] },
				},
				{ name: "projectRoot", in: "query", schema: { type: "string" } },
			],
			responses: {
				"200": {
					description: "Array of matching burrows.",
					contentType: "application/json",
					itemSchemaName: "Burrow",
					isArray: true,
				},
				"400": errorResponse("validation_error on bad query param"),
			},
		},
	},
	{
		method: "post",
		pattern: "/burrows",
		op: {
			operationId: "createBurrow",
			summary:
				"Provision a project burrow (SPEC §15.1, §16). Loads `burrow.toml` from `projectRoot`, runs doctor, materializes the workspace worktree, and inserts the burrow row with its resolved sandbox profile. When a `seed` payload is included, its files are written into the workspace before the burrow is returned (atomic with provisioning, single round-trip). Returns 201 with the new `Burrow`.",
			tags: ["burrows"],
			requestBody: { schemaName: "CreateBurrowBody" },
			responses: {
				"201": {
					description: "The provisioned burrow.",
					contentType: "application/json",
					schemaName: "Burrow",
				},
				"400": errorResponse("validation_error"),
				"503": errorResponse(
					"worker_draining — POST /admin/drain has set this worker's drain bit; retry against another worker or flip drain off to resume",
				),
			},
		},
	},
	{
		method: "get",
		pattern: "/burrows/{id}",
		op: {
			operationId: "getBurrow",
			summary: "Get a burrow by id.",
			tags: ["burrows"],
			parameters: [burrowIdParam],
			responses: {
				"200": {
					description: "The burrow.",
					contentType: "application/json",
					schemaName: "Burrow",
				},
				"404": errorResponse("not_found"),
			},
		},
	},
	{
		method: "delete",
		pattern: "/burrows/{id}",
		op: {
			operationId: "destroyBurrow",
			summary:
				"Archive (optional) and delete a burrow's rows. Workspace teardown is the caller's responsibility.",
			tags: ["burrows"],
			parameters: [
				burrowIdParam,
				{
					name: "archive",
					in: "query",
					description: "When false, skip the events/messages/runs export.",
					schema: { type: "string", enum: ["true", "false"] },
				},
			],
			responses: {
				"200": {
					description: "Archive + delete result.",
					contentType: "application/json",
					schemaName: "DestroyBurrowResult",
				},
				"404": errorResponse("not_found"),
			},
		},
	},
	{
		method: "post",
		pattern: "/burrows/{id}/stop",
		op: {
			operationId: "stopBurrow",
			summary: "Transition the burrow to `stopped` (active → stopped).",
			tags: ["burrows"],
			parameters: [burrowIdParam],
			responses: {
				"200": {
					description: "The updated burrow.",
					contentType: "application/json",
					schemaName: "Burrow",
				},
				"404": errorResponse("not_found"),
			},
		},
	},
	{
		method: "post",
		pattern: "/burrows/{id}/resume",
		op: {
			operationId: "resumeBurrow",
			summary: "Transition the burrow to `active` (stopped → active).",
			tags: ["burrows"],
			parameters: [burrowIdParam],
			responses: {
				"200": {
					description: "The updated burrow.",
					contentType: "application/json",
					schemaName: "Burrow",
				},
				"404": errorResponse("not_found"),
			},
		},
	},
	{
		method: "post",
		pattern: "/burrows/{id}/files",
		op: {
			operationId: "writeFiles",
			summary:
				"Write files into a burrow's workspace (R-07). Same path-validation contract as `POST /burrows` with `seed`: workspace-relative paths only, no `..` traversal, no symlink escapes, no overwrites of `.git/` or sandbox-owned paths. The batch is all-or-nothing — a single rejected entry returns 400 with no partial writes.",
			tags: ["burrows"],
			parameters: [burrowIdParam],
			requestBody: { schemaName: "WriteFilesBody" },
			responses: {
				"200": {
					description: "Write succeeded. Body reports the count for caller-side sanity checks.",
					contentType: "application/json",
					schemaName: "WriteFilesResponse",
				},
				"400": errorResponse("validation_error on bad path or rejected file"),
				"404": errorResponse("not_found"),
			},
		},
	},
	{
		method: "get",
		pattern: "/burrows/{id}/files",
		op: {
			operationId: "readOrListFiles",
			summary:
				"Read one file or list the workspace (R-07, burrow-18ca). With `?path=`, returns a single `WorkspaceFile` decoded per `encoding` (UTF-8 by default; `base64` for binary). Without `?path=`, returns a recursive `ListFilesResponse` rooted at the workspace; `?prefix=relative/dir` scopes the walk to a subtree. Same path-validation contract as `POST /burrows/{id}/files` — workspace-relative only, no `..` or symlink escapes, reserved entries (`.git/`, `.gitconfig.burrow`) are rejected as a prefix and excluded from the top-level listing. Symlinks inside the workspace are listed but not traversed. Used by orchestrators (e.g. warren) to enumerate agent-controlled outputs (mulch records, seed updates) when filenames can't be predicted up front.",
			tags: ["burrows"],
			parameters: [
				burrowIdParam,
				{
					name: "path",
					in: "query",
					description:
						"Workspace-relative path of a single file to read. Mutually exclusive with `prefix` — when both are present, `path` wins.",
					schema: { type: "string", minLength: 1 },
				},
				{
					name: "prefix",
					in: "query",
					description:
						"Workspace-relative directory to scope the listing to. Ignored when `path` is set. Omit for a whole-workspace walk.",
					schema: { type: "string", minLength: 1 },
				},
				{
					name: "encoding",
					in: "query",
					description:
						"Encoding for the read body when `path` is set. `utf-8` (default) decodes to a UTF-8 string; `base64` returns base64-encoded bytes for binary payloads. Ignored on the listing path.",
					schema: { type: "string", enum: ["utf-8", "base64"] },
				},
			],
			responses: {
				"200": {
					description:
						"Either the requested file (when `?path=` is set) or a recursive listing of workspace files (no `?path=`).",
					contentType: "application/json",
					oneOfSchemaNames: ["WorkspaceFile", "ListFilesResponse"],
				},
				"400": errorResponse("validation_error on bad path or prefix"),
				"404": errorResponse("not_found (burrow, file, or prefix)"),
			},
		},
	},
	{
		method: "get",
		pattern: "/burrows/{id}/runs",
		op: {
			operationId: "listRunsByBurrow",
			summary: "List runs for one burrow, newest first.",
			tags: ["runs"],
			parameters: [burrowIdParam, limitParam],
			responses: {
				"200": {
					description: "Array of runs.",
					contentType: "application/json",
					itemSchemaName: "Run",
					isArray: true,
				},
			},
		},
	},
	{
		method: "post",
		pattern: "/burrows/{id}/runs",
		op: {
			operationId: "createRun",
			summary: "Enqueue a run. Returns 201 with the queued `Run`.",
			tags: ["runs"],
			parameters: [burrowIdParam],
			requestBody: { schemaName: "CreateRunBody" },
			responses: {
				"201": {
					description: "The enqueued run.",
					contentType: "application/json",
					schemaName: "Run",
				},
				"400": errorResponse("validation_error"),
				"404": errorResponse("not_found"),
				"503": errorResponse(
					"worker_draining — POST /admin/drain has set this worker's drain bit; retry against another worker or flip drain off to resume",
				),
			},
		},
	},
	{
		method: "get",
		pattern: "/runs/{id}",
		op: {
			operationId: "getRun",
			summary: "Get a run by id.",
			tags: ["runs"],
			parameters: [runIdParam],
			responses: {
				"200": {
					description: "The run.",
					contentType: "application/json",
					schemaName: "Run",
				},
				"404": errorResponse("not_found"),
			},
		},
	},
	{
		method: "post",
		pattern: "/runs/{id}/cancel",
		op: {
			operationId: "cancelRun",
			summary:
				"Graceful cancel. Transitions a `queued`/`running` run to `cancelled`, records the optional `reason` on `errorMessage`, and emits a `run_cancelled` event on the run's stream so subscribers see the trigger. Idempotent on already-terminal runs (returns the current row with 200, not 4xx) so callers can safely retry.",
			tags: ["runs"],
			parameters: [runIdParam],
			requestBody: {
				schemaName: "CancelRunBody",
				required: false,
				description:
					"Optional. Bare POST with no body is accepted; `{reason}` is recorded on the run + cancel event when provided.",
			},
			responses: {
				"200": {
					description:
						"The run after cancel — current row when already terminal, freshly-cancelled row otherwise.",
					contentType: "application/json",
					schemaName: "Run",
				},
				"400": errorResponse("validation_error on malformed body"),
				"404": errorResponse("not_found"),
			},
		},
	},
	{
		method: "delete",
		pattern: "/runs/{id}",
		op: {
			operationId: "deleteRun",
			summary:
				"Remove a finished run row from the database (record removal). Distinct from `POST /runs/{id}/cancel` — this is post-completion cleanup, not a state transition. Only allowed when the run is in a terminal state (`succeeded`/`failed`/`cancelled`); 400 if the run is still `queued`/`running` (cancel it first). Cascades to the run's events (the `events.run_id` foreign key would otherwise block the delete); the burrow-level event history shrinks by the deleted run's tail. Returns 204 No Content on success.",
			tags: ["runs"],
			parameters: [runIdParam],
			responses: {
				"204": { description: "Run row removed." },
				"400": errorResponse("validation_error when run is non-terminal"),
				"404": errorResponse("not_found"),
			},
		},
	},
	{
		method: "get",
		pattern: "/runs/{id}/stream",
		op: {
			operationId: "runStream",
			summary:
				"Tail one run's events as NDJSON over chunked HTTP. Always follows; consumers stop via `?limit=N` or by cancelling the request.",
			tags: ["runs", "streams"],
			parameters: [runIdParam, limitParam, pollIntervalMsParam],
			responses: {
				"200": {
					description: "Newline-delimited `EventEnvelope` records (one per line).",
					contentType: "application/x-ndjson",
					schemaName: "EventEnvelope",
				},
				"404": errorResponse("not_found"),
			},
		},
	},
	{
		method: "get",
		pattern: "/burrows/{id}/sidecars",
		op: {
			operationId: "listSidecars",
			summary:
				"List sidecars for one burrow (R-08, SPEC §8.7). Sidecars are long-lived non-agent processes scoped to the burrow — warren spawns one per preview environment. Storage is in-memory per `burrow serve` process; a worker restart drops them.",
			tags: ["sidecars"],
			parameters: [burrowIdParam],
			responses: {
				"200": {
					description: "Array of sidecars.",
					contentType: "application/json",
					itemSchemaName: "Sidecar",
					isArray: true,
				},
				"404": errorResponse("not_found — unknown burrow or sidecars not enabled on this worker"),
			},
		},
	},
	{
		method: "post",
		pattern: "/burrows/{id}/sidecars",
		op: {
			operationId: "createSidecar",
			summary:
				"Spawn a sidecar inside the burrow's sandbox (R-08, SPEC §8.7). The sidecar inherits the burrow's stored `SandboxProfile` (network policy, ro-binds, workspace bind) — no escalation. Optional `inboundPortForward` plumbs `127.0.0.1:hostPort` on the host into `127.0.0.1:sandboxPort` inside the sandbox's network namespace (Linux: per-connection `nsenter`+`nc` relay; macOS: implicit, returns `host_port_bound: false`). Per-burrow cap (default 4, configurable via `BURROW_SIDECAR_CAP`) bounds blast radius — over-cap returns 409 `sidecar_cap_exceeded`.",
			tags: ["sidecars"],
			parameters: [burrowIdParam],
			requestBody: { schemaName: "CreateSidecarBody" },
			responses: {
				"201": {
					description: "The spawned sidecar.",
					contentType: "application/json",
					schemaName: "Sidecar",
				},
				"400": errorResponse(
					"validation_error — invalid command, env, or `inboundPortForward` shape; burrow not active",
				),
				"404": errorResponse("not_found — unknown burrow or sidecars not enabled on this worker"),
				"409": errorResponse("sidecar_cap_exceeded — per-burrow cap reached"),
			},
		},
	},
	{
		method: "get",
		pattern: "/burrows/{id}/sidecars/{sidecarId}",
		op: {
			operationId: "getSidecar",
			summary: "Get a sidecar's current state (R-08, SPEC §8.7).",
			tags: ["sidecars"],
			parameters: [burrowIdParam, sidecarIdParam],
			responses: {
				"200": {
					description: "The sidecar.",
					contentType: "application/json",
					schemaName: "Sidecar",
				},
				"404": errorResponse("not_found — unknown burrow / sidecar, or sidecars not enabled"),
			},
		},
	},
	{
		method: "delete",
		pattern: "/burrows/{id}/sidecars/{sidecarId}",
		op: {
			operationId: "deleteSidecar",
			summary:
				"Tear down a sidecar (R-08, SPEC §8.7). Cancels the process and releases its inbound forward. Idempotent on already-terminal sidecars (returns 204 even if state is `exited`/`torn-down`/`failed`). The state transitions to `torn-down` so subsequent `GET` reflects the explicit teardown.",
			tags: ["sidecars"],
			parameters: [burrowIdParam, sidecarIdParam],
			responses: {
				"204": { description: "Sidecar torn down." },
				"404": errorResponse("not_found — unknown burrow / sidecar, or sidecars not enabled"),
			},
		},
	},
	{
		method: "get",
		pattern: "/burrows/{id}/sidecars/{sidecarId}/logs",
		op: {
			operationId: "sidecarLogs",
			summary:
				"Read the sidecar's captured stdout/stderr. Logs are an in-memory ring buffer per stream (default 64 KiB; oldest bytes evict head-first). `?tail_bytes=N` returns the last N bytes per stream; omitting returns whatever is currently buffered.",
			tags: ["sidecars"],
			parameters: [
				burrowIdParam,
				sidecarIdParam,
				{
					name: "tail_bytes",
					in: "query",
					description: "Return only the last N bytes of each stream.",
					schema: { type: "integer", minimum: 0 },
				},
			],
			responses: {
				"200": {
					description: "Sidecar log payload.",
					contentType: "application/json",
					schemaName: "SidecarLogs",
				},
				"404": errorResponse("not_found — unknown burrow / sidecar, or sidecars not enabled"),
			},
		},
	},
	{
		method: "get",
		pattern: "/burrows/{id}/inbox",
		op: {
			operationId: "listInbox",
			summary: "List inbox messages for one burrow.",
			tags: ["inbox"],
			parameters: [
				burrowIdParam,
				{
					name: "state",
					in: "query",
					schema: { type: "string", enum: [...QueryEnums.messageState] },
				},
			],
			responses: {
				"200": {
					description: "Array of messages.",
					contentType: "application/json",
					itemSchemaName: "Message",
					isArray: true,
				},
			},
		},
	},
	{
		method: "post",
		pattern: "/burrows/{id}/inbox",
		op: {
			operationId: "sendInbox",
			summary: "Enqueue a steering message.",
			tags: ["inbox"],
			parameters: [burrowIdParam],
			requestBody: { schemaName: "SendInboxBody" },
			responses: {
				"201": {
					description: "The enqueued message.",
					contentType: "application/json",
					schemaName: "Message",
				},
				"400": errorResponse("validation_error"),
				"404": errorResponse("not_found"),
			},
		},
	},
	{
		method: "delete",
		pattern: "/messages/{id}",
		op: {
			operationId: "cancelMessage",
			summary: "Drop an undelivered message. 204 on success.",
			tags: ["inbox"],
			parameters: [messageIdParam],
			responses: {
				"204": { description: "Message cancelled." },
				"404": errorResponse("not_found"),
			},
		},
	},
	{
		method: "get",
		pattern: "/burrows/{id}/events",
		op: {
			operationId: "eventsTail",
			summary:
				"Tail per-burrow events as NDJSON over chunked HTTP. Wire bytes match `burrow events --json` exactly.",
			tags: ["events", "streams"],
			parameters: [
				burrowIdParam,
				followStreamParam,
				sinceParam,
				kindsParam,
				limitParam,
				pollIntervalMsParam,
			],
			responses: {
				"200": {
					description: "Newline-delimited `EventEnvelope` records (one per line).",
					contentType: "application/x-ndjson",
					schemaName: "EventEnvelope",
				},
				"400": errorResponse("validation_error"),
				"404": errorResponse("not_found"),
			},
		},
	},
	{
		method: "get",
		pattern: "/agents",
		op: {
			operationId: "listAgents",
			summary: "List registered agent runtimes with install status.",
			tags: ["agents"],
			responses: {
				"200": {
					description: "Array of agent details.",
					contentType: "application/json",
					itemSchemaName: "AgentDetail",
					isArray: true,
				},
			},
		},
	},
	{
		method: "get",
		pattern: "/agents/{id}",
		op: {
			operationId: "getAgent",
			summary: "Get one agent runtime detail.",
			tags: ["agents"],
			parameters: [agentIdParam],
			responses: {
				"200": {
					description: "Agent detail.",
					contentType: "application/json",
					schemaName: "AgentDetail",
				},
				"404": errorResponse("not_found"),
			},
		},
	},
	{
		method: "get",
		pattern: "/watch",
		op: {
			operationId: "watch",
			summary:
				"Stream `DashboardSnapshot` records as NDJSON. Wire bytes match `burrow watch --json` exactly (SPEC §26.5).",
			tags: ["dashboard", "streams"],
			parameters: [
				{
					name: "once",
					in: "query",
					description:
						"Emit a single snapshot then close. Accepts `true`/`false` or `1`/`0`. Mutually exclusive with `follow`.",
					schema: { type: "string", enum: ["true", "false", "1", "0"] },
				},
				{
					name: "follow",
					in: "query",
					description:
						"Inverse alias of `once` — when false, emit one snapshot then close; when true (default), keep streaming. Accepts `true`/`false` or `1`/`0`. Mutually exclusive with `once`.",
					schema: { type: "string", enum: ["true", "false", "1", "0"] },
				},
				{ name: "coalesceMs", in: "query", schema: { type: "integer", minimum: 0 } },
				pollIntervalMsParam,
				{ name: "runsLimit", in: "query", schema: { type: "integer", minimum: 1 } },
				{ name: "eventTailCap", in: "query", schema: { type: "integer", minimum: 0 } },
			],
			responses: {
				"200": {
					description: "Newline-delimited `DashboardSnapshot` records (one per line).",
					contentType: "application/x-ndjson",
					schemaName: "DashboardSnapshot",
				},
				"400": errorResponse("validation_error"),
			},
		},
	},
	{
		method: "post",
		pattern: "/admin/drain",
		op: {
			operationId: "drainWorker",
			summary:
				"Flip the worker's drain bit (pl-cb3e step 4 / burrow-79ad). While drain is set, `POST /burrows` and `POST /burrows/:id/runs` return 503 `worker_draining`; reads, lifecycle (cancel/stop/resume/delete), inbox sends, and every streaming surface keep working so operators can still observe and tear down in-flight work. In-flight runs continue to terminal state — drain is graceful, not preemptive. Idempotent: setting drain to its current value still returns 200 with the same echo. Mounted only when the server is booted with admin controls (i.e. by `burrow serve`); absent in library-mode embeds.",
			tags: ["admin"],
			requestBody: { schemaName: "DrainBody" },
			responses: {
				"200": {
					description: "Echo of the dispatcher's drain bit after the request.",
					contentType: "application/json",
					schemaName: "DrainState",
				},
				"400": errorResponse(
					"validation_error — empty body, non-object body, or 'drain' not a JSON boolean",
				),
			},
		},
	},
];

function errorResponse(label: string): ResponseDef {
	return {
		description: `Error envelope (\`${label}\`).`,
		contentType: "application/json",
		schemaName: "ErrorEnvelope",
	};
}

/* ----------------------------------------------------------------------- */
/* Build                                                                    */
/* ----------------------------------------------------------------------- */

/**
 * Build the OpenAPI 3.1 document. Pure / deterministic — given the same
 * `version` arg, output is byte-identical (the lock test depends on this).
 */
export function buildOpenApiDocument(opts: { version?: string } = {}): OpenApiDocument {
	const version = opts.version ?? VERSION;
	const components = buildComponents();
	const paths = buildPaths();

	return {
		openapi: "3.1.0",
		info: {
			title: "burrow serve",
			version,
			description:
				"HTTP API for the burrow runtime. Routes mirror the in-process `Client` namespaces 1:1 so the Library API stays the source of truth. Streaming surfaces (`/burrows/{id}/events`, `/runs/{id}/stream`, `/watch`) emit NDJSON over chunked HTTP byte-for-byte equal to the matching `--json` CLI output.\n\nBind-host posture: `burrow serve` defaults to `127.0.0.1` (loopback) and refuses to start with a non-loopback `--bind-host` when `--no-auth` is set — exposing the API over TCP requires `BURROW_API_TOKEN`. The threat model is VPC-private (Tailscale / AWS VPC / Fly private network); TLS is the operator's job at a reverse proxy on each worker. mTLS is a future R-NN, not V1. Multi-worker pools coordinate quiescence via `POST /admin/drain` (see the `admin` tag).",
			license: { name: "MIT" },
		},
		servers: [
			{
				url: "http://127.0.0.1:4040",
				description: "localhost TCP (opt-in via `burrow serve --port`)",
			},
		],
		components: {
			...components,
			securitySchemes: {
				bearerAuth: {
					type: "http",
					scheme: "bearer",
					description:
						"Bearer token from `BURROW_API_TOKEN`. `--no-auth` mode disables auth on the server side; clients still need to omit the header.",
				},
			},
		},
		security: [{ bearerAuth: [] }],
		tags: [
			{ name: "meta", description: "Health and self-description." },
			{ name: "burrows", description: "Burrows namespace (SPEC §15.1)." },
			{ name: "runs", description: "Runs namespace (SPEC §15.2)." },
			{
				name: "sidecars",
				description:
					"Sidecars namespace (R-08, SPEC §8.7). Long-lived non-agent processes scoped to a burrow; warren's per-run preview environments are the load-bearing consumer.",
			},
			{ name: "inbox", description: "Inbox namespace (SPEC §15.3)." },
			{ name: "events", description: "Events namespace (SPEC §15.4)." },
			{ name: "agents", description: "Agents namespace (SPEC §15.5)." },
			{ name: "dashboard", description: "Dashboard view-model (SPEC §26)." },
			{ name: "streams", description: "NDJSON-over-chunked-HTTP surfaces." },
			{
				name: "admin",
				description:
					"Operator-facing endpoints for worker lifecycle (drain, future cache/telemetry pulls). Mounted only when the server is booted with admin controls.",
			},
		],
		paths,
	};
}

function buildComponents(): { schemas: Record<string, unknown> } {
	void registrySources();
	const out = z.toJSONSchema(componentRegistry, {
		uri: (id) => `${COMPONENT_REF_BASE}/${id}`,
		target: "draft-2020-12",
	}) as { schemas: Record<string, unknown> };
	const cleaned: Record<string, unknown> = {};
	for (const [name, schema] of Object.entries(out.schemas)) {
		const obj = schema as Record<string, unknown>;
		const { $schema: _drop, $id: _drop2, ...rest } = obj;
		cleaned[name] = rest;
	}
	return { schemas: sortRecord(cleaned) };
}

/**
 * Reference every registered schema so a tree-shaking importer doesn't
 * accidentally drop an unused export and silently shrink the registry.
 * The lock test would catch the drift, but referencing here is cheaper
 * than debugging a confusing test failure.
 */
function registrySources(): readonly z.ZodType[] {
	return [
		BurrowSchema,
		RunSchema,
		MessageSchema,
		EventEnvelopeSchema,
		DashboardSnapshotSchema,
		AgentDetailSchema,
		DestroyBurrowResultSchema,
		ErrorEnvelopeSchema,
		HealthResponseSchema,
		CreateBurrowBodySchema,
		CreateRunBodySchema,
		CancelRunBodySchema,
		SendInboxBodySchema,
		WorkspaceFileSchema,
		WorkspaceFileEntrySchema,
		WriteFilesBodySchema,
		WriteFilesResponseSchema,
		ListFilesResponseSchema,
		DrainBodySchema,
		DrainStateSchema,
		SidecarSchema,
		CreateSidecarBodySchema,
		SidecarLogsSchema,
	];
}

function buildPaths(): Record<string, Record<string, unknown>> {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const { method, pattern, op } of OPERATIONS) {
		paths[pattern] ??= {};
		paths[pattern][method] = renderOperation(op);
	}
	return sortRecord(paths) as Record<string, Record<string, unknown>>;
}

function renderOperation(op: OperationDef): Record<string, unknown> {
	const out: Record<string, unknown> = {
		operationId: op.operationId,
		summary: op.summary,
		tags: [...op.tags],
	};
	if (op.parameters && op.parameters.length > 0) {
		out.parameters = op.parameters.map(renderParameter);
	}
	if (op.requestBody) {
		out.requestBody = {
			required: op.requestBody.required ?? true,
			content: {
				"application/json": {
					schema: { $ref: `${COMPONENT_REF_BASE}/${op.requestBody.schemaName}` },
				},
			},
		};
		if (op.requestBody.description !== undefined) {
			(out.requestBody as Record<string, unknown>).description = op.requestBody.description;
		}
	}
	out.responses = sortRecord(
		Object.fromEntries(
			Object.entries(op.responses).map(([status, def]) => [status, renderResponse(def)]),
		),
	);
	if (op.authRequired === false) {
		out.security = [];
	}
	return out;
}

function renderParameter(p: ParameterDef): Record<string, unknown> {
	const out: Record<string, unknown> = { name: p.name, in: p.in, schema: p.schema };
	if (p.required !== undefined) out.required = p.required;
	if (p.description !== undefined) out.description = p.description;
	return out;
}

function renderResponse(def: ResponseDef): Record<string, unknown> {
	const out: Record<string, unknown> = { description: def.description };
	if (!def.contentType) return out;
	let schema: Record<string, unknown>;
	if (def.oneOfSchemaNames && def.oneOfSchemaNames.length > 0) {
		schema = {
			oneOf: def.oneOfSchemaNames.map((name) => ({ $ref: `${COMPONENT_REF_BASE}/${name}` })),
		};
	} else if (def.isArray) {
		schema = {
			type: "array",
			items: def.itemSchemaName ? { $ref: `${COMPONENT_REF_BASE}/${def.itemSchemaName}` } : {},
		};
	} else if (def.schemaName) {
		schema = { $ref: `${COMPONENT_REF_BASE}/${def.schemaName}` };
	} else {
		schema = { type: "object" };
	}
	out.content = { [def.contentType]: { schema } };
	return out;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
	const sorted: Record<string, T> = {};
	for (const key of Object.keys(record).sort()) {
		// biome-ignore lint/style/noNonNullAssertion: key is from Object.keys
		sorted[key] = record[key]!;
	}
	return sorted;
}

/**
 * Stable JSON serialization for the lock test and the served response —
 * key ordering is forced by `sortRecord` above; we only need pretty
 * formatting. Two-space indent + trailing newline matches the project's
 * existing JSON files (.canopy/, .seeds/) so it diffs cleanly.
 */
export function serializeOpenApiDocument(doc: OpenApiDocument): string {
	return `${JSON.stringify(doc, null, 2)}\n`;
}
