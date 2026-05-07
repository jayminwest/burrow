import { describe, expect, test } from "bun:test";
import type { SandboxProfile, SpawnCommand } from "../types.ts";
import { buildBwrapArgv, SYSTEM_RO_MOUNTS } from "./bwrap.ts";

function baseProfile(over: Partial<SandboxProfile> = {}): SandboxProfile {
	return {
		workspace: "/host/workspaces/bur_x",
		readOnlyMounts: [],
		network: "none",
		allowedDomains: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: [],
		...over,
	};
}

const cmd = (over: Partial<SpawnCommand> = {}): SpawnCommand => ({
	argv: ["echo", "hi"],
	...over,
});

describe("buildBwrapArgv", () => {
	test("starts with `bwrap --unshare-all`, ends with `-- argv`", () => {
		const argv = buildBwrapArgv(baseProfile(), cmd(), { hostEnv: {} });
		expect(argv[0]).toBe("bwrap");
		expect(argv).toContain("--unshare-all");
		const dashDash = argv.indexOf("--");
		expect(dashDash).toBeGreaterThan(0);
		expect(argv.slice(dashDash + 1)).toEqual(["echo", "hi"]);
	});

	test("network=open shares the host net namespace", () => {
		const argv = buildBwrapArgv(baseProfile({ network: "open" }), cmd(), { hostEnv: {} });
		expect(argv).toContain("--share-net");
	});

	test("network=none and network=restricted both keep net unshared", () => {
		const none = buildBwrapArgv(baseProfile({ network: "none" }), cmd(), { hostEnv: {} });
		const restricted = buildBwrapArgv(
			baseProfile({ network: "restricted", allowedDomains: ["github.com"] }),
			cmd(),
			{ hostEnv: {} },
		);
		expect(none).not.toContain("--share-net");
		expect(restricted).not.toContain("--share-net");
	});

	test("workspace is bound read-write at /workspace", () => {
		const argv = buildBwrapArgv(baseProfile({ workspace: "/host/ws" }), cmd(), { hostEnv: {} });
		expectAdjacent(argv, "--bind", "/host/ws", "/workspace");
	});

	test("system dirs are bound read-only via --ro-bind-try", () => {
		const argv = buildBwrapArgv(baseProfile(), cmd(), { hostEnv: {} });
		for (const path of SYSTEM_RO_MOUNTS) {
			expectAdjacent(argv, "--ro-bind-try", path, path);
		}
	});

	test("toolchain and ssh agent paths get hard --ro-bind", () => {
		const argv = buildBwrapArgv(
			baseProfile({
				toolchainPaths: ["/opt/homebrew/bin/bun"],
				sshAuthSock: "/run/user/1000/ssh-agent",
			}),
			cmd(),
			{ hostEnv: {} },
		);
		expectAdjacent(argv, "--ro-bind", "/opt/homebrew/bin/bun", "/opt/homebrew/bin/bun");
		expectAdjacent(argv, "--ro-bind", "/run/user/1000/ssh-agent", "/run/user/1000/ssh-agent");
	});

	test("--clearenv wipes host env before --setenv lines", () => {
		const argv = buildBwrapArgv(baseProfile(), cmd(), { hostEnv: { LEAKED: "yes" } });
		const clearIdx = argv.indexOf("--clearenv");
		expect(clearIdx).toBeGreaterThan(0);
		expect(argv).not.toContain("LEAKED");
		// HOME and PATH baseline are always set
		expectAdjacent(argv, "--setenv", "HOME", "/workspace");
		expectAdjacent(argv, "--setenv", "PATH", "/usr/bin:/bin");
	});

	test("envPassthrough forwards host values; setEnv overrides", () => {
		const argv = buildBwrapArgv(
			baseProfile({
				envPassthrough: ["ANTHROPIC_API_KEY", "MISSING_VAR"],
				setEnv: { LOG_LEVEL: "debug", PATH: "/custom/bin" },
			}),
			cmd({ env: { CMD_VAR: "x", LOG_LEVEL: "trace" } }),
			{ hostEnv: { ANTHROPIC_API_KEY: "sk-test" } },
		);
		expectAdjacent(argv, "--setenv", "ANTHROPIC_API_KEY", "sk-test");
		expect(argv).not.toContain("MISSING_VAR");
		expectAdjacent(argv, "--setenv", "PATH", "/custom/bin");
		// command-level env wins over profile setEnv
		expectAdjacent(argv, "--setenv", "LOG_LEVEL", "trace");
		expectAdjacent(argv, "--setenv", "CMD_VAR", "x");
	});

	test("sshAuthSock auto-exports SSH_AUTH_SOCK", () => {
		const argv = buildBwrapArgv(baseProfile({ sshAuthSock: "/tmp/agent.sock" }), cmd(), {
			hostEnv: {},
		});
		expectAdjacent(argv, "--setenv", "SSH_AUTH_SOCK", "/tmp/agent.sock");
	});

	test("--die-with-parent and --chdir /workspace are present", () => {
		const argv = buildBwrapArgv(baseProfile(), cmd(), { hostEnv: {} });
		expect(argv).toContain("--die-with-parent");
		expectAdjacent(argv, "--chdir", "/workspace");
	});

	test("relative cwd resolves under /workspace", () => {
		const argv = buildBwrapArgv(baseProfile(), cmd({ cwd: "src" }), { hostEnv: {} });
		expectAdjacent(argv, "--chdir", "/workspace/src");
	});

	test("absolute cwd is preserved", () => {
		const argv = buildBwrapArgv(baseProfile(), cmd({ cwd: "/workspace/sub" }), { hostEnv: {} });
		expectAdjacent(argv, "--chdir", "/workspace/sub");
	});
});

function expectAdjacent(argv: string[], ...tokens: string[]): void {
	for (let i = 0; i + tokens.length <= argv.length; i++) {
		let ok = true;
		for (let j = 0; j < tokens.length; j++) {
			if (argv[i + j] !== tokens[j]) {
				ok = false;
				break;
			}
		}
		if (ok) return;
	}
	throw new Error(
		`expected adjacent tokens ${JSON.stringify(tokens)} in argv:\n${JSON.stringify(argv, null, 2)}`,
	);
}
