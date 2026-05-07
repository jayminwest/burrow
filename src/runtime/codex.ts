/**
 * Built-in `codex` runtime — one-shot, raw-text output.
 *
 * Codex is a single-pass agent: each invocation reads a prompt file,
 * executes once, and exits. There's no inter-turn injection seam, so
 * `supportsResume` is false and `encodeInboxMessage` is intentionally
 * absent — pending steering messages roll over to the *next* run, which
 * the inbox layer surfaces as a warning when the user runs `burrow send`
 * against a one-shot runtime (SPEC §13.3).
 *
 * Pending messages from the prior run are still folded into the next run's
 * prompt prefix here so steering isn't silently lost when the user sends a
 * message and then queues another run.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "../core/types.ts";
import type { SpawnCommand } from "../provider/types.ts";
import { parseRawText } from "./parsers/raw-text.ts";
import type {
	AgentRuntime,
	InstallCheckResult,
	ParseContext,
	PrepareContext,
	RuntimeEvent,
	SpawnContext,
} from "./runtime.ts";
import { runVersionCheck } from "./version.ts";

const CODEX_BIN = "codex";
export const CODEX_PROMPT_DIR = ".burrow/codex";

export const codexRuntime: AgentRuntime = {
	id: "codex",
	displayName: "OpenAI Codex",
	supportsResume: false,

	buildSpawnCommand(ctx: SpawnContext): SpawnCommand {
		const promptFile = codexPromptFileFor(ctx.run.id);
		return {
			argv: [CODEX_BIN, "exec", "--prompt-file", promptFile],
		};
	},

	parseEvents(line: string, _ctx: ParseContext): RuntimeEvent[] {
		return parseRawText(line);
	},

	async prepareWorkspace(ctx: PrepareContext): Promise<void> {
		// Phase 4 establishes the file path; the run-loop layer in Phase 7 owns
		// writing the actual prompt body before spawn (it has the SpawnContext).
		// We just guarantee the directory exists so writeFile in the run loop
		// doesn't trip on a missing parent.
		await mkdir(join(ctx.workspacePath, CODEX_PROMPT_DIR), { recursive: true });
	},

	async installCheck(): Promise<InstallCheckResult> {
		return runVersionCheck(CODEX_BIN, ["--version"], {
			hint: "install OpenAI Codex CLI: see https://github.com/openai/codex",
		});
	},
};

/**
 * Compose a prompt body that prefixes any pending steering messages.
 * Exported so the run-loop layer (Phase 7) can call it when materializing
 * the prompt file before spawn.
 */
export function composeCodexPrompt(prompt: string, messages: Message[]): string {
	if (messages.length === 0) return prompt;
	const steering = messages.map((m) => `[STEERING] (priority: ${m.priority}) ${m.body}`).join("\n");
	return prompt.length > 0 ? `${steering}\n\n${prompt}` : steering;
}

export function codexPromptFileFor(runId: string): string {
	return `${CODEX_PROMPT_DIR}/${runId}.txt`;
}

export async function writeCodexPromptFile(
	workspacePath: string,
	runId: string,
	body: string,
): Promise<string> {
	const rel = codexPromptFileFor(runId);
	const target = join(workspacePath, rel);
	await mkdir(join(workspacePath, CODEX_PROMPT_DIR), { recursive: true });
	await writeFile(target, body, { encoding: "utf8", flag: "w" });
	return target;
}
