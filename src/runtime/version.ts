/**
 * Shared `<bin> --version` probe used by built-in runtimes' `installCheck`.
 *
 * Treats a non-zero exit (or a missing binary) as "not installed" and trims
 * stdout so callers can store a stable version string. We deliberately keep
 * this synchronous-feeling and lightweight — installCheck runs from the
 * `burrow doctor` command and from runtime registration, neither of which
 * should fan out into long-running probes.
 */

import type { InstallCheckResult } from "./runtime.ts";

export interface VersionCheckOptions {
	hint?: string;
	bin?: string;
	timeoutMs?: number;
}

export async function runVersionCheck(
	bin: string,
	args: string[],
	opts: VersionCheckOptions = {},
): Promise<InstallCheckResult> {
	try {
		const proc = Bun.spawn([opts.bin ?? bin, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exit = await proc.exited;
		if (exit !== 0) {
			return opts.hint ? { installed: false, hint: opts.hint } : { installed: false };
		}
		const out = await new Response(proc.stdout).text();
		const version = out.trim();
		const result: InstallCheckResult = { installed: true };
		if (version.length > 0) result.version = version;
		return result;
	} catch {
		return opts.hint ? { installed: false, hint: opts.hint } : { installed: false };
	}
}
