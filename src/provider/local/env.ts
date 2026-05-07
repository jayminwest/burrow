/**
 * Resolve the env a sandboxed process actually sees: a hardened baseline
 * (HOME, PATH) layered with declared host passthrough, an SSH_AUTH_SOCK
 * derived from the profile when present, profile setEnv overrides, and
 * finally per-command env. Used by both the bwrap and seatbelt wrappers so
 * they stay symmetric.
 */

import type { SandboxProfile, SpawnCommand } from "../types.ts";

export interface ResolveEnvOptions {
	/** "/workspace" inside bwrap; the host workspace path on macOS. */
	homePath: string;
	/** Used to resolve `envPassthrough` names. */
	hostEnv: Record<string, string | undefined>;
}

export function resolveSandboxEnv(
	profile: SandboxProfile,
	command: SpawnCommand,
	options: ResolveEnvOptions,
): Record<string, string> {
	const out: Record<string, string> = {
		HOME: options.homePath,
		PATH: "/usr/bin:/bin",
	};

	for (const name of profile.envPassthrough) {
		const value = options.hostEnv[name];
		if (value !== undefined) out[name] = value;
	}

	if (profile.sshAuthSock) {
		out.SSH_AUTH_SOCK = profile.sshAuthSock;
	}

	for (const [name, value] of Object.entries(profile.setEnv)) {
		out[name] = value;
	}

	if (command.env) {
		for (const [name, value] of Object.entries(command.env)) {
			out[name] = value;
		}
	}

	return out;
}
