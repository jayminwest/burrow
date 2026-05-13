/**
 * Built-in `pi` runtime — spawn-per-turn, JSON-RPC over stdin (pi v0.74.0).
 *
 * Pi's `--mode rpc` reads one JSON command per `\n`-delimited line on stdin
 * and emits one JSON event per line on stdout. Each burrow run writes a
 * single `{"type":"prompt","message":"<prompt + steering prefix>"}` line and
 * then waits for the agent to drain. The parser in
 * `src/runtime/parsers/pi.ts` collapses pi's wider event vocabulary into
 * burrow's stable taxonomy (SPEC §14.1) — the runtime here owns argv,
 * stdin payload, env passthrough, and installCheck.
 *
 * Forced argv flags (locked by unit tests):
 *
 *   - `--mode rpc`            — JSONL command/event protocol.
 *   - `--session-dir <path>`  — pin per-burrow session storage to
 *                               `<workspace>/.pi/sessions`. Pi writes one
 *                               `<ts>_<uuid>.jsonl` file per run there;
 *                               `extractMetadata` reads the most recent
 *                               file's header to recover the session id
 *                               for `buildResumeCommand`.
 *   - `--no-extensions`       — pi's `extension_ui_request` is an
 *                               interactive prompt RPC the dispatcher has
 *                               no path to answer; force-disable to avoid
 *                               hangs on auto-discovered extensions
 *                               (workspace `.pi/extensions/`, user
 *                               `~/.pi/extensions/`).
 *   - `--provider anthropic`  — pi's CLI default provider is Gemini;
 *                               omitting this would silently bill
 *                               GEMINI_API_KEY against a runtime declared
 *                               for Claude. Hardcoded so the
 *                               `ANTHROPIC_API_KEY` envPassthrough below
 *                               actually authenticates.
 *
 * Auth precedence (mx-5fee0d): on a host with `~/.pi/agent/auth.json`
 * populated (developer ran `pi /login`), pi prefers the stored OAuth token
 * over `ANTHROPIC_API_KEY`. Inside the sandbox `~/.pi` is not bind-mounted,
 * so the env-var route always wins there. In host-mode dev it's a footgun
 * — surfaced via the install-check hint rather than mutated, since burrow
 * should never silently rewrite a developer's auth state.
 *
 * Resume contract (lifting burrow-4d8b V1 posture): pi v0.74.0 does NOT
 * emit the session id on `agent_end`; the only stable surface is the
 * `--session-dir` filesystem layout (per-session `<ts>_<uuid>.jsonl`) and
 * the `get_state` RPC reply (`data.sessionId`). `extractMetadata` reads
 * the newest session file's first line (a `{"type":"session","id":...}`
 * envelope pi writes synchronously on startup) and persists the UUID as
 * `Run.metadataJson.session_id`. `buildResumeCommand` then passes
 * `--session <id>` alongside the pinned `--session-dir` so the next run
 * resumes the same conversation.
 *
 * Critical dispatcher invariant (mx-d9b3ad, from the captured fixtures):
 * pi exits the instant stdin closes, even mid-inference. The runtime
 * declares `shouldCloseStdinOnEvent` returning true for `agent_end`, which
 * tells the dispatcher to write the prompt + hold stdin open, then close
 * it only after pi has emitted its terminal lifecycle envelope. Real e2e
 * runs without this hook produce only response+agent_start+turn_start and
 * exit 0 with no assistant content (burrow-5db3).
 *
 * Mid-run steering (SPEC §13.5, burrow-250d): because stdin is held open
 * until `agent_end`, the dispatcher can route inbox messages arriving
 * during an in-flight turn directly to pi by writing additional
 * `{"type":"prompt",...}` lines through `SpawnResult.writeStdin`. The
 * runtime exposes that encoding via `encodeSteeringMessage` so other
 * runtimes that grow a stdin-held path can adopt the same seam without
 * pi-specific dispatcher code.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../core/types.ts";
import type { SpawnCommand } from "../provider/types.ts";
import { parsePiEvents } from "./parsers/pi.ts";
import type {
	AgentFrontmatter,
	AgentRuntime,
	ExtractMetadataContext,
	InstallCheckResult,
	ParseContext,
	PrepareContext,
	ResumeContext,
	RuntimeEvent,
	SpawnContext,
} from "./runtime.ts";
import { runVersionCheck } from "./version.ts";

const PI_BIN = "pi";

/**
 * Model pin for V1. Matches the model used to capture the golden RPC
 * fixtures under `src/runtime/parsers/__golden__/`, so the runtime's wire
 * shape stays in lockstep with what the parser was validated against.
 * Bump only when the fixtures are regenerated against a new model.
 */
export const PI_DEFAULT_MODEL = "claude-haiku-4-5";

/**
 * Per-burrow session storage root, relative to the burrow workspace. Pi's
 * `--session-dir` flag resolves relative paths against the agent's cwd
 * (the workspace), so a relative value works for both bwrap (where the
 * workspace is remapped to `/workspace`) and sandbox-exec (where the
 * workspace stays at its host path). The host side reads from
 * `<workspacePath>/<PI_SESSION_DIR>` to recover the session id post-spawn.
 */
