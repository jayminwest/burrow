import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BurrowRow, MessageRow, RunRow } from "../db/schema.ts";
import {
	CODEX_PROMPT_DIR,
	codexPromptFileFor,
	codexRuntime,
	composeCodexPrompt,
	writeCodexPromptFile,
} from "./codex.ts";

function fakeBurrow(): BurrowRow {
	return {
		id: "bur_y",
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

function fakeRun(): RunRow {
	return {
		id: "run_codex",
		burrowId: "bur_y",
		agentId: "codex",
		prompt: "p",
		resumeOfRunId: null,
		state: "queued",
		exitCode: null,
		errorMessage: null,
		metadataJson: null,
		queuedAt: new Date(0),
		startedAt: null,
		completedAt: null,
	};
}

function fakeMessage(extra: Partial<MessageRow> = {}): MessageRow {
	return {
		id: "msg_1",
		burrowId: "bur_y",
		fromActor: "user",
		body: "stop",
		priority: "normal",
		state: "unread",
		deliveredAtRunId: null,
		createdAt: new Date(0),
		deliveredAt: null,
		...extra,
	};
}

describe("codexRuntime", () => {
	test("flagged as one-shot — supportsResume is false and encodeInboxMessage is unset", () => {
		expect(codexRuntime.supportsResume).toBe(false);
		expect(codexRuntime.encodeInboxMessage).toBeUndefined();
	});

	test("buildSpawnCommand renders codex exec --prompt-file <path>", () => {
		const cmd = codexRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "do thing",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd.argv).toEqual(["codex", "exec", "--prompt-file", codexPromptFileFor("run_codex")]);
	});
});

describe("composeCodexPrompt", () => {
	test("prefixes pending steering messages onto the prompt body", () => {
		const out = composeCodexPrompt("ship", [
			fakeMessage({ body: "add tests", priority: "urgent" }),
		]);
		expect(out.startsWith("[STEERING]")).toBe(true);
		expect(out).toContain("ship");
		expect(out).toContain("priority: urgent");
	});

	test("with no messages, returns prompt verbatim", () => {
		expect(composeCodexPrompt("noop", [])).toBe("noop");
	});
});

describe("writeCodexPromptFile / prepareWorkspace", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "burrow-codex-prep-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("prepareWorkspace ensures the prompt dir exists", async () => {
		await codexRuntime.prepareWorkspace?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		const f = await writeCodexPromptFile(dir, "run_codex", "hello");
		const body = await readFile(f, "utf8");
		expect(body).toBe("hello");
		expect(f.endsWith(`${CODEX_PROMPT_DIR}/run_codex.txt`)).toBe(true);
	});
});
