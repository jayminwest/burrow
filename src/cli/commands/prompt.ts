/**
 * `burrow prompt <id> '<message>'` — drive one synchronous run against a
 * burrow (SPEC §5.1, §16).
 *
 * The CLI process owns the spawn from end to end: claim a queued run, mark it
 * running, and delegate the spawn-and-event-stream body to `dispatchRun`
 * (src/runner/dispatch.ts). Events flow into the events table AND into the
 * user's terminal via the `onEvent` tee. We deliberately bypass `RunLoop` —
 * that machinery is for `burrow serve`'s daemonized callers driving N
 * burrows in parallel; the CLI just needs one run, inline, with its events
 * flowing to the user's terminal.
 *
 * Defaults follow burrow.toml: when `--agent` is omitted we pick the first
 * `[[agents]]` row from the burrow's project. Honors `SandboxProfile.setEnv`
 * baked at `burrow up` time. Refuses to dispatch against stopped/destroyed
 * burrows and points the user at `bw attach`.
 */

import { loadBurrowToml } from "../../config/burrow-toml-loader.ts";
import { AgentNotInstalled, ValidationError } from "../../core/errors.ts";
import type { Burrow, Run } from "../../core/types.ts";
import { renderNdjson, renderPretty } from "../../events/render.ts";
import type { Client } from "../../lib/client.ts";
import { dispatchRun, type SpawnFn, type StartProxyFn } from "../../runner/dispatch.ts";
import type { AgentRuntime, InstallCheckResult } from "../../runtime/runtime.ts";

export type { SpawnFn, StartProxyFn } from "../../runner/dispatch.ts";

export interface PromptCommandOptions {
	/** Override the default agent (burrow.toml [[agents]][0].id). */
	agent?: string;
	/** k=v pairs stored on `runs.metadata_json` for downstream callers. */
	metadata?: string[];
	/** Force NDJSON event output. Pretty mode is the default on TTY. */
	json?: boolean;
	/** Don't write events to stdout — still persists everything. */
	noStream?: boolean;
}

export interface PromptCommandInput {
	client: Client;
	burrowId: string;
	prompt: string;
	options: PromptCommandOptions;
	stdout: NodeJS.WritableStream;
	signal?: AbortSignal;
	/** TTY hint — defaults to checking process.stdout when omitted. */
	isTty?: boolean;
	/** Test seam: alternate sandboxed-spawn implementation. */
	spawn?: SpawnFn;
	/** Test seam: alternate proxy starter (default: src/proxy/server.ts). */
	startProxy?: StartProxyFn;
	/** Test seam: skip the runtime's installCheck. */
	installCheck?: (rt: AgentRuntime) => Promise<InstallCheckResult>;
	/** Test seam: alternate burrow.toml loader (for default-agent resolution). */
	burrowTomlLoader?: typeof loadBurrowToml;
}

export interface PromptCommandResult {
	burrow: Burrow;
	run: Run;
	agentId: string;
	state: Run["state"];
	exitCode: number | null;
	/** Number of structured events persisted. */
	eventsPersisted: number;
	/** Number of pending steering messages folded into this turn. */
	messagesDelivered: number;
}

