# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Phase 0 scaffold: library entry (`src/index.ts`), CLI entry (`src/cli/main.ts`),
  `BurrowError` hierarchy with stable codes and recovery hints, XDG-aware paths
  module, pino logger factory, and a `burrow doctor` stub that checks for the
  platform's sandbox primitive (`bwrap` on Linux, `sandbox-exec` on macOS).
- Phase 7 — public `Client` (lib/client.ts) with the five SPEC §15 namespaces
  (burrows / runs / inbox / events / agents); CLI wiring for `up`, `fork`,
  `attach`, `list`, `show`, `stop`, `destroy`, and `agents list/show/validate`;
  shared style helpers in `src/cli/style.ts` (status icons, TTY-aware color);
  exit codes per SPEC §16 (3 = invalid input, 2 = not found, 4 = sandbox).
- Phase 8 — `burrow.toml` schema (Zod over smol-toml) covering `[project]`,
  `[sandbox]`, `[toolchain]`, `[env]`, `[secrets]`, `[git]`, `[hooks]`, and
  `[[agents]]`; per-project loader (`src/config/burrow-toml-loader.ts`); secret
  resolution pipeline in `src/secrets/` (env-file store, 1Password `op://`
  resolver with caching, layered `resolveEnv` orchestrator); host toolchain
  checker in `src/toolchain/check.ts` (prefix + `>=`/`>`/`=` operator
  matching); `burrow init` command that scaffolds a starter `burrow.toml`
  with detected toolchains; `burrow doctor` extended with project-scoped
  toolchain + 1Password CLI checks (`--project <root>`, `--no-project`);
  `burrow up` now loads `burrow.toml`, gates on `assertDoctorOk`, and folds
  `[sandbox]`/`[env]`/`[secrets]` into the persisted `SandboxProfile`.
- Host credential forwarding (SPEC §17.4): `AgentRuntime.credentialPaths()`
  declares which host paths a runtime needs read-only inside the sandbox to
  authenticate. `burrow up` collects them across declared `[[agents]]` and
  folds them into `SandboxProfile.readOnlyMounts`. `claude-code` reports
  `~/.claude` and `~/.claude.json` and `prepareWorkspace` mirrors
  `~/.claude/.credentials.json` into `<workspace>/.claude/` so the sandboxed
  agent finds it via `HOME/.claude/.credentials.json`. Per-agent opt-out via
  `forwardCredentials = false` in the burrow.toml `[[agents]]` row.
