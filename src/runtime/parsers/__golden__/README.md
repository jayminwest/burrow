# pi RPC golden traces

Real `pi --mode rpc` stdout captures used by the pi parser unit tests
(`burrow-d949`) and the RPC handshake compatibility test (`burrow-988b`).
Source seed: `burrow-01f7`. Refreshed for pi v0.77.0 in `burrow-f395`.

## Pinned environment

- pi version: **0.77.0** (from `pi --version`; pinned in `.devcontainer/Dockerfile`)
- Provider: `anthropic`
- Model: `claude-haiku-4-5`
- Auth: explicit `--api-key $ANTHROPIC_API_KEY` (see "Auth precedence" below)
- pi flags applied to every capture:
  `--mode rpc --no-session --provider anthropic`
  (note: `--no-extensions` is **not** applied — these fixtures cover the
  extensions-enabled wire shape, mirroring how the `pi-chat` runtime
  spawns pi at runtime; the plain `pi` runtime still passes
  `--no-extensions`)

## Fixtures

| File | Tools? | Extra flags | Covers |
|------|--------|-------------|--------|
| `pi-v0.77.0-anthropic-success.jsonl` | `--no-tools` | — | response · agent_start · turn_start · message_start/end (user) · message_start · message_update (thinking_start/delta/end, text_start/delta/end) · message_end · turn_end · agent_end |
| `pi-v0.77.0-anthropic-tools.jsonl`   | `--tools ls,read` | — | All of the above plus message_update (toolcall_start/delta/end) · tool_execution_start · tool_execution_update · tool_execution_end · message_start/end (role=`toolResult`) |
| `pi-v0.77.0-anthropic-extension-ui.jsonl` | `--no-tools` | `--extension ./confirm-ext.mjs` | Same as the success fixture **plus** a real `extension_ui_request` envelope (method=`confirm`) emitted during `agent_start`. The host (burrow's `pi-chat` runtime) auto-declines via the `autoRespondToEvent` hook — pi treats the cancellation as no-op and the run completes normally. |

Event types **not** present in any fixture (rare/exceptional events the
parser must still handle): `queue_update`, `compaction_start`,
`compaction_end`, `auto_retry_start`, `auto_retry_end`, `extension_error`.
The parser unit tests (`burrow-d949`) exercise these with hand-crafted
envelopes derived from pi's RPC spec — same pattern as
`jsonl-claude.test.ts`.

## v0.77.0 vocabulary deltas vs v0.74.0

1. **New: `tool_execution_update`** — pi 0.77 streams incremental tool
   execution progress (e.g. partial stdout from long-running tools) between
   `tool_execution_start` and `tool_execution_end`. The parser collapses
   it to `telemetry` on `system` (same posture as `message_update`).
   Visible in `pi-v0.77.0-anthropic-tools.jsonl`.
2. **`extension_ui_request.id`** — when extensions are loaded, pi emits
   a dialog request envelope whose `id` is a freshly-generated UUID per
   request. The handshake test scrubs this `id` (alongside the existing
   `toolCallId` scrub) so the canonical fixture stays byte-stable across
   regenerations.

No other envelope shape changes were observed.

## Observed wire-shape facts

1. **RPC framing** — Each line is a single JSON object terminated by `\n`.
   No length prefix. No comment lines. Empty lines do not appear in
   any capture.
2. **First event is always** `{"type":"response","command":"prompt","success":true}`
   — pi's acknowledgement of the inbound RPC command. Burrow's parser
   maps this to `state_change` on the `system` stream.
3. **Assistant content is delta-streamed** via `message_update` envelopes
   whose `assistantMessageEvent.type` is one of
   `thinking_start | thinking_delta | thinking_end | text_start | text_delta | text_end | toolcall_start | toolcall_delta | toolcall_end`.
   The terminal `message_end` envelope carries the fully assembled
   `content[]` array (a superset of what the per-update events carry), so
   the parser can rely on `message_end` alone for canonical block content
   and treat `message_update` as best-effort streaming telemetry.
4. **Tool results are messages, not content blocks.** Unlike claude-code
   (which wraps tool results as `{type:"tool_result"}` inside a `user`
   message's `content[]`), pi emits a dedicated `message_start` /
   `message_end` pair with `message.role === "toolResult"` after each
   `tool_execution_end`.
5. **stopReason on errors** — When the provider returns a 4xx, pi still
   emits the full `message_start` → `message_end` → `turn_end` →
   `agent_end` envelope chain, with `stopReason:"error"` and a string
   `errorMessage` field carrying the upstream error body. The assistant
   `content[]` array is empty in that case.
6. **`extension_ui_request` carries a UUID `id`** — the host must echo it
   back in an `extension_ui_response` envelope written to pi's stdin.
   Burrow's `pi-chat` runtime auto-declines via
   `{type:"extension_ui_response", id, cancelled:true}\n` (the v1
   allowlist; `confirmed:true` is out of scope per `burrow-f375`).

## Critical dispatcher invariant (deviation from claude-code)

**pi exits the instant stdin closes**, even mid-inference. A naive
"write prompt blob then close stdin" (the claude-code pattern in
`src/runner/dispatch.ts:114-148`) produces a five-line trace and an
exit code 0 with no assistant content. To get a complete run the
dispatcher must hold stdin open until `agent_end` arrives on stdout.
The plain `pi` runtime closes stdin on `agent_end`; the `pi-chat`
runtime keeps stdin open so the §13.5 steering loop drives operator
turns. Both fixtures here were captured with
`(echo '<prompt>'; sleep <N>) | pi …` for exactly this reason.

## Auth precedence (also a runtime hazard)

On a host with `~/.pi/agent/auth.json` populated (i.e. the user has
run `pi /login`), pi prefers the stored OAuth token over the
`ANTHROPIC_API_KEY` env var. Only an explicit `--api-key <value>` argv
flag overrides the OAuth path. Plan note: inside the burrow sandbox
`~/.pi` is not bind-mounted, so the env-var path will win there by
default; in host-mode dev, this is a footgun worth documenting in
the runtime's prepare/install check.

## Regenerating

All three fixtures are produced with the commands below in a scratch
directory (`/tmp/pi-fixture-test`). `ANTHROPIC_API_KEY` must be set
to a billed API key, not a Pro/Plus OAuth token. The `sleep N` holds
stdin open so pi can finish inference before EOF (see above).

```bash
mkdir -p /tmp/pi-fixture-test && cd /tmp/pi-fixture-test

# Success-path (no tools), extensions enabled
(echo '{"type":"prompt","message":"Reply with exactly the single word: ack."}'; sleep 45) \
  | pi --mode rpc --no-session \
       --provider anthropic --model claude-haiku-4-5 --no-tools \
       --api-key "$ANTHROPIC_API_KEY" \
  > pi-v0.77.0-anthropic-success.jsonl

# Tool-using (two turns: ls call + final text), extensions enabled
mkdir -p ws && echo alpha > ws/a.txt && echo beta > ws/b.txt && cd ws
(echo '{"type":"prompt","message":"List the files in the current directory using the ls tool, then reply with exactly the JSON: {\"done\":true} and stop."}'; sleep 75) \
  | pi --mode rpc --no-session \
       --provider anthropic --model claude-haiku-4-5 --tools ls,read \
       --api-key "$ANTHROPIC_API_KEY" \
  > ../pi-v0.77.0-anthropic-tools.jsonl
cd ..

# extension_ui_request capture — drop a one-shot extension that fires
# a confirm dialog during agent_start, then run the success-path again.
cat > confirm-ext.mjs <<'EOF'
export default function (pi) {
  let fired = false;
  pi.on("agent_start", async (_event, ctx) => {
    if (fired) return;
    fired = true;
    try {
      await ctx.ui.confirm("burrow-fixture", "approve this fixture run?", {
        timeout: 1500,
      });
    } catch {}
  });
}
EOF

(echo '{"type":"prompt","message":"Reply with exactly the single word: ack."}'; sleep 30) \
  | pi --mode rpc --no-session \
       --provider anthropic --model claude-haiku-4-5 --no-tools \
       --extension ./confirm-ext.mjs \
       --api-key "$ANTHROPIC_API_KEY" \
  > pi-v0.77.0-anthropic-extension-ui.jsonl
```

Then move the three `.jsonl` files into
`src/runtime/parsers/__golden__/` and refresh the canonical goldens:

```bash
BURROW_UPDATE_PI_GOLDEN=1 bun test src/runtime/parsers/pi-handshake.test.ts
```

Volatile fields (`timestamp`, `responseId`, `request_id`,
`thinkingSignature`, `toolCallId`, and the `id` field inside
`type:"toolCall"` content blocks and `type:"extension_ui_request"`
envelopes) will differ between captures. The handshake test
(`burrow-988b`) canonicalizes these before comparing — the fixture
bytes themselves are not byte-stable across regenerations.
