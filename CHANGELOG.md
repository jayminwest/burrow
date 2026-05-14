# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-05-14

Ships R-08 — the sandbox-side substrate for warren's per-run preview
environments (`warren-83dc` / `pl-2c59`). `SandboxProfile` gains
`inboundPortForwards` so a burrow can declare host→sandbox loopback
forwards at provision time, and a new `/burrows/:id/sidecars` HTTP
namespace lets warren (or any external orchestrator) spawn long-lived
non-agent processes — `bun run dev`, `vite preview`, a Postgres — inside
the burrow's existing sandbox profile, separately from agent runs.

### Added

- **`feat(sandbox)`** — `SandboxProfile.inboundPortForwards?: [{hostPort,
  sandboxPort}]` (`src/provider/types.ts`) declares per-burrow loopback
  forwards. Linux implements them via a per-connection forwarder using
  `nsenter --net=/proc/<pid>/ns/net -- nc`
  (`src/provider/local/inbound-forward.ts`); macOS is a no-op
  (`host_port_bound: false`) since `sandbox-exec` doesn't ship a network
  namespace. (`R-08`, `burrow-8647`)
- **`feat(server)`** — `/burrows/:id/sidecars` HTTP namespace spawns
  long-lived non-agent processes inside the burrow's sandbox profile:
  `POST/GET /burrows/:id/sidecars`,
  `GET/DELETE /burrows/:id/sidecars/:sidecarId`,
  `GET /burrows/:id/sidecars/:sidecarId/logs`. Backed by an in-memory
  `SidecarRegistry` (`src/server/sidecars.ts`) with a default per-burrow
  cap of 4 (override via `BURROW_SIDECAR_CAP`); over-cap creates return
  `409 sidecar_cap_exceeded`. OpenAPI golden updated. `burrow serve`
  wires a registry by default; library-mode embeds opt out and sidecar
  routes 404 with the `sidecars are not enabled` hint. (`R-08`,
  `burrow-8647`)
- **`feat(client)`** — `HttpClient.sidecars` namespace mirrors the wire
  surface; errors rehydrate as `NotFoundError` / `ValidationError` /
  `HttpClientError(sidecar_cap_exceeded)` so consumers can `instanceof`-
  check across transports. (`burrow-8647`)

### Changed

- **`DELETE /burrows/:id` cascades sidecar teardown.** The handler now
  funnels through `SidecarRegistry.cascadeDeleteBurrow` before the row
  is marked destroyed, enforcing the SPEC §8.7 cleanup invariant that
  no sidecar can outlive its parent burrow. (`burrow-8647`)
- **`docs(claude)`** — Refreshed Mulch onboarding section in CLAUDE.md
  to v0.10.0 (manifest prime mode, soft archive workflow).
- **`docs(changelog)`** — Split prior 0.3.0 roadmap entries to align
  with the underlying commit history (`burrow-a581`).

## [0.3.0] - 2026-05-13

Lands the burrow-side substrate for remote workers (plan `pl-cb3e`,
parent `burrow-62ce`) — the capability that lets an external warren
dispatch runs against a burrow on another host. `burrow serve` is now
formally a multi-host executor: `--bind-host` opens it to a non-loopback
interface (with a `--no-auth` guard against accidental open exposure),
`POST /admin/drain` quiesces a worker for rolling deploys, and
`GET /burrows/:id/files` exposes the workspace tree so warren can render
PR-like diffs without shelling into the host. Multi-worker topology,
TLS-at-reverse-proxy, and bind-host posture are now documented end-to-end
in DEPLOY.md and the OpenAPI spec, and SPEC §27 / ROADMAP R-02 are
cross-linked to the canonical multi-worker design.

### Added

- **`feat(serve)`** — `--bind-host <host>` flag on `burrow serve` (default
  `127.0.0.1`, preserving the current localhost-only posture). Non-loopback
  hosts are rejected at startup when `--no-auth` is also set, so an
  unauthenticated burrow can never accidentally listen on a public
  interface (`burrow-b160`, `pl-cb3e` step 2).
- **`feat(serve)`** — `POST /admin/drain` admin endpoint. While drained,
  the server returns 503 on new burrow and run creation but keeps
  serving reads, stream tails, and steering on existing runs so workers
  can finish in-flight work during a rolling deploy. Drain is process-
  local state (no DB row) and resets on restart (`burrow-79ad`,
  `pl-cb3e` step 4).
- **`feat(server)`** — `GET /burrows/:id/files` returns a listing of the
  workspace tree (path + size + mtime, gitignore-aware) so warren can
  render workspace diffs / file previews against a remote burrow without
  shelling into the worker host (`burrow-18ca`).

### Changed

- **`docs(deploy)`** — DEPLOY.md gains a multi-worker topology section
  (warren ↔ N burrow workers behind a reverse proxy) plus a TLS-at-
  reverse-proxy recipe documenting the recommended bearer-token-over-TLS
  posture (`burrow-f676`, `pl-cb3e` step 3).
- **`docs(openapi)`** — OpenAPI spec documents `POST /admin/drain` and
  carries a bind-host posture note alongside the existing auth section,
  so generated client docs reflect the multi-worker contract
  (`burrow-37c3`, `pl-cb3e` step 5).
