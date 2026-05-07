#!/usr/bin/env bun
/**
 * Burrow CLI entry. Phase 0 wires --version/--help and a doctor stub;
 * the full surface (up/prompt/send/...) lands in later phases per SPEC §22.
 */

import { Command } from "commander";
import { formatError } from "../core/errors.ts";
import { VERSION } from "../index.ts";
import { renderDoctorReport, runDoctor } from "./commands/doctor.ts";

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

async function main(): Promise<void> {
	try {
		await program.parseAsync(process.argv);
	} catch (err) {
		process.stderr.write(`${formatError(err)}\n`);
		process.exit(1);
	}
}

if (import.meta.main) {
	void main();
}
