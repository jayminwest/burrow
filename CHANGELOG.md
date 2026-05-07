# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Globally-installed bun packages reachable inside burrow.** When `bun` is
  a declared toolchain, `burrow up` now mounts `<BUN_INSTALL>/install/global/node_modules`
  in addition to `<BUN_INSTALL>/bin`. Previously, stub symlinks under
  `~/.bun/bin/` (e.g. `ml`, `sd`, `cn`, `ov`, `sapling`) were visible by
  name but their `.ts` source targets in the install root were sandbox-denied,
  manifesting as `error loading current directory` (burrow-aa46).

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

[Unreleased]: https://github.com/jayminwest/burrow/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jayminwest/burrow/releases/tag/v0.1.0
