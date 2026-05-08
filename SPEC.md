# Burrow — Specification

> Each agent digs its own contained space. Coding work happens in burrows, not on the host.

**Status:** Design phase, V1 spec.
**Last updated:** 2026-05-07.
**CLI:** `burrow` / `bw`.
**Package:** `@os-eco/burrow-cli`.

---

## 1. TL;DR

Burrow is an OS-isolated sandbox runtime for coding agents. It spins up many sandboxed workspaces in parallel, runs *any* CLI-based coding agent inside them, persists run state, streams events, and gives the user a CLI to steer running agents and observe what they're doing.

The user sits at their terminal. They never write code by hand — agents do. Burrow makes "agents do all the coding" safe by ensuring every agent run happens inside an isolated sandbox with a defined network policy and explicit env passthrough. The host stays clean: no language toolchains polluting `~`, no half-installed deps, no risky agent commands escaping to the user's filesystem.

V1 is local-first and single-user. The architecture is designed so that running burrows on remote machines (fly.io, AWS) is a future provider implementation, not a rewrite.

---

## 2. Vision

### 2.1 The day-in-the-life

```
$ cd ~/projects/web-app
$ burrow up
✓ burrow bur_a3f9 up (workspace: ~/.local/share/burrow/sessions/bur_a3f9/workspace)
$ burrow prompt bur_a3f9 claude-code "Add input validation to the login endpoint"
[stream of agent events...]
✓ run completed in 2m14s

# parallel exploration
$ burrow fork bur_a3f9 --task "try a redis-backed approach"
✓ task burrow bur_b21c forked from bur_a3f9 (branch: task/bur_b21c)
$ burrow fork bur_a3f9 --task "try in-memory caching"
✓ task burrow bur_d4e0 forked from bur_a3f9 (branch: task/bur_d4e0)
$ burrow prompt bur_b21c claude-code "Implement the redis caching layer"
$ burrow prompt bur_d4e0 claude-code "Implement the in-memory caching layer"

# observe
$ burrow events --follow
[interleaved live events from all running burrows...]

# steer
$ burrow send bur_b21c "stop and write tests first"
✓ message queued; will be delivered on next turn

# inspect a single burrow
$ burrow show bur_b21c
$ burrow logs bur_b21c --follow

# done
$ burrow stop bur_b21c bur_d4e0
$ burrow destroy bur_b21c bur_d4e0   # archives events to ~/.local/share/burrow/archive/
```

### 2.2 Two scales, one tool

Burrow is built for the solo developer first — but it scales to teams of 50+ ICs by being **docker-esque**: opinionated CLI, project config (`burrow.toml`) checked into the repo, no central server, and onboarding for a new team member is `bun install -g @os-eco/burrow-cli && cd project && burrow up`. There is no SaaS, no admin console, no auth layer. A team adopts Burrow by checking in a `burrow.toml`; that file is the contract.

### 2.3 What Burrow is not

- Not a coding agent. Burrow runs them, doesn't write code.
- Not an orchestrator. It does not decompose tasks, route work between agents, or merge branches. (Overstory, Mycelium, and the user/agents themselves do that.)
- Not a hosted service. There is no multi-tenant story.
- Not an editor environment. Humans don't `code` into a burrow. Agents do.
- Not a container manager. Burrow uses OS-level sandbox primitives (bwrap, sandbox-exec) — much lighter than Docker.

---

## 3. Goals & Non-Goals

### 3.1 V1 Goals

- Spin up multiple OS-isolated sandboxes (burrows) in parallel against any project.
- Run *any* CLI-based coding agent inside a burrow via declarative config — Claude Code, Codex, Sapling, custom — with no per-agent code in the core.
- Steer running agents by sending JSON messages to a burrow's inbox; messages get delivered on the agent's next turn.
- Observe live agent activity via a JSON event stream, both per-burrow (`burrow logs <id> --follow`) and cross-burrow (`burrow events --follow`).
- Persist sessions, runs, and events to SQLite so crashes don't lose work and `burrow destroy` archives a complete audit trail.
- Enforce environment determinism per project via `burrow.toml`: required toolchains, env vars, network policy, sandbox limits.
- First-class TypeScript library + CLI. Both are public surface.

### 3.2 V1 Non-Goals

- No remote `BurrowProvider` (fly/AWS) — interface lands in V1, second implementation does not.
- No web UI — designed for, deferred to post-V1. (`burrow watch` TUI shipped in 0.2.0; `burrow serve` HTTP API shipped in 0.3.0 — see §27.)
- No multi-tenant auth or per-user RBAC.
- No Docker, no container images.
- No dependency on Anthropic's `sandbox-runtime` / `srt` — Burrow owns the bwrap and sandbox-exec wrapping directly.
- No merge orchestration. Each task burrow produces a branch; the user (or an external agent) handles git work.
- No snapshot / fork-of-running-state — workspace forking off the project burrow is supported, but in-memory snapshots are V2.
- No Postgres, no Redis, no external services.

### 3.3 The seams that *do* survive

The original sandbox spec proposed broad reversibility seams (multi-tenant, queue abstraction, storage abstraction, HTTP server hooks). Most of those are dropped — they pay for futures that aren't coming. The seams that earn their keep:

