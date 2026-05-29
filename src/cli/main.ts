#!/usr/bin/env bun
/**
 * Burrow CLI entry — wires every Phase 7 command on top of the public Client.
 *
 * The CLI opens a Client per invocation (no daemon) and routes commands to
 * thin handlers in ./commands/*. Long-running commands wire SIGINT/SIGTERM
 * to an AbortController so cooperative cancellation flows down to the tail
 * generators. Tail commands auto-pick output mode: NDJSON when --json is set
 * OR stdout is not a TTY.
 *
 * Exit codes follow SPEC §16: 0 success, 1 generic, 2 not found, 3 invalid
 * input, 4 runtime/sandbox error.
 */

import { Command } from "commander";
import { formatError, ValidationError } from "../core/errors.ts";
import { VERSION } from "../index.ts";
import { Client } from "../lib/client.ts";
import {
	type AgentsListItem,
	renderAgentShow,
	renderAgentsList,
	renderAgentValidate,
	runAgentShow,
	runAgentsList,
	runAgentValidate,
} from "./commands/agents.ts";
import { renderAgentsAddResult, runAgentsAdd } from "./commands/agents-add.ts";
import { renderAttachResult, runAttachCommand } from "./commands/attach.ts";
import { type ChatCommandOptions, lineIterator, runChatCommand } from "./commands/chat.ts";
import { runCompletionsCommand, SUPPORTED_SHELLS } from "./commands/completions.ts";
import { renderDestroyResult, runDestroyCommand } from "./commands/destroy.ts";
import { renderDoctorReport, runDoctor } from "./commands/doctor.ts";
import { type EventsCommandOptions, runEventsCommand } from "./commands/events.ts";
import { renderForkResult, runForkCommand } from "./commands/fork.ts";
import { renderInitResult, runInitCommand } from "./commands/init.ts";
import { type ListCommandOptions, renderListTable, runListCommand } from "./commands/list.ts";
import { type LogsCommandOptions, runLogsCommand } from "./commands/logs.ts";
import {
	type PromptCommandInput,
	type PromptCommandOptions,
	renderPromptResult,
	runPromptCommand,
} from "./commands/prompt.ts";
import {
	parsePriority,
	renderSendJson,
	renderSendResult,
	resolveSendBody,
	runSendCommand,
	type SendCommandOptions,
} from "./commands/send.ts";
import { runServeCommand, type ServeCommandOptions } from "./commands/serve.ts";
import { runShipCommand, type ShipCommandOptions, shipResultToJson } from "./commands/ship.ts";
import { renderShowReport, runShowCommand, showResultToJson } from "./commands/show.ts";
import { renderStopResult, runStopCommand } from "./commands/stop.ts";
import { renderUpResult, runUpCommand } from "./commands/up.ts";
import {
	parseNonNegative as parseWatchNonNegative,
	parsePositive as parseWatchPositive,
	runWatchCommand,
	type WatchCommandOptions,
} from "./commands/watch.ts";
import { exitCodeFor } from "./exit-codes.ts";

const program = new Command();

program
	.name("burrow")
	.description("OS-isolated sandbox runtime for coding agents")
	.version(VERSION, "-v, --version", "print version and exit")
	.option("--quiet, -q", "suppress informational output (errors still print)")
	.option("--verbose", "increase log verbosity")
	.option("--timing", "print timing information for the command")
	.showSuggestionAfterError(true);

program
	.command("doctor")
	.description("check host environment, burrow.toml, and declared toolchains")
	.option("--project <root>", "project root to load burrow.toml from (defaults to cwd)")
	.option("--no-project", "skip project-scoped checks (host-only doctor)")
	.option("--json", "emit machine-readable JSON")
	.action(async (opts: { project?: string; noProject?: boolean; json?: boolean }) => {
		const runOpts: Parameters<typeof runDoctor>[0] = {};
		const wantsProject = opts.project !== undefined || opts.noProject !== true;
		if (wantsProject) runOpts.projectRoot = opts.project ?? process.cwd();
		const report = await runDoctor(runOpts);
		if (opts.json) {
			process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		} else {
			process.stdout.write(`${renderDoctorReport(report)}\n`);
		}
		process.exit(report.ok ? 0 : 1);
	});

