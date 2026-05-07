/**
 * Built-in `claude-code` runtime — spawn-per-turn, stream-json over stdin.
 *
 * Claude Code's `--input-format stream-json` reads one user/system JSON
 * envelope per line from stdin and emits matching `--output-format stream-json`
 * lines on stdout. We render the prompt + any pending steering messages as
 * a single multi-line stdin blob, then let the parser turn each output line
 * into structured events.
 *
 * `prepareWorkspace` writes a minimal `.claude/settings.local.json` so the
 * agent has a stable settings file even when the project ships none. Phase 8
 * extends this with policy-driven hooks; for now we just guarantee the file
 * exists so PreToolUse hooks added later have somewhere to land.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "../core/types.ts";
import type { SpawnCommand } from "../provider/types.ts";
import { parseJsonlClaude } from "./parsers/jsonl-claude.ts";
import type {
	AgentRuntime,
	InstallCheckResult,
	ParseContext,
	PrepareContext,
	ResumeContext,
	RuntimeEvent,
	SpawnContext,
} from "./runtime.ts";
import { runVersionCheck } from "./version.ts";

const CLAUDE_BIN = "claude";

export const CLAUDE_CODE_SETTINGS_PATH = ".claude/settings.local.json";

const DEFAULT_SETTINGS: Record<string, unknown> = {
	permissions: {},
	hooks: {},
};

export const claudeCodeRuntime: AgentRuntime = {
	id: "claude-code",
	displayName: "Claude Code",
	supportsResume: true,

	buildSpawnCommand(ctx: SpawnContext): SpawnCommand {
		return {
			argv: [
				CLAUDE_BIN,
				"--print",
				"--input-format",
				"stream-json",
				"--output-format",
				"stream-json",
				"--verbose",
			],
			stdin: encodeClaudeStdin(ctx.prompt, ctx.pendingMessages),
		};
	},

	buildResumeCommand(ctx: ResumeContext): SpawnCommand {
		// Claude Code resumes by --resume <session-id>. The prior run's metadata
		// is expected to carry session_id (populated by the run loop from the
		// system/init event). When absent we fall back to a fresh spawn so a
		// resume request never hard-fails on missing metadata.
		const sessionId = readSessionId(ctx.priorRun.metadataJson);
		const argv = [
			CLAUDE_BIN,
			"--print",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
		];
		if (sessionId) argv.push("--resume", sessionId);
		return {
			argv,
			stdin: encodeClaudeStdin(ctx.prompt, ctx.pendingMessages),
		};
	},

	parseEvents(line: string, _ctx: ParseContext): RuntimeEvent[] {
		return parseJsonlClaude(line);
	},

	encodeInboxMessage(messages: Message[]): { stdin: string } {
		return { stdin: messages.map(claudeUserTurnFromMessage).join("\n") };
	},

	async prepareWorkspace(ctx: PrepareContext): Promise<void> {
		const target = join(ctx.workspacePath, CLAUDE_CODE_SETTINGS_PATH);
		await mkdir(join(ctx.workspacePath, ".claude"), { recursive: true });
		await writeFile(target, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, {
			encoding: "utf8",
			flag: "w",
		});
	},

	async installCheck(): Promise<InstallCheckResult> {
		return runVersionCheck(CLAUDE_BIN, ["--version"], {
			hint: "install Claude Code via `bun install -g @anthropic-ai/claude-code` or follow https://docs.claude.com/claude-code",
		});
	},
};

/**
 * Encode the run's prompt followed by any pending steering messages as a
 * single stdin blob (one JSON envelope per line). Exported for unit tests.
 */
export function encodeClaudeStdin(prompt: string, messages: Message[]): string {
	const lines: string[] = [];
	if (prompt.length > 0) lines.push(claudeUserTurn(prompt));
	for (const m of messages) lines.push(claudeUserTurnFromMessage(m));
	return lines.join("\n");
}

function claudeUserTurn(text: string): string {
	return JSON.stringify({
		type: "user",
		message: { role: "user", content: [{ type: "text", text }] },
	});
}

function claudeUserTurnFromMessage(message: Message): string {
	const tag = `[STEERING] (priority: ${message.priority}) `;
	return claudeUserTurn(`${tag}${message.body}`);
}

function readSessionId(metadata: unknown): string | undefined {
	if (metadata === null || typeof metadata !== "object") return undefined;
	const v = (metadata as Record<string, unknown>).session_id;
	return typeof v === "string" && v.length > 0 ? v : undefined;
}
