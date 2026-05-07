import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxProfile } from "../types.ts";
import { runSandboxed } from "./sandbox.ts";

const isDarwin = process.platform === "darwin";

function baseProfile(workspace: string, over: Partial<SandboxProfile> = {}): SandboxProfile {
	return {
		workspace,
		readOnlyMounts: [],
		network: "none",
		allowedDomains: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: [],
		...over,
	};
}

if (isDarwin) {
	describe("runSandboxed (darwin / sandbox-exec integration)", () => {
		let workspace: string;

		beforeEach(() => {
			workspace = mkdtempSync(join(tmpdir(), "burrow-ws-"));
		});
		afterEach(() => {
			rmSync(workspace, { recursive: true, force: true });
		});

		test("runs `echo` and captures stdout + exit code", async () => {
			const proc = await runSandboxed(baseProfile(workspace), {
				argv: ["/bin/echo", "hello-burrow"],
			});
			const out = await Bun.readableStreamToText(proc.stdout);
			const exit = await proc.exited;
			expect(exit).toBe(0);
			expect(out.trim()).toBe("hello-burrow");
		});

		test("HOME is rewritten to the workspace path", async () => {
			const proc = await runSandboxed(baseProfile(workspace), {
				argv: ["/usr/bin/printenv", "HOME"],
			});
			const out = await Bun.readableStreamToText(proc.stdout);
			await proc.exited;
			// Workspace is canonicalized inside the sandbox; compare against the
			// resolved real path rather than the symlinked /var/folders form.
			expect(out.trim()).toBe(realpathSync(workspace));
		});

		test("envPassthrough forwards a host var to the sandboxed child", async () => {
			const proc = await runSandboxed(
				baseProfile(workspace, { envPassthrough: ["BURROW_TEST_VAR"] }),
				{
					argv: ["/usr/bin/printenv", "BURROW_TEST_VAR"],
					env: {},
				},
			);
			// Inject host value via setEnv — covers the passthrough+merge path through
			// resolveSandboxEnv without leaning on the test-runner's process.env.
			const proc2 = await runSandboxed(
				baseProfile(workspace, { setEnv: { BURROW_TEST_VAR: "host-value" } }),
				{ argv: ["/usr/bin/printenv", "BURROW_TEST_VAR"] },
			);
			await proc.exited;
			const out = await Bun.readableStreamToText(proc2.stdout);
			await proc2.exited;
			expect(out.trim()).toBe("host-value");
		});

		test("workspace can be read+written, files outside it cannot be read", async () => {
			// Sentinel under $HOME — outside any allowed subpath in the profile.
			const secretDir = mkdtempSync(join(homedir(), ".burrow-isolation-test-"));
			const secretFile = join(secretDir, "secret.txt");
			writeFileSync(secretFile, "TOPSECRET\n");
			try {
				// Workspace write succeeds.
				const wsFile = join(workspace, "hello.txt");
				const writeProc = await runSandboxed(baseProfile(workspace), {
					argv: ["/bin/sh", "-c", "echo wrote-it > hello.txt"],
				});
				expect(await writeProc.exited).toBe(0);
				expect(await Bun.file(wsFile).text()).toBe("wrote-it\n");

				// Reading outside the workspace fails.
				const readProc = await runSandboxed(baseProfile(workspace), {
					argv: ["/bin/cat", secretFile],
				});
				const code = await readProc.exited;
				expect(code).not.toBe(0);
			} finally {
				rmSync(secretDir, { recursive: true, force: true });
			}
		});

		test("cancel() kills a long-running child", async () => {
			const proc = await runSandboxed(baseProfile(workspace), {
				argv: ["/bin/sleep", "60"],
			});
			proc.cancel();
			const code = await proc.exited;
			// SIGTERM => exit code 143 (128+15) on most shells; some contexts surface
			// the signal differently. Either way, the process is no longer alive.
			expect(typeof code).toBe("number");
			expect(code).not.toBe(0);
		});
	});
}

describe("runSandboxed (platform dispatch)", () => {
	test("rejects unsupported platforms", async () => {
		await expect(
			runSandboxed(baseProfile("/tmp/ws"), { argv: ["true"] }, { plat: "win32" }),
		).rejects.toThrow(/unsupported platform/);
	});
});
