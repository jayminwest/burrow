import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BURROW_TOML_FILENAME } from "../../config/burrow-toml-loader.ts";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { parseBurrowToml } from "../../schemas/burrow-toml.ts";
import { renderAgentStanza, renderAgentsAddResult, runAgentsAdd } from "./agents-add.ts";

describe("renderAgentStanza", () => {
	test("built-in renders id-only with a hint comment", () => {
		const out = renderAgentStanza("claude-code");
		expect(out).toContain("[[agents]]");
		expect(out).toContain(`id = "claude-code"`);
		expect(out).toContain("Built-in runtime");
	});

	test("non-built-in renders a skeleton with command/args placeholders", () => {
		const out = renderAgentStanza("custom-agent");
		expect(out).toContain(`id = "custom-agent"`);
		expect(out).toContain("# command =");
	});
});

describe("runAgentsAdd", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "burrow-agents-add-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	function writeStarterToml(): void {
		writeFileSync(
			join(projectRoot, BURROW_TOML_FILENAME),
			`[project]\nname = "x"\n[sandbox]\nnetwork = "none"\n`,
		);
	}

	test("appends an [[agents]] block and re-parses cleanly", async () => {
		writeStarterToml();
		const result = await runAgentsAdd({ projectRoot, tokens: ["claude"] });
		expect(result.outcomes).toEqual([{ token: "claude", canonicalId: "claude-code", added: true }]);
		const raw = readFileSync(join(projectRoot, BURROW_TOML_FILENAME), "utf8");
		expect(raw).toContain(`id = "claude-code"`);
		const parsed = parseBurrowToml(raw);
		expect(parsed.ok).toBe(true);
		expect(parsed.config?.agents?.map((a) => a.id)).toContain("claude-code");
	});

	test("is idempotent — second call no-ops with reason", async () => {
		writeStarterToml();
		await runAgentsAdd({ projectRoot, tokens: ["claude"] });
		const result = await runAgentsAdd({ projectRoot, tokens: ["claude"] });
		expect(result.outcomes[0]?.added).toBe(false);
		expect(result.outcomes[0]?.reason).toMatch(/already declared/);
		const raw = readFileSync(join(projectRoot, BURROW_TOML_FILENAME), "utf8");
		expect(raw.match(/\[\[agents\]\]/g)?.length).toBe(1);
	});

	test("preserves existing content (project, sandbox, comments)", async () => {
		writeFileSync(
			join(projectRoot, BURROW_TOML_FILENAME),
			`# top-of-file comment
[project]
name = "preserve-me"

[sandbox]
network = "restricted"
`,
		);
		await runAgentsAdd({ projectRoot, tokens: ["sapling"] });
		const raw = readFileSync(join(projectRoot, BURROW_TOML_FILENAME), "utf8");
		expect(raw).toContain("# top-of-file comment");
		expect(raw).toContain(`name = "preserve-me"`);
		expect(raw).toContain(`network = "restricted"`);
		expect(raw).toContain(`id = "sapling"`);
	});

	test("multiple tokens add in one shot, dedupe across the batch", async () => {
		writeStarterToml();
		const result = await runAgentsAdd({
			projectRoot,
			tokens: ["claude", "cc", "codex"],
		});
		const added = result.outcomes.filter((o) => o.added).map((o) => o.canonicalId);
		expect(added).toEqual(["claude-code", "codex"]);
	});

	test("recognizes `pi` as a built-in id", async () => {
		writeStarterToml();
		const result = await runAgentsAdd({ projectRoot, tokens: ["pi"] });
		expect(result.outcomes).toEqual([{ token: "pi", canonicalId: "pi", added: true }]);
		const raw = readFileSync(join(projectRoot, BURROW_TOML_FILENAME), "utf8");
		expect(raw).toContain(`id = "pi"`);
	});

	test("unknown token errors BEFORE mutating the file", async () => {
		writeStarterToml();
		await expect(runAgentsAdd({ projectRoot, tokens: ["gemini"] })).rejects.toBeInstanceOf(
			ValidationError,
		);
		const raw = readFileSync(join(projectRoot, BURROW_TOML_FILENAME), "utf8");
		expect(raw).not.toContain("[[agents]]");
	});

	test("missing burrow.toml throws NotFoundError pointing at `bw init`", async () => {
		try {
			await runAgentsAdd({ projectRoot, tokens: ["claude"] });
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(NotFoundError);
			expect((err as Error).message).toContain("burrow.toml");
		}
	});

	test("empty token list errors with a known-builtins hint", async () => {
		writeStarterToml();
		try {
			await runAgentsAdd({ projectRoot, tokens: [] });
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ValidationError);
			const hint = (err as ValidationError).recoveryHint ?? "";
			expect(hint).toContain("claude-code");
		}
	});
});

describe("renderAgentsAddResult", () => {
	test("formats added rows with ✓ and skip rows with the reason", () => {
		const out = renderAgentsAddResult({
			source: "/x/burrow.toml",
			outcomes: [
				{ token: "claude", canonicalId: "claude-code", added: true },
				{
					token: "sapling",
					canonicalId: "sapling",
					added: false,
					reason: "already declared in burrow.toml",
				},
			],
		});
		expect(out).toContain("✓ added");
		expect(out).toContain("claude-code");
		expect(out).toContain("alias for claude");
		expect(out).toContain("already declared");
	});
});
