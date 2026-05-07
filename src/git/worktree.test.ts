import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addWorktree,
	branchExists,
	cloneRepo,
	deleteBranch,
	discoverHostClone,
	initRepo,
	listWorktrees,
	removeWorktree,
} from "./worktree.ts";

async function bootstrapRepo(path: string): Promise<void> {
	await initRepo({ targetPath: path, initialBranch: "main" });
	writeFileSync(join(path, "README.md"), "# repo\n");
	const { runGit } = await import("./exec.ts");
	await runGit(["config", "user.email", "test@example.com"], { cwd: path });
	await runGit(["config", "user.name", "Test"], { cwd: path });
	await runGit(["add", "."], { cwd: path });
	await runGit(["commit", "-m", "init", "--allow-empty"], { cwd: path });
	// Pre-create a non-checked-out branch the existing-branch worktree tests
	// can target. `main` is already claimed by the host clone itself, so a
	// second worktree on `main` would fail with "already used by worktree".
	await runGit(["branch", "feature/wt", "main"], { cwd: path });
}

describe("git worktree helpers", () => {
	let root: string;
	let repo: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "burrow-wt-"));
		repo = join(root, "repo");
		await bootstrapRepo(repo);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("discoverHostClone returns top-level + git common dir for a real clone", async () => {
		const result = await discoverHostClone(repo);
		expect(result).not.toBeNull();
		// macOS resolves /var/folders/... to /private/var/folders/...; the
		// realpath form is what git emits and what callers must compare against.
		expect(result?.topLevel.endsWith("/repo")).toBe(true);
		expect(result?.gitCommonDir.endsWith("/.git")).toBe(true);
	});

	test("discoverHostClone returns null outside a git repo", async () => {
		const outside = mkdtempSync(join(tmpdir(), "burrow-non-git-"));
		try {
			const result = await discoverHostClone(outside);
			expect(result).toBeNull();
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("addWorktree creates a checkout on an existing branch", async () => {
		const ws = join(root, "ws");
		await addWorktree({ hostClonePath: repo, workspacePath: ws, branch: "feature/wt" });
		expect(await Bun.file(join(ws, "README.md")).exists()).toBe(true);
	});

	test("addWorktree with createBranch carves a new branch off the base", async () => {
		const ws = join(root, "ws-task");
		await addWorktree({
			hostClonePath: repo,
			workspacePath: ws,
			branch: "task/abc",
			createBranch: true,
			baseBranch: "main",
		});
		expect(await branchExists(repo, "task/abc")).toBe(true);
		const list = await listWorktrees(repo);
		const taskEntry = list.find((e) => e.worktree.endsWith("/ws-task"));
		expect(taskEntry?.branch).toBe("refs/heads/task/abc");
	});

	test("removeWorktree tears down a checkout cleanly", async () => {
		const ws = join(root, "ws-remove");
		await addWorktree({
			hostClonePath: repo,
			workspacePath: ws,
			branch: "burrow/rm",
			createBranch: true,
			baseBranch: "main",
		});
		await removeWorktree({ hostClonePath: repo, workspacePath: ws });
		const list = await listWorktrees(repo);
		expect(list.find((e) => e.worktree.endsWith("/ws-remove"))).toBeUndefined();
		expect(await Bun.file(join(ws, "README.md")).exists()).toBe(false);
	});

	test("addWorktree against a missing branch surfaces a WorkspaceMaterializationError", async () => {
		const ws = join(root, "ws-missing");
		await expect(
			addWorktree({ hostClonePath: repo, workspacePath: ws, branch: "does-not-exist" }),
		).rejects.toThrow(/git worktree add .* failed/);
	});

	test("deleteBranch drops a non-checked-out branch", async () => {
		const ws = join(root, "ws-delbranch");
		await addWorktree({
			hostClonePath: repo,
			workspacePath: ws,
			branch: "burrow/delme",
			createBranch: true,
			baseBranch: "main",
		});
		await removeWorktree({ hostClonePath: repo, workspacePath: ws });
		expect(await branchExists(repo, "burrow/delme")).toBe(true);
		await deleteBranch({ hostClonePath: repo, branch: "burrow/delme" });
		expect(await branchExists(repo, "burrow/delme")).toBe(false);
	});

	test("deleteBranch throws when the branch does not exist", async () => {
		await expect(deleteBranch({ hostClonePath: repo, branch: "no-such-branch" })).rejects.toThrow(
			/git branch -D .* failed/,
		);
	});

	test("cloneRepo materializes a fresh clone from a local path origin", async () => {
		const cloneTarget = join(root, "fresh");
		await cloneRepo({ originUrl: repo, targetPath: cloneTarget, branch: "main" });
		expect(await Bun.file(join(cloneTarget, "README.md")).exists()).toBe(true);
		const result = await discoverHostClone(cloneTarget);
		expect(result?.topLevel.endsWith("/fresh")).toBe(true);
	});
});
