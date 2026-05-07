import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BurrowRow, MessageRow, RunRow } from "../db/schema.ts";
import {
	CLAUDE_CODE_BURROW_TMPDIR,
	CLAUDE_CODE_SETTINGS_PATH,
	claudeCodeBurrowTmpdir,
	claudeCodeHostCredentialPaths,
	claudeCodeRuntime,
	encodeClaudeStdin,
	forwardClaudeHostCredentials,
} from "./claude-code.ts";

function fakeBurrow(): BurrowRow {
	return {
		id: "bur_test",
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
		id: "run_test",
		burrowId: "bur_test",
		agentId: "claude-code",
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
		burrowId: "bur_test",
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

describe("claudeCodeRuntime.buildSpawnCommand", () => {
	test("renders stream-json argv with the prompt + steering on stdin", () => {
		const cmd = claudeCodeRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "fix the bug",
			pendingMessages: [fakeMessage()],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd.argv).toEqual([
			"claude",
			"--print",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--dangerously-skip-permissions",
		]);
		expect(typeof cmd.stdin).toBe("string");
		const lines = (cmd.stdin as string).split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({
			type: "user",
			message: { role: "user", content: [{ type: "text", text: "fix the bug" }] },
		});
		expect(lines[1]).toContain("[STEERING]");
		expect(lines[1]).toContain("priority: high");
	});

	test("encodeClaudeStdin omits the prompt line when prompt is empty", () => {
		const blob = encodeClaudeStdin("", [fakeMessage()]);
		expect(blob.split("\n")).toHaveLength(1);
		expect(blob).toContain("[STEERING]");
	});

	test("emits per-burrow TMPDIR pointing at .burrow-tmp under the in-sandbox workspace (burrow-8452)", () => {
		const cmd = claudeCodeRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/host/ws",
		});
		expect(cmd.env?.TMPDIR).toBe(claudeCodeBurrowTmpdir("/host/ws"));
	});
});

describe("claudeCodeBurrowTmpdir", () => {
	test("linux resolves under bwrap's /workspace remap, not the host path", () => {
		expect(claudeCodeBurrowTmpdir("/host/ws", "linux")).toBe(
			`/workspace/${CLAUDE_CODE_BURROW_TMPDIR}`,
		);
	});

	test("darwin keeps the host workspace path (sandbox-exec doesn't remap)", () => {
		expect(claudeCodeBurrowTmpdir("/Users/u/ws", "darwin")).toBe(
			`/Users/u/ws/${CLAUDE_CODE_BURROW_TMPDIR}`,
		);
	});
});

describe("claudeCodeRuntime.buildResumeCommand", () => {
	test("appends --resume <session_id> when metadata carries one", () => {
		const cmd = claudeCodeRuntime.buildResumeCommand?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: "run_new" }),
			priorRun: fakeRun({
				id: "run_prior",
				state: "succeeded",
				metadataJson: { session_id: "sess-123" },
			}),
			prompt: "continue",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd?.argv).toContain("--resume");
		expect(cmd?.argv.at(-1)).toBe("sess-123");
	});

	test("falls back to a fresh argv when no session_id is present", () => {
		const cmd = claudeCodeRuntime.buildResumeCommand?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: "run_new" }),
			priorRun: fakeRun({ id: "run_prior", state: "succeeded" }),
			prompt: "",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd?.argv).not.toContain("--resume");
	});

	test("resume spawns inherit the per-burrow TMPDIR (burrow-8452)", () => {
		const cmd = claudeCodeRuntime.buildResumeCommand?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: "run_new" }),
			priorRun: fakeRun({
				id: "run_prior",
				state: "succeeded",
				metadataJson: { session_id: "sess-z" },
			}),
			prompt: "continue",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/host/ws",
		});
		expect(cmd?.env?.TMPDIR).toBe(claudeCodeBurrowTmpdir("/host/ws"));
	});
});

describe("claudeCodeRuntime.encodeInboxMessage", () => {
	test("emits one user-text envelope per message tagged with priority", () => {
		const out = claudeCodeRuntime.encodeInboxMessage?.([
			fakeMessage({ id: "msg_a", body: "first", priority: "urgent" }),
			fakeMessage({ id: "msg_b", body: "second", priority: "low" }),
		]);
		const lines = out?.stdin.split("\n") ?? [];
		expect(lines).toHaveLength(2);
		const parsed = lines.map((l) => JSON.parse(l));
		expect(parsed[0]?.message.content[0].text).toContain("priority: urgent");
		expect(parsed[1]?.message.content[0].text).toContain("priority: low");
	});
});

