/**
 * Cross-platform entry point for one-shot sandboxed execution.
 *
 * macOS — write the rendered Seatbelt profile to a `0600` temp file under
 * the system tmp dir, invoke `sandbox-exec -f`, clean up the temp dir when
 * the child exits or is cancelled.
 * Linux — invoke `bwrap` directly; env is injected via `--clearenv` plus
 * `--setenv`, so we don't need a side-channel for it.
 *
 * Returns once the child has been spawned, with live stdout/stderr streams
 * and `exited` for awaiting the exit code. The BurrowProvider work in a
 * later phase wraps this into the public `exec()` surface (SPEC §9).
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../types.ts";
import { buildBwrapArgv } from "./bwrap.ts";
import { resolveSandboxEnv } from "./env.ts";
import { buildSeatbeltArgv, buildSeatbeltProfile } from "./seatbelt.ts";

export interface RunSandboxedOptions {
	/** Override the host platform (testing). Defaults to `process.platform`. */
	plat?: NodeJS.Platform;
	bwrapBin?: string;
	sandboxExecBin?: string;
	/** Defaults to `os.tmpdir()`. Used to host the rendered .sb file on macOS. */
	tmpRoot?: string;
}

export async function runSandboxed(
	profile: SandboxProfile,
	command: SpawnCommand,
	options: RunSandboxedOptions = {},
): Promise<SpawnResult> {
	const plat = options.plat ?? process.platform;
	if (plat === "darwin") return spawnDarwin(profile, command, options);
	if (plat === "linux") return spawnLinux(profile, command, options);
	throw new Error(`burrow sandbox: unsupported platform ${plat}`);
}

async function spawnDarwin(
	profile: SandboxProfile,
	command: SpawnCommand,
	options: RunSandboxedOptions,
): Promise<SpawnResult> {
	// Seatbelt matches against canonical paths — `/var/folders/...` resolves to
	// `/private/var/folders/...` and rules written against the un-resolved form
	// silently miss. Resolve every path the profile binds before rendering.
	const resolved = canonicalizeProfilePaths(profile);

	const tmpDir = mkdtempSync(join(options.tmpRoot ?? tmpdir(), "burrow-sb-"));
	const profilePath = join(tmpDir, "profile.sb");
	writeFileSync(profilePath, buildSeatbeltProfile(resolved), { mode: 0o600 });

	const env = resolveSandboxEnv(resolved, command, {
		homePath: resolved.workspace,
		hostEnv: process.env,
	});
	const argv = buildSeatbeltArgv(profilePath, command, {
		sandboxExecBin: options.sandboxExecBin,
	});
	const cwd = resolveCwd(resolved.workspace, command.cwd);

	const wantsStdin = command.stdin !== undefined;
	const proc = Bun.spawn(argv, {
		cwd,
		env,
		stdin: wantsStdin ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	await writeStringStdin(proc, command.stdin);

	let cleanedUp = false;
	const cleanup = (): void => {
		if (cleanedUp) return;
		cleanedUp = true;
		rmSync(tmpDir, { recursive: true, force: true });
	};
	const exited = proc.exited.finally(cleanup);

	return {
		pid: proc.pid,
		stdout: proc.stdout as ReadableStream<Uint8Array>,
		stderr: proc.stderr as ReadableStream<Uint8Array>,
		exited,
		cancel: () => {
			proc.kill();
			cleanup();
		},
	};
}

async function spawnLinux(
	profile: SandboxProfile,
	command: SpawnCommand,
	options: RunSandboxedOptions,
): Promise<SpawnResult> {
	const argv = buildBwrapArgv(profile, command, { bwrapBin: options.bwrapBin });
	const wantsStdin = command.stdin !== undefined;
	const proc = Bun.spawn(argv, {
		stdin: wantsStdin ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	await writeStringStdin(proc, command.stdin);

	return {
		pid: proc.pid,
		stdout: proc.stdout as ReadableStream<Uint8Array>,
		stderr: proc.stderr as ReadableStream<Uint8Array>,
		exited: proc.exited,
		cancel: () => proc.kill(),
	};
}

async function writeStringStdin(proc: Bun.Subprocess, stdin: SpawnCommand["stdin"]): Promise<void> {
	if (typeof stdin !== "string") return;
	const sink = proc.stdin;
	if (!sink || typeof sink === "number") return;
	sink.write(new TextEncoder().encode(stdin));
	await sink.end();
}

function resolveCwd(workspace: string, cwd: string | undefined): string {
	if (!cwd) return workspace;
	if (cwd.startsWith("/")) return cwd;
	return join(workspace, cwd);
}

function canonicalizeProfilePaths(profile: SandboxProfile): SandboxProfile {
	return {
		...profile,
		workspace: realpathOrSelf(profile.workspace),
		readOnlyMounts: profile.readOnlyMounts.map(realpathOrSelf),
		toolchainPaths: profile.toolchainPaths.map(realpathOrSelf),
		sshAuthSock: profile.sshAuthSock ? realpathOrSelf(profile.sshAuthSock) : profile.sshAuthSock,
	};
}

function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
