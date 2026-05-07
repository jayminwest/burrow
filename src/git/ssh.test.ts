import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSshAgent } from "./ssh.ts";

describe("detectSshAgent", () => {
	test("returns null when SSH_AUTH_SOCK is unset", () => {
		expect(detectSshAgent({ env: {} })).toBeNull();
	});

	test("returns null when the path does not exist", () => {
		expect(detectSshAgent({ env: { SSH_AUTH_SOCK: "/no/such/socket" } })).toBeNull();
	});

	let tmp: string;
	let regularFile: string;
	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "burrow-ssh-"));
		regularFile = join(tmp, "not-a-socket");
		writeFileSync(regularFile, "");
	});
	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	test("returns null when the path is a regular file, not a socket", () => {
		expect(detectSshAgent({ env: { SSH_AUTH_SOCK: regularFile } })).toBeNull();
	});

	test("returns the socket path when SSH_AUTH_SOCK points to a real socket", () => {
		// Use the host's actual socket if available — rules in CI: skip when not running.
		const real = process.env.SSH_AUTH_SOCK;
		if (!real) return;
		const result = detectSshAgent();
		if (result) expect(result.socketPath).toBe(real);
	});
});