export const PI_SESSION_DIR = ".pi/sessions";

/**
 * Default provider when `SpawnContext.frontmatter.provider` is unset. Kept
 * separate from `PI_FORCED_ARGV` because `buildPiArgv` substitutes this
 * slot when an upstream caller (e.g. warren) supplies a non-empty
 * frontmatter override (burrow-b5b4); the constant continues to express
 * "what pi runs with no override" so the regression-locked argv shape
 * stays intact.
 */
export const PI_DEFAULT_PROVIDER = "anthropic";

/**
 * Locked prefix of `pi`'s argv when no frontmatter overrides are in play.
 * The trailing `--model <PI_DEFAULT_MODEL>` pair is appended in
 * `buildSpawnCommand` — split out so the test that enforces flag presence
 * can assert the prefix without coupling to the exact pinned model. When
 * `SpawnContext.frontmatter.provider` is non-empty `buildPiArgv` swaps the
 * final `PI_DEFAULT_PROVIDER` slot for the override; otherwise this array
 * is the rendered prefix verbatim.
 */
export const PI_FORCED_ARGV: readonly string[] = [
	PI_BIN,
	"--mode",
	"rpc",
	"--session-dir",
	PI_SESSION_DIR,
	"--no-extensions",
	"--provider",
	PI_DEFAULT_PROVIDER,
] as const;

/**
 * Host env vars the `pi` CLI consults at startup. Forwarded into the
 * sandbox via `SandboxProfile.envPassthrough` so a project with no
 * `burrow.toml [env]` block still authenticates when `ANTHROPIC_API_KEY`
 * (or its siblings) is set in the burrow process env. Aligned with
 * `claude-code` minus the `CLAUDE_CODE_OAUTH_TOKEN` flavor since pi's
 * OAuth path is keyed off `~/.pi/agent/auth.json` (not bind-mounted into
 * the sandbox), not an env var.
 *
 * Non-anthropic provider keys (`GEMINI_API_KEY`, `OPENAI_API_KEY`, ...)
 * are intentionally NOT in this list — argv pins `--provider anthropic`,
 * so forwarding them would leak host secrets into a sandbox that can't
 * use them. Projects that override the provider via `burrow.toml [env]`
 * passthrough opt in per-project (mx-d46d5d).
 */
export const PI_ENV_PASSTHROUGH: readonly string[] = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
] as const;

export const piRuntime: AgentRuntime = {
	id: "pi",
	displayName: "Pi",
	supportsResume: true,
	envPassthrough: PI_ENV_PASSTHROUGH,

	buildSpawnCommand(ctx: SpawnContext): SpawnCommand {
		return {
			argv: buildPiArgv(ctx.frontmatter),
			stdin: encodePiStdin(ctx.prompt, ctx.pendingMessages),
		};
	},

	buildResumeCommand(ctx: ResumeContext): SpawnCommand {
		const argv = buildPiArgv(ctx.frontmatter);
		const sessionId = readSessionId(ctx.priorRun.metadataJson);
		if (sessionId) argv.push("--session", sessionId);
		return {
			argv,
			stdin: encodePiStdin(ctx.prompt, ctx.pendingMessages),
		};
	},

	parseEvents(line: string, _ctx: ParseContext): RuntimeEvent[] {
		return parsePiEvents(line);
	},

	/**
	 * pi v0.74.0 exits the instant stdin closes (mx-d9b3ad), so the dispatcher
	 * must hold stdin open until the run actually finishes. `agent_end` is
	 * pi's terminal lifecycle envelope (collapsed by the parser to
	 * `state_change` on `system` with the raw envelope preserved in
	 * `payload`); closing stdin on that signal lets pi exit cleanly through
	 * its RPC read loop instead of being killed mid-inference.
	 */
	shouldCloseStdinOnEvent(event: RuntimeEvent): boolean {
		if (event.kind !== "state_change") return false;
		const payload = event.payload as { type?: unknown } | null | undefined;
		return !!payload && payload.type === "agent_end";
	},

	encodeInboxMessage(messages: Message[]): { stdin: string } {
		return { stdin: messages.map(piPromptCommandFromMessage).join("\n") };
	},

	/**
	 * Mid-run steering (SPEC §13.5, burrow-250d). Pi's `--mode rpc` reads
	 * one JSON command per `\n`-delimited line from stdin, so an in-flight
	 * agent can be steered by writing additional `{"type":"prompt",...}`
	 * envelopes to the still-open sink (the stdin-hold path established by
	 * burrow-5db3 keeps the FD live until `agent_end`). Pi's RPC vocabulary
	 * pinned to `prompt` here for the same reason `encodeInboxMessage` uses
	 * it — that's the only command shape proven against the captured
	 * fixtures; if a later pi version exposes a dedicated `steer` /
	 * `follow_up` command this is the one place to bump.
	 */
	encodeSteeringMessage(message: Message): { stdin: string } {
		return { stdin: `${piPromptCommandFromMessage(message)}\n` };
	},

	async prepareWorkspace(ctx: PrepareContext): Promise<void> {
		mkdirSync(join(ctx.workspacePath, PI_SESSION_DIR), { recursive: true });
	},

	async extractMetadata(ctx: ExtractMetadataContext): Promise<Record<string, unknown> | undefined> {
		const sessionId = readNewestPiSessionId(join(ctx.workspacePath, PI_SESSION_DIR));
		return sessionId ? { session_id: sessionId } : undefined;
	},

	async installCheck(): Promise<InstallCheckResult> {
		return runVersionCheck(PI_BIN, ["--version"], {
			hint: "install pi: `bun install -g @earendil-works/pi-coding-agent` (run `pi /login` for subscription auth or set ANTHROPIC_API_KEY)",
		});
	},
};