- **`BurrowProvider` interface.** The single load-bearing seam. `LocalProvider` ships in V1; `FlyProvider` and friends are V2+. Without this seam, remote provisioning is a rewrite.
- **`AgentRuntime` adapter.** The harness-agnostic surface. Adding a new agent is config + (rarely) a small adapter, not core code.
- **Structured event envelope.** A stable JSON event shape over NDJSON, so external observers (a `burrow watch` TUI in V1.1, a multica-style web UI in V2, a team's monitoring system at any time) can all consume the same stream.

What does *not* survive: `tenant_id`, `actor` fields on every row, the `Storage` interface, the `Queue` interface, the SQLite-backed `queue_jobs` table, "future HTTP server" success criteria.

---

## 4. Mental Model

### 4.1 Two kinds of burrow

| Kind | Lifetime | Default branch | Created via | Use |
|---|---|---|---|---|
| **Project burrow** | Long-lived (days/weeks) | `main` (or project default) | `burrow up` from a project root | The default workspace for a project. Toolchains installed once, deps cached, agents run sequential or parallel work here. |
| **Task burrow** | Ephemeral (minutes/hours) | `task/<burrow-id>` | `burrow fork <project-burrow-id>` | Parallel exploration. Forks a project burrow's worktree onto a new branch. Cheap to create, easy to throw away. |

A user typically has one project burrow per project they're actively working on, and zero-to-N task burrows per project at any given time.

### 4.2 What a burrow contains

A burrow is a 4-tuple:

1. **Workspace** — a git working tree on disk, scoped to the burrow.
2. **Sandbox** — an OS isolation profile (bwrap on Linux / sandbox-exec on macOS) defining network, filesystem, and resource boundaries.
3. **Inbox** — a per-burrow message queue (SQLite-backed) for steering messages.
4. **Event log** — a per-burrow NDJSON event stream (SQLite-backed) capturing every agent event.

A burrow can host many *runs*. A run is a single agent invocation with a prompt. Runs are queued and processed serially per burrow (one agent in a burrow at a time, by default — but many burrows in parallel).

### 4.3 Agents do all the coding

Burrow has no human-in-the-sandbox UX. There is no editor mount, no SSH-into-burrow, no interactive shell as the primary flow (`burrow exec` exists for one-shot debugging). Agents write code. The user writes prompts, sends steering messages, and reads streamed events.

This simplification eliminates whole categories of complexity: editor file sync, mount semantics for tools that watch filesystem events, attach UX, container-aware editor extensions. None of it is needed.

### 4.4 The user's hands

The user touches three things, in order of frequency:
- The CLI (`burrow up`, `burrow prompt`, `burrow events`, `burrow send`, ...).
- `burrow.toml` (per-project, checked in).
- `~/.config/burrow/config.toml` and `~/.config/burrow/secrets/*` (per-user, not checked in).

That's the entire surface.

---

## 5. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ User's Terminal                                                      │
│   burrow up / prompt / send / events / logs / show / fork / ship     │
└─────────────────────────────┬────────────────────────────────────────┘
                              │
                              │ Library API (typed)
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Burrow Core (TS library)                                             │
│   ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐    │
│   │ Burrows    │  │ Runs       │  │ Inbox      │  │ Events     │    │
│   │ (sessions) │  │ (queue)    │  │ (steering) │  │ (NDJSON)   │    │
│   └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘    │
│         └──────────────┬┴───────────────┴───────────────┘           │
│                        ▼                                            │
│                   SQLite (WAL)                                      │
│           burrows | runs | events | messages | meta                 │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                ┌──────────────┴──────────────┐
                ▼                             ▼
┌──────────────────────────┐   ┌──────────────────────────────────────┐
│ BurrowProvider           │   │ AgentRuntime                         │
│  ┌─────────────────────┐ │   │  ┌────────────────────────────────┐  │
│  │ LocalProvider (V1)  │ │   │  │ ClaudeCodeRuntime (built-in)   │  │
│  │  bwrap | sb-exec    │ │   │  │ SaplingRuntime    (built-in)   │  │
│  └─────────────────────┘ │   │  │ CodexRuntime      (built-in)   │  │
│  ┌─────────────────────┐ │   │  │ <user-defined via AgentConfig> │  │
│  │ FlyProvider (V2+)   │ │   │  └────────────────────────────────┘  │
│  └─────────────────────┘ │   └──────────────────────────────────────┘
└──────────────────────────┘
```

The Library API is the source of truth. The CLI is a thin wrapper. SQLite is the durable substrate for everything that survives a process crash. `BurrowProvider` and `AgentRuntime` are the two seams.

### 5.1 End-to-end flow: `burrow prompt`

1. CLI invokes `client.runs.create({ burrowId, agentId, prompt })`.
2. Library validates the burrow is active, the agent is registered, required env vars are present.
3. Library inserts a `runs` row (`state='queued'`).
4. The in-process run loop picks up the queued run, marks `state='running'`.
5. Library asks `BurrowProvider` for a `BurrowHandle`, asks `AgentRuntime` to render a spawn command.
6. Library spawns the agent inside the sandbox via `BurrowProvider.exec()`.
7. Agent stdout (NDJSON or raw) is parsed line-by-line by the `AgentRuntime`'s `parseEvents`. Each event is:
   - Inserted into the `events` table with a monotonic `seq`.
   - Pushed to in-memory tail subscribers.
8. Agent exits. Run is finalized (`succeeded` / `failed` / `cancelled`).
9. Cleanup: temp files removed; sandbox stays alive (it's burrow-scoped).

### 5.2 End-to-end flow: `burrow send` (steering)

1. CLI invokes `client.inbox.send({ burrowId, body, priority })`.
2. Library inserts a `messages` row (`state='unread'`).
3. If a run is currently in-flight on a runtime that supports **spawn-per-turn** (Claude Code, Sapling), the message is buffered until the *next* turn.
4. On the next turn (next `burrow prompt` or next loop iteration of an agent that re-spawns), the runtime's adapter pulls unread messages and injects them as the user input for that turn.
5. For runtimes that do *not* support spawn-per-turn (one-shot Codex), messages queue for the next *run*. The CLI surfaces this clearly.

---

## 6. Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Bun** (≥1.1) | Fast startup, native SQLite, native fetch, native test runner, built-in TS. Matches every other os-eco tool. |
| Language | **TypeScript** (strict) | Type safety across library + CLI. |
| Validation | **Zod** | `burrow.toml`, `AgentConfig`, sandbox config, message envelopes. |
| DB | **`bun:sqlite`** (WAL mode) | Zero-dep, in-process, multi-reader safe. Mature WAL story, fits the patterns scouted from overstory/multica. |
| ORM | **Drizzle** | Type-safe, lightweight, multi-dialect (keeps door open for Postgres if `FlyProvider` ever needs server-side state). |
| Subprocess | **`Bun.spawn`** | Native streaming, fast. |
| CLI framework | **citty** | Same choice as other os-eco tools (mulch, seeds, canopy). |
| Logging | **pino** | Structured JSON logs. |
| Concurrency | **`p-queue`** | In-memory concurrency cap (one agent per burrow, N burrows in parallel). |
| Sandbox isolation | **Native** (bwrap + sandbox-exec wrappers, no `srt`) | Owns the contract. No third-party CLI dependency. |
| TOML | **`smol-toml`** | Parsing `burrow.toml`. Small, no native deps. |
| Testing | **`bun:test`** | Native. |

No HTTP framework, no Redis, no Postgres, no Docker.

---

## 7. Project Structure

Single Bun package, single repo.

```
burrow/
├── package.json
├── bunfig.toml
├── tsconfig.json
├── biome.json
├── drizzle.config.ts
├── README.md
├── SPEC.md                        # This document.
├── src/
│   ├── index.ts                   # Public library entry.
│   ├── cli/
│   │   ├── main.ts                # citty entry.
│   │   └── commands/
│   │       ├── up.ts              # Create + start a burrow.
│   │       ├── attach.ts          # Re-attach to an existing burrow.
│   │       ├── list.ts            # List burrows.
│   │       ├── show.ts            # Show one burrow's state.
│   │       ├── stop.ts            # Stop a burrow (workspace persists).
│   │       ├── destroy.ts         # Destroy a burrow + archive events.
│   │       ├── fork.ts            # Fork a project burrow into a task burrow.
│   │       ├── prompt.ts          # Run an agent against a burrow.
│   │       ├── send.ts            # Inject a steering message.
│   │       ├── chat.ts            # Interactive chat (stdin↔events).
│   │       ├── logs.ts            # Per-burrow event tail.
│   │       ├── events.ts          # Cross-burrow event tail.
│   │       ├── exec.ts            # One-shot command in a burrow.
│   │       ├── ship.ts            # Build + deploy artifacts (uses provider).
│   │       ├── agents.ts          # Registered agent runtimes.
│   │       ├── doctor.ts          # Health check (toolchains, providers, etc.).
│   │       └── init.ts            # Scaffold burrow.toml in current project.
│   ├── core/
│   │   ├── types.ts               # Public types: Burrow, Run, RunEvent, Message, ...
│   │   ├── errors.ts              # Error hierarchy with recovery hints.
│   │   ├── ids.ts                 # bur_xxx, run_xxx, msg_xxx, evt_xxx generators.
│   │   └── state-machine.ts       # Run + burrow state transitions.
│   ├── schemas/
│   │   ├── burrow-toml.ts         # Project config schema.
│   │   ├── agent-config.ts        # AgentConfig schema.
│   │   └── message.ts             # Steering message envelope.
│   ├── db/
│   │   ├── client.ts              # Drizzle init, migration runner.
│   │   ├── schema.ts              # Tables.
│   │   ├── migrations/
│   │   └── repos/
│   │       ├── burrows.ts
│   │       ├── runs.ts
│   │       ├── events.ts
│   │       └── messages.ts
│   ├── provider/
│   │   ├── provider.ts            # BurrowProvider interface.
│   │   ├── local/
│   │   │   ├── index.ts           # LocalProvider (V1).
│   │   │   ├── bwrap.ts           # Linux: bubblewrap profile generation.
│   │   │   ├── seatbelt.ts        # macOS: sandbox-exec profile generation.
│   │   │   ├── workspace.ts       # git worktree materialization.
│   │   │   └── network.ts         # Allowed-domain DNS / pf rules.
│   │   └── fly/                   # Stub for V2; not implemented in V1.
│   ├── runtime/
│   │   ├── runtime.ts             # AgentRuntime interface.
│   │   ├── claude-code.ts         # Built-in: spawn-per-turn, NDJSON.
│   │   ├── sapling.ts             # Built-in: spawn-per-turn, NDJSON.
│   │   ├── codex.ts               # Built-in: one-shot.
│   │   ├── declarative.ts         # User-defined adapters from AgentConfig.
│   │   └── parsers/
│   │       ├── jsonl-claude.ts
│   │       ├── stream-json.ts
│   │       └── raw-text.ts
│   ├── inbox/
│   │   ├── inbox.ts               # Message queue per burrow.
│   │   └── injector.ts            # Pre-turn injection helper for runtimes.
│   ├── events/
│   │   ├── store.ts               # SQLite event store (WAL).
│   │   ├── tail.ts                # Live tail subscribers (in-memory pub/sub).
│   │   └── archive.ts             # On-destroy NDJSON archiver.
│   ├── runner/
│   │   └── run-loop.ts            # Per-burrow run queue (p-queue).
│   ├── secrets/
│   │   ├── store.ts               # ~/.config/burrow/secrets/ reader.
│   │   ├── op.ts                  # Optional 1Password resolver (op CLI).
│   │   └── env.ts                 # Resolve `burrow.toml` env spec → real env.
│   ├── git/
│   │   ├── identity.ts            # Read host gitconfig, generate burrow gitconfig.
│   │   ├── ssh.ts                 # SSH agent passthrough setup.
│   │   └── worktree.ts            # git worktree helpers.
│   ├── config/
│   │   ├── paths.ts               # Resolve XDG / home / data dirs.
│   │   └── settings.ts            # Read user + project config.
│   ├── logging/
│   │   └── logger.ts              # pino factory with bound burrow/run context.
│   └── lib/
│       └── client.ts              # Top-level `Client` class.
└── tests/
    ├── unit/
    └── integration/
```

---

## 8. Sandbox Isolation (Native)

Burrow generates and invokes sandbox profiles directly. No `srt`, no Anthropic dependency.

### 8.1 Linux: bubblewrap (`bwrap`)

Each burrow generates a `bwrap` invocation at exec time:

```bash
bwrap \
  --unshare-all \
  --share-net \                            # only when network policy allows
  --bind <workspace> /workspace \
  --ro-bind /usr /usr \
  --ro-bind /etc /etc \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin \
  --ro-bind <toolchain-paths> ... \
  --ro-bind ${SSH_AUTH_SOCK} ${SSH_AUTH_SOCK} \   # SSH agent passthrough
  --setenv HOME /workspace \
  --setenv PATH ... \
  --setenv ${user-allowed-env} ... \
  --chdir /workspace \
  --die-with-parent \
  -- <agent-argv>
```

When network policy is `restricted`, bwrap is invoked without `--share-net` and a per-burrow nftables/userspace proxy gates outbound DNS to the allowlisted domains. When `none`, full network namespace isolation. When `open`, full host network access (development override only).

### 8.2 macOS: sandbox-exec (Seatbelt)

Each burrow generates a `.sb` profile:

```scheme
(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/System"))
(allow file-read* (subpath "/Library"))
(allow file-read* (subpath "/private/etc"))
(allow file-read* (literal "<toolchain paths>"))
(allow file-read-data file-write* (subpath "<workspace>"))
(allow file-read-data (literal "<SSH_AUTH_SOCK>"))
(allow network-outbound (regex "^.*\\.<allowed-domain-1>"))
(allow network-outbound (regex "^.*\\.<allowed-domain-2>"))
;; ...
```

Invoked via:

```bash
sandbox-exec -f <profile.sb> -- <agent-argv>
```

### 8.3 Sandbox profile builder

```ts
export interface SandboxProfile {
  workspace: string;                     // bind read-write
  readOnlyMounts: string[];              // additional ro mounts
  network: 'none' | 'restricted' | 'open';
  allowedDomains: string[];              // when network=restricted
  envPassthrough: string[];              // env var names to forward
  setEnv: Record<string, string>;        // overrides
  toolchainPaths: string[];              // resolved by toolchain layer
  timeoutMs?: number;
  memoryLimitMb?: number;
  cpuLimit?: number;
}
```

The provider's `exec(handle, command)` builds the profile, renders the platform-specific invocation, and `Bun.spawn`s it. Streams flow back as `ReadableStream<Uint8Array>` for stdout/stderr.

### 8.4 What the sandbox can do

- Run language toolchains (declared in `burrow.toml`, resolved from host install paths and read-only mounted into the sandbox).
- Make HTTP calls only to allowed domains (when `network=restricted`).
- Read/write inside the workspace.
- Use SSH agent (passed through) for git push.

### 8.5 What it cannot do

- Read or write outside the workspace.
- Access the user's home directory, SSH keys (only the agent socket), browser data, or any other host file.
- Run Docker.
- Reach the network when policy is `none`, or unallowed domains when `restricted`.

### 8.6 Why native, not `srt`

- No third-party CLI dependency in the critical path of the user's daily workflow.
- Burrow owns the profile contract; future provider implementations (Fly, AWS) generate equivalent profiles for their own substrates without translating through a wrapper.
- The bwrap/sandbox-exec primitives are stable OS interfaces. The wrapping code is roughly 500-800 LOC and changes rarely once correct.

The first reasonable port of `srt`'s default profile is the starting baseline, validated against Claude Code's expectations.

---

## 9. BurrowProvider Interface

The provider abstracts *where the burrow runs*. V1 ships `LocalProvider`. Post-V1 adds remote providers.

```ts
export interface BurrowProvider {
  /** Materialize workspace + sandbox profile, return a handle. */
  up(spec: BurrowSpec): Promise<BurrowHandle>;

  /** Run a one-shot command inside the burrow's sandbox. */
  exec(handle: BurrowHandle, command: SpawnCommand): Promise<SpawnResult>;

  /** Tear down the sandbox. Workspace persists unless `destroy()` is called. */
  stop(handle: BurrowHandle): Promise<void>;

  /** Fully remove workspace + handle metadata. */
  destroy(handle: BurrowHandle): Promise<void>;

  /** Health/state. */
  describe(handle: BurrowHandle): Promise<BurrowProviderState>;
}
```

```ts
export interface BurrowSpec {
  id: string;
  workspaceSource:
    | { kind: 'worktree'; hostClonePath: string; branch: string }
    | { kind: 'clone'; originUrl: string; branch: string }
    | { kind: 'empty' };
  profile: SandboxProfile;
}

export interface SpawnCommand {
  argv: string[];
  cwd?: string;                          // relative to workspace
  env?: Record<string, string>;
  stdin?: ReadableStream | string;
  timeoutMs?: number;
}

export interface SpawnResult {
  exitCode: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  pid: number;
  cancel(): void;
}
```

### 9.1 LocalProvider (V1)

- Workspace materialization: prefers `kind: 'worktree'` for project burrows; uses `kind: 'clone'` only when no host clone is available.
- Sandbox: builds a bwrap or sandbox-exec invocation per call; no long-running sandbox process.
- State: handle metadata stored as a row in the `burrows` table (workspace path, last-used profile, branch, etc.).

### 9.2 FlyProvider (post-V1, designed for)

- Workspace materialization: always `kind: 'clone'`. The remote machine git-clones the project at boot, using forwarded credentials or a deploy key declared in `burrow.toml`.
- Sandbox: the fly machine runs its own bwrap (Linux only on Fly).
- Connection: control-plane API over HTTPS; the local CLI calls into a thin remote-burrow API exposed by a Fly app started on demand.

The interface is identical from the user's POV:

```bash
burrow up                    # local
burrow up --remote fly       # fly machine
burrow events --follow       # works the same either way
```

---

## 10. Data Model

SQLite schema. WAL mode enabled at startup.

```ts
// src/db/schema.ts (illustrative)

export const burrows = sqliteTable('burrows', {
  id: text('id').primaryKey(),                       // bur_xxx
  parentId: text('parent_id'),                        // for forks; null for project burrows
  kind: text('kind', { enum: ['project', 'task'] }).notNull(),
  name: text('name'),
  projectRoot: text('project_root').notNull(),       // host path
  workspacePath: text('workspace_path').notNull(),   // burrow's workspace
  branch: text('branch').notNull(),
  provider: text('provider').notNull(),              // 'local', 'fly', ...
  providerStateJson: text('provider_state_json', { mode: 'json' }),
  profileJson: text('profile_json', { mode: 'json' }).notNull(),
  state: text('state', { enum: ['active', 'stopped', 'destroyed'] }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  destroyedAt: integer('destroyed_at', { mode: 'timestamp' }),
});

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),                       // run_xxx
  burrowId: text('burrow_id').notNull().references(() => burrows.id),
  agentId: text('agent_id').notNull(),
  prompt: text('prompt').notNull(),
  resumeOfRunId: text('resume_of_run_id'),            // for spawn-per-turn continuations
  state: text('state', {
    enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled']
  }).notNull(),
  exitCode: integer('exit_code'),
  errorMessage: text('error_message'),
  metadataJson: text('metadata_json', { mode: 'json' }),
  queuedAt: integer('queued_at', { mode: 'timestamp' }).notNull(),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
});

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  burrowId: text('burrow_id').notNull().references(() => burrows.id),
  runId: text('run_id').references(() => runs.id),    // null for burrow-level events
  seq: integer('seq').notNull(),                      // monotonic per (burrow_id)
  kind: text('kind').notNull(),                       // 'tool_use' | 'tool_result' | 'thinking' | ...
  stream: text('stream', { enum: ['stdout', 'stderr', 'system'] }).notNull(),
  payloadJson: text('payload_json', { mode: 'json' }).notNull(),
  ts: integer('ts', { mode: 'timestamp' }).notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),                       // msg_xxx
  burrowId: text('burrow_id').notNull().references(() => burrows.id),
  fromActor: text('from_actor').notNull(),           // 'user' | 'system' | <agent_id>
  body: text('body').notNull(),
  priority: text('priority', { enum: ['low', 'normal', 'high', 'urgent'] }).notNull(),
  state: text('state', { enum: ['unread', 'delivered', 'failed'] }).notNull(),
  deliveredAtRunId: text('delivered_at_run_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  deliveredAt: integer('delivered_at', { mode: 'timestamp' }),
});

