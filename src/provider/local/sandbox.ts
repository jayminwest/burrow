/**
 * Cross-platform entry point for one-shot sandboxed execution.
 *
 * macOS — write the rendered Seatbelt profile to a `0600` temp file under
 * the system tmp dir, invoke `sandbox-exec -f`, clean up the temp dir when
 * the child exits or is cancelled.
 * Linux — invoke `bwrap` directly. Env is delivered via Bun.spawn's `env`
 * option (which becomes bwrap's process env, then propagates to the child via
 * execve). Putting env on the bwrap argv via `--setenv` would leak secrets
 * through `/proc/<pid>/cmdline` (burrow-ab95).
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

	await writeStringStdin(proc, command.stdin, command.holdStdin ?? false);

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
		closeStdin: makeCloseStdin(proc),
	};
}

async function spawnLinux(
	profile: SandboxProfile,
	command: SpawnCommand,
	options: RunSandboxedOptions,
): Promise<SpawnResult> {
	const argv = buildBwrapArgv(profile, command, { bwrapBin: options.bwrapBin });
	const env = resolveSandboxEnv(profile, command, {
		homePath: "/workspace",
		hostEnv: process.env,
	});
	const wantsStdin = command.stdin !== undefined;
	// `env` here becomes bwrap's process env (replacing process.env entirely,
	// not merging with it). bwrap then execve()s the child with that same env,
	// so secrets reach the child via /proc/<pid>/environ (mode 400) instead of
	// /proc/<pid>/cmdline (world-readable). See burrow-ab95.
	const proc = Bun.spawn(argv, {
		env,
		stdin: wantsStdin ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	await writeStringStdin(proc, command.stdin, command.holdStdin ?? false);

	return {
		pid: proc.pid,
		stdout: proc.stdout as ReadableStream<Uint8Array>,
		stderr: proc.stderr as ReadableStream<Uint8Array>,
		exited: proc.exited,
		cancel: () => proc.kill(),
		closeStdin: makeCloseStdin(proc),
	};
}

async function writeStringStdin(
	proc: Bun.Subprocess,
	stdin: SpawnCommand["stdin"],
	holdStdin: boolean,
): Promise<void> {
	if (typeof stdin !== "string") return;
	const sink = proc.stdin;
	if (!sink || typeof sink === "number") return;
	sink.write(new TextEncoder().encode(stdin));
	if (!holdStdin) await sink.end();
}

function makeCloseStdin(proc: Bun.Subprocess): () => Promise<void> {
	let closed = false;
	return async () => {
		if (closed) return;
		closed = true;
		const sink = proc.stdin;
		if (!sink || typeof sink === "number") return;
		await sink.end();
	};
}

function resolveCwd(workspace: string, cwd: string | undefined): string {
	if (!cwd) return workspace;
	if (cwd.startsWith("/")) return cwd;
	return join(workspace, cwd);
}

function canonicalizeProfilePaths(profile: SandboxProfile): SandboxProfile {
	const out: SandboxProfile = {
		...profile,
		workspace: realpathOrSelf(profile.workspace),
		readOnlyMounts: profile.readOnlyMounts.map(realpathOrSelf),
		toolchainPaths: profile.toolchainPaths.map(realpathOrSelf),
		sshAuthSock: profile.sshAuthSock ? realpathOrSelf(profile.sshAuthSock) : profile.sshAuthSock,
	};
	if (profile.workspaceGitdir) out.workspaceGitdir = realpathOrSelf(profile.workspaceGitdir);
	return out;
}

function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