- **`docs(roadmap+spec)`** — ROADMAP R-02 (FlyProvider + SshProvider) is
  marked superseded by `burrow-62ce`; SPEC §27 (multi-host) cross-links
  to the canonical multi-worker design in `pl-cb3e` (`burrow-d380`,
  `pl-cb3e` step 6).
- **`docs(roadmap)`** — ROADMAP R-07 marked shipped on the burrow side
  (workspace-seed HTTP API via `pl-2467`); R-06 reframed as mycelium's
  folding into warren + overstory's hierarchy direction is under
  reconsideration.

### Tests

- **`test(serve)`** — Cross-process e2e test for `burrow serve`'s
  in-process dispatcher: a sibling Bun subprocess drives the server
  over HTTP and asserts the run lifecycle end-to-end, locking the
  contract that the warren executor depends on (`burrow-e2bc`,
  `pl-cb3e` step 1).

## [0.2.12] - 2026-05-13

### Fixed

- **`encodePiStdin` / `encodeInboxMessage` terminate every RPC envelope
  with `\n` (`burrow-faf5`).** Pi's `--mode rpc` is line-delimited: it
  buffers stdin and only fires a parsed command on `\n`. The previous
  `lines.join("\n")` left the single-prompt case (every fresh run with
  no steering messages) one byte short, so after `burrow-029d`'s flush
  fix delivered the bytes, pi still parked in `epoll_pwait2` waiting
  for the terminator — initialized far enough to scaffold
  `.pi/agent/auth.json` and spin libuv workers, but never reached
  inference. `encodeSteeringMessage` already appended `\n` per envelope;
  this mirrors that convention everywhere (`lines.map(l => l + "\n").join("")`).

## [0.2.11] - 2026-05-13

### Fixed

- **`writeStringStdin` flushes stdin when `holdStdin=true` (`burrow-029d`).**
  The `holdStdin=true` branch only called `sink.write()`; the else
  branch's `sink.end()` (which flushes-and-closes) never ran, so
  bytes stayed buffered in bun userland and never reached the kernel
  pipe. `pi` (and any future stdin-hold runtime) hung forever on its
  initial read because burrow had the write fd open and connected but
  zero bytes had been written through. Now flushes explicitly with
  `sink.flush()` before returning, matching the discipline
  `makeWriteStdin` already follows for mid-run steering.

## [0.2.10] - 2026-05-13

### Fixed

- **piRuntime spawn latency: pin `--offline` to skip pi's startup
  network operations (`burrow-029d`).** Inside bwrap (warren docker
  image) pi v0.74.0 sat in `ep_poll` for 2+ minutes after spawn before
  emitting its first RPC event, because pi's startup telemetry /
  update-check calls block the RPC read loop. `PI_FORCED_ARGV` now
  includes `--offline` (equivalent to `PI_OFFLINE=1`) — burrow runs are
  headless and don't surface those banners anyway, so disabling is pure
  latency win.

## [0.2.9] - 2026-05-13

### Added

- **Pi V1 resume via `--session-dir` + `extractMetadata` hook
  (`burrow-4d8b`, SPEC §12.1/§12.2).** `pi` v0.74.0 doesn't surface
  `session_id` on `agent_end`; the only stable per-run source is the
  `--session-dir` filesystem layout (`<ts>_<uuid>.jsonl` whose first
  line is `{type:"session", id:"<uuid>"}`). `PI_FORCED_ARGV` now swaps
  `--no-session` for `--session-dir .pi/sessions` (relative path,
  resolved against the agent cwd so it works under both bwrap and
  sandbox-exec); `prepareWorkspace` creates the dir under the
  workspace. New optional `AgentRuntime.extractMetadata(ctx)` hook
  runs after a clean exit; the dispatcher merges the returned object
  into `Run.metadataJson` via `RunsRepo.patchMetadata` (failures are
  swallowed — extraction is advisory). `piRuntime.extractMetadata`
  reads the newest `*.jsonl` in the per-burrow session dir and
  persists `session_id`; `piRuntime.buildResumeCommand` passes
  `--session <id>` (alongside the pinned `--session-dir`) when the
  prior run carries one, falling back to a fresh argv otherwise.
  `supportsResume` flips to `true` for `pi`.
- **Mid-run steering for stdin-held runtimes (`burrow-250d`,
  SPEC §13.5).** Runtimes that keep a live stdin RPC channel for the
  duration of a turn — today that's `pi` via `--mode rpc`, which
  already opted into the stdin-hold contract under `burrow-5db3` — can
  now have inbox messages delivered *during* a run instead of queueing
  for the next spawn. Two AgentRuntime hooks govern this:
  `shouldCloseStdinOnEvent(event)` (required prerequisite, established
  by `burrow-5db3`) and the new
  `encodeSteeringMessage(message): { stdin } | undefined`. While both
  are present and `SpawnResult.writeStdin` is available, the dispatcher
  runs a 200 ms poll loop alongside `consumeStdout` that claims each
  newly-arrived `unread` message, writes the encoded bytes to the
  still-open child stdin, marks the row `delivered`, and appends an
  `inbox_delivered` system event (`{messageId, priority,
  mode:"mid_run"}`) so observers can correlate. A write failure leaves
  the row `unread` for the next tick or the next spawn — same
  recovery posture as the §10.2 sweep. `pi` maps each message to its
  existing `{"type":"prompt","message":"[STEERING] (priority: P)
  <body>"}\n` shape; runtimes that close stdin at spawn time
  (claude-code `--print`, sapling `--prompt`) leave the hook unset and
  keep their §13.2/§13.3 next-spawn semantics. New
  `SpawnResult.writeStdin?(chunk)` surfaces the still-open sink to the
  dispatcher; the bwrap and sandbox-exec wrappers both supply it via
  `Bun.Subprocess.stdin.flush()` so writes are sequenced against the
  child's buffer.