export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
// meta rows: schema_version, app_version, install_id, ...
```

### 10.1 Indices

- `burrows(state, kind)` — list active project / task burrows.
- `runs(burrow_id, queued_at desc)`.
- `runs(state)` — startup recovery sweep.
- `events(burrow_id, seq)` — replay / tail.
- `events(burrow_id, ts desc)` — recent activity per burrow.
- `messages(burrow_id, state, priority desc, created_at)` — pending steering messages, priority-first.

### 10.2 Crash recovery

On startup, the run loop sweeps `runs WHERE state = 'running'` and marks them `failed` with `error_message = 'process exited unexpectedly'`. Any in-flight messages with `state = 'delivered'` but no completed delivery target (e.g., the run was killed mid-injection) are reset to `unread`. That's the entire crash-recovery story; no separate jobs table.

---

## 11. Workspace Materialization

### 11.1 LocalProvider strategies

- **Project burrow.** Default: `git worktree add <burrow-workspace> <branch>` against the user's existing clone. This is fast (no copy), shares `.git/`, and a single clone supports many burrows. If no host clone is detected (e.g., user runs `burrow up <git-url>` from outside a repo), falls back to `git clone`.
- **Task burrow.** `burrow fork <project-burrow-id>` creates a new branch (`task/<new-burrow-id>`) and adds a fresh worktree. Forking is an O(1) operation against the shared `.git/`.

### 11.2 The `.git/` boundary

The host clone's `.git/` is read-write inside the burrow (so the agent can `git commit`, `git push`). This means an agent could in principle corrupt the host's git metadata. The mitigations:
- Path policies prevent the agent from touching anything outside `<workspace>` and the host clone's `.git/`.
- `burrow.toml` can set `git.read_only_main_branch = true` to forbid push to the project's main branch from inside any burrow.
- Worktrees on disposable branches (task burrows) bound the blast radius.

If a team finds this trade-off unacceptable, the future `burrow.toml: workspace.materialize = "clone"` setting forces fresh-clone mode at the cost of speed.

### 11.3 Remote (FlyProvider)

Always `kind: 'clone'`. The remote machine has no pre-existing host clone. The clone uses credentials per §13 (SSH agent forward over the control-plane connection, or a per-project deploy key registered with the git host).

---

## 12. Agent Runtime Adapter

Harness-agnostic. Adding a new agent is config + (sometimes) a small adapter.

### 12.1 The interface

```ts
export interface AgentRuntime {
  id: string;
  displayName: string;

