/**
 * Zod schemas for the `burrow serve` HTTP surface (burrow-d3ea).
 *
 * Authored as the single source of truth for the OpenAPI 3.1 document
 * (`spec.ts`) — request bodies, query params, and response shapes. The
 * runtime handlers in `../handlers.ts` still validate by hand because they
 * landed before this module did and the parent plan (pl-5b40) declared the
 * route shapes stable; treat the schemas here as the *documented* contract
 * and keep them in sync with the handlers' actual behaviour. The golden
 * lock test (`spec.test.ts`) catches accidental drift in the published
 * spec; cross-handler drift is caught by the existing handlers.test.ts
 * fixtures, which exercise the same shapes from the wire side.
 *
 * All schemas register into a single `z.registry` keyed by stable display
 * names so `spec.ts` can emit them as `#/components/schemas/<Name>`
 * references and the wire bytes stay compact + diff-friendly.
 */

import { z } from "zod";
import {
	BURROW_KINDS,
	BURROW_STATES,
	EVENT_STREAMS,
	MESSAGE_PRIORITIES,
	MESSAGE_STATES,
	RUN_STATES,
} from "../../db/schema.ts";
import { NETWORK_POLICIES } from "../../provider/types.ts";

export const componentRegistry = z.registry<{ id: string }>();

function component<T extends z.ZodType>(id: string, schema: T): T {
	componentRegistry.add(schema, { id });
	return schema;
}

const isoTimestamp = z.string().describe("ISO-8601 timestamp with millisecond precision");

/* ----------------------------------------------------------------------- */
/* Domain types (mirrors src/core/types.ts + src/dashboard/types.ts)       */
/* ----------------------------------------------------------------------- */

export const BurrowSchema = component(
	"Burrow",
	z.object({
		id: z.string(),
		parentId: z.string().nullable(),
		kind: z.enum(BURROW_KINDS),
		name: z.string().nullable(),
		projectRoot: z.string(),
		workspacePath: z.string(),
		branch: z.string(),
		provider: z.string(),
		providerStateJson: z.unknown().nullable(),
		profileJson: z.unknown(),
		state: z.enum(BURROW_STATES),
		createdAt: isoTimestamp,
		updatedAt: isoTimestamp,
		destroyedAt: isoTimestamp.nullable(),
	}),
);

export const RunSchema = component(
	"Run",
	z.object({
		id: z.string(),
		burrowId: z.string(),
		agentId: z.string(),
		prompt: z.string(),
		resumeOfRunId: z.string().nullable(),
		state: z.enum(RUN_STATES),
		exitCode: z.number().int().nullable(),
		errorMessage: z.string().nullable(),
		metadataJson: z.unknown().nullable(),
		queuedAt: isoTimestamp,
		startedAt: isoTimestamp.nullable(),
		completedAt: isoTimestamp.nullable(),
	}),
);

export const MessageSchema = component(
	"Message",
	z.object({
		id: z.string(),
		burrowId: z.string(),
		fromActor: z.string(),
		body: z.string(),
		priority: z.enum(MESSAGE_PRIORITIES),
		state: z.enum(MESSAGE_STATES),
		deliveredAtRunId: z.string().nullable(),
		createdAt: isoTimestamp,
		deliveredAt: isoTimestamp.nullable(),
	}),
);

export const EventEnvelopeSchema = component(
	"EventEnvelope",
	z.object({
		type: z.literal("event"),
		ts: isoTimestamp,
		burrowId: z.string(),
		runId: z.string().nullable(),
		seq: z.number().int().nonnegative(),
		kind: z.string(),
		stream: z.enum(EVENT_STREAMS),
		payload: z.unknown(),
	}),
);

/* ----------------------------------------------------------------------- */
/* Dashboard envelope (SPEC §26)                                            */
/* ----------------------------------------------------------------------- */

const RunSummarySchema = component(
	"RunSummary",
	z.object({
		id: z.string(),
		burrowId: z.string(),
		agentId: z.string(),
		state: z.enum(RUN_STATES),
		exitCode: z.number().int().nullable(),
		errorMessage: z.string().nullable(),
		queuedAt: isoTimestamp,
		startedAt: isoTimestamp.nullable(),
		completedAt: isoTimestamp.nullable(),
	}),
);

