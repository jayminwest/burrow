import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../core/errors.ts";
import type { BurrowRow, MessageRow, RunRow } from "../db/schema.ts";
import { agentConfigToRuntime, loadAgentConfig } from "./declarative.ts";

function fakeBurrow(): BurrowRow {
	return {
		id: "bur_d",
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
		id: "run_d",
		burrowId: "bur_d",
		agentId: "x",
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
		id: "msg_d",
		burrowId: "bur_d",
		fromActor: "user",
		body: "steer",
		priority: "high",
		state: "unread",
		deliveredAtRunId: null,
		createdAt: new Date(0),
		deliveredAt: null,
		...extra,
	};
}

describe("loadAgentConfig", () => {
	test("rejects malformed configs with ValidationError listing the failing path", () => {
		expect(() => loadAgentConfig({ id: "", outputFormat: "raw-text" })).toThrow(ValidationError);
	});

	test("accepts a minimal config and returns a runtime with the declared id", () => {
		const rt = loadAgentConfig({
			id: "gemini",
			displayName: "Gemini CLI",
			command: "gemini",
			args: ["chat", "{{prompt}}"],
			promptDelivery: "arg",
			outputFormat: "raw-text",
		});
		expect(rt.id).toBe("gemini");
		expect(rt.displayName).toBe("Gemini CLI");
		expect(rt.supportsResume).toBe(false);
	});
});

describe("agentConfigToRuntime — token substitution + prompt delivery", () => {
	test("substitutes {{prompt}} / {{workspace}} / {{run_id}} / {{burrow_id}}", () => {
		const rt = agentConfigToRuntime({
			id: "x",
			displayName: "X",
			command: "x-cli",
			args: [
				"--p",
				"{{prompt}}",
				"--ws",
				"{{workspace}}",
				"--rid",
				"{{run_id}}",
				"--bid",
				"{{burrow_id}}",
			],
			promptDelivery: "arg",
			outputFormat: "raw-text",
			supportsResume: false,
			inboxDelivery: "none",
		});
		const cmd = rt.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "hello",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd.argv).toEqual([
			"x-cli",
			"--p",
			"hello",
			"--ws",
			"/ws",
			"--rid",
			"run_d",
			"--bid",
			"bur_d",
		]);
		expect(cmd.stdin).toBeUndefined();
	});

	test("promptDelivery=stdin populates command.stdin with steering-prefixed body", () => {
		const rt = agentConfigToRuntime({
			id: "x",
			displayName: "X",
			command: "x-cli",
			args: [],
			promptDelivery: "stdin",
			outputFormat: "stream-json",
			supportsResume: false,
			inboxDelivery: "stdin-ndjson",
		});
		const cmd = rt.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "ship",
			pendingMessages: [fakeMessage()],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(typeof cmd.stdin).toBe("string");
		expect(cmd.stdin as string).toContain("[STEERING]");
		expect(cmd.stdin as string).toContain("ship");
	});

	test("inboxDelivery=stdin-ndjson encodes one JSON envelope per message", () => {
		const rt = agentConfigToRuntime({
			id: "x",
			displayName: "X",
			command: "x-cli",
			args: [],
			promptDelivery: "arg",
			outputFormat: "stream-json",
			supportsResume: false,
			inboxDelivery: "stdin-ndjson",
		});
		const out = rt.encodeInboxMessage?.([
			fakeMessage({ id: "m1", body: "a", priority: "high" }),
			fakeMessage({ id: "m2", body: "b", priority: "low" }),
		]);
		const lines = (out?.stdin ?? "").split("\n");
		expect(lines).toHaveLength(2);
		const parsed = lines.map((l) => JSON.parse(l));
		expect(parsed[0]).toMatchObject({ type: "steering", id: "m1", priority: "high", body: "a" });
		expect(parsed[1]).toMatchObject({ type: "steering", id: "m2", priority: "low", body: "b" });
	});
});

describe("agentConfigToRuntime — buildResumeCommand", () => {
	test("uses resumeArgs when provided, falls back to args otherwise", () => {
		const rt = agentConfigToRuntime({
			id: "x",
			displayName: "X",
			command: "x-cli",
			args: ["fresh", "{{prompt}}"],
			resumeArgs: ["resume", "{{run_id}}"],
			promptDelivery: "arg",
			outputFormat: "raw-text",
			supportsResume: true,
			inboxDelivery: "none",
		});
		const cmd = rt.buildResumeCommand?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			priorRun: { ...fakeRun(), id: "run_prev", state: "succeeded" },
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd?.argv).toEqual(["x-cli", "resume", "run_d"]);
	});
});

describe("agentConfigToRuntime — prepareWorkspace hook", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "burrow-decl-prep-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("inline JSON in hooks.settingsLocalJson lands in .claude/settings.local.json", async () => {
		const rt = agentConfigToRuntime({
			id: "x",
			displayName: "X",
			command: "x",
			args: [],
			promptDelivery: "arg",
			outputFormat: "raw-text",
			supportsResume: false,
			inboxDelivery: "none",
			hooks: { settingsLocalJson: '{"permissions":{"allow":["Bash"]}}' },
		});
		await rt.prepareWorkspace?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		const body = await readFile(join(dir, ".claude/settings.local.json"), "utf8");
		expect(JSON.parse(body)).toEqual({ permissions: { allow: ["Bash"] } });
	});
});

describe("agentConfigToRuntime — installCheck", () => {
	test("with no installCheck declared, reports installed", async () => {
		const rt = agentConfigToRuntime({
			id: "x",
			displayName: "X",
			command: "x",
			args: [],
			promptDelivery: "arg",
			outputFormat: "raw-text",
			supportsResume: false,
			inboxDelivery: "none",
		});
		await expect(rt.installCheck()).resolves.toEqual({ installed: true });
	});

	test("a probe that exits as expected reports installed and captures stdout as version", async () => {
		const rt = agentConfigToRuntime({
			id: "x",
			displayName: "X",
			command: "x",
			args: [],
			promptDelivery: "arg",
			outputFormat: "raw-text",
			supportsResume: false,
			inboxDelivery: "none",
			installCheck: { command: "sh", args: ["-c", "echo v1.2.3"], exitCode: 0 },
		});
		const out = await rt.installCheck();
		expect(out.installed).toBe(true);
		expect(out.version).toBe("v1.2.3");
	});

	test("a probe that fails reports not installed with a hint", async () => {
		const rt = agentConfigToRuntime({
			id: "x",
			displayName: "X",
			command: "x",
			args: [],
			promptDelivery: "arg",
			outputFormat: "raw-text",
			supportsResume: false,
			inboxDelivery: "none",
			installCheck: { command: "sh", args: ["-c", "exit 7"], exitCode: 0 },
		});
		const out = await rt.installCheck();
		expect(out.installed).toBe(false);
		expect(out.hint).toContain("exited 7");
	});
});
