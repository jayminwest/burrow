import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expandToolchainBinDirs, resolveBunGlobalInstallDir } from "./paths.ts";

describe("expandToolchainBinDirs", () => {
	test("returns dirname of each non-existent path in input order, deduped", () => {
		// Use unrealistic paths so realpath always fails — keeps the assertion
		// stable across hosts where `/opt/homebrew/bin/node` is itself a symlink.
		const out = expandToolchainBinDirs([
			"/imaginary/a/bin/bun",
			"/imaginary/a/bin/node",
			"/imaginary/b/bin/git",
		]);
		expect(out).toEqual(["/imaginary/a/bin", "/imaginary/b/bin"]);
	});

	test("ignores null/undefined/empty entries", () => {
		const out = expandToolchainBinDirs([null, undefined, "", "/imaginary/a/bin/bun"]);
		expect(out).toEqual(["/imaginary/a/bin"]);
	});

	test("expands a symlinked binary into both its dir and the realpath ancestor", () => {
		const root = mkdtempSync(join(tmpdir(), "burrow-paths-"));
		try {
			const realDir = join(root, "share/claude/versions/2.1.132");
			mkdirSync(realDir, { recursive: true });
			const realBin = join(realDir, "claude");
			writeFileSync(realBin, "#!/bin/sh\nexec true\n", { mode: 0o755 });

			const linkDir = join(root, "local/bin");
			mkdirSync(linkDir, { recursive: true });
			const linkBin = join(linkDir, "claude");
			symlinkSync(realBin, linkBin);

			// The helper returns the raw dirname for the input path (so PATH lookup
			// finds the symlink under its declared name) plus the canonical
			// realpath ancestor (so the read after symlink resolution is allowed).
			// macOS prefixes /var/folders → /private/var/folders, so realpath the
			// real-side parent for a stable assertion.
			const expectedLinkDir = linkDir;
			const expectedRealDir = dirname(realpathSync(realBin));

			const out = expandToolchainBinDirs([linkBin]);
			expect(out).toContain(expectedLinkDir);
			expect(out).toContain(expectedRealDir);
			// Order: PATH-visible dir first (so it wins on bare-name lookup), then
			// the realpath target. Callers prepend this onto PATH.
			expect(out.indexOf(expectedLinkDir)).toBeLessThan(out.indexOf(expectedRealDir));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("skips realpath expansion when the binary itself doesn't exist", () => {
		const out = expandToolchainBinDirs(["/definitely/not/a/real/path/foo"]);
		// We still surface the dirname — bwrap/seatbelt mount it `--ro-bind-try`
		// equivalent so this is harmless if the path is missing at exec time.
		expect(out).toEqual(["/definitely/not/a/real/path"]);
	});
});

describe("resolveBunGlobalInstallDir", () => {
	test("returns <BUN_INSTALL>/install/global/node_modules when it exists", () => {
		const root = mkdtempSync(join(tmpdir(), "burrow-bun-install-"));
		try {
			const installDir = join(root, "install", "global", "node_modules");
			mkdirSync(installDir, { recursive: true });
			const out = resolveBunGlobalInstallDir({ bunInstall: root });
			expect(out).toBe(installDir);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("returns null when the install root doesn't exist", () => {
		const out = resolveBunGlobalInstallDir({ bunInstall: "/definitely/not/a/real/bun-install" });
		expect(out).toBeNull();
	});

	test("falls back to $HOME/.bun when BUN_INSTALL is unset", () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "burrow-bun-home-"));
		try {
			const installDir = join(fakeHome, ".bun", "install", "global", "node_modules");
			mkdirSync(installDir, { recursive: true });
			const out = resolveBunGlobalInstallDir({ home: fakeHome, hostEnv: {} });
			expect(out).toBe(installDir);
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	test("BUN_INSTALL from hostEnv wins over $HOME fallback", () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "burrow-bun-home-"));
		const fakeBun = mkdtempSync(join(tmpdir(), "burrow-bun-explicit-"));
		try {
			const installDir = join(fakeBun, "install", "global", "node_modules");
			mkdirSync(installDir, { recursive: true });
			// Intentionally do NOT populate fakeHome/.bun/install/global/node_modules.
			const out = resolveBunGlobalInstallDir({
				home: fakeHome,
				hostEnv: { BUN_INSTALL: fakeBun },
			});
			expect(out).toBe(installDir);
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
			rmSync(fakeBun, { recursive: true, force: true });
		}
	});

	test("honors injected `exists` predicate (test seam)", () => {
		const out = resolveBunGlobalInstallDir({
			bunInstall: "/somewhere",
			exists: (path) => path === "/somewhere/install/global/node_modules",
		});
		expect(out).toBe("/somewhere/install/global/node_modules");
	});
});
