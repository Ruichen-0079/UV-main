import { applyRuntimeEnv, readRuntimeEnvFiles } from "../packages/config/src/index.js";
import { normalizePostgresConnectionString } from "../packages/memory/src/index.js";
import { Pool } from "pg";

async function main(): Promise<void> {
  await loadRuntimeEnv();
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl?.trim()) {
    throw new Error("DATABASE_URL is required for memory index status.");
  }

  const pool = new Pool({
    connectionString: normalizePostgresConnectionString(databaseUrl),
    connectionTimeoutMillis: 10_000
  });
  try {
    const [indexes, counts] = await Promise.all([
      pool.query<{
        indexname: string;
        indexdef: string;
      }>(
        `select indexname, indexdef
         from pg_indexes
         where schemaname = current_schema()
           and tablename = 'memories'
           and indexdef ilike '%embedding%'
         order by indexname`
      ),
      pool.query<{
        embedding_count: string;
        missing_embedding_count: string;
        dimensions: number[] | null;
      }>(
        `select
           count(*) filter (where embedding is not null)::text as embedding_count,
           count(*) filter (where embedding is null)::text as missing_embedding_count,
           coalesce(
             array_agg(distinct embedding_dimensions order by embedding_dimensions)
               filter (where embedding_dimensions is not null),
             '{}'::integer[]
           ) as dimensions
         from memories`
      )
    ]);

    const countRow = counts.rows[0];
    console.log("Memory vector index status");
    console.log(`embeddingCount=${countRow?.embedding_count ?? "0"}`);
    console.log(`missingEmbeddingCount=${countRow?.missing_embedding_count ?? "0"}`);
    console.log(`vectorDimensions=${(countRow?.dimensions ?? []).join(",") || "none"}`);
    if (indexes.rows.length === 0) {
      console.log("annIndex=missing");
      return;
    }
    for (const index of indexes.rows) {
      const type = index.indexdef.includes("USING hnsw")
        ? "hnsw"
        : index.indexdef.includes("USING ivfflat")
          ? "ivfflat"
          : "btree/other";
      console.log(`index=${index.indexname} type=${type}`);
    }
  } finally {
    await pool.end();
  }
}

async function loadRuntimeEnv(): Promise<void> {
  const runtimeEnvFiles = await readRuntimeEnvFiles();
  applyRuntimeEnv(runtimeEnvFiles.env);
  for (const [label, file] of [
    [".env", runtimeEnvFiles.base],
    [".env.local", runtimeEnvFiles.local]
  ] as const) {
    if (file.exists) {
      console.log(`[env] Loaded ${label}: keys=${Object.keys(file.values).sort().join(",")}`);
    }
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/(DATABASE_URL|API_KEY|TOKEN|SECRET|PASSWORD)=([^\s]+)/giu, "$1=[REDACTED]")
    .slice(0, 300);
}

try {
  await main();
} catch (error) {
  console.error(safeErrorMessage(error));
  process.exitCode = 1;
}