- **`frontmatter.provider`/`model` overrides flow into `piRuntime`
  argv (`burrow-b5b4`).** `SpawnContext` gains an optional
  `frontmatter: { provider?, model? }` field that the dispatcher
  hydrates from `Run.metadataJson.frontmatter` — the channel warren
  (and any other upstream caller) uses to push resolved operator
  overrides + project defaults + agent frontmatter through to a
  built-in runtime. `piRuntime`'s new `buildPiArgv` substitutes the
  override provider into the trailing `PI_DEFAULT_PROVIDER` slot of
  `PI_FORCED_ARGV` and replaces `PI_DEFAULT_MODEL` with the override
  model; empty/whitespace values fall back to today's pinned defaults.
  `envPassthrough` stays narrow (anthropic trio only) — non-anthropic
  keys still opt in via `burrow.toml [env]` per `mx-d46d5d`.

### Fixed

- **Hold stdin open until `agent_end` for `pi` runtime (`burrow-5db3`).**
  `pi` v0.74.0 exits the instant stdin closes (`mx-d9b3ad`), so the
  prior write-and-end-at-spawn dispatcher truncated real `pi` runs to
  `response` + `agent_start` + `turn_start` with no assistant content.
  New opt-in stdin-hold contract: `SpawnCommand.holdStdin` /
  `SpawnResult.closeStdin` plumb the lifetime through `runSandboxed` so
  callers own the close; `AgentRuntime.shouldCloseStdinOnEvent(event)`
  is the per-runtime hook the dispatcher polls per persisted event
  (`pi` matches `agent_end`); `dispatch.ts` wires both, with a
  defensive close in `finally` so a child that never emits its trigger
  doesn't leak the FD. Unblocks `burrow-56bb` (the dispatcher e2e test
  would otherwise observe truncated traces).

## [0.2.8] - 2026-05-13

### Added

