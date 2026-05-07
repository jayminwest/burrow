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
 *   - "restricted" — currently behaves like "none". Domain-allowlist
 *     enforcement requires the userspace proxy / nftables rules tracked in
 *     SPEC §25.3 and lands in a later phase. Building the profile is
 *     intentional so callers can declare intent today.
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
	argv.push("--die-with-parent");

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
