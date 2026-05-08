/**
 * Route-level tests for `/openapi.json` and `/openapi.html` (burrow-d3ea).
 *
 * Verifies the wire-level contract: status, content-type, and the auth
 * posture (`/openapi.json` is auth-required, `/openapi.html` is exempt).
 * The byte-level shape of the JSON itself is locked by `spec.test.ts`
 * against the golden file.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createLogger } from "../../logging/logger.ts";
import { bearerAuth, NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";

const silentLogger = createLogger({ level: "fatal" });

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

describe("openapi route handlers", () => {
	let handle: ServeHandle | null = null;

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
	});

	test("GET /openapi.json returns the spec under no-auth", async () => {
		handle = startServer(null, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/openapi.json`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const doc = (await res.json()) as { openapi: string; info: { title: string } };
		expect(doc.openapi).toBe("3.1.0");
		expect(doc.info.title).toBe("burrow serve");
	});

	test("GET /openapi.json requires auth when bearer is configured", async () => {
		handle = startServer(null, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth("s3cr3t"),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/openapi.json`);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain("Bearer");
	});

	test("GET /openapi.json with valid bearer → 200", async () => {
		handle = startServer(null, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth("s3cr3t"),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/openapi.json`, {
			headers: { authorization: "Bearer s3cr3t" },
		});
		expect(res.status).toBe(200);
	});

	test("GET /openapi.html is auth-exempt and returns HTML referencing /openapi.json", async () => {
		handle = startServer(null, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: bearerAuth("s3cr3t"),
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/openapi.html`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const body = await res.text();
		expect(body).toContain('data-url="/openapi.json"');
		// The viewer is intentionally simple; assert the script tag is present
		// without pinning the CDN URL byte-for-byte (which would otherwise
		// break every Scalar version bump in the source).
		expect(body).toContain("<script");
	});

	test("the JSON body is byte-stable across requests (cached)", async () => {
		handle = startServer(null, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const a = await fetch(`${tcpUrl(handle)}/openapi.json`).then((r) => r.text());
		const b = await fetch(`${tcpUrl(handle)}/openapi.json`).then((r) => r.text());
		expect(a).toBe(b);
	});
});
