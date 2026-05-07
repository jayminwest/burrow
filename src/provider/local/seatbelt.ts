/**
 * macOS: render a sandbox-exec (Seatbelt) profile and argv from a
 * SandboxProfile + SpawnCommand (SPEC §8.2).
 *
 * The .sb language is SBPL, a Scheme dialect. We start from `(deny default)`
 * and grant only what's needed: stable system reads (/usr, /System, /Library,
 * /bin, /sbin, /private/etc), the workspace (read+write), declared toolchain
 * paths (literal allow), and an optional SSH agent socket.
 *
 * Network policy:
 *   - "open"       — `(allow network*)`.
 *   - "none"       — no rule (default deny).
 *   - "restricted" — `(allow network-outbound (regex "^.*\\.<dom>"))` per
 *     allowed domain, plus the local mDNSResponder socket so DNS lookups
 *     succeed. This is enforceable on macOS today; the Linux equivalent
 *     waits on the proxy work in SPEC §25.3.
 */

import type { SandboxProfile, SpawnCommand } from "../types.ts";

export const SYSTEM_READ_SUBPATHS: readonly string[] = [
	"/usr",
	"/System",
	"/Library",
	"/bin",
	"/sbin",
	"/private/etc",
	"/private/var/db",
	"/private/var/select",
	"/dev",
];

export interface BuildSeatbeltArgvOptions {
	/** Override the sandbox-exec binary (testing or non-PATH installs). */
	sandboxExecBin?: string;
}

export function buildSeatbeltProfile(profile: SandboxProfile): string {
	const lines: string[] = [];
	lines.push(";; burrow sandbox profile (Phase 1) — see SPEC §8.2");
	lines.push("(version 1)");
	lines.push("(deny default)");

	lines.push("(allow process-fork)");
	lines.push("(allow process-exec)");
	lines.push("(allow signal (target self))");
	lines.push("(allow sysctl-read)");
	lines.push("(allow mach-lookup)");
	lines.push("(allow ipc-posix-shm)");
	lines.push("(allow iokit-open)");
	// stat / getcwd traversal must succeed across the host fs even when data
	// reads are denied — otherwise tools like /bin/sh fail to even resolve cwd.
	lines.push("(allow file-read-metadata)");
	// dyld stats `/` early in process bringup; without this, every spawn aborts.
	lines.push('(allow file-read* (literal "/"))');

	for (const path of SYSTEM_READ_SUBPATHS) {
		lines.push(`(allow file-read* (subpath ${sbString(path)}))`);
	}

	for (const path of profile.toolchainPaths) {
		lines.push(`(allow file-read* (subpath ${sbString(path)}))`);
	}

	for (const path of profile.readOnlyMounts) {
		lines.push(`(allow file-read* (subpath ${sbString(path)}))`);
	}

	lines.push(
		`(allow file-read-data file-read-metadata file-write* (subpath ${sbString(profile.workspace)}))`,
	);

	lines.push('(allow file-write* (subpath "/private/tmp"))');
	lines.push('(allow file-write* (subpath "/private/var/folders"))');

	if (profile.sshAuthSock) {
		lines.push(`(allow file-read* file-write-data (literal ${sbString(profile.sshAuthSock)}))`);
	}

	lines.push(...renderNetworkRules(profile));

	return `${lines.join("\n")}\n`;
}

export function buildSeatbeltArgv(
	profilePath: string,
	command: SpawnCommand,
	options: BuildSeatbeltArgvOptions = {},
): string[] {
	const bin = options.sandboxExecBin ?? "sandbox-exec";
	return [bin, "-f", profilePath, ...command.argv];
}

function renderNetworkRules(profile: SandboxProfile): string[] {
	if (profile.network === "open") return ["(allow network*)"];
	if (profile.network === "none") return [];

	const rules: string[] = [];
	rules.push('(allow network-outbound (literal "/private/var/run/mDNSResponder"))');
	for (const domain of profile.allowedDomains) {
		const escaped = escapeRegexDots(domain);
		rules.push(`(allow network-outbound (regex ${sbString(`^.*\\.${escaped}$`)}))`);
		rules.push(`(allow network-outbound (regex ${sbString(`^${escaped}$`)}))`);
	}
	return rules;
}

function escapeRegexDots(domain: string): string {
	return domain.replace(/\./g, "\\.");
}

/** Quote a string for SBPL: escape backslash and double-quote. */
function sbString(value: string): string {
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escaped}"`;
}
