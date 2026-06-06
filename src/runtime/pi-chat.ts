/**
 * Built-in `pi-chat` runtime — conversational, stdin-held variant of `pi`
 * (Leveret §0 phase 1; burrow-f375). Same pi binary, same RPC wire
 * (`--mode rpc`), same per-burrow session storage (`.pi/sessions`), same
 * env-passthrough function — the only deltas from `piRuntime` are:
 *
 *   1. Extensions enabled. `buildPiArgv(..., { extensions: true })` elides
 *      `--no-extensions` so pi loads workspace/user extensions and may
 *      emit `extension_ui_request` envelopes mid-run. The plain `pi`
 *      runtime stays byte-identical to its V1 argv shape (still emits
 *      `--no-extensions`); the two runtimes share `buildPiArgv` through
 *      the `extensions` option seam (burrow-12ba).
 *
 *   2. `shouldCloseStdinOnEvent` is DEFINED but never returns true.
 *      Dispatcher behavior is gated on the hook being defined at all —
 *      defining it opts the runtime into the stdin-hold path (mx-d7a551)
 *      so the child's stdin FD stays live for as long as the dispatcher
 *      keeps the run going. A predicate that never trips means no
 *      parsed event closes stdin: the run remains `running` past
 *      `agent_end`, and the mid-run steering loop (SPEC §13.5) drives
 *      subsequent operator turns by writing fresh `prompt` envelopes to
 *      the still-open stdin via `encodeSteeringMessage`. Stdin is only
 *      closed when the dispatcher tears the run down externally (stop /
 *      kill / process exit), at which point the parent dispatcher path
 *      finalizes the run.
 *
 *   3. `autoRespondToEvent` declines `extension_ui_request` envelopes
 *      with `{type:"extension_ui_response", id, cancelled:true}` written
 *      verbatim to the held stdin (burrow-aea0). A V1 allowlist
 *      (`confirmed:true`) is intentionally out of scope — every
 *      extension UI prompt is auto-cancelled so an interactive
 *      extension can't stall a burrow run. The dispatcher invokes the
 *      hook once per persisted event and writes the returned `stdin`
 *      payload through `SpawnResult.writeStdin`; payloads include their
 *      own trailing `\n` for pi's NDJSON read loop.
 *
 * Everything else (`buildSpawnCommand`, `buildResumeCommand`,
 * `parseEvents`, `encodeSteeringMessage`, `encodeInboxMessage`,
 * `prepareWorkspace`, `extractMetadata`, `installCheck`) reuses the pi
 * runtime's helpers directly so the two runtimes stay in lockstep on
 * argv shape, stdin framing, and session/resume contract.
 */

import type { SpawnCommand } from "../provider/types.ts";
import { parsePiEvents } from "./parsers/pi.ts";
import { buildPiArgv, encodePiStdin, piEnvPassthrough, piRuntime } from "./pi.ts";
import type {
	AgentRuntime,
	ExtractMetadataContext,
	InstallCheckResult,
	ParseContext,
	PrepareContext,
	ResumeContext,
	RuntimeEvent,
	SpawnContext,
} from "./runtime.ts";

/**
 * Encode pi-chat's reply to an `extension_ui_request` envelope. V1
 * unconditionally cancels every prompt — burrow has no surface to ask the
 * operator whether to approve an extension UI flow, and the spec parks
 * the allowlist (`confirmed:true`) decision for a later iteration. Same
 * NDJSON framing as every other pi RPC command (trailing `\n`).
 *
 * The id field is copied from the request envelope verbatim. Pi correlates
 * the response by id; a missing / non-string id falls through as `null` so
 * pi can still match the reply when it issues an anonymous request (the
 * existing pi vocabulary always carries an id, so this is defensive).
 *
 * Exported for unit tests.
 */
export function encodeExtensionUiDecline(payload: unknown): string {
	const id = readStringField(payload, "id");
	return `${JSON.stringify({
		type: "extension_ui_response",
		id: id ?? null,
		cancelled: true,
	})}\n`;
}

function readStringField(payload: unknown, key: string): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const v = (payload as Record<string, unknown>)[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function isExtensionUiRequest(event: RuntimeEvent): boolean {
	if (event.kind !== "state_change") return false;
	const payload = event.payload as { type?: unknown } | null | undefined;
	return !!payload && payload.type === "extension_ui_request";
}

export const piChatRuntime: AgentRuntime = {
	id: "pi-chat",
	displayName: "Pi (chat)",
	supportsResume: true,
	envPassthrough: piEnvPassthrough,

	buildSpawnCommand(ctx: SpawnContext): SpawnCommand {
		return {
			argv: buildPiArgv(ctx.frontmatter, { extensions: true }),
			stdin: encodePiStdin(ctx.prompt, ctx.pendingMessages),
		};
	},

	buildResumeCommand(ctx: ResumeContext): SpawnCommand {
		const argv = buildPiArgv(ctx.frontmatter, { extensions: true });
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

	encodeInboxMessage: piRuntime.encodeInboxMessage,
	encodeSteeringMessage: piRuntime.encodeSteeringMessage,

	async prepareWorkspace(ctx: PrepareContext): Promise<void> {
		await piRuntime.prepareWorkspace?.(ctx);
	},

	async extractMetadata(ctx: ExtractMetadataContext): Promise<Record<string, unknown> | undefined> {
		return piRuntime.extractMetadata?.(ctx);
	},

	/**
	 * Defined-but-always-false: opts the runtime into the dispatcher's
	 * stdin-hold path (mx-d7a551 — the dispatcher gates holdStdin on the
	 * predicate being defined at all) without ever signalling close from
	 * a parsed event. Pi-chat runs stay `running` past `agent_end` so the
	 * mid-run steering loop drives subsequent operator turns through the
	 * still-open stdin. The dispatcher tears the run down externally when
	 * the operator stops it.
	 */
	shouldCloseStdinOnEvent(_event: RuntimeEvent): boolean {
		return false;
	},

	/**
	 * Decline every `extension_ui_request` with `cancelled:true`. V1
	 * allowlist (`confirmed:true`) is out of scope — see file-level
	 * comment. The dispatcher writes the returned stdin verbatim to the
	 * still-open child stdin via `SpawnResult.writeStdin`.
	 */
	autoRespondToEvent(event: RuntimeEvent): { stdin: string } | undefined {
		if (!isExtensionUiRequest(event)) return undefined;
		return { stdin: encodeExtensionUiDecline(event.payload) };
	},

	async installCheck(): Promise<InstallCheckResult> {
		return piRuntime.installCheck();
	},
};

function readSessionId(metadata: unknown): string | undefined {
	if (metadata === null || typeof metadata !== "object") return undefined;
	const v = (metadata as Record<string, unknown>).session_id;
	return typeof v === "string" && v.length > 0 ? v : undefined;
}
