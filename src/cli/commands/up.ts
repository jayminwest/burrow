/**
 * `burrow up` — create + start a project burrow (SPEC §16, §11).
 *
 * Phase 8 wiring: load `burrow.toml` from the project root, run `burrow
 * doctor` (toolchain + sandbox + op CLI), resolve `[env]` + `[secrets]` into
 * `SandboxProfile.setEnv`, and lift `[sandbox]` directives onto the profile.
 *
 * The burrow row stores enough state for later phases to pick it up:
 *   - `providerStateJson.workspaceSource` so destroy can remove the worktree.
 *   - `profileJson` so the runner can rebuild the sandbox profile per turn.
 *
 * Doctor failures throw `ValidationError`; the user runs `burrow doctor` to
 * see the per-row breakdown. CLI flag overrides win over `burrow.toml`, which
 * wins over built-in defaults (SPEC §17.1).
 */

import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { loadBurrowToml } from "../../config/burrow-toml-loader.ts";
import { ValidationError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import type { Burrow, BurrowKind } from "../../core/types.ts";
import type { AgentsClient, Client } from "../../lib/client.ts";
import {
	type MaterializedWorkspace,
	type MaterializeProjectOptions,
	materializeProjectWorkspace,
} from "../../provider/local/workspace.ts";
import type { NetworkPolicy, SandboxProfile } from "../../provider/types.ts";
import type { BurrowToml } from "../../schemas/burrow-toml.ts";
import { resolveEnv } from "../../secrets/env.ts";
import type { OpResolver } from "../../secrets/op.ts";
import { loadSecretStore } from "../../secrets/store.ts";
import { expandToolchainBinDirs, resolveBunGlobalInstallDir } from "../../toolchain/paths.ts";
import { assertDoctorOk, type DoctorReport, runDoctor } from "./doctor.ts";

const DEFAULT_BRANCH_PREFIX = "burrow";
const NETWORK_POLICIES: readonly NetworkPolicy[] = ["none", "restricted", "open"];

export interface UpCommandOptions {
	name?: string;
	branch?: string;
	baseBranch?: string;
	originUrl?: string;
	network?: string;
	provider?: string;
	json?: boolean;
}

export interface UpCommandInput {
	client: Client;
	projectRoot: string;
	options: UpCommandOptions;
	/** Test seam for `materializeProjectWorkspace`. */
	materializer?: (opts: MaterializeProjectOptions) => Promise<MaterializedWorkspace>;
	/** Override the projects base directory. Defaults to `client.paths.projectsDir`. */
	projectsDir?: string;
	/**
	 * Inject an OpResolver. Tests pass a fake; the CLI defaults to the real
	 * `op read` shell-out.
	 */
	opResolver?: OpResolver;
	/** Skip the embedded `burrow doctor` call (tests). */
	skipDoctor?: boolean;
	/** Inject a doctor runner (tests). */
	doctorRunner?: typeof runDoctor;
	/** Host environment for [env] required/optional resolution. Defaults to process.env. */
	hostEnv?: Record<string, string | undefined>;
	/** CLI overrides that win over [env].defaults / [secrets] / store / host. */
	envOverrides?: Record<string, string>;
	/**
	 * Test seam for the bun-global-install lookup (burrow-aa46). Tests inject
	 * a fake to avoid touching the real `~/.bun` layout; the default uses
	 * `resolveBunGlobalInstallDir()` which inspects host env + filesystem.
	 */
	bunGlobalInstallDirResolver?: () => string | null;
}

export interface UpCommandResult {
	burrow: Burrow;
	workspace: MaterializedWorkspace;
	/** Loaded burrow.toml (null when none was present in the project). */
	burrowToml: BurrowToml | null;
	/** Resolved env vars baked into the sandbox profile. */
	resolvedEnv: Record<string, string>;
}

export function parseNetworkPolicy(raw: string | undefined): NetworkPolicy {
	if (raw === undefined) return "none";
	if (!(NETWORK_POLICIES as readonly string[]).includes(raw)) {
		throw new ValidationError(
			`unknown network policy '${raw}' — expected one of: ${NETWORK_POLICIES.join(", ")}`,
		);
	}
	return raw as NetworkPolicy;
}

export async function runUpCommand(input: UpCommandInput): Promise<UpCommandResult> {
	const projectRoot = resolve(input.projectRoot);
	const provider = input.options.provider ?? "local";

	// 1. Load burrow.toml (parse errors throw ValidationError).
	const loaded = await loadBurrowToml(projectRoot);
	const burrowToml = loaded?.config ?? null;

	// 2. Resolve `[sandbox]` + flag overrides into the network policy. CLI flag
	// wins over burrow.toml which wins over the "none" default (SPEC §17.1).
	const network = resolveNetworkPolicy(input.options.network, burrowToml);

	// 3. Run the doctor before any side effects so a missing toolchain refuses
	// `up` rather than orphaning a worktree (SPEC §19). Keep the report —
	// the OK toolchain rows carry resolved binary paths we'll feed into the
	// sandbox profile so the agent can actually exec them (SPEC §8.4).
	let doctorReport: DoctorReport | null = null;
	if (input.skipDoctor !== true) {
		const doctor = input.doctorRunner ?? runDoctor;
		doctorReport = await doctor({ projectRoot });
		assertDoctorOk(doctorReport);
	}

	// 4. Resolve env + secrets.
	const projectId = burrowToml?.project?.name ?? basename(projectRoot);
	const store = await loadSecretStore({
		secretsDir: input.client.paths.secretsDir,
		projectId,
	});
	const envInput: Parameters<typeof resolveEnv>[0] = {
		config: burrowToml,
		secretsStore: store.merged,
		hostEnv: input.hostEnv ?? process.env,
	};
	if (input.envOverrides) envInput.overrides = input.envOverrides;
	if (input.opResolver) envInput.op = input.opResolver;
	const envResult = await resolveEnv(envInput);

	// 5. Generate the burrow id up front so the workspace path can include it.
	// The id is supplied to BurrowsRepo.create below so insert + workspace
	// dir share the same identifier.
	const burrowId = generateId("burrow");
	const workspacePath = computeWorkspacePath(
		input.projectsDir ?? input.client.paths.projectsDir,
		projectRoot,
		burrowId,
	);
	const branch = input.options.branch ?? `${DEFAULT_BRANCH_PREFIX}/${burrowId}`;

	const materializer = input.materializer ?? materializeProjectWorkspace;
	const matOpts: MaterializeProjectOptions = {
		workspacePath,
		branch,
		createBranch: true,
		baseBranch: input.options.baseBranch ?? burrowToml?.project?.default_branch ?? "main",
		projectRoot,
	};
	if (input.options.originUrl !== undefined) {
		matOpts.originUrl = input.options.originUrl;
	} else if (burrowToml?.project?.origin) {
		matOpts.originUrl = burrowToml.project.origin;
	}
	const workspace = await materializer(matOpts);

	const toolchainPaths = await collectToolchainPaths({
		doctorReport,
		burrowToml,
		registry: input.client.agents,
		bunGlobalInstallDirResolver:
			input.bunGlobalInstallDirResolver ?? (() => resolveBunGlobalInstallDir()),
	});
	const readOnlyMounts = await collectCredentialPaths({
		burrowToml,
		registry: input.client.agents,
	});

	const profile: SandboxProfile = {
		workspace: workspace.workspacePath,
		readOnlyMounts,
		network,
		allowedDomains: burrowToml?.sandbox?.allowed_domains ?? [],
		envPassthrough: [],
		setEnv: envResult.values,
		toolchainPaths,
	};
	const timeoutMinutes = burrowToml?.sandbox?.timeout_minutes;
	if (timeoutMinutes !== undefined) profile.timeoutMs = timeoutMinutes * 60_000;
	const memMb = burrowToml?.sandbox?.memory_limit_mb;
	if (memMb !== undefined) profile.memoryLimitMb = memMb;
	const cpu = burrowToml?.sandbox?.cpu_limit;
	if (cpu !== undefined) profile.cpuLimit = cpu;

	const providerState = {
		workspaceSource: workspace.source,
		identity: workspace.identity,
	};

	const burrow = input.client.repos.burrows.create({
		id: burrowId,
		kind: "project" satisfies BurrowKind,
		name: input.options.name ?? burrowToml?.project?.name ?? null,
		projectRoot,
		workspacePath: workspace.workspacePath,
		branch,
		provider,
		providerState,
		profile,
	});

	return { burrow, workspace, burrowToml, resolvedEnv: envResult.values };
}

function resolveNetworkPolicy(flag: string | undefined, config: BurrowToml | null): NetworkPolicy {
	if (flag !== undefined) return parseNetworkPolicy(flag);
	if (config?.sandbox?.network) return config.sandbox.network;
	return "none";
}

interface CollectToolchainPathsInput {
	doctorReport: DoctorReport | null;
	burrowToml: BurrowToml | null;
	registry: AgentsClient;
	bunGlobalInstallDirResolver: () => string | null;
}

/**
 * Resolve every host directory the sandbox needs read access to so its
 * declared toolchains and agents can run (SPEC §8.4, §19). We pull resolved
 * binary paths from two sources:
 *   - `[toolchain]` rows that the doctor already probed.
 *   - `[[agents]]` rows whose runtime is registered — we ask each runtime's
 *     `installCheck()` for the resolved binary path.
 *
 * Each path is expanded into both its `dirname` and the realpath ancestor
 * (for symlinked installs like `~/.local/bin/claude` →
 * `~/.local/share/claude/versions/...`). A non-installed agent simply
 * contributes nothing here; `bw prompt` still gates on installCheck so a
 * later run against that agent fails with a clean `AgentNotInstalled`.
 *
 * When `bun` is a declared toolchain we additionally mount its global
 * install root (`<BUN_INSTALL>/install/global/node_modules`) so that
 * stub symlinks under `<BUN_INSTALL>/bin/` (e.g. `ml`, `sd`, `cn`) can
 * resolve to their `.ts` source — see burrow-aa46.
 */
async function collectToolchainPaths(input: CollectToolchainPathsInput): Promise<string[]> {
	const resolved: string[] = [];
	let bunIsDeclaredToolchain = false;
	for (const row of input.doctorReport?.toolchain?.results ?? []) {
		if (row.resolvedPath) resolved.push(row.resolvedPath);
		if (row.binary === "bun" && row.resolvedPath) bunIsDeclaredToolchain = true;
	}
	for (const agent of input.burrowToml?.agents ?? []) {
		const rt = input.registry.get(agent.id);
		if (!rt) continue;
		try {
			const check = await rt.installCheck();
			if (check.installed && check.path) resolved.push(check.path);
		} catch {
			// installCheck shouldn't throw, but if a declarative probe fouls up
			// we don't want it taking `burrow up` down with it.
		}
	}
	const expanded = expandToolchainBinDirs(resolved);
	if (bunIsDeclaredToolchain) {
		const bunGlobal = input.bunGlobalInstallDirResolver();
		if (bunGlobal && !expanded.includes(bunGlobal)) {
			expanded.push(bunGlobal);
		}
	}
	return expanded;
}

interface CollectCredentialPathsInput {
	burrowToml: BurrowToml | null;
	registry: AgentsClient;
}

/**
 * Resolve the host paths each declared agent needs read-only inside the
 * sandbox to authenticate (SPEC §17.4). Only registered runtimes that
 * implement `credentialPaths()` contribute, and an agent that sets
 * `forwardCredentials = false` in `burrow.toml` opts out entirely.
 *
 * The result lands on `SandboxProfile.readOnlyMounts`, dedup'd in declaration
 * order so two agents pointing at the same path (e.g. shared `~/.claude`)
 * don't fight over the bind mount. A runtime that throws is treated as
 * contributing nothing — same defensive shape as `collectToolchainPaths`.
 */
async function collectCredentialPaths(input: CollectCredentialPathsInput): Promise<string[]> {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const agent of input.burrowToml?.agents ?? []) {
		if (agent.forwardCredentials === false) continue;
		const rt = input.registry.get(agent.id);
		if (!rt?.credentialPaths) continue;
		try {
			for (const path of await rt.credentialPaths()) {
				if (path.length === 0 || seen.has(path)) continue;
				seen.add(path);
				out.push(path);
			}
		} catch {
			// credentialPaths may stat the host fs; a transient EACCES shouldn't
			// take `burrow up` down — agent runs without forwarded creds and
			// surfaces the auth failure itself.
		}
	}
	return out;
}

export function renderUpResult(result: UpCommandResult): string {
	const lines = [
		`✓ burrow ${result.burrow.id} up`,
		`  branch:    ${result.burrow.branch}`,
		`  workspace: ${result.burrow.workspacePath}`,
		`  source:    ${result.workspace.source.kind}`,
	];
	if (result.workspace.identity) {
		lines.push(
			`  identity:  ${result.workspace.identity.name} <${result.workspace.identity.email}>`,
		);
	}
	return lines.join("\n");
}

function computeWorkspacePath(projectsDir: string, projectRoot: string, burrowId: string): string {
	const slug = projectSlug(projectRoot);
	return join(projectsDir, slug, "workspaces", burrowId);
}

function projectSlug(projectRoot: string): string {
	const trimmed = projectRoot.replace(/\/+$/, "");
	const last = trimmed.split("/").pop() ?? "project";
	return last.replace(/[^A-Za-z0-9_.-]+/g, "-").toLowerCase() || "project";
}

/** Exported helper used by other commands that need to ensure projectsDir exists. */
export async function ensureProjectsDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}
