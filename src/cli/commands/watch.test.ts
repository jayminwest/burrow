import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { ValidationError } from "../../core/errors.ts";
import {
	ALT_SCREEN_ENTER,
	ALT_SCREEN_EXIT,
	CURSOR_HOME,
	CURSOR_SHOW,
	type TuiStdin,
} from "../../dashboard/tui.ts";
import { Client } from "../../lib/client.ts";
import {
	parseNonNegative,
	parsePositive,
	runWatchCommand,
	type WatchCommandInput,
} from "./watch.ts";

class CollectStream extends Writable {
	chunks: string[] = [];
	columns?: number;
	rows?: number;
	override _write(
		chunk: Buffer | string,
		_enc: BufferEncoding,
		cb: (err?: Error | null) => void,
	): void {
		this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		cb();
	}
	get text(): string {
		return this.chunks.join("");
	}
	get lines(): string[] {
		return this.text.split("\n").filter((l) => l.length > 0);
	}
}

class FakeStdin implements TuiStdin {
	private listeners = new Set<(chunk: Buffer) => void>();
	isRaw = false;

	on(_event: "data", listener: (chunk: Buffer) => void): unknown {
		this.listeners.add(listener);
		return this;
	}
	off(_event: "data", listener: (chunk: Buffer) => void): unknown {
		this.listeners.delete(listener);
		return this;
	}
	setRawMode(raw: boolean): unknown {
		this.isRaw = raw;
		return this;
	}
	resume(): unknown {
		return this;
	}
	pause(): unknown {
		return this;
	}

	send(s: string): void {
		const buf = Buffer.from(s, "utf8");
		for (const listener of [...this.listeners]) listener(buf);
	}

	listenerCount(): number {
		return this.listeners.size;
	}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("parseNonNegative / parsePositive", () => {
	test("parseNonNegative accepts 0 and integers; rejects floats and negatives", () => {
		expect(parseNonNegative(undefined, "--x")).toBeUndefined();
		expect(parseNonNegative("0", "--x")).toBe(0);
		expect(parseNonNegative("100", "--x")).toBe(100);
		expect(() => parseNonNegative("-1", "--x")).toThrow(ValidationError);
		expect(() => parseNonNegative("1.5", "--x")).toThrow(ValidationError);
		expect(() => parseNonNegative("abc", "--x")).toThrow(ValidationError);
	});
	test("parsePositive rejects 0 and negatives", () => {
		expect(parsePositive(undefined, "--y")).toBeUndefined();
		expect(parsePositive("3", "--y")).toBe(3);
		expect(() => parsePositive("0", "--y")).toThrow(ValidationError);
		expect(() => parsePositive("-2", "--y")).toThrow(ValidationError);
	});
});

describe("runWatchCommand", () => {
	let dataDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-watch-"));
		client = await Client.open({ dataDir, configDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	function seed(name: string) {
		return client.repos.burrows.create({
			kind: "project",
			name,
			projectRoot: `/work/${name}`,
			workspacePath: `/work/${name}/.ws`,
			branch: "main",
			provider: "local",
			profile: {},
		});
	}

	test("--json --once emits exactly one DashboardSnapshot envelope and exits", async () => {
		seed("alpha");
		seed("beta");
		const stdout = new CollectStream();

		const summary = await runWatchCommand({
			client,
			options: { json: true, once: true, coalesceMs: 0, pollIntervalMs: 0 },
			stdout: stdout as unknown as WatchCommandInput["stdout"],
			isTty: false,
		});

		expect(summary.mode).toBe("json");
		expect(summary.emitted).toBe(1);
		expect(summary.stoppedReason).toBe("once");
		expect(stdout.lines).toHaveLength(1);
		const envelope = JSON.parse(stdout.lines[0] ?? "");
		expect(envelope.type).toBe("snapshot");
		expect(envelope.version).toBe(1);
		expect(envelope.burrows).toHaveLength(2);
	});

	test("--json without --once streams snapshots until aborted", async () => {
		seed("alpha");
		const stdout = new CollectStream();
		const ac = new AbortController();

		const consumer = runWatchCommand({
			client,
			options: { json: true, coalesceMs: 0, pollIntervalMs: 5 },
			stdout: stdout as unknown as WatchCommandInput["stdout"],
			signal: ac.signal,
			isTty: false,
		});

		await sleep(20);
		ac.abort();
		const summary = await consumer;

		expect(summary.mode).toBe("json");
		expect(summary.emitted).toBeGreaterThanOrEqual(1);
		expect(summary.stoppedReason).toBe("abort");
		// Every emitted line must parse as a snapshot envelope.
		for (const line of stdout.lines) {
			const env = JSON.parse(line);
			expect(env.type).toBe("snapshot");
			expect(env.version).toBe(1);
		}
		// Subscription cleanup — the bus is shared with the live client.
		expect(client.bus.listenerCount()).toBe(0);
	});

	test("isTty=true with no --json drives the TUI runtime (alt-screen entry/exit)", async () => {
		seed("alpha");
		const stdout = new CollectStream();
		stdout.columns = 100;
		stdout.rows = 30;
		const stdin = new FakeStdin();
		const ac = new AbortController();

		const consumer = runWatchCommand({
			client,
			options: { coalesceMs: 0, pollIntervalMs: 0 },
			stdout: stdout as unknown as WatchCommandInput["stdout"],
			stdin,
			signal: ac.signal,
			isTty: true,
			onResize: () => () => {},
			initialTermSize: { columns: 100, rows: 30 },
		});

		await sleep(5);
		expect(stdout.chunks[0]).toBe(`${ALT_SCREEN_ENTER}\x1b[?25l`);
		expect(stdout.text).toContain(CURSOR_HOME);

		ac.abort();
		const summary = await consumer;

		expect(summary.mode).toBe("tui");
		expect(summary.framesRendered).toBeGreaterThanOrEqual(1);
		expect(summary.quitReason).toBe("abort");
		expect(stdout.chunks.at(-1)).toBe(`${CURSOR_SHOW}${ALT_SCREEN_EXIT}`);
		expect(stdin.listenerCount()).toBe(0);
		expect(client.bus.listenerCount()).toBe(0);
	});

	test("--json overrides isTty=true (force NDJSON mode)", async () => {
		seed("alpha");
		const stdout = new CollectStream();

		const summary = await runWatchCommand({
			client,
			options: { json: true, once: true, coalesceMs: 0, pollIntervalMs: 0 },
			stdout: stdout as unknown as WatchCommandInput["stdout"],
			isTty: true,
		});

		expect(summary.mode).toBe("json");
		expect(stdout.text).not.toContain(ALT_SCREEN_ENTER);
		expect(stdout.lines).toHaveLength(1);
	});

	test("isTty=false with no --json defaults to NDJSON mode", async () => {
		seed("alpha");
		const stdout = new CollectStream();

		const summary = await runWatchCommand({
			client,
			options: { once: true, coalesceMs: 0, pollIntervalMs: 0 },
			stdout: stdout as unknown as WatchCommandInput["stdout"],
			isTty: false,
		});

		expect(summary.mode).toBe("json");
		expect(summary.emitted).toBe(1);
	});
});
