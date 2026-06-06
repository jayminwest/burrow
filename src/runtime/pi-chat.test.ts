import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BurrowRow, MessageRow, RunRow } from "../db/schema.ts";
import {
	PI_DEFAULT_MODEL,
	PI_DEFAULT_PROVIDER,
	PI_ENV_PASSTHROUGH,
	PI_FORCED_ARGV_WITH_EXTENSIONS,
	PI_SESSION_DIR,
	piEnvPassthrough,
	piRuntime,
} from "./pi.ts";
import { encodeExtensionUiDecline, piChatRuntime } from "./pi-chat.ts";
import type { RuntimeEvent } from "./runtime.ts";

function fakeBurrow(): BurrowRow {
	return {
		id: "bur_pi_chat",
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
		id: "run_pi_chat",
		burrowId: "bur_pi_chat",
		agentId: "pi-chat",
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
		burrowId: "bur_pi_chat",
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

describe("piChatRuntime identity", () => {
	test("declares id=pi-chat, supportsResume=true, distinct displayName", () => {
		expect(piChatRuntime.id).toBe("pi-chat");
		expect(piChatRuntime.displayName).toBe("Pi (chat)");
		expect(piChatRuntime.supportsResume).toBe(true);
		expect(piChatRuntime.buildResumeCommand).toBeDefined();
	});

	test("reuses pi's env-passthrough function (same conditional set)", () => {
		// Same callback reference — pi-chat tracks pi's
		// multi-provider passthrough contract verbatim.
		expect(piChatRuntime.envPassthrough).toBe(piEnvPassthrough);
	});

	test("registered as a built-in alongside pi", async () => {
		const { BUILT_IN_RUNTIMES } = await import("./registry.ts");
		const ids = BUILT_IN_RUNTIMES.map((r) => r.id);
		expect(ids).toContain("pi-chat");
		expect(ids).toContain("pi");
	});
});

describe("piChatRuntime.buildSpawnCommand", () => {
	test("renders the extensions-enabled argv (no --no-extensions flag)", () => {
		const cmd = piChatRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "fix the bug",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd.argv).not.toContain("--no-extensions");
		// Locked prefix is PI_FORCED_ARGV_WITH_EXTENSIONS — same flags as
		// plain pi modulo the single --no-extensions entry.
		expect(cmd.argv.slice(0, PI_FORCED_ARGV_WITH_EXTENSIONS.length)).toEqual([
			...PI_FORCED_ARGV_WITH_EXTENSIONS,
		]);
		const modelIdx = cmd.argv.indexOf("--model");
		expect(modelIdx).toBeGreaterThan(-1);
		expect(cmd.argv[modelIdx + 1]).toBe(PI_DEFAULT_MODEL);
	});

	test("forced argv still pins --mode rpc, --session-dir, --offline, --provider", () => {
		const cmd = piChatRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd.argv).toContain("--mode");
		expect(cmd.argv).toContain("rpc");
		const sessionIdx = cmd.argv.indexOf("--session-dir");
		expect(cmd.argv[sessionIdx + 1]).toBe(PI_SESSION_DIR);
		expect(cmd.argv).toContain("--offline");
		const providerIdx = cmd.argv.indexOf("--provider");
		expect(cmd.argv[providerIdx + 1]).toBe(PI_DEFAULT_PROVIDER);
	});

	test("frontmatter overrides substitute provider + model", () => {
		const cmd = piChatRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "p",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
			frontmatter: { provider: "openai", model: "gpt-4o" },
		});
		expect(cmd.argv).not.toContain("--no-extensions");
		const providerIdx = cmd.argv.indexOf("--provider");
		expect(cmd.argv[providerIdx + 1]).toBe("openai");
		const modelIdx = cmd.argv.indexOf("--model");
		expect(cmd.argv[modelIdx + 1]).toBe("gpt-4o");
	});

	test("stdin carries one RPC prompt envelope per line, newline-terminated", () => {
		const cmd = piChatRuntime.buildSpawnCommand({
			burrow: fakeBurrow(),
			run: fakeRun(),
			prompt: "fix the bug",
			pendingMessages: [fakeMessage()],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(typeof cmd.stdin).toBe("string");
		expect((cmd.stdin as string).endsWith("\n")).toBe(true);
		const lines = (cmd.stdin as string).split("\n").slice(0, -1);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "")).toEqual({ type: "prompt", message: "fix the bug" });
		expect(lines[1]).toContain("[STEERING]");
	});
});

describe("piChatRuntime.buildResumeCommand", () => {
	test("extensions-enabled argv + --session token from prior metadata", () => {
		const cmd = piChatRuntime.buildResumeCommand?.({
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
		});
		expect(cmd?.argv).not.toContain("--no-extensions");
		expect(cmd?.argv.slice(0, PI_FORCED_ARGV_WITH_EXTENSIONS.length)).toEqual([
			...PI_FORCED_ARGV_WITH_EXTENSIONS,
		]);
		const sessionIdx = cmd?.argv.indexOf("--session") ?? -1;
		expect(cmd?.argv[sessionIdx + 1]).toBe("sess-xyz");
	});

	test("no --session token when metadata lacks one", () => {
		const cmd = piChatRuntime.buildResumeCommand?.({
			burrow: fakeBurrow(),
			run: fakeRun({ id: "run_new" }),
			priorRun: fakeRun({ id: "run_prior", state: "succeeded" }),
			prompt: "continue",
			pendingMessages: [],
			envResolved: {},
			workspacePath: "/ws",
		});
		expect(cmd?.argv).not.toContain("--session");
		expect(cmd?.argv).not.toContain("--no-extensions");
	});
});

