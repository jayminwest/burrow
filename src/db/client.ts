/**
 * Drizzle + bun:sqlite database client.
 *
 * `openDatabase` opens (or creates) the SQLite file, enables WAL mode, runs
 * any pending migrations, and returns a typed drizzle handle plus the raw
 * connection. Callers close via `db.close()` to release the file.
 *
 * WAL is enabled at startup (SPEC §10) so concurrent readers don't block the
 * single writer. The pragmas are idempotent and cheap to set on every open.
 *
 * For tests, pass `path: ':memory:'` to get an ephemeral DB; migrations still
 * run so the schema is identical to production.
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema.ts";

const DEFAULT_MIGRATIONS_FOLDER = join(import.meta.dir, "migrations");

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

export interface BurrowDb {
	drizzle: DrizzleDb;
	raw: Database;
	close(): void;
}

export interface OpenDatabaseOptions {
	path: string;
	migrationsFolder?: string;
	skipMigrations?: boolean;
}

export async function openDatabase(options: OpenDatabaseOptions): Promise<BurrowDb> {
	if (options.path !== ":memory:") {
		await mkdir(dirname(options.path), { recursive: true });
	}

	const inMemory = options.path === ":memory:";
	const raw = new Database(options.path, { create: true });
	configurePragmas(raw, inMemory);

	const db = drizzle(raw, { schema });

	if (!options.skipMigrations) {
		migrate(db, {
			migrationsFolder: options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER,
		});
	}

	if (!inMemory) reclaimIfBloated(raw);

	return {
		drizzle: db,
		raw,
		close: () => raw.close(),
	};
}

function configurePragmas(raw: Database, inMemory: boolean): void {
	if (!inMemory) {
		// Keep the freelist from growing without bound. `burrow destroy` frees
		// pages on every reaped run; without auto_vacuum those pages are never
		// returned to the OS and the file balloons (a prod box hit 1.83 GB
		// holding ~1 MB of live data). The mode is recorded in the file header
		// at creation, so it must be set BEFORE journal_mode = WAL writes the
		// first page. On a fresh file INCREMENTAL takes effect immediately; on a
		// pre-existing DB the mode only converts after a full VACUUM, which
		// `reclaimIfBloated` performs when the freelist is large.
		raw.exec("PRAGMA auto_vacuum = INCREMENTAL");
		raw.exec("PRAGMA journal_mode = WAL");
		raw.exec("PRAGMA synchronous = NORMAL");
	}
	raw.exec("PRAGMA foreign_keys = ON");
	raw.exec("PRAGMA busy_timeout = 5000");
}

/** Above this freelist/page ratio, a one-time VACUUM is worth the rebuild. */
const FREELIST_VACUUM_RATIO = 0.5;

/**
 * Self-healing startup compaction. When most of the file is free pages, run a
 * one-time `VACUUM` to return the space to the OS. Because `auto_vacuum =
 * INCREMENTAL` is already set, this rebuild also converts a legacy DB to
 * incremental mode so it never re-bloats. VACUUM cannot run inside a
 * transaction, so this is invoked after migrations on the open path. Returns
 * true when a VACUUM was performed.
 */
export function reclaimIfBloated(raw: Database, ratio = FREELIST_VACUUM_RATIO): boolean {
	const pageCount =
		raw.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
	if (pageCount === 0) return false;
	const freelist =
		raw.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count ?? 0;
	if (freelist / pageCount <= ratio) return false;
	raw.exec("VACUUM");
	return true;
}

export { schema };
