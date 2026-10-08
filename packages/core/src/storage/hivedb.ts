/**
 * HiveDB — singleton accessor
 *
 * HiveDB (@johpaz/hive-db) is the embedded Rust engine (redb + tantivy BM25 +
 * hnsw_rs) that is the sole data store for Hive: capability search (tools,
 * skills, playbook, MCP tools) via its BM25/hybrid index, and every other
 * piece of relational-shaped data (users, agents, providers, models,
 * conversations, cron, projects, ACE/playbook, ...) via its document
 * collections (`db.collection<T>(name)`).
 *
 * The database lives at ~/.hive/data/hivedb (or ~/.hive-dev/data/hivedb in
 * dev).
 */

import path from "node:path";
import { HiveDB } from "@johpaz/hive-db";
import { getHiveDir, loadConfig } from "../config/loader";
import { logger } from "../utils/logger";

const log = logger.child("hivedb");

let db: HiveDB | null = null;
let opening: Promise<HiveDB> | null = null;

export function getHiveDbPath(): string {
  // Tests can point the database at an ephemeral (":memory:") instance.
  if (process.env.HIVE_DB_PATH) return process.env.HIVE_DB_PATH;
  return path.join(getHiveDir(), "data", "hivedb");
}

/**
 * ¿Se abre la base con el embedder local (búsqueda por significado)?
 *
 * Es una decisión por base: ligarla a un modelo (`spaceId`) es permanente, y
 * abrirla después sin él, o con otro, falla con VECTOR_SPACE_MISMATCH. La primera
 * apertura descarga el modelo (~470 MB). `HIVE_EMBEDDER=local` fuerza el valor.
 */
export function embedderEnabled(): boolean {
  const env = process.env.HIVE_EMBEDDER;
  if (env) return env === "local";
  return loadConfig().memory?.embedder === "local";
}

/**
 * Get the shared HiveDB instance, opening it on first use.
 * Concurrent callers share the same open() promise.
 */
export async function getHiveDb(): Promise<HiveDB> {
  if (db) return db;
  if (!opening) {
    const dbPath = getHiveDbPath();
    opening = HiveDB.open(dbPath, embedderEnabled() ? { embedder: "local" } : undefined).then((opened) => {
      db = opened;
      log.info(`[hivedb] Opened at ${dbPath}`);
      return opened;
    });
    opening.catch(() => {
      opening = null;
    });
  }
  return opening;
}

/**
 * Return the currently open database without opening one.
 * Used by lifecycle-aware consumers that need to invalidate state after a
 * close/reopen cycle.
 */
export function getOpenHiveDb(): HiveDB | null {
  return db;
}

export function closeHiveDb(): void {
  if (db) {
    try {
      db.close();
    } catch (err) {
      log.warn(`[hivedb] Error closing database: ${(err as Error).message}`);
    }
    db = null;
    opening = null;
  }
}
