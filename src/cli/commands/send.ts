/**
 * `burrow send` — inject a steering message into a burrow's inbox (SPEC §13.1).
 *
 * Stays narrow: validate the priority flag, read the body (positional arg or
 * `-` for stdin), open the database, hand off to `Inbox.send`. Phase 5 owns
 * the message lifecycle; the run loop's per-turn injection (Phase 7) is what
 * actually surfaces messages to the agent.
 *
 * Reads-from-stdin lets `burrow send <id> -` accept piped input. The `--json`
 * mode emits the inserted row so scripts can chain on the message id.
 */

import { ValidationError } from "../../core/errors.ts";
import type { Message } from "../../core/types.ts";
import type { BurrowDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import { MESSAGE_PRIORITIES, type MessagePriority } from "../../db/schema.ts";
import { Inbox } from "../../inbox/inbox.ts";
import { isSpawnPerTurn } from "../../inbox/injector.ts";
import { AgentRegistry } from "../../runtime/registry.ts";

export interface SendCommandOptions {
	priority?: string;
	from?: string;
	json?: boolean;
}

export interface SendCommandInput {
	db: BurrowDb;
	registry?: AgentRegistry;
	burrowId: string;
	body: string;
	options: SendCommandOptions;
	now?: Date;
}

export interface SendCommandResult {
	message: Message;
	deferred: boolean;
	lastAgentId: string | null;
}

const STDIN_SENTINEL = "-";

export async function readStdinBody(stdin: NodeJS.ReadableStream): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stdin) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8").replace(/\n+$/, "");
}

export function parsePriority(raw: string | undefined): MessagePriority {
	if (raw === undefined) return "normal";
	const found = (MESSAGE_PRIORITIES as readonly string[]).includes(raw)
		? (raw as MessagePriority)
		: undefined;
	if (!found) {
		throw new ValidationError(
			`unknown priority '${raw}' — expected one of: ${MESSAGE_PRIORITIES.join(", ")}`,
		);
	}
	return found;
}

export function runSendCommand(input: SendCommandInput): SendCommandResult {
	const repos = createRepos(input.db);
	const inbox = new Inbox(repos);
	const registry = input.registry ?? new AgentRegistry();
	const priority = parsePriority(input.options.priority);

	const message = inbox.send({
		burrowId: input.burrowId,
		body: input.body,
		priority,
		fromActor: input.options.from ?? "user",
		now: input.now,
	});

	const lastRun = repos.runs.listByBurrow(input.burrowId, 1)[0] ?? null;
	const lastAgentId = lastRun?.agentId ?? null;
	const deferred = lastAgentId ? !isSpawnPerTurn(registry.require(lastAgentId)) : false;

	return { message, deferred, lastAgentId };
}

/**
 * Pretty-print the `--json` payload for `burrow send`. Indented with 2 spaces
 * to match the rest of the CLI's `--json` outputs (renderUpReport, list, etc.)
 * — humans skim it directly more often than scripts pipe it through `jq`.
 */
export function renderSendJson(result: SendCommandResult): string {
	return `${JSON.stringify(
		{
			message: result.message,
			deferred: result.deferred,
			lastAgentId: result.lastAgentId,
		},
		null,
		2,
	)}\n`;
}

export function renderSendResult(result: SendCommandResult): string {
	const lines = [`✓ message queued (${result.message.id}, priority: ${result.message.priority})`];
	if (result.deferred && result.lastAgentId) {
		lines.push(
			`  ! ${result.lastAgentId} is one-shot — message will queue for the next run, not the next turn`,
		);
	}
	return lines.join("\n");
}

export async function resolveSendBody(
	rawBody: string | undefined,
	stdin: NodeJS.ReadableStream,
): Promise<string> {
	if (rawBody === undefined) {
		throw new ValidationError("missing message body — pass a string or `-` to read stdin");
	}
	if (rawBody === STDIN_SENTINEL) {
		const body = await readStdinBody(stdin);
		if (body.length === 0) {
			throw new ValidationError("stdin produced an empty message body");
		}
		return body;
	}
	return rawBody;
}
