import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BurrowRow, MessageRow, RunRow } from "../db/schema.ts";
import {
	buildPiArgv,
	encodePiStdin,
	PI_DEFAULT_MODEL,
	PI_DEFAULT_PROVIDER,
	PI_ENV_PASSTHROUGH,
	PI_FORCED_ARGV,
	PI_PROVIDER_ENV_KEYS,
	PI_SESSION_DIR,
	piEnvPassthrough,
	piRuntime,
	readNewestPiSessionId,
} from "./pi.ts";
import type { RuntimeEvent } from "./runtime.ts";

function fakeBurrow(): BurrowRow {
	return {
		id: "bur_pi",
		parentId: null,
		kind: "project",
		name: null,
		projectRoot: "/r",
		workspacePath: "/r/ws",
		branch: "main",
		provider: "local",
		providerStateJson: null,
		profileJson: {},
		state: "active",
		createdAt: new Date(0),
		updatedAt: new Date(0),
		destroyedAt: null,
	};
}

function fakeRun(extra: Partial<RunRow> = {}): RunRow {
	return {
		id: "run_pi",
		burrowId: "bur_pi",
		agentId: "pi",
		prompt: "hello",
		resumeOfRunId: null,
		state: "queued",
		exitCode: null,
		errorMessage: null,
		metadataJson: null,
		queuedAt: new Date(0),
		startedAt: null,
		completedAt: null,
		...extra,
	};
}

function fakeMessage(extra: Partial<MessageRow> = {}): MessageRow {
	return {
		id: "msg_1",
		burrowId: "bur_pi",
		fromActor: "user",
		body: "stop and write tests first",
		priority: "high",
		state: "unread",
		deliveredAtRunId: null,
		createdAt: new Date(0),
		deliveredAt: null,
		...extra,
	};
}

describe("piRuntime identity", () => {
	test("declares id, displayName, and supportsResume:true (burrow-4d8b)", () => {
		expect(piRuntime.id).toBe("pi");
		expect(piRuntime.displayName).toBe("Pi");
		expect(piRuntime.supportsResume).toBe(true);
		// V1 deferred resume; lifted now that the runtime pins a session
		// directory and propagates session_id via extractMetadata.
		expect(piRuntime.buildResumeCommand).toBeDefined();
	});
});

describe("piRuntime.buildSpawnCommand", () => {
	test("renders the locked argv prefix and pins the model", () => {
		const cmd = piRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "fix the bug",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		// Argv prefix is locked — any drop of these flags re-introduces the
		// Gemini-default / interactive-extension / session-persistence
		// hazards documented in src/runtime/pi.ts.
		expect(cmd.argv.slice(0, PI_FORCED_ARGV.length)).toEqual([...PI_FORCED_ARGV]);
		const modelIdx = cmd.argv.indexOf("--model");
		expect(modelIdx).toBeGreaterThan(-1);
		expect(cmd.argv[modelIdx + 1]).toBe(PI_DEFAULT_MODEL);
	});

	test("PI_FORCED_ARGV is the exact frozen prefix (regression guard)", () => {
		// Frozen list — bumping requires verifying the new flag set against
		// pi's RPC behavior and regenerating the golden fixtures. The
		// trailing 'anthropic' slot is the default provider that
		// buildPiArgv swaps out when ctx.frontmatter.provider is set.
		expect(PI_DEFAULT_PROVIDER).toBe("anthropic");
		expect([...PI_FORCED_ARGV]).toEqual([
			"pi",
			"--mode",
			"rpc",
			"--session-dir",
			PI_SESSION_DIR,
			"--no-extensions",
			"--offline",
			"--provider",
			PI_DEFAULT_PROVIDER,
		]);
	});

	test("session-dir is the per-burrow .pi/sessions path (resume storage)", () => {
		expect(PI_SESSION_DIR).toBe(".pi/sessions");
		const cmd = piRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		const idx = cmd.argv.indexOf("--session-dir");
		expect(idx).toBeGreaterThan(-1);
		expect(cmd.argv[idx + 1]).toBe(PI_SESSION_DIR);
		expect(cmd.argv).not.toContain("--no-session");
	});

	test("stdin carries a single RPC prompt command for a plain prompt", () => {
		const cmd = piRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "fix the bug",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(typeof cmd.stdin).toBe("string");
		expect((cmd.stdin as string).endsWith("\n")).toBe(true);
		const lines = (cmd.stdin as string).split("\n").slice(0, -1);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toEqual({
			type: "prompt",
			message: "fix the bug",
		});
	});

	test("prepends each pending steering message as its own RPC prompt command", () => {
		const cmd = piRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "fix the bug",
			pendingMessages: [fakeMessage()],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect((cmd.stdin as string).endsWith("\n")).toBe(true);
		const lines = (cmd.stdin as string).split("\n").slice(0, -1);
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0] ?? "") as { message: string };
		const second = JSON.parse(lines[1] ?? "") as { message: string };
		expect(first.message).toBe("fix the bug");
		expect(second.message).toContain("[STEERING]");
		expect(second.message).toContain("priority: high");
		expect(second.message).toContain("stop and write tests first");
	});

	test("does not set custom env or cwd (sandbox owns those)", () => {
		const cmd = piRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd.env).toBeUndefined();
		expect(cmd.cwd).toBeUndefined();
	});
});

