/**
 * `burrow init` — scaffold `burrow.toml` in the current project (SPEC §17.2).
 *
 * Detects common project signals (package.json, pyproject.toml, Cargo.toml,
 * go.mod) to seed the [toolchain] block with a sensible default version
 * range. The user is expected to review and commit; we deliberately err on
 * the side of "small but useful" — missing toolchains are fine to add later.
 *
 * Positional agent args (e.g. `bw init claude`) bake `[[agents]]` stanzas
 * into the file so the project is ready to run that runtime out of the box.
 * Aliases collapse via `resolveAgentAlias`; unknown tokens fail loudly.
 *
 * Refuses to overwrite an existing `burrow.toml` unless `--force` is set.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { BURROW_TOML_FILENAME, loadBurrowToml } from "../../config/burrow-toml-loader.ts";
import { ValidationError } from "../../core/errors.ts";
import { knownBuiltInIds, resolveAgentAlias } from "../../runtime/aliases.ts";
import { renderAgentStanza } from "./agents-add.ts";

export interface InitCommandOptions {
	/** Project root. Defaults to process.cwd(). */
	projectRoot?: string;
	/** Override the burrow.toml's [project].name (default: dirname). */
	name?: string;
	/** Overwrite an existing burrow.toml. */
	force?: boolean;
	/** Render but don't write — surfaces the contents on stdout. */
	dryRun?: boolean;
	/**
	 * Agents (aliases or canonical ids) to bake into the scaffolded file.
	 * Each becomes an `[[agents]]` stanza. Unknown tokens throw
	 * `ValidationError` before any file is written.
	 */
	agents?: string[];
}

export interface InitCommandResult {
	source: string;
	contents: string;
	written: boolean;
	detected: DetectedToolchains;
	/** Canonical agent ids that were baked in (after alias resolution). */
	agents: string[];
}

interface DetectedToolchains {
	hasNode: boolean;
	hasBun: boolean;
	hasPython: boolean;
	hasRust: boolean;
	hasGo: boolean;
}

export async function runInitCommand(opts: InitCommandOptions = {}): Promise<InitCommandResult> {
	const projectRoot = resolve(opts.projectRoot ?? process.cwd());
	const target = join(projectRoot, BURROW_TOML_FILENAME);

	// Resolve agent tokens BEFORE the existence check so a typo fails fast,
	// before we annoy the user with an "already exists" error they then have
	// to retry to discover the real problem.
	const agentIds = resolveAgentTokens(opts.agents ?? []);

	if (existsSync(target) && !opts.force && !opts.dryRun) {
		// Validate it parses — if so, surface a friendly "already exists".
		await loadBurrowToml(projectRoot);
		throw new ValidationError(`${target} already exists`, {
			recoveryHint:
				"re-run with --force to overwrite, or run `burrow agents add <id>` to add an agent in place",
		});
	}

	const detected = detectToolchains(projectRoot);
	const projectName = opts.name ?? basename(projectRoot);
	const contents = renderBurrowToml({ projectName, detected, agentIds });

	if (opts.dryRun) {
		return { source: target, contents, written: false, detected, agents: agentIds };
	}

	await writeFile(target, contents, "utf8");
	return { source: target, contents, written: true, detected, agents: agentIds };
}

function resolveAgentTokens(tokens: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const token of tokens) {
		const canonical = resolveAgentAlias(token);
		if (!canonical) {
			throw new ValidationError(`unknown agent: '${token}'`, {
				recoveryHint: `known built-ins: ${knownBuiltInIds().join(", ")}`,
			});
		}
		if (seen.has(canonical)) continue;
		seen.add(canonical);
		out.push(canonical);
	}
	return out;
}

function detectToolchains(projectRoot: string): DetectedToolchains {
	return {
		hasNode: existsSync(join(projectRoot, "package.json")),
		hasBun:
			existsSync(join(projectRoot, "bun.lock")) ||
			existsSync(join(projectRoot, "bunfig.toml")) ||
			detectsBunInPackageJson(projectRoot),
		hasPython:
			existsSync(join(projectRoot, "pyproject.toml")) ||
			existsSync(join(projectRoot, "requirements.txt")),
		hasRust: existsSync(join(projectRoot, "Cargo.toml")),
		hasGo: existsSync(join(projectRoot, "go.mod")),
	};
}