  /** Build the argv to spawn one turn / one run. */
  buildSpawnCommand(ctx: SpawnContext): SpawnCommand;

  /** Parse one stdout line into structured events (zero or more). */
  parseEvents(line: string, ctx: ParseContext): RunEvent[];

  /** True if a continuation can resume an existing session. */
  supportsResume: boolean;

  /** Render a continuation spawn command, given a prior run. */
  buildResumeCommand?(ctx: ResumeContext): SpawnCommand;

  /** Render a steering message for injection on the next turn. */
  encodeInboxMessage?(messages: Message[]): { stdin: string };

  /** Pre-spawn hooks (e.g., write Claude Code settings.local.json). */
  prepareWorkspace?(ctx: PrepareContext): Promise<void>;

  /** Health check: is this runtime installed on the host? */
  installCheck(): Promise<{ installed: boolean; version?: string; hint?: string }>;
}

export interface SpawnContext {
  burrow: Burrow;
  run: Run;
  prompt: string;
  pendingMessages: Message[];           // delivered as part of this turn
  envResolved: Record<string, string>;
}
```

### 12.2 Built-in runtimes

- **`claude-code`** — Spawn-per-turn. Uses `claude --output-format stream-json --input-format stream-json`. Steering messages delivered as user turns over stdin between agent turns. Deploys a `.claude/settings.local.json` with PreToolUse guards via `prepareWorkspace`.
- **`sapling`** — Spawn-per-turn. Native NDJSON event stream. Reuses the harness already used by overstory/mycelium.
- **`codex`** — One-shot. `codex exec --prompt-file ...`. `supportsResume = false`. Steering messages defer to the next *run*.

### 12.3 Declarative adapters (`AgentConfig`)

For the long tail (Gemini CLI, aider, custom scripts), an `AgentConfig` schema lets a user add an agent without writing code:

```ts
export const AgentConfigSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  command: z.string(),
  args: z.array(z.string()),                                   // tokens: {{prompt}}, {{workspace}}, {{run_id}}
  promptDelivery: z.enum(['arg', 'stdin', 'file']),
  promptFile: z.string().optional(),
  outputFormat: z.enum(['raw-text', 'stream-json', 'jsonl-claude']),
  supportsResume: z.boolean().default(false),
  resumeArgs: z.array(z.string()).optional(),
  inboxDelivery: z.enum(['stdin-ndjson', 'file', 'none']).default('none'),
  requiredEnv: z.array(z.string()).optional(),
  optionalEnv: z.array(z.string()).optional(),
  installCheck: z.object({
    command: z.string(),
    args: z.array(z.string()),
    exitCode: z.number().default(0),
  }).optional(),
  hooks: z.object({
    settingsLocalJson: z.string().optional(),                  // path or inline JSON
  }).optional(),
});
```

Loaded from (in order):
1. Built-in registry.
2. `~/.config/burrow/agents.toml`.
3. `<project>/burrow.toml: agents`.

Same `id` later overrides earlier; new `id`s extend.

---

## 13. Inbox & Steering

### 13.1 Sending

```bash
burrow send <id> "stop and write tests first" [--priority high]
echo "your message" | burrow send <id> -
```

Inserts a `messages` row with `state='unread'`. Returns immediately.

### 13.2 Delivery (spawn-per-turn runtimes)

The next time the run loop spawns a turn for that burrow:

1. Inbox queries `messages WHERE burrow_id = ? AND state = 'unread' ORDER BY priority DESC, created_at`.
2. The runtime's `encodeInboxMessage` is called to render those messages into the agent's input format. For Claude Code:
   ```jsonc
   {"type":"user","message":{"role":"user","content":[
     {"type":"text","text":"[STEERING] (priority: high) stop and write tests first"}
   ]}}
   ```
3. The encoded blob is written to the spawn's stdin alongside the run's own prompt.
4. Messages are marked `state='delivered'`, `delivered_at_run_id` is set.

### 13.3 Delivery (one-shot runtimes)

Messages queue. The next *run* against that burrow consumes them as part of its prompt prefix. `burrow send` warns when targeting a one-shot runtime.

### 13.4 Interactive `burrow chat`

```bash
burrow chat <id>
```

Opens a TTY where stdin lines are sent as messages and the burrow's event stream is rendered to stdout. Internally: `burrow send` + `burrow logs --follow` glued together, with a small renderer for `text` / `thinking` / `tool_use` events.

---

## 14. Event Store & Observation

### 14.1 Event envelope (NDJSON, line-delimited)

```jsonc
{
  "type": "event",
  "ts": "2026-05-07T19:00:00.000Z",
  "burrowId": "bur_a3f9",
  "runId": "run_2c4d",
  "seq": 42,
  "kind": "tool_use",       // | tool_result | thinking | text | state_change | error | stderr
  "stream": "stdout",       // | stderr | system
  "payload": {              // shape depends on kind
    "tool": "Bash",
    "input": { "command": "bun test" }
  }
}
```

The envelope is **stable**. Adding a new `kind` is additive; consumers ignore unknown kinds.

### 14.2 CLI

```bash
burrow logs <id> [--follow] [--since SEQ] [--json] [--limit N]
burrow events [--follow] [--burrow ID...] [--kind tool_use,error,...] [--json]
```

`burrow events --follow` is the **V1 cross-burrow tail**. It subscribes to all active burrows, interleaves events by `ts`, prints NDJSON to stdout (or pretty when stdin is a TTY and `--json` is unset).

### 14.3 Tailing internals

In-memory pub/sub keyed by burrow ID. The run loop publishes to subscribers on insert. CLI subscribers receive events on a channel and write them out. SQLite is the source of truth on disconnect / replay; subscribers replay missed events from `events.seq` on reconnect (post-V1, when `serve` lands).

### 14.4 Archive on destroy

`burrow destroy <id>` (default behavior):

1. Stops the burrow.
2. Exports `events WHERE burrow_id = ?` to `${dataDir}/archive/<id>/events.jsonl`.
3. Exports `messages` to `${dataDir}/archive/<id>/messages.jsonl`.
4. Exports `runs` summary to `${dataDir}/archive/<id>/runs.json`.
5. Deletes the workspace.
6. Removes rows from live tables; sets `burrows.state = 'destroyed'` and `destroyedAt`.

`burrow destroy <id> --no-archive` skips the export.

This is the audit trail. Months later, a team can grep across `${dataDir}/archive/` to reconstruct what an agent did and why.

---

## 15. Library API

```ts
import { Client } from '@os-eco/burrow';

