import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { Client } from "./client.ts";

function mkTmp(): string {
	return mkdtempSync(join(tmpdir(), "burrow-client-"));
}

describe("Client", () => {
	let dataDir: string;
	let configDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkTmp();
		configDir = mkTmp();
		client = await Client.open({ dataDir, configDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(configDir, { recursive: true, force: true });
	});

	test("open + close wires all five namespaces", () => {
		expect(client.burrows).toBeDefined();
		expect(client.runs).toBeDefined();
		expect(client.inbox).toBeDefined();
		expect(client.events).toBeDefined();
		expect(client.agents).toBeDefined();
	});

	test("agents namespace boots with the built-ins", () => {
		const ids = client.agents.list().map((rt) => rt.id);
		expect(ids).toContain("claude-code");
		expect(ids).toContain("sapling");
		expect(ids).toContain("codex");
	});

	test("burrows.list filters by kind / state", () => {
		const project = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const task = client.repos.burrows.create({
			kind: "task",
			parentId: project.id,
			projectRoot: "/r",
			workspacePath: "/r/.task",
			branch: "task/x",
			provider: "local",
			profile: {},
		});
		client.repos.burrows.markStopped(task.id);

		expect(
			client.burrows
				.list()
				.map((b) => b.id)
				.sort(),
		).toEqual([project.id, task.id].sort());
		expect(client.burrows.list({ state: "active" }).map((b) => b.id)).toEqual([project.id]);
		expect(client.burrows.list({ kind: "task" }).map((b) => b.id)).toEqual([task.id]);
		expect(client.burrows.list({ projectRoot: "/elsewhere" })).toEqual([]);
	});

	test("burrows.get throws NotFoundError for unknown ids", () => {
		expect(() => client.burrows.get("bur_nope")).toThrow(NotFoundError);
		expect(client.burrows.tryGet("bur_nope")).toBeNull();
	});

	test("runs.create round-trips through runs.get", () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "hello",
		});
		expect(run.state).toBe("queued");
		expect(client.runs.get(run.id).id).toBe(run.id);
	});

	test("runs.cancel finalizes a queued run", () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "hi",
		});
		const finalized = client.runs.cancel(run.id);
		expect(finalized.state).toBe("cancelled");
	});

	test("runs.cancel records the optional reason and emits one event", () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "hi",
		});
		const finalized = client.runs.cancel(run.id, { reason: "operator-aborted" });
		expect(finalized.state).toBe("cancelled");
		expect(finalized.errorMessage).toBe("operator-aborted");
		const events = client.repos.events
			.listByBurrow(burrow.id)
			.filter((e) => e.kind === "run_cancelled");
		expect(events).toHaveLength(1);
		expect(events[0]?.payloadJson).toEqual({ reason: "operator-aborted" });
	});

	test("runs.cancel is idempotent on terminal runs", () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "hi",
		});
		client.runs.cancel(run.id, { reason: "first" });
		// Already-terminal: returns the same row, doesn't re-emit.
		const second = client.runs.cancel(run.id, { reason: "second-ignored" });
		expect(second.state).toBe("cancelled");
		expect(second.errorMessage).toBe("first");
		const events = client.repos.events
			.listByBurrow(burrow.id)
			.filter((e) => e.kind === "run_cancelled");
		expect(events).toHaveLength(1);
	});

	test("runs.delete removes a terminal run row", () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "hi",
		});
		client.runs.cancel(run.id);
		client.runs.delete(run.id);
		expect(client.runs.tryGet(run.id)).toBeNull();
	});

	test("runs.delete refuses non-terminal runs", () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "hi",
		});
		expect(() => client.runs.delete(run.id)).toThrow(ValidationError);
		expect(client.runs.tryGet(run.id)?.id).toBe(run.id);
	});

	test("runs.delete throws NotFoundError for unknown ids", () => {
		expect(() => client.runs.delete("run_nope")).toThrow(NotFoundError);
	});

	test("inbox.send rejects empty body", () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		expect(() => client.inbox.send({ burrowId: burrow.id, body: "" })).toThrow(ValidationError);
	});

	test("inbox.send + list + cancel", () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const m = client.inbox.send({ burrowId: burrow.id, body: "do it" });
		expect(m.state).toBe("unread");
		expect(client.inbox.count(burrow.id)).toBe(1);
		client.inbox.cancel(m.id);
		expect(client.inbox.count(burrow.id)).toBe(0);
	});

	test("burrows.destroy archives by default", async () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const result = await client.burrows.destroy(burrow.id);
		expect(result.archived).not.toBeNull();
		expect(client.burrows.get(burrow.id).state).toBe("destroyed");
	});

	test("events.subscribe receives publishes from the in-process bus", async () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});

		const received: string[] = [];
		const sub = client.events.subscribe(burrow.id, (e) => {
			received.push(e.kind);
		});

		client.events.rawBus.publish({
			id: 1,
			burrowId: burrow.id,
			runId: null,
			seq: 1,
			kind: "test_event",
			stream: "system",
			payload: null,
			ts: new Date(),
		});

		sub.unsubscribe();
		expect(received).toEqual(["test_event"]);
	});

	test("events.replay yields persisted rows", async () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		client.repos.events.append({
			burrowId: burrow.id,
			kind: "tool_use",
			stream: "stdout",
			payload: { tool: "bash" },
		});
		const seen: string[] = [];
		for await (const e of client.events.replay(burrow.id)) {
			seen.push(e.kind);
		}
		expect(seen).toEqual(["tool_use"]);
	});
});