const EventTailEntrySchema = component(
	"EventTailEntry",
	z.object({
		burrowId: z.string(),
		runId: z.string().nullable(),
		seq: z.number().int().nonnegative(),
		kind: z.string(),
		stream: z.enum(EVENT_STREAMS),
		ts: isoTimestamp,
		payload: z.unknown(),
	}),
);

const BurrowCardSchema = component(
	"BurrowCard",
	z.object({
		id: z.string(),
		parentId: z.string().nullable(),
		kind: z.enum(BURROW_KINDS),
		name: z.string().nullable(),
		state: z.enum(BURROW_STATES),
		projectRoot: z.string(),
		workspacePath: z.string(),
		branch: z.string(),
		provider: z.string(),
		createdAt: isoTimestamp,
		updatedAt: isoTimestamp,
		destroyedAt: isoTimestamp.nullable(),
		runs: z.array(RunSummarySchema),
		activeRun: RunSummarySchema.nullable(),
		eventTail: z.array(EventTailEntrySchema),
		lastEventSeq: z.number().int().nonnegative().nullable(),
	}),
);

export const DashboardSnapshotSchema = component(
	"DashboardSnapshot",
	z.object({
		type: z.literal("snapshot"),
		version: z.literal(1),
		ts: isoTimestamp,
		burrows: z.array(BurrowCardSchema),
	}),
);

/* ----------------------------------------------------------------------- */
/* Agents (§15.5)                                                           */
/* ----------------------------------------------------------------------- */

const InstallCheckResultSchema = component(
	"InstallCheckResult",
	z.object({
		installed: z.boolean(),
		version: z.string().optional(),
		hint: z.string().optional(),
		path: z.string().optional(),
	}),
);

export const AgentDetailSchema = component(
	"AgentDetail",
	z.object({
		id: z.string(),
		displayName: z.string(),
		supportsResume: z.boolean(),
		spawnPerTurn: z.boolean(),
		install: InstallCheckResultSchema,
	}),
);

/* ----------------------------------------------------------------------- */
/* Destroy (§14.4)                                                          */
/* ----------------------------------------------------------------------- */

const ArchiveBurrowResultSchema = component(
	"ArchiveBurrowResult",
	z.object({
		burrowId: z.string(),
		directory: z.string(),
		eventsPath: z.string(),
		messagesPath: z.string(),
		runsPath: z.string(),
		eventCount: z.number().int().nonnegative(),
		messageCount: z.number().int().nonnegative(),
		runCount: z.number().int().nonnegative(),
	}),
);

export const DestroyBurrowResultSchema = component(
	"DestroyBurrowResult",
	z.object({
		burrowId: z.string(),
		archived: ArchiveBurrowResultSchema.nullable(),
		deletedEvents: z.number().int().nonnegative(),
		deletedMessages: z.number().int().nonnegative(),
		deletedRuns: z.number().int().nonnegative(),
	}),
);

/* ----------------------------------------------------------------------- */
/* Errors                                                                   */
/* ----------------------------------------------------------------------- */

export const ErrorEnvelopeSchema = component(
	"ErrorEnvelope",
	z.object({
		error: z.object({
			code: z.string(),
			message: z.string(),
			hint: z.string().optional(),
		}),
	}),
);

/* ----------------------------------------------------------------------- */
/* Health                                                                   */
/* ----------------------------------------------------------------------- */

export const HealthResponseSchema = component("HealthResponse", z.object({ ok: z.literal(true) }));

/* ----------------------------------------------------------------------- */
/* Request bodies                                                           */
/* ----------------------------------------------------------------------- */

