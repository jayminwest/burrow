# pi RPC golden traces

Real `pi --mode rpc` stdout captures used by the pi parser unit tests
(`burrow-d949`) and the RPC handshake compatibility test (`burrow-988b`).
Source seed: `burrow-01f7`.

## Pinned environment

- pi version: **0.74.0** (from `pi --version`)
- Provider: `anthropic`
- Model: `claude-haiku-4-5`
- Auth: explicit `--api-key $ANTHROPIC_API_KEY` (see "Auth precedence" below)
- pi flags applied to every capture:
  `--mode rpc --no-session --no-extensions --provider anthropic`

## Fixtures

| File | Tools? | Turns | Covers |
|------|--------|-------|--------|
| `pi-v0.74.0-anthropic-success.jsonl` | `--no-tools` | 1 | response · agent_start · turn_start · message_start/end (user) · message_start · message_update (thinking_start/delta/end, text_start/delta/end) · message_end · turn_end · agent_end |
| `pi-v0.74.0-anthropic-tools.jsonl`   | `--tools ls,read` | 2 | All of the above plus message_update (toolcall_start/delta/end) · tool_execution_start · tool_execution_end · message_start/end (role=`toolResult`) |

Event types **not** present in either fixture (rare/exceptional events the
parser must still handle): `queue_update`, `compaction_start`,
`compaction_end`, `auto_retry_start`, `auto_retry_end`, `extension_error`,
`extension_ui_request`. The parser unit tests (`burrow-d949`) exercise these
with hand-crafted envelopes derived from pi's RPC spec — same pattern as
`jsonl-claude.test.ts`.

## Observed wire-shape facts

1. **RPC framing** — Each line is a single JSON object terminated by `\n`.
   No length prefix. No comment lines. Empty lines do not appear in
   either capture.
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

## Critical dispatcher invariant (deviation from claude-code)

**pi exits the instant stdin closes**, even mid-inference. A naive
"write prompt blob then close stdin" (the claude-code pattern in
`src/runner/dispatch.ts:114-148`) produces a five-line trace and an
exit code 0 with no assistant content. To get a complete run the
dispatcher must hold stdin open until `agent_end` arrives on stdout
(or write a `{"type":"exit"}` RPC command, if pi defines one — see
follow-up).

This contradicts plan `pl-5198` risk #9, which assumed parity with
claude-code's "stdin-close finishes inference" semantics. Step 3
(`burrow-4a3b`, build `src/runtime/pi.ts`) must wire the stdin-hold
contract explicitly. Both fixtures here were captured with
`(echo '<prompt>'; sleep 30) | pi …` for exactly this reason.

## Auth precedence (also a runtime hazard)

On a host with `~/.pi/agent/auth.json` populated (i.e. the user has
run `pi /login`), pi prefers the stored OAuth token over the
`ANTHROPIC_API_KEY` env var. Only an explicit `--api-key <value>` argv
flag overrides the OAuth path. Plan note: inside the burrow sandbox
`~/.pi` is not bind-mounted, so the env-var path will win there by
default; in host-mode dev, this is a footgun worth documenting in
the runtime's prepare/install check.

## Regenerating

Both fixtures were produced with the commands below in a scratch
directory (`/tmp/pi-fixture-test`). `ANTHROPIC_API_KEY` must be set
to a billed API key, not a Pro/Plus OAuth token. The `sleep 30`
holds stdin open so pi can finish inference before EOF (see above).

```bash
# Success-path (no tools)
(echo '{"type":"prompt","message":"Reply with exactly the single word: ack."}'; sleep 30) \
  | pi --mode rpc --no-session --no-extensions \
       --provider anthropic --model claude-haiku-4-5 --no-tools \
       --api-key "$ANTHROPIC_API_KEY" \
  > pi-v0.74.0-anthropic-success.jsonl

# Tool-using (two turns: ls call + final text)
mkdir -p ws && echo alpha > ws/a.txt && echo beta > ws/b.txt && cd ws
(echo '{"type":"prompt","message":"List the files in the current directory using the ls tool, then reply with exactly the JSON: {\"done\":true} and stop."}'; sleep 60) \
  | pi --mode rpc --no-session --no-extensions \
       --provider anthropic --model claude-haiku-4-5 --tools ls,read \
       --api-key "$ANTHROPIC_API_KEY" \
  > pi-v0.74.0-anthropic-tools.jsonl
```

Volatile fields (`timestamp`, `responseId`, `request_id`, `thinkingSignature`,
`toolCallId`) will differ between captures. The handshake test
(`burrow-988b`) canonicalizes these before comparing — the fixture
bytes themselves are not byte-stable across regenerations.
