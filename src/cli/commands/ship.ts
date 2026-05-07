/**
 * `burrow ship [<id>]` — build + deploy artifacts via the selected ShipTarget
 * (SPEC §16, §22 Phase 9).
 *
 * Resolution: if `<id>` is given, look it up; otherwise resolve to the unique
 * project burrow whose projectRoot matches `cwd` (mirrors the doctor + up
 * pattern). If neither path yields a burrow we still let the caller ship —
 * the workspace is the cwd, and config falls back to a fresh `burrow.toml` load.
 *
 * Target resolution: `--target` flag wins over `[ship].default_target`. If
 * neither is set, we error with the list of registered targets.
 *
 * Output: events stream as NDJSON when --json is set OR stdout is not a TTY
 * (matches the logs/events convention). Pretty mode prints one line per
 * event.
 */

import { resolve } from "node:path";
import { type LoadedBurrowToml, loadBurrowToml } from "../../config/burrow-toml-loader.ts";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import type { Burrow } from "../../core/types.ts";
import type { Client } from "../../lib/client.ts";
import type { BurrowTomlShip } from "../../schemas/burrow-toml.ts";
import { defaultShipRegistry, type ShipRegistry } from "../../ship/registry.ts";
import type { ShipContext, ShipEvent, ShipPlan, ShipTarget } from "../../ship/target.ts";

export interface ShipCommandOptions {
	/** Override [ship].default_target. */
	target?: string;
	/** Stop after planning; do not invoke any side-effecting commands. */
	dryRun?: boolean;
	/** Force NDJSON output (default when stdout is not a TTY). */
	json?: boolean;
	/** Suppress the per-step event stream — only emit the final `done` line. */
	quiet?: boolean;
}

export interface ShipCommandInput {
	client?: Client;
	/** Burrow id to ship (optional; falls back to project burrow at cwd). */
	burrowId?: string;
	/** Project root used when no burrow is matched. Defaults to cwd. */
	projectRoot?: string;
	options: ShipCommandOptions;
	stdout: { write(chunk: string): void };
	signal?: AbortSignal;
	isTty?: boolean;
	/** Test seam — defaults to defaultShipRegistry(). */
	registry?: ShipRegistry;
	/** Test seam — synthetic clock for stable plan output. */
	now?: Date;
	/** Test seam — load function for burrow.toml. */
	loadToml?: (root: string) => Promise<LoadedBurrowToml | null>;
}

export interface ShipCommandResult {
	target: string;
	plan: ShipPlan;
	dryRun: boolean;
	state: "succeeded" | "failed" | "cancelled";
	artifact?: string;
	exitCodes: number[];
}

