import { describe, expect, test } from "bun:test";
import type { BurrowRow, MessageRow, RunRow } from "../db/schema.ts";
import { composeSaplingPrompt, saplingRuntime } from "./sapling.ts";

function fakeBurrow(): BurrowRow {
	return {
		id: "bur_x",
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
		id: "run_x",
		burrowId: "bur_x",
		agentId: "sapling",
		prompt: "p",
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
		burrowId: "bur_x",
		fromActor: "user",
		body: "be quick",
		priority: "normal",
		state: "unread",
		deliveredAtRunId: null,
		createdAt: new Date(0),
		deliveredAt: null,
		...extra,
	};
}

describe("saplingRuntime.buildSpawnCommand", () => {
	test("argv includes --json + the composed prompt", () => {
		const cmd = saplingRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "ship the feature",
			pendingMessages: [fakeMessage({ body: "add tests", priority: "high" })],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd.argv[0]).toBe("sapling");
		expect(cmd.argv).toContain("--json");
		const promptIdx = cmd.argv.indexOf("--prompt");
		const composed = cmd.argv[promptIdx + 1] ?? "";
		expect(composed).toContain("[STEERING]");
		expect(composed).toContain("priority: high");
		expect(composed).toContain("ship the feature");
	});
});

describe("saplingRuntime.buildResumeCommand", () => {
	test("includes --resume <prior_run_id>", () => {
		const cmd = saplingRuntime.buildResumeCommand?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: "run_new" }),
			priorRun: fakeRun({ id: "run_prev", state: "succeeded" }),
			prompt: "continue",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		const idx = cmd?.argv.indexOf("--resume") ?? -1;
		expect(idx).toBeGreaterThan(-1);
		expect(cmd?.argv[idx + 1]).toBe("run_prev");
	});
});

describe("composeSaplingPrompt", () => {
	test("returns the bare prompt when there are no pending messages", () => {
		expect(composeSaplingPrompt("just do it", [])).toBe("just do it");
	});

	test("returns only the steering block when prompt is empty", () => {
		const out = composeSaplingPrompt("", [fakeMessage({ body: "hi", priority: "low" })]);
		expect(out).toContain("[STEERING]");
		expect(out).toContain("hi");
		expect(out.endsWith("\n")).toBe(false);
	});
});
