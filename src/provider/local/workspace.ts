/**
 * Workspace materialization for the LocalProvider (SPEC §11).
 *
 * Two strategies:
 *   - Project burrow → `git worktree add <ws> <branch>` against a host clone.
 *     Falls back to `git clone <originUrl>` when no host clone is available
 *     (e.g. the user runs `burrow up <git-url>` from outside any repo).
 *   - Task burrow    → `git worktree add -b task/<bur-id> <ws> <baseBranch>`
 *     against the parent burrow's host clone. O(1) — no copy.
 *
 * The `materializeProjectWorkspace` / `materializeTaskWorkspace` entry points
 * own the create + cleanup cycle so callers only handle the result handle.
 * The accompanying `removeMaterializedWorkspace` reverses whichever path was
 * taken; the result is recorded in `MaterializedWorkspace.source` so the
 * caller doesn't have to re-derive it.
 */

import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { WorkspaceMaterializationError } from "../../core/errors.ts";
import {
	type GitIdentity,
	type IdentitySpec,
	resolveBurrowIdentity,
	writeBurrowGitconfig,
} from "../../git/identity.ts";
import {
	addWorktree,
	cloneRepo,
	deleteBranch,
	discoverHostClone,
	type HostClone,
	pruneWorktrees,
	removeWorktree,
} from "../../git/worktree.ts";

export type WorkspaceSourceKind = "worktree" | "clone";

export interface MaterializedWorkspaceSource {
	kind: WorkspaceSourceKind;
	/** Branch checked out in the workspace. */
	branch: string;
	/** Host clone the worktree was added against. Absent when `kind === 'clone'`. */
	hostClonePath?: string;
	/** Origin URL used for fresh clones. Absent for worktrees. */
	originUrl?: string;
}

export interface MaterializedWorkspace {
	workspacePath: string;
	source: MaterializedWorkspaceSource;
	identity: GitIdentity | null;
}

export interface MaterializeProjectOptions {
	/** Where to create the worktree / clone. Parent dir is created if missing. */
	workspacePath: string;
	/**
	 * Branch the workspace checks out. When `createBranch` is true this is the
	 * fresh branch name (typically per-burrow, e.g. `burrow/<bur-id>`); when
	 * false, an existing branch that is not already checked out elsewhere.
	 */
	branch: string;
	/**
	 * When true (default), `branch` is created off `baseBranch`. When false,
	 * `branch` must already exist and not be checked out by another worktree.
	 * Project burrows default to carving a per-burrow branch — git refuses to
	 * add two worktrees on the same branch, so a project that's currently
	 * checked out at `main` can't be re-used directly.
	 */
	createBranch?: boolean;
	/** Branch the per-burrow branch is carved from. Defaults to `main`. */
	baseBranch?: string;
	/** Path to start probing for an existing host clone (typically projectRoot). */
	projectRoot?: string;
	/** Explicit clone fallback (when no host clone is found). */
	originUrl?: string;
	identity?: IdentitySpec;
	/** Override host env (testing). */
	hostEnv?: Record<string, string | undefined>;
}

export async function materializeProjectWorkspace(
	options: MaterializeProjectOptions,
): Promise<MaterializedWorkspace> {
	await ensureParentDir(options.workspacePath);

	const hostClone = options.projectRoot ? await discoverHostClone(options.projectRoot) : null;

	const source = hostClone
		? await materializeViaWorktree(hostClone, options)
		: await materializeViaClone(options);

	const identity = await applyIdentity(options.workspacePath, options.identity, options.hostEnv);

	return { workspacePath: options.workspacePath, source, identity };
}

export interface MaterializeTaskOptions {
	workspacePath: string;
	/** Path to the parent burrow's host clone — required (task burrows fork). */
	parentClonePath: string;
	/** Branch carved by the fork, e.g. `task/bur_xxx`. */
	taskBranch: string;
	/** Branch the new task branch is created from. */
	baseBranch: string;
	identity?: IdentitySpec;
	hostEnv?: Record<string, string | undefined>;
}

export async function materializeTaskWorkspace(
	options: MaterializeTaskOptions,
): Promise<MaterializedWorkspace> {
	await ensureParentDir(options.workspacePath);

	try {
		await addWorktree({
			hostClonePath: options.parentClonePath,
			workspacePath: options.workspacePath,
			branch: options.taskBranch,
			createBranch: true,
			baseBranch: options.baseBranch,
		});
	} catch (err) {
		throw wrapMaterializationError(`failed to fork task burrow into ${options.workspacePath}`, err);
	}

	const identity = await applyIdentity(options.workspacePath, options.identity, options.hostEnv);

	return {
		workspacePath: options.workspacePath,
		source: {
			kind: "worktree",
			branch: options.taskBranch,
			hostClonePath: options.parentClonePath,
		},
		identity,
	};
}