export const WorkspaceFileSchema = component(
	"WorkspaceFile",
	z.object({
		path: z
			.string()
			.min(1)
			.describe(
				"Workspace-relative path. Must stay inside `burrow.workspacePath`; absolute paths, `..` traversal, symlink escapes, and overwrites of `.git/` or sandbox-owned paths are rejected (400 validation_error).",
			),
		contents: z
			.string()
			.describe(
				"File contents. UTF-8 text by default; if `encoding` is `base64`, the decoded bytes are written.",
			),
		encoding: z
			.enum(["utf-8", "base64"])
			.optional()
			.describe(
				"Encoding of `contents`. Defaults to `utf-8`. Use `base64` for binary payloads — multipart upload is a future, additive extension (R-07 V1 ships JSON only).",
			),
		mode: z
			.number()
			.int()
			.min(0)
			.max(0o777)
			.optional()
			.describe("POSIX mode bits applied with chmod after write (0–0o777). Defaults to 0o644."),
	}),
);

export const WriteFilesBodySchema = component(
	"WriteFilesBody",
	z.object({
		files: z
			.array(WorkspaceFileSchema)
			.min(1)
			.describe(
				"One or more files to write into the burrow workspace. Writes are all-or-nothing: a single rejected entry aborts the batch with no partial-state side effects.",
			),
	}),
);

export const WriteFilesResponseSchema = component(
	"WriteFilesResponse",
	z.object({
		written: z
			.number()
			.int()
			.nonnegative()
			.describe("Number of files written (matches `body.files.length` on success)."),
	}),
);

export const CreateBurrowBodySchema = component(
	"CreateBurrowBody",
	z.object({
		projectRoot: z.string().min(1).describe("Absolute host path to the project root."),
		name: z.string().optional(),
		branch: z.string().optional(),
		baseBranch: z.string().optional(),
		originUrl: z.string().optional(),
		network: z.enum(NETWORK_POLICIES).optional(),
		provider: z.string().optional(),
		agents: z
			.array(z.string().min(1))
			.optional()
			.describe(
				"Built-in runtime ids to enable as `[[agents]]` patch rows. Forwarded by orchestrators (e.g. warren) so the sandbox profile mounts the runtime's binary even when the project clone has no `burrow.toml`.",
			),
		seed: WriteFilesBodySchema.optional().describe(
			"Optional workspace seed payload. Files are written into the new workspace before the burrow is returned, atomic with provisioning — single round-trip for orchestrators (e.g. warren) that need to drop `.canopy/`, `.mulch/`, `.seeds/` inputs before the agent starts. Same path-validation rules as `POST /burrows/{id}/files`.",
		),
	}),
);

export const CreateRunBodySchema = component(
	"CreateRunBody",
	z.object({
		agentId: z.string().min(1),
		prompt: z.string().min(1),
		metadata: z.unknown().optional(),
	}),
);

export const CancelRunBodySchema = component(
	"CancelRunBody",
	z.object({
		reason: z
			.string()
			.optional()
			.describe(
				"Free-form note recorded on the run's `errorMessage` and emitted in the `run_cancelled` event payload. Optional — POSTs with no body cancel without a reason.",
			),
	}),
);

export const SendInboxBodySchema = component(
	"SendInboxBody",
	z.object({
		body: z.string().min(1),
		priority: z.enum(MESSAGE_PRIORITIES).optional(),
		fromActor: z.string().optional(),
	}),
);

/* ----------------------------------------------------------------------- */
/* Admin (pl-cb3e step 4 / burrow-79ad)                                     */
/* ----------------------------------------------------------------------- */

export const DrainBodySchema = component(
	"DrainBody",
	z.object({
		drain: z
			.boolean()
			.describe(
				"When true, mark the worker as draining: `POST /burrows` and `POST /burrows/:id/runs` return 503 `worker_draining`; in-flight runs and streams continue to terminal state. When false, restore acceptance. No string coercion — must be a JSON boolean.",
			),
	}),
);

export const DrainStateSchema = component(
	"DrainState",
	z.object({
		drain: z
			.boolean()
			.describe(
				"The dispatcher's drain bit after the request. Idempotent: setting drain to its current value still returns 200 with the same echo.",
			),
	}),
);

/* ----------------------------------------------------------------------- */
/* Query parameter primitives (used by spec.ts for parameter authoring)     */
/* ----------------------------------------------------------------------- */

export const QueryEnums = {
	burrowKind: BURROW_KINDS,
	burrowState: BURROW_STATES,
	messageState: MESSAGE_STATES,
} as const;
