import { afterEach, describe, expect, it } from "vitest";
import {
  createYuviPostgresPool,
  YUVI_POSTGRES_IDLE_TIMEOUT_MS,
  YUVI_POSTGRES_POOL_MAX
} from "./postgres-pool.js";
import { normalizePostgresConnectionString } from "./postgres-connection.js";

describe("createYuviPostgresPool", () => {
  const pools: ReturnType<typeof createYuviPostgresPool>[] = [];

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it("bounds idle single-user connections", () => {
    const pool = createYuviPostgresPool("postgres://yuvi:secret@localhost:5432/yuvi");
    pools.push(pool);

    const options = (pool as unknown as { options: Record<string, unknown> }).options;
    expect(options["max"]).toBe(YUVI_POSTGRES_POOL_MAX);
    expect(options["idleTimeoutMillis"]).toBe(YUVI_POSTGRES_IDLE_TIMEOUT_MS);
    expect(options["connectionTimeoutMillis"]).toBe(10_000);
    expect(options["connectionString"]).toBe(
      normalizePostgresConnectionString("postgres://yuvi:secret@localhost:5432/yuvi")
    );
  });
});
