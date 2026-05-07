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
export { generateId, type IdKind, isId } from "./core/ids.ts";
export {
	assertBurrowTransition,
	assertRunTransition,
	BURROW_TERMINAL_STATES,
	canTransitionBurrow,
	canTransitionRun,
	RUN_TERMINAL_STATES,
} from "./core/state-machine.ts";
export {
	type Burrow,
	type BurrowKind,
	type BurrowState,
	type EventStream,
	eventRowToEvent,
	type Message,
	type MessagePriority,
	type MessageState,
	type Run,
	type RunEvent,
	type RunState,
} from "./core/types.ts";
export { type BurrowDb, type OpenDatabaseOptions, openDatabase } from "./db/client.ts";
export {
	CRASH_ERROR_MESSAGE,
	type RecoverySweepResult,
	runStartupRecovery,
} from "./db/recovery.ts";
export {
	BurrowsRepo,
	createRepos,
	EventsRepo,
	MessagesRepo,
	MetaRepo,
	type Repos,
	RunsRepo,
} from "./db/repos/index.ts";
export {
	BURROW_GITCONFIG_FILENAME,
	type GitIdentity,
	type IdentitySpec,
	readHostGitIdentity,
	renderBurrowGitconfig,
	resolveBurrowIdentity,
	writeBurrowGitconfig,
} from "./git/identity.ts";
export { detectSshAgent, type SshAgentPassthrough } from "./git/ssh.ts";
export {
	addWorktree,
	branchExists,
	cloneRepo,
	discoverHostClone,
	type HostClone,
	initRepo,
	listWorktrees,
	pruneWorktrees,
	removeWorktree,
	type WorktreeEntry,
} from "./git/worktree.ts";
export { createLogger, type Logger } from "./logging/logger.ts";
export { buildBwrapArgv, SYSTEM_RO_MOUNTS } from "./provider/local/bwrap.ts";
export { type RunSandboxedOptions, runSandboxed } from "./provider/local/sandbox.ts";
export {
	buildSeatbeltArgv,
	buildSeatbeltProfile,
	SYSTEM_READ_SUBPATHS,
} from "./provider/local/seatbelt.ts";
export {
	type MaterializedWorkspace,
	type MaterializedWorkspaceSource,
	type MaterializeProjectOptions,
	type MaterializeTaskOptions,
	materializeProjectWorkspace,
	materializeTaskWorkspace,
	type RemoveWorkspaceOptions,
	removeMaterializedWorkspace,
	type WorkspaceSourceKind,
} from "./provider/local/workspace.ts";
export type {
	NetworkPolicy,
	SandboxProfile,
	SpawnCommand,
	SpawnResult,
} from "./provider/types.ts";
export {
	type RunHandler,
	type RunHandlerContext,
	RunLoop,
	type RunLoopOptions,
	type RunOutcome,
} from "./runner/run-loop.ts";
export {
	CLAUDE_CODE_SETTINGS_PATH,
	claudeCodeRuntime,
	encodeClaudeStdin,
} from "./runtime/claude-code.ts";
export {
	CODEX_PROMPT_DIR,
	codexPromptFileFor,
	codexRuntime,
	composeCodexPrompt,
	writeCodexPromptFile,
} from "./runtime/codex.ts";
export { agentConfigToRuntime, loadAgentConfig } from "./runtime/declarative.ts";
export { parseJsonlClaude } from "./runtime/parsers/jsonl-claude.ts";
export { parseRawText } from "./runtime/parsers/raw-text.ts";
export { parseStreamJson } from "./runtime/parsers/stream-json.ts";
export { AgentRegistry, BUILT_IN_RUNTIMES } from "./runtime/registry.ts";
export type {
	AgentRuntime,
	InstallCheckResult,
	ParseContext,
	PrepareContext,
	ResumeContext,
	RuntimeEvent,
	SpawnContext,
} from "./runtime/runtime.ts";
export { composeSaplingPrompt, saplingRuntime } from "./runtime/sapling.ts";
export {
	AGENT_INBOX_DELIVERIES,
	AGENT_OUTPUT_FORMATS,
	AGENT_PROMPT_DELIVERIES,
	type AgentConfig,
	type AgentConfigParseError,
	type AgentConfigParseResult,
	AgentConfigSchema,
	type AgentHooks,
	type AgentInboxDelivery,
	type AgentInstallCheck,
	type AgentOutputFormat,
	type AgentPromptDelivery,
	parseAgentConfig,
} from "./schemas/agent-config.ts";
