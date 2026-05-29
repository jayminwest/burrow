import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { ValidationError } from "../../core/errors.ts";
import { type BurrowDb, openDatabase } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { BurrowRow } from "../../db/schema.ts";
import { AgentRegistry } from "../../runtime/registry.ts";
import {
	parsePriority,
	readStdinBody,
	renderSendJson,
	renderSendResult,
	resolveSendBody,
	runSendCommand,
} from "./send.ts";

function seedBurrow(repos: Repos): BurrowRow {
	return repos.burrows.create({
		kind: "project",
		projectRoot: "/r",
		workspacePath: "/r/ws",
		branch: "main",
		provider: "local",
		profile: {},
	});
}

describe("parsePriority", () => {
	test("defaults to normal", () => {
		expect(parsePriority(undefined)).toBe("normal");
	});

	test("accepts known priorities", () => {
		expect(parsePriority("urgent")).toBe("urgent");
		expect(parsePriority("low")).toBe("low");
	});

	test("rejects unknown priorities with a hint listing valid values", () => {
		expect(() => parsePriority("medium")).toThrow(ValidationError);
		expect(() => parsePriority("medium")).toThrow(/low, normal, high, urgent/);
	});
});

describe("resolveSendBody", () => {
	test("returns the literal body when provided", async () => {
		expect(await resolveSendBody("hi", Readable.from([]))).toBe("hi");
	});

	test("reads stdin when body is the '-' sentinel", async () => {
		const body = await resolveSendBody("-", Readable.from(["queue\n", "this\n"]));
		expect(body).toBe("queue\nthis");
	});

	test("rejects an empty stdin payload", async () => {
		await expect(resolveSendBody("-", Readable.from([]))).rejects.toThrow(ValidationError);
	});

	test("requires a body", async () => {
		await expect(resolveSendBody(undefined, Readable.from([]))).rejects.toThrow(ValidationError);
	});
});

describe("readStdinBody", () => {
	test("strips a trailing newline so commit-message-style input doesn't carry whitespace", async () => {
		const body = await readStdinBody(Readable.from(["already trimmed\n"]));
		expect(body).toBe("already trimmed");
	});
});

describe("runSendCommand", () => {
	let db: BurrowDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => db.close());

	test("queues the message and returns deferred=false when no run has been started yet", () => {
		const burrow = seedBurrow(repos);
		const result = runSendCommand({
			db,
			burrowId: burrow.id,
			body: "stop and write tests",
			options: { priority: "high" },
		});
		expect(result.message.priority).toBe("high");
		expect(result.message.fromActor).toBe("user");
		expect(result.deferred).toBe(false);
		expect(result.lastAgentId).toBeNull();
	});

	test("flags deferred=true when the burrow's most recent run targeted a one-shot runtime", () => {
		const burrow = seedBurrow(repos);
		repos.runs.enqueue({ burrowId: burrow.id, agentId: "codex", prompt: "p" });
		const result = runSendCommand({
			db,
			burrowId: burrow.id,
			body: "remember to lint",
			options: {},
		});
		expect(result.deferred).toBe(true);
		expect(result.lastAgentId).toBe("codex");
	});

	test("registry override lets callers register a one-shot custom agent", () => {
		const burrow = seedBurrow(repos);
		const registry = new AgentRegistry();
		registry.register({
			id: "fire-and-forget",
			displayName: "Fire and forget",
			supportsResume: false,
			buildSpawnCommand: () => ({ argv: ["x"] }),
			parseEvents: () => [],
			installCheck: async () => ({ installed: true }),
		});
		repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "fire-and-forget",
			prompt: "p",
		});
		const result = runSendCommand({
			db,
			registry,
			burrowId: burrow.id,
			body: "go",
			options: {},
		});
		expect(result.deferred).toBe(true);
	});

	test("propagates ValidationError when the burrow is not active", () => {
		const burrow = seedBurrow(repos);
		repos.burrows.markStopped(burrow.id);
		expect(() => runSendCommand({ db, burrowId: burrow.id, body: "hi", options: {} })).toThrow(
			ValidationError,
		);
	});
});

describe("renderSendJson", () => {
	const result = {
		message: {
			id: "msg_abc",
			burrowId: "bur_x",
			fromActor: "user",
			body: "hi",
			priority: "urgent" as const,
			state: "unread" as const,
			deliveredAtRunId: null,
			createdAt: new Date(0),
			deliveredAt: null,
		},
		deferred: false,
		lastAgentId: null,
	};

	test("emits 2-space-indented JSON terminated with a single newline (burrow-2444)", () => {
		const out = renderSendJson(result);
		expect(out.endsWith("\n")).toBe(true);
		expect(out).toContain('\n  "message": {');
		expect(out).toContain('\n    "id": "msg_abc"');
		expect(out).toContain('\n  "deferred": false');
		expect(out).toContain('\n  "lastAgentId": null');
		// One trailing newline, not two.
		expect(out.endsWith("\n\n")).toBe(false);
		// Parses back round-trip.
		const parsed = JSON.parse(out);
		expect(parsed.message.id).toBe("msg_abc");
		expect(parsed.deferred).toBe(false);
		expect(parsed.lastAgentId).toBeNull();
	});
});

describe("renderSendResult", () => {
	test("prints a confirmation line with the message id and priority", () => {
		const out = renderSendResult({
			message: {
				id: "msg_abc",
				burrowId: "bur_x",
				fromActor: "user",
				body: "hi",
				priority: "urgent",
				state: "unread",
				deliveredAtRunId: null,
				createdAt: new Date(0),
				deliveredAt: null,
			},
			deferred: false,
			lastAgentId: null,
		});
		expect(out).toContain("✓ message queued (msg_abc, priority: urgent)");
		expect(out).not.toContain("one-shot");
	});

	test("appends a one-shot warning when the runtime defers delivery", () => {
		const out = renderSendResult({
			message: {
				id: "msg_def",
				burrowId: "bur_x",
				fromActor: "user",
				body: "hi",
				priority: "normal",
				state: "unread",
				deliveredAtRunId: null,
				createdAt: new Date(0),
				deliveredAt: null,
			},
			deferred: true,
			lastAgentId: "codex",
		});
		expect(out).toContain("codex is one-shot");
		expect(out).toContain("next run, not the next turn");
	});
});