const client = await Client.open({
  dataDir?: string,
  configDir?: string,
  logger?: pino.Logger,
});

await client.close();
```

### 15.1 Burrows

```ts
client.burrows.up(spec: BurrowUpInput): Promise<Burrow>;
client.burrows.fork(parentId: string, opts?: ForkOpts): Promise<Burrow>;
client.burrows.list(filter?: { kind?, state?, projectRoot? }): Promise<Burrow[]>;
client.burrows.get(id: string): Promise<Burrow>;
client.burrows.stop(id: string): Promise<void>;
client.burrows.destroy(id: string, opts?: { archive?: boolean }): Promise<void>;
```

### 15.2 Runs

```ts
client.runs.create(input: { burrowId, agentId, prompt, metadata? }): Promise<Run>;
client.runs.get(id): Promise<Run>;
client.runs.list(filter?: { burrowId?, state? }): Promise<Run[]>;
client.runs.cancel(id): Promise<void>;
client.runs.stream(id): AsyncIterable<RunEvent>;     // tails one run
```

### 15.3 Inbox

```ts
client.inbox.send(input: { burrowId, body, priority?, fromActor? }): Promise<Message>;
client.inbox.list(burrowId, filter?: { state? }): Promise<Message[]>;
client.inbox.cancel(messageId): Promise<void>;
```

### 15.4 Events

```ts
client.events.tail(filter?: { burrowId?, kinds?, since? }): AsyncIterable<RunEvent>;
client.events.replay(burrowId, since?: number): AsyncIterable<RunEvent>;
```

### 15.5 Agents

```ts
client.agents.register(adapter: AgentRuntime | AgentConfig): void;
client.agents.list(): AgentRuntime[];
client.agents.get(id): AgentRuntime | undefined;
```

### 15.6 HTTP-backed `Client`

`HttpClient` (`src/lib/http-client.ts`) mirrors the namespace surface above
1:1 over a `burrow serve` connection (§27). Same method shapes, same return
types, same error subclasses — consumers swap transports without touching
call sites.

```ts
import { HttpClient } from '@os-eco/burrow';

const client = new HttpClient({
  transport: { kind: 'unix', path: '/run/burrow.sock' }, // or { kind: 'tcp', hostname, port }
  token: process.env.BURROW_API_TOKEN,
});
```

---

## 16. CLI Surface

V1 commands. Every command supports `--json` for structured output. Exit codes: `0` success; `1` generic; `2` not found; `3` invalid input; `4` runtime / sandbox error.

```
burrow init                                    # Scaffold burrow.toml in cwd
burrow doctor [--fix]                          # Health check (toolchains, providers, agents)

