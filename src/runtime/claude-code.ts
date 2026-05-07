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
 * agent has a stable settings file even when the project ships none, plants a
 * private `.burrow-tmp/` for the spawn's `TMPDIR` (burrow-8452 — the host
 * UID-keyed `/tmp/claude-${uid}/` root races every other claude-code on the
 * machine during startup cleanup), and, when the host is logged in (SPEC
 * §17.4), forwards credentials into the burrow's `.claude/` so the sandboxed
 * agent finds them via HOME-relative lookup without requiring a second
 * `/login`. Source is platform-specific:
 *   - linux: copy `~/.claude/.credentials.json` if present.
 *   - darwin: extract from the macOS Keychain (service `Claude Code-
 *     credentials`) and materialize as `.credentials.json`. The sandbox
 *     denies Keychain IPC, so the file fallback is the only viable path.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { homedir } from "node:os";
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

/**
 * Per-burrow TMPDIR root. claude-code's Bash tool stores command output under
 * `${TMPDIR-/tmp}/claude-${uid}/...` and runs a startup cleanup sweep across
 * the entire UID-keyed root — that races every other claude-code on the host
 * (the user's terminal session, sibling burrows) and surfaces as
 * `<bash output unavailable: ... could not be read (EPERM)>`. Pinning TMPDIR
 * inside the workspace gives each burrowed claude a private sweep boundary
 * (burrow-8452).
 */
export const CLAUDE_CODE_BURROW_TMPDIR = ".burrow-tmp";

/** Auth file Claude Code writes when it can't reach the OS keychain. */
const CLAUDE_CREDENTIALS_FILE = ".credentials.json";

const DEFAULT_SETTINGS: Record<string, unknown> = {
	permissions: {},
	hooks: {},
};

/**
 * Resolve the host paths Claude Code uses for auth + per-user state. Returns
 * only those that currently exist so a fresh host (no `~/.claude` yet)
 * contributes nothing instead of breaking the bind mount.
 */
export function claudeCodeHostCredentialPaths(home: string = homedir()): string[] {
	const candidates = [join(home, ".claude"), join(home, ".claude.json")];
	return candidates.filter((p) => existsSync(p));
}

/** macOS Keychain service name claude-code uses for OAuth tokens. */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

export interface ForwardCredentialsOptions {
	home?: string;
	plat?: NodeJS.Platform;
	/** Override for tests: returns the Keychain blob (or null if absent). */
	keychainReader?: KeychainReader;
}

/**
 * Read the Claude Code OAuth blob from the macOS Keychain. Returns `null`
 * when the entry is missing or the `security` shell-out is unavailable so
 * a fresh host (no login yet) is never a hard error.
 */
export type KeychainReader = (service: string) => Promise<string | null>;

export const macKeychainReader: KeychainReader = async (service) => {
	try {
		const proc = Bun.spawn(["security", "find-generic-password", "-s", service, "-w"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exit = await proc.exited;
		if (exit !== 0) return null;
		const out = (await new Response(proc.stdout).text()).trim();
		return out.length > 0 ? out : null;
	} catch {
		return null;
	}
};

/**
 * Forward host credentials into the burrow's `.claude/`. Inside the sandbox
 * HOME is `/workspace`, so the agent reads `HOME/.claude/.credentials.json` —
 * materializing the file ahead of every spawn lets token refreshes pick up on
 * the next prompt without round-tripping through `bw destroy`. No-op when
 * the host has never logged in.
 *
 * Linux: copy the host's `.credentials.json` byte-for-byte.
 * macOS: extract from the Keychain (service `Claude Code-credentials`) and
 * write the JSON blob into the workspace. The sandbox profile denies
 * Keychain IPC, so claude-code's file fallback is the only path that works.
 */
export async function forwardClaudeHostCredentials(
	workspacePath: string,
	options: ForwardCredentialsOptions = {},
): Promise<void> {
	const plat = options.plat ?? process.platform;
	const home = options.home ?? homedir();

	let body: string | null = null;
	if (plat === "darwin") {
		const reader = options.keychainReader ?? macKeychainReader;
		body = await reader(CLAUDE_KEYCHAIN_SERVICE);
	} else {
		const hostCreds = join(home, ".claude", CLAUDE_CREDENTIALS_FILE);
		if (existsSync(hostCreds)) {
			const claudeDir = join(workspacePath, ".claude");
			mkdirSync(claudeDir, { recursive: true });
			await copyFile(hostCreds, join(claudeDir, CLAUDE_CREDENTIALS_FILE));
		}
		return;
	}

	if (body === null) return;
	const claudeDir = join(workspacePath, ".claude");
	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(join(claudeDir, CLAUDE_CREDENTIALS_FILE), body, {
		encoding: "utf8",
		flag: "w",
		mode: 0o600,
	});
}

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
				// Burrow's bwrap/sandbox-exec is the enforcement boundary; an in-app
				// prompt would deadlock a non-interactive spawn.
				"--dangerously-skip-permissions",
			],
			env: { TMPDIR: claudeCodeBurrowTmpdir(ctx.workspacePath) },
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
			"--dangerously-skip-permissions",
		];
		if (sessionId) argv.push("--resume", sessionId);
		return {
			argv,
			env: { TMPDIR: claudeCodeBurrowTmpdir(ctx.workspacePath) },
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
		const claudeDir = join(ctx.workspacePath, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(ctx.workspacePath, CLAUDE_CODE_SETTINGS_PATH),
			`${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`,
			{ encoding: "utf8", flag: "w" },
		);
		ensureBurrowTmpdir(ctx.workspacePath);
		await forwardClaudeHostCredentials(ctx.workspacePath);
	},

	async credentialPaths(): Promise<string[]> {
		return claudeCodeHostCredentialPaths();
	},

	async installCheck(): Promise<InstallCheckResult> {
		return runVersionCheck(CLAUDE_BIN, ["--version"], {
			hint: "install Claude Code via `bun install -g @anthropic-ai/claude-code` or follow https://docs.claude.com/claude-code",
		});
	},
};

/**
 * Resolve the in-sandbox absolute path of the per-burrow TMPDIR. The runtime
 * always shares a platform with the host that runs it (burrow can't host a
 * Linux sandbox on macOS or vice versa), so `process.platform` is the right
 * proxy for sandbox layout: bwrap remaps the workspace to `/workspace`,
 * sandbox-exec leaves it at the host path. Exposed with a `plat` override for
 * unit tests.
 */
export function claudeCodeBurrowTmpdir(
	workspacePath: string,
	plat: NodeJS.Platform = process.platform,
): string {
	const home = plat === "linux" ? "/workspace" : workspacePath;
	return join(home, CLAUDE_CODE_BURROW_TMPDIR);
}

/**
 * Materialize the per-burrow TMPDIR on the host and drop a `*` .gitignore so
 * tool output never trips `git status` inside a project worktree.
 */
function ensureBurrowTmpdir(workspacePath: string): void {
	const dir = join(workspacePath, CLAUDE_CODE_BURROW_TMPDIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".gitignore"), "*\n", { encoding: "utf8", flag: "w" });
}

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
