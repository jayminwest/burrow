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

import { type Dirent, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

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
		const nodeModulesRoot = realDir ? outermostNodeModulesAncestorFromRoot(realDir) : null;
		if (nodeModulesRoot && !seen.has(nodeModulesRoot)) {
			seen.add(nodeModulesRoot);
			out.push(nodeModulesRoot);
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

function outermostNodeModulesAncestorFromRoot(start: string): string | null {
	let cursor = start;
	let outermost: string | null = null;
	while (true) {
		if (basename(cursor) === "node_modules") outermost = cursor;
		const parent = dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	return outermost;
}

export interface WalkToolchainBinSymlinksInput {
	/** Bin directories to walk. Each must be absolute. */
	binDirs: Iterable<string>;
	/** Cap how many entries we stat per bin dir. Defaults to 256. */
	maxEntries?: number;
	/** Test seam — list directory entries (defaults to `fs.readdirSync` w/ types). */
	readdir?: (dir: string) => readonly Pick<Dirent, "name" | "isSymbolicLink">[];
	/** Test seam — resolve a symlink. Defaults to `fs.realpathSync`. */
	realpath?: (path: string) => string;
}

/**
 * For each declared-toolchain bin directory, follow each symlinked entry and
 * contribute a host directory whose mount lets the symlink's target load
 * inside the sandbox. Generalises the `bin/<stub>` symlink → `install/<real>`
 * shape used by bun-globals (`ml`, `sd`, `cn`, …), uv-tool, pyenv shims, nvm,
 * rustup, and mise/asdf — without any per-tool knowledge.
 *
 * Bound: realpath targets must stay within `dirname(binDir)` (the toolchain
 * "root" — the bin's parent). A rogue symlink pointing at `/etc` or `/var`
 * is dropped silently. Bin dirs whose parent resolves to `/` are skipped on
 * the same reasoning.
 *
 * Special-case for node-style ecosystems: when the resolved target lives
 * inside a `node_modules` subtree (within the trusted root), we contribute
 * the *outermost* such ancestor instead of `dirname(realpath)`. That's what
 * makes globally-installed bun packages load — bun's bare-import resolution
 * walks ancestor `node_modules` dirs from the entrypoint, so mounting a
 * deeper sub-dir wouldn't suffice. For non-node ecosystems we fall back to
 * `dirname(realpath)`; sibling layouts (pyenv `lib/`, uv venv `lib/`) still
 * need the `[sandbox] read_only_paths` escape hatch.
 *
 * Bin dirs that don't exist or can't be read are skipped (consistent with
 * `expandToolchainBinDirs` — missing inputs don't fail `up`).
 */
export function walkToolchainBinSymlinks(input: WalkToolchainBinSymlinksInput): string[] {
	const cap = input.maxEntries ?? 256;
	const readdirFn = input.readdir ?? defaultReaddir;
	const realpathFn = input.realpath ?? realpathSync;

	const out: string[] = [];
	const seen = new Set<string>();
	const add = (dir: string): void => {
		if (dir.length === 0 || seen.has(dir)) return;
		seen.add(dir);
		out.push(dir);
	};

	for (const binDirRaw of input.binDirs) {
		if (binDirRaw.length === 0) continue;
		// Canonicalise the bin dir before computing the trusted root.
		// realpathSync of a symlinked entry returns canonical form (`/private/...`
		// on macOS); without canonicalising the input, `isWithin` would compare
		// `/var/folders/...` to `/private/var/folders/...` and reject every hit.
		let binDir: string;
		try {
			binDir = realpathFn(binDirRaw);
		} catch {
			continue;
		}
		const trustedRoot = dirname(binDir);
		if (trustedRoot === "/" || trustedRoot === "" || trustedRoot === binDir) continue;

		let entries: readonly Pick<Dirent, "name" | "isSymbolicLink">[];
		try {
			entries = readdirFn(binDir);
		} catch {
			continue;
		}

		let walked = 0;
		for (const entry of entries) {
			if (walked >= cap) break;
			walked++;
			if (!entry.isSymbolicLink()) continue;

			let resolved: string;
			try {
				resolved = realpathFn(join(binDir, entry.name));
			} catch {
				continue;
			}
			if (!isWithin(resolved, trustedRoot)) continue;

			const dir = dirname(resolved);
			if (dir === binDir) continue;

			const nodeModulesAncestor = outermostNodeModulesAncestor(dir, trustedRoot);
			add(nodeModulesAncestor ?? dir);
		}
	}
	return out;
}

function defaultReaddir(dir: string): readonly Dirent[] {
	return readdirSync(dir, { withFileTypes: true });
}

function isWithin(path: string, root: string): boolean {
	if (path === root) return true;
	if (root === "/") return path.startsWith("/");
	return path.startsWith(`${root}${sep}`);
}

function outermostNodeModulesAncestor(start: string, trustedRoot: string): string | null {
	let cursor = start;
	let outermost: string | null = null;
	while (cursor !== trustedRoot && isWithin(cursor, trustedRoot)) {
		if (basename(cursor) === "node_modules") outermost = cursor;
		const parent = dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	return outermost;
}

/**
 * Expand a leading `~`, `~/...`, `$HOME`, or `${HOME}` to the host home dir.
 * Anything else is returned verbatim (so absolute paths and unrecognised
 * shapes pass through). Used to render `[sandbox] read_only_paths` entries
 * before they land on `SandboxProfile.readOnlyMounts`.
 */
export function expandHomePrefix(value: string, home: string = homedir()): string {
	if (value === "~") return home;
	if (value.startsWith("~/")) return join(home, value.slice(2));
	const HOME_BRACE = `$${"{HOME}"}`; // Spelled out to dodge biome's template-in-string rule.
	if (value === "$HOME" || value === HOME_BRACE) return home;
	if (value.startsWith("$HOME/")) return join(home, value.slice("$HOME/".length));
	if (value.startsWith(`${HOME_BRACE}/`)) return join(home, value.slice(HOME_BRACE.length + 1));
	return value;
}