burrow up [--name NAME] [--branch BR] [--remote PROVIDER] [--no-toml]
                                               # Start a project burrow.
burrow fork <id> [--task "DESC"] [--branch BR]
                                               # Fork into a task burrow.
burrow attach <id>                             # Resume / re-init an existing burrow.
burrow list [--all] [--kind project|task] [--state STATE]
burrow show <id>                               # Snapshot: state, recent runs, recent events.
burrow stop <id>...
burrow destroy <id>... [--no-archive] [--force]

burrow prompt <id> <agent> "<prompt>" [--metadata k=v] [--no-stream]
                                               # Run an agent. Default streams events.
burrow send <id> "<message>" [--priority LEVEL]
                                               # Inject a steering message.
burrow chat <id>                               # Interactive TTY chat.
burrow exec <id> -- <cmd>...                   # One-shot command in the burrow.

burrow logs <id> [--follow] [--since SEQ] [--limit N] [--json]
burrow events [--follow] [--burrow ID...] [--kind ...] [--json]

burrow agents list
burrow agents show <id>
burrow agents validate <file>

burrow serve [--socket PATH | --port N [--host HOST]] [--no-auth] [--json]
                                               # Run the HTTP API (§27). Unix socket by
                                               # default; localhost TCP opt-in via --port.

burrow ship [<id>] [--target fly|docker|tarball|...] [--dry-run]
                                               # Build + deploy artifacts (uses provider).

burrow config show
burrow config edit
```

### 16.1 Branding

Follows the os-eco brand standards:
- Forest palette brand color (TBD; suggest a burrow-evocative tone, e.g. warm earth).
- Help screen Style A (branded header + tagline).
- Status icon set D (`- > x !`).
- Message format `✓ ✗ !` with standard colors.
- Global flags: `-v`, `--json`, `--quiet/-q`, `--verbose`, `--timing`.
- `doctor` and `upgrade` commands present.
- Shell completions via `burrow completions <shell>`.
- Typo suggestions for unknown commands.

---

## 17. `burrow.toml` Schema

The team contract. Checked into the project root. Fully optional — `burrow up` works with no `burrow.toml` and sensible defaults — but recommended for any team setting.

```toml
# burrow.toml (project-scoped)

[project]
name = "web-app"
default_branch = "main"
origin = "git@github.com:org/web-app.git"   # used by remote providers

[sandbox]
network = "restricted"                        # none | restricted | open
allowed_domains = [
  "registry.npmjs.org",
  "github.com",
  "api.anthropic.com",
]
timeout_minutes = 60
memory_limit_mb = 8192
cpu_limit = 2.0

[toolchain]
node = "20"
bun = "1.1"
python = "3.12"
# burrow doctor verifies these exist on the host before `burrow up` succeeds.

[env]
required = ["DATABASE_URL", "ANTHROPIC_API_KEY"]
optional = ["SENTRY_DSN", "STRIPE_SECRET_KEY"]

[env.defaults]
NODE_ENV = "development"
LOG_LEVEL = "info"

[secrets]
# Per-project secret references. Resolved at burrow up.
# `op://...` resolves via 1Password CLI (optional, requires `op` on host).
DATABASE_URL = "op://Engineering/web-app-dev/db_url"
STRIPE_SECRET_KEY = "op://Engineering/web-app-dev/stripe"

[git]
identity = "user"                             # user | bot
read_only_main_branch = true
credentials = "ssh-agent"                     # ssh-agent | managed-key | token

[hooks]
post_create = ["bun install"]
pre_destroy = []

[[agents]]
id = "claude-code"
# overrides apply on top of built-ins

[[agents]]
id = "my-custom-agent"
command = "./scripts/agent.sh"
args = ["--prompt", "{{prompt}}"]
output_format = "raw-text"
prompt_delivery = "arg"
```

### 17.1 Resolution order

For each setting:
1. CLI flag (`--memory 16384`).
2. Environment variable (`BURROW_MEMORY_MB=16384`).
3. `<project>/burrow.toml`.
4. `~/.config/burrow/config.toml`.
5. Built-in defaults.

### 17.2 `burrow init`

Scaffolds a `burrow.toml` based on detected project (presence of `package.json`, `pyproject.toml`, etc.). Picks reasonable defaults; the user reviews and commits.

---

## 18. Git, Identity, Secrets

### 18.1 SSH agent passthrough (default)

The host's `$SSH_AUTH_SOCK` is forwarded into the burrow as a read-only mount. The agent inside has access to the same SSH keys the user has loaded — no host key files copied or exposed. Setup is `ssh-add ~/.ssh/id_ed25519` once on the host; every burrow inherits.

### 18.2 Managed deploy key (opt-in)

```toml
[git]
credentials = "managed-key"
```

On `burrow up`, Burrow generates a project-scoped ed25519 keypair under `${dataDir}/keys/<project>/` and prints the public half for the user to register (or invokes `gh ssh-key add` if `gh` is installed and the user opts in). The private half is read-only mounted into burrows for that project only.

### 18.3 Token-based (CI / automation)

```toml
[git]
credentials = "token"
token_env = "BURROW_GIT_TOKEN"
```

The named env var is forwarded into the burrow as `GH_TOKEN` / `GITHUB_TOKEN`. Useful for automation contexts where SSH agent isn't available.

### 18.4 Identity

```toml
[git]
identity = "user"   # default: read host ~/.gitconfig
# or
identity = "bot"
bot_name = "Acme Agents"
bot_email = "agents@acme.example"
```

Burrow writes a per-burrow `.gitconfig` into the workspace overlay before the agent runs.

### 18.5 Secrets

User-scoped, not in `burrow.toml`:
- `~/.config/burrow/secrets/<project>.env` — KV file (auto-loaded for that project).
- `~/.config/burrow/secrets/global.env` — applies to all projects.
- 1Password references (`op://...`) in `burrow.toml` resolved via `op` if installed.

Claude Code credentials specifically:
- If the host has Claude Code authenticated (`~/.claude/`), Burrow detects this and forwards the credential cache (read-only) into burrows that declare `claude-code` as a runtime. No second login required.

---

## 19. Toolchain Consistency

`burrow.toml: [toolchain]` declares required toolchains and versions. `burrow doctor` verifies each is installed on the host and matches the declared version. `burrow up` calls `doctor` first; if any toolchain is missing or mismatched, the command fails with a clear hint:

```
✗ Required toolchain `bun >= 1.1` not found.
  → install with: curl -fsSL https://bun.sh/install | bash
```

V1 does *not* install toolchains into the sandbox itself. Toolchains live on the host; burrows mount their binary directories read-only. The team scaling pressure: every IC on a team gets the same `burrow.toml`, so every IC's burrow is verified against the same toolchain contract.

(V2 may introduce mise / asdf integration to manage toolchains automatically.)

---

## 20. Errors & Logging

### 20.1 Error hierarchy

```ts
abstract class BurrowError extends Error {
  abstract code: string;
  recoveryHint?: string;
  cause?: unknown;
}

class SandboxError                  extends BurrowError { code = 'sandbox_error' }
class SandboxPrimitiveMissing       extends SandboxError { code = 'bwrap_or_sb_missing' }
class WorkspaceMaterializationError extends BurrowError { code = 'workspace_materialization_failed' }
class AgentNotInstalled             extends BurrowError { code = 'agent_not_installed' }
class AgentRuntimeError             extends BurrowError { code = 'agent_runtime_failed' }
class ToolchainMismatch             extends BurrowError { code = 'toolchain_mismatch' }
class SecretResolutionError         extends BurrowError { code = 'secret_resolution_failed' }
class ValidationError               extends BurrowError { code = 'validation_error' }
class NotFoundError                 extends BurrowError { code = 'not_found' }
class CredentialError               extends BurrowError { code = 'credential_error' }
```

