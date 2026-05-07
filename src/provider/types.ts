/**
 * Sandbox + spawn contracts shared by the bwrap and sandbox-exec wrappers
 * (SPEC §8.3, §9). These are the inputs to a one-shot sandboxed invocation;
 * the BurrowProvider interface that consumes them lands in a later phase.
 */

export type NetworkPolicy = "none" | "restricted" | "open";

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
}

export interface SpawnCommand {
	argv: string[];
	/** Working directory, relative to the workspace. Defaults to "/workspace". */
	cwd?: string;
	/** Extra env merged on top of the profile's resolved env. */
	env?: Record<string, string>;
	stdin?: ReadableStream<Uint8Array> | string;
	timeoutMs?: number;
}

export interface SpawnResult {
	pid: number;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	/** Resolves with the child's exit code once it terminates. */
	exited: Promise<number>;
	/** Kill the child and clean up sandbox-side temp state. Idempotent. */
	cancel(): void;
}
