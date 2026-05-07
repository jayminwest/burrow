/**
 * SSH agent passthrough (SPEC §18.1).
 *
 * The host's SSH_AUTH_SOCK is forwarded into the burrow as a read-only mount,
 * giving the agent inside access to the keys the user has loaded without
 * exposing key files. We never copy private keys.
 */

import { statSync } from "node:fs";

export interface SshAgentPassthrough {
	/** Absolute path of the host's SSH agent socket. */
	socketPath: string;
}

export interface DetectSshAgentOptions {
	env?: Record<string, string | undefined>;
}

/**
 * Detect a usable host SSH agent socket. Returns null when SSH_AUTH_SOCK is
 * unset, points at a missing path, or points at a non-socket; callers fall
 * back to no-passthrough rather than failing — see SPEC §18.
 */
export function detectSshAgent(options: DetectSshAgentOptions = {}): SshAgentPassthrough | null {
	const env = options.env ?? process.env;
	const sock = env.SSH_AUTH_SOCK;
	if (!sock) return null;
	try {
		const st = statSync(sock);
		if (!st.isSocket()) return null;
	} catch {
		return null;
	}
	return { socketPath: sock };
}
