import { describe, expect, test } from "bun:test";
import {
	AgentNotInstalled,
	AgentRuntimeError,
	BurrowError,
	CredentialError,
	NotFoundError,
	SandboxError,
	SandboxPrimitiveMissing,
	SecretResolutionError,
	ToolchainMismatch,
	ValidationError,
	WorkerDrainingError,
	WorkspaceMaterializationError,
} from "../core/errors.ts";
import { SidecarCapExceededError } from "../server/sidecars.ts";
import { exitCodeFor } from "./exit-codes.ts";

/**
 * Pins the CLI exit-code contract per SPEC §16. The CLI uses five coarse
 * buckets — it is intentionally NOT a 1:1 mirror of src/server/errors.ts
 * statusFor(). Most BurrowError subclasses fall through to the generic `1`,
 * which is the documented contract. Update this test only when SPEC §16
 * itself changes.
 */
describe("exitCodeFor (SPEC §16 buckets)", () => {
	test("ValidationError → 3 (invalid input)", () => {
		expect(exitCodeFor(new ValidationError("bad"))).toBe(3);
	});

	test("NotFoundError → 2 (not found)", () => {
		expect(exitCodeFor(new NotFoundError("missing"))).toBe(2);
	});

	test("SandboxError → 4 (runtime/sandbox)", () => {
		expect(exitCodeFor(new SandboxError("bwrap failed"))).toBe(4);
	});

	test("SandboxPrimitiveMissing → 4 (extends SandboxError)", () => {
		expect(exitCodeFor(new SandboxPrimitiveMissing("no bwrap"))).toBe(4);
	});

	test("AgentNotInstalled → 4 (runtime)", () => {
		expect(exitCodeFor(new AgentNotInstalled("missing claude-code"))).toBe(4);
	});

	test("AgentRuntimeError → 4 (runtime)", () => {
		expect(exitCodeFor(new AgentRuntimeError("agent crashed"))).toBe(4);
	});

	test("WorkspaceMaterializationError → 1 (generic fallback)", () => {
		expect(exitCodeFor(new WorkspaceMaterializationError("oops"))).toBe(1);
	});

	test("ToolchainMismatch → 1 (generic fallback)", () => {
		expect(exitCodeFor(new ToolchainMismatch("bun drift"))).toBe(1);
	});

	test("SecretResolutionError → 1 (generic fallback)", () => {
		expect(exitCodeFor(new SecretResolutionError("secret"))).toBe(1);
	});

	test("CredentialError → 1 (generic fallback)", () => {
		expect(exitCodeFor(new CredentialError("auth"))).toBe(1);
	});

	test("WorkerDrainingError → 1 (generic fallback)", () => {
		expect(exitCodeFor(new WorkerDrainingError("draining"))).toBe(1);
	});

	test("SidecarCapExceededError → 1 (generic fallback)", () => {
		expect(exitCodeFor(new SidecarCapExceededError("cap"))).toBe(1);
	});

	test("unknown BurrowError subclass → 1", () => {
		class CustomBurrowError extends BurrowError {
			readonly code = "custom_error";
		}
		expect(exitCodeFor(new CustomBurrowError("x"))).toBe(1);
	});

	test("plain Error → 1", () => {
		expect(exitCodeFor(new Error("kaboom"))).toBe(1);
	});

	test("non-Error throw → 1", () => {
		expect(exitCodeFor("just a string")).toBe(1);
	});
});
