# AGENTS.md

This file is the canonical entry point for AI coding agents working in
`burrow`, following the [agents.md](https://agents.md) convention.

## Mission

`burrow` — OS-isolated sandbox runtime for coding agents.

Burrow wraps untrusted agent processes in OS-level sandboxes — `bwrap` on
Linux, `sandbox-exec` on macOS — with no Docker and no daemon. Its single
most important guarantee is that a sandboxed agent cannot read or write
outside the filesystem scopes the operator granted it. Sessions and events
persist in SQLite via `bun:sqlite`.

Burrow is part of the [os-eco](https://github.com/jayminwest) ecosystem: it
is the substrate sandbox primitive that warren (the cloud control plane)
embeds per run, and it works standalone via the `burrow` / `bw` CLI.
`SPEC.md` is the frozen V1 design record; `ROADMAP.md` is the punch list of
forward-looking `R-NN` items.

## Commands

All commands run from the repo root. Bun must be on PATH.

```bash
bun install                   # install dependencies
bun test                      # run all tests
bun test src/foo.test.ts      # run a single test file
bun run lint                  # biome check --error-on-warnings .
bun run lint:fix              # biome check --write .
bun run typecheck             # tsc --noEmit
bun run check:all             # full quality-gate suite (see below)
bun run verify                # alias for check:all (agent-facing entry point)
bun run check:coverage        # tests + coverage-floor ratchet
```

The user-facing CLI entry points:

```bash
bw --help                     # CLI top-level help
bw up                         # start a sandboxed session
```

### Quality gates

`bun run check:all` (quiet runner, `scripts/check-all.ts`) runs every gate
CI also enforces, in canonical order:

- `lint` — `biome check --error-on-warnings .` (warnings fail)
- `typecheck` — `tsc --noEmit`
- `check:agents` — `scripts/validate-agents-md.ts` (this file's references)
- `check:dups` — `bunx jscpd` (duplicate-code detector, `.jscpd.json`)
- `check:deps` — `knip --dependencies` (unused / undeclared deps, `knip.json`)
- `check:size` — `scripts/check-file-sizes.ts` (line-count ratchet)
- `check:debt` — `scripts/check-debt-markers.ts` (tracker-pinned TODOs)
- `check:coverage` — `scripts/check-coverage.ts` (coverage-floor ratchet)
- `check:ci-parity` — `scripts/check-ci-parity.ts` (CI ⇄ check:all parity)

Each ratchet reads a JSON budget under `scripts/`
(`scripts/file-size-budgets.json`, `scripts/debt-markers-budget.json`,
`scripts/coverage-budgets.json`). Budgets ratchet in one direction only
(file-size and debt-markers tighten downward; coverage tightens upward). Do
not loosen a budget without filing a `burrow-XXXX` seed and noting it in
the commit body.

`scripts/check-all.ts` and `scripts/check-ci-parity.ts` are byte-identical
to the fleet templates (see docs/check-all-standard.md at the os-eco
root) — never edit them in place; per-repo variation lives in
`package.json` script bodies only.

## Conventions

### Filenames & directories

- Source files: kebab-case (`*.ts`). Tests are `<name>.test.ts` next to
  the file under test.
- Directories: `kebab-case`.
- TOML config keys stay `snake_case` to match upstream schemas
  (`burrow.toml`).

### TypeScript

- Strict mode with `noUncheckedIndexedAccess` — always handle possible
  `undefined` from indexing.
- No `any`; use `unknown` and narrow.
- Shared types live in per-module types files (e.g. `src/core/types.ts`,
  `src/server/types.ts`).
- Import with `.ts` extensions.
- Tab indentation, 100-char line width (Biome enforces via `biome.json`).

### Debt markers

Every `TODO` / `FIXME` / `HACK` / `XXX` on a source line must carry a
tracker reference on the same line. Accepted prefixes:

- `burrow-XXXX` — repo-local seeds tracker
- `pl-XXXX` — seeds plan IDs
- `mx-XXXX` — cross-repo mission tracker
- `#NNN` — GitHub issue
- A URL (any http link) — external reference

`scripts/check-debt-markers.ts` fails CI on bare markers.

### Version management

The version lives in two places, kept in sync by
`scripts/version-bump.ts` and verified by the publish workflow:
`package.json` (`"version"`) and `src/index.ts` (`const VERSION`). Bump
via `bun run version:bump` with `major|minor|patch`.

### Log scrubbing

Burrow logs structured events via pino. Any logger must redact sensitive
keys (`token`, `api_key`, `password`, `secret`, `authorization`). Add new
redact paths in the same commit that introduces a new sensitive field.

## Agent Workflow

When an agent works in `burrow`, it should:

1. **Prime context.** Read this file, `SPEC.md` for design rationale, and
   the most recent `CHANGELOG.md` entry. Run `ml prime` (Mulch) and
   `sd prime` (Seeds) if available.
2. **Find unblocked work.** `sd ready` (Seeds) or `gh issue list`.
3. **Make focused changes.** One concern per commit. Preserve existing
   conventions — adapt, don't overwrite.
4. **Run gates locally.** `bun run verify` must exit 0 before commit.
5. **Pin debt markers.** Any new `TODO` / `FIXME` must reference a tracker
   id created in the same change.
6. **Commit & sync.** Commit message follows `<area>: <summary>` (e.g.
   `quality: ratchet file-size cap`).
7. **Record insights.** `ml record` any convention discovered or failure
   encountered, then `ml sync`.

### Session completion protocol

Before ending a session:

1. File issues for remaining work (`sd create`).
2. Run `bun run check:all`.
3. Close finished issues (`sd close`).
4. Record session insights (Mulch).
5. Push: `sd sync && git push`, then verify `git status` is clean.

## Testing & Validation Guidance

### Per-change verification

After every code change (before commit):

```bash
bun run check:all
```

It must exit 0. CI runs the same suite — local greens are the contract,
and `check:ci-parity` proves CI cannot drift from it.

### Coverage discipline

`bun run check:coverage` enforces `scripts/coverage-budgets.json`. The
ratchet only goes **up**. Raising a floor when coverage improves is
encouraged; lowering one requires a `burrow-XXXX` reference in the commit
body explaining what tests were removed and why.

### Tests live under `src/`

Tests are co-located: new tests belong next to the file under test with
the `*.test.ts` suffix. Toolkit ratchet scripts under `scripts/` carry
co-located `*.test.ts` suites too.

### CI parity

`.github/workflows/ci.yml` runs `bun run check:all`. Local `check:all`
failures will break CI; do not push hoping CI will pass.

## Further reading

- `SPEC.md` — frozen V1 design record
- `ROADMAP.md` — forward-looking `R-NN` punch list
- `README.md` — user-facing pitch + install instructions
- `CHANGELOG.md` — release history
- `CONTRIBUTING.md` — contribution guidelines
- `SECURITY.md` — security policy
- `scripts/` — ratchet scripts and budgets
- `.github/workflows/` — CI + publish + auto-merge workflows
