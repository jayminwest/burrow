# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/jayminwest/burrow/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/jayminwest/burrow/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jayminwest/burrow/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jayminwest/burrow/releases/tag/v0.1.0
