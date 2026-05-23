import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { createProviderRegistryFromEnv } from "../packages/providers/src/index.js";

type BackfillRow = {
  id: string;
  content: string;
  summary: string | null;
  tags: string[] | null;
};

const DEFAULT_LIMIT = 100;

async function main(): Promise<void> {
  await loadEnvFiles();

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for pnpm memory:embed:backfill.");
  }

  const force = process.argv.includes("--force");
  const dryRun = process.argv.includes("--dry-run");
  const limit = readLimit();
  const registry = createProviderRegistryFromEnv(process.env);
  const provider = registry.getEmbeddingProvider();
  const health = await provider.healthCheck();

  if (!health.available) {
    throw new Error(
      `Embedding provider is unavailable: ${health.message ?? "configure EMBEDDING_PROVIDER first."}`
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const rows = await listRows(pool, force, limit);
    console.log(
      `Found ${rows.length} memory row(s) ${force ? "eligible for re-embedding" : "missing embeddings"}.`
    );

    if (dryRun) {
      console.log("Dry run enabled; no rows were updated.");
      return;
    }

    let updated = 0;
    for (const row of rows) {
      const input = buildEmbeddingInput(row);
      if (!input) continue;
      const embedding = await provider.embedText(input);
      if (embedding.length !== provider.dimensions) {
        throw new Error(
          `Embedding dimension mismatch for ${row.id}: expected ${provider.dimensions}, got ${embedding.length}.`
        );
      }
      await pool.query(
        `
          update memories
          set embedding = $2::vector,
              embedding_provider = $3,
              embedding_model = $4,
              embedding_dimensions = $5,
              embedded_at = now(),
              updated_at = now()
          where id = $1
        `,
        [
          row.id,
          vectorLiteral(embedding),
          provider.name,
          provider.model ?? provider.name,
          provider.dimensions
        ]
      );
      updated += 1;
    }

    console.log(`Backfilled embeddings for ${updated} memory row(s).`);
  } finally {
    await pool.end();
  }
}

async function listRows(pool: Pool, force: boolean, limit: number): Promise<BackfillRow[]> {
  const result = await pool.query<BackfillRow>(
    `
      select id, content, summary, tags
      from memories
      where $1::boolean or embedding is null or embedded_at is null
      order by created_at asc
      limit $2
    `,
    [force, limit]
  );
  return result.rows;
}

function buildEmbeddingInput(row: BackfillRow): string {
  return [row.summary, row.content, ...(row.tags ?? []).map((tag) => `#${tag}`)]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n")
    .trim();
}

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

function readLimit(): number {
  const flag = process.argv.find((arg) => arg.startsWith("--limit="));
  if (!flag) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(flag.slice("--limit=".length), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;
}

async function loadEnvFiles(): Promise<void> {
  for (const file of [".env", ".env.local"]) {
    try {
      const text = await readFile(file, "utf8");
      for (const [key, value] of parseDotEnv(text)) {
        process.env[key] = value;
      }
      console.log(`[env] Loaded ${file}`);
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
  for (const line of text.split(/\r?\n/)) {
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

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
