/**
 * Zod schema for `burrow.toml` (SPEC §17).
 *
 * The team contract: every field is optional. `parseBurrowToml(raw)` accepts a
 * TOML string, parses with smol-toml, and validates with Zod. Top-level keys
 * are normalised to snake_case → camelCase so callers in TS see ergonomic
 * field names while the on-disk file stays idiomatic TOML.
 *
 * Schema-validation errors mirror the AgentConfig path/message shape so the
 * CLI renderer can format both with one helper.
 */

import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { ValidationError } from "../core/errors.ts";
import { AgentConfigSchema } from "./agent-config.ts";

export const NETWORK_POLICIES = ["none", "restricted", "open"] as const;
export type BurrowTomlNetworkPolicy = (typeof NETWORK_POLICIES)[number];

export const TOOLCHAIN_MODES = ["binary", "shim-aware"] as const;
export type BurrowTomlToolchainMode = (typeof TOOLCHAIN_MODES)[number];

export const GIT_IDENTITY_KINDS = ["user", "bot"] as const;
export type BurrowTomlGitIdentity = (typeof GIT_IDENTITY_KINDS)[number];

export const GIT_CREDENTIAL_KINDS = ["ssh-agent", "managed-key", "token"] as const;
export type BurrowTomlGitCredentials = (typeof GIT_CREDENTIAL_KINDS)[number];

const ProjectSchema = z
	.object({
		name: z.string().min(1).optional(),
		default_branch: z.string().min(1).optional(),
		origin: z.string().min(1).optional(),
	})
	.strict();

const SandboxSchema = z
	.object({
		network: z.enum(NETWORK_POLICIES).optional(),
		allowed_domains: z.array(z.string().min(1)).optional(),
		timeout_minutes: z.number().int().positive().optional(),
		memory_limit_mb: z.number().int().positive().optional(),
		cpu_limit: z.number().positive().optional(),
		toolchain_mode: z.enum(TOOLCHAIN_MODES).optional(),
	})
	.strict();

const EnvSchema = z
	.object({
		required: z.array(z.string().min(1)).optional(),
		optional: z.array(z.string().min(1)).optional(),
		defaults: z.record(z.string(), z.string()).optional(),
	})
	.strict();

const GitSchema = z
	.object({
		identity: z.enum(GIT_IDENTITY_KINDS).optional(),
		bot_name: z.string().min(1).optional(),
		bot_email: z.string().min(1).optional(),
		read_only_main_branch: z.boolean().optional(),
		credentials: z.enum(GIT_CREDENTIAL_KINDS).optional(),
		token_env: z.string().min(1).optional(),
	})
	.strict();

const HooksSchema = z
	.object({
		post_create: z.array(z.string().min(1)).optional(),
		pre_destroy: z.array(z.string().min(1)).optional(),
	})
	.strict();

export const SHIP_TARGETS = ["tarball", "docker", "fly"] as const;
export type BurrowTomlShipTarget = (typeof SHIP_TARGETS)[number];

const ShipTarballSchema = z
	.object({
		out_dir: z.string().min(1).optional(),
		out: z.string().min(1).optional(),
		include: z.array(z.string().min(1)).optional(),
	})
	.strict();

const ShipDockerSchema = z
	.object({
		image: z.string().min(1),
		tag: z.string().min(1).optional(),
		dockerfile: z.string().min(1).optional(),
		context: z.string().min(1).optional(),
		platforms: z.array(z.string().min(1)).optional(),
		build_args: z.record(z.string().min(1), z.string()).optional(),
	})
	.strict();

const ShipFlySchema = z
	.object({
		app: z.string().min(1),
		config: z.string().min(1).optional(),
		strategy: z.string().min(1).optional(),
		region: z.string().min(1).optional(),
	})
	.strict();

const ShipSchema = z
	.object({
		default_target: z.enum(SHIP_TARGETS).optional(),
		build: z.array(z.string().min(1)).optional(),
		tarball: ShipTarballSchema.optional(),
		docker: ShipDockerSchema.optional(),
		fly: ShipFlySchema.optional(),
	})
	.strict();

