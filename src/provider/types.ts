/**
 * Sandbox + spawn contracts shared by the bwrap and sandbox-exec wrappers
 * (SPEC §8.3, §9). These are the inputs to a one-shot sandboxed invocation;
 * the BurrowProvider interface that consumes them lands in a later phase.
 */

export const NETWORK_POLICIES = ["none", "restricted", "open"] as const;
export type NetworkPolicy = (typeof NETWORK_POLICIES)[number];

export interface SandboxProfile {
	/** Workspace root, bound read-write inside the sandbox. */
	workspace: string;
	/** Additional host paths to mount read-only (e.g. toolchain shared libs). */
	readOnlyMounts: string[];
	network: NetworkPolicy;
	/** Domains permitted under `network: "restricted"`. */
	allowedDomains: string[];
	/** Names of host env vars to forward unchanged. */
	envPassthrough: string[];
	/** Env overrides that take precedence over passthrough. */
	setEnv: Record<string, string>;
	/** Resolved host paths to language toolchain binaries (mounted read-only). */
	toolchainPaths: string[];
	/** Host path of the SSH agent socket to forward, if any. */
	sshAuthSock?: string;
	timeoutMs?: number;
	memoryLimitMb?: number;
	cpuLimit?: number;
	/**
	 * Loopback endpoint of the per-burrow proxy that gates outbound traffic
	 * under `network = "restricted"`. Set by the run dispatcher right before
	 * `runSandboxed` (not persisted on the burrow row): the proxy is bound
	 * to a kernel-assigned port for each run, and the seatbelt/bwrap profile
	 * builders use this to allow only loopback to that exact endpoint.
	 */
	proxyAddress?: { host: string; port: number };
	/**
	 * Linux only: uid the sandboxed process runs as inside the userns
	 * (`bwrap --uid`). Defaults to a non-root constant (1000). The host's
	 * uid is remapped via `uid_map` so workspace files owned by the caller
	 * appear as this uid inside. Override only when the caller has a
	 * specific reason — e.g. matching the uid of an existing image's user.
	 *
	 * Required (in spirit): without `--uid`, the userns inherits the host's
	 * caller uid. When burrow runs as root (e.g. inside a Docker container
	 * without an explicit USER), the agent sees `getuid() == 0` and tools
	 * like claude-code refuse to run.
	 */
	runAsUid?: number;
	/** Linux only: gid the sandboxed process runs as. Defaults to 1000. */
	runAsGid?: number;
	/**
	 * Host path of the parent clone's `.git` common dir, bound read-write at
	 * the same path inside the sandbox. Set when `MaterializedWorkspaceSource`
	 * is `kind: "worktree"` (`up` / `fork` derive it from
	 * `MaterializedWorkspaceSource.gitCommonDir`).
	 *
	 * `git worktree add` writes the worktree's `.git` *file* with an absolute
	 * `gitdir:` pointer at `<gitCommonDir>/worktrees/<id>`; that path lives
	 * outside the workspace bind, so without this mount every git invocation
	 * inside the sandbox fails with `fatal: not a git repository` and the
	 * agent can't commit or push its own work (burrow-7a80). It's read-write
	 * because git needs to update per-worktree HEAD/index plus write new
	 * objects into the shared object database when committing.
	 */
	workspaceGitdir?: string;
}

export interface SpawnCommand {
	argv: string[];
	/** Working directory, relative to the workspace. Defaults to "/workspace". */
	cwd?: string;
	/** Extra env merged on top of the profile's resolved env. */
	env?: Record<string, string>;
	stdin?: ReadableStream<Uint8Array> | string;
	timeoutMs?: number;
	/**
	 * When true, the sandbox writes `stdin` (if a string) but does NOT close
	 * the write side. The caller drains stdout, then invokes
	 * `SpawnResult.closeStdin()` once it has observed whatever signal
	 * indicates the child is done consuming input (e.g. pi's `agent_end`
	 * event — mx-d9b3ad). Runtimes whose CLI exits the instant stdin closes
	 * mid-inference must set this; runtimes that rely on stdin EOF to flush
	 * their final output (e.g. claude-code `--print`) must not. Default
	 * false (current behavior — write+end at spawn time).
	 */
	holdStdin?: boolean;
}

export interface SpawnResult {
	pid: number;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	/** Resolves with the child's exit code once it terminates. */
	exited: Promise<number>;
	/** Kill the child and clean up sandbox-side temp state. Idempotent. */
	cancel(): void;
	/**
	 * Idempotent. Closes the child's stdin write side. Only meaningful when
	 * the command was sent with `holdStdin: true` — otherwise stdin was
	 * already ended at spawn time and this call is a no-op.
	 */
	closeStdin?: () => Promise<void>;
}