program
	.command("init")
	.description(
		"scaffold a burrow.toml in the current project (pass agent ids as positional args, e.g. `bw init claude`)",
	)
	.argument("[agents...]", "agent ids or aliases (claude, sapling, codex, ...) to pre-declare")
	.option("--name <name>", "override [project].name (defaults to dirname)")
	.option("--force", "overwrite an existing burrow.toml")
	.option("--dry-run", "print the rendered file without writing")
	.option("--json", "emit machine-readable JSON")
	.action(
		async (
			agents: string[],
			opts: { name?: string; force?: boolean; dryRun?: boolean; json?: boolean },
		) => {
			const initOpts: Parameters<typeof runInitCommand>[0] = { projectRoot: process.cwd() };
			if (opts.name !== undefined) initOpts.name = opts.name;
			if (opts.force !== undefined) initOpts.force = opts.force;
			if (opts.dryRun !== undefined) initOpts.dryRun = opts.dryRun;
			if (agents.length > 0) initOpts.agents = agents;
			const result = await runInitCommand(initOpts);
			if (opts.json) {
				process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			} else {
				process.stdout.write(`${renderInitResult(result)}\n`);
				if (opts.dryRun) {
					process.stdout.write(`\n--- ${result.source} ---\n${result.contents}`);
				}
			}
		},
	);

program
	.command("up")
	.description("create + start a project burrow against the current directory")
	.option("--name <name>", "human-readable label for the burrow")
	.option("--branch <branch>", "branch to check out (defaults to burrow/<id>)")
	.option("--base-branch <branch>", "branch to fork from (defaults to main)")
	.option("--origin <url>", "git origin URL for fresh clones (no host clone present)")
	.option(
		"--network <policy>",
		"network policy: none | restricted | open (defaults to burrow.toml [sandbox].network, then 'none')",
	)
	.option("--provider <name>", "provider id (defaults to local)", "local")
	.option("--json", "emit machine-readable JSON")
	.action(async (opts: Record<string, string | boolean>) => {
		await withClient(async (client) => {
			const result = await runUpCommand({
				client,
				projectRoot: process.cwd(),
				options: collapseUpOptions(opts),
			});
			if (opts.json) {
				process.stdout.write(
					`${JSON.stringify(
						{
							burrow: result.burrow,
							workspace: result.workspace,
						},
						null,
						2,
					)}\n`,
				);
			} else {
				process.stdout.write(`${renderUpResult(result)}\n`);
			}
		});
	});

program
	.command("fork <id>")
	.description("fork a project burrow into a task burrow with its own branch")
	.option("--task <description>", "human-readable task description (stored as name)")
	.option("--branch <branch>", "task branch name (defaults to task/<id>)")
	.option("--base-branch <branch>", "branch to fork from (defaults to parent's branch)")
	.option("--json", "emit machine-readable JSON")
	.action(async (parentId: string, opts: Record<string, string | boolean>) => {
		await withClient(async (client) => {
			const result = await runForkCommand({
				client,
				parentId,
				options: collapseForkOptions(opts),
			});
			if (opts.json) {
				process.stdout.write(
					`${JSON.stringify(
						{
							burrow: result.burrow,
							workspace: result.workspace,
						},
						null,
						2,
					)}\n`,
				);
			} else {
				process.stdout.write(`${renderForkResult(result)}\n`);
			}
		});
	});

