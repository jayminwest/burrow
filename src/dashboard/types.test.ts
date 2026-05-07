/**
 * Lock test for the DashboardSnapshot view-model envelope (SPEC §27 —
 * forthcoming, see ../dashboard/types.ts JSDoc). The envelope is
 * additive-only: this test pins the canonical key set per interface so
 * any rename or removal trips the test, forcing an intentional
 * `DASHBOARD_SNAPSHOT_VERSION` bump.
 *
 * Adding a new field is expected to be a one-line update to the
 * corresponding `expect(...keys...).toEqual([...])` array — that's the
 * intentional change the convention demands.
 */

import { describe, expect, test } from "bun:test";
import {
	type BurrowCard,
	DASHBOARD_SNAPSHOT_VERSION,
	type DashboardSnapshot,
	DEFAULT_EVENT_TAIL_CAP,
	type EventTailEntry,
	type RunSummary,
} from "./types.ts";

const sampleRun: RunSummary = {
	id: "run_2c4d",
	burrowId: "bur_a3f9",
	agentId: "claude-code",
	state: "running",
	exitCode: null,
	errorMessage: null,
	queuedAt: "2026-05-07T18:59:00.000Z",
	startedAt: "2026-05-07T18:59:01.000Z",
	completedAt: null,
};

const sampleEvent: EventTailEntry = {
	burrowId: "bur_a3f9",
	runId: "run_2c4d",
	seq: 42,
	kind: "tool_use",
	stream: "stdout",
	ts: "2026-05-07T19:00:00.000Z",
	payload: { tool: "Bash", input: { command: "bun test" } },
};

const sampleCard: BurrowCard = {
	id: "bur_a3f9",
	parentId: null,
	kind: "project",
	name: "burrow",
	state: "active",
	projectRoot: "/work/burrow",
	workspacePath: "/work/burrow/.burrow/workspaces/bur_a3f9",
	branch: "burrow/bur_a3f9",
	provider: "local",
	createdAt: "2026-05-07T18:00:00.000Z",
	updatedAt: "2026-05-07T19:00:00.000Z",
	destroyedAt: null,
	runs: [sampleRun],
	activeRun: sampleRun,
	eventTail: [sampleEvent],
	lastEventSeq: 42,
};

const sampleSnapshot: DashboardSnapshot = {
	type: "snapshot",
	version: DASHBOARD_SNAPSHOT_VERSION,
	ts: "2026-05-07T19:00:00.000Z",
	burrows: [sampleCard],
};

function keys(value: object): string[] {
	return Object.keys(value).sort();
}

describe("DashboardSnapshot envelope (additive-only lock)", () => {
	test("DASHBOARD_SNAPSHOT_VERSION is 1 and locked", () => {
		expect(DASHBOARD_SNAPSHOT_VERSION).toBe(1);
	});

	test("DEFAULT_EVENT_TAIL_CAP is 500", () => {
		expect(DEFAULT_EVENT_TAIL_CAP).toBe(500);
	});

	test("DashboardSnapshot canonical keys are [burrows, ts, type, version]", () => {
		expect(keys(sampleSnapshot)).toEqual(["burrows", "ts", "type", "version"]);
	});

	test("DashboardSnapshot.type is the literal 'snapshot'", () => {
		expect(sampleSnapshot.type).toBe("snapshot");
	});

	test("BurrowCard canonical keys", () => {
		expect(keys(sampleCard)).toEqual([
			"activeRun",
			"branch",
			"createdAt",
			"destroyedAt",
			"eventTail",
			"id",
			"kind",
			"lastEventSeq",
			"name",
			"parentId",
			"projectRoot",
			"provider",
			"runs",
			"state",
			"updatedAt",
			"workspacePath",
		]);
	});

	test("RunSummary canonical keys", () => {
		expect(keys(sampleRun)).toEqual([
			"agentId",
			"burrowId",
			"completedAt",
			"errorMessage",
			"exitCode",
			"id",
			"queuedAt",
			"startedAt",
			"state",
		]);
	});

	test("EventTailEntry canonical keys", () => {
		expect(keys(sampleEvent)).toEqual([
			"burrowId",
			"kind",
			"payload",
			"runId",
			"seq",
			"stream",
			"ts",
		]);
	});

	test("envelope round-trips through JSON without loss", () => {
		const restored = JSON.parse(JSON.stringify(sampleSnapshot)) as DashboardSnapshot;
		expect(restored).toEqual(sampleSnapshot);
		// Null fields survive round-trip rather than collapsing to undefined.
		expect(restored.burrows[0]?.parentId).toBeNull();
		expect(restored.burrows[0]?.destroyedAt).toBeNull();
		expect(restored.burrows[0]?.runs[0]?.completedAt).toBeNull();
	});
});
