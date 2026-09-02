import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import type { PoolClient } from "pg";

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

/**
 * Lazily built: top-level module code runs at build time, and `next build` must
 * not need a reachable database.
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // A VPS-local Postgres does not need many connections for this workload.
      max: 5,
    });
  }
  return pool;
}

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Applies schema.sql once per process. Every statement is `IF NOT EXISTS`, so
 * this doubles as the migration step — no separate tool for a schema this size.
 */
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const file = path.join(process.cwd(), "src/schema.sql");
      const sql = await readFile(file, "utf8");
      await getPool().query(sql);
    })().catch((error) => {
      // Let the next caller retry rather than caching a failure forever.
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

/**
 * Runs `fn` inside BEGIN/COMMIT, rolling back on any thrown error. The
 * connection is always released back to the pool, success or failure.
 */
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
