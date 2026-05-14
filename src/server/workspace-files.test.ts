/**
 * Unit tests for `listWorkspaceFiles` (burrow-18ca). The end-to-end wire
 * shape over HTTP is locked by `handlers.test.ts`; this file pins the
 * helper's traversal contract directly so accidental refactors of the
 * walker (e.g. switching to `realpath` for prefix resolution) trip a
 * focused test rather than the integration-test bundle.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import { listWorkspaceFiles } from "./workspace-files.ts";

describe("listWorkspaceFiles", () => {
	let workspace: string;

	beforeEach(async () => {
		workspace = await mkdtemp(join(tmpdir(), "burrow-ls-"));
	});

	afterEach(async () => {
		await rm(workspace, { recursive: true, force: true });
	});

	test("returns recursively-discovered files sorted by path", async () => {
		await mkdir(join(workspace, "sub", "deeper"), { recursive: true });
		await writeFile(join(workspace, "z.txt"), "z");
		await writeFile(join(workspace, "sub", "a.txt"), "a");
		await writeFile(join(workspace, "sub", "deeper", "b.txt"), "bb");

		const out = await listWorkspaceFiles(workspace);
		expect(out.map((f) => f.path)).toEqual(["sub/a.txt", "sub/deeper/b.txt", "z.txt"]);
		const z = out.find((f) => f.path === "z.txt");
		expect(z?.size).toBe(1);
		expect(typeof z?.mode).toBe("number");
	});

	test("returns empty array for an empty workspace", async () => {
		const out = await listWorkspaceFiles(workspace);
		expect(out).toEqual([]);
	});

	test("excludes top-level reserved entries (.git, .gitconfig.burrow)", async () => {
		await mkdir(join(workspace, ".git"), { recursive: true });
		await writeFile(join(workspace, ".git", "HEAD"), "ref: x");
		await writeFile(join(workspace, ".gitconfig.burrow"), "x");
		await writeFile(join(workspace, "keep.txt"), "keep");

		const out = await listWorkspaceFiles(workspace);
		expect(out.map((f) => f.path)).toEqual(["keep.txt"]);
	});

	test("scopes the walk to a prefix subtree", async () => {
		await mkdir(join(workspace, ".mulch", "expertise"), { recursive: true });
		await writeFile(join(workspace, ".mulch", "expertise", "a.jsonl"), "x");
		await writeFile(join(workspace, "outside.txt"), "y");

		const out = await listWorkspaceFiles(workspace, ".mulch/expertise");
		expect(out.map((f) => f.path)).toEqual([".mulch/expertise/a.jsonl"]);
	});

	test("lists in-workspace symlinks but does not traverse them", async () => {
		await mkdir(join(workspace, "real"), { recursive: true });
		await writeFile(join(workspace, "real", "f.txt"), "x");
		await symlink("real", join(workspace, "alias"));

		const out = await listWorkspaceFiles(workspace);
		const paths = out.map((f) => f.path);
		expect(paths).toContain("real/f.txt");
		expect(paths).toContain("alias");
		expect(paths.some((p) => p.startsWith("alias/"))).toBe(false);
	});

	test("rejects '..' prefix with ValidationError", async () => {
		await expect(listWorkspaceFiles(workspace, "..")).rejects.toBeInstanceOf(ValidationError);
	});

	test("rejects reserved prefix with ValidationError", async () => {
		await expect(listWorkspaceFiles(workspace, ".git")).rejects.toThrow(/reserved/);
	});

	test("rejects missing prefix with NotFoundError", async () => {
		await expect(listWorkspaceFiles(workspace, "does/not/exist")).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	test("rejects prefix that resolves to a file with ValidationError", async () => {
		await writeFile(join(workspace, "f.txt"), "x");
		await expect(listWorkspaceFiles(workspace, "f.txt")).rejects.toThrow(/not a directory/);
	});

	test("rejects prefix that escapes via symlink", async () => {
		await symlink("/etc", join(workspace, "escape"));
		await expect(listWorkspaceFiles(workspace, "escape")).rejects.toThrow(/escapes/);
	});
});
