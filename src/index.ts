/**
 * @os-eco/burrow-cli — OS-isolated sandbox runtime for coding agents.
 *
 * This module is the public library entry. The CLI lives at src/cli/main.ts
 * and consumes the same surface a programmatic caller would.
 */

export const VERSION = "0.2.12";

export {
	BURROW_TOML_FILENAME,
	type LoadedBurrowToml,
	loadBurrowToml,
} from "./config/burrow-toml-loader.ts";
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
	WorkerDrainingError,
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
export {
	type BuildSnapshotOptions,
	buildSnapshot,
	DEFAULT_RUNS_PER_CARD,
} from "./dashboard/snapshot.ts";
export {
	DEFAULT_COALESCE_MS,
	DEFAULT_POLL_FALLBACK_MS,
	type StreamSnapshotsOptions,
	streamSnapshots,
} from "./dashboard/stream.ts";
export {
	type BurrowCard,
	DASHBOARD_SNAPSHOT_VERSION,
	type DashboardSnapshot,
	type DashboardSnapshotVersion,
	DEFAULT_EVENT_TAIL_CAP,
	type EventTailEntry,
	type RunSummary,
} from "./dashboard/types.ts";
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
	type ArchiveBurrowInput,
	type ArchiveBurrowResult,
	archiveBurrow,
	type RunsArchive,
} from "./events/archive.ts";
export {
	type DestroyBurrowInput,
	type DestroyBurrowResult,
	destroyBurrowStorage,
} from "./events/destroy.ts";
export {
	type TailAllOptions,
	type TailOptions,
	tailAll,
	tailBurrow,
} from "./events/poll.ts";
export {
	type AppendAndPublishInput,
	appendAndPublish,
} from "./events/publish.ts";
export {
	type EventEnvelope,
	eventToEnvelope,
	renderNdjson,
	renderPretty,
} from "./events/render.ts";
export {
	EventBus,
	type EventListener,
	type Subscription,
} from "./events/tail.ts";
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
export {
	Inbox,
	type InboxListFilter,
	type InboxSendInput,
} from "./inbox/inbox.ts";
export {
	isSpawnPerTurn,
	type PrepareTurnInjectionInput,
	prepareTurnInjection,
	type TurnInjection,
} from "./inbox/injector.ts";
export {
	AgentsClient,
	type BurrowDestroyOverrides,
	type BurrowListFilter,
	BurrowsClient,
	type BurrowUpInput,
	type BurrowUpOverrides,
	Client,
	type ClientOpenOptions,
	EventsClient,
	type EventTailFilter,
	InboxClient,
	type InboxListFilter as ClientInboxListFilter,
	type InboxSendInput as ClientInboxSendInput,
	type RunCreateInput,
	type RunListFilter,
	RunsClient,
} from "./lib/client.ts";
export {
	type DestroyBurrowFullyOptions,
	type DestroyBurrowFullyOutcome,
	destroyBurrowFully,
} from "./lib/destroy.ts";
export {
	type HttpAgentDetail,
	type HttpAgentSummary,
	HttpAgentsClient,
	type HttpBurrowListFilter,
	HttpBurrowsClient,
	type HttpBurrowUpInput,
	HttpClient,
	HttpClientError,
	type HttpClientOptions,
	HttpEventsClient,
	type HttpEventTailFilter,
	HttpFilesClient,
	type HttpFilesReadOptions,
	type HttpFilesWriteResult,
	HttpInboxClient,
	type HttpInboxListFilter,
	type HttpInboxSendInput,
	type HttpRunCreateInput,
	type HttpRunListFilter,
	type HttpRunStreamOptions,
	HttpRunsClient,
	type HttpWorkspaceFile,
	type HttpWorkspaceFileEncoding,
	type HttpWorkspaceFileOutput,
} from "./lib/http-client.ts";
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
	matchAllowedDomain,
	type ProxyHandle,
	type ProxyLogger,
	type StartProxyOptions,
	startProxy,
} from "./proxy/server.ts";
export {
	type DispatchRunInput,
	dispatchRun,
	type SpawnFn as DispatchSpawnFn,
	type StartProxyFn as DispatchStartProxyFn,
} from "./runner/dispatch.ts";
export {
	type DrainController,
	type RunDispatcherHandle,
	type RunDispatcherOptions,
	startRunDispatcher,
} from "./runner/dispatcher.ts";
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
export {
	type BurrowToml,
	type BurrowTomlAgent,
	type BurrowTomlGitCredentials,
	type BurrowTomlGitIdentity,
	type BurrowTomlNetworkPolicy,
	type BurrowTomlParseError,
	type BurrowTomlParseResult,
	BurrowTomlSchema,
	type BurrowTomlShip,
	type BurrowTomlShipDocker,
	type BurrowTomlShipFly,
	type BurrowTomlShipTarball,
	type BurrowTomlShipTarget,
	type BurrowTomlToolchainMode,
	type BurrowTomlToolchainSpec,
	GIT_CREDENTIAL_KINDS,
	GIT_IDENTITY_KINDS,
	NETWORK_POLICIES,
	normalizeToolchainSpec,
	parseBurrowToml,
	parseBurrowTomlOrThrow,
	SHIP_TARGETS,
	TOOLCHAIN_MODES,
} from "./schemas/burrow-toml.ts";
export {
	type ResolveEnvInput,
	type ResolveEnvResult,
	resolveEnv,
} from "./secrets/env.ts";
export {
	defaultOpRead,
	OP_PROTOCOL,
	type OpReadFn,
	type OpReadInput,
	type OpReadResult,
	OpResolver,
	type OpResolverOptions,
} from "./secrets/op.ts";
export {
	GLOBAL_ENV_FILENAME,
	type LoadedSecretFile,
	loadSecretStore,
	parseDotenv,
	readEnvFile,
	type SecretStoreOptions,
	type SecretStoreResult,
} from "./secrets/store.ts";
export type { ErrorEnvelope, Transport } from "./server/types.ts";
export {
	BUILT_IN_SHIP_TARGETS,
	buildDockerArgv,
	buildFlyArgv,
	defaultShipRegistry,
	dockerShipTarget,
	flyShipTarget,
	probeBinary,
	type ResolvedDockerPlan,
	type ResolvedFlyPlan,
	resolveDockerPlan,
	resolveFlyPlan,
	type ShipContext,
	type ShipEvent,
	type ShipInstallCheck,
	type ShipPlan,
	type ShipPlanStep,
	ShipRegistry,
	type ShipTarget,
	streamLines,
	tarballShipTarget,
} from "./ship/index.ts";
export {
	type CheckToolchainsInput,
	checkToolchains,
	compareSemver,
	defaultToolchainProbe,
	extractVersionToken,
	type ToolchainCheckResult,
	type ToolchainCheckSummary,
	type ToolchainProbe,
	type ToolchainProbeResult,
	type ToolchainStatus,
	versionMatches,
} from "./toolchain/check.ts";