CLI renderer prints `[<code>] <message>\n  → <recoveryHint>` and sets the right exit code.

### 20.2 Logging

`pino` with bound context. Every log line includes `burrowId`, `runId` (when applicable), `provider`, `agentId`. Output destinations:
- `stdout` — JSON in CI, pretty in TTY (auto-detected).
- `${cacheDir}/logs/<date>.log` — daily rotation by filename.

---

## 21. Configuration & Paths

| Purpose | Path |
|---|---|
| Data dir (DB, workspaces, archive) | `$XDG_DATA_HOME/burrow` → `~/.local/share/burrow` (Linux) / `~/Library/Application Support/burrow` (macOS) |
| Config dir | `$XDG_CONFIG_HOME/burrow` → `~/.config/burrow` |
| Cache dir (logs) | `$XDG_CACHE_HOME/burrow` → `~/.cache/burrow` (Linux) / `~/Library/Caches/burrow` (macOS) |
| Secrets | `${configDir}/secrets/` (mode `0700`, files `0600`) |
| Per-project state | `${dataDir}/projects/<project-id>/` |
| Workspaces | `${dataDir}/projects/<project-id>/workspaces/<burrow-id>/` |
| Archive | `${dataDir}/archive/<burrow-id>/` |
| DB | `${dataDir}/db.sqlite` |
| Logs | `${cacheDir}/logs/<date>.log` |

Override via env (`BURROW_DATA_DIR`, etc.) or `Client.open({ dataDir, configDir, cacheDir })`.

---

## 22. Implementation Phases

### Phase 0 — Scaffold (½ day)
Bun project, TS strict, citty CLI skeleton, pino, paths module, error hierarchy, `doctor` stub.

### Phase 1 — Native sandbox (2-3 days)
`bwrap.ts` + `seatbelt.ts` profile generation. SSH agent passthrough. Network policy enforcement. Tested with simple commands (`echo`, `bun --version`, `git clone`).

### Phase 2 — Data model + run loop (1-2 days)
Drizzle schema, migrations, repos. `events` / `runs` / `messages` / `burrows` tables. p-queue per-burrow run loop. Crash recovery sweep on startup.

### Phase 3 — Workspace materialization (1 day)
`git worktree` for project burrows, `git clone` fallback, `burrow fork` for task burrows.

### Phase 4 — Agent runtimes (2-3 days)
`AgentRuntime` interface. Built-ins: `claude-code` (spawn-per-turn, NDJSON, settings.local.json hooks), `sapling`, `codex`. Declarative `AgentConfig` adapter for the long tail.

### Phase 5 — Inbox + steering (1 day)
`messages` table, `burrow send`, `burrow chat`, inbox-injection on next turn for spawn-per-turn runtimes.

### Phase 6 — Event tail + archive (1 day)
In-memory pub/sub. `burrow logs --follow`, `burrow events --follow`. NDJSON archiver on `destroy`.

### Phase 7 — Library API + CLI surface (1-2 days)
`Client` class, all commands wired. JSON + pretty modes. Branding pass.

