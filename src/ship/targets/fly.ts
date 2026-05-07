/**
 * `fly` ShipTarget — runs `flyctl deploy` against the workspace.
 *
 * Stress-tests the ShipTarget interface for the real-world end of the
 * spectrum: requires auth (an active flyctl session), reaches the network,
 * and *composes the docker target* as its build substrate. flyctl handles the
 * docker build internally; we just shell out to it after running any [ship].build
 * pre-deploy commands.
 *
 * `[ship.fly].config` defaults to `fly.toml` at the workspace root. The app
 * name is required even when the toml itself declares one — explicit > implicit.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ValidationError } from "../../core/errors.ts";
import { probeBinary, runStep } from "../run.ts";
import type { ShipContext, ShipEvent, ShipInstallCheck, ShipPlan, ShipTarget } from "../target.ts";

export const flyShipTarget: ShipTarget = {
	id: "fly",
	description: "deploy to fly.io via flyctl (composes docker build)",

	validate(ctx: ShipContext): void {
		const cfg = ctx.ship.fly;
		if (!cfg) {
			throw new ValidationError(
				"[ship.fly] is required when using --target fly — declare at least { app }",
			);
		}
		if (cfg.app.trim().length === 0) {
			throw new ValidationError("[ship.fly].app cannot be empty");
		}
	},

	async installCheck(_ctx: ShipContext): Promise<ShipInstallCheck> {
		const path = await probeBinary("flyctl");
		if (!path) {
			return {
				ok: false,
				binary: "flyctl",
				detail:
					"`flyctl` not found on $PATH — install via https://fly.io/docs/flyctl/install/ then `fly auth login`",
			};
		}
		return { ok: true, binary: "flyctl", path };
	},

	async plan(ctx: ShipContext): Promise<ShipPlan> {
		const resolved = resolveFlyPlan(ctx);
		const argv = buildFlyArgv(resolved);
		const steps =
			ctx.ship.build && ctx.ship.build.length > 0
				? ctx.ship.build.map((cmd) => ({
						description: `run build step: ${cmd}`,
						command: ["sh", "-c", cmd],
						cwd: ctx.workspace,
					}))
				: [];
		steps.push({
			description: `flyctl deploy → ${resolved.app}`,
			command: argv,
			cwd: ctx.workspace,
		});
		const plan: ShipPlan = {
			target: "fly",
			artifact: `fly:${resolved.app}`,
			steps,
		};
		const notes: string[] = [];
		if (!existsSync(resolved.configAbs)) {
			notes.push(
				`fly config not found at ${resolved.configAbs} — flyctl will require --config or fail`,
			);
		}
		if (notes.length > 0) plan.notes = notes;
		return plan;
	},

	async *execute(ctx: ShipContext): AsyncGenerator<ShipEvent, void, void> {
		const plan = await this.plan(ctx);
		yield { kind: "plan", plan };
		if (ctx.dryRun) return;

		const resolved = resolveFlyPlan(ctx);

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

		yield {
			kind: "artifact",
			path: `fly:${resolved.app}`,
			metadata: {
				app: resolved.app,
				config: resolved.configAbs,
				...(resolved.region ? { region: resolved.region } : {}),
				...(resolved.strategy ? { strategy: resolved.strategy } : {}),
			},
		};
		yield { kind: "done", artifact: `fly:${resolved.app}` };
	},
};

export interface ResolvedFlyPlan {
	app: string;
	configAbs: string;
	region?: string;
	strategy?: string;
}

export function resolveFlyPlan(ctx: ShipContext): ResolvedFlyPlan {
	const cfg = ctx.ship.fly;
	if (!cfg) throw new ValidationError("[ship.fly] missing");
	const configRel = cfg.config ?? "fly.toml";
	const configAbs = isAbsolute(configRel) ? configRel : resolve(ctx.workspace, configRel);
	const out: ResolvedFlyPlan = {
		app: cfg.app,
		configAbs,
	};
	if (cfg.region !== undefined) out.region = cfg.region;
	if (cfg.strategy !== undefined) out.strategy = cfg.strategy;
	return out;
}

export function buildFlyArgv(resolved: ResolvedFlyPlan): string[] {
	const argv = ["flyctl", "deploy", "--app", resolved.app, "--config", resolved.configAbs];
	if (resolved.region) argv.push("--region", resolved.region);
	if (resolved.strategy) argv.push("--strategy", resolved.strategy);
	return argv;
}