export interface RemoveWorkspaceOptions {
	workspacePath: string;
	source: MaterializedWorkspaceSource;
	force?: boolean;
}

export async function removeMaterializedWorkspace(opts: RemoveWorkspaceOptions): Promise<void> {
	if (opts.source.kind === "worktree") {
		const hostClonePath = opts.source.hostClonePath;
		if (!hostClonePath) {
			throw new WorkspaceMaterializationError(
				"cannot remove worktree: source.hostClonePath is missing",
			);
		}
		try {
			// Force is the right default: the burrow's workspace is always carrying
			// untracked files we put there ourselves (.gitconfig.burrow) plus
			// whatever the agent created. Callers can opt out by passing
			// `force: false` explicitly.
			await removeWorktree({
				hostClonePath,
				workspacePath: opts.workspacePath,
				force: opts.force ?? true,
			});
		} catch (err) {
			// Pruning rescues the case where the workspace dir was deleted out from
			// under git (rm -rf during a crash); the porcelain entry lingers until
			// pruned. We re-throw if the original error wasn't a stale-record one.
			await pruneWorktrees(hostClonePath).catch(() => {});
			await rm(opts.workspacePath, { recursive: true, force: true });
			if (!isStaleWorktreeError(err)) throw err;
		}
		// `git worktree remove` leaves the branch ref behind. `up`/`fork` always
		// carve a fresh per-burrow branch, so dropping it here keeps `git branch`
		// clean. Failures are non-fatal: the workspace is gone, which is the
		// caller's primary intent.
		await deleteBranch({ hostClonePath, branch: opts.source.branch, force: true }).catch(() => {});
		return;
	}
	await rm(opts.workspacePath, { recursive: true, force: true });
}

async function materializeViaWorktree(
	hostClone: HostClone,
	options: MaterializeProjectOptions,
): Promise<MaterializedWorkspaceSource> {
	const createBranch = options.createBranch ?? true;
	try {
		await addWorktree({
			hostClonePath: hostClone.topLevel,
			workspacePath: options.workspacePath,
			branch: options.branch,
			createBranch,
			...(createBranch && options.baseBranch
				? { baseBranch: options.baseBranch }
				: createBranch
					? { baseBranch: "main" }
					: {}),
		});
	} catch (err) {
		throw wrapMaterializationError(`failed to add worktree at ${options.workspacePath}`, err);
	}
	return {
		kind: "worktree",
		branch: options.branch,
		hostClonePath: hostClone.topLevel,
	};
}

async function materializeViaClone(
	options: MaterializeProjectOptions,
): Promise<MaterializedWorkspaceSource> {
	if (!options.originUrl) {
		throw new WorkspaceMaterializationError("no host clone detected and no originUrl provided", {
			recoveryHint:
				"Run `burrow up` inside an existing git clone, or pass --origin <git-url> so burrow can clone fresh.",
		});
	}
	try {
		await cloneRepo({
			originUrl: options.originUrl,
			targetPath: options.workspacePath,
			branch: options.branch,
		});
	} catch (err) {
		throw wrapMaterializationError(
			`failed to clone ${options.originUrl} into ${options.workspacePath}`,
			err,
		);
	}
	return {
		kind: "clone",
		branch: options.branch,
		originUrl: options.originUrl,
	};
}

async function applyIdentity(
	workspacePath: string,
	spec: IdentitySpec | undefined,
	hostEnv: Record<string, string | undefined> | undefined,
): Promise<GitIdentity | null> {
	const target: IdentitySpec = spec ?? { mode: "user" };
	const resolved = await resolveBurrowIdentity(target, hostEnv ? { hostEnv } : {});
	if (!resolved) return null;
	await writeBurrowGitconfig(workspacePath, resolved);
	return resolved;
}

async function ensureParentDir(workspacePath: string): Promise<void> {
	await mkdir(dirname(workspacePath), { recursive: true });
}

function wrapMaterializationError(prefix: string, err: unknown): WorkspaceMaterializationError {
	if (err instanceof WorkspaceMaterializationError) {
		return new WorkspaceMaterializationError(`${prefix}: ${err.message}`, {
			cause: err,
			...(err.recoveryHint ? { recoveryHint: err.recoveryHint } : {}),
		});
	}
	const message = err instanceof Error ? err.message : String(err);
	return new WorkspaceMaterializationError(`${prefix}: ${message}`, { cause: err });
}

function isStaleWorktreeError(err: unknown): boolean {
	if (err instanceof Error) return /not a working tree|does not exist/i.test(err.message);
	return false;
}
