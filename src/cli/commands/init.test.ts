import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BURROW_TOML_FILENAME } from "../../config/burrow-toml-loader.ts";
import { ValidationError } from "../../core/errors.ts";
import { parseBurrowToml } from "../../schemas/burrow-toml.ts";
import { renderInitResult, runInitCommand } from "./init.ts";

describe("runInitCommand", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "burrow-init-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("writes a burrow.toml that parses cleanly back via parseBurrowToml", async () => {
		const result = await runInitCommand({ projectRoot });
		expect(result.written).toBe(true);
		expect(existsSync(join(projectRoot, BURROW_TOML_FILENAME))).toBe(true);
		const raw = readFileSync(join(projectRoot, BURROW_TOML_FILENAME), "utf8");
		const parsed = parseBurrowToml(raw);
		expect(parsed.ok).toBe(true);
		expect(parsed.config?.project?.name).toBe(result.source.split("/").at(-2));
	});

	test("dry-run emits contents without writing", async () => {
		const result = await runInitCommand({ projectRoot, dryRun: true });
		expect(result.written).toBe(false);
		expect(existsSync(join(projectRoot, BURROW_TOML_FILENAME))).toBe(false);
		expect(result.contents).toContain("[sandbox]");
	});

	test("detects toolchains from project signals", async () => {
		writeFileSync(join(projectRoot, "package.json"), `{"name":"x"}`);
		writeFileSync(join(projectRoot, "bun.lock"), `{}`);
		writeFileSync(join(projectRoot, "pyproject.toml"), ``);
		const result = await runInitCommand({ projectRoot });
		expect(result.detected.hasNode).toBe(true);
		expect(result.detected.hasBun).toBe(true);
		expect(result.detected.hasPython).toBe(true);
		expect(result.contents).toContain(`bun = "1.1"`);
		expect(result.contents).toContain(`node = ">=20"`);
		expect(result.contents).toContain(`python = "3.12"`);
	});

	test("refuses to overwrite an existing burrow.toml without --force", async () => {
		writeFileSync(join(projectRoot, BURROW_TOML_FILENAME), `[project]\nname = "x"\n`);
		await expect(runInitCommand({ projectRoot })).rejects.toBeInstanceOf(ValidationError);
	});

	test("--force overwrites an existing file", async () => {
		writeFileSync(join(projectRoot, BURROW_TOML_FILENAME), `# old\n`);
		const result = await runInitCommand({ projectRoot, force: true, name: "fresh" });
		expect(result.written).toBe(true);
		const raw = readFileSync(join(projectRoot, BURROW_TOML_FILENAME), "utf8");
		expect(raw).toContain(`name = "fresh"`);
	});
});

describe("renderInitResult", () => {
	test("written result mentions the source path + next-step hint", () => {
		const out = renderInitResult({
			source: "/x/burrow.toml",
			contents: "...",
			written: true,
			detected: { hasNode: true, hasBun: false, hasPython: false, hasRust: false, hasGo: false },
			agents: [],
		});
		expect(out).toContain("/x/burrow.toml");
		expect(out).toContain("burrow doctor");
		expect(out).toContain("node");
	});

	test("dry-run result mentions (dry-run)", () => {
		const out = renderInitResult({
			source: "/x/burrow.toml",
			contents: "...",
			written: false,
			detected: { hasNode: false, hasBun: false, hasPython: false, hasRust: false, hasGo: false },
			agents: [],
		});
		expect(out).toContain("dry-run");
	});

	test("includes the resolved agent ids when present", () => {
		const out = renderInitResult({
			source: "/x/burrow.toml",
			contents: "...",
			written: true,
			detected: { hasNode: false, hasBun: false, hasPython: false, hasRust: false, hasGo: false },
			agents: ["claude-code"],
		});
		expect(out).toContain("agents: claude-code");
	});
});

describe("runInitCommand — agent positional args", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "burrow-init-agents-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("`bw init claude` resolves the alias and bakes [[agents]]", async () => {
		const result = await runInitCommand({ projectRoot, agents: ["claude"] });
		expect(result.agents).toEqual(["claude-code"]);
		const raw = readFileSync(join(projectRoot, BURROW_TOML_FILENAME), "utf8");
		expect(raw).toContain("[[agents]]");
		expect(raw).toContain(`id = "claude-code"`);
		const parsed = parseBurrowToml(raw);
		expect(parsed.ok).toBe(true);
		expect(parsed.config?.agents?.[0]?.id).toBe("claude-code");
	});

	test("multiple aliases dedupe to canonical ids", async () => {
		const result = await runInitCommand({
			projectRoot,
			agents: ["claude", "cc", "sapling"],
		});
		expect(result.agents).toEqual(["claude-code", "sapling"]);
		const raw = readFileSync(join(projectRoot, BURROW_TOML_FILENAME), "utf8");
		expect(raw.match(/\[\[agents\]\]/g)?.length).toBe(2);
	});

	test("`bw init pi` recognizes pi as a built-in canonical id", async () => {
		const result = await runInitCommand({ projectRoot, agents: ["pi"] });
		expect(result.agents).toEqual(["pi"]);
		const raw = readFileSync(join(projectRoot, BURROW_TOML_FILENAME), "utf8");
		expect(raw).toContain(`id = "pi"`);
		const parsed = parseBurrowToml(raw);
		expect(parsed.ok).toBe(true);
		expect(parsed.config?.agents?.[0]?.id).toBe("pi");
	});

	test("unknown agent token throws ValidationError BEFORE writing", async () => {
		await expect(runInitCommand({ projectRoot, agents: ["gemini"] })).rejects.toBeInstanceOf(
			ValidationError,
		);
		expect(existsSync(join(projectRoot, BURROW_TOML_FILENAME))).toBe(false);
	});

	test("baking agents replaces the trailing example-comment block", async () => {
		const result = await runInitCommand({ projectRoot, agents: ["claude"] });
		// When agents are baked we drop the "Add agents that aren't built-in" tip.
		expect(result.contents).not.toContain('# id = "my-custom-agent"');
	});
});
