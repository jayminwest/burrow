import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretResolutionError, ValidationError } from "../../core/errors.ts";
import { Client } from "../../lib/client.ts";
import type {
	MaterializedWorkspace,
	MaterializeProjectOptions,
} from "../../provider/local/workspace.ts";
import { type OpReadFn, OpResolver } from "../../secrets/op.ts";
import { parseNetworkPolicy, renderUpResult, runUpCommand } from "./up.ts";

describe("parseNetworkPolicy", () => {
	test("defaults to none", () => {
		expect(parseNetworkPolicy(undefined)).toBe("none");
	});
	test("rejects unknown values", () => {
		expect(() => parseNetworkPolicy("bogus")).toThrow(ValidationError);
	});
});

describe("runUpCommand", () => {
	let dataDir: string;
	let client: Client;
	let materializerCalls: MaterializeProjectOptions[];

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-up-"));
		client = await Client.open({ dataDir, configDir: dataDir });
		materializerCalls = [];
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	const fakeMaterializer = async (
		opts: MaterializeProjectOptions,
	): Promise<MaterializedWorkspace> => {
		materializerCalls.push(opts);
		return {
			workspacePath: opts.workspacePath,
			source: { kind: "worktree", branch: opts.branch, hostClonePath: "/host" },
			identity: null,
		};
	};

	test("creates a project burrow row with the materialized workspace", async () => {
		const result = await runUpCommand({
			client,
			projectRoot: "/repos/web-app",
			options: { name: "web", branch: "feature/x" },
			materializer: fakeMaterializer,
			skipDoctor: true,
		});
		expect(result.burrow.kind).toBe("project");
		expect(result.burrow.name).toBe("web");
		expect(result.burrow.branch).toBe("feature/x");
		expect(result.burrow.workspacePath).toContain(result.burrow.id);
		expect(materializerCalls).toHaveLength(1);
		expect(materializerCalls[0]?.branch).toBe("feature/x");

		const row = client.burrows.get(result.burrow.id);
		expect(row.id).toBe(result.burrow.id);
		expect(row.providerStateJson).toMatchObject({
			workspaceSource: { kind: "worktree" },
		});
	});

	test("auto-generates a per-burrow branch when --branch is omitted", async () => {
		const result = await runUpCommand({
			client,
			projectRoot: "/repos/web-app",
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
		});
		expect(result.burrow.branch.startsWith("burrow/")).toBe(true);
	});

	test("defaults to network=none with no toolchain mounts", async () => {
		const result = await runUpCommand({
			client,
			projectRoot: "/repos/web-app",
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
		});
		const profile = result.burrow.profileJson as { network: string; toolchainPaths: unknown[] };
		expect(profile.network).toBe("none");
		expect(profile.toolchainPaths).toEqual([]);
	});

	test("renderUpResult prints the human summary", async () => {
		const result = await runUpCommand({
			client,
			projectRoot: "/repos/web-app",
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
		});
		const out = renderUpResult(result);
		expect(out).toContain("up");
		expect(out).toContain(result.burrow.id);
	});
});

