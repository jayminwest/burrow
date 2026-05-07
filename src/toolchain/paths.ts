/**
 * Expand a list of resolved binary paths into the set of host directories
 * that have to be visible inside the sandbox for those binaries to execute
 * (SPEC §8.4, §19).
 *
 * For each binary we contribute two directories:
 *   1. `dirname(path)` — where the binary (or its symlink) lives on PATH.
 *      Mounting this directory is what makes `execvp("claude")` succeed
 *      inside the sandbox: the bare-name lookup needs the directory to be
 *      readable and the entry to be present.
 *   2. `dirname(realpath(path))` — when the PATH entry is a symlink, the
 *      actual binary file lives elsewhere (`~/.local/bin/claude` →
 *      `~/.local/share/claude/versions/2.1.132`). Without admitting that
 *      target directory, the kernel can resolve the symlink but the read
 *      that follows is denied by the sandbox profile.
 *
 * Order is preserved (first-seen wins) so callers can prepend these to PATH
 * deterministically. Falsy/empty inputs are dropped — we only care about
 * paths that actually resolved.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function expandToolchainBinDirs(paths: Iterable<string | null | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of paths) {
		if (!raw) continue;
		const original = dirname(raw);
		if (original.length > 0 && !seen.has(original)) {
			seen.add(original);
			out.push(original);
		}
		const realDir = realpathDirOrNull(raw);
		if (realDir && !seen.has(realDir)) {
			seen.add(realDir);
			out.push(realDir);
		}
	}
	return out;
}

function realpathDirOrNull(path: string): string | null {
	try {
		const resolved = realpathSync(path);
		const dir = dirname(resolved);
		return dir.length > 0 ? dir : null;
	} catch {
		return null;
	}
}

export interface ResolveBunGlobalInstallDirInput {
	/** Override `BUN_INSTALL`. Defaults to the value from `hostEnv`. */
	bunInstall?: string | undefined;
	/** Host env (defaults to `process.env`); supplies `BUN_INSTALL` when set. */
	hostEnv?: Record<string, string | undefined>;
	/** Override `$HOME`. Defaults to `os.homedir()`. */
	home?: string;
	/** Existence probe (test seam). Defaults to `fs.existsSync`. */
	exists?: (path: string) => boolean;
}

/**
 * Resolve the directory where `bun add -g <pkg>` lays down packages
 * (`<BUN_INSTALL>/install/global/node_modules`).
 *
 * Globally-installed bun CLIs ship as a stub symlink under `<BUN_INSTALL>/bin/`
 * whose target points into `install/global/node_modules/<scope>/<pkg>/...`
 * (a `.ts` source file with a bun shebang). The toolchain mount only covers
 * the `bin` directory, so the stub is visible by name but bun's read of the
 * realpath target is denied by the sandbox — and bun reports the failure as
 * `error loading current directory` (burrow-aa46). Mounting the install root
 * lets every bun-installed CLI (`ml`, `sd`, `cn`, `ov`, …) load.
 *
 * Returns `null` when the install root doesn't exist (no bun-globals
 * installed, or BUN_INSTALL points somewhere unusual). Callers should treat
 * a `null` result as "nothing to mount" and proceed without it.
 */
export function resolveBunGlobalInstallDir(
	input: ResolveBunGlobalInstallDirInput = {},
): string | null {
	const env = input.hostEnv ?? process.env;
	const root = input.bunInstall ?? env.BUN_INSTALL ?? join(input.home ?? homedir(), ".bun");
	const candidate = join(root, "install", "global", "node_modules");
	const probe = input.exists ?? existsSync;
	return probe(candidate) ? candidate : null;
}