describe("claudeCodeRuntime.prepareWorkspace", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "burrow-claude-prep-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("writes a default .claude/settings.local.json", async () => {
		await claudeCodeRuntime.prepareWorkspace?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		const body = await readFile(join(dir, CLAUDE_CODE_SETTINGS_PATH), "utf8");
		const parsed = JSON.parse(body);
		expect(parsed).toMatchObject({ permissions: {}, hooks: {} });
	});

	test("plants .burrow-tmp/ + a `*` .gitignore (burrow-8452)", async () => {
		await claudeCodeRuntime.prepareWorkspace?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		const fs = await import("node:fs");
		const tmpDir = join(dir, CLAUDE_CODE_BURROW_TMPDIR);
		expect(fs.statSync(tmpDir).isDirectory()).toBe(true);
		expect(await readFile(join(tmpDir, ".gitignore"), "utf8")).toBe("*\n");
	});
});

describe("forwardClaudeHostCredentials (linux)", () => {
	let workspaceDir: string;
	let fakeHome: string;
	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "burrow-claude-prep-"));
		fakeHome = await mkdtemp(join(tmpdir(), "burrow-claude-home-"));
	});
	afterEach(async () => {
		await rm(workspaceDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	test("copies host ~/.claude/.credentials.json into the burrow's .claude/ when present", async () => {
		const fs = await import("node:fs/promises");
		await fs.mkdir(join(fakeHome, ".claude"), { recursive: true });
		await writeFile(join(fakeHome, ".claude", ".credentials.json"), '{"token":"fake"}');

		await forwardClaudeHostCredentials(workspaceDir, { home: fakeHome, plat: "linux" });

		const forwarded = await readFile(join(workspaceDir, ".claude", ".credentials.json"), "utf8");
		expect(JSON.parse(forwarded)).toEqual({ token: "fake" });
	});

	test("is a no-op when the host has no ~/.claude/.credentials.json", async () => {
		await forwardClaudeHostCredentials(workspaceDir, { home: fakeHome, plat: "linux" });
		const fs = await import("node:fs");
		expect(fs.existsSync(join(workspaceDir, ".claude", ".credentials.json"))).toBe(false);
	});
});

describe("forwardClaudeHostCredentials (darwin)", () => {
	let workspaceDir: string;
	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "burrow-claude-prep-"));
	});
	afterEach(async () => {
		await rm(workspaceDir, { recursive: true, force: true });
	});

	test("extracts the Keychain blob and writes it as .credentials.json", async () => {
		const blob = '{"claudeAiOauth":{"accessToken":"oat-x","refreshToken":"rt-y"}}';
		await forwardClaudeHostCredentials(workspaceDir, {
			plat: "darwin",
			keychainReader: async (service) => {
				expect(service).toBe("Claude Code-credentials");
				return blob;
			},
		});
		const written = await readFile(join(workspaceDir, ".claude", ".credentials.json"), "utf8");
		expect(written).toBe(blob);
	});

	test("is a no-op when Keychain has no entry", async () => {
		await forwardClaudeHostCredentials(workspaceDir, {
			plat: "darwin",
			keychainReader: async () => null,
		});
		const fs = await import("node:fs");
		expect(fs.existsSync(join(workspaceDir, ".claude", ".credentials.json"))).toBe(false);
	});
});

describe("claudeCodeHostCredentialPaths", () => {
	let fakeHome: string;
	beforeEach(async () => {
		fakeHome = await mkdtemp(join(tmpdir(), "burrow-claude-creds-"));
	});
	afterEach(async () => {
		await rm(fakeHome, { recursive: true, force: true });
	});

	test("returns nothing when neither ~/.claude nor ~/.claude.json exists", () => {
		expect(claudeCodeHostCredentialPaths(fakeHome)).toEqual([]);
	});

	test("returns existing host paths from ~/.claude and ~/.claude.json", async () => {
		const fs = await import("node:fs/promises");
		await fs.mkdir(join(fakeHome, ".claude"), { recursive: true });
		await writeFile(join(fakeHome, ".claude.json"), "{}");
		expect(claudeCodeHostCredentialPaths(fakeHome)).toEqual([
			join(fakeHome, ".claude"),
			join(fakeHome, ".claude.json"),
		]);
	});

	test("filters out paths the host doesn't have", async () => {
		const fs = await import("node:fs/promises");
		await fs.mkdir(join(fakeHome, ".claude"), { recursive: true });
		expect(claudeCodeHostCredentialPaths(fakeHome)).toEqual([join(fakeHome, ".claude")]);
	});
});
