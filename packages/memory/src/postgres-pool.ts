import { Pool } from "pg";
import { normalizePostgresConnectionString } from "./postgres-connection.js";

/**
 * YUVI is a single-user desktop application, not a multi-tenant server.
 * Keep the default pool bounded across the several repository facades that
 * may share or own a PostgreSQL client.
 */
export const YUVI_POSTGRES_POOL_MAX = 4;
export const YUVI_POSTGRES_IDLE_TIMEOUT_MS = 10_000;

export function createYuviPostgresPool(connectionString: string): Pool {
  return new Pool({
    connectionString: normalizePostgresConnectionString(connectionString),
    max: YUVI_POSTGRES_POOL_MAX,
    idleTimeoutMillis: YUVI_POSTGRES_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: 10_000
  });
}
