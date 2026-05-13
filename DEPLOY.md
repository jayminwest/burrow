# Deploy

Production deployment guide for `burrow serve`. Local single-machine use needs none of this — `bun install -g @os-eco/burrow-cli` and you're done. This document is for running burrow as a long-lived daemon that other processes (warren, overstory, mycelium, ad-hoc HTTP clients) drive over its API.

> **Scope.** Linux is the canonical deploy target. macOS is developer ergonomics, not a deploy posture (see [SPEC §8](SPEC.md#8-sandbox-isolation)). Everything below assumes a Linux host or a Linux container.

## TL;DR

- **Default: run `burrow serve` directly on a Linux host.** A VM, Fly Machine, EC2 instance, or bare metal box. No outer container. Modern kernels support unprivileged user namespaces out of the box; bwrap nests cleanly with no admission-policy negotiation.
- **Acceptable: run `burrow serve` inside a container** (Docker, self-managed Kubernetes, single-tenant ECS) **with four security flags.** This is the warren container's posture and the local devcontainer's posture; it works, but the relaxations partly defeat the point of nesting and require a privileged-workload waiver in most multi-tenant clusters.
- **Don't: run `burrow serve` inside a managed multi-tenant pod** (Cloud Run, ECS Fargate with default policy, GKE Autopilot, or any cluster where you can't grant the four flags). The admission policy will reject the workload, and even if it didn't, the four flags relax the outer container further than most multi-tenant clusters tolerate.

## Why on-host is preferred

`bwrap` is the isolation primitive on Linux. It needs `unshare(CLONE_NEWUSER)` to create the burrow's user namespace, plus a few additional kernel capabilities for mount and network setup. On modern Linux hosts that just works. Inside a managed container, the outer runtime's default security profile typically blocks one or more of these:

| Need | Default container blocker | Override |
|---|---|---|
| `unshare(CLONE_NEWUSER)` | Ubuntu 24.04+ ship `kernel.apparmor_restrict_unprivileged_userns=1`; Docker's default AppArmor profile blocks it | `--security-opt apparmor=unconfined` |
| `clone3` shape for new namespaces | Docker's default seccomp profile is mostly fine but blocks specific argument shapes | `--security-opt seccomp=unconfined` |
| Mount `/proc` in the new pid+mount namespace | Container masks `/proc` paths | `--security-opt systempaths=unconfined` |
| Bring up `lo` in the new netns | `RTM_NEWADDR` needs `CAP_NET_ADMIN` (implied by `SYS_ADMIN`) | `--cap-add SYS_ADMIN` |

Any one missing causes a different bwrap failure mode (`EPERM` at `unshare`, `Failed RTM_NEWADDR`, `Can't mount proc on /newroot/proc`, etc.). The four-flag set is the empirically minimum override that lets non-privileged bwrap nest. Verified on Ubuntu 24.04 / Docker 28.4. `--privileged` works too but relaxes the outer container far more than necessary.

In multi-tenant managed Kubernetes / ECS / Cloud Run, granting those four overrides is a privileged-workload waiver in admission policy. It's possible but expensive to negotiate, and it punches a security hole in the outer container that arguably makes the nesting net-negative.

Skip the negotiation: run burrow on the host.

## burrow-on-host (recommended)

A Linux VM, Fly Machine, EC2 instance, or bare metal host. Burrow runs as a systemd service, listens on a unix socket, and is consumed locally (warren co-tenanted on the same host) or over a reverse proxy with TLS termination.

### Prerequisites

- Linux kernel ≥ 5.10 (for stable unprivileged userns).
- `bubblewrap` installed (`apt install bubblewrap`, `dnf install bubblewrap`, etc.).
- `bun` ≥ 1.1 installed system-wide or via a service-account user.
- A non-root user that the daemon runs as (`useradd -r -m burrow`).
- Confirm unprivileged userns works:

  ```bash
  unshare -Ur whoami     # → root if userns works
  bwrap --bind / / --proc /proc true && echo ok
  ```

  If `apparmor_restrict_unprivileged_userns=1` is set on the host, either flip it (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, persisted in `/etc/sysctl.d/`) or install an AppArmor profile that allows it for the burrow user. The host kernel choice is yours; on a single-purpose VM, flipping the sysctl is the simplest answer.

### Reference systemd unit

`/etc/systemd/system/burrow.service`:

```ini
[Unit]
Description=Burrow sandbox runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=burrow
Group=burrow
Environment=BURROW_DATA_DIR=/var/lib/burrow
EnvironmentFile=/etc/burrow/burrow.env       # BURROW_API_TOKEN=...
ExecStart=/usr/local/bin/burrow serve --socket /run/burrow/burrow.sock
RuntimeDirectory=burrow
RuntimeDirectoryMode=0750
StateDirectory=burrow
StateDirectoryMode=0750
Restart=on-failure
RestartSec=5

# Don't sandbox the sandboxer — bwrap needs the kernel surface intact.
# Specifically: NoNewPrivileges + Protect* would block the userns nesting
# burrow itself relies on.

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo install -d -o burrow -g burrow -m 0750 /etc/burrow
sudo install -m 0640 -o burrow -g burrow /dev/stdin /etc/burrow/burrow.env <<< "BURROW_API_TOKEN=$(openssl rand -hex 32)"
sudo systemctl daemon-reload
sudo systemctl enable --now burrow.service
```

The socket lives at `/run/burrow/burrow.sock` (group-readable for `burrow:burrow`). Co-tenanted consumers (warren, an HTTP gateway) run as the same group and connect directly. Cross-host consumers go through a reverse proxy that terminates TLS and forwards to the socket.

### Reference Fly Machine config

`fly.toml` (run as a single Machine, not a multi-instance app):

```toml
app = "burrow-prod"
primary_region = "sjc"

[build]
  image = "ghcr.io/jayminwest/burrow:0.3.0"   # or your own build

[mounts]
  source = "burrow_data"
  destination = "/var/lib/burrow"

[env]
  BURROW_DATA_DIR = "/var/lib/burrow"

[[services]]
  internal_port = 4040
  protocol = "tcp"
  auto_stop_machines = "off"
  auto_start_machines = false
  min_machines_running = 1

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
```

Set the API token as a Fly secret:

```bash
fly volumes create burrow_data --size 20 --region sjc
fly secrets set BURROW_API_TOKEN=$(openssl rand -hex 32)
fly deploy
```

The Fly Machine is a Firecracker VM, not a managed container — bwrap nests without any of the four security flags. Treat the Machine as the host.

## burrow-in-pod (acceptable, with caveats)

Acceptable in:
- Self-managed Kubernetes clusters where you control admission policy and can grant the four flags.
- Single-tenant clusters with no shared-trust constraints (one team, one workload, one cluster).
- Dev / CI environments where the relaxation is fine (the local devcontainer uses this posture — see [README §"Linux dev container"](README.md#linux-dev-container)).
- The warren container ([warren SPEC §5.3](../warren/SPEC.md#53-sandbox-nesting)), which is single-user single-tenant by design.

Not acceptable in:
- Multi-tenant managed Kubernetes / ECS Fargate / Cloud Run / GKE Autopilot.
- Anywhere admission policy is restrictive and not yours to change.
- Any production-swarm posture where the security relaxation would be load-bearing.

### The four flags

Whatever the orchestrator, the four overrides are the same:

```yaml
# docker-compose.yml fragment
services:
  burrow:
    image: ghcr.io/jayminwest/burrow:0.3.0
    security_opt:
      - apparmor=unconfined
      - seccomp=unconfined
      - systempaths=unconfined
    cap_add:
      - SYS_ADMIN
    volumes:
      - burrow_data:/var/lib/burrow
      - /run/burrow:/run/burrow
    environment:
      - BURROW_DATA_DIR=/var/lib/burrow
    env_file: /etc/burrow/burrow.env
    command: ["burrow", "serve", "--socket", "/run/burrow/burrow.sock"]
```

For Kubernetes, the equivalent is a `securityContext` with `capabilities.add: ["SYS_ADMIN"]` plus the AppArmor / seccomp annotations (`container.apparmor.security.beta.kubernetes.io/<name>: unconfined`, `seccompProfile.type: Unconfined`). `systempaths=unconfined` has no Kubernetes equivalent — you typically need a privileged container or a custom kubelet-level workaround. **This is the friction point that pushes most cluster operators toward burrow-on-host.**

## Verification

After deploy, confirm the daemon is healthy and bwrap nests:

```bash
# socket reachable
curl --unix-socket /run/burrow/burrow.sock \
     -H "Authorization: Bearer $BURROW_API_TOKEN" \
     http://localhost/burrows
# → []  (or your existing burrows)

# OpenAPI surface live
curl --unix-socket /run/burrow/burrow.sock \
     -H "Authorization: Bearer $BURROW_API_TOKEN" \
     http://localhost/openapi.json | jq '.info.version'

# end-to-end: provision a burrow against a test repo, run something, destroy
sudo -u burrow burrow doctor
sudo -u burrow git clone https://github.com/your/test-repo /var/lib/burrow/test-repo
sudo -u burrow burrow up --project /var/lib/burrow/test-repo
```

If `burrow up` fails with `bwrap: unshare(CLONE_NEWUSER): Operation not permitted`, the userns gate is closed — recheck the prerequisites. If it fails with `bwrap: Can't mount proc on /newroot/proc`, you're inside a container missing `systempaths=unconfined`.

## Reverse proxy (cross-host access)

`burrow serve` does not terminate TLS or implement multi-user auth. For cross-host access, front it with Caddy / nginx / Fly's edge:

```caddyfile
# Caddyfile, host running on the same machine as burrow.service
burrow.example.com {
  reverse_proxy unix//run/burrow/burrow.sock
}
```

Bearer auth via `BURROW_API_TOKEN` is the only auth gate; it's a single token, no rotation, no per-user scope (see [SPEC §27](SPEC.md#27-http-api-burrow-serve) for the security posture). Multi-user is an explicit non-goal — if you need it, run a control plane like [warren](../warren/SPEC.md) in front of burrow.

## Cross-process dispatch contract

`burrow serve` is a single-process, stateful-per-host worker: the HTTP listener and the run dispatcher live in the same Bun process, sharing the per-host SQLite DB (`$BURROW_DATA_DIR/db.sqlite`, WAL mode). When a remote client (warren, an HTTP gateway, `curl`) POSTs `/burrows/:id/runs`, the dispatcher inside that same process picks the row up off the create-time hook and drives it to a terminal state — `succeeded`, `failed`, or `cancelled` — without any further intervention from the caller. This is what makes burrow viable as the unit of cross-host fan-out: a control plane only has to know how to talk HTTP and observe the run row over `/runs/:id` (or `/runs/:id/stream`); the executor lives with the workspace.

Two operational implications:

- **Don't run two `burrow serve` processes against the same `BURROW_DATA_DIR`.** The dispatcher's startup sweep flips orphaned `running` rows from a previous process to `failed`; a second concurrent process would race the same sweep and risk double-claim. One worker per data dir.
- **Crash recovery is local.** If a worker dies mid-run, the next start sweeps in-flight rows to `failed` (with `errorMessage` recording the orphaned state). A control plane that wants at-least-once execution has to retry by enqueuing a fresh run, not by resurrecting the failed row.

The locked test for this contract is `src/server/dispatcher-cross-process.test.ts` — it spawns `burrow serve` as a real OS subprocess, POSTs a run over TCP, and asserts the row reaches `succeeded` without any in-process help. Cross-host warren topologies depend on this behaviour.

## Decision record

This document supersedes the deploy-posture sections of [SPEC.md §8](SPEC.md#8-sandbox-isolation) and resolves [ROADMAP.md R-01](ROADMAP.md#r-01--prefer-burrow-on-host-over-burrow-in-pod-userns-nesting). The empirical work was done in `burrow-0fab` (the macOS-vs-Linux design discussion); the standalone decision was `burrow-7ba7`; this guide is the executable form.

Related expertise: `mx-94901b`, `mx-c085ba` (the four-flag recipe).
