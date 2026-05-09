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
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { resolveWorkspaceFilePath } from "./workspace-paths.ts";

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
