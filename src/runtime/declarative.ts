/**
 * Lift an `AgentConfig` into a runtime that satisfies `AgentRuntime`.
 *
 * The config carries everything the runtime needs to know: how the prompt
 * reaches the binary (`promptDelivery`), what output format to parse
 * (`outputFormat`), whether/how steering messages are injected
 * (`inboxDelivery`), and an optional `prepareWorkspace` hook for writing a
 * settings file. We materialize a fresh `AgentRuntime` object per call so
 * each registration is independent — no shared state, no surprise mutations.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { ValidationError } from "../core/errors.ts";
import type { Message } from "../core/types.ts";
import type { SpawnCommand } from "../provider/types.ts";
import {
	type AgentConfig,
	type AgentInboxDelivery,
	type AgentOutputFormat,
	parseAgentConfig,
} from "../schemas/agent-config.ts";
import { parseJsonlClaude } from "./parsers/jsonl-claude.ts";
import { parseRawText } from "./parsers/raw-text.ts";
import { parseStreamJson } from "./parsers/stream-json.ts";
import type {
	AgentRuntime,
	InstallCheckResult,
	ParseContext,
	PrepareContext,
	ResumeContext,
	RuntimeEvent,
	SpawnContext,
} from "./runtime.ts";

const TOKEN_RE = /\{\{(prompt|workspace|run_id|burrow_id)\}\}/g;

interface Substitutions {
	prompt: string;
	workspace: string;
	run_id: string;
	burrow_id: string;
}

/**
 * Validate `input` against the config schema and return a runtime. Throws
 * `ValidationError` with a flattened diff on schema failure so the CLI can
 * surface it directly.
 */
export function loadAgentConfig(input: unknown): AgentRuntime {
	const res = parseAgentConfig(input);
	if (!res.ok || !res.config) {
		const detail =
			res.errors?.map((e) => `${e.path.join(".") || "<root>"}: ${e.message}`).join("; ") ??
			"unknown agent config error";
		throw new ValidationError(`invalid agent config: ${detail}`);
	}
	return agentConfigToRuntime(res.config);
}

export function agentConfigToRuntime(config: AgentConfig): AgentRuntime {
	const parser = pickParser(config.outputFormat);
	const inboxDelivery: AgentInboxDelivery = config.inboxDelivery;

	return {
		id: config.id,
		displayName: config.displayName,
		supportsResume: config.supportsResume,

		buildSpawnCommand(ctx: SpawnContext): SpawnCommand {
			return renderSpawn(config, ctx, /*resume*/ false);
		},

		buildResumeCommand(ctx: ResumeContext): SpawnCommand {
			return renderSpawn(config, ctx, /*resume*/ true);
		},

		parseEvents(line: string, _ctx: ParseContext): RuntimeEvent[] {
			return parser(line);
		},

		encodeInboxMessage(messages: Message[]): { stdin: string } {
			return { stdin: encodeInbox(messages, inboxDelivery) };
		},

		async prepareWorkspace(ctx: PrepareContext): Promise<void> {
			const settings = config.hooks?.settingsLocalJson;
			if (!settings) return;
			await writeSettingsLocalJson(ctx.workspacePath, settings);
		},

		async installCheck(): Promise<InstallCheckResult> {
			const probe = config.installCheck;
			if (!probe) return { installed: true };
			try {
				const proc = Bun.spawn([probe.command, ...(probe.args ?? [])], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const exit = await proc.exited;
				if (exit !== probe.exitCode) {
					return {
						installed: false,
						hint: `${probe.command} exited ${exit}, expected ${probe.exitCode}`,
					};
				}
				const out = (await new Response(proc.stdout).text()).trim();
				const result: InstallCheckResult = { installed: true };
				if (out.length > 0) result.version = out;
				return result;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { installed: false, hint: `failed to invoke ${probe.command}: ${msg}` };
			}
		},
	};
}

function pickParser(format: AgentOutputFormat): (line: string) => RuntimeEvent[] {
	switch (format) {
		case "raw-text":
			return parseRawText;
		case "stream-json":
			return parseStreamJson;
		case "jsonl-claude":
			return parseJsonlClaude;
	}
}

function renderSpawn(config: AgentConfig, ctx: SpawnContext, resume: boolean): SpawnCommand {
	const subs: Substitutions = {
		prompt: composePrompt(ctx.prompt, ctx.pendingMessages),
		workspace: ctx.workspacePath,
		run_id: ctx.run.id,
		burrow_id: ctx.burrow.id,
	};

	const baseArgs = resume && config.resumeArgs ? config.resumeArgs : config.args;
	const args = baseArgs.map((a) => substitute(a, subs));
	const argv = [config.command, ...args];

	const command: SpawnCommand = { argv };

	switch (config.promptDelivery) {
		case "arg":
			// `{{prompt}}` already substituted into args. Nothing else to do.
			break;
		case "stdin":
			command.stdin = subs.prompt;
			break;
		case "file":
			// File path lives in promptFile; the actual write happens at run-loop
			// dispatch time (it owns the workspace and post-prepareWorkspace order).
			// We surface the rendered path via env so the spawned process can read it.
			break;
	}

	return command;
}

function composePrompt(prompt: string, messages: Message[]): string {
	if (messages.length === 0) return prompt;
	const steering = messages.map((m) => `[STEERING] (priority: ${m.priority}) ${m.body}`).join("\n");
	return prompt.length > 0 ? `${steering}\n\n${prompt}` : steering;
}

function encodeInbox(messages: Message[], delivery: AgentInboxDelivery): string {
	if (delivery === "none" || messages.length === 0) return "";
	if (delivery === "stdin-ndjson") {
		return messages
			.map((m) =>
				JSON.stringify({
					type: "steering",
					id: m.id,
					priority: m.priority,
					body: m.body,
					createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
				}),
			)
			.join("\n");
	}
	// "file": callers persist the encoded blob themselves; we just return the
	// canonical text form here so they don't reinvent it.
	return messages.map((m) => `[STEERING] (priority: ${m.priority}) ${m.body}`).join("\n");
}

function substitute(template: string, subs: Substitutions): string {
	return template.replace(TOKEN_RE, (_match, key: keyof Substitutions) => subs[key]);
}

async function writeSettingsLocalJson(workspacePath: string, value: string): Promise<void> {
	const target = join(workspacePath, ".claude", "settings.local.json");
	const body = await loadInlineOrFile(value);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, body, { encoding: "utf8", flag: "w" });
}

async function loadInlineOrFile(value: string): Promise<string> {
	const trimmed = value.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return ensureNewline(trimmed);
	const path = isAbsolute(value) ? value : value;
	const file = Bun.file(path);
	if (!(await file.exists())) {
		throw new ValidationError(
			`agent settings template not found: ${path} (expected an inline JSON literal or a readable file path)`,
		);
	}
	return ensureNewline(await file.text());
}

function ensureNewline(s: string): string {
	return s.endsWith("\n") ? s : `${s}\n`;
}
