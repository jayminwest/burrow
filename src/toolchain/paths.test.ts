import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expandHomePrefix, expandToolchainBinDirs, walkToolchainBinSymlinks } from "./paths.ts";

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

	test("adds the outermost node_modules ancestor for node-based global CLIs", () => {
		const root = mkdtempSync(join(tmpdir(), "burrow-paths-node-"));
		try {
			const pkgDist = join(root, "install/global/node_modules/@earendil-works/pi-coding-agent/dist");
			mkdirSync(pkgDist, { recursive: true });
			const realBin = join(pkgDist, "cli.js");
			writeFileSync(realBin, "// entrypoint\n");

			const linkDir = join(root, "bin");
			mkdirSync(linkDir, { recursive: true });
			const linkBin = join(linkDir, "pi");
			symlinkSync(realBin, linkBin);

			const out = expandToolchainBinDirs([linkBin]);
			expect(out).toContain(linkDir);
			expect(out).toContain(dirname(realpathSync(realBin)));
			expect(out).toContain(realpathSync(join(root, "install/global/node_modules")));
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

describe("walkToolchainBinSymlinks", () => {
	test("contributes dirname(realpath) for each symlink whose target escapes the bin dir", () => {
		// Lay out the rustup-shaped case: bin/<stub> → versions/<version>/bin/<bin>.
		// The walk should mount the realpath dir so the actual binary loads from
		// inside the sandbox.
		const root = mkdtempSync(join(tmpdir(), "burrow-walk-rustup-"));
		try {
			const versionsBin = join(root, "toolchains/stable/bin");
			mkdirSync(versionsBin, { recursive: true });
			const realBin = join(versionsBin, "rustc");
			writeFileSync(realBin, "#!/bin/sh\nexec true\n", { mode: 0o755 });

			const binDir = join(root, "bin");
			mkdirSync(binDir, { recursive: true });
			symlinkSync(realBin, join(binDir, "rustc"));

			const out = walkToolchainBinSymlinks({ binDirs: [binDir] });
			expect(out).toEqual([realpathSync(versionsBin)]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("contributes the outermost node_modules ancestor for bun-globals layouts", () => {
		// `~/.bun/bin/<cli>` → `~/.bun/install/global/node_modules/<scope>/<pkg>/src/<entry>.ts`
		// bun's bare-import resolver walks ancestor `node_modules` dirs from the
		// entrypoint, so mounting just `<pkg>/src` would still ENOENT on
		// imports — we mount the outermost `node_modules` instead.
		const root = mkdtempSync(join(tmpdir(), "burrow-walk-bun-"));
		try {
			const pkgSrc = join(root, "install/global/node_modules/@os-eco/mulch-cli/src");
			mkdirSync(pkgSrc, { recursive: true });
			const entry = join(pkgSrc, "cli.ts");
			writeFileSync(entry, "// entrypoint\n");

			const binDir = join(root, "bin");
			mkdirSync(binDir, { recursive: true });
			symlinkSync(entry, join(binDir, "ml"));

			const out = walkToolchainBinSymlinks({ binDirs: [binDir] });
			const expected = realpathSync(join(root, "install/global/node_modules"));
			expect(out).toEqual([expected]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("dedupes a node_modules root contributed by multiple symlinks (ml/sd/cn)", () => {
		const root = mkdtempSync(join(tmpdir(), "burrow-walk-bun-multi-"));
		try {
			const nm = join(root, "install/global/node_modules");
			const mulch = join(nm, "@os-eco/mulch-cli/src/cli.ts");
			const seeds = join(nm, "seeds/src/index.ts");
			const canopy = join(nm, "@os-eco/canopy-cli/src/cli.ts");
			for (const f of [mulch, seeds, canopy]) {
				mkdirSync(dirname(f), { recursive: true });
				writeFileSync(f, "// entrypoint\n");
			}
			const binDir = join(root, "bin");
			mkdirSync(binDir, { recursive: true });
			symlinkSync(mulch, join(binDir, "ml"));
			symlinkSync(seeds, join(binDir, "sd"));
			symlinkSync(canopy, join(binDir, "cn"));

			const out = walkToolchainBinSymlinks({ binDirs: [binDir] });
			expect(out).toEqual([realpathSync(nm)]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("drops symlinks whose realpath escapes the trusted root (parent of bin dir)", () => {
		const root = mkdtempSync(join(tmpdir(), "burrow-walk-escape-"));
		const outside = mkdtempSync(join(tmpdir(), "burrow-walk-escape-out-"));
		try {
			const realBin = join(outside, "shadow");
			writeFileSync(realBin, "#!/bin/sh\nexec true\n", { mode: 0o755 });
			const binDir = join(root, "bin");
			mkdirSync(binDir, { recursive: true });
			symlinkSync(realBin, join(binDir, "shadow"));

			const out = walkToolchainBinSymlinks({ binDirs: [binDir] });
			expect(out).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("skips bin dirs whose parent resolves to / (defensive)", () => {
		let readdirCalled = false;
		const out = walkToolchainBinSymlinks({
			binDirs: ["/bin"],
			realpath: (p) => p,
			readdir: () => {
				readdirCalled = true;
				return [];
			},
		});
		expect(readdirCalled).toBe(false);
		expect(out).toEqual([]);
	});

	test("ignores non-symlink entries and self-referential symlinks", () => {
		const root = mkdtempSync(join(tmpdir(), "burrow-walk-noop-"));
		try {
			const binDir = join(root, "bin");
			mkdirSync(binDir, { recursive: true });
			// Plain regular file — no walk contribution.
			writeFileSync(join(binDir, "real-bin"), "#!/bin/sh\nexec true\n", { mode: 0o755 });
			// Symlink whose realpath dir IS the bin dir (sibling-of-itself shape).
			writeFileSync(join(binDir, "actual"), "#!/bin/sh\nexec true\n", { mode: 0o755 });
			symlinkSync(join(binDir, "actual"), join(binDir, "alias"));

			const out = walkToolchainBinSymlinks({ binDirs: [binDir] });
			expect(out).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("missing or unreadable bin dirs are skipped silently", () => {
		const out = walkToolchainBinSymlinks({
			binDirs: ["/definitely/not/a/real/path/bin"],
		});
		expect(out).toEqual([]);
	});

	test("honours the maxEntries cap", () => {
		// Inject a synthetic listing so the test isn't sensitive to dir-walk order
		// or how many entries fit on one filesystem. The fake `realpath` is an
		// identity for the bin dir itself (so trustedRoot = `/fake/parent`) and
		// fans entries out into distinct sibling realdirs.
		const out = walkToolchainBinSymlinks({
			binDirs: ["/fake/parent/bin"],
			maxEntries: 2,
			readdir: () => [
				{ name: "a", isSymbolicLink: () => true },
				{ name: "b", isSymbolicLink: () => true },
				{ name: "c", isSymbolicLink: () => true },
			],
			realpath: (p) => {
				if (p === "/fake/parent/bin") return "/fake/parent/bin";
				const leaf = p.split("/").pop();
				return `/fake/parent/realdir-${leaf}/inner`;
			},
		});
		// Only the first two entries get walked; each contributes a distinct dir.
		expect(out).toEqual(["/fake/parent/realdir-a", "/fake/parent/realdir-b"]);
	});
});

describe("expandHomePrefix", () => {
	// Spelled out to dodge biome's template-in-string rule.
	const HOME_BRACE = `$${"{HOME}"}`;
	test("'~' alone expands to home", () => {
		expect(expandHomePrefix("~", "/u/me")).toBe("/u/me");
	});
	test("'~/foo' joins on home", () => {
		expect(expandHomePrefix("~/.config/burrow", "/u/me")).toBe("/u/me/.config/burrow");
	});
	test("'$HOME/foo' and brace-form both join on home", () => {
		expect(expandHomePrefix("$HOME/.bun", "/u/me")).toBe("/u/me/.bun");
		expect(expandHomePrefix(`${HOME_BRACE}/.bun`, "/u/me")).toBe("/u/me/.bun");
	});
	test("bare '$HOME' and brace-form both expand to home", () => {
		expect(expandHomePrefix("$HOME", "/u/me")).toBe("/u/me");
		expect(expandHomePrefix(HOME_BRACE, "/u/me")).toBe("/u/me");
	});
	test("absolute paths pass through verbatim", () => {
		expect(expandHomePrefix("/opt/homebrew", "/u/me")).toBe("/opt/homebrew");
	});
	test("unrecognised shapes are left alone (no double-expansion of '$HOMER')", () => {
		expect(expandHomePrefix("$HOMER/x", "/u/me")).toBe("$HOMER/x");
	});
});