describe("piChatRuntime.shouldCloseStdinOnEvent", () => {
	// pi-chat opts INTO the stdin-hold path (predicate is defined — see
	// mx-d7a551) but never returns true. The run stays running past
	// agent_end so the mid-run steering loop drives subsequent operator
	// turns through the still-open stdin (Leveret §0 phase 1).
	test("predicate is defined (gates dispatcher hold-stdin)", () => {
		expect(typeof piChatRuntime.shouldCloseStdinOnEvent).toBe("function");
	});

	test("returns false for agent_end (run continues, dispatcher won't close stdin)", () => {
		const ev = piChatRuntime.parseEvents(JSON.stringify({ type: "agent_end" }), {
			burrow: fakeBurrow(),
			run: fakeRun(),
		})[0];
		if (!ev) throw new Error("expected one event from agent_end envelope");
		expect(piChatRuntime.shouldCloseStdinOnEvent?.(ev)).toBe(false);
	});

	test("returns false for every other lifecycle envelope sampled", () => {
		const samples = [
			JSON.stringify({ type: "response", command: "prompt", success: true }),
			JSON.stringify({ type: "agent_start" }),
			JSON.stringify({ type: "turn_start" }),
			JSON.stringify({ type: "turn_end" }),
			JSON.stringify({ type: "tool_execution_start" }),
			JSON.stringify({ type: "tool_execution_end" }),
			JSON.stringify({ type: "extension_ui_request", id: "ui-1" }),
		];
		for (const line of samples) {
			const ev = piChatRuntime.parseEvents(line, { burrow: fakeBurrow(), run: fakeRun() })[0];
			if (!ev) throw new Error(`expected one event from ${line}`);
			expect(piChatRuntime.shouldCloseStdinOnEvent?.(ev)).toBe(false);
		}
	});

	test("returns false for assistant content events", () => {
		const ev: RuntimeEvent = { kind: "text", stream: "stdout", payload: { text: "hi" } };
		expect(piChatRuntime.shouldCloseStdinOnEvent?.(ev)).toBe(false);
	});
});

describe("piChatRuntime.autoRespondToEvent (extension_ui_request decline)", () => {
	test("declines extension_ui_request with cancelled response carrying request id", () => {
		const events = piChatRuntime.parseEvents(
			JSON.stringify({
				type: "extension_ui_request",
				id: "ui-req-42",
				extensionId: "ext.foo",
				prompt: "approve?",
			}),
			{ burrow: fakeBurrow(), run: fakeRun() },
		);
		const ev = events[0];
		if (!ev) throw new Error("expected one event");
		const out = piChatRuntime.autoRespondToEvent?.(ev);
		expect(out).toBeDefined();
		expect(out?.stdin.endsWith("\n")).toBe(true);
		const parsed = JSON.parse(out?.stdin.trimEnd() ?? "") as {
			type: string;
			id: string | null;
			cancelled: boolean;
		};
		expect(parsed).toEqual({
			type: "extension_ui_response",
			id: "ui-req-42",
			cancelled: true,
		});
	});

	test("missing id on the request falls through as null (defensive — pi always sets id)", () => {
		const events = piChatRuntime.parseEvents(
			JSON.stringify({ type: "extension_ui_request", extensionId: "ext.foo" }),
			{ burrow: fakeBurrow(), run: fakeRun() },
		);
		const ev = events[0];
		if (!ev) throw new Error("expected one event");
		const out = piChatRuntime.autoRespondToEvent?.(ev);
		expect(out).toBeDefined();
		expect(JSON.parse(out?.stdin.trimEnd() ?? "")).toEqual({
			type: "extension_ui_response",
			id: null,
			cancelled: true,
		});
	});

	test("returns undefined for non-extension_ui_request events", () => {
		const samples = [
			JSON.stringify({ type: "agent_end" }),
			JSON.stringify({ type: "agent_start" }),
			JSON.stringify({ type: "turn_start" }),
			JSON.stringify({ type: "tool_execution_start" }),
			JSON.stringify({ type: "response", command: "prompt", success: true }),
			JSON.stringify({ type: "extension_error", extensionId: "ext.foo" }),
		];
		for (const line of samples) {
			const ev = piChatRuntime.parseEvents(line, { burrow: fakeBurrow(), run: fakeRun() })[0];
			if (!ev) throw new Error(`expected one event from ${line}`);
			expect(piChatRuntime.autoRespondToEvent?.(ev)).toBeUndefined();
		}
	});

	test("V1 never sets confirmed:true — allowlist is out of scope", () => {
		const events = piChatRuntime.parseEvents(
			JSON.stringify({ type: "extension_ui_request", id: "ui-1" }),
			{ burrow: fakeBurrow(), run: fakeRun() },
		);
		const ev = events[0];
		if (!ev) throw new Error("expected one event");
		const out = piChatRuntime.autoRespondToEvent?.(ev);
		const parsed = JSON.parse(out?.stdin.trimEnd() ?? "") as Record<string, unknown>;
		expect(parsed.cancelled).toBe(true);
		expect(parsed.confirmed).toBeUndefined();
	});
});

