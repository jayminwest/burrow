# Burrow

OS-isolated sandbox runtime for coding agents.

[![CI](https://github.com/jayminwest/burrow/actions/workflows/ci.yml/badge.svg)](https://github.com/jayminwest/burrow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Each agent digs its own contained space. Coding work happens in burrows, not on the host.

Burrow spins up many sandboxed workspaces in parallel, runs *any* CLI-based coding agent inside them, persists run state, streams events, and gives the user a CLI to steer running agents and observe what they're doing. The host stays clean: no language toolchains polluting `~`, no half-installed deps, no risky agent commands escaping to the user's filesystem.

V1 is local-first and single-user, with `bwrap` (Linux) and `sandbox-exec` (macOS) as the sandbox primitives — no Docker, no daemon. Remote providers are a post-V1 implementation, not a rewrite.

## Install

```bash
bun install -g @os-eco/burrow-cli
# or: npm install -g @os-eco/burrow-cli
```

CLI binaries: `burrow` and `bw`.

## Quickstart

```bash
$ cd ~/projects/web-app
$ burrow init claude                  # scaffold burrow.toml + register claude-code
$ burrow doctor                       # confirm sandbox primitive + toolchains
$ burrow up                           # spin up a project burrow
✓ burrow bur_a3f9 up (workspace: ~/.local/share/burrow/sessions/bur_a3f9/workspace)

$ burrow prompt bur_a3f9 "Add input validation to the login endpoint"
[stream of agent events...]
✓ run completed in 2m14s

# parallel exploration
$ burrow fork bur_a3f9 --task "try a redis-backed approach"
$ burrow prompt bur_b21c "Implement the redis caching layer"

# observe + steer
$ burrow events --follow              # interleaved live events from every active burrow
$ burrow send bur_b21c "stop and write tests first"

# tear down + archive
$ burrow stop bur_b21c
$ burrow destroy bur_b21c             # archives events to the data dir
```

See [`examples/`](examples) for a runnable walkthrough plus a custom-agent recipe.

## What you get

- **Native sandboxing.** `bwrap` on Linux, `sandbox-exec` on macOS. No Docker, no container images, no daemon. The host filesystem outside the workspace is unreachable; the network policy is one of `none | restricted | open`.
- **Any CLI agent.** Built-in runtimes for `claude-code`, `sapling`, and `codex`. New agents land via a declarative `[[agents]]` stanza in `burrow.toml` — zero core code changes.
- **Parallel work.** A project burrow plus N task burrows, each on its own git worktree, running concurrently behind a per-burrow FIFO queue.
- **Steerable runs.** `burrow send <id> "..."` queues a steering message; the next agent turn delivers it.
- **Durable state.** `bun:sqlite` (WAL) persists burrows, runs, events, and inbox messages. `kill -9` leaves the system recoverable; `burrow destroy` archives the full event log to NDJSON.
- **First-class observability.** `burrow logs <id> --follow` and `burrow events --follow` stream NDJSON events from one or every burrow.
- **Project contract.** [`burrow.toml`](SPEC.md#17-burrowtoml-schema) declares toolchain versions, env requirements, secrets references (op://, env, defaults), network policy, and `[[agents]]`. `burrow doctor` gates `burrow up` on those checks.
- **`burrow ship`.** Build + deploy artifacts via the `tarball`, `docker`, or `fly` ShipTargets — the same shape a future `aws` target would land into.
- **Library-first.** Every CLI command is a thin wrapper over the public `Client` class. `import { Client } from "@os-eco/burrow-cli"` to drive Burrow from TypeScript.

## CLI surface (V1)

```bash
burrow init [agents...]                  # scaffold burrow.toml
burrow doctor [--project <root>]         # health check (sandbox + toolchains + agents)
burrow upgrade                           # print the upgrade command for the installed binary
burrow completions <shell>               # bash | zsh | fish

burrow up                                # spin up a project burrow against the cwd
burrow fork <id> --task "<desc>"         # task burrow on a fresh branch
burrow attach <id>                       # re-activate a stopped burrow
burrow list / show / stop / destroy

burrow prompt <id> "<task>"              # dispatch the default agent (or --agent <id>)
burrow send <id> "<message>"             # queue a steering message
burrow chat <id>                         # interactive REPL — one stdin line per message

burrow logs <id> [--follow]              # one burrow's event log
burrow events [--follow]                 # every active burrow, interleaved
burrow watch [--json]                    # multi-burrow TUI dashboard (NDJSON snapshots with --json)

burrow agents list / show / validate / add
burrow ship [<id>] --target tarball|docker|fly
```

Every command supports `--json` for machine-readable output and `--quiet`/`--verbose` for log level. Exit codes: `0` success, `1` generic, `2` not found, `3` invalid input, `4` runtime/sandbox error.

Full design rationale, the `burrow.toml` schema, and the deferred V2 surface live in [SPEC.md](SPEC.md).

## Ecosystem

Burrow is part of the [os-eco](https://github.com/jayminwest/os-eco) ecosystem. It does not orchestrate agents — that's [Overstory](https://github.com/jayminwest/overstory) and [Mycelium](https://github.com/jayminwest/mycelium). It runs whatever agent the orchestrator hands it, in isolation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). For security issues, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
