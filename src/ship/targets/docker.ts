/**
 * `docker` ShipTarget — runs `docker build` against a Dockerfile inside the
 * workspace and tags the result as `<image>:<tag>`.
 *
 * Stress-tests the ShipTarget interface for the long-running, streaming-output
 * end of the spectrum. Build output flows through `step.stdout` / `step.stderr`
 * lines as docker buildkit emits them; cancellation kills the underlying
 * `docker build` child.
 *
 * The image is also a reusable artifact: callers (including the `fly` target)
 * can compose this build by re-using the resolved `<image>:<tag>` reference.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ValidationError } from "../../core/errors.ts";
import { probeBinary, runStep } from "../run.ts";
import type { ShipContext, ShipEvent, ShipInstallCheck, ShipPlan, ShipTarget } from "../target.ts";

export const dockerShipTarget: ShipTarget = {
	id: "docker",
	description: "build + tag a docker image (composable by other targets)",

	validate(ctx: ShipContext): void {
		const cfg = ctx.ship.docker;
		if (!cfg) {
			throw new ValidationError(
				"[ship.docker] is required when using --target docker — declare at least { image }",
			);
		}
		if (cfg.image.trim().length === 0) {
			throw new ValidationError("[ship.docker].image cannot be empty");
		}
		if (cfg.tag !== undefined && cfg.tag.trim().length === 0) {
			throw new ValidationError("[ship.docker].tag cannot be empty when set");
		}
	},

	async installCheck(_ctx: ShipContext): Promise<ShipInstallCheck> {
		const path = await probeBinary("docker");
		if (!path) {
			return {
				ok: false,
				binary: "docker",
				detail: "`docker` not found on $PATH — install Docker Desktop or the docker engine",
			};
		}
		return { ok: true, binary: "docker", path };
	},

	async plan(ctx: ShipContext): Promise<ShipPlan> {
		const resolved = resolveDockerPlan(ctx);
		const argv = buildDockerArgv(resolved);
		const steps =
			ctx.ship.build && ctx.ship.build.length > 0
				? ctx.ship.build.map((cmd) => ({
						description: `run build step: ${cmd}`,
						command: ["sh", "-c", cmd],
						cwd: ctx.workspace,
					}))
				: [];
		steps.push({
			description: `docker build → ${resolved.imageRef}`,
			command: argv,
			cwd: ctx.workspace,
		});
		const plan: ShipPlan = {
			target: "docker",
			artifact: resolved.imageRef,
			steps,
		};
		if (!existsSync(resolved.dockerfileAbs)) {
			plan.notes = [
				`dockerfile not found at ${resolved.dockerfileAbs} — execute will fail unless created first`,
			];
		}
		return plan;
	},

	async *execute(ctx: ShipContext): AsyncGenerator<ShipEvent, void, void> {
		const plan = await this.plan(ctx);
		yield { kind: "plan", plan };
		if (ctx.dryRun) return;

		const resolved = resolveDockerPlan(ctx);

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
			path: resolved.imageRef,
			metadata: {
				image: resolved.image,
				tag: resolved.tag,
				dockerfile: resolved.dockerfileAbs,
			},
		};
		yield { kind: "done", artifact: resolved.imageRef };
	},
};

export interface ResolvedDockerPlan {
	image: string;
	tag: string;
	imageRef: string;
	dockerfileAbs: string;
	contextAbs: string;
	platforms: string[];
	buildArgs: Record<string, string>;
}

export function resolveDockerPlan(ctx: ShipContext): ResolvedDockerPlan {
	const cfg = ctx.ship.docker;
	if (!cfg) {
		throw new ValidationError("[ship.docker] missing");
	}
	const image = cfg.image;
	const tag = cfg.tag ?? "latest";
	const imageRef = `${image}:${tag}`;
	const dockerfileRel = cfg.dockerfile ?? "Dockerfile";
	const dockerfileAbs = isAbsolute(dockerfileRel)
		? dockerfileRel
		: resolve(ctx.workspace, dockerfileRel);
	const contextRel = cfg.context ?? ".";
	const contextAbs = isAbsolute(contextRel) ? contextRel : resolve(ctx.workspace, contextRel);
	return {
		image,
		tag,
		imageRef,
		dockerfileAbs,
		contextAbs,
		platforms: cfg.platforms ?? [],
		buildArgs: cfg.build_args ?? {},
	};
}

export function buildDockerArgv(resolved: ResolvedDockerPlan): string[] {
	const argv = ["docker", "build", "-f", resolved.dockerfileAbs, "-t", resolved.imageRef];
	if (resolved.platforms.length > 0) {
		argv.push("--platform", resolved.platforms.join(","));
	}
	for (const [k, v] of Object.entries(resolved.buildArgs)) {
		argv.push("--build-arg", `${k}=${v}`);
	}
	argv.push(resolved.contextAbs);
	return argv;
}