function detectsBunInPackageJson(projectRoot: string): boolean {
	try {
		const raw = readFileSync(join(projectRoot, "package.json"), "utf8");
		return /"bun"\s*:/.test(raw);
	} catch {
		return false;
	}
}

interface RenderOptions {
	projectName: string;
	detected: DetectedToolchains;
	agentIds: string[];
}

function renderBurrowToml(opts: RenderOptions): string {
	const lines: string[] = [
		`# burrow.toml — project contract for the Burrow sandbox runtime.`,
		`# See SPEC §17 for the full schema. Every field is optional.`,
		``,
		`[project]`,
		`name = "${escapeTomlString(opts.projectName)}"`,
		`default_branch = "main"`,
		``,
		`[sandbox]`,
		`network = "restricted"   # one of: none | restricted | open`,
		`allowed_domains = [`,
		`  "registry.npmjs.org",`,
		`  "github.com",`,
		`  "api.anthropic.com",`,
		`]`,
		`timeout_minutes = 60`,
		``,
	];

	if (hasAnyToolchain(opts.detected)) {
		lines.push("[toolchain]");
		if (opts.detected.hasBun) lines.push(`bun = "1.1"`);
		if (opts.detected.hasNode) lines.push(`node = ">=20"`);
		if (opts.detected.hasPython) lines.push(`python = "3.12"`);
		if (opts.detected.hasRust) lines.push(`cargo = ">=1.75"`);
		if (opts.detected.hasGo) lines.push(`go = ">=1.22"`);
		lines.push("");
	}

	lines.push(
		`[env]`,
		`# required = ["DATABASE_URL"]   # burrow up fails until these resolve`,
		`# optional = ["SENTRY_DSN"]     # missing optionals are silently dropped`,
		``,
		`# [secrets]`,
		`# DATABASE_URL = "op://Engineering/web-app-dev/db_url"   # 1Password ref`,
		`# STRIPE_SECRET_KEY = "literal-fallback"                # plain literal`,
		``,
		`[git]`,
		`identity = "user"                # user | bot`,
		`read_only_main_branch = true     # block pushes to default_branch`,
		`credentials = "ssh-agent"        # ssh-agent | managed-key | token`,
		``,
	);

	if (opts.agentIds.length > 0) {
		lines.push(
			`# Agents declared for this project. Built-ins (claude-code, sapling, codex, pi)`,
			`# are auto-registered; an explicit entry pins the choice and lets you patch`,
			`# defaults without forking the runtime.`,
			``,
		);
		for (const id of opts.agentIds) {
			lines.push(renderAgentStanza(id));
		}
	} else {
		lines.push(
			`# Add agents that aren't built-in here. Built-in ids: claude-code, sapling, codex, pi.`,
			`# Run \`burrow agents add <id>\` to append an entry without editing this file.`,
			`# [[agents]]`,
			`# id = "my-custom-agent"`,
			`# displayName = "Custom"`,
			`# command = "./scripts/agent.sh"`,
			`# args = ["--prompt", "{{prompt}}"]`,
			`# outputFormat = "raw-text"`,
			`# promptDelivery = "arg"`,
			``,
		);
	}
	return lines.join("\n");
}

function hasAnyToolchain(d: DetectedToolchains): boolean {
	return d.hasNode || d.hasBun || d.hasPython || d.hasRust || d.hasGo;
}

function escapeTomlString(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function renderInitResult(result: InitCommandResult): string {
	const head = result.written
		? `✓ wrote ${result.source}`
		: `(dry-run) would write ${result.source}`;
	const detected = formatDetected(result.detected);
	const lines = [head];
	if (detected.length > 0) lines.push(`  detected toolchains: ${detected.join(", ")}`);
	if (result.agents.length > 0) lines.push(`  agents: ${result.agents.join(", ")}`);
	if (result.written) {
		lines.push(``, `Next: review the file, commit it, then run \`burrow doctor\`.`);
	}
	return lines.join("\n");
}

function formatDetected(d: DetectedToolchains): string[] {
	const out: string[] = [];
	if (d.hasNode) out.push("node");
	if (d.hasBun) out.push("bun");
	if (d.hasPython) out.push("python");
	if (d.hasRust) out.push("cargo");
	if (d.hasGo) out.push("go");
	return out;
}