describe("piRuntime.buildSpawnCommand frontmatter override (burrow-b5b4)", () => {
	// Warren passes `runs.rendered_agent_json.frontmatter.{provider,model}` —
	// the dispatcher hydrates it onto SpawnContext.frontmatter, and pi
	// substitutes the override for its pinned defaults. Empty / whitespace
	// values fall back to PI_DEFAULT_PROVIDER + PI_DEFAULT_MODEL so a
	// frontmatter envelope that didn't fill a field doesn't accidentally
	// emit `--provider ""`.
	test("substitutes provider + model when both frontmatter fields are set", () => {
		const cmd = piRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
			frontmatter: { provider: "openai", model: "gpt-4o" },
		});
		const providerIdx = cmd.argv.indexOf("--provider");
		expect(providerIdx).toBeGreaterThan(-1);
		expect(cmd.argv[providerIdx + 1]).toBe("openai");
		const modelIdx = cmd.argv.indexOf("--model");
		expect(modelIdx).toBeGreaterThan(-1);
		expect(cmd.argv[modelIdx + 1]).toBe("gpt-4o");
	});

	test("model override alone keeps the default provider slot", () => {
		const cmd = piRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
			frontmatter: { model: "claude-opus-4-7" },
		});
		const providerIdx = cmd.argv.indexOf("--provider");
		expect(cmd.argv[providerIdx + 1]).toBe(PI_DEFAULT_PROVIDER);
		const modelIdx = cmd.argv.indexOf("--model");
		expect(cmd.argv[modelIdx + 1]).toBe("claude-opus-4-7");
	});

	test("provider override alone keeps the default model", () => {
		const cmd = piRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
			frontmatter: { provider: "openai" },
		});
		const providerIdx = cmd.argv.indexOf("--provider");
		expect(cmd.argv[providerIdx + 1]).toBe("openai");
		const modelIdx = cmd.argv.indexOf("--model");
		expect(cmd.argv[modelIdx + 1]).toBe(PI_DEFAULT_MODEL);
	});

	test("empty / whitespace frontmatter values fall back to defaults", () => {
		const cmd = piRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
			frontmatter: { provider: "   ", model: "" },
		});
		// Whole argv collapses to the no-override shape — guard the prefix
		// equality so a future change can't silently emit `--provider ""`.
		expect(cmd.argv.slice(0, PI_FORCED_ARGV.length)).toEqual([...PI_FORCED_ARGV]);
		const modelIdx = cmd.argv.indexOf("--model");
		expect(cmd.argv[modelIdx + 1]).toBe(PI_DEFAULT_MODEL);
	});

	test("undefined frontmatter is a no-op (today's behavior)", () => {
		const cmd = piRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd.argv).toEqual([...PI_FORCED_ARGV, "--model", PI_DEFAULT_MODEL]);
	});

	test("buildResumeCommand honors frontmatter alongside --session", () => {
		const cmd = piRuntime.buildResumeCommand?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: "run_new" }),
			priorRun: fakeRun({
				id: "run_prior",
				state: "succeeded",
				metadataJson: { session_id: "sess-xyz" },
			}),
			prompt: "continue",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
			frontmatter: { provider: "openai", model: "gpt-4o" },
		});
		const providerIdx = cmd?.argv.indexOf("--provider") ?? -1;
		expect(cmd?.argv[providerIdx + 1]).toBe("openai");
		const modelIdx = cmd?.argv.indexOf("--model") ?? -1;
		expect(cmd?.argv[modelIdx + 1]).toBe("gpt-4o");
		const sessionIdx = cmd?.argv.indexOf("--session") ?? -1;
		expect(cmd?.argv[sessionIdx + 1]).toBe("sess-xyz");
	});
});

