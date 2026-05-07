import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { Client } from "../../lib/client.ts";
import { ShipRegistry } from "../../ship/registry.ts";
import type { ShipContext, ShipEvent, ShipTarget } from "../../ship/target.ts";
import { runShipCommand } from "./ship.ts";

const NOW = new Date("2026-05-07T20:45:12.000Z");

interface RecordingTarget extends ShipTarget {
	calls: { ctx: ShipContext; phase: "validate" | "installCheck" | "plan" | "execute" }[];
	events: ShipEvent[];
	executed: boolean;
}

function makeRecordingTarget(
	id: string,
	overrides: Partial<RecordingTarget> = {},
): RecordingTarget {
	const target: RecordingTarget = {
		id,
		description: `recording ${id}`,
		calls: [],
		events: [],
		executed: false,
		validate(ctx) {
			target.calls.push({ ctx, phase: "validate" });
		},
		async installCheck(ctx) {
			target.calls.push({ ctx, phase: "installCheck" });
			return { ok: true, binary: id, path: `/usr/bin/${id}` };
		},
		async plan(ctx) {
			target.calls.push({ ctx, phase: "plan" });
			return {
				target: id,
				artifact: `${id}://artifact`,
				steps: [{ description: "noop", command: ["true"] }],
			};
		},
		async *execute(ctx): AsyncGenerator<ShipEvent, void, void> {
			target.calls.push({ ctx, phase: "execute" });
			target.executed = true;
			const plan = await target.plan(ctx);
			target.calls.pop(); // remove the plan call we just re-triggered
			yield { kind: "plan", plan };
			if (ctx.dryRun) return;
			yield { kind: "step.start", index: 0, description: "noop" };
			yield { kind: "step.end", index: 0, exitCode: 0 };
			yield { kind: "artifact", path: `${id}://artifact` };
			yield { kind: "done", artifact: `${id}://artifact` };
		},
		...overrides,
	};
	return target;
}

class CapturingStdout {
	chunks: string[] = [];
	write(chunk: string): void {
		this.chunks.push(chunk);
	}
	get text(): string {
		return this.chunks.join("");
	}
}

describe("runShipCommand", () => {
	let projectRoot: string;
	let registry: ShipRegistry;
	let target: RecordingTarget;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "burrow-ship-cli-"));
		registry = new ShipRegistry();
		target = makeRecordingTarget("tarball");
		registry.register(target);
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("requires a target when no flag and no default_target", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `# empty\n`);
		const stdout = new CapturingStdout();
		await expect(
			runShipCommand({
				projectRoot,
				options: {},
				stdout,
				registry,
				now: NOW,
			}),
		).rejects.toBeInstanceOf(ValidationError);
	});

	test("--target flag overrides [ship].default_target", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[ship]\ndefault_target = "tarball"\n`);
		const other = makeRecordingTarget("docker");
		registry.register(other);
		const stdout = new CapturingStdout();
		const result = await runShipCommand({
			projectRoot,
			options: { target: "docker" },
			stdout,
			registry,
			now: NOW,
		});
		expect(result.target).toBe("docker");
		expect(other.executed).toBe(true);
		expect(target.executed).toBe(false);
	});

	test("dry-run skips post-plan events", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[ship]\ndefault_target = "tarball"\n`);
		const stdout = new CapturingStdout();
		const result = await runShipCommand({
			projectRoot,
			options: { dryRun: true },
			stdout,
			registry,
			now: NOW,
		});
		expect(result.dryRun).toBe(true);
		expect(result.state).toBe("succeeded");
		// Stdout should not contain step.start since dry-run halts after plan.
		expect(stdout.text).not.toContain("step.start");
	});

	test("non-zero step exit marks state=failed and surfaces exit codes", async () => {
		// Custom target ids aren't allowed in [ship].default_target (schema-locked
		// to built-ins), so the CLI flag --target is the supported way to reach
		// a custom ShipTarget — exercise that path here.
		const failing = makeRecordingTarget("flaky", {
			async *execute(ctx): AsyncGenerator<ShipEvent, void, void> {
				yield { kind: "plan", plan: await failing.plan(ctx) };
				yield { kind: "step.start", index: 0, description: "x" };
				yield { kind: "step.end", index: 0, exitCode: 9 };
			},
		});
		registry.register(failing);
		const stdout = new CapturingStdout();
		const result = await runShipCommand({
			projectRoot,
			options: { target: "flaky" },
			stdout,
			registry,
			now: NOW,
		});
		expect(result.state).toBe("failed");
		expect(result.exitCodes).toEqual([9]);
	});

	test("installCheck failure throws ValidationError before execute()", async () => {
		const broken = makeRecordingTarget("broken", {
			async installCheck() {
				return { ok: false, binary: "broken", detail: "missing" };
			},
		});
		registry.register(broken);
		writeFileSync(join(projectRoot, "burrow.toml"), `[ship]\ndefault_target = "broken"\n`);
		const stdout = new CapturingStdout();
		await expect(
			runShipCommand({
				projectRoot,
				options: {},
				stdout,
				registry,
				now: NOW,
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(broken.executed).toBe(false);
	});

	test("--json forces NDJSON output of every event", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[ship]\ndefault_target = "tarball"\n`);
		const stdout = new CapturingStdout();
		await runShipCommand({
			projectRoot,
			options: { json: true },
			stdout,
			registry,
			isTty: true,
			now: NOW,
		});
		const lines = stdout.text.trim().split("\n");
		// Each line is a JSON-parseable event.
		const kinds = lines.map((l) => JSON.parse(l).kind);
		expect(kinds).toContain("plan");
		expect(kinds).toContain("done");
	});

	test("non-TTY stdout defaults to NDJSON unless --json=false", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[ship]\ndefault_target = "tarball"\n`);
		const stdout = new CapturingStdout();
		await runShipCommand({
			projectRoot,
			options: {},
			stdout,
			registry,
			isTty: false,
			now: NOW,
		});
		const firstLine = stdout.text.trim().split("\n")[0];
		expect(() => firstLine && JSON.parse(firstLine)).not.toThrow();
	});

	test("--quiet suppresses per-step events but keeps plan/artifact/done", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[ship]\ndefault_target = "tarball"\n`);
		const stdout = new CapturingStdout();
		await runShipCommand({
			projectRoot,
			options: { quiet: true, json: true },
			stdout,
			registry,
			isTty: true,
			now: NOW,
		});
		const kinds = stdout.text
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l).kind);
		expect(kinds).toContain("plan");
		expect(kinds).toContain("done");
		expect(kinds).not.toContain("step.start");
		expect(kinds).not.toContain("step.end");
	});

	test("explicit unknown burrow id throws NotFoundError", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "burrow-ship-data-"));
		const client = await Client.open({ dataDir, configDir: dataDir });
		try {
			writeFileSync(join(projectRoot, "burrow.toml"), `[ship]\ndefault_target = "tarball"\n`);
			const stdout = new CapturingStdout();
			await expect(
				runShipCommand({
					client,
					projectRoot,
					burrowId: "burrow-missing",
					options: {},
					stdout,
					registry,
					now: NOW,
				}),
			).rejects.toBeInstanceOf(NotFoundError);
		} finally {
			await client.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
