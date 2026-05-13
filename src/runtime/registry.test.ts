import { describe, expect, test } from "bun:test";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { AgentRegistry, BUILT_IN_RUNTIMES } from "./registry.ts";

describe("AgentRegistry", () => {
	test("seeds with the built-in runtimes by default", () => {
		const reg = new AgentRegistry();
		expect(reg.has("claude-code")).toBe(true);
		expect(reg.has("sapling")).toBe(true);
		expect(reg.has("codex")).toBe(true);
		expect(reg.has("pi")).toBe(true);
		expect(reg.list()).toHaveLength(BUILT_IN_RUNTIMES.length);
	});

	test("pi built-in resolves to the Pi runtime", () => {
		const reg = new AgentRegistry();
		const pi = reg.require("pi");
		expect(pi.id).toBe("pi");
		expect(pi.displayName).toBe("Pi");
		expect(pi.supportsResume).toBe(false);
	});

	test("register accepts a raw AgentRuntime object", () => {
		const reg = new AgentRegistry([]);
		reg.register({
			id: "fake",
			displayName: "Fake",
			supportsResume: false,
			buildSpawnCommand: () => ({ argv: ["fake"] }),
			parseEvents: () => [],
			installCheck: async () => ({ installed: true }),
		});
		expect(reg.get("fake")?.displayName).toBe("Fake");
	});

	test("register accepts an AgentConfig and lifts it into a runtime", () => {
		const reg = new AgentRegistry([]);
		reg.register({
			id: "decl",
			displayName: "Declarative",
			command: "x",
			args: [],
			promptDelivery: "arg",
			outputFormat: "raw-text",
			supportsResume: false,
			inboxDelivery: "none",
		});
		expect(reg.get("decl")?.id).toBe("decl");
	});

	test("same id later overrides earlier (SPEC §12.3 resolution order)", () => {
		const reg = new AgentRegistry();
		const before = reg.require("claude-code");
		reg.register({
			id: "claude-code",
			displayName: "Claude Code (custom)",
			command: "claude",
			args: ["{{prompt}}"],
			promptDelivery: "arg",
			outputFormat: "jsonl-claude",
			supportsResume: true,
			inboxDelivery: "stdin-ndjson",
		});
		const after = reg.require("claude-code");
		expect(after).not.toBe(before);
		expect(after.displayName).toBe("Claude Code (custom)");
	});

	test("require throws NotFoundError for unknown ids", () => {
		const reg = new AgentRegistry([]);
		expect(() => reg.require("missing")).toThrow(NotFoundError);
	});

	test("invalid configs surface as ValidationError", () => {
		const reg = new AgentRegistry([]);
		expect(() =>
			reg.register({
				id: "bad",
				command: "x",
				outputFormat: "stream-json",
				// missing displayName, args, promptDelivery
			}),
		).toThrow(ValidationError);
	});

	test("unregister returns true on hit, false on miss", () => {
		const reg = new AgentRegistry();
		expect(reg.unregister("claude-code")).toBe(true);
		expect(reg.unregister("claude-code")).toBe(false);
	});
});