describe("buildPiArgv", () => {
	test("matches PI_FORCED_ARGV + default model with no frontmatter", () => {
		expect(buildPiArgv()).toEqual([...PI_FORCED_ARGV, "--model", PI_DEFAULT_MODEL]);
	});

	test("trims surrounding whitespace from provider + model overrides", () => {
		const argv = buildPiArgv({ provider: "  openai  ", model: "\tgpt-4o\n" });
		const providerIdx = argv.indexOf("--provider");
		expect(argv[providerIdx + 1]).toBe("openai");
		const modelIdx = argv.indexOf("--model");
		expect(argv[modelIdx + 1]).toBe("gpt-4o");
	});

	test("PI_FORCED_ARGV stays bit-for-bit identical (the constant is the no-override default)", () => {
		// Constant must not be mutated across buildPiArgv calls — guards
		// against an accidental in-place [PI_FORCED_ARGV.length-1] = ...
		// (the helper uses a copy, but pin the invariant explicitly).
		buildPiArgv({ provider: "openai", model: "gpt-4o" });
		expect([...PI_FORCED_ARGV]).toEqual([
			"pi",
			"--mode",
			"rpc",
			"--session-dir",
			PI_SESSION_DIR,
			"--no-extensions",
			"--offline",
			"--provider",
			PI_DEFAULT_PROVIDER,
		]);
	});
});

describe("encodePiStdin", () => {
	test("omits the prompt line when the prompt is empty (steering-only nudge)", () => {
		const blob = encodePiStdin("", [fakeMessage()]);
		expect(blob.endsWith("\n")).toBe(true);
		const lines = blob.split("\n").slice(0, -1);
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0] ?? "") as { type: string; message: string };
		expect(parsed.type).toBe("prompt");
		expect(parsed.message).toContain("[STEERING]");
	});

	test("returns an empty string when both prompt and messages are empty", () => {
		expect(encodePiStdin("", [])).toBe("");
	});

	test("emits one RPC line per pending steering message in order", () => {
		const blob = encodePiStdin("", [
			fakeMessage({ id: "msg_a", body: "first", priority: "urgent" }),
			fakeMessage({ id: "msg_b", body: "second", priority: "low" }),
		]);
		expect(blob.endsWith("\n")).toBe(true);
		const lines = blob.split("\n").slice(0, -1);
		expect(lines).toHaveLength(2);
		const parsed = lines.map((l) => JSON.parse(l) as { type: string; message: string });
		expect(parsed[0]?.type).toBe("prompt");
		expect(parsed[0]?.message).toContain("priority: urgent");
		expect(parsed[0]?.message).toContain("first");
		expect(parsed[1]?.message).toContain("priority: low");
		expect(parsed[1]?.message).toContain("second");
	});

	test("single-prompt case terminates with a newline (burrow-faf5)", () => {
		// pi's RPC mode is line-delimited — without a trailing \n it sits on
		// an incomplete JSON line and never processes the prompt.
		const blob = encodePiStdin("hello", []);
		expect(blob.endsWith("\n")).toBe(true);
		const lines = blob.split("\n").slice(0, -1);
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0] ?? "") as { type: string; message: string };
		expect(parsed.type).toBe("prompt");
		expect(parsed.message).toBe("hello");
	});

	test("prompt + steering messages all terminate with newlines", () => {
		const blob = encodePiStdin("primary", [
			fakeMessage({ id: "msg_a", body: "first", priority: "urgent" }),
		]);
		expect(blob.endsWith("\n")).toBe(true);
		const lines = blob.split("\n").slice(0, -1);
		expect(lines).toHaveLength(2);
	});
});

