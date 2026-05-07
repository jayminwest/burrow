/**
 * @os-eco/burrow-cli — OS-isolated sandbox runtime for coding agents.
 *
 * This module is the public library entry. The CLI lives at src/cli/main.ts
 * and consumes the same surface a programmatic caller would.
 */

export const VERSION = "0.0.0";

export { type BurrowPaths, resolvePaths } from "./config/paths.ts";
export {
	AgentNotInstalled,
	AgentRuntimeError,
	BurrowError,
	CredentialError,
	formatError,
	NotFoundError,
	SandboxError,
	SandboxPrimitiveMissing,
	SecretResolutionError,
	ToolchainMismatch,
	ValidationError,
	WorkspaceMaterializationError,
} from "./core/errors.ts";
export { detectSshAgent, type SshAgentPassthrough } from "./git/ssh.ts";
export { createLogger, type Logger } from "./logging/logger.ts";
export { buildBwrapArgv, SYSTEM_RO_MOUNTS } from "./provider/local/bwrap.ts";
export { type RunSandboxedOptions, runSandboxed } from "./provider/local/sandbox.ts";
export {
	buildSeatbeltArgv,
	buildSeatbeltProfile,
	SYSTEM_READ_SUBPATHS,
} from "./provider/local/seatbelt.ts";
export type {
	NetworkPolicy,
	SandboxProfile,
	SpawnCommand,
	SpawnResult,
} from "./provider/types.ts";