program
	.command("attach <id>")
	.description("re-activate a stopped burrow")
	.option("--json", "emit machine-readable JSON")
	.action(async (id: string, opts: { json?: boolean }) => {
		await withClient(async (client) => {
			const result = runAttachCommand({ client, burrowId: id, options: opts });
			if (opts.json) {
				process.stdout.write(
					`${JSON.stringify(
						{ burrow: result.burrow, wasAlreadyActive: result.wasAlreadyActive },
						null,
						2,
					)}\n`,
				);
			} else {
				process.stdout.write(`${renderAttachResult(result)}\n`);
			}
		});
	});

program
	.command("list")
	.description("list known burrows (defaults to non-destroyed)")
	.option("--all", "include destroyed burrows")
	.option("--kind <kind>", "filter by kind: project | task")
	.option("--state <state>", "filter by state: active | stopped | destroyed")
	.option("--json", "emit machine-readable JSON")
	.action(async (opts: ListCommandOptions) => {
		await withClient(async (client) => {
			const rows = runListCommand({ client, options: opts });
			if (opts.json) {
				process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
			} else {
				process.stdout.write(`${renderListTable(rows)}\n`);
			}
		});
	});

program
	.command("show <id>")
	.description("snapshot one burrow: state, recent runs, recent events, pending messages")
	.option("--runs <n>", "number of recent runs to include", "10")
	.option("--events <n>", "number of recent events to include", "20")
	.option("--json", "emit machine-readable JSON")
	.action(async (id: string, opts: { runs?: string; events?: string; json?: boolean }) => {
		await withClient(async (client) => {
			const showOpts: { json?: boolean; runsLimit?: number; eventsLimit?: number } = {};
			if (opts.json !== undefined) showOpts.json = opts.json;
			if (opts.runs !== undefined) showOpts.runsLimit = parsePositive(opts.runs, "--runs");
			if (opts.events !== undefined) showOpts.eventsLimit = parsePositive(opts.events, "--events");
			const result = runShowCommand({ client, burrowId: id, options: showOpts });
			if (opts.json) {
				process.stdout.write(`${showResultToJson(result)}\n`);
			} else {
				process.stdout.write(`${renderShowReport(result)}\n`);
			}
		});
	});

program
	.command("stop <id...>")
	.description("mark one or more burrows stopped (workspace persists)")
	.option("--json", "emit machine-readable JSON")
	.action(async (ids: string[], opts: { json?: boolean }) => {
		await withClient(async (client) => {
			const result = runStopCommand({ client, burrowIds: ids, options: opts });
			if (opts.json) {
				process.stdout.write(`${JSON.stringify(result.outcomes, null, 2)}\n`);
			} else {
				process.stdout.write(`${renderStopResult(result)}\n`);
			}
			if (result.outcomes.some((o) => !o.ok)) process.exit(1);
		});
	});

program
	.command("destroy <id...>")
	.description("destroy one or more burrows: archive events, remove workspace, prune rows")
	.option("--no-archive", "skip writing the NDJSON archive on the way down")
	.option("--keep-workspace", "leave the workspace directory in place")
	.option("--force", "force removal even when worktree contains modified files")
	.option("--json", "emit machine-readable JSON")
	.action(
		async (
			ids: string[],
			opts: { archive?: boolean; keepWorkspace?: boolean; force?: boolean; json?: boolean },
		) => {
			await withClient(async (client) => {
				const destroyOpts = {
					noArchive: opts.archive === false,
					...(opts.keepWorkspace !== undefined ? { keepWorkspace: opts.keepWorkspace } : {}),
					...(opts.force !== undefined ? { force: opts.force } : {}),
					...(opts.json !== undefined ? { json: opts.json } : {}),
				};
				const result = await runDestroyCommand({
					client,
					burrowIds: ids,
					options: destroyOpts,
				});
				if (opts.json) {
					process.stdout.write(`${JSON.stringify(result.outcomes, null, 2)}\n`);
				} else {
					process.stdout.write(`${renderDestroyResult(result)}\n`);
				}
				if (result.outcomes.some((o) => !o.ok)) process.exit(1);
			});
		},
	);

