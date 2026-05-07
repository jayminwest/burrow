#!/usr/bin/env bun
/**
 * Burrow CLI entry. Phase 0 wires --version/--help and a doctor stub;
 * Phase 5 adds `send` and `chat`. The full surface (up/prompt/...) lands
 * in later phases per SPEC §22.
 */

import { Command } from "commander";
import { resolvePaths } from "../config/paths.ts";
import { formatError, ValidationError } from "../core/errors.ts";
import { type BurrowDb, openDatabase } from "../db/client.ts";
import { VERSION } from "../index.ts";
import { type ChatCommandOptions, lineIterator, runChatCommand } from "./commands/chat.ts";
import { renderDoctorReport, runDoctor } from "./commands/doctor.ts";
import { type EventsCommandOptions, runEventsCommand } from "./commands/events.ts";
import { type LogsCommandOptions, runLogsCommand } from "./commands/logs.ts";
import {
	parsePriority,
	renderSendResult,
	resolveSendBody,
	runSendCommand,
	type SendCommandOptions,
} from "./commands/send.ts";

const program = new Command();

program
	.name("burrow")
	.description("OS-isolated sandbox runtime for coding agents")
	.version(VERSION, "-v, --version", "print version and exit");

program
	.command("doctor")
	.description("check host environment for required sandbox primitives")
	.option("--json", "emit machine-readable JSON")
	.action(async (opts: { json?: boolean }) => {
		const report = await runDoctor();
		if (opts.json) {
			process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		} else {
			process.stdout.write(`${renderDoctorReport(report)}\n`);
		}
		process.exit(report.ok ? 0 : 1);
	});

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
		const db = await openCliDatabase();
		try {
			const result = runSendCommand({
				db,
				burrowId: id,
				body,
				options: opts,
			});
			if (opts.json) {
				process.stdout.write(
					`${JSON.stringify({
						message: result.message,
						deferred: result.deferred,
						lastAgentId: result.lastAgentId,
					})}\n`,
				);
			} else {
				process.stdout.write(`${renderSendResult(result)}\n`);
			}
		} finally {
			db.close();
		}
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
		const db = await openCliDatabase();
		try {
			const summary = await runChatCommand({
				db,
				burrowId: id,
				options: chatOpts,
				stdin: lineIterator(process.stdin),
				stdout: process.stdout,
			});
			if (!opts.json) {
				process.stdout.write(`\n${summary.queued} message(s) queued.\n`);
			}
		} finally {
			db.close();
		}
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
		const db = await openCliDatabase();
		const ac = new AbortController();
		const onSig = () => ac.abort();
		process.on("SIGINT", onSig);
		process.on("SIGTERM", onSig);
		try {
			await runLogsCommand({
				db,
				burrowId: id,
				options: opts,
				stdout: process.stdout,
				signal: ac.signal,
				isTty: Boolean(process.stdout.isTTY),
			});
		} finally {
			process.off("SIGINT", onSig);
			process.off("SIGTERM", onSig);
			db.close();
		}
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
		const db = await openCliDatabase();
		const ac = new AbortController();
		const onSig = () => ac.abort();
		process.on("SIGINT", onSig);
		process.on("SIGTERM", onSig);
		try {
			await runEventsCommand({
				db,
				options: opts,
				stdout: process.stdout,
				signal: ac.signal,
				isTty: Boolean(process.stdout.isTTY),
			});
		} finally {
			process.off("SIGINT", onSig);
			process.off("SIGTERM", onSig);
			db.close();
		}
	});

async function openCliDatabase(): Promise<BurrowDb> {
	const paths = resolvePaths();
	return openDatabase({ path: paths.dbPath });
}

async function main(): Promise<void> {
	try {
		await program.parseAsync(process.argv);
	} catch (err) {
		process.stderr.write(`${formatError(err)}\n`);
		process.exit(err instanceof ValidationError ? 3 : 1);
	}
}

if (import.meta.main) {
	void main();
}
