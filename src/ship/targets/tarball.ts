/**
 * `tarball` ShipTarget — packages workspace artifacts into a `.tar.gz`.
 *
 * Stress-tests the ShipTarget interface for the simple end of the spectrum:
 * synchronous, no auth, no network, no streaming child. The artifact is a
 * single file written under `dist/<burrowOrName>-<ts>.tar.gz` (or the value of
 * `[ship].tarball.out`).
 *
 * Includes default to the project's [ship].tarball.out_dir (e.g. "dist") when
 * present, otherwise the entire workspace (excluding .git, node_modules).
 */

import { mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ValidationError } from "../../core/errors.ts";
import { probeBinary, runStep } from "../run.ts";
import type { ShipContext, ShipEvent, ShipInstallCheck, ShipPlan, ShipTarget } from "../target.ts";

const DEFAULT_OUT_DIR = "dist";
const DEFAULT_EXCLUDES = [".git", "node_modules", "dist/.cache"];

export const tarballShipTarget: ShipTarget = {
	id: "tarball",
	description: "package workspace into a .tar.gz under dist/ (offline, no auth)",

	validate(ctx: ShipContext): void {
		const cfg = ctx.ship.tarball;
		// Empty/absent config is fine — defaults take over.
		if (!cfg) return;
		if (cfg.out !== undefined && cfg.out.trim().length === 0) {
			throw new ValidationError("[ship.tarball].out cannot be empty");
		}
		if (cfg.out_dir !== undefined && cfg.out_dir.trim().length === 0) {
			throw new ValidationError("[ship.tarball].out_dir cannot be empty");
		}
		if (cfg.include !== undefined && cfg.include.length === 0) {
			throw new ValidationError(
				"[ship.tarball].include must be non-empty when set; omit the key for defaults",
			);
		}
	},

	async installCheck(_ctx: ShipContext): Promise<ShipInstallCheck> {
		const path = await probeBinary("tar");
		if (!path) {
			return {
				ok: false,
				binary: "tar",
				detail: "`tar` not found on $PATH — install GNU tar (linux) or use system tar (macOS)",
			};
		}
		return { ok: true, binary: "tar", path };
	},

	async plan(ctx: ShipContext): Promise<ShipPlan> {
		const resolved = resolveTarballPlan(ctx);
		const tarArgv = [
			"tar",
			"-czf",
			resolved.outAbs,
			"-C",
			ctx.workspace,
			...resolved.excludeArgs,
			...resolved.includes,
		];

		const steps =
			ctx.ship.build && ctx.ship.build.length > 0
				? ctx.ship.build.map((cmd) => ({
						description: `run build step: ${cmd}`,
						command: ["sh", "-c", cmd],
						cwd: ctx.workspace,
					}))
				: [];
		steps.push({
			description: `tar workspace → ${resolved.outAbs}`,
			command: tarArgv,
			cwd: ctx.workspace,
		});
		const plan: ShipPlan = {
			target: "tarball",
			artifact: resolved.outAbs,
			steps,
		};
		if (resolved.usingDefaultIncludes) {
			plan.notes = [
				`includes default to '${resolved.includes.join(" ")}' (no [ship.tarball].include set)`,
			];
		}
		return plan;
	},

	async *execute(ctx: ShipContext): AsyncGenerator<ShipEvent, void, void> {
		const plan = await this.plan(ctx);
		yield { kind: "plan", plan };
		if (ctx.dryRun) return;

		const resolved = resolveTarballPlan(ctx);
		mkdirSync(dirname(resolved.outAbs), { recursive: true });

		for (let i = 0; i < plan.steps.length; i++) {
			const step = plan.steps[i];
			if (!step?.command) continue;
			const stepInput: Parameters<typeof runStep>[0] = {
				index: i,
				description: step.description,
				command: step.command,
			};
			if (step.cwd !== undefined) stepInput.cwd = step.cwd;
			if (ctx.env !== undefined) stepInput.env = ctx.env;
			if (ctx.signal !== undefined) stepInput.signal = ctx.signal;
			let stepFailed = false;
			for await (const evt of runStep(stepInput)) {
				yield evt;
				if (evt.kind === "step.end" && evt.exitCode !== 0) stepFailed = true;
			}
			if (stepFailed) return;
		}

		const size = sizeOrZero(resolved.outAbs);
		yield {
			kind: "artifact",
			path: resolved.outAbs,
			metadata: {
				bytes: String(size),
			},
		};
		yield { kind: "done", artifact: resolved.outAbs };
	},
};

interface ResolvedTarballPlan {
	outAbs: string;
	includes: string[];
	excludeArgs: string[];
	usingDefaultIncludes: boolean;
}

function resolveTarballPlan(ctx: ShipContext): ResolvedTarballPlan {
	const cfg = ctx.ship.tarball ?? {};
	const ts = compactTimestamp(ctx.now);
	const baseName = ctx.burrow?.id ?? ctx.toml?.project?.name ?? "burrow";

	const outTemplate = cfg.out ?? join(DEFAULT_OUT_DIR, `${baseName}-${ts}.tar.gz`);
	const outRendered = renderTemplate(outTemplate, {
		burrow: baseName,
		ts,
		project: ctx.toml?.project?.name ?? baseName,
	});
	const outAbs = isAbsolute(outRendered) ? outRendered : resolve(ctx.workspace, outRendered);

	let includes: string[];
	let usingDefaultIncludes = false;
	if (cfg.include && cfg.include.length > 0) {
		includes = cfg.include;
	} else if (cfg.out_dir) {
		includes = [cfg.out_dir];
	} else {
		includes = ["."];
		usingDefaultIncludes = true;
	}

	const excludeArgs: string[] = [];
	for (const pattern of DEFAULT_EXCLUDES) {
		excludeArgs.push(`--exclude=${pattern}`);
	}
	// Don't include the artifact dir itself when we're tarring the whole workspace.
	if (usingDefaultIncludes) {
		excludeArgs.push(`--exclude=${DEFAULT_OUT_DIR}`);
	}

	return { outAbs, includes, excludeArgs, usingDefaultIncludes };
}

function renderTemplate(input: string, vars: Record<string, string>): string {
	return input.replace(/\{(\w+)\}/g, (m, key) => (key in vars ? (vars[key] ?? m) : m));
}

function compactTimestamp(now: Date): string {
	// e.g. 20260507T204512Z — sortable, filename-safe, no separators.
	const iso = now.toISOString();
	return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function sizeOrZero(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}