program
	.command("prompt")
	.description("dispatch a registered agent against a burrow and stream events")
	.argument("<id>", "burrow id")
	.argument("<message>", "prompt body")
	.option("--agent <id>", "override the burrow.toml [[agents]] default")
	.option("--metadata <kv...>", "k=v pairs to attach to the run row (repeatable)")
	.option("--no-stream", "skip writing events to stdout (still persists everything)")
	.option("--json", "force NDJSON event output (default when not a TTY)")
	.action(
		async (id: string, message: string, opts: PromptCommandOptions & { stream?: boolean }) => {
			await withClient(async (client) => {
				const ac = makeAbortController();
				try {
					const promptOpts: PromptCommandOptions = {};
					if (opts.agent !== undefined) promptOpts.agent = opts.agent;
					if (opts.metadata !== undefined) promptOpts.metadata = opts.metadata;
					if (opts.json !== undefined) promptOpts.json = opts.json;
					if (opts.stream === false) promptOpts.noStream = true;
					const input: PromptCommandInput = {
						client,
						burrowId: id,
						prompt: message,
						options: promptOpts,
						stdout: process.stdout,
						signal: ac.controller.signal,
						isTty: Boolean(process.stdout.isTTY),
					};
					const result = await runPromptCommand(input);
					if (opts.json) {
						process.stdout.write(
							`${JSON.stringify(
								{
									run: result.run,
									agentId: result.agentId,
									state: result.state,
									exitCode: result.exitCode,
									eventsPersisted: result.eventsPersisted,
									messagesDelivered: result.messagesDelivered,
								},
								null,
								2,
							)}\n`,
						);
					} else {
						process.stdout.write(`${renderPromptResult(result)}\n`);
					}
					if (result.state === "failed") process.exit(4);
					if (result.state === "cancelled") process.exit(1);
				} finally {
					ac.dispose();
				}
			});
		},
	);

program
	.command("send")
	.description("queue a steering message for a burrow's inbox")
	.argument("<id>", "burrow id")
	.argument("[body]", "message body, or `-` to read from stdin")
	.option("--priority <level>", "priority: low | normal | high | urgent")
	.option("--from <actor>", "override the message's fromActor (default: 'user')")
	.option("--json", "emit machine-readable JSON")
	.action(async (id: string, rawBody: string | undefined, opts: SendCommandOptions) => {
		const body = await resolveSendBody(rawBody, process.stdin);
		await withClient(async (client) => {
			const result = runSendCommand({
				db: client.db,
				registry: client.agents.raw,
				burrowId: id,
				body,
				options: opts,
			});
			if (opts.json) {
				process.stdout.write(renderSendJson(result));
			} else {
				process.stdout.write(`${renderSendResult(result)}\n`);
			}
		});
	});

program
	.command("chat")
	.description("interactive steering REPL — one stdin line per message")
	.argument("<id>", "burrow id")
	.option("--priority <level>", "priority for every queued message")
	.option("--from <actor>", "override fromActor (default: 'user')")
	.option("--json", "emit JSON confirmations instead of pretty output")
	.action(async (id: string, opts: { priority?: string; from?: string; json?: boolean }) => {
		const priority = opts.priority ? parsePriority(opts.priority) : undefined;
		const chatOpts: ChatCommandOptions = {
			...(priority !== undefined ? { priority } : {}),
			...(opts.from !== undefined ? { from: opts.from } : {}),
			...(opts.json !== undefined ? { json: opts.json } : {}),
		};
		await withClient(async (client) => {
			const summary = await runChatCommand({
				db: client.db,
				registry: client.agents.raw,
				burrowId: id,
				options: chatOpts,
				stdin: lineIterator(process.stdin),
				stdout: process.stdout,
			});
			if (!opts.json) {
				process.stdout.write(`\n${summary.queued} message(s) queued.\n`);
			}
		});
	});

