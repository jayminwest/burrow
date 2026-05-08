import { describe, expect, test } from "bun:test";
import { probeBinary, runStep, streamLines } from "./run.ts";

describe("probeBinary", () => {
	test("resolves a binary that exists on $PATH", async () => {
		// `sh` is on every POSIX host; /bin/sh is the most predictable.
		const path = await probeBinary("sh");
		expect(path).toBeTruthy();
		expect(path).toContain("sh");
	});

	test("returns undefined for a binary that does not exist", async () => {
		const path = await probeBinary("definitely-not-a-real-binary-xyz");
		expect(path).toBeUndefined();
	});
});

describe("streamLines", () => {
	test("yields lines split on \\n, flushing the final partial line", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("alpha\nbeta\npart"));
				controller.enqueue(new TextEncoder().encode("ial\nfinal"));
				controller.close();
			},
		});
		const lines: string[] = [];
		for await (const line of streamLines(stream)) lines.push(line);
		expect(lines).toEqual(["alpha", "beta", "partial", "final"]);
	});

	test("an empty stream yields nothing", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				c.close();
			},
		});
		const out: string[] = [];
		for await (const line of streamLines(stream)) out.push(line);
		expect(out).toEqual([]);
	});
});

describe("runStep", () => {
	test("yields step.start, stdout/stderr lines, and step.end with exit code 0 on success", async () => {
		const events: { kind: string; line?: string; exitCode?: number }[] = [];
		for await (const evt of runStep({
			index: 0,
			description: "echo",
			command: ["sh", "-c", "echo hello && echo error >&2"],
		})) {
			if (evt.kind === "step.stdout" || evt.kind === "step.stderr") {
				events.push({ kind: evt.kind, line: evt.line });
			} else if (evt.kind === "step.end") {
				events.push({ kind: evt.kind, exitCode: evt.exitCode });
			} else if (evt.kind === "step.start") {
				events.push({ kind: evt.kind });
			}
		}
		expect(events[0]?.kind).toBe("step.start");
		expect(events.at(-1)?.kind).toBe("step.end");
		expect(events.at(-1)?.exitCode).toBe(0);
		expect(events.some((e) => e.kind === "step.stdout" && e.line === "hello")).toBe(true);
		expect(events.some((e) => e.kind === "step.stderr" && e.line === "error")).toBe(true);
	});

	test("non-zero exit propagates via step.end.exitCode", async () => {
		const codes: number[] = [];
		for await (const evt of runStep({
			index: 7,
			description: "false",
			command: ["sh", "-c", "exit 3"],
		})) {
			if (evt.kind === "step.end") codes.push(evt.exitCode);
		}
		expect(codes).toEqual([3]);
	});

	test("AbortSignal kills the in-flight child", async () => {
		// Spawn `sleep` directly (no `sh -c` wrapper). On Linux with dash,
		// `sh -c "sleep 5"` keeps `sh` as the parent of `sleep`, so SIGTERM
		// to `sh` orphans `sleep` which holds the stdout/stderr pipes open
		// until it exits — the stream-drain loop then blocks for 5s.
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 50);
		let endSeen = false;
		for await (const evt of runStep({
			index: 0,
			description: "sleep",
			command: ["sleep", "5"],
			signal: ac.signal,
		})) {
			if (evt.kind === "step.end") endSeen = true;
		}
		expect(endSeen).toBe(true);
	});
});
