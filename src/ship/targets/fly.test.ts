import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../core/errors.ts";
import type { ShipContext } from "../target.ts";
import { buildFlyArgv, flyShipTarget, resolveFlyPlan } from "./fly.ts";

const NOW = new Date("2026-05-07T20:45:12.000Z");

function makeCtx(overrides: Partial<ShipContext> = {}): ShipContext {
	return {
		workspace: "/repo/web",
		ship: { fly: { app: "my-app" } },
		toml: null,
		now: NOW,
		...overrides,
	};
}

describe("flyShipTarget — validate", () => {
	test("rejects when [ship.fly] is absent", () => {
		expect(() => flyShipTarget.validate(makeCtx({ ship: {} }))).toThrow(ValidationError);
	});

	test("rejects empty app", () => {
		expect(() => flyShipTarget.validate(makeCtx({ ship: { fly: { app: " " } } }))).toThrow(
			ValidationError,
		);
	});

	test("accepts a minimal config", () => {
		expect(() => flyShipTarget.validate(makeCtx())).not.toThrow();
	});
});

describe("resolveFlyPlan", () => {
	test("defaults config to fly.toml at workspace root", () => {
		const r = resolveFlyPlan(makeCtx());
		expect(r.app).toBe("my-app");
		expect(r.configAbs).toBe("/repo/web/fly.toml");
		expect(r.region).toBeUndefined();
	});

	test("respects absolute config + region + strategy", () => {
		const r = resolveFlyPlan(
			makeCtx({
				ship: {
					fly: {
						app: "my-app",
						config: "/tmp/fly.toml",
						region: "iad",
						strategy: "rolling",
					},
				},
			}),
		);
		expect(r.configAbs).toBe("/tmp/fly.toml");
		expect(r.region).toBe("iad");
		expect(r.strategy).toBe("rolling");
	});
});

describe("buildFlyArgv", () => {
	test("flyctl deploy with --app, --config, optional --region/--strategy", () => {
		const argv = buildFlyArgv({
			app: "my-app",
			configAbs: "/repo/fly.toml",
			region: "iad",
			strategy: "rolling",
		});
		expect(argv).toEqual([
			"flyctl",
			"deploy",
			"--app",
			"my-app",
			"--config",
			"/repo/fly.toml",
			"--region",
			"iad",
			"--strategy",
			"rolling",
		]);
	});

	test("omits region/strategy when unset", () => {
		const argv = buildFlyArgv({ app: "x", configAbs: "/r/fly.toml" });
		expect(argv).toEqual(["flyctl", "deploy", "--app", "x", "--config", "/r/fly.toml"]);
	});
});

describe("flyShipTarget — plan + dry-run", () => {
	test("plan flags a missing fly.toml as a note", async () => {
		const plan = await flyShipTarget.plan(
			makeCtx({ ship: { fly: { app: "x", config: "/no/such/fly.toml" } } }),
		);
		expect(plan.notes?.[0]).toContain("fly config not found");
		expect(plan.artifact).toBe("fly:x");
	});

	test("execute() dry-run yields exactly one plan event", async () => {
		const events: { kind: string }[] = [];
		for await (const e of flyShipTarget.execute(makeCtx({ dryRun: true }))) {
			events.push(e);
		}
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("plan");
	});
});
