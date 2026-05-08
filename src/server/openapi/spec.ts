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
	componentRegistry,
	DashboardSnapshotSchema,
	DestroyBurrowResultSchema,
	ErrorEnvelopeSchema,
	EventEnvelopeSchema,
	HealthResponseSchema,
	MessageSchema,
	QueryEnums,
	RunSchema,
	SendInboxBodySchema,
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
	description: "Agent runtime id (e.g. `claude-code`, `sapling`).",
	schema: { type: "string" },
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
				"Provision a project burrow (SPEC §15.1, §16). Loads `burrow.toml` from `projectRoot`, runs doctor, materializes the workspace worktree, and inserts the burrow row with its resolved sandbox profile. Returns 201 with the new `Burrow`.",
			tags: ["burrows"],
			requestBody: { schemaName: "CreateBurrowBody" },
			responses: {
				"201": {
					description: "The provisioned burrow.",
					contentType: "application/json",
					schemaName: "Burrow",
				},
				"400": errorResponse("validation_error"),
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
				"HTTP API for the burrow runtime. Routes mirror the in-process `Client` namespaces 1:1 so the Library API stays the source of truth. Streaming surfaces (`/burrows/{id}/events`, `/runs/{id}/stream`, `/watch`) emit NDJSON over chunked HTTP byte-for-byte equal to the matching `--json` CLI output.",
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
			{ name: "inbox", description: "Inbox namespace (SPEC §15.3)." },
			{ name: "events", description: "Events namespace (SPEC §15.4)." },
			{ name: "agents", description: "Agents namespace (SPEC §15.5)." },
			{ name: "dashboard", description: "Dashboard view-model (SPEC §26)." },
			{ name: "streams", description: "NDJSON-over-chunked-HTTP surfaces." },
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
	const schema = def.isArray
		? {
				type: "array",
				items: def.itemSchemaName ? { $ref: `${COMPONENT_REF_BASE}/${def.itemSchemaName}` } : {},
			}
		: def.schemaName
			? { $ref: `${COMPONENT_REF_BASE}/${def.schemaName}` }
			: { type: "object" };
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