- **Built-in `pi` runtime — fourth headless coding agent
  (`burrow-8aff`, plan `pl-5198`).** Burrow now ships a built-in `pi`
  runtime (`@earendil-works/pi-coding-agent` pinned at `v0.74.0`)
  alongside `claude-code`, `sapling`, and `codex`.
  `BUILT_IN_RUNTIMES` (`src/runtime/registry.ts`) now has four entries
  and `AGENT_ALIASES` (`src/runtime/aliases.ts`) carries the `pi`
  identity. The forced argv prefix is locked at `pi --mode rpc
  --no-session --no-extensions --provider anthropic` with
  `--model claude-haiku-4-5` appended (pinned to the model the parser's
  golden RPC fixtures were captured against): `--mode rpc` flips pi to
  its JSONL command/event protocol; `--no-session` keeps V1 one-shot
  (`supportsResume:false`); `--no-extensions` blocks pi's
  `extension_ui_request` RPC dialog (the dispatcher has no path to
  answer mid-stream UI requests, so an auto-discovered extension would
  hang the run); `--provider anthropic` overrides pi's Gemini CLI
  default so the `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
  `ANTHROPIC_BASE_URL` envPassthrough contract actually authenticates.
  Per-run wire payload is a single
  `{"type":"prompt","message":"<prompt + steering prefix>"}` line on
  stdin; steering messages render as the existing `[STEERING]
  (priority: P) <body>` prefix (parity with sapling/codex). The new
  parser at `src/runtime/parsers/pi.ts` collapses pi's wider RPC
  vocabulary (`agent_*`, `turn_*`, `message_start`/`update`/`end`,
  `tool_execution_*`, `queue_update`, `compaction_*`, `auto_retry_*`,
  `extension_error`, `extension_ui_request`, `response` acks) into the
  SPEC §14.1 stable kinds (`text`, `thinking`, `tool_use`,
  `tool_result`, `telemetry`, `state_change`) with the full original
  envelope preserved in `payload` — see the new SPEC §14.1 footnote for
  the full collapse map. The devcontainer image bakes pi at the pinned
  version via `bun install -g @earendil-works/pi-coding-agent@0.74.0`
  (`.devcontainer/Dockerfile`). A golden RPC-handshake compatibility
  test (`src/runtime/parsers/pi-handshake.test.ts`) locks the canonical
  argv + per-event collapse against checked-in fixtures so a silent
  upstream wire-shape drift fails CI. Resume parity, mid-run steering,
  and event-kind promotion (e.g. `compaction` as a first-class kind)
  are tracked as follow-up seeds; the dispatcher's stdin-close-on-end
  semantics (which currently end pi before assistant content streams)
  are tracked separately under `burrow-5db3`.

## [0.2.7] - 2026-05-09

### Fixed

- **Bind host gitdir into sandbox so worktree-backed workspaces can run
  git (`burrow-7a80`).** `git worktree add` writes the worktree's `.git`
  *file* with an absolute `gitdir:` pointer at
  `<hostClone>/.git/worktrees/<id>`, which the `/workspace` bind didn't
  cover. Inside the sandbox every git invocation failed with
  `fatal: not a git repository` — the agent couldn't commit or push its
  own work. New `SandboxProfile.workspaceGitdir` plumbs through from
  `MaterializedWorkspace` `Source.gitCommonDir` (set for
  `kind: 'worktree'` via `discoverHostClone` /
  `discoverGitCommonDir`, canonicalized through `realpath`); bwrap
  binds it read-write at the same host path and seatbelt allows
  read+write subpath. Both `up` and `fork` lift the value onto the
  profile; `fork` drops any inherited value when the new workspace is
  clone-backed.

## [0.2.6] - 2026-05-09

### Fixed

- **Default-allow `ANTHROPIC_*` env vars without project `burrow.toml [env]`
  (`burrow-e9e7`).** A fresh project clone with no `burrow.toml` started
  `claude-code` inside the sandbox with an empty env block, so
  `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` /
  `CLAUDE_CODE_OAUTH_TOKEN` set on the burrow process never reached the
  agent — the CLI then errored on first call. New optional
  `AgentRuntime.envPassthrough` lets a built-in runtime declare the host
  env names its CLI consults at startup; `runUpCommand` unions every
  effective agent's `envPassthrough` (skipping agents with
  `forwardCredentials = false`) onto `SandboxProfile.envPassthrough`, so
  the runtime's intrinsic env contract no longer requires a per-project
  `[env]` block. `claude-code` declares the four names above. Per-project
  keys (`DATABASE_URL` etc.) still belong in `burrow.toml [env]`.

## [0.2.5] - 2026-05-09

### Fixed

- **Linux sandbox env now travels via the bwrap process env, not argv
  (`burrow-ab95`).** `buildBwrapArgv` previously rendered
  `--clearenv` + `--setenv NAME VALUE` for every var, putting secrets
  like `ANTHROPIC_API_KEY` on the bwrap argv — world-readable via
  `/proc/<bwrap-pid>/cmdline`, so any in-sandbox process or any host
  tool that captures cmdline (`ps`, `top`, observability agents) could
  read the user's provider key. This actually leaked an Anthropic key
  into a Claude Code transcript during dogfooding. `spawnLinux` now
  resolves env via `resolveSandboxEnv` and passes it to `Bun.spawn`'s
  `env` option, so bwrap's process env IS the resolved env; the
  child's env now lives in `/proc/<pid>/environ` (mode 400, private to
  the running uid) instead of `/proc/<pid>/cmdline`. macOS `spawnDarwin`
  already used this channel via `sandbox-exec` — Linux is now symmetric.
  `buildBwrapArgv` no longer takes `hostEnv`; regression test asserts
  argv contains neither `--setenv` nor any secret value. SPEC §8.1
  updated to document the env channel.

### Changed

- **`ROADMAP.md` — R-02 (FlyProvider + SshProvider) flipped to
  `[deferred]`.** Original framing claimed warren-on-Fly required a
  remote-daemon model; misread of warren SPEC §10.2 + §3.2 — warren and
  burrow are co-located in one container over a unix socket, identical
  on home server and Fly. SPEC §23 seam-validation argument stands alone
  but lacks a concrete consumer right now. Sequencing reshuffled (R-06
  no longer waits on R-02, R-07 stands on warren-cleanup merits alone).
  Revisit when warren V2 worker pool, greenhouse remote dispatch, or
  laptop `burrow up --remote` actually pulls on the seam.

## [0.2.4] - 2026-05-09

### Added

- **Workspace seed + files HTTP API (R-07, `burrow-30c7`).** `POST
  /burrows` accepts an optional `seed: { files: WorkspaceFile[] }`
  that's written atomically with provisioning — a failed write rolls
  back the burrow. New `POST /burrows/:id/files` and
  `GET /burrows/:id/files` close the warren↔burrow seam-violation by
  letting orchestrators write/read workspace files over HTTP instead
  of touching disk directly. Both routes share a single writer (opens
  with `O_NOFOLLOW`) and reader, gated by
  `resolveWorkspaceFilePath`. Closes plan `pl-2467`.
- **`HttpFilesClient` namespace + `seed.files` on
  `HttpBurrowUpInput` (`burrow-ba5c`).** `HttpClient.files` mirrors
  `POST/GET /burrows/:id/files` for post-provision writes and reaping;
  `up()` forwards `seed.files` on the create call. Wire shape and
  errors round-trip — path-validation rejections rehydrate to
  `ValidationError`, missing files to `NotFoundError`. The serialize
  helper is shared between create-with-seed and `files.write` so both
  paths emit identical payloads.
- **`resolveWorkspaceFilePath` primitive
  (`src/server/workspace-paths.ts`, `burrow-9dbd`).** Returns a
  canonical path inside the realpath'd workspace root or throws
  `ValidationError`. Rejects empty/NUL paths, absolute paths, `..`
  segments, the `.git` / `.gitconfig.burrow` reserved entries (and
  any descendant), and any path whose segment-by-segment walk crosses
  a symlink whose target escapes the workspace. Symlinks are followed
  manually via `readlink` so dangling escape symlinks don't slip past
  `fs.realpath`'s `ENOENT`; depth capped at 40. Handlers still apply
  `O_NOFOLLOW` on actual writes to close the TOCTOU window.
- **OpenAPI surface for workspace-seed HTTP API (`burrow-da98`).**
  `WorkspaceFile`, `WriteFilesBody`, `WriteFilesResponse` schemas and
  the `writeFiles` + `readFile` operations on `/burrows/{id}/files`,
  plus the optional `seed` payload on `POST /burrows`. Lets warren and
  any future external consumer codegen typed clients against the new
  surface.

### Fixed

- **`Bun.serve` `idleTimeout: 0` so NDJSON streams survive quiet
  stretches (`burrow-3d45`).** Bun's 10s default force-closed
  long-lived streaming routes (`/runs/:id/stream`,
  `/burrows/:id/events`, `/watch`) during agent silence, killing
  warren's `bridgeRunStream` with `ECONNRESET`. `bindTcp` and
  `bindUnix` now disable the idle timeout.
- **Idempotent tag + GitHub-release steps in publish workflow.** The
  v0.2.3 publish run failed at "Tag release" because the tag had been
  created manually before the workflow ran, even though `npm publish`
  had already succeeded; the non-zero exit prevented "Create GitHub
  release" from running. Both steps now check
  `git rev-parse --verify` / `git ls-remote --exit-code --tags` /
  `gh release view` before acting and no-op cleanly when the artifact
  already exists. Future manually-tagged releases or workflow re-runs
  won't fail the job.

## [0.2.3] - 2026-05-09

### Fixed

- **bwrap argv now forces `--uid`/`--gid` on the sandboxed pid 1
  (`burrow-0329`).** Without these, `--unshare-all`'s new userns
  inherits the caller's uid mapping; on a root-running host (e.g.
  warren's Dockerized posture without an explicit `USER` directive)
  the agent saw `getuid() == 0` and `claude-code --dangerously-skip-permissions`
  refused to start with `cannot be used with root/sudo privileges`.
  `buildBwrapArgv` now emits `--uid <n> --gid <n>` immediately after
  `--unshare-all`, defaulting to a non-root constant
  (`DEFAULT_SANDBOX_UID`/`_GID` = 1000). Callers that need a different
  uid (e.g. matching an image's existing user) override via
  `SandboxProfile.runAsUid` / `runAsGid`. Closes the last gate that
  was blocking warren Scenario 04 end-to-end claude-code runs.

## [0.2.2] - 2026-05-09

### Added

- **`burrow up --agents <id,…>` / `up({ agents })` (`burrow-55e3`).**
  `HttpBurrowUpInput` / `BurrowUpInput` / `UpCommandOptions` gain an
  optional `agents: readonly string[]` of runtime ids that
  `resolveEffectiveAgents()` merges with `burrow.toml` `[[agents]]`
  before the profile is built (existing config rows win on id overlap).
  The merged list feeds both `collectToolchainPaths` and
  `collectCredentialPaths`. Lets orchestrators (warren) enable a
  built-in runtime at up-time when the project clone has no
  `burrow.toml` — without it, `toolchainPaths` came back empty and
  `bwrap` failed `execvp <bin>`.
- **`DEPLOY.md` — authoritative deploy guide for `burrow serve`
  (resolves ROADMAP R-01, `burrow-9986`).** On-host (systemd /
  Fly Machine) is the production default; in-pod with the four-flag
  bwrap recipe is acceptable for self-managed / single-tenant /
  dev-CI postures, not for multi-tenant managed K8s/ECS/Cloud Run.
  Includes reference systemd unit, Fly Machine config, Caddy
  reverse-proxy snippet, and verification commands. README links it
  from the `burrow serve` section. Unblocks R-02 substrate decision:
  Fly Machines map to on-host posture, no admission-policy
  negotiation.
- **`ROADMAP.md` — forward-direction punch list (closes
  `burrow-d103`).** SPEC.md is now the frozen V1 design record;
  ROADMAP.md tracks `R-NN` items, seeded with R-01 (deploy posture,
  shipped) and R-02..R-07 (FlyProvider + SshProvider, Drizzle
  migrations, hooks, `burrow exec`, library-API consumers,
  workspace-seed HTTP API). SPEC §25's open questions are resolved in
  place. CLAUDE.md cross-references both files and routes future
  deferred decisions into ROADMAP as `R-NN` entries instead of as
  standalone informational seeds.
- **npm provenance attestation on publish.** `id-token: write`
  permission and `--provenance` on `npm publish` so the package page
  on npmjs.com shows a verified link back to the GitHub commit /
  workflow that built it. OIDC token is picked up from GHA
  automatically — no other config needed.

### Fixed

- **`burrow serve` now drives HTTP-enqueued runs (`burrow-7b97`).**
  `POST /burrows/:id/runs` previously called `repos.runs.enqueue()`
  (DB insert with `state=queued`) but `startServer` never instantiated
  a `RunLoop` or any executor, so HTTP-driven runs sat indefinitely.
  Extracted the spawn-and-event-stream body into
  `src/runner/dispatch.ts:dispatchRun` (always returns `RunOutcome`,
  never throws on infra failures) and added
  `src/runner/dispatcher.ts:startRunDispatcher` — owns a single
  `RunLoop` and wires `RunsClient.setOnCreated` so HTTP-enqueued runs
  flow into the loop the instant they're inserted. `runServeCommand`
  starts the dispatcher *before* `startServer` (recovery + hook
  installed before the first request) and stops in reverse on abort.
  `burrow prompt` now delegates to `dispatchRun` via
  `onEvent`/`onMessagesClaimed` callbacks; behavior change — spawn
  failure no longer throws, the run finalizes as failed and the CLI
  returns the result. Blocker for warren-8bc9 / -c09d / -9f65.
- **Linux CI stability (`scripts/version-bump.ts` workflow runner).**
  Four `runUpCommand` tests in `src/cli/commands/up.test.ts` were
  missing `skipDoctor: true` and hit `runDoctor()`'s
  sandbox-primitive check, which fails on Ubuntu CI because `bwrap`
  isn't installed there. The `AbortSignal` test in
  `src/ship/run.test.ts` wrapped `sleep` in `sh -c`; under dash
  (Ubuntu's `/bin/sh`) `SIGTERM` killed `sh` but orphaned `sleep`,
  keeping pipes open until it exited 5s later and blocking
  stream-drain past the test timeout. Spawned `sleep` directly to
  test the actual contract (abort kills the child) without the
  shell-fork confound.

## [0.2.1] - 2026-05-08

### Fixed

- **`DELETE /burrows/:id` now tears down workspace + branch (`burrow-a79f`).**
  Pre-fix the HTTP delete archived the row but skipped workspace
  teardown, leaking worktrees and `burrow/<id>` branches on disk. The
  per-id orchestration (stop → remove workspace → archive+prune) now
  lives in a shared `src/lib/destroy.ts:destroyBurrowFully` helper so
  `bw destroy` and `BurrowsClient.destroy` (HTTP `DELETE`) funnel
  through identical cleanup. Regression test seam:
  `BurrowsClient.setDestroyOverrides`.
- **`/watch` query-param grammar uniform with other streaming routes
  (`burrow-130a`).** `?once=` now accepts `1`/`0` in addition to
  `true`/`false` (matching the SPEC §27 doc and `?follow=` on
  `/burrows/:id/events`), and `/watch` accepts `?follow=` as the inverse
  alias of `?once=` so curl muscle memory carries across endpoints.
  Specifying both `?once` and `?follow` is now a 400. Previously
  `/watch?once=1` returned a 400 and `/watch?follow=0` was silently
  ignored — the stream ran forever.

### Added

- **`burrow serve` — HTTP API (SPEC §27).** Bun.serve thin layer over the
  existing Library API; routes mirror the `Client` namespaces 1:1
  (`POST /burrows`, `GET /burrows/:id/events?follow=1`,
  `POST /burrows/:id/runs`, `GET /runs/:id/stream`, `GET /watch`,
  …) so the in-process Library stays the source of truth. Streaming
  surfaces emit NDJSON over chunked HTTP byte-for-byte equal to the
  matching `--json` CLI output (`burrow events --json`,
  `burrow watch --json`); `events?since=<seq>&follow=1` replays then
  switches to live tail with no duplicates and no gaps. Unix socket is
  the primary transport (default `<cacheDir>/burrow.sock`); localhost TCP
  is opt-in via `--port [--host]`. Bearer auth from `BURROW_API_TOKEN`
  (redacted from logs); `--no-auth` bypasses for loopback-only use.
  SIGINT shuts down cleanly within 1s. Resolves plan `pl-5b40` (parent
  seed `burrow-1d64`); SPEC §3.2's "No HTTP API server in V1" non-goal
  is removed.
- **`POST /burrows` provisioning landed (`burrow-4767`).** Replaces
  the prior 501 stub with a real handler that calls a new
  `client.burrows.up()` wrapping `runUpCommand`; mirrored on
  `HttpClient.burrows.up`. Tests inject materializer / `skipDoctor` via
  a server-side-only `BurrowsClient.setUpOverrides` seam (not exposed
  on the wire). Unblocks warren provisioning over HTTP.
- **Run cancellation + record removal (`burrow-6739`).**
  `POST /runs/:id/cancel` is graceful + idempotent: accepts an optional
  `{reason}` body, returns the current row with 200 on already-terminal
  runs (never 4xx), and emits a `run_cancelled` event on the run's
  stream. `DELETE /runs/:id` is post-completion record removal — only
  legal on terminal runs (400 otherwise), 204 on success, cascades to
  `events.run_id` rows so the FK doesn't block the delete. Distinct
  from cancel so warren can separate "stop this run" from "purge this
  row."
- **`HttpClient` (`src/lib/http-client.ts`).** HTTP-backed mirror of
  `Client` with the same five namespaces (burrows / runs / inbox /
  events / agents) and identical method shapes. Rehydrates `Date`
  fields and the `{ error: { code, message, hint } }` envelope back
  into the matching `BurrowError` subclasses, so consumers (warren,
  future UIs) can swap transports without touching call sites or
  `instanceof` checks. Re-exported from `@os-eco/burrow-cli` alongside
  `HttpClientOptions` and the `Transport` discriminated union.
- **OpenAPI 3.1 self-description (`burrow-d3ea`).** `burrow serve` now
  exposes `GET /openapi.json` (auth-required) describing every route
  and response shape, plus an unauthenticated `GET /openapi.html`
  rendering the spec via Scalar API Reference for browser exploration.
  The document is built from a single Zod schema registry
  (`src/server/openapi/schemas.ts`) using Zod 4's native
  `z.toJSONSchema` — no extra runtime dependency. Output bytes are
  locked by a golden file (`__golden__/openapi.json`,
  mx-1785cc pattern) so any drift in the wire shape is a deliberate,
  reviewable diff. Lets warren and any future external consumer
  codegen typed clients instead of hand-rolling against the surface.

## [0.2.0] - 2026-05-08

### Added

- **`burrow watch` — TUI dashboard.** Multi-burrow live view (header / burrow
  list / detail pane / keybind footer); raw-mode keypress dispatch (q to quit,
  j/k to move, enter to focus a burrow, esc back, PgUp/PgDn for detail
  scroll); SIGWINCH-debounced redraw; clean alt-screen entry/exit on SIGINT.
  `burrow watch --json` emits NDJSON `DashboardSnapshot` envelopes — the same
  wire shape `burrow serve` will eventually WebSocket-stream — so scripts and
  CI can consume the live view today.
- **Dashboard view-model (SPEC §26).** Public `DashboardSnapshot` /
  `BurrowCard` / `RunSummary` / `EventTailEntry` types, additive-only
  versioning lock (mirrors §14.1 events), and pure builder/streamer:
  `buildSnapshot(repos, opts?)` (deterministic projection over `Repos`) and
  `streamSnapshots(repos, bus, opts?)` (event-bus driven async generator with
  trailing-edge coalescing, polling fallback for non-bus state changes, and
  leak-free teardown). Re-exported from `@os-eco/burrow-cli` alongside
  `DASHBOARD_SNAPSHOT_VERSION`, `DEFAULT_EVENT_TAIL_CAP`,
  `DEFAULT_RUNS_PER_CARD`, `DEFAULT_COALESCE_MS`, `DEFAULT_POLL_FALLBACK_MS`.
- **`[sandbox].read_only_paths` in `burrow.toml`.** Generic per-project
  read-only mount escape hatch on top of the toolchain-bin-dir symlink walk
  (burrow-a1b1).

### Fixed

- **Globally-installed bun packages reachable inside burrow.** When `bun` is
  a declared toolchain, `burrow up` now mounts `<BUN_INSTALL>/install/global/node_modules`
  in addition to `<BUN_INSTALL>/bin`. Previously, stub symlinks under
  `~/.bun/bin/` (e.g. `ml`, `sd`, `cn`, `ov`, `sapling`) were visible by
  name but their `.ts` source targets in the install root were sandbox-denied,
  manifesting as `error loading current directory` (burrow-aa46).
- **Symmetric read+write on macOS sandbox temp roots.** seatbelt profile now
  grants `file-read*` on `/private/tmp` + `/private/var/folders` alongside
  the existing `file-write*`, and explicitly permits `file-write*` on
  `/dev/null` (burrow-8452).
- **Per-burrow `TMPDIR` for `claude-code` agents.** Bash-tool output under
  `${TMPDIR}/claude-${uid}/...` now isolates per burrow instead of colliding
  on a UID-keyed shared root (burrow-8452).
- **`claude-code` runtime spawns with `--dangerously-skip-permissions`** —
  burrow's `bwrap` / `sandbox-exec` profile is the actual enforcement
  boundary, so claude-code's own permission gate is redundant noise inside
  the sandbox.

## [0.1.0] - 2026-05-07

Inaugural V1 release. Local-first, single-user OS-isolated sandbox runtime for
coding agents on Linux (`bwrap`) and macOS (`sandbox-exec`).

### Added

- **Phase 0 — scaffold.** Library entry (`src/index.ts`), CLI entry
  (`src/cli/main.ts`), `BurrowError` hierarchy with stable codes and recovery
  hints, XDG-aware paths module, pino logger factory, and a `burrow doctor`
  stub that checks for the platform's sandbox primitive.
- **Phase 1 — native sandbox wrappers.** `bwrap` (Linux) and `sandbox-exec`
  (macOS) launchers behind a single `Sandbox` interface; no Docker, no
  daemon. Network policy is one of `none | restricted | open`.
- **Phase 2 — durable state.** SQLite via `bun:sqlite` (WAL mode), Drizzle
  schema/repos for burrows, runs, events, and inbox; crash-recoverable run
  loop; atomic state transitions.
- **Phase 3 — workspace materialization.** Per-burrow git worktree with
  clone fallback when worktrees aren't usable; per-burrow branches with
  cleanup on `burrow destroy`.
- **Phase 4 — agent runtime interface + built-ins.** `AgentRuntime`
  abstraction with built-in runtimes for `claude-code`, `sapling`, and
  `codex`; declarative `AgentConfig` so new agents land via a `[[agents]]`
  stanza in `burrow.toml` with zero core code changes.
- **Phase 5 — inbox + steering.** `burrow send` queues a steering message;
  `burrow chat` provides an interactive REPL (one stdin line per message);
  atomic claim helper for next-turn delivery.
- **Phase 6 — event tail + archive.** In-memory pub/sub for live event
  streaming; `burrow logs --follow` (one burrow) and `burrow events --follow`
  (interleaved across all active burrows); NDJSON archiver writes the full
  event log to disk on `burrow destroy`.
- **Phase 7 — Client class + full CLI surface.** Public `Client`
  (`src/lib/client.ts`) with the five SPEC §15 namespaces (burrows / runs /
  inbox / events / agents); CLI wiring for `up`, `fork`, `attach`, `list`,
  `show`, `stop`, `destroy`, and `agents list/show/validate`; shared style
  helpers in `src/cli/style.ts` (status icons, TTY-aware color); exit codes
  per SPEC §16 (3 = invalid input, 2 = not found, 4 = sandbox).
- **Phase 8 — `burrow.toml` + secrets + toolchain doctor.** Zod-over-`smol-toml`
  schema covering `[project]`, `[sandbox]`, `[toolchain]`, `[env]`,
  `[secrets]`, `[git]`, `[hooks]`, and `[[agents]]`; per-project loader
  (`src/config/burrow-toml-loader.ts`); secret resolution pipeline
  (env-file store, 1Password `op://` resolver with caching, layered
  `resolveEnv` orchestrator); host toolchain checker
  (`src/toolchain/check.ts`) with prefix and `>=`/`>`/`=` operator matching;
  `burrow init` scaffolds a starter `burrow.toml` with detected toolchains;
  `burrow doctor` extended with project-scoped toolchain + 1Password CLI
  checks (`--project <root>`, `--no-project`); `burrow up` loads
  `burrow.toml`, gates on `assertDoctorOk`, and folds
  `[sandbox]`/`[env]`/`[secrets]` into the persisted `SandboxProfile`.
