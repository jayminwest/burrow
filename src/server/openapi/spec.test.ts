/**
 * Golden-file lock for the OpenAPI 3.1 document (burrow-d3ea, mx-1785cc).
 *
 * The full document is checked into `__golden__/openapi.json` so any
 * change to a route or schema is a deliberate, reviewable diff. The
 * `version` field is normalized to a placeholder before comparison so
 * routine `bun run version:bump` calls don't trip the lock.
 *
 * Updating the golden: when the route table or schemas change on
 * purpose, run:
 *
 *   bun -e 'import { buildOpenApiDocument, serializeOpenApiDocument } \
 *     from "./src/server/openapi/spec.ts"; \
 *     const doc = buildOpenApiDocument({ version: "0.0.0-test" }); \
 *     console.log(serializeOpenApiDocument(doc))' \
 *     > src/server/openapi/__golden__/openapi.json
 *
 * and review the diff before committing.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTE_PATTERNS } from "../routes.ts";
import { buildOpenApiDocument, serializeOpenApiDocument } from "./spec.ts";

const GOLDEN_PATH = join(import.meta.dir, "__golden__", "openapi.json");

describe("OpenAPI document (golden lock)", () => {
	test("matches the checked-in golden file byte-for-byte (with version normalized)", () => {
		const doc = buildOpenApiDocument({ version: "0.0.0-test" });
		const actual = serializeOpenApiDocument(doc);
		const expected = readFileSync(GOLDEN_PATH, "utf8");
		expect(actual).toBe(expected);
	});

	test("openapi field is the literal string '3.1.0'", () => {
		const doc = buildOpenApiDocument() as { openapi: string };
		expect(doc.openapi).toBe("3.1.0");
	});

	test("info.version reflects the package VERSION when no override is passed", async () => {
		const { VERSION } = await import("../../index.ts");
		const doc = buildOpenApiDocument() as { info: { version: string } };
		expect(doc.info.version).toBe(VERSION);
	});

	test("every route in routes.ts ROUTE_PATTERNS appears in the spec", () => {
		const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>> };
		const specPaths = new Set<string>();
		for (const [path, methods] of Object.entries(doc.paths)) {
			for (const method of Object.keys(methods)) {
				specPaths.add(`${method.toUpperCase()} ${path.replaceAll(/\{([^}]+)\}/g, ":$1")}`);
			}
		}
		const missing: string[] = [];
		for (const { method, pattern } of ROUTE_PATTERNS) {
			if (!specPaths.has(`${method} ${pattern}`)) missing.push(`${method} ${pattern}`);
		}
		expect(missing).toEqual([]);
	});

	test("response schemas use $ref into components, not inline objects (where applicable)", () => {
		const doc = buildOpenApiDocument() as {
			paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
		};
		// Spot-check: GET /burrows/:id 200 response should ref the Burrow component.
		const getBurrow = doc.paths["/burrows/{id}"]?.get;
		const ok = getBurrow?.responses?.["200"] as
			| {
					content?: { "application/json"?: { schema?: { $ref?: string } } };
			  }
			| undefined;
		expect(ok?.content?.["application/json"]?.schema?.$ref).toBe("#/components/schemas/Burrow");
	});

	test("auth-exempt routes (`/healthz`, `/openapi.html`) declare empty security", () => {
		const doc = buildOpenApiDocument() as {
			paths: Record<string, Record<string, { security?: unknown[] }>>;
		};
		expect(doc.paths["/healthz"]?.get?.security).toEqual([]);
		expect(doc.paths["/openapi.html"]?.get?.security).toEqual([]);
	});

	test("auth-required routes inherit the global bearer security (no per-op override)", () => {
		const doc = buildOpenApiDocument() as {
			paths: Record<string, Record<string, { security?: unknown[] }>>;
		};
		expect(doc.paths["/burrows"]?.get?.security).toBeUndefined();
		expect(doc.paths["/openapi.json"]?.get?.security).toBeUndefined();
	});

	test("streaming responses declare application/x-ndjson", () => {
		const doc = buildOpenApiDocument() as {
			paths: Record<
				string,
				Record<string, { responses?: Record<string, { content?: Record<string, unknown> }> }>
			>;
		};
		expect(doc.paths["/burrows/{id}/events"]?.get?.responses?.["200"]?.content).toHaveProperty(
			"application/x-ndjson",
		);
		expect(doc.paths["/runs/{id}/stream"]?.get?.responses?.["200"]?.content).toHaveProperty(
			"application/x-ndjson",
		);
		expect(doc.paths["/watch"]?.get?.responses?.["200"]?.content).toHaveProperty(
			"application/x-ndjson",
		);
	});

	test("output is deterministic (two calls produce byte-identical bytes)", () => {
		const a = serializeOpenApiDocument(buildOpenApiDocument({ version: "x" }));
		const b = serializeOpenApiDocument(buildOpenApiDocument({ version: "x" }));
		expect(a).toBe(b);
	});
});