describe("runUpCommand — Phase 8 burrow.toml integration", () => {
	let dataDir: string;
	let projectRoot: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-up-p8-"));
		projectRoot = mkdtempSync(join(tmpdir(), "burrow-up-p8-proj-"));
		client = await Client.open({ dataDir, configDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(projectRoot, { recursive: true, force: true });
	});

	const fakeMaterializer = async (
		opts: MaterializeProjectOptions,
	): Promise<MaterializedWorkspace> => ({
		workspacePath: opts.workspacePath,
		source: { kind: "worktree", branch: opts.branch, hostClonePath: "/host" },
		identity: null,
	});

	test("loads burrow.toml: sandbox/network and project name lift onto the profile + burrow row", async () => {
		writeFileSync(
			join(projectRoot, "burrow.toml"),
			`
[project]
name = "web-app"
default_branch = "develop"

[sandbox]
network = "restricted"
allowed_domains = ["github.com"]
timeout_minutes = 30
memory_limit_mb = 4096
cpu_limit = 1.5
`,
		);
		const result = await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
		});
		expect(result.burrow.name).toBe("web-app");
		const profile = result.burrow.profileJson as {
			network: string;
			allowedDomains: string[];
			timeoutMs?: number;
			memoryLimitMb?: number;
			cpuLimit?: number;
		};
		expect(profile.network).toBe("restricted");
		expect(profile.allowedDomains).toEqual(["github.com"]);
		expect(profile.timeoutMs).toBe(30 * 60_000);
		expect(profile.memoryLimitMb).toBe(4096);
		expect(profile.cpuLimit).toBe(1.5);
	});

	test("CLI --network flag overrides burrow.toml [sandbox].network", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[sandbox]\nnetwork = "restricted"\n`);
		const result = await runUpCommand({
			client,
			projectRoot,
			options: { network: "open" },
			materializer: fakeMaterializer,
			skipDoctor: true,
		});
		const profile = result.burrow.profileJson as { network: string };
		expect(profile.network).toBe("open");
	});

	test("[env].defaults + host env land in profile.setEnv", async () => {
		writeFileSync(
			join(projectRoot, "burrow.toml"),
			`
[env]
required = ["DATABASE_URL"]
optional = ["LOG_LEVEL"]

[env.defaults]
NODE_ENV = "test"
LOG_LEVEL = "info"
`,
		);
		const result = await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
			hostEnv: { DATABASE_URL: "postgres://h" },
		});
		const profile = result.burrow.profileJson as { setEnv: Record<string, string> };
		expect(profile.setEnv.DATABASE_URL).toBe("postgres://h");
		expect(profile.setEnv.NODE_ENV).toBe("test");
		expect(profile.setEnv.LOG_LEVEL).toBe("info");
		expect(result.resolvedEnv).toEqual(profile.setEnv);
	});

	test("op:// secrets are resolved via the injected OpResolver", async () => {
		writeFileSync(
			join(projectRoot, "burrow.toml"),
			`
[secrets]
API_KEY = "op://Eng/web/api-key"
`,
		);
		const fake: OpReadFn = async ({ ref }) => {
			if (ref === "op://Eng/web/api-key") return { exitCode: 0, stdout: "abc-123", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "miss" };
		};
		const result = await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
			opResolver: new OpResolver({ read: fake }),
		});
		const profile = result.burrow.profileJson as { setEnv: Record<string, string> };
		expect(profile.setEnv.API_KEY).toBe("abc-123");
	});

	test("missing required env throws SecretResolutionError without creating a burrow row", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[env]\nrequired = ["MUST_HAVE"]\n`);
		await expect(
			runUpCommand({
				client,
				projectRoot,
				options: {},
				materializer: fakeMaterializer,
				skipDoctor: true,
				hostEnv: {},
			}),
		).rejects.toBeInstanceOf(SecretResolutionError);
		expect(client.burrows.list({}).length).toBe(0);
	});

	test("doctor failure (toolchain mismatch) blocks `up` with a ValidationError", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[toolchain]\nbun = ">=999.0"\n`);
		await expect(
			runUpCommand({
				client,
				projectRoot,
				options: {},
				materializer: fakeMaterializer,
				doctorRunner: async () => ({
					platform: "linux",
					ok: false,
					checks: [
						{
							name: "toolchain.bun >=999.0",
							status: "fail",
							detail: "wanted >=999.0, found 1.1.30",
						},
					],
				}),
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(client.burrows.list({}).length).toBe(0);
	});

	test("doctor's resolved toolchain paths land on profile.toolchainPaths", async () => {
		// Two declared toolchains share `/fake/bin` — we expect the dirname dedup
		// to collapse them into a single entry, in declaration order. The
		// symlink walker is stubbed empty so this test stays focused on the
		// dedup behaviour rather than what the host's real bin dir contains.
		writeFileSync(join(projectRoot, "burrow.toml"), `[toolchain]\nbun = "1.1"\nnode = "20"\n`);
		const result = await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			doctorRunner: async () => ({
				platform: "linux",
				ok: true,
				checks: [],
				toolchain: {
					ok: true,
					missing: [],
					mismatched: [],
					results: [
						{
							name: "bun",
							binary: "bun",
							requested: "1.1",
							resolvedPath: "/fake/bin/bun",
							status: "ok",
							detail: "found",
						},
						{
							name: "node",
							binary: "node",
							requested: "20",
							resolvedPath: "/fake/bin/node",
							status: "ok",
							detail: "found",
						},
					],
				},
			}),
			symlinkWalker: () => [],
		});
		const profile = result.burrow.profileJson as { toolchainPaths: string[] };
		expect(profile.toolchainPaths).toEqual(["/fake/bin"]);
	});

	test("symlink walker contributes additional toolchainPaths (burrow-a1b1)", async () => {
		// The walker is invoked with the declared-toolchain bin dirs and its
		// output is appended (deduped) to profile.toolchainPaths. Subsumes the
		// bun-specific path from burrow-aa46.
		writeFileSync(join(projectRoot, "burrow.toml"), `[toolchain]\nbun = "1.1"\n`);
		let walkerInput: string[] = [];
		const result = await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			doctorRunner: async () => ({
				platform: "linux",
				ok: true,
				checks: [],
				toolchain: {
					ok: true,
					missing: [],
					mismatched: [],
					results: [
						{
							name: "bun",
							binary: "bun",
							requested: "1.1",
							resolvedPath: "/fake/.bun/bin/bun",
							status: "ok",
							detail: "found",
						},
					],
				},
			}),
			symlinkWalker: (binDirs) => {
				walkerInput = [...binDirs];
				return ["/fake/.bun/install/global/node_modules"];
			},
		});
		expect(walkerInput).toEqual(["/fake/.bun/bin"]);
		const profile = result.burrow.profileJson as { toolchainPaths: string[] };
		expect(profile.toolchainPaths).toEqual([
			"/fake/.bun/bin",
			"/fake/.bun/install/global/node_modules",
		]);
	});

	test("symlink walker is NOT given agent-only bin dirs (declared-toolchain only)", async () => {
		// Agents are vetted by installCheck and contribute exactly the dir(s)
		// they need; we only walk declared-toolchain bin dirs to bound the
		// implicit mount surface.
		writeFileSync(join(projectRoot, "burrow.toml"), `[[agents]]\nid = "fake-agent"\n`);
		client.agents.register({
			id: "fake-agent",
			displayName: "Fake",
			supportsResume: false,
			buildSpawnCommand: () => ({ argv: ["fake"] }),
			parseEvents: () => [],
			installCheck: async () => ({
				installed: true,
				version: "0",
				path: "/opt/agents/bin/fake",
			}),
		});
		let walkerInput: string[] = [];
		await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
			symlinkWalker: (binDirs) => {
				walkerInput = [...binDirs];
				return [];
			},
		});
		expect(walkerInput).toEqual([]);
	});

	test("symlink walker integration end-to-end against a real bun-globals layout", async () => {
		// Lay out the canonical bun-globals shape, plumb it through the
		// production walker, and assert the install-root mount lands on the
		// profile. This is the regression that burrow-aa46 fixed and burrow-a1b1
		// generalises.
		const bunRoot = mkdtempSync(join(tmpdir(), "burrow-up-bunwalk-"));
		try {
			const pkgSrc = join(bunRoot, "install/global/node_modules/@os-eco/mulch-cli/src");
			mkdirSync(pkgSrc, { recursive: true });
			const entry = join(pkgSrc, "cli.ts");
			writeFileSync(entry, "// entry\n");
			const binDir = join(bunRoot, "bin");
			mkdirSync(binDir, { recursive: true });
			const realBun = join(binDir, "bun");
			writeFileSync(realBun, "#!/bin/sh\nexec true\n", { mode: 0o755 });
			symlinkSync(entry, join(binDir, "ml"));

			writeFileSync(join(projectRoot, "burrow.toml"), `[toolchain]\nbun = "1.1"\n`);
			const result = await runUpCommand({
				client,
				projectRoot,
				options: {},
				materializer: fakeMaterializer,
				doctorRunner: async () => ({
					platform: "linux",
					ok: true,
					checks: [],
					toolchain: {
						ok: true,
						missing: [],
						mismatched: [],
						results: [
							{
								name: "bun",
								binary: "bun",
								requested: "1.1",
								resolvedPath: realBun,
								status: "ok",
								detail: "found",
							},
						],
					},
				}),
			});
			const profile = result.burrow.profileJson as { toolchainPaths: string[] };
			const expectedNm = realpathSync(join(bunRoot, "install/global/node_modules"));
			expect(profile.toolchainPaths).toContain(expectedNm);
		} finally {
			rmSync(bunRoot, { recursive: true, force: true });
		}
	});

	test("[sandbox] read_only_paths land on profile.readOnlyMounts (burrow-a1b1)", async () => {
		// Tilde / $HOME prefixes expand against the injected home; absolute
		// entries pass through verbatim. Order is preserved and entries are
		// deduped against any agent-contributed credentialPaths.
		writeFileSync(
			join(projectRoot, "burrow.toml"),
			`
[sandbox]
read_only_paths = ["~/.config/foo", "$HOME/.cache/bar", "/opt/data"]
`,
		);
		const result = await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
			home: "/u/me",
		});
		const profile = result.burrow.profileJson as { readOnlyMounts: string[] };
		expect(profile.readOnlyMounts).toEqual(["/u/me/.config/foo", "/u/me/.cache/bar", "/opt/data"]);
	});

	test("[sandbox] read_only_paths dedupes against agent credential paths", async () => {
		writeFileSync(
			join(projectRoot, "burrow.toml"),
			`
[[agents]]
id = "creds-agent"

[sandbox]
read_only_paths = ["/host/shared", "/host/extra"]
`,
		);
		client.agents.register({
			id: "creds-agent",
			displayName: "Creds",
			supportsResume: false,
			buildSpawnCommand: () => ({ argv: ["x"] }),
			parseEvents: () => [],
			installCheck: async () => ({ installed: true, version: "0" }),
			credentialPaths: async () => ["/host/shared"],
		});
		const result = await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
		});
		const profile = result.burrow.profileJson as { readOnlyMounts: string[] };
		// Agent credentials come first (declaration order); sandbox.read_only_paths
		// /host/shared is a duplicate and gets dropped.
		expect(profile.readOnlyMounts).toEqual(["/host/shared", "/host/extra"]);
	});

	test("declared agents contribute their resolved binary directory to toolchainPaths", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[[agents]]\nid = "fake-agent"\n`);
		// Register a runtime that reports a resolved host path the way the
		// built-ins do via runVersionCheck. `up.ts` reads InstallCheckResult.path
		// and feeds it through expandToolchainBinDirs.
		client.agents.register({
			id: "fake-agent",
			displayName: "Fake",
			supportsResume: false,
			buildSpawnCommand: () => ({ argv: ["fake"] }),
			parseEvents: () => [],
			installCheck: async () => ({
				installed: true,
				version: "0.0.1",
				path: "/opt/fakes/bin/fake",
			}),
		});
		const result = await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
		});
		const profile = result.burrow.profileJson as { toolchainPaths: string[] };
		expect(profile.toolchainPaths).toContain("/opt/fakes/bin");
	});

	test("an agent that fails its installCheck doesn't block `up` and contributes nothing", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[[agents]]\nid = "missing-agent"\n`);
		client.agents.register({
			id: "missing-agent",
			displayName: "Missing",
			supportsResume: false,
			buildSpawnCommand: () => ({ argv: ["missing"] }),
			parseEvents: () => [],
			installCheck: async () => ({ installed: false, hint: "install it" }),
		});
		const result = await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
		});
		const profile = result.burrow.profileJson as { toolchainPaths: string[] };
		expect(profile.toolchainPaths).toEqual([]);
	});

	test("registered agent's credentialPaths land on profile.readOnlyMounts (SPEC §17.4)", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[[agents]]\nid = "creds-agent"\n`);
		client.agents.register({
			id: "creds-agent",
			displayName: "Creds",
			supportsResume: false,
			buildSpawnCommand: () => ({ argv: ["x"] }),
			parseEvents: () => [],
			installCheck: async () => ({ installed: true, version: "0", path: "/opt/x/bin/x" }),
			credentialPaths: async () => ["/host/.creds-agent", "/host/.creds-agent.json"],
		});
		const result = await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
		});
		const profile = result.burrow.profileJson as { readOnlyMounts: string[] };
		expect(profile.readOnlyMounts).toEqual(["/host/.creds-agent", "/host/.creds-agent.json"]);
	});

	test("forwardCredentials = false suppresses credential forwarding for that agent", async () => {
		writeFileSync(
			join(projectRoot, "burrow.toml"),
			`[[agents]]\nid = "creds-agent"\nforwardCredentials = false\n`,
		);
		client.agents.register({
			id: "creds-agent",
			displayName: "Creds",
			supportsResume: false,
			buildSpawnCommand: () => ({ argv: ["x"] }),
			parseEvents: () => [],
			installCheck: async () => ({ installed: true, version: "0" }),
			credentialPaths: async () => ["/host/.creds-agent"],
		});
		const result = await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
		});
		const profile = result.burrow.profileJson as { readOnlyMounts: string[] };
		expect(profile.readOnlyMounts).toEqual([]);
	});

	test("dedups credential paths across agents (declaration order wins)", async () => {
		writeFileSync(
			join(projectRoot, "burrow.toml"),
			`[[agents]]\nid = "agent-a"\n[[agents]]\nid = "agent-b"\n`,
		);
		client.agents.register({
			id: "agent-a",
			displayName: "A",
			supportsResume: false,
			buildSpawnCommand: () => ({ argv: ["a"] }),
			parseEvents: () => [],
			installCheck: async () => ({ installed: true }),
			credentialPaths: async () => ["/host/shared", "/host/a-only"],
		});
		client.agents.register({
			id: "agent-b",
			displayName: "B",
			supportsResume: false,
			buildSpawnCommand: () => ({ argv: ["b"] }),
			parseEvents: () => [],
			installCheck: async () => ({ installed: true }),
			credentialPaths: async () => ["/host/shared", "/host/b-only"],
		});
		const result = await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
		});
		const profile = result.burrow.profileJson as { readOnlyMounts: string[] };
		expect(profile.readOnlyMounts).toEqual(["/host/shared", "/host/a-only", "/host/b-only"]);
	});

	test("a credentialPaths() that throws contributes nothing instead of failing up", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[[agents]]\nid = "broken-agent"\n`);
		client.agents.register({
			id: "broken-agent",
			displayName: "Broken",
			supportsResume: false,
			buildSpawnCommand: () => ({ argv: ["x"] }),
			parseEvents: () => [],
			installCheck: async () => ({ installed: true }),
			credentialPaths: async () => {
				throw new Error("EACCES");
			},
		});
		const result = await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
		});
		const profile = result.burrow.profileJson as { readOnlyMounts: string[] };
		expect(profile.readOnlyMounts).toEqual([]);
	});

	test("default_branch from burrow.toml is used when --base-branch is omitted", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[project]\ndefault_branch = "trunk"\n`);
		let captured: MaterializeProjectOptions | undefined;
		await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: async (opts) => {
				captured = opts;
				return fakeMaterializer(opts);
			},
			skipDoctor: true,
		});
		expect(captured?.baseBranch).toBe("trunk");
	});
});