- **Phase 9 — `burrow ship`.** Build + deploy artifacts via the `tarball`,
  `docker`, or `fly` ShipTargets — the same shape a future `aws` target
  would land into.
- **Phase 10 — polish.** Real shell completions for bash/zsh/fish via
  `burrow completions <shell>` (registers both `burrow` and `bw` from one
  script); `burrow upgrade` prints the npm/bun upgrade hint per SPEC §16.1;
  README replaced with V1 quickstart + CLI surface; `examples/` directory
  with a claude-code quickstart and a declarative custom-agent recipe;
  recovery hints filled in for common user-facing throw sites.
- **Host credential forwarding** (SPEC §17.4).
  `AgentRuntime.credentialPaths()` declares which host paths a runtime
  needs read-only inside the sandbox to authenticate. `burrow up` collects
  them across declared `[[agents]]` and folds them into
  `SandboxProfile.readOnlyMounts`. `claude-code` reports `~/.claude` and
  `~/.claude.json`; `prepareWorkspace` mirrors `~/.claude/.credentials.json`
  into `<workspace>/.claude/` so the sandboxed agent finds it via
  `HOME/.claude/.credentials.json`. Per-agent opt-out via
  `forwardCredentials = false` in the `[[agents]]` row.
- **`bw prompt`** dispatches a registered agent against a burrow.
- **`bw init <agent>` and `bw agents add`** wire built-in runtimes into
  `burrow.toml`.

### Fixed

- `claude-code` runtime extracts credentials from the macOS Keychain when
  `~/.claude/.credentials.json` is absent.
- Per-burrow userspace HTTP/HTTPS proxy for `network=restricted` so the
  policy actually constrains agent traffic instead of leaking through.
- CLI no longer defaults `--network` to `none`; the flag is now an explicit
  override and falls back to `burrow.toml`'s `[sandbox].network`.
- `SandboxProfile.toolchainPaths` is now populated from declared toolchains
  and agents (previously empty, breaking PATH inside the sandbox).
- `burrow destroy` drops the per-burrow branch when tearing down a worktree.

[Unreleased]: https://github.com/jayminwest/burrow/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/jayminwest/burrow/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jayminwest/burrow/compare/v0.2.12...v0.3.0
[0.2.12]: https://github.com/jayminwest/burrow/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/jayminwest/burrow/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/jayminwest/burrow/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/jayminwest/burrow/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/jayminwest/burrow/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/jayminwest/burrow/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/jayminwest/burrow/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/jayminwest/burrow/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/jayminwest/burrow/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/jayminwest/burrow/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/jayminwest/burrow/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jayminwest/burrow/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jayminwest/burrow/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jayminwest/burrow/releases/tag/v0.1.0
