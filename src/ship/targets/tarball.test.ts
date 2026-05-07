import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../../core/errors.ts";
import type { ShipContext, ShipEvent } from "../target.ts";
import { tarballShipTarget } from "./tarball.ts";

const NOW = new Date("2026-05-07T20:45:12.000Z");

function makeCtx(workspace: string, overrides: Partial<ShipContext> = {}): ShipContext {
	return {
		workspace,
		ship: {},
		toml: null,
		now: NOW,
		...overrides,
	};
}

async function collect(gen: AsyncGenerator<ShipEvent, void, void>): Promise<ShipEvent[]> {
	const out: ShipEvent[] = [];
	for await (const e of gen) out.push(e);
	return out;
}

describe("tarballShipTarget", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "burrow-ship-tar-"));
		writeFileSync(join(workspace, "package.json"), `{"name":"sample"}`);
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	test("validate rejects empty out / out_dir / include", () => {
		expect(() =>
			tarballShipTarget.validate(makeCtx(workspace, { ship: { tarball: { out: " " } } })),
		).toThrow(ValidationError);
		expect(() =>
			tarballShipTarget.validate(makeCtx(workspace, { ship: { tarball: { out_dir: "" } } })),
		).toThrow(ValidationError);
		expect(() =>
			tarballShipTarget.validate(makeCtx(workspace, { ship: { tarball: { include: [] } } })),
		).toThrow(ValidationError);
	});

	test("plan() bakes a deterministic artifact path from now + project name", async () => {
		const plan = await tarballShipTarget.plan(
			makeCtx(workspace, { toml: { project: { name: "demo" } } }),
		);
		expect(plan.target).toBe("tarball");
		expect(plan.artifact).toContain("demo-20260507T204512Z.tar.gz");
		expect(plan.steps[0]?.command).toContain("tar");
	});

	test("plan() prepends [ship].build commands as their own steps", async () => {
		const plan = await tarballShipTarget.plan(
			makeCtx(workspace, { ship: { build: ["echo first", "echo second"] } }),
		);
		expect(plan.steps).toHaveLength(3);
		expect(plan.steps[0]?.description).toContain("echo first");
		expect(plan.steps[1]?.description).toContain("echo second");
		expect(plan.steps[2]?.description).toContain("tar");
	});

	test("execute() with --dry-run only emits the plan event", async () => {
		const events = await collect(tarballShipTarget.execute(makeCtx(workspace, { dryRun: true })));
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("plan");
		// dry-run must not write any artifact
		const expected = join(workspace, "dist", `burrow-20260507T204512Z.tar.gz`);
		expect(existsSync(expected)).toBe(false);
	});

	test("execute() really packages the workspace into a .tar.gz", async () => {
		const events = await collect(tarballShipTarget.execute(makeCtx(workspace)));
		const done = events.at(-1);
		expect(done?.kind).toBe("done");
		const artifact = (done as { kind: "done"; artifact: string }).artifact;
		expect(existsSync(artifact)).toBe(true);
		expect(statSync(artifact).size).toBeGreaterThan(0);
		// .tar.gz starts with the gzip magic bytes 1f 8b.
		const bytes = readFileSync(artifact);
		expect(bytes[0]).toBe(0x1f);
		expect(bytes[1]).toBe(0x8b);
	});

	test("execute() respects an explicit out + include set", async () => {
		writeFileSync(join(workspace, "extra.txt"), "hello");
		const out = join(workspace, "out", "custom.tar.gz");
		const events = await collect(
			tarballShipTarget.execute(
				makeCtx(workspace, {
					ship: { tarball: { out, include: ["extra.txt"] } },
				}),
			),
		);
		expect(events.at(-1)?.kind).toBe("done");
		expect(existsSync(out)).toBe(true);
	});

	test("execute() halts when a build step fails (no artifact event)", async () => {
		const events = await collect(
			tarballShipTarget.execute(makeCtx(workspace, { ship: { build: ["sh -c 'exit 7'"] } })),
		);
		const endIdx = events.findIndex((e) => e.kind === "step.end");
		expect(endIdx).toBeGreaterThan(-1);
		expect((events[endIdx] as { exitCode: number }).exitCode).toBe(7);
		expect(events.some((e) => e.kind === "artifact")).toBe(false);
		expect(events.some((e) => e.kind === "done")).toBe(false);
	});
});