describe("encodeExtensionUiDecline", () => {
	test("emits exactly one JSON envelope terminated by \\n", () => {
		const blob = encodeExtensionUiDecline({ type: "extension_ui_request", id: "abc" });
		expect(blob.endsWith("\n")).toBe(true);
		const lines = blob.split("\n").slice(0, -1);
		expect(lines).toHaveLength(1);
	});

	test("non-string id collapses to null", () => {
		const blob = encodeExtensionUiDecline({ type: "extension_ui_request", id: 7 });
		expect(JSON.parse(blob.trimEnd())).toEqual({
			type: "extension_ui_response",
			id: null,
			cancelled: true,
		});
	});

	test("null / undefined payload still produces a well-formed response envelope", () => {
		for (const p of [null, undefined, "string", 42]) {
			const blob = encodeExtensionUiDecline(p);
			const parsed = JSON.parse(blob.trimEnd()) as Record<string, unknown>;
			expect(parsed.type).toBe("extension_ui_response");
			expect(parsed.id).toBeNull();
			expect(parsed.cancelled).toBe(true);
		}
	});
});

describe("piChatRuntime.encodeSteeringMessage / encodeInboxMessage parity with pi", () => {
	// pi-chat shares the helpers verbatim — the same wire shape covers
	// both the at-spawn pendingMessages drain and the mid-run delivery
	// loop (SPEC §13.5).
	test("encodeSteeringMessage is the same wire shape as piRuntime's", () => {
		const msg = fakeMessage({ id: "msg_x", body: "do thing", priority: "high" });
		expect(piChatRuntime.encodeSteeringMessage?.(msg)).toEqual(
			piRuntime.encodeSteeringMessage?.(msg) ?? { stdin: "" },
		);
	});

	test("encodeInboxMessage is the same wire shape as piRuntime's", () => {
		const msgs = [
			fakeMessage({ id: "m1", body: "a", priority: "urgent" }),
			fakeMessage({ id: "m2", body: "b", priority: "low" }),
		];
		expect(piChatRuntime.encodeInboxMessage?.(msgs)).toEqual(
			piRuntime.encodeInboxMessage?.(msgs) ?? { stdin: "" },
		);
	});
});

describe("piChatRuntime.envPassthrough (delegates to piEnvPassthrough)", () => {
	test("default (no frontmatter) returns the pi base set", () => {
		const fn = piChatRuntime.envPassthrough;
		expect(typeof fn).toBe("function");
		if (typeof fn !== "function") return;
		expect([...fn({})]).toEqual([...PI_ENV_PASSTHROUGH]);
	});

	test("non-anthropic provider unions the matching provider key", () => {
		const fn = piChatRuntime.envPassthrough;
		if (typeof fn !== "function") throw new Error("envPassthrough must be function-form");
		const names = fn({ frontmatter: { provider: "openai" } });
		expect(names).toContain("OPENAI_API_KEY");
		expect(names).toContain("OPENAI_BASE_URL");
		for (const base of PI_ENV_PASSTHROUGH) expect(names).toContain(base);
	});
});

describe("piChatRuntime.prepareWorkspace + extractMetadata (reused from pi)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "burrow-pichat-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("prepareWorkspace creates .pi/sessions/ under workspacePath", async () => {
		await piChatRuntime.prepareWorkspace?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		const fs = await import("node:fs");
		expect(fs.statSync(join(dir, PI_SESSION_DIR)).isDirectory()).toBe(true);
	});

	test("extractMetadata recovers session_id from the newest session jsonl", async () => {
		const sessionDir = join(dir, PI_SESSION_DIR);
		await mkdir(sessionDir, { recursive: true });
		await writeFile(
			join(sessionDir, "2026-06-06T00-00-00-000Z_sess.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "sess-pi-chat" })}\n`,
		);
		const patch = await piChatRuntime.extractMetadata?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		expect(patch).toEqual({ session_id: "sess-pi-chat" });
	});

	test("extractMetadata returns undefined when no session file exists", async () => {
		const patch = await piChatRuntime.extractMetadata?.({
			burrow: fakeBurrow(),
			run: fakeRun(),
			workspacePath: dir,
		});
		expect(patch).toBeUndefined();
	});
});

describe("piChatRuntime.parseEvents", () => {
	test("delegates to parsePiEvents", () => {
		const events = piChatRuntime.parseEvents(
			JSON.stringify({ type: "extension_ui_request", id: "u1" }),
			{ burrow: fakeBurrow(), run: fakeRun() },
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
	});
});