describe("piRuntime.envPassthrough (burrow-6f3f)", () => {
	// Function-form passthrough — conditional on frontmatter.provider so a
	// run flipped to a non-anthropic provider via warren's multi-provider
	// override path (warren-fe96) gets the matching host key forwarded.
	// At burrow up time the same function is invoked with an empty
	// frontmatter to bake the anthropic base into profile.envPassthrough;
	// the dispatcher re-invokes it with the run's frontmatter and unions
	// the delta onto the per-spawn profile.
	test("base set is the anthropic env trio (default provider, locked)", () => {
		// Frozen base list — the anthropic auth surface stays available
		// regardless of provider override so a follow-up run that flips
		// back to anthropic keeps authenticating.
		expect([...PI_ENV_PASSTHROUGH]).toEqual([
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
		]);
	});

	test("envPassthrough is a function on the runtime", () => {
		expect(typeof piRuntime.envPassthrough).toBe("function");
	});

	test("no frontmatter → base anthropic triple, nothing else", () => {
		expect(piEnvPassthrough({})).toEqual([...PI_ENV_PASSTHROUGH]);
	});

	test("frontmatter.provider unset / empty / whitespace → base only", () => {
		expect(piEnvPassthrough({ frontmatter: {} })).toEqual([...PI_ENV_PASSTHROUGH]);
		expect(piEnvPassthrough({ frontmatter: { provider: "" } })).toEqual([...PI_ENV_PASSTHROUGH]);
		expect(piEnvPassthrough({ frontmatter: { provider: "   " } })).toEqual([...PI_ENV_PASSTHROUGH]);
	});

	test("provider=anthropic (explicit) → base only (no double-include)", () => {
		expect(piEnvPassthrough({ frontmatter: { provider: PI_DEFAULT_PROVIDER } })).toEqual([
			...PI_ENV_PASSTHROUGH,
		]);
	});

	test("provider=openai → base + OPENAI_API_KEY + OPENAI_BASE_URL", () => {
		const names = piEnvPassthrough({ frontmatter: { provider: "openai" } });
		expect(names).toContain("OPENAI_API_KEY");
		// Self-hosted / OpenAI-compatible endpoints need the base URL
		// forwarded too (burrow-cae5).
		expect(names).toContain("OPENAI_BASE_URL");
		// Base still present so a host with both keys set keeps anthropic
		// auth viable across resume / provider flips.
		for (const base of PI_ENV_PASSTHROUGH) expect(names).toContain(base);
		// Single-key delta — other providers' keys MUST NOT leak when the
		// run only selected openai.
		expect(names).not.toContain("GEMINI_API_KEY");
		expect(names).not.toContain("GROQ_API_KEY");
		expect(names).not.toContain("MISTRAL_API_KEY");
		expect(names).not.toContain("DEEPSEEK_API_KEY");
	});

	test("each non-anthropic provider opts in only its matching key", () => {
		const cases: Array<[string, readonly string[]]> = [
			["openai", ["OPENAI_API_KEY", "OPENAI_BASE_URL"]],
			// pi's "google" provider reads GEMINI_API_KEY (per pi-ai
			// env-api-keys.js); there is no "gemini" provider name.
			["google", ["GEMINI_API_KEY"]],
			["groq", ["GROQ_API_KEY"]],
			["mistral", ["MISTRAL_API_KEY"]],
			["deepseek", ["DEEPSEEK_API_KEY"]],
		];
		for (const [provider, keys] of cases) {
			const names = piEnvPassthrough({ frontmatter: { provider } });
			expect(names).toEqual([...PI_ENV_PASSTHROUGH, ...keys]);
		}
	});

	test("provider name is matched case-insensitively (warren normalizes to lowercase)", () => {
		expect(piEnvPassthrough({ frontmatter: { provider: "OPENAI" } })).toEqual([
			...PI_ENV_PASSTHROUGH,
			"OPENAI_API_KEY",
			"OPENAI_BASE_URL",
		]);
		expect(piEnvPassthrough({ frontmatter: { provider: "OpenAI" } })).toEqual([
			...PI_ENV_PASSTHROUGH,
			"OPENAI_API_KEY",
			"OPENAI_BASE_URL",
		]);
	});

	test("unknown provider → base only (project still opts in via burrow.toml [env])", () => {
		expect(piEnvPassthrough({ frontmatter: { provider: "made-up-llm" } })).toEqual([
			...PI_ENV_PASSTHROUGH,
		]);
	});

	test("PI_PROVIDER_ENV_KEYS exposes the canonical key per provider name", () => {
		// Map is the contract surface for warren-fe96's multi-provider
		// passthrough wiring. Frozen against accidental edits. Provider
		// names match pi's --provider vocabulary exactly; each value is the
		// env var pi-ai's env-api-keys.js looks up for that provider.
		expect(PI_PROVIDER_ENV_KEYS).toEqual({
			openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
			google: ["GEMINI_API_KEY"],
			groq: ["GROQ_API_KEY"],
			mistral: ["MISTRAL_API_KEY"],
			deepseek: ["DEEPSEEK_API_KEY"],
		});
	});

	test("provider=gemini → base only (pi has no 'gemini' provider; unknown contributes nothing)", () => {
		expect(piEnvPassthrough({ frontmatter: { provider: "gemini" } })).toEqual([
			...PI_ENV_PASSTHROUGH,
		]);
	});
});

