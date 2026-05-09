/**
 * Linux: render a `bwrap` argv from a SandboxProfile + SpawnCommand (SPEC §8.1).
 *
 * The host file system is invisible by default (`--unshare-all`, no mounts);
 * we then explicitly admit the system directories needed for typical
 * toolchains, the workspace (read-write at /workspace), declared toolchain
 * paths, and an optional SSH agent socket. Env is wiped before being rebuilt
 * from `envPassthrough` + `setEnv` + per-command overrides so host secrets
 * don't leak unless declared.
 *
 * Network policy:
 *   - "open"       — share the host net namespace (`--share-net`).
 *   - "none"       — no network at all (no `--share-net`).
 *   - "restricted" — share the host net namespace so the agent can reach the
 *     host-side userspace proxy on loopback (the proxy enforces the domain
 *     allowlist). The agent's HTTP_PROXY/HTTPS_PROXY env points at that
 *     proxy. This is honor-system enforcement — a non-HTTP-aware tool can
 *     still reach the host network — until the netns + nftables work in
 *     SPEC §25 lands. With `proxyAddress` unset we fall back to deny-all
 *     (no `--share-net`) so callers can declare intent today.
 */

import type { SandboxProfile, SpawnCommand } from "../types.ts";
import { resolveSandboxEnv } from "./env.ts";

export const SYSTEM_RO_MOUNTS: readonly string[] = [
	"/usr",
	"/etc",
	"/lib",
	"/lib64",
	"/bin",
	"/sbin",
	"/opt",
];

/**
 * Default uid/gid the sandboxed process runs as when `SandboxProfile.runAsUid`
 * / `runAsGid` aren't set. Anything non-zero would do — 1000 is the conventional
 * "first interactive user" id and what most distro images use, so workspace
 * tooling that hardcodes uid==1000 (e.g. /home/user paths) keeps working.
 */
export const DEFAULT_SANDBOX_UID = 1000;
export const DEFAULT_SANDBOX_GID = 1000;

export interface BuildBwrapOptions {
	/** Used to resolve `envPassthrough` names. Defaults to `process.env`. */
	hostEnv?: Record<string, string | undefined>;
	/** Override the bwrap binary (testing or non-PATH installs). */
	bwrapBin?: string;
}

export function buildBwrapArgv(
	profile: SandboxProfile,
	command: SpawnCommand,
	options: BuildBwrapOptions = {},
): string[] {
	const argv: string[] = [options.bwrapBin ?? "bwrap"];

	argv.push("--unshare-all");
	if (profile.network === "open") argv.push("--share-net");
	else if (profile.network === "restricted" && profile.proxyAddress) argv.push("--share-net");
	argv.push("--die-with-parent");

	// Force the sandboxed pid 1 to a non-root uid/gid inside the userns. Without
	// this the new userns inherits the caller's uid mapping; when burrow runs
	// as host root (e.g. warren's Dockerized posture) the agent sees
	// getuid()==0 and tooling like claude-code refuses to run.
	argv.push("--uid", String(profile.runAsUid ?? DEFAULT_SANDBOX_UID));
	argv.push("--gid", String(profile.runAsGid ?? DEFAULT_SANDBOX_GID));

	argv.push("--proc", "/proc");
	argv.push("--dev", "/dev");
	argv.push("--tmpfs", "/tmp");

	for (const path of SYSTEM_RO_MOUNTS) {
		argv.push("--ro-bind-try", path, path);
	}

	for (const path of profile.toolchainPaths) {
		argv.push("--ro-bind", path, path);
	}

	if (profile.sshAuthSock) {
		argv.push("--ro-bind", profile.sshAuthSock, profile.sshAuthSock);
	}

	for (const path of profile.readOnlyMounts) {
		argv.push("--ro-bind", path, path);
	}

	argv.push("--bind", profile.workspace, "/workspace");

	const cwd = resolveCwd(command.cwd);
	argv.push("--chdir", cwd);

	argv.push("--clearenv");
	const env = resolveSandboxEnv(profile, command, {
		homePath: "/workspace",
		hostEnv: options.hostEnv ?? process.env,
	});
	for (const [name, value] of Object.entries(env)) {
		argv.push("--setenv", name, value);
	}

	argv.push("--", ...command.argv);
	return argv;
}

function resolveCwd(cwd: string | undefined): string {
	if (!cwd) return "/workspace";
	if (cwd.startsWith("/")) return cwd;
	return `/workspace/${cwd}`;
}
