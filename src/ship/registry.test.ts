import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { BUILT_IN_SHIP_TARGETS, defaultShipRegistry, ShipRegistry } from "./registry.ts";
import type { ShipTarget } from "./target.ts";

const fakeTarget: ShipTarget = {
	id: "fake",
	description: "test fake",
	validate(): void {},
	async installCheck() {
		return { ok: true };
	},
	async plan() {
		return { target: "fake", artifact: "fake://", steps: [] };
	},
	async *execute() {
		yield { kind: "done", artifact: "fake://" };
	},
};

describe("ShipRegistry", () => {
	test("register + get + has", () => {
		const reg = new ShipRegistry();
		expect(reg.has("fake")).toBe(false);
		reg.register(fakeTarget);
		expect(reg.has("fake")).toBe(true);
		expect(reg.get("fake")?.id).toBe("fake");
	});

	test("require throws ValidationError for unknown id with hint", () => {
		const reg = new ShipRegistry();
		try {
			reg.require("nope");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ValidationError);
			expect((err as Error).message).toContain("nope");
		}
	});

	test("last-write-wins on duplicate id", () => {
		const reg = new ShipRegistry();
		reg.register(fakeTarget);
		const replacement: ShipTarget = { ...fakeTarget, description: "second" };
		reg.register(replacement);
		expect(reg.get("fake")?.description).toBe("second");
	});

	test("unregister returns true only when an entry existed", () => {
		const reg = new ShipRegistry();
		reg.register(fakeTarget);
		expect(reg.unregister("fake")).toBe(true);
		expect(reg.unregister("fake")).toBe(false);
	});
});

describe("defaultShipRegistry", () => {
	test("includes all three V1 built-ins", () => {
		const reg = defaultShipRegistry();
		for (const id of BUILT_IN_SHIP_TARGETS) {
			expect(reg.has(id)).toBe(true);
		}
	});

	test("BUILT_IN_SHIP_TARGETS matches the constant order", () => {
		expect([...BUILT_IN_SHIP_TARGETS]).toEqual(["tarball", "docker", "fly"]);
	});
});
