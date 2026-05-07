/**
 * Shared helpers for ship targets: binary probing on $PATH, and a
 * Bun-spawn-to-event-stream adapter that yields `step.stdout` / `step.stderr`
 * lines as they arrive.
 *
 * Targets reach for these instead of growing their own near-identical spawn +
 * line-buffer code. The `runStep` helper is also the seam tests stub out, so
 * we keep its signature small and explicit.
 */

import type { ShipEvent } from "./target.ts";

export interface ProbeBinaryOptions {
	/** Override the spawn function — used by tests to stub `which` calls. */
	spawn?: typeof Bun.spawn;
}

/**
 * Resolve a binary on $PATH using `which <name>`. Returns the absolute path
 * (trailing newline stripped) or undefined if not found. We deliberately use
 * `which` instead of `command -v` because `which` prints the absolute path
 * even when shell builtins shadow the binary name.
 */
export async function probeBinary(
	name: string,
	options: ProbeBinaryOptions = {},
): Promise<string | undefined> {
	const spawn = options.spawn ?? Bun.spawn;
	const proc = spawn(["which", name], { stdout: "pipe", stderr: "ignore" });
	const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (exit !== 0) return undefined;
	const trimmed = stdout.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export interface RunStepInput {
	index: number;
	description: string;
	command: string[];
	cwd?: string;
	env?: Record<string, string>;
	signal?: AbortSignal;
	/** Test seam; defaults to `Bun.spawn`. */
	spawn?: typeof Bun.spawn;
}

/**
 * Spawn one step and yield `step.start` / `step.stdout` / `step.stderr` /
 * `step.end` events. The step's exit code is on `step.end` — callers decide
 * whether non-zero halts the pipeline or is collected and reported.
 */
export async function* runStep(input: RunStepInput): AsyncGenerator<ShipEvent, void, void> {
	const startEvent: ShipEvent = {
		kind: "step.start",
		index: input.index,
		description: input.description,
		command: input.command,
	};
	yield startEvent;

	const spawn = input.spawn ?? Bun.spawn;
	const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
		stdout: "pipe",
		stderr: "pipe",
	};
	if (input.cwd !== undefined) spawnOpts.cwd = input.cwd;
	if (input.env !== undefined) spawnOpts.env = { ...process.env, ...input.env };

	const proc = spawn(input.command, spawnOpts);

	const onAbort = (): void => {
		try {
			proc.kill();
		} catch {
			// process already exited
		}
	};
	if (input.signal) {
		if (input.signal.aborted) onAbort();
		input.signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		const stdoutLines = streamLines(proc.stdout as ReadableStream<Uint8Array>);
		const stderrLines = streamLines(proc.stderr as ReadableStream<Uint8Array>);

		// Drain both streams concurrently; merge events in arrival order.
		for await (const evt of mergeStreams<ShipEvent>([
			adapt(stdoutLines, (line) => ({ kind: "step.stdout", index: input.index, line })),
			adapt(stderrLines, (line) => ({ kind: "step.stderr", index: input.index, line })),
		])) {
			yield evt;
		}

		const exitCode = await proc.exited;
		yield { kind: "step.end", index: input.index, exitCode };
	} finally {
		if (input.signal) input.signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Async iterator that yields decoded lines from a Uint8Array stream. The last
 * partial line (if any) is flushed when the stream ends.
 */
export async function* streamLines(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx = buf.indexOf("\n");
			while (idx >= 0) {
				const line = buf.slice(0, idx);
				buf = buf.slice(idx + 1);
				yield line;
				idx = buf.indexOf("\n");
			}
		}
		buf += decoder.decode();
		if (buf.length > 0) yield buf;
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// no-op
		}
	}
}

async function* adapt<T, U>(
	src: AsyncGenerator<T, void, void>,
	xform: (t: T) => U,
): AsyncGenerator<U, void, void> {
	for await (const v of src) yield xform(v);
}

/**
 * Merge N async iterators preserving arrival order — a fair race over `next()`
 * calls. Used by `runStep` so stdout/stderr lines interleave as they're written.
 */
async function* mergeStreams<T>(
	iters: AsyncGenerator<T, void, void>[],
): AsyncGenerator<T, void, void> {
	type Pending = {
		iter: AsyncGenerator<T, void, void>;
		promise: Promise<{ idx: number; value: IteratorResult<T> }>;
	};
	const slots: (Pending | null)[] = iters.map((iter, idx) => ({
		iter,
		promise: iter.next().then((value) => ({ idx, value })),
	}));

	while (slots.some((s) => s !== null)) {
		const live = slots.filter((s): s is Pending => s !== null);
		const { idx, value } = await Promise.race(live.map((s) => s.promise));
		const slot = slots[idx];
		if (!slot) continue;
		if (value.done) {
			slots[idx] = null;
			continue;
		}
		yield value.value;
		slot.promise = slot.iter.next().then((next) => ({ idx, value: next }));
	}
}
