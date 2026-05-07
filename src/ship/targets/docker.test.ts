import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../core/errors.ts";
import type { ShipContext } from "../target.ts";
import { buildDockerArgv, dockerShipTarget, resolveDockerPlan } from "./docker.ts";

const NOW = new Date("2026-05-07T20:45:12.000Z");

function makeCtx(overrides: Partial<ShipContext> = {}): ShipContext {
	return {
		workspace: "/repo/web",
		ship: { docker: { image: "myorg/app", tag: "v1" } },
		toml: null,
		now: NOW,
		...overrides,
	};
}

describe("dockerShipTarget — validate", () => {
	test("rejects when [ship.docker] is absent", () => {
		expect(() => dockerShipTarget.validate(makeCtx({ ship: {} }))).toThrow(ValidationError);
	});

	test("rejects empty image / tag", () => {
		expect(() => dockerShipTarget.validate(makeCtx({ ship: { docker: { image: " " } } }))).toThrow(
			ValidationError,
		);
		expect(() =>
			dockerShipTarget.validate(makeCtx({ ship: { docker: { image: "ok", tag: " " } } })),
		).toThrow(ValidationError);
	});

	test("accepts a minimal config", () => {
		expect(() =>
			dockerShipTarget.validate(makeCtx({ ship: { docker: { image: "ok" } } })),
		).not.toThrow();
	});
});

describe("resolveDockerPlan", () => {
	test("defaults dockerfile to ./Dockerfile and tag to latest", () => {
		const r = resolveDockerPlan(makeCtx({ ship: { docker: { image: "x" } } }));
		expect(r.image).toBe("x");
		expect(r.tag).toBe("latest");
		expect(r.imageRef).toBe("x:latest");
		expect(r.dockerfileAbs).toBe("/repo/web/Dockerfile");
		expect(r.contextAbs).toBe("/repo/web");
	});

	test("respects an absolute dockerfile path", () => {
		const r = resolveDockerPlan(
			makeCtx({ ship: { docker: { image: "x", dockerfile: "/tmp/Dockerfile" } } }),
		);
		expect(r.dockerfileAbs).toBe("/tmp/Dockerfile");
	});
});

describe("buildDockerArgv", () => {
	test("emits canonical argv with -f, -t, build-args, platforms, and context", () => {
		const argv = buildDockerArgv({
			image: "x",
			tag: "v1",
			imageRef: "x:v1",
			dockerfileAbs: "/repo/Dockerfile",
			contextAbs: "/repo",
			platforms: ["linux/amd64", "linux/arm64"],
			buildArgs: { NODE_ENV: "production", FOO: "bar" },
		});
		expect(argv[0]).toBe("docker");
		expect(argv[1]).toBe("build");
		expect(argv).toContain("-f");
		expect(argv).toContain("/repo/Dockerfile");
		expect(argv).toContain("-t");
		expect(argv).toContain("x:v1");
		expect(argv.join(" ")).toContain("--platform linux/amd64,linux/arm64");
		expect(argv.join(" ")).toContain("--build-arg NODE_ENV=production");
		expect(argv.join(" ")).toContain("--build-arg FOO=bar");
		// context is the trailing positional
		expect(argv.at(-1)).toBe("/repo");
	});
});

describe("dockerShipTarget — plan + dry-run execute", () => {
	test("plan annotates a missing dockerfile as a note", async () => {
		const plan = await dockerShipTarget.plan(
			makeCtx({ ship: { docker: { image: "x", dockerfile: "/no/such/file" } } }),
		);
		expect(plan.notes?.[0]).toContain("dockerfile not found");
		expect(plan.artifact).toBe("x:latest");
	});

	test("execute() dry-run yields exactly one plan event", async () => {
		const events: { kind: string }[] = [];
		for await (const e of dockerShipTarget.execute(makeCtx({ dryRun: true }))) {
			events.push(e);
		}
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("plan");
	});
});
