/**
 * In-memory registry for agent runtimes (SPEC §12.3 resolution order).
 *
 * The library boots with the built-ins pre-registered; user-supplied
 * AgentConfigs and adapters layer on top via `register`. Same `id` later
 * overrides earlier — letting `~/.config/burrow/agents.toml` or a project's
 * `burrow.toml: agents` patch a built-in (e.g. swap claude-code's settings
 * template) without forking the runtime code.
 *
 * The registry is intentionally minimal: lookups are sync, registration is
 * a method call, no I/O. Loading agent configs from disk is a job for the
 * config layer (Phase 8); the registry only stores resolved runtimes.
 */

import { NotFoundError, ValidationError } from "../core/errors.ts";
import type { AgentConfig } from "../schemas/agent-config.ts";
import { claudeCodeRuntime } from "./claude-code.ts";
import { codexRuntime } from "./codex.ts";
import { loadAgentConfig } from "./declarative.ts";
import { piRuntime } from "./pi.ts";
import { piChatRuntime } from "./pi-chat.ts";
import type { AgentRuntime } from "./runtime.ts";
import { saplingRuntime } from "./sapling.ts";

export const BUILT_IN_RUNTIMES: readonly AgentRuntime[] = [
	claudeCodeRuntime,
	saplingRuntime,
	codexRuntime,
	piRuntime,
	piChatRuntime,
] as const;

export class AgentRegistry {
	private readonly runtimes = new Map<string, AgentRuntime>();

	constructor(initial: Iterable<AgentRuntime> = BUILT_IN_RUNTIMES) {
		for (const rt of initial) this.register(rt);
	}

	register(input: AgentRuntime | AgentConfig | unknown): AgentRuntime {
		const runtime = coerceToRuntime(input);
		if (runtime.id.length === 0) {
			throw new ValidationError("agent runtime id must not be empty");
		}
		this.runtimes.set(runtime.id, runtime);
		return runtime;
	}

	get(id: string): AgentRuntime | undefined {
		return this.runtimes.get(id);
	}

	require(id: string): AgentRuntime {
		const rt = this.get(id);
		if (!rt) {
			throw new NotFoundError(`agent runtime not registered: ${id}`, {
				recoveryHint: `register a runtime via burrow.toml [[agents]] or Client.agents.register({ id: "${id}", ... })`,
			});
		}
		return rt;
	}

	has(id: string): boolean {
		return this.runtimes.has(id);
	}

	list(): AgentRuntime[] {
		return [...this.runtimes.values()];
	}

	/** Drop a registered runtime. Returns true if a row was removed. */
	unregister(id: string): boolean {
		return this.runtimes.delete(id);
	}
}

function coerceToRuntime(input: AgentRuntime | AgentConfig | unknown): AgentRuntime {
	// Already a fully-shaped runtime — accept as-is. Anything else has to pass
	// through the Zod schema so a malformed config fails loudly at registration
	// time instead of at first run.
	if (isRuntime(input)) return input;
	return loadAgentConfig(input);
}

function isRuntime(v: unknown): v is AgentRuntime {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.id === "string" &&
		typeof o.displayName === "string" &&
		typeof o.buildSpawnCommand === "function" &&
		typeof o.parseEvents === "function" &&
		typeof o.installCheck === "function"
	);
}