export type BurrowTomlShip = z.infer<typeof ShipSchema>;
export type BurrowTomlShipTarball = z.infer<typeof ShipTarballSchema>;
export type BurrowTomlShipDocker = z.infer<typeof ShipDockerSchema>;
export type BurrowTomlShipFly = z.infer<typeof ShipFlySchema>;

/**
 * Per-toolchain version spec. Either a bare version string ("20", ">=1.1"),
 * or a richer object so callers can also pin the binary name explicitly.
 */
const ToolchainSpecSchema = z.union([
	z.string().min(1),
	z
		.object({
			version: z.string().min(1),
			binary: z.string().min(1).optional(),
		})
		.strict(),
]);

/**
 * The `[[agents]]` array. Agents are not full AgentConfig records: a single
 * `id` row patches a built-in (just to *enable* it explicitly), while a
 * complete row defines a new declarative runtime. We accept both by relaxing
 * AgentConfigSchema to its partial shape and re-asserting that `id` is
 * present.
 */
const BurrowTomlAgentSchema = AgentConfigSchema.partial()
	.extend({
		id: z.string().min(1),
	})
	.passthrough();

export const BurrowTomlSchema = z
	.object({
		project: ProjectSchema.optional(),
		sandbox: SandboxSchema.optional(),
		toolchain: z.record(z.string().min(1), ToolchainSpecSchema).optional(),
		env: EnvSchema.optional(),
		secrets: z.record(z.string().min(1), z.string()).optional(),
		git: GitSchema.optional(),
		hooks: HooksSchema.optional(),
		agents: z.array(BurrowTomlAgentSchema).optional(),
		ship: ShipSchema.optional(),
	})
	.strict();

export type BurrowToml = z.infer<typeof BurrowTomlSchema>;
export type BurrowTomlAgent = z.infer<typeof BurrowTomlAgentSchema>;
export type BurrowTomlToolchainSpec = z.infer<typeof ToolchainSpecSchema>;

export interface BurrowTomlParseError {
	path: (string | number)[];
	message: string;
}

export interface BurrowTomlParseResult {
	ok: boolean;
	config?: BurrowToml;
	errors?: BurrowTomlParseError[];
}

/**
 * Parse a TOML string. Returns `{ ok:false, errors }` on TOML or schema
 * failures so callers can build a single error report. The CLI's `init`
 * + `doctor` paths translate failures to `ValidationError`.
 */
export function parseBurrowToml(raw: string): BurrowTomlParseResult {
	let data: unknown;
	try {
		data = parseToml(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, errors: [{ path: [], message: `TOML parse error: ${message}` }] };
	}
	const res = BurrowTomlSchema.safeParse(data);
	if (res.success) return { ok: true, config: res.data };
	return {
		ok: false,
		errors: res.error.issues.map((i) => ({
			path: [...i.path] as (string | number)[],
			message: i.message,
		})),
	};
}

/**
 * Convenience: throws `ValidationError` if parsing/validation fails.
 * Used by CLI commands that already wrap errors via `formatError`.
 */
export function parseBurrowTomlOrThrow(raw: string, sourceHint?: string): BurrowToml {
	const res = parseBurrowToml(raw);
	if (res.ok && res.config) return res.config;
	const errors = res.errors ?? [{ path: [], message: "unknown error" }];
	const lines = errors.map(
		(e) => `${e.path.length === 0 ? "(root)" : e.path.join(".")}: ${e.message}`,
	);
	const head = sourceHint ? `invalid burrow.toml (${sourceHint})` : "invalid burrow.toml";
	throw new ValidationError(`${head}:\n  ${lines.join("\n  ")}`, {
		recoveryHint: "fix the listed fields and re-run; see SPEC §17 for the schema",
	});
}

/**
 * Normalise a toolchain spec to its `{version, binary}` form. The default
 * binary name is the toolchain key (e.g. `node`, `bun`).
 */
export function normalizeToolchainSpec(
	key: string,
	spec: BurrowTomlToolchainSpec,
): { version: string; binary: string } {
	if (typeof spec === "string") return { version: spec, binary: key };
	return { version: spec.version, binary: spec.binary ?? key };
}
