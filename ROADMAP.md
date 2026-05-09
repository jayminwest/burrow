# Burrow Roadmap

Direction for burrow as it scales from solo / single-machine use to multi-machine
swarms and team-of-50+ adoption. Each item is a self-contained idea with a stable
ID for reference. Items can be sequenced independently; the dependency graph is
captured per-item.

This file is the punch list, not the spec. Items here become seeds issues when
committed to. [SPEC.md](SPEC.md) is the frozen V1 design record; ROADMAP.md is
the forward-looking direction.

## Status legend

- `[proposed]` — under discussion, not committed
- `[in-progress]` — actively being built
- `[partially shipped]` — some sub-items released, others still open
- `[shipped]` — released
- `[deferred]` — useful but not now

## Item template

New items follow this shape so the format doesn't drift:

    ## R-NN — Title
    Status: [proposed]
    Depends on: —
    Unlocks: —

    **Problem.** One paragraph: what breaks today, especially as burrow leaves
    single-machine local use.

    **Sketch.** Short description or config/code example of the proposed shape.
    Not a spec.

    **Open questions.** Bullets — things to decide before or during implementation.

---

## R-01 — Prefer burrow-on-host over burrow-in-pod (userns nesting)
Status: [shipped]
Depends on: —
Unlocks: R-02 (FlyProvider deploy posture); deploy guides in warren / overstory link to burrow's [DEPLOY.md](DEPLOY.md)

**Resolution.** Lives at [DEPLOY.md](DEPLOY.md): on-host is the production
default; in-pod is acceptable for self-managed / single-tenant / dev-CI
postures with the four-flag bwrap recipe, not acceptable in multi-tenant
managed K8s/ECS/Cloud Run. Reference systemd unit + Fly Machine config
included. Both open questions resolved (guide lives in burrow; reference
configs ship inline).

**Original problem (preserved for context).** For deploying burrow swarms in the cloud, bwrap needs unprivileged
user namespaces. On modern Linux hosts that works directly. Inside a managed
container (K8s, ECS Fargate, Cloud Run), the outer runtime's default security
profile typically blocks userns creation:

- Ubuntu 24.04 hosts ship `kernel.apparmor_restrict_unprivileged_userns=1`.
  Containers without an explicit AppArmor profile can't `unshare(CLONE_NEWUSER)`.
- Docker default seccomp is fine, but the docker-default AppArmor profile blocks
  userns; you need `--security-opt apparmor=unconfined`.
- bwrap also wants `SYS_ADMIN` (loopback in new netns) and
  `systempaths=unconfined` (mount /proc past masked paths).

Empirically (burrow-0fab spike, Ubuntu 24.04 host, Docker 28.4) the minimum
viable in-container invocation is 4 security overrides:

    --security-opt apparmor=unconfined
    --security-opt seccomp=unconfined
    --security-opt systempaths=unconfined
    --cap-add SYS_ADMIN

In production K8s / ECS / Cloud Run terms that's a privileged-workload waiver
in most clusters' admission policy. Possible but expensive to negotiate, and
the security relaxation of the outer container partly defeats the point of
nesting.

**Sketch.** Default deployment posture: burrow daemon runs directly on a Linux
host (VM, Fly Machine, EC2). No outer container. burrow-in-pod is acceptable in
self-managed clusters where you control admission policy, single-tenant
clusters with no shared-trust constraints, and dev/CI where the relaxation is
fine. burrow-on-host is the right call for multi-tenant managed K8s/ECS/Cloud
Run, anywhere admission policy is restrictive and not yours to change, and as
the production-swarm default.

**Open questions (resolved).**
- ~~Where the deploy guide actually lives.~~ → `burrow/DEPLOY.md`. Warren,
  overstory, greenhouse cross-link in.
- ~~Reference systemd unit / Fly Machine config alongside.~~ → both
  included inline in DEPLOY.md.

