import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceMaterializationError } from "../../core/errors.ts";
import { runGit } from "../../git/exec.ts";
import { branchExists, discoverHostClone, initRepo, listWorktrees } from "../../git/worktree.ts";
import {
	materializeProjectWorkspace,
	materializeTaskWorkspace,
	removeMaterializedWorkspace,
} from "./workspace.ts";

async function bootstrapRepo(path: string): Promise<void> {
	await initRepo({ targetPath: path, initialBranch: "main" });
	writeFileSync(join(path, "README.md"), "# repo\n");
	await runGit(["config", "user.email", "host@example.com"], { cwd: path });
	await runGit(["config", "user.name", "Host"], { cwd: path });
	await runGit(["add", "."], { cwd: path });
	await runGit(["commit", "-m", "init"], { cwd: path });
}

function isolatedEnv(home: string): Record<string, string | undefined> {
	return {
		HOME: home,
		GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		XDG_CONFIG_HOME: join(home, ".config"),
		PATH: process.env.PATH,
	};
}

describe("materializeProjectWorkspace", () => {
	let root: string;
	let repo: string;
	let home: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "burrow-ws-"));
		repo = join(root, "repo");
		home = mkdtempSync(join(tmpdir(), "burrow-ws-home-"));
		writeFileSync(
			join(home, ".gitconfig"),
			"[user]\n\tname = Burrow Tester\n\temail = burrow@example.com\n",
		);
		await bootstrapRepo(repo);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	test("carves a per-burrow branch off main when host clone exists (default)", async () => {
		const ws = join(root, "ws");
		const result = await materializeProjectWorkspace({
			workspacePath: ws,
			branch: "burrow/bur_test",
			baseBranch: "main",
			projectRoot: repo,
			hostEnv: isolatedEnv(home),
		});
		expect(result.source.kind).toBe("worktree");
		expect(result.source.branch).toBe("burrow/bur_test");
		expect(result.source.hostClonePath?.endsWith("/repo")).toBe(true);
		expect(await Bun.file(join(ws, "README.md")).exists()).toBe(true);
		expect(result.identity).toEqual({
			name: "Burrow Tester",
			email: "burrow@example.com",
		});
		expect(await Bun.file(join(ws, ".gitconfig.burrow")).exists()).toBe(true);

		const list = await listWorktrees(repo);
		const entry = list.find((e) => e.worktree.endsWith("/ws"));
		expect(entry?.branch).toBe("refs/heads/burrow/bur_test");
	});

	test("checks out an existing branch when createBranch=false", async () => {
		// Pre-create a feature branch on the host clone (without checking it out).
		await runGit(["branch", "feature/x", "main"], { cwd: repo });
		const ws = join(root, "ws-existing");
		const result = await materializeProjectWorkspace({
			workspacePath: ws,
			branch: "feature/x",
			createBranch: false,
			projectRoot: repo,
			hostEnv: isolatedEnv(home),
		});
		expect(result.source.branch).toBe("feature/x");
		const list = await listWorktrees(repo);
		const entry = list.find((e) => e.worktree.endsWith("/ws-existing"));
		expect(entry?.branch).toBe("refs/heads/feature/x");
	});

	test("falls back to git clone when no host clone is detected", async () => {
		const outside = mkdtempSync(join(tmpdir(), "burrow-outside-"));
		try {
			const ws = join(outside, "ws");
			const result = await materializeProjectWorkspace({
				workspacePath: ws,
				branch: "main",
				projectRoot: outside,
				originUrl: repo,
				hostEnv: isolatedEnv(home),
			});
			expect(result.source.kind).toBe("clone");
			expect(result.source.originUrl).toBe(repo);
			expect(await Bun.file(join(ws, "README.md")).exists()).toBe(true);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("throws when neither a host clone nor an originUrl is available", async () => {
		const outside = mkdtempSync(join(tmpdir(), "burrow-outside-empty-"));
		try {
			await expect(
				materializeProjectWorkspace({
					workspacePath: join(outside, "ws"),
					branch: "main",
					projectRoot: outside,
					hostEnv: isolatedEnv(home),
				}),
			).rejects.toBeInstanceOf(WorkspaceMaterializationError);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("identity is null when host config has no name + email", async () => {
		const blankHome = mkdtempSync(join(tmpdir(), "burrow-blank-home-"));
		try {
			writeFileSync(join(blankHome, ".gitconfig"), "");
			const ws = join(root, "ws-no-id");
			const result = await materializeProjectWorkspace({
				workspacePath: ws,
				branch: "burrow/bur_no_id",
				baseBranch: "main",
				projectRoot: repo,
				hostEnv: isolatedEnv(blankHome),
			});
			expect(result.identity).toBeNull();
			expect(await Bun.file(join(ws, ".gitconfig.burrow")).exists()).toBe(false);
		} finally {
			rmSync(blankHome, { recursive: true, force: true });
		}
	});
});

describe("materializeTaskWorkspace", () => {
	let root: string;
	let repo: string;
	let home: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "burrow-task-"));
		repo = join(root, "repo");
		home = mkdtempSync(join(tmpdir(), "burrow-task-home-"));
		writeFileSync(
			join(home, ".gitconfig"),
			"[user]\n\tname = Task Tester\n\temail = task@example.com\n",
		);
		await bootstrapRepo(repo);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	test("forks off the parent clone onto a new branch", async () => {
		const ws = join(root, "task-ws");
		const result = await materializeTaskWorkspace({
			workspacePath: ws,
			parentClonePath: repo,
			taskBranch: "task/bur_abc",
			baseBranch: "main",
			hostEnv: isolatedEnv(home),
		});
		expect(result.source.kind).toBe("worktree");
		expect(result.source.branch).toBe("task/bur_abc");
		expect(result.identity).toEqual({ name: "Task Tester", email: "task@example.com" });

		const list = await listWorktrees(repo);
		const entry = list.find((e) => e.worktree.endsWith("/task-ws"));
		expect(entry?.branch).toBe("refs/heads/task/bur_abc");
	});

	test("multiple sibling task burrows fork independently from the same parent", async () => {
		const a = join(root, "task-a");
		const b = join(root, "task-b");
		await materializeTaskWorkspace({
			workspacePath: a,
			parentClonePath: repo,
			taskBranch: "task/bur_a",
			baseBranch: "main",
			hostEnv: isolatedEnv(home),
		});
		await materializeTaskWorkspace({
			workspacePath: b,
			parentClonePath: repo,
			taskBranch: "task/bur_b",
			baseBranch: "main",
			hostEnv: isolatedEnv(home),
		});
		const list = await listWorktrees(repo);
		const branches = list.map((e) => e.branch).filter(Boolean);
		expect(branches).toContain("refs/heads/task/bur_a");
		expect(branches).toContain("refs/heads/task/bur_b");
	});
});

describe("removeMaterializedWorkspace", () => {
	let root: string;
	let repo: string;
	let home: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "burrow-rm-"));
		repo = join(root, "repo");
		home = mkdtempSync(join(tmpdir(), "burrow-rm-home-"));
		writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Remover\n\temail = rm@example.com\n");
		await bootstrapRepo(repo);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	test("removes a worktree-backed workspace, drops the branch, and updates worktree list", async () => {
		const ws = join(root, "ws");
		const result = await materializeProjectWorkspace({
			workspacePath: ws,
			branch: "burrow/bur_remove",
			baseBranch: "main",
			projectRoot: repo,
			hostEnv: isolatedEnv(home),
		});
		expect(await branchExists(repo, "burrow/bur_remove")).toBe(true);
		await removeMaterializedWorkspace({ workspacePath: ws, source: result.source });
		const list = await listWorktrees(repo);
		expect(list.find((e) => e.worktree.endsWith("/ws"))).toBeUndefined();
		expect(await Bun.file(join(ws, "README.md")).exists()).toBe(false);
		expect(await branchExists(repo, "burrow/bur_remove")).toBe(false);
	});

	test("removes a clone-backed workspace by deleting the directory tree", async () => {
		const outside = mkdtempSync(join(tmpdir(), "burrow-rm-outside-"));
		try {
			const ws = join(outside, "ws");
			const result = await materializeProjectWorkspace({
				workspacePath: ws,
				branch: "main",
				projectRoot: outside,
				originUrl: repo,
				hostEnv: isolatedEnv(home),
			});
			await removeMaterializedWorkspace({ workspacePath: ws, source: result.source });
			expect(await Bun.file(join(ws, "README.md")).exists()).toBe(false);
			// The host clone should be untouched.
			const probe = await discoverHostClone(repo);
			expect(probe).not.toBeNull();
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("recovers when the workspace dir was already deleted out-of-band", async () => {
		const ws = join(root, "ws-stale");
		const result = await materializeProjectWorkspace({
			workspacePath: ws,
			branch: "burrow/bur_stale",
			baseBranch: "main",
			projectRoot: repo,
			hostEnv: isolatedEnv(home),
		});
		// Simulate the user (or a crash) yanking the workspace dir before stop().
		rmSync(ws, { recursive: true, force: true });
		await removeMaterializedWorkspace({ workspacePath: ws, source: result.source });
		const list = await listWorktrees(repo);
		expect(list.find((e) => e.worktree.endsWith("/ws-stale"))).toBeUndefined();
	});
});
