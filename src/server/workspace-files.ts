/**
 * Read/write helpers for the workspace-mutation HTTP surface (R-07).
 *
 * The handlers for `POST /burrows`, `POST /burrows/:id/files`, and
 * `GET /burrows/:id/files` all share the same wire shape (`WorkspaceFile`):
 * relative path, base64-or-utf-8 contents, optional POSIX mode. This module
 * is the single place where the shape is decoded, validated against the
 * workspace root via `resolveWorkspaceFilePath`, and written through.
 *
 * Writers open with `O_NOFOLLOW` on the final segment so a symlink swapped
 * in between validation and write can't redirect bytes outside the
 * workspace. Intermediate-segment TOCTOU races against `realpath` are out
 * of scope for V1 — the canonical path is computed under the realpath-d
 * workspace root, and the attack window between validate and open is
 * narrow. `openat` with `RESOLVE_NO_SYMLINKS` (Linux 5.6+) is the future
 * tightening if a real threat emerges.
 *
 * `writeWorkspaceFiles` validates ALL paths upfront before opening any file
 * handle, so a single rejected entry aborts the batch with no partial-state
 * side effects (acceptance pl-2467 step 3 #1).
 */

import { constants as FS } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { RESERVED_WORKSPACE_ENTRIES, resolveWorkspaceFilePath } from "./workspace-paths.ts";

export type WorkspaceFileEncoding = "utf-8" | "base64";

export interface WorkspaceFileInput {
	path: string;
	contents: string;
	encoding?: WorkspaceFileEncoding;
	mode?: number;
}

export interface WorkspaceFileOutput {
	path: string;
	contents: string;
	encoding: WorkspaceFileEncoding;
}

export interface WorkspaceFileEntry {
	/** Workspace-relative path, forward-slash separated. */
	path: string;
	/** Raw `st_mode` (includes file-type bits per `stat(2)`). */
	mode: number;
	/** Byte size from `lstat`; for symlinks this is the link's own length. */
	size: number;
}

const DEFAULT_FILE_MODE = 0o644;

export async function writeWorkspaceFiles(
	workspaceRoot: string,
	files: readonly WorkspaceFileInput[],
): Promise<void> {
	const resolved: { canonical: string; data: Uint8Array; mode: number }[] = [];
	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		if (file === undefined) continue;
		const canonical = await resolveWorkspaceFilePath(workspaceRoot, file.path);
		const data = decodeContents(file, i);
		const mode = file.mode ?? DEFAULT_FILE_MODE;
		resolved.push({ canonical, data, mode });
	}
	for (const { canonical, data, mode } of resolved) {
		await mkdir(dirname(canonical), { recursive: true });
		const flags = FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW;
		const handle = await open(canonical, flags, mode);
		try {
			await handle.writeFile(data);
			await handle.chmod(mode);
		} finally {
			await handle.close();
		}
	}
}

export async function readWorkspaceFile(
	workspaceRoot: string,
	relPath: string,
	encoding: WorkspaceFileEncoding,
): Promise<WorkspaceFileOutput> {
	const canonical = await resolveWorkspaceFilePath(workspaceRoot, relPath);
	let bytes: Buffer;
	try {
		bytes = await readFile(canonical);
	} catch (err) {
		if (isENOENT(err)) {
			throw new NotFoundError(`file '${relPath}' not found in workspace`);
		}
		throw err;
	}
	const contents = encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8");
	return { path: relPath, contents, encoding };
}

/**
 * Recursively list every file (and dangling/in-workspace symlink) under the
 * burrow's workspace. With no `prefix`, walks from `workspaceRoot` and skips
 * the top-level reserved entries (`.git`, `.gitconfig.burrow`) so the listing
 * is the agent-visible surface, not burrow's own bookkeeping. With a
 * `prefix`, scopes the walk to that subtree after running it through
 * `resolveWorkspaceFilePath` — same validation as `files.read`, so `..`,
 * absolute paths, reserved-entry escapes, and symlink escapes all reject 400
 * before any directory read.
 *
 * Symlinks inside the workspace are listed but never traversed: the entry
 * appears once with `lstat`-derived `mode`/`size`, and the walk does NOT
 * recurse through the link target. Callers that want the linked file's
 * bytes go through `files.read`, which re-validates via the same
 * `resolveWorkspaceFilePath` guard.
 *
 * The result is sorted by `path` ascending so callers get deterministic
 * ordering across runs (matches the test golden + makes warren's mulch_merge
 * diff cleaner).
 */
export async function listWorkspaceFiles(
	workspaceRoot: string,
	prefix?: string,
): Promise<WorkspaceFileEntry[]> {
	let rootReal: string;
	try {
		rootReal = await realpath(workspaceRoot);
	} catch (err) {
		throw new ValidationError(`workspace root '${workspaceRoot}' is not accessible`, {
			cause: err,
		});
	}

	const hasPrefix = prefix !== undefined && prefix.length > 0;
	let startDir = rootReal;
	let prefixRel = "";
	if (hasPrefix) {
		// biome-ignore lint/style/noNonNullAssertion: hasPrefix guarantees prefix is defined
		const canonical = await resolveWorkspaceFilePath(workspaceRoot, prefix!);
		startDir = canonical;
		prefixRel = canonical === rootReal ? "" : canonical.slice(rootReal.length + 1);
	}

	let dirStats: Awaited<ReturnType<typeof lstat>>;
	try {
		dirStats = await lstat(startDir);
	} catch (err) {
		if (isENOENT(err)) {
			throw new NotFoundError(
				hasPrefix
					? `prefix '${prefix}' not found in workspace`
					: `workspace root not found at '${workspaceRoot}'`,
			);
		}
		throw err;
	}
	if (!dirStats.isDirectory()) {
		throw new ValidationError(`prefix '${prefix}' is not a directory`);
	}

	const entries: WorkspaceFileEntry[] = [];
	await walkWorkspaceDirectory(startDir, prefixRel, entries, !hasPrefix);
	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return entries;
}

async function walkWorkspaceDirectory(
	dir: string,
	relPath: string,
	out: WorkspaceFileEntry[],
	isWorkspaceRoot: boolean,
): Promise<void> {
	const dirEntries = await readdir(dir, { withFileTypes: true });
	for (const entry of dirEntries) {
		if (isWorkspaceRoot && RESERVED_WORKSPACE_ENTRIES.includes(entry.name)) continue;
		const absChild = join(dir, entry.name);
		const childRel = relPath.length === 0 ? entry.name : `${relPath}/${entry.name}`;
		const stats = await lstat(absChild);
		if (stats.isSymbolicLink()) {
			out.push({ path: childRel, mode: stats.mode, size: stats.size });
			continue;
		}
		if (stats.isDirectory()) {
			await walkWorkspaceDirectory(absChild, childRel, out, false);
			continue;
		}
		if (stats.isFile()) {
			out.push({ path: childRel, mode: stats.mode, size: stats.size });
		}
	}
}

function decodeContents(file: WorkspaceFileInput, index: number): Uint8Array {
	const encoding = file.encoding ?? "utf-8";
	if (encoding === "base64") {
		const buf = Buffer.from(file.contents, "base64");
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	}
	if (encoding === "utf-8") {
		return new TextEncoder().encode(file.contents);
	}
	throw new ValidationError(`files[${index}].encoding '${encoding}' must be 'utf-8' or 'base64'`);
}

function isENOENT(err: unknown): boolean {
	return (
		err !== null &&
		typeof err === "object" &&
		"code" in err &&
		(err as { code: unknown }).code === "ENOENT"
	);
}