describe("piRuntime.encodeInboxMessage", () => {
	test("emits one prompt RPC envelope per message tagged with priority", () => {
		const out = piRuntime.encodeInboxMessage?.([
			fakeMessage({ id: "msg_a", body: "first", priority: "urgent" }),
			fakeMessage({ id: "msg_b", body: "second", priority: "low" }),
		]);
		expect(out?.stdin.endsWith("\n")).toBe(true);
		const lines = out?.stdin.split("\n").slice(0, -1) ?? [];
		expect(lines).toHaveLength(2);
		const parsed = lines.map((l) => JSON.parse(l) as { type: string; message: string });
		expect(parsed[0]?.type).toBe("prompt");
		expect(parsed[0]?.message).toContain("priority: urgent");
		expect(parsed[1]?.message).toContain("priority: low");
	});
});

describe("piRuntime.buildResumeCommand", () => {
	test("appends --session <session_id> when metadata carries one", () => {
		const cmd = piRuntime.buildResumeCommand?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: "run_new" }),
			priorRun: fakeRun({
				id: "run_prior",
				state: "succeeded",
				metadataJson: { session_id: "019e220e-3e2e-73cd-ac0b-ed36c073dfed" },
			}),
			prompt: "continue",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		// Forced prefix + model + --session token. --session-dir stays in the
		// prefix so resume reads from the same per-burrow storage that the
		// initial spawn wrote into.
		expect(cmd?.argv.slice(0, PI_FORCED_ARGV.length)).toEqual([...PI_FORCED_ARGV]);
		const idx = cmd?.argv.indexOf("--session") ?? -1;
		expect(idx).toBeGreaterThan(-1);
		expect(cmd?.argv[idx + 1]).toBe("019e220e-3e2e-73cd-ac0b-ed36c073dfed");
	});

	test("falls back to a fresh argv when no session_id is present", () => {
		const cmd = piRuntime.buildResumeCommand?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: "run_new" }),
			priorRun: fakeRun({ id: "run_prior", state: "succeeded" }),
			prompt: "continue",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd?.argv).not.toContain("--session");
		// Still pins session-dir so the new run keeps the same storage root.
		expect(cmd?.argv.slice(0, PI_FORCED_ARGV.length)).toEqual([...PI_FORCED_ARGV]);
	});

	test("encodes the prompt + steering on stdin (parity with buildSpawnCommand)", () => {
		const cmd = piRuntime.buildResumeCommand?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: "run_new" }),
			priorRun: fakeRun({
				id: "run_prior",
				state: "succeeded",
				metadataJson: { session_id: "sess-z" },
			}),
			prompt: "continue",
			pendingMessages: [fakeMessage()],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect((cmd?.stdin as string).endsWith("\n")).toBe(true);
		const lines = (cmd?.stdin as string).split("\n").slice(0, -1);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "")).toEqual({ type: "prompt", message: "continue" });
		expect(lines[1]).toContain("[STEERING]");
	});
});