**Related.**
- burrow-9986 (executed R-01 — wrote DEPLOY.md, this status flip)
- burrow-7ba7 (closed into this; was the standalone decision record)
- burrow-fbdf (closed; required Anthropic upstream action)
- burrow-0fab (parent decision discussion)

---

## R-02 — FlyProvider + SshProvider (remote `BurrowProvider`s)
Status: [proposed]
Depends on: R-01 (shipped — deploy posture in [DEPLOY.md](DEPLOY.md): Fly
Machines = on-host posture, no four-flag overrides needed); R-07
(workspace-seed HTTP API — without it, remote burrows have no contract for
warren to populate `.canopy/`, `.mulch/`, `.seeds/`)
Unlocks: cloud-deployed burrow swarms; warren-on-Fly's remote-daemon model;
the load-bearing test of the `BurrowProvider` seam (SPEC §23)

**Problem.** V1 ships only `LocalProvider`. SPEC §23's last success criterion
— "a future `FlyProvider` can be added without modifying any file under
`src/core/`, `src/db/`, `src/runtime/`, `src/inbox/`, `src/events/`, or
`src/runner/`" — is unverified until at least one remote provider actually
lands. And until *two* land, "the seam is generic" is just "the seam is
Fly-shaped."

**Sketch.** The remote-daemon model: a long-lived `burrow serve` runs on a
host (Fly Machine or SSH'd VPS) per DEPLOY.md's on-host posture. `burrow up
--remote fly` is `POST /burrows` over HTTPS against that daemon's endpoint,
not a fresh Fly Machine boot per burrow. Cold start is paid once at
machine-up, not per `burrow up`. Each remote burrow's workspace is `kind:
'clone'` (no shared filesystem with the caller). User-facing surface stays
identical:

    burrow up                          # local
    burrow up --remote fly             # fly machine
    burrow up --remote my-vps          # named SSH remote
    burrow events --follow             # works the same against any of them

The provider seam splits cleanly into two responsibilities — machine
lifecycle and daemon binding:

- `LocalProvider`: no lifecycle (`$localhost`); spawn or attach local
  `burrow serve`.
- `FlyProvider`: lifecycle = ensure a Fly Machine exists for this user;
  binding = HTTPS to that machine.
- `SshProvider`: no lifecycle (user already deployed per DEPLOY.md);
  binding = HTTPS to user's registered host.

`SshProvider` is essentially a *registration*: `burrow login ssh
https://my-vps --token …` records a named remote, and everything downstream
is shared `HttpClient` + URL code. Shipping Fly + SSH together is the
load-test — anything Fly-specific that leaks past the lifecycle boundary
will fail to compile against `SshProvider`.

Acceptance bar: both providers land without modifying any file under
`src/core/`, `src/db/`, `src/runtime/`, `src/inbox/`, `src/events/`, or
`src/runner/` (SPEC §23's last criterion made load-bearing).

**Decisions made (2026-05-08 design discussion).**
- **Interpretation A (remote daemon), not B (per-burrow Fly Machine).** One
  machine = one daemon = many burrows. Per-burrow Fly Machine boot is a
  future scale-out layer on top, not the same product.
- **Primary consumer is warren-on-Fly.** Solo-user `burrow up --remote fly`
  from a laptop is supported but not the dominant case. Tilts the design
  toward persistent-machine, not ephemeral.
- **Fly + SSH ship together.** Fly-only doesn't actually test "the seam is
  generic." Generic-SSH provider rides on the same daemon-binding code as
  Fly with no machine lifecycle of its own.
- **Workspace seeding goes through R-07's API**, not direct-disk writes.
  Warren's current shared-fs reach into burrow's workspace path is a
  co-location accident; R-02 cannot rely on it.

**Open questions.**
- Credential delivery to the remote machine — for warren-on-Fly, per-machine
  via Fly secrets (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`); per-burrow override
  is V2. Confirm.
- Auth from local CLI to remote daemon — bearer token identical to local
  `BURROW_API_TOKEN`, stored under a named profile in
  `~/.config/burrow/remotes.toml` (think `git remote`). `burrow login fly`
  and `burrow login ssh` populate it.
- Fly app provisioning — does FlyProvider create the Fly app on first use,
  or does the user run `fly launch` against a published burrow image and we
  attach? Lean attach-only for V1 (matches DEPLOY.md's "you provision the
  host"); add provisioning later as a convenience.
- Per-user tenancy on the Fly machine — one machine = one warren = many
  burrows is the model. Multi-tenanting a single Fly machine across warrens
  is explicitly out of scope.

---

## R-03 — `burrow snapshot` / `burrow restore`
Status: [proposed]
Depends on: —
Unlocks: time-travel debugging; reproducible "rewind to before the agent broke
this" workflows

**Problem.** Today a botched agent run leaves the workspace in whatever state
the agent reached. The user's recovery options are git-level (`git reset
--hard`) or destroy-and-recreate. Neither captures "the burrow at minute 7" in
a way you can re-spawn an agent against.

**Sketch.** Versioned workspace snapshots, tied to the burrow id. `burrow
snapshot <id> [--label NAME]` captures workspace + relevant DB state (runs,
events tail, messages in flight). `burrow restore <id> --to <snapshot>`
rewinds. Snapshots stored under `${dataDir}/snapshots/<burrow-id>/<snapshot-id>/`.

In-memory snapshots of a *running* agent (fork-of-running-state) stay V2+ —
SPEC §3.2 already excludes that. R-03 is the workspace-on-disk story.

**Open questions.**
- Storage shape: tarball, git ref under a hidden namespace, or content-addressed
  blob store?
- Retention policy — keep N most recent, prune-by-age, or manual-only?
- Does a snapshot restore reset the burrow's event log, or branch it the way
  `burrow fork` does?

---

## R-04 — Toolchain auto-install (mise / asdf integration)
Status: [proposed]
Depends on: —
Unlocks: zero-host-setup onboarding; closes SPEC §19's "V2 may introduce mise /
asdf integration" pointer

**Problem.** V1 toolchains live on the host. `burrow doctor` verifies them but
won't install. A new IC joining a project with a `burrow.toml` declaring
`bun = "1.1"` and `python = "3.12"` still has to install both before
`burrow up` succeeds.

**Sketch.** Detect the user's toolchain manager (mise → asdf → fnm → nvm) and
run its install command for missing entries before mounting toolchain bin dirs
into the sandbox. `burrow doctor --install` (or `--fix` if the existing flag
covers it) opts in. The sandbox itself stays clean — toolchains still install
to the host's manager, then mount read-only as today.

**Open questions.**
- Default behavior: silently install on `burrow up`, prompt, or require explicit
  `--install`? Probably prompt, since installing language runtimes is not free.
- Order of preference when multiple managers are detected.
- Per-project pinning: defer to the manager's own pin file (`.tool-versions`,
  `mise.toml`) when present; `burrow.toml: [toolchain]` is the override.

---

## R-05 — `burrow ship` target plugins
Status: [proposed]
Depends on: V1 `burrow ship` (shipped, SPEC §22 Phase 9)
Unlocks: org-internal deploy targets without forking burrow

**Problem.** V1 ships three first-class `ShipTarget`s — `fly`, `docker`,
`tarball` — chosen specifically to stress-test the interface across shape,
lifecycle, and real-world deploy. The interface holds, but `[ship].default_target`
is schema-locked to those three (mulch record `mx-966e8b`). Adding a 4th
target — internal registry, k8s deploy, S3 upload — currently requires forking.

**Sketch.** Discovery model parallel to mulch's R-04 (provider plugin registry,
shipped 2026-05-06):

1. **Filesystem convention:** `.burrow/ship-targets/<name>.{ts,sh}` auto-discovered.
2. **npm convention:** `burrow-ship-target-<name>` exports a `ShipTarget`.

`[ship].default_target` validates against the union of built-ins + discovered
targets. `burrow ship --list` surfaces sources and shadowed built-ins.

**Open questions.**
- Sandboxing for arbitrary shell ship-targets — same trust model as user-defined
  agents (`AgentConfig`, SPEC §12.3): users own what they install.
- Versioning — npm targets carry semver via package.json; filesystem targets
  pin to whatever's at the path.
- Whether the V1 built-ins move out of core into shipped target files, leaving
  the registry as just a loader (the natural follow-up; mulch's R-04 deferred
  this same step).

---

## R-06 — Substrate integration with Overstory and Mycelium
Status: [proposed]
Depends on: stable `burrow serve` API (shipped, SPEC §27)
Unlocks: agents dispatched into burrows from upstream orchestrators; replaces
overstory/mycelium's tmux dispatch with sandboxed burrows

**Problem.** Today overstory and mycelium dispatch agents into tmux sessions on
the host. The host has no isolation; a botched agent can touch the user's real
filesystem. Burrow exists to fix exactly that, but the upstream tools haven't
adopted it as their substrate yet.

**Sketch.** Overstory and mycelium consume burrow's HTTP API (SPEC §27) instead
of spawning tmux. A run dispatched from overstory becomes a `POST /runs` against
a burrow's serve socket; events stream back over `GET /runs/:id/stream`.
Burrow's CLI/API stays unchanged; consumption is purely additive on the upstream
side.

Acceptance bar: overstory's `ov dispatch` and mycelium's equivalent can target
either tmux (legacy) or burrow (new) via config, with no per-tool changes in
burrow.

**Open questions.**
- Whose repo owns the dispatcher glue — burrow client library vs. an
  overstory/mycelium adapter consuming `HttpClient`?
- Migration story — flag-gated rollout per project, or an `ov.toml`
  `runtime = "burrow"` opt-in?
- Whether warren (the control plane this work feeds) needs anything beyond
  what `burrow serve` already exposes.

---

## R-07 — Workspace-seed HTTP API
Status: [proposed]
Depends on: —
Unlocks: warren stops reaching into burrow's workspace path via shared
filesystem; prerequisite for R-02 (remote burrows have no shared disk to
reach into)

**Problem.** Warren's current run-spawn flow seeds the burrow workspace by
writing directly to `burrow.workspacePath` from disk — three drops
(`.canopy/agent.json`, `.mulch/expertise/*.jsonl`, `.seeds/workflow.txt`,
all in `warren/src/runs/seed.ts`). This works today only because warren
and burrow are co-tenanted in one container and share `/data`. The moment
burrow runs on a different host (R-02), those writes break — there is no
shared filesystem. Warren's own SPEC §11.A even waves at it: "invokes `ml
record` inside the burrow workspace via `burrow exec` (or equivalent)."
That equivalent doesn't exist.

The smell predates remote: even co-tenanted, warren has no API contract for
"put files in a burrow's workspace." It reaches past the seam onto disk.
Every other warren↔burrow path is HTTP with a typed contract; this one
isn't.

**Sketch.** Add a workspace-mutation surface to burrow's HTTP API. Two
shapes, both probably wanted:

1. **Provision-time seed payload.** `POST /burrows` accepts an optional
   `seed: { files: [{ path, mode?, contents }, ...] }`. Files written into
   the new workspace before the burrow returns. Atomic with provisioning,
   no second round-trip — covers warren's "all three files known at
   provision" case in one shot.
2. **Post-provision file API.** `POST /burrows/:id/files` with the same
   envelope. Allows seeding after provisioning, top-up mid-run, and covers
   any future use case the provision-time path doesn't.

Path validation: writes constrained to within `workspacePath`; no symlink
escape; no overwrite of paths burrow owns (`.git/`, sandbox metadata,
etc.). Warren consumes via `HttpClient.burrows.create({ ..., seed })` and
deletes the disk-writing code in `src/runs/seed.ts`. Once R-07 is shipped,
warren's seed code path is the same local and remote.

**Open questions.**
- Read side. Warren's reap step (§11.A) also reads `<burrow-workspace>/
  .mulch/expertise/*.jsonl` off disk. Does R-07 include `GET
  /burrows/:id/files?path=…`, or is that a separate item? Lean include —
  same shape, same constraints, ships warren a complete remote-capable
  seed/reap loop.
- Binary content. Base64-encode in JSON, or accept multipart? JSON-with-
  base64 is simpler and covers the only known consumer (text); multipart
  is the right answer if anyone ever wants to seed a tarball.
- Quota / size limits. Provision-time seeds shouldn't be unbounded. A 10
  MB cap per call and 1 MB per file seems fine for everything warren
  actually seeds today.
- Whether warren switches over before R-02 ships. Argument for: warren
  stops violating the seam contract immediately, and R-02 inherits a
  battle-tested API. Argument against: nothing's broken today. Lean
  immediate switchover — the whole point of carving R-07 out is to load-
  test the API with a real consumer well before R-02 arrives.

---

## Decisions already made

Choices locked in during prior design discussions. Captured here so they aren't
relitigated when items become seeds issues.

- **Linux is canonical, macOS is best-effort + thin permission filter**
  (burrow-0fab Q1). End goal is swarms of agents in cloud-deployed Linux
  containers; macOS stays as developer-ergonomics mode. Synthesizing bwrap
  parity on macOS via DYLD/wrapper tricks is rejected.
- **No host /tmp deny on macOS in V1** (burrow-0fab Q2). Blocked on (a)
  claude-code hardcoding /tmp and ignoring `$TMPDIR` (upstream issue, was
  burrow-fbdf), and (b) sandbox-exec having no bind-mount primitive. Linux
  already private-tmpfs's /tmp via bwrap. Revisit when the upstream lands.
- **Best-effort accommodation for shipped agents; user-spawned binaries accept
  collision and document** (burrow-0fab Q3).
- **Ergonomic profile only in V1; no `strict` knob** (burrow-0fab Q4). Splitting
  the profile adds complexity without buying real isolation given Q1.
- **Userspace HTTP proxy for restricted-network enforcement** over IP-resolution
  and port-only options (mulch decision `mx-d6a44f`). Resolved SPEC §25 Q2.
- **Phase 9 ship V1 targets are fly + docker + tarball, not fly + render**
  (mulch decision `mx-ef364e`). The second/third targets exist primarily to
  prove the `ShipTarget` interface is genuinely generic.
- **`BurrowProvider` is the single load-bearing seam** (SPEC §3.3). Tenant id,
  Storage interface, Queue interface, queue_jobs table — none of those survive.
- **JSONL/SQLite-in-WAL is non-negotiable.** Every item assumes the storage
  substrate stays.

## Cross-cutting themes

Threads that run through multiple items.

- **Remote substrate (R-01, R-07, R-02, R-06).** R-01 picks the deploy
  posture, R-07 closes the workspace-mutation contract gap that warren is
  papering over with shared-filesystem writes, R-02 proves the
  `BurrowProvider` seam (Fly + SSH, in tandem), R-06 lets upstream tools
  consume the result. Sequence so each one's foundation is real before the
  next consumes it.
- **Plugin registries (R-05, parallels mulch R-04).** Burrow already takes user
  extension via `[[agents]]`; ship targets are the next surface. Future
  registries (sandbox profiles? secret resolvers?) should follow the same
  discovery shape.
- **The seam load-test (R-02).** Until a second `BurrowProvider` actually
  exists, SPEC §23's last success criterion ("a future `FlyProvider` can be
  added without modifying any file under `src/core/`...") is unverified.

## Recently shipped

Cross-references to closed work that maps onto post-V1 direction. Tracked here
so subsequent revisions know what's already off the punch list.

- **R-01 deploy posture — [DEPLOY.md](DEPLOY.md)** (burrow-9986). On-host is
  the production default; in-pod is acceptable for self-managed / single-tenant
  / dev-CI postures with the four-flag bwrap recipe (`mx-94901b`, `mx-c085ba`).
  Reference systemd unit + Fly Machine config + Caddy reverse-proxy snippet
  included. Unblocks R-02 substrate decision (Fly Machines = on-host) and gives
  warren / overstory / greenhouse a single canonical link for deploy guides.
- **`burrow watch` (TUI dashboard) — 0.2.0.** Multi-burrow live view; pure
  `DashboardSnapshot` builder + reducer + renderer with golden tests.
  Self-describes via SPEC §26's additive-only versioning lock. Seeds:
  burrow-304b → burrow-77bd / -95b0 / -db7a / -0a39 / -584b / -5c0b / -fd72 / -1a43.
- **`burrow serve` (HTTP API) — 0.3.0** (SPEC §27, seed `burrow-1d64`, plan
  `pl-5b40`). Routes mirror the `Client` namespaces 1:1; streaming surfaces
  emit NDJSON over chunked HTTP byte-for-byte equal to `--json` CLI output.
  Unix socket primary, localhost TCP opt-in, bearer auth from
  `BURROW_API_TOKEN`. `HttpClient` mirrors the namespace surface so consumers
  swap transports without touching call sites.
- **OpenAPI self-description — 0.3.x** (mulch pattern `mx-f5d9c8`). A running
  `burrow serve` exposes its full contract at `GET /openapi.json` (auth
  required) + Scalar-rendered `GET /openapi.html` (auth-exempt). Hand-authored
  source `src/server/openapi/spec.ts`; golden file locks the wire shape.
- **Run cancellation split (`burrow-6739`).** `POST /runs/:id/cancel`
  (graceful, idempotent on terminal runs, emits `run_cancelled` event) is
  separate from `DELETE /runs/:id` (record removal post-completion, cascades
  to `events.run_id`).
- **Userspace HTTP proxy for restricted networks** (mulch `mx-d6a44f`).
  Resolved SPEC §25 Q2 — chosen over IP-resolution-at-up-time and port-only
  options for portability across distros. nftables remains a future opt-in.
- **Generic toolchain bin-dir symlink walk + `[sandbox] read_only_paths`
  escape hatch** (burrow-a1b1, mulch `mx-25becd` / `mx-b673da`). Resolved
  SPEC §25 Q3 directionally — burrow follows symlinks in each declared
  toolchain's bin dir and contributes either `dirname(realpath)` or the
  declared `read_only_paths` to the sandbox mount set. Full
  `sandbox.toolchain_mode = "shim-aware"` opt-in is no longer needed in
  practice.
- **Linux-canonical devcontainer for local dev** (burrow-1c19). Lets macOS
  contributors opt into real bwrap isolation locally; same artifact shape as
  eventual deploy. Image satisfies the dual contract (mulch `mx-20f3b1`):
  every `[toolchain]` binary present, sandbox primitives functional.

## Suggested sequencing

A first cut at order of attack — not committed:

1. ~~**R-01** (deploy posture)~~ — shipped, see [DEPLOY.md](DEPLOY.md).
2. **R-07** (workspace-seed HTTP API) — small, immediately consumed by
   warren, prerequisite for R-02. Carves the workspace-mutation contract
   out of R-02 so a real consumer load-tests it ahead of remote work.
3. **R-02** (FlyProvider + SshProvider together) — first remote
   `BurrowProvider`s; the seam's load-bearing test. Fly Machines map to
   on-host posture per R-01; SSH provider keeps the seam from going
   Fly-shaped.
4. **R-04** (toolchain auto-install) — orthogonal to remote work; valuable
   for solo and team onboarding without blocking R-02.
5. **R-06** (overstory/mycelium integration) — once R-02 is shipped,
   upstream tools have a substrate worth migrating to. Warren is already
   proving the pattern via burrow's HTTP API + `HttpClient`.
6. **R-05** (ship target plugins) — incremental once `burrow ship`'s
   interface is exercised by a fourth, user-supplied target.
7. **R-03** (snapshot / restore) — defer until V1 + R-02 are stable enough
   that "rewind a burrow" is a meaningful operation rather than rare
   polish.