export async function runPromptCommand(input: PromptCommandInput): Promise<PromptCommandResult> {
	const repos = input.client.repos;
	const burrow = repos.burrows.require(input.burrowId);

	if (burrow.state !== "active") {
		throw new ValidationError(`cannot prompt burrow ${burrow.id} in state '${burrow.state}'`, {
			recoveryHint: `restart it with \`bw attach ${burrow.id}\` and retry`,
		});
	}

	const agentId = await resolveAgentId({
		burrow,
		override: input.options.agent,
		loader: input.burrowTomlLoader ?? loadBurrowToml,
	});
	const runtime = input.client.agents.require(agentId);

	// installCheck runs up here too (in addition to dispatchRun's check)
	// so the CLI can throw `AgentNotInstalled` with the runtime's hint
	// before any DB row is written. dispatchRun's check is the
	// daemon-path safety net.
	const installCheck = input.installCheck ?? ((rt) => rt.installCheck());
	const install = await installCheck(runtime);
	if (!install.installed) {
		throw new AgentNotInstalled(`agent '${runtime.id}' is not installed on this host`, {
			recoveryHint: install.hint,
		});
	}

	const metadata = parseMetadataPairs(input.options.metadata);

	const run = repos.runs.enqueue({
		burrowId: burrow.id,
		agentId: runtime.id,
		prompt: input.prompt,
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
	});

	const claimed = repos.runs.claimById(run.id);
	if (!claimed) {
		throw new ValidationError(`failed to claim run ${run.id} for dispatch`);
	}

	const json = resolveJsonMode(input.options.json, input.isTty);
	const writeStream = input.options.noStream !== true;
	let eventsPersisted = 0;
	let messagesDelivered = 0;
	const dispatchInput: Parameters<typeof dispatchRun>[0] = {
		client: input.client,
		run: claimed,
		onEvent: (event) => {
			eventsPersisted += 1;
			if (writeStream) {
				input.stdout.write(json ? renderNdjson(event) : renderPretty(event));
			}
		},
		onMessagesClaimed: (count) => {
			messagesDelivered = count;
		},
	};
	if (input.signal) dispatchInput.signal = input.signal;
	if (input.spawn) dispatchInput.spawn = input.spawn;
	if (input.startProxy) dispatchInput.startProxy = input.startProxy;
	if (input.installCheck) dispatchInput.installCheck = input.installCheck;

	const outcome = await dispatchRun(dispatchInput);
	const finalized = repos.runs.finalize(claimed.id, outcome);

	if (outcome.state === "failed" && outcome.errorMessage?.startsWith("event stream failed:")) {
		// Mirror the prior CLI behavior: bubble the underlying stream error
		// up to the caller so the CLI exit code reflects the real failure
		// instead of the generic "failed" envelope.
		throw new Error(outcome.errorMessage.replace(/^event stream failed: /, ""));
	}

	return {
		burrow,
		run: finalized,
		agentId: runtime.id,
		state: finalized.state,
		exitCode: outcome.exitCode ?? null,
		eventsPersisted,
		messagesDelivered,
	};
}

export function renderPromptResult(result: PromptCommandResult): string {
	const sym = result.state === "succeeded" ? "✓" : result.state === "cancelled" ? "!" : "✗";
	const head =
		result.exitCode !== null
			? `${sym} run ${result.run.id} ${result.state} (exit ${result.exitCode})`
			: `${sym} run ${result.run.id} ${result.state}`;
	const lines = [
		head,
		`  agent:    ${result.agentId}`,
		`  burrow:   ${result.burrow.id}`,
		`  events:   ${result.eventsPersisted}`,
	];
	if (result.messagesDelivered > 0) {
		lines.push(`  steering: ${result.messagesDelivered} message(s) delivered`);
	}
	return lines.join("\n");
}

export function parseMetadataPairs(pairs: string[] | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!pairs) return out;
	for (const raw of pairs) {
		const eq = raw.indexOf("=");
		if (eq <= 0) {
			throw new ValidationError(`--metadata expects 'key=value', got '${raw}'`, {
				recoveryHint: "repeat the flag for multiple pairs: `--metadata foo=1 --metadata bar=2`",
			});
		}
		const key = raw.slice(0, eq);
		const value = raw.slice(eq + 1);
		out[key] = value;
	}
	return out;
}

interface ResolveAgentIdInput {
	burrow: Burrow;
	override: string | undefined;
	loader: typeof loadBurrowToml;
}

async function resolveAgentId(input: ResolveAgentIdInput): Promise<string> {
	if (input.override !== undefined && input.override.length > 0) return input.override;
	const loaded = await input.loader(input.burrow.projectRoot);
	const first = loaded?.config.agents?.[0]?.id;
	if (first) return first;
	throw new ValidationError("no default agent — pass --agent <id> or declare one in burrow.toml", {
		recoveryHint:
			"add an agent with `bw agents add <id>` (e.g. claude, sapling, codex, pi), or pass --agent on the command line",
	});
}

function resolveJsonMode(flag: boolean | undefined, tty: boolean | undefined): boolean {
	if (flag !== undefined) return flag;
	if (tty === undefined) return !process.stdout.isTTY;
	return !tty;
}
