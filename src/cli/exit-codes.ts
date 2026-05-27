/**
 * CLI exit code mapping per SPEC §16.
 *
 * Buckets (intentionally coarser than src/server/errors.ts statusFor):
 *   0 — success (never produced here)
 *   1 — generic failure (any BurrowError not matched below, or unknown throw)
 *   2 — not found
 *   3 — invalid input
 *   4 — runtime/sandbox error
 *
 * This is NOT a 1:1 mirror of statusFor(). statusFor() maps each BurrowError
 * subclass to a precise HTTP status (424, 502, 409, 503, 401, ...). The CLI
 * deliberately collapses those into the five SPEC §16 buckets, so most
 * subclasses fall through to the generic `1` and that fallback is the
 * documented contract — not a drift bug. Keep this file as the canonical
 * source for the CLI contract; the unit test in exit-codes.test.ts pins it.
 */

import {
	AgentNotInstalled,
	AgentRuntimeError,
	BurrowError,
	NotFoundError,
	SandboxError,
	ValidationError,
} from "../core/errors.ts";

export function exitCodeFor(err: unknown): number {
	if (err instanceof ValidationError) return 3;
	if (err instanceof NotFoundError) return 2;
	if (err instanceof SandboxError) return 4;
	if (err instanceof AgentNotInstalled) return 4;
	if (err instanceof AgentRuntimeError) return 4;
	if (err instanceof BurrowError) return 1;
	return 1;
}