/**
 * Render pi's argv with optional per-run frontmatter overrides (burrow-b5b4).
 * When `frontmatter.provider` is non-empty (after trim) it replaces the
 * default `PI_DEFAULT_PROVIDER` slot in the locked prefix; when unset, the
 * prefix stays bit-for-bit identical to `PI_FORCED_ARGV`. Same story for
 * `--model`: a non-empty `frontmatter.model` substitutes for
 * `PI_DEFAULT_MODEL`. `envPassthrough` is intentionally not adjusted here —
 * projects opt non-anthropic provider keys in via `burrow.toml [env]`
 * (mx-d46d5d). Exported for unit tests.
 */
export function buildPiArgv(frontmatter?: AgentFrontmatter): string[] {
	const argv = [...PI_FORCED_ARGV];
	const provider = nonEmpty(frontmatter?.provider);
	if (provider) argv[argv.length - 1] = provider;
	const model = nonEmpty(frontmatter?.model) ?? PI_DEFAULT_MODEL;
	argv.push("--model", model);
	return argv;
}

function nonEmpty(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Encode the run's prompt followed by any pending steering messages as a
 * single stdin blob — one `{"type":"prompt", ...}` JSON envelope per line.
 * Each pending steering message becomes its own prompt command, prefixed
 * with the standard `[STEERING] (priority: P) ` tag for parity with
 * claude-code (mx-63b005). Exported for unit tests.
 *
 * When the run carries no prompt (e.g. inbox-only nudge) the first line
 * is dropped, mirroring `encodeClaudeStdin`'s contract.
 */
export function encodePiStdin(prompt: string, messages: Message[]): string {
	const lines: string[] = [];
	if (prompt.length > 0) lines.push(piPromptCommand(prompt));
	for (const m of messages) lines.push(piPromptCommandFromMessage(m));
	return lines.join("\n");
}

function piPromptCommand(text: string): string {
	return JSON.stringify({ type: "prompt", message: text });
}

function piPromptCommandFromMessage(message: Message): string {
	const tag = `[STEERING] (priority: ${message.priority}) `;
	return piPromptCommand(`${tag}${message.body}`);
}

function readSessionId(metadata: unknown): string | undefined {
	if (metadata === null || typeof metadata !== "object") return undefined;
	const v = (metadata as Record<string, unknown>).session_id;
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Read the session id from the newest `*.jsonl` in `sessionDir`. Pi writes
 * each session's UUID into the first line of the file as
 * `{"type":"session","version":N,"id":"<uuid>",...}` synchronously on
 * startup, so the file is guaranteed to exist with at least one line by
 * the time the agent has emitted any output. Returns `undefined` when the
 * directory is missing, empty, or the header line doesn't parse —
 * extraction is best-effort and the dispatcher swallows failures.
 *
 * Exported for unit tests.
 */
export function readNewestPiSessionId(sessionDir: string): string | undefined {
	if (!existsSync(sessionDir)) return undefined;
	let entries: string[];
	try {
		entries = readdirSync(sessionDir).filter((n) => n.endsWith(".jsonl"));
	} catch {
		return undefined;
	}
	if (entries.length === 0) return undefined;

	let newest: { path: string; mtimeMs: number } | undefined;
	for (const name of entries) {
		const path = join(sessionDir, name);
		try {
			const stat = statSync(path);
			if (newest === undefined || stat.mtimeMs > newest.mtimeMs) {
				newest = { path, mtimeMs: stat.mtimeMs };
			}
		} catch {
			// skip unreadable entries
		}
	}
	if (!newest) return undefined;

	let body: string;
	try {
		body = readFileSync(newest.path, "utf8");
	} catch {
		return undefined;
	}
	const firstNewline = body.indexOf("\n");
	const header = firstNewline === -1 ? body : body.slice(0, firstNewline);
	try {
		const parsed = JSON.parse(header) as { type?: string; id?: unknown };
		if (parsed.type !== "session") return undefined;
		return typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : undefined;
	} catch {
		return undefined;
	}
}
