import { describe, expect, test } from "bun:test";
import type { SandboxProfile } from "../types.ts";
import { buildSeatbeltArgv, buildSeatbeltProfile, SYSTEM_READ_SUBPATHS } from "./seatbelt.ts";

function baseProfile(over: Partial<SandboxProfile> = {}): SandboxProfile {
	return {
		workspace: "/Users/u/ws",
		readOnlyMounts: [],
		network: "none",
		allowedDomains: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: [],
		...over,
	};
}

describe("buildSeatbeltProfile", () => {
	test("starts with version + deny-default", () => {
		const out = buildSeatbeltProfile(baseProfile());
		expect(out).toContain("(version 1)");
		expect(out).toContain("(deny default)");
	});

	test("system subpaths are allowed read", () => {
		const out = buildSeatbeltProfile(baseProfile());
		for (const path of SYSTEM_READ_SUBPATHS) {
			expect(out).toContain(`(allow file-read* (subpath "${path}"))`);
		}
	});

	test("workspace is allowed read+write", () => {
		const out = buildSeatbeltProfile(baseProfile({ workspace: "/Users/u/ws" }));
		expect(out).toContain('(subpath "/Users/u/ws")');
		expect(out).toMatch(/file-write\*.*\(subpath "\/Users\/u\/ws"\)/);
	});

	test("network=open allows network*", () => {
		const out = buildSeatbeltProfile(baseProfile({ network: "open" }));
		expect(out).toContain("(allow network*)");
	});

	test("network=none emits no network rule", () => {
		const out = buildSeatbeltProfile(baseProfile({ network: "none" }));
		expect(out).not.toMatch(/allow network/);
	});

	test("network=restricted with proxyAddress allows loopback to the proxy port", () => {
		const out = buildSeatbeltProfile(
			baseProfile({
				network: "restricted",
				allowedDomains: ["registry.npmjs.org", "github.com"],
				proxyAddress: { host: "127.0.0.1", port: 51234 },
			}),
		);
		// sandbox-exec's `remote tcp` only accepts `localhost`/`*` as the
		// host token; numeric IPs raise a parse error. The host-side proxy
		// enforces the domain allowlist behind that loopback endpoint.
		expect(out).toContain('(allow network-outbound (remote tcp "localhost:51234"))');
		expect(out).not.toMatch(/127\.0\.0\.1:51234/);
		// Domain rules are no longer in the profile (sandbox-exec can't
		// match by hostname after DNS — see burrow-14b6).
		expect(out).not.toMatch(/regex/);
		expect(out).not.toContain("mDNSResponder");
	});

	test("network=restricted without proxyAddress denies all outbound", () => {
		const out = buildSeatbeltProfile(
			baseProfile({
				network: "restricted",
				allowedDomains: ["github.com"],
			}),
		);
		// Without a proxy endpoint the profile emits no allow rules and
		// falls back to the global deny — explicit, honest, and safer than
		// the legacy hostname regex which silently denied everything anyway.
		expect(out).not.toMatch(/allow network/);
	});

	test("sshAuthSock literal allow is rendered", () => {
		const out = buildSeatbeltProfile(baseProfile({ sshAuthSock: "/tmp/ssh-agent.sock" }));
		expect(out).toContain('(literal "/tmp/ssh-agent.sock")');
	});

	test("toolchain + extra readOnlyMounts are allowed read", () => {
		const out = buildSeatbeltProfile(
			baseProfile({
				toolchainPaths: ["/opt/homebrew/bin/bun"],
				readOnlyMounts: ["/Users/u/.cargo"],
			}),
		);
		expect(out).toContain('(allow file-read* (subpath "/opt/homebrew/bin/bun"))');
		expect(out).toContain('(allow file-read* (subpath "/Users/u/.cargo"))');
	});

	test("temp roots get read+write so claude-code's Bash output round-trip works (burrow-8452)", () => {
		const out = buildSeatbeltProfile(baseProfile());
		expect(out).toContain('(allow file-read* file-write* (subpath "/private/tmp"))');
		expect(out).toContain('(allow file-read* file-write* (subpath "/private/var/folders"))');
	});

	test("/dev/null is writable so shell redirects don't ENOENT (burrow-8452)", () => {
		const out = buildSeatbeltProfile(baseProfile());
		expect(out).toContain('(allow file-write* (literal "/dev/null"))');
	});

	test("paths with double-quotes are escaped", () => {
		const out = buildSeatbeltProfile(baseProfile({ workspace: '/tmp/ws"weird' }));
		expect(out).toContain('"/tmp/ws\\"weird"');
	});
});

describe("buildSeatbeltArgv", () => {
	test("invokes sandbox-exec -f <profile> then the user argv", () => {
		const argv = buildSeatbeltArgv("/tmp/p.sb", { argv: ["echo", "hi"] });
		expect(argv).toEqual(["sandbox-exec", "-f", "/tmp/p.sb", "echo", "hi"]);
	});

	test("sandboxExecBin override is honored", () => {
		const argv = buildSeatbeltArgv("/tmp/p.sb", { argv: ["true"] }, { sandboxExecBin: "/opt/sb" });
		expect(argv[0]).toBe("/opt/sb");
	});
});
