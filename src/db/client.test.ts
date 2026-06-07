import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, reclaimIfBloated } from "./client.ts";
import { createRepos } from "./repos/index.ts";

describe("openDatabase", () => {
	test("runs migrations against a fresh in-memory db", async () => {
		const db = await openDatabase({ path: ":memory:" });
		try {
			const tables = db.raw
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
				)
				.all();
			const names = tables.map((t) => t.name);
			for (const expected of ["burrows", "runs", "events", "messages", "meta"]) {
				expect(names).toContain(expected);
			}
		} finally {
			db.close();
		}
	});

	test("enables WAL on file-backed databases and creates parent dirs", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "burrow-db-"));
		const dbPath = join(tmp, "nested", "db.sqlite");
		const db = await openDatabase({ path: dbPath });
		try {
			const mode = db.raw.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
			expect(mode?.journal_mode).toBe("wal");
			const fk = db.raw.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
			expect(fk?.foreign_keys).toBe(1);
		} finally {
			db.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("enables incremental auto_vacuum on file-backed databases", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "burrow-db-"));
		const dbPath = join(tmp, "db.sqlite");
		const db = await openDatabase({ path: dbPath });
		try {
			const mode = db.raw.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get();
			expect(mode?.auto_vacuum).toBe(2);
		} finally {
			db.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("self-healing VACUUM reclaims a bloated file on reopen", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "burrow-db-"));
		const dbPath = join(tmp, "db.sqlite");
		const a = await openDatabase({ path: dbPath });
		const repos = createRepos(a);
		const burrow = repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		for (let i = 0; i < 4000; i++) {
			repos.events.append({
				burrowId: burrow.id,
				kind: "k",
				stream: "stdout",
				payload: { i, blob: "x".repeat(64) },
			});
		}
		a.raw.exec("DELETE FROM events");
		const bloated =
			a.raw.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count ??
			0;
		expect(bloated).toBeGreaterThan(0);
		a.close();

		// Reopen triggers reclaimIfBloated when the freelist dominates the file.
		const b = await openDatabase({ path: dbPath });
		try {
			const after =
				b.raw.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()
					?.freelist_count ?? -1;
			expect(after).toBeLessThan(bloated);
		} finally {
			b.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("reclaimIfBloated is a no-op when the freelist is small", async () => {
		const db = await openDatabase({ path: ":memory:" });
		try {
			expect(reclaimIfBloated(db.raw)).toBe(false);
		} finally {
			db.close();
		}
	});

	test("re-opening an existing db is a no-op for migrations", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "burrow-db-"));
		const dbPath = join(tmp, "db.sqlite");
		const a = await openDatabase({ path: dbPath });
		a.close();
		const b = await openDatabase({ path: dbPath });
		try {
			const tables = b.raw
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='burrows'",
				)
				.all();
			expect(tables).toHaveLength(1);
		} finally {
			b.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