program
	.command("logs")
	.description("tail one burrow's event log (replay or --follow)")
	.argument("<id>", "burrow id")
	.option("--follow", "stream new events as they're appended")
	.option("--since <seq>", "skip events with seq <= the given value")
	.option("--limit <n>", "stop after N events")
	.option("--json", "force NDJSON output (default when not a TTY)")
	.action(async (id: string, opts: LogsCommandOptions) => {
		await withClient(async (client) => {
			const ac = makeAbortController();
			try {
				await runLogsCommand({
					db: client.db,
					burrowId: id,
					options: opts,
					stdout: process.stdout,
					signal: ac.controller.signal,
					isTty: Boolean(process.stdout.isTTY),
				});
			} finally {
				ac.dispose();
			}
		});
	});

program
	.command("events")
	.description("tail events across every active burrow (or --burrow allow-list)")
	.option("--follow", "stream new events as they're appended")
	.option("--burrow <id...>", "restrict to specific burrow ids")
	.option("--kind <kinds...>", "comma-separated kinds to keep (e.g. tool_use,error)")
	.option("--limit <n>", "stop after N events")
	.option("--json", "force NDJSON output (default when not a TTY)")
	.action(async (opts: EventsCommandOptions) => {
		await withClient(async (client) => {
			const ac = makeAbortController();
			try {
				await runEventsCommand({
					db: client.db,
					options: opts,
					stdout: process.stdout,
					signal: ac.controller.signal,
					isTty: Boolean(process.stdout.isTTY),
				});
			} finally {
				ac.dispose();
			}
		});
	});

const agents = program.command("agents").description("inspect registered agent runtimes");

agents
	.command("list")
	.description("list every registered agent runtime")
	.option("--json", "emit machine-readable JSON")
	.action(async (opts: { json?: boolean }) => {
		await withClient(async (client) => {
			const items: AgentsListItem[] = await runAgentsList(client);
			if (opts.json) {
				process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
			} else {
				process.stdout.write(`${renderAgentsList(items)}\n`);
			}
		});
	});

agents
	.command("show <id>")
	.description("show one agent's metadata + install status")
	.option("--json", "emit machine-readable JSON")
	.action(async (id: string, opts: { json?: boolean }) => {
		await withClient(async (client) => {
			const report = await runAgentShow(client, id);
			if (opts.json) {
				process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
			} else {
				process.stdout.write(`${renderAgentShow(report)}\n`);
			}
		});
	});

agents
	.command("validate <file>")
	.description("validate an AgentConfig JSON file against the schema")
	.option("--json", "emit machine-readable JSON")
	.action(async (file: string, opts: { json?: boolean }) => {
		const result = await runAgentValidate(file);
		if (opts.json) {
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} else {
			process.stdout.write(`${renderAgentValidate(result)}\n`);
		}
		if (!result.ok) process.exit(3);
	});

agents
	.command("add")
	.description("append [[agents]] stanzas to burrow.toml (built-in id or alias)")
	.argument("<id...>", "agent ids or aliases — e.g. `claude`, `sapling`, `codex`")
	.option("--project <root>", "project root (defaults to cwd)")
	.option("--json", "emit machine-readable JSON")
	.action(async (ids: string[], opts: { project?: string; json?: boolean }) => {
		const result = await runAgentsAdd({
			tokens: ids,
			projectRoot: opts.project ?? process.cwd(),
		});
		if (opts.json) {
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} else {
			process.stdout.write(`${renderAgentsAddResult(result)}\n`);
		}
	});