### Phase 8 — `burrow.toml` + secrets + toolchain doctor (1-2 days)
TOML parsing, schema validation, toolchain checks, secret resolution (env, file, op://), 1Password integration.

### Phase 9 — `burrow ship` (1-2 days)
Build + deploy: detects project type, runs declared build steps inside burrow, deploys artifact to declared target. V1 supports three first-class `ShipTarget`s: `fly` (managed deploy), `docker` (build + tag an image — user-facing, not just fly's substrate; reusable for any registry or local handoff), and `tarball` (offline artifact: `./dist/<id>-<ts>.tar.gz`). Three targets stress-test the interface across shape (tarball: sync, no auth, no network), lifecycle (docker: streaming build events, long-running), and real-world deploy (fly composes the docker target). The abstraction is a `ShipTarget` interface so adding more is mechanical.

### Phase 10 — Polish (1-2 days)
README, examples, error message review, branding compliance, completion shells.

**Total estimate: 12-16 days of focused work.** ~3-4k LOC.

---

## 23. V1 Success Criteria

V1 is "done" when all of these hold:

- `burrow up` in a project with a `burrow.toml` succeeds, agents run inside an isolated sandbox, the host filesystem outside the workspace is unreachable.
- Four parallel burrows (one project + three task burrows) can run agents simultaneously without races.
- A `kill -9` on the burrow process leaves the system recoverable: in-flight runs marked `failed`, burrows still listed, workspaces intact.
- `burrow send <id> "<msg>"` is delivered to the agent on its next turn for `claude-code` and `sapling` runtimes.
- `burrow events --follow` interleaves events from all active burrows in real-time as NDJSON.
- `burrow destroy <id>` archives the burrow's complete event log to `${dataDir}/archive/<id>/events.jsonl`.
- Adding a Gemini-CLI-shaped agent requires only a `[[agents]]` entry in `burrow.toml` — zero code changes in `src/`.
- `burrow doctor` correctly identifies a missing host toolchain declared in `burrow.toml` and refuses to `up` until fixed.
- A new IC joining a project with a `burrow.toml` runs `bun install -g @os-eco/burrow-cli && cd project && burrow up` and is productive without further setup steps.
- A future `FlyProvider` can be added without modifying any file under `src/core/`, `src/db/`, `src/runtime/`, `src/inbox/`, `src/events/`, or `src/runner/`. The seam holds.

The last bullet is the load-bearing test of the architecture.

---

## 24. Post-V1 Roadmap

These are explicitly designed *for* but not built *in* V1:

- **`burrow watch` (TUI dashboard).** Multi-burrow live view, like `ov dashboard`. First post-V1 feature.
- **`burrow serve` (WS + REST server).** Powers external UIs (a future multica-style web frontend, team monitoring, CI integrations). Second post-V1 feature.
- **`FlyProvider` (and friends).** Remote burrows on Fly machines. Same CLI, same APIs.
- **`burrow snapshot` / `burrow restore`.** Versioned workspace snapshots for time-travel debugging.
- **Toolchain auto-install (mise / asdf integration).** No manual host setup.
- **`burrow ship` target plugins.** Additional deploy targets beyond fly/docker/tarball.
- **Substrate integration with Overstory and Mycelium.** Eventually, those tools dispatch agents into burrows instead of tmux. Burrow's CLI/API stays unchanged; consumption is purely additive.

Pre-emptively *out of scope* even post-V1, unless the design changes:

- Multi-tenant SaaS / hosted Burrow product.
- In-burrow human editor experience (VS Code Remote-style attach).
- Burrow-managed merge orchestration.
- Container image management (we use OS sandbox primitives, not images).

---

## 25. Open Questions

These need a decision before or during early implementation:

1. **Brand color.** Forest palette has open slots; pick a tone that reads "warm, contained, earthy."
2. **Network policy enforcement on Linux.** Userspace HTTP proxy vs. nftables rules. The latter is more correct; the former is more portable across distros. Probably ship userspace proxy first, nftables as opt-in.
3. **Toolchain mounting.** Mount specific binary paths only, or the entire `$PATH` ancestry? The first is safer; the second is more compatible with toolchain shims (mise, asdf, fnm). V1 likely mounts the resolved binary plus its lib dir; full `$PATH` is opt-in via `burrow.toml: sandbox.toolchain_mode = "shim-aware"`.
4. **Default `burrow up` behavior outside a project.** Refuse, prompt for `burrow init`, or create an "ephemeral scratch burrow" with no project context? Probably refuse + suggest `burrow init`.
5. **`burrow chat` when an agent doesn't support spawn-per-turn.** Disabled command, or graceful "messages will queue for the next run"? The latter is friendlier.

---

## 26. Dashboard view model

`burrow watch` is the first post-V1 feature (§24) and the forcing function for the wire shape that a future `burrow serve` will WebSocket-stream to a browser frontend. Both faces consume the same envelope: a self-contained `DashboardSnapshot` produced by a pure builder over `Repos`. Building the contract now keeps `burrow serve` a thin adapter later instead of a rewrite, and gives `burrow watch --json` an immediate machine-readable mode that scripts and CI can consume.

### 26.1 Snapshot envelope (NDJSON, line-delimited)

```jsonc
{
  "type": "snapshot",
  "version": 1,
  "ts": "2026-05-07T19:00:00.000Z",
  "burrows": [
    {
      "id": "bur_a3f9",
      "parentId": null,
      "kind": "project",
      "name": "web-app",
      "state": "running",
      "projectRoot": "/home/user/projects/web-app",
      "workspacePath": "/home/user/.local/share/burrow/sessions/bur_a3f9/workspace",
      "branch": "main",
      "provider": "local",
      "createdAt": "2026-05-07T18:42:00.000Z",
      "updatedAt": "2026-05-07T18:59:58.000Z",
      "destroyedAt": null,
      "runs": [ /* RunSummary[], newest-first, capped (default 20) */ ],
      "activeRun": { /* RunSummary | null — running else queued */ },
      "eventTail": [ /* EventTailEntry[], oldest-first, capped (default 500) */ ],
      "lastEventSeq": 1287
    }
  ]
}
```

`burrow watch --json` emits one `DashboardSnapshot` per coalesced wake — exactly the shape `burrow serve` will eventually push over WebSocket.

### 26.2 Additive-only versioning (the lock)

Same discipline as the §14.1 event envelope:

1. **Existing keys never change semantics or types.** Renaming or re-typing a field is breaking.
2. **New keys may be added.** Consumers MUST ignore unknown top-level keys and unknown fields on `BurrowCard` / `RunSummary` / `EventTailEntry`.
3. **`version` only bumps on a breaking change.** A v1 consumer reading a v1 snapshot with extra fields must keep working.
4. **Optional fields stay optional forever.** Promoting an optional field to required is breaking.
5. **Enum members may be added; existing members never change.** Consumers MUST treat unknown `state` / `kind` / `stream` values as pass-through strings rather than crashing.

The companion test (`src/dashboard/types.test.ts`) pins the canonical key set per interface — any field rename or removal trips the test, forcing an intentional `version` bump.

### 26.3 Library surface

Re-exported from `@os-eco/burrow-cli`:

```ts
import {
  buildSnapshot,
  streamSnapshots,
  DASHBOARD_SNAPSHOT_VERSION,
  DEFAULT_EVENT_TAIL_CAP,
  DEFAULT_RUNS_PER_CARD,
  DEFAULT_COALESCE_MS,
  DEFAULT_POLL_FALLBACK_MS,
  type DashboardSnapshot,
  type BurrowCard,
  type RunSummary,
  type EventTailEntry,
  type BuildSnapshotOptions,
  type StreamSnapshotsOptions,
} from '@os-eco/burrow-cli';
```

`buildSnapshot(repos, opts?)` is pure: same `Repos` state ⇒ same `DashboardSnapshot` (modulo the envelope `ts`, which can be pinned via `opts.now` for tests). `streamSnapshots(repos, bus, opts?)` is an async generator that wakes on `EventBus.subscribeAll` pushes plus a polling fallback (default 1s, for burrow/run lifecycle changes that don't traverse the bus), coalesces wakes through a trailing-edge window (default 100ms), and yields one snapshot per closed window. Tear-down is leak-free: bus subscription, polling timer, and abort listener are all released in a single `finally` block.

### 26.4 Trim and cap

Snapshots are best-effort live state, not a replay log. The SQLite event store remains the source of truth for full replay (§14.3).

- `BurrowCard.runs` — capped (default 20, newest-first). `Run.prompt` and `Run.metadataJson` are dropped from `RunSummary` to keep the wire small; re-add as new optional fields if a consumer ever needs them — additive, no `version` bump.
- `BurrowCard.eventTail` — capped (default 500, oldest-first within the window). `lastEventSeq` lets a reconnecting consumer (a future web UI) replay missed events from `events.seq > lastEventSeq`.
- `BurrowCard.activeRun` — derived: most recent `running` run, falling back to most recent `queued` run, else `null`.

### 26.5 `burrow serve` wire-shape lock

`burrow serve` (§27) consumes `streamSnapshots()` directly and broadcasts each yielded `DashboardSnapshot` as NDJSON over chunked HTTP at `GET /watch` (`?once=1` collapses to the first snapshot for one-shot consumers). The wire shape is identical to `burrow watch --json` so a single client library targets both. Any change that breaks `watch --json` is a breaking change and bumps `version`.

---

## 27. HTTP API (`burrow serve`)

Shipped in 0.3.0 (plan `pl-5b40`, parent seed `burrow-1d64`). Design and decomposition live in seeds, not here — the spec section is intentionally a pointer so the design record stays where the work happens.

- **Seed:** `burrow-1d64` — feature.
- **Plan:** `pl-5b40` — context, approach, rejected alternatives, risks, acceptance criteria, and 8 child-seed implementation steps.
- **View:** `sd plan show pl-5b40`.

Motivation: the warren control plane (and any future external orchestrator) needs a stable, streaming, cross-process surface to drive burrow. Routes mirror the `Client` namespaces 1:1 so the Library API (§15) stays the source of truth, and an HTTP-backed `HttpClient` mirror (§15.6, `src/lib/http-client.ts`) lets consumers swap transports without touching call sites. Streaming surfaces (events tail, run stream, watch snapshots) emit NDJSON over chunked HTTP byte-for-byte equal to the `--json` CLI output. Unix socket is the primary transport (single-host / single-container deploy); localhost TCP is opt-in via `--port`. Bearer auth from `BURROW_API_TOKEN` env; `--no-auth` bypasses for loopback-only use. Single-user posture preserved — multi-user remains a non-goal.

**Self-description.** A running `burrow serve` exposes its full contract at `GET /openapi.json` (OpenAPI 3.1, bearer-auth required) and a Scalar-rendered `GET /openapi.html` (auth-exempt, loopback browsing). The hand-authored source is `src/server/openapi/spec.ts`; `src/server/openapi/__golden__/openapi.json` locks it via `spec.test.ts`. Treat the OpenAPI document as the canonical wire contract; this section remains a pointer.

**Run cancellation (`burrow-6739`).** Two endpoints split the cancel/cleanup surface so callers don't need to overload one verb. `POST /runs/:id/cancel` is the graceful state transition: optional `{reason}` body, idempotent on already-terminal runs (returns current state with 200, never 4xx), and emits a `run_cancelled` event on the run's stream so subscribers see the trigger. `DELETE /runs/:id` is post-completion record removal — only legal when the run is terminal (400 otherwise), 204 on success — distinct from cancel so warren and other consumers can cleanly separate "stop this run" from "purge this row." DELETE cascades to the run's events (the `events.run_id` foreign key would otherwise block the delete). See the OpenAPI doc for the full schema.
