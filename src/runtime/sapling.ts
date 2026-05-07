/**
 * Built-in `sapling` runtime — spawn-per-turn, native NDJSON event stream.
 *
 * Sapling is a sibling os-eco tool whose headless mode emits one event per
 * line on stdout. The shape isn't Claude Code's stream-json envelope, so we
 * use the generic NDJSON parser and let the kind/payload pass through. The
 * inbox-injection seam is preserved (steering messages get prepended to the
 * prompt) so spawn-per-turn behaviour matches Claude Code's, but the on-the-
 * wire encoding stays plain text.
 */

import type { Message } from "../core/types.ts";
import type { SpawnCommand } from "../provider/types.ts";
import { parseStreamJson } from "./parsers/stream-json.ts";
import type {
	AgentRuntime,
	InstallCheckResult,
	ParseContext,
	ResumeContext,
	RuntimeEvent,
	SpawnContext,
} from "./runtime.ts";
import { runVersionCheck } from "./version.ts";

const SAPLING_BIN = "sapling";

export const saplingRuntime: AgentRuntime = {
	id: "sapling",
	displayName: "Sapling",
	supportsResume: true,

	buildSpawnCommand(ctx: SpawnContext): SpawnCommand {
		return {
			argv: [
				SAPLING_BIN,
				"--json",
				"--prompt",
				composeSaplingPrompt(ctx.prompt, ctx.pendingMessages),
			],
		};
	},

	buildResumeCommand(ctx: ResumeContext): SpawnCommand {
		const argv = [SAPLING_BIN, "--json"];
		if (ctx.priorRun.id) argv.push("--resume", ctx.priorRun.id);
		argv.push("--prompt", composeSaplingPrompt(ctx.prompt, ctx.pendingMessages));
		return { argv };
	},

	parseEvents(line: string, _ctx: ParseContext): RuntimeEvent[] {
		return parseStreamJson(line);
	},

	encodeInboxMessage(messages: Message[]): { stdin: string } {
		// Sapling reads its prompt from --prompt; the inbox encoding is consumed
		// indirectly via composeSaplingPrompt below. We still expose the stdin
		// shape so external callers (chat command, future loops) can format
		// steering messages consistently.
		return { stdin: messages.map(formatSteeringLine).join("\n") };
	},

	async installCheck(): Promise<InstallCheckResult> {
		return runVersionCheck(SAPLING_BIN, ["--version"], {
			hint: "install Sapling: `bun install -g @os-eco/sapling-cli`",
		});
	},
};

/**
 * Compose the per-turn prompt by prefixing any pending steering messages.
 * Exported for unit tests and for the inbox layer to share encoding.
 */
export function composeSaplingPrompt(prompt: string, messages: Message[]): string {
	if (messages.length === 0) return prompt;
	const steering = messages.map(formatSteeringLine).join("\n");
	return prompt.length > 0 ? `${steering}\n\n${prompt}` : steering;
}

function formatSteeringLine(message: Message): string {
	return `[STEERING] (priority: ${message.priority}) ${message.body}`;
}
