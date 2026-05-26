import { readFile } from "node:fs/promises";
import { Pool } from "pg";

async function main(): Promise<void> {
  await loadEnvFiles();
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl?.trim()) {
    throw new Error("DATABASE_URL is required for memory index status.");
  }

  const pool = new Pool({ connectionString: databaseUrl });
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

async function loadEnvFiles(): Promise<void> {
  for (const file of [".env", ".env.local"]) {
    try {
      const text = await readFile(file, "utf8");
      for (const [key, value] of parseDotEnv(text)) {
        process.env[key] = value;
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
}

function parseDotEnv(text: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.push([key, value]);
  }
  return entries;
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