program
	.command("ship")
	.description("build + deploy artifacts via the configured ShipTarget (fly | docker | tarball)")
	.argument("[id]", "burrow id (defaults to project burrow at cwd, if any)")
	.option("--target <name>", "override [ship].default_target — one of: fly, docker, tarball")
	.option("--dry-run", "print the plan without invoking any side-effecting commands")
	.option("--quiet", "only emit plan + final done line; suppress per-step output")
	.option("--json", "force NDJSON output (default when stdout is not a TTY)")
	.action(async (id: string | undefined, opts: ShipCommandOptions & { json?: boolean }) => {
		const ac = makeAbortController();
		try {
			const shipOpts: ShipCommandOptions = {};
			if (opts.target !== undefined) shipOpts.target = opts.target;
			if (opts.dryRun !== undefined) shipOpts.dryRun = opts.dryRun;
			if (opts.json !== undefined) shipOpts.json = opts.json;
			if (opts.quiet !== undefined) shipOpts.quiet = opts.quiet;
			await withClient(async (client) => {
				const runInput: Parameters<typeof runShipCommand>[0] = {
					client,
					projectRoot: process.cwd(),
					options: shipOpts,
					stdout: process.stdout,
					signal: ac.controller.signal,
					isTty: Boolean(process.stdout.isTTY),
				};
				if (id !== undefined) runInput.burrowId = id;
				const result = await runShipCommand(runInput);
				if (opts.json) process.stdout.write(`${shipResultToJson(result)}\n`);
				if (result.state === "failed") process.exit(4);
				if (result.state === "cancelled") process.exit(1);
			});
		} finally {
			ac.dispose();
		}
	});

program
	.command("watch")
	.description("live multi-burrow dashboard (TUI by default; --json emits NDJSON snapshots)")
	.option("--json", "force NDJSON DashboardSnapshot output (default when not a TTY)")
	.option("--once", "NDJSON only: emit one snapshot and exit")
	.option("--coalesce-ms <ms>", "snapshot coalescing window (default 100)")
	.option("--poll-ms <ms>", "polling fallback interval (default 1000; 0 disables)")
	.option("--runs-limit <n>", "cap recent runs per burrow (default 20)")
	.option("--event-tail-cap <n>", "cap event tail per burrow (default 500)")
	.action(
		async (opts: {
			json?: boolean;
			once?: boolean;
			coalesceMs?: string;
			pollMs?: string;
			runsLimit?: string;
			eventTailCap?: string;
		}) => {
			const watchOpts: WatchCommandOptions = {};
			if (opts.json !== undefined) watchOpts.json = opts.json;
			if (opts.once !== undefined) watchOpts.once = opts.once;
			const coalesce = parseWatchNonNegative(opts.coalesceMs, "--coalesce-ms");
			if (coalesce !== undefined) watchOpts.coalesceMs = coalesce;
			const poll = parseWatchNonNegative(opts.pollMs, "--poll-ms");
			if (poll !== undefined) watchOpts.pollIntervalMs = poll;
			const runsLimit = parseWatchPositive(opts.runsLimit, "--runs-limit");
			if (runsLimit !== undefined) watchOpts.runsLimit = runsLimit;
			const eventTailCap = parseWatchPositive(opts.eventTailCap, "--event-tail-cap");
			if (eventTailCap !== undefined) watchOpts.eventTailCap = eventTailCap;

			await withClient(async (client) => {
				const ac = makeAbortController();
				try {
					await runWatchCommand({
						client,
						options: watchOpts,
						stdout: process.stdout as NodeJS.WritableStream & {
							write(data: string): unknown;
							columns?: number;
							rows?: number;
						},
						signal: ac.controller.signal,
						isTty: Boolean(process.stdout.isTTY),
					});
				} finally {
					ac.dispose();
				}
			});
		},
	);

program
	.command("serve")
	.description(
		"run the HTTP API server (unix socket by default; --port for TCP). SIGINT shuts down cleanly.",
	)
	.option("--socket <path>", "bind to a unix socket at <path> (default: <cacheDir>/burrow.sock)")
	.option(
		"--bind-host <host>",
		"TCP bind interface (defaults to 127.0.0.1; non-loopback requires BURROW_API_TOKEN)",
	)
	.option("--port <port>", "TCP port (use 0 for an ephemeral port)")
	.option("--no-auth", "skip bearer auth (loopback only — refused with non-loopback --bind-host)")
	.option("--json", "emit a machine-readable JSON line on startup")
	.action(
		async (opts: {
			socket?: string;
			bindHost?: string;
			port?: string;
			auth?: boolean;
			json?: boolean;
		}) => {
			const ac = makeAbortController();
			try {
				await withClient(async (client) => {
					const serveOpts: ServeCommandOptions = {};
					if (opts.socket !== undefined) serveOpts.socket = opts.socket;
					if (opts.bindHost !== undefined) serveOpts.bindHost = opts.bindHost;
					if (opts.port !== undefined) serveOpts.port = opts.port;
					if (opts.auth === false) serveOpts.noAuth = true;
					if (opts.json !== undefined) serveOpts.json = opts.json;
					await runServeCommand({
						client,
						options: serveOpts,
						signal: ac.controller.signal,
						stdout: process.stdout,
					});
				});
			} finally {
				ac.dispose();
			}
		},
	);