describe("piRuntime.prepareWorkspace", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "burrow-pi-prep-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("creates the .pi/sessions/ directory under the workspace", async () => {
		await piRuntime.prepareWorkspace?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		const fs = await import("node:fs");
		expect(fs.statSync(join(dir, PI_SESSION_DIR)).isDirectory()).toBe(true);
	});

	test("is idempotent when the directory already exists", async () => {
		await piRuntime.prepareWorkspace?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		await piRuntime.prepareWorkspace?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		expect(readdirSync(join(dir, PI_SESSION_DIR))).toEqual([]);
	});
});

describe("piRuntime.extractMetadata", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "burrow-pi-extract-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("reads session_id from the newest session jsonl header", async () => {
		const sessionDir = join(dir, PI_SESSION_DIR);
		await mkdir(sessionDir, { recursive: true });
		// Two sessions — the second one (later mtime) wins.
		await writeFile(
			join(sessionDir, "2026-05-13T15-56-59-311Z_old-session-id.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "old-session-id" })}\n`,
		);
		// Force an older mtime on the first file.
		const fs = await import("node:fs/promises");
		const oldTime = new Date(Date.now() - 60_000);
		await fs.utimes(
			join(sessionDir, "2026-05-13T15-56-59-311Z_old-session-id.jsonl"),
			oldTime,
			oldTime,
		);
		await writeFile(
			join(sessionDir, "2026-05-13T15-58-00-000Z_new-session-id.jsonl"),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "019e220e-3e2e-73cd-ac0b-ed36c073dfed",
			})}\n${JSON.stringify({ type: "model_change" })}\n`,
		);
		const patch = await piRuntime.extractMetadata?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		expect(patch).toEqual({ session_id: "019e220e-3e2e-73cd-ac0b-ed36c073dfed" });
	});

	test("returns undefined when the session directory is missing", async () => {
		const patch = await piRuntime.extractMetadata?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		expect(patch).toBeUndefined();
	});

	test("returns undefined when no jsonl files are present", async () => {
		await mkdir(join(dir, PI_SESSION_DIR), { recursive: true });
		const patch = await piRuntime.extractMetadata?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		expect(patch).toBeUndefined();
	});

	test("returns undefined when the header line is malformed", async () => {
		const sessionDir = join(dir, PI_SESSION_DIR);
		await mkdir(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "broken.jsonl"), "not json\n");
		const patch = await piRuntime.extractMetadata?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		expect(patch).toBeUndefined();
	});

	test("returns undefined when the header is not a session envelope", async () => {
		const sessionDir = join(dir, PI_SESSION_DIR);
		await mkdir(sessionDir, { recursive: true });
		// First line is e.g. a model_change — not a session header.
		writeFileSync(
			join(sessionDir, "wrong-shape.jsonl"),
			`${JSON.stringify({ type: "model_change", modelId: "x" })}\n`,
		);
		const patch = await piRuntime.extractMetadata?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		expect(patch).toBeUndefined();
	});
});

describe("readNewestPiSessionId", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "burrow-pi-newest-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("returns undefined for a missing directory", () => {
		expect(readNewestPiSessionId(join(dir, "does-not-exist"))).toBeUndefined();
	});

	test("ignores non-jsonl files in the same directory", () => {
		writeFileSync(join(dir, "notes.txt"), "ignore");
		writeFileSync(
			join(dir, "session.jsonl"),
			`${JSON.stringify({ type: "session", id: "abc" })}\n`,
		);
		expect(readNewestPiSessionId(dir)).toBe("abc");
	});
});

describe("piRuntime.parseEvents", () => {
	test("delegates to parsePiEvents — RPC ack becomes state_change/system", () => {
		const events = piRuntime.parseEvents(
			JSON.stringify({ type: "response", command: "prompt", success: true }),
			{ burrow: fakeBurrow(), run: fakeRun() },
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
	});
});

describe("piRuntime.encodeSteeringMessage (burrow-250d)", () => {
	// Mid-run steering encoder: one pi RPC prompt envelope per message,
	// tagged with the standard [STEERING] prefix and a trailing newline
	// so the line is framed for pi's NDJSON read loop. The dispatcher's
	// mid-run poll loop (SPEC §13.5) writes this verbatim to the still-
	// open child stdin via SpawnResult.writeStdin.
	test("emits exactly one prompt RPC envelope terminated by \\n", () => {
		const out = piRuntime.encodeSteeringMessage?.(
			fakeMessage({ id: "msg_mid", body: "stop and write tests", priority: "high" }),
		);
		expect(out?.stdin.endsWith("\n")).toBe(true);
		const lines = out?.stdin.trimEnd().split("\n") ?? [];
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0] ?? "") as { type: string; message: string };
		expect(parsed.type).toBe("prompt");
		expect(parsed.message).toContain("[STEERING]");
		expect(parsed.message).toContain("priority: high");
		expect(parsed.message).toContain("stop and write tests");
	});

	test("priority prefix matches the at-spawn encoder (parity with encodeInboxMessage)", () => {
		const msg = fakeMessage({ id: "msg_p", body: "urgent thing", priority: "urgent" });
		const midRun = piRuntime.encodeSteeringMessage?.(msg)?.stdin;
		const atSpawn = piRuntime.encodeInboxMessage?.([msg])?.stdin;
		// Same wire shape regardless of whether the message landed in
		// pendingMessages (atSpawn) or arrived mid-run (midRun) — both
		// terminate the JSON envelope with \n so pi's line-delimited RPC
		// loop processes it (burrow-faf5).
		expect(midRun).toBe(atSpawn);
	});
});

describe("piRuntime.shouldCloseStdinOnEvent (burrow-5db3)", () => {
	// pi v0.74.0 exits the instant stdin closes (mx-d9b3ad), so the
	// dispatcher must withhold stdin EOF until pi's terminal lifecycle
	// envelope arrives. The predicate below is what the dispatcher polls
	// per persisted event.
	test("returns true for agent_end state_change envelopes", () => {
		const ev = piRuntime.parseEvents(JSON.stringify({ type: "agent_end" }), {
			burrow: fakeBurrow(),
			run: fakeRun(),
		})[0];
		if (!ev) throw new Error("expected one event from agent_end envelope");
		expect(piRuntime.shouldCloseStdinOnEvent?.(ev)).toBe(true);
	});

	test("returns false for non-terminal lifecycle envelopes", () => {
		const samples = [
			JSON.stringify({ type: "response", command: "prompt", success: true }),
			JSON.stringify({ type: "agent_start" }),
			JSON.stringify({ type: "turn_start" }),
			JSON.stringify({ type: "turn_end" }),
			JSON.stringify({ type: "tool_execution_start" }),
			JSON.stringify({ type: "tool_execution_end" }),
		];
		for (const line of samples) {
			const ev = piRuntime.parseEvents(line, { burrow: fakeBurrow(), run: fakeRun() })[0];
			if (!ev) throw new Error(`expected one event from ${line}`);
			expect(piRuntime.shouldCloseStdinOnEvent?.(ev)).toBe(false);
		}
	});

	test("returns false for assistant content events (text / thinking / tool_use)", () => {
		// agent_end mapping is intentionally narrow — closing stdin on an
		// intermediate message_end would truncate pi mid-turn.
		const ev: RuntimeEvent = { kind: "text", stream: "stdout", payload: { text: "ack" } };
		expect(piRuntime.shouldCloseStdinOnEvent?.(ev)).toBe(false);
	});
});
