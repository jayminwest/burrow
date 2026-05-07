import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BurrowRow, MessageRow, RunRow } from "../db/schema.ts";
import { CLAUDE_CODE_SETTINGS_PATH, claudeCodeRuntime, encodeClaudeStdin } from "./claude-code.ts";

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
});