export async function runShipCommand(input: ShipCommandInput): Promise<ShipCommandResult> {
	const projectRoot = resolve(input.projectRoot ?? process.cwd());
	const registry = input.registry ?? defaultShipRegistry();
	const loadToml = input.loadToml ?? loadBurrowToml;

	const burrow = resolveBurrow(input, projectRoot);
	const workspace = burrow?.workspacePath ?? projectRoot;
	const tomlRoot = burrow?.projectRoot ?? projectRoot;
	const loaded = await loadToml(tomlRoot);
	const toml = loaded?.config ?? null;

	const ship: BurrowTomlShip = toml?.ship ?? {};
	const targetId = input.options.target ?? ship.default_target;
	if (!targetId) {
		throw new ValidationError(
			"no ship target selected — pass --target <fly|docker|tarball> or set [ship].default_target",
			{
				recoveryHint: `registered targets: ${registry
					.list()
					.map((t) => t.id)
					.join(", ")}`,
			},
		);
	}
	const target = registry.require(targetId);

	const ctx: ShipContext = {
		workspace,
		ship,
		toml: toml ?? null,
		now: input.now ?? new Date(),
		dryRun: input.options.dryRun === true,
	};
	if (burrow) ctx.burrow = burrow;
	if (input.signal) ctx.signal = input.signal;

	target.validate(ctx);
	const installed = await target.installCheck(ctx);
	if (!installed.ok) {
		throw new ValidationError(
			installed.detail ?? `ship target '${target.id}' is missing its required tool`,
			{ recoveryHint: `install ${installed.binary ?? target.id} and retry` },
		);
	}

	const plan = await target.plan(ctx);
	const renderJson =
		input.options.json === true || (input.isTty === false && input.options.json !== false);
	const quiet = input.options.quiet === true;

	let lastPlan = plan;
	let lastArtifact: string | undefined;
	const exitCodes: number[] = [];
	let state: ShipCommandResult["state"] = "succeeded";

	const printer = (evt: ShipEvent): void => {
		if (quiet && evt.kind !== "done" && evt.kind !== "artifact" && evt.kind !== "plan") return;
		if (renderJson) {
			input.stdout.write(`${JSON.stringify(evt)}\n`);
		} else {
			input.stdout.write(`${renderShipEventPretty(evt, target)}\n`);
		}
	};

	let aborted = false;
	const onAbort = (): void => {
		aborted = true;
	};
	if (input.signal) {
		if (input.signal.aborted) aborted = true;
		else input.signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		for await (const evt of target.execute(ctx)) {
			printer(evt);
			if (evt.kind === "plan") lastPlan = evt.plan;
			else if (evt.kind === "artifact") lastArtifact = evt.path;
			else if (evt.kind === "step.end") {
				exitCodes.push(evt.exitCode);
				if (evt.exitCode !== 0) state = "failed";
			} else if (evt.kind === "done") {
				lastArtifact = evt.artifact;
			}
		}
	} finally {
		if (input.signal) input.signal.removeEventListener("abort", onAbort);
	}

	if (aborted) state = "cancelled";

	const result: ShipCommandResult = {
		target: target.id,
		plan: lastPlan,
		dryRun: ctx.dryRun === true,
		state,
		exitCodes,
	};
	if (lastArtifact !== undefined) result.artifact = lastArtifact;
	return result;
}

function resolveBurrow(input: ShipCommandInput, projectRoot: string): Burrow | undefined {
	if (!input.client) return undefined;
	if (input.burrowId !== undefined) {
		const found = input.client.burrows.tryGet(input.burrowId);
		if (!found) {
			throw new NotFoundError(`burrow not found: ${input.burrowId}`);
		}
		return found;
	}
	const candidates = input.client.burrows.list({ kind: "project", projectRoot });
	const live = candidates.filter((b) => b.state !== "destroyed");
	if (live.length === 0) return undefined;
	if (live.length > 1) {
		throw new ValidationError(
			`multiple project burrows found at ${projectRoot}: ${live.map((b) => b.id).join(", ")}`,
			{ recoveryHint: "pass an explicit <id> argument" },
		);
	}
	return live[0];
}

export function renderShipEventPretty(event: ShipEvent, target: ShipTarget): string {
	switch (event.kind) {
		case "plan": {
			const head = `> plan (${event.plan.target}) → ${event.plan.artifact}`;
			const lines = [head];
			for (let i = 0; i < event.plan.steps.length; i++) {
				const step = event.plan.steps[i];
				if (!step) continue;
				lines.push(`  ${i + 1}. ${step.description}`);
				if (step.command) {
					lines.push(`     $ ${step.command.join(" ")}`);
				}
			}
			if (event.plan.notes) {
				for (const n of event.plan.notes) lines.push(`  ! ${n}`);
			}
			return lines.join("\n");
		}
		case "step.start":
			return `> step ${event.index + 1}: ${event.description}`;
		case "step.stdout":
			return `  ${event.line}`;
		case "step.stderr":
			return `  [stderr] ${event.line}`;
		case "step.end":
			return event.exitCode === 0
				? `  ✓ step ${event.index + 1} completed`
				: `  ✗ step ${event.index + 1} exited with code ${event.exitCode}`;
		case "artifact":
			return `> artifact: ${event.path}`;
		case "done":
			return `✓ ${target.id}: shipped ${event.artifact}`;
	}
}

export function shipResultToJson(result: ShipCommandResult): string {
	return JSON.stringify(result, null, 2);
}