program
	.command("completions")
	.description(`print shell completion script (one of: ${SUPPORTED_SHELLS.join(", ")})`)
	.argument("<shell>", `shell name — one of: ${SUPPORTED_SHELLS.join(", ")}`)
	.action((shell: string) => {
		process.stdout.write(runCompletionsCommand(program, shell));
	});

program
	.command("upgrade")
	.description("print the command to upgrade burrow to the latest published version")
	.option("--json", "emit machine-readable JSON")
	.action((opts: { json?: boolean }) => {
		const message = "bun install -g @os-eco/burrow-cli@latest";
		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ command: message, current: VERSION }, null, 2)}\n`);
		} else {
			process.stdout.write(
				`current: ${VERSION}\nrun this to upgrade:\n  ${message}\n` +
					`(npm: \`npm install -g @os-eco/burrow-cli@latest\`)\n`,
			);
		}
	});

async function withClient(handler: (client: Client) => Promise<void>): Promise<void> {
	const client = await Client.open();
	try {
		await handler(client);
	} finally {
		await client.close();
	}
}

interface AbortSession {
	controller: AbortController;
	dispose: () => void;
}

function makeAbortController(): AbortSession {
	const controller = new AbortController();
	const onSig = (): void => controller.abort();
	process.on("SIGINT", onSig);
	process.on("SIGTERM", onSig);
	return {
		controller,
		dispose: () => {
			process.off("SIGINT", onSig);
			process.off("SIGTERM", onSig);
		},
	};
}

function collapseUpOptions(
	opts: Record<string, string | boolean>,
): Parameters<typeof runUpCommand>[0]["options"] {
	const out: Parameters<typeof runUpCommand>[0]["options"] = {};
	if (typeof opts.name === "string") out.name = opts.name;
	if (typeof opts.branch === "string") out.branch = opts.branch;
	if (typeof opts.baseBranch === "string") out.baseBranch = opts.baseBranch;
	if (typeof opts.origin === "string") out.originUrl = opts.origin;
	if (typeof opts.network === "string") out.network = opts.network;
	if (typeof opts.provider === "string") out.provider = opts.provider;
	if (opts.json !== undefined) out.json = Boolean(opts.json);
	return out;
}

function collapseForkOptions(
	opts: Record<string, string | boolean>,
): Parameters<typeof runForkCommand>[0]["options"] {
	const out: Parameters<typeof runForkCommand>[0]["options"] = {};
	if (typeof opts.task === "string") out.task = opts.task;
	if (typeof opts.branch === "string") out.branch = opts.branch;
	if (typeof opts.baseBranch === "string") out.baseBranch = opts.baseBranch;
	if (opts.json !== undefined) out.json = Boolean(opts.json);
	return out;
}

function parsePositive(raw: string, flag: string): number {
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0 || String(n) !== raw) {
		throw new ValidationError(`${flag} expects a positive integer, got '${raw}'`);
	}
	return n;
}

async function main(): Promise<void> {
	try {
		await program.parseAsync(process.argv);
	} catch (err) {
		process.stderr.write(`${formatError(err)}\n`);
		process.exit(exitCodeFor(err));
	}
}

if (import.meta.main) {
	void main();
}
