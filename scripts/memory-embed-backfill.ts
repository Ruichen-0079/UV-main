import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { createProviderRegistryFromEnv } from "../packages/providers/src/index.js";

type BackfillRow = {
  id: string;
  content: string;
  summary: string | null;
  tags: string[] | null;
  scope: string;
  scope_id: string | null;
  status: string;
  embedding: unknown | null;
  embedded_at: Date | null;
};

type BackfillOptions = {
  dryRun: boolean;
  limit: number;
  force: boolean;
  missingOnly: boolean;
  scope?: string;
  scopeId?: string;
  status?: string;
};

type BackfillSummary = {
  scanned: number;
  skipped: number;
  embedded: number;
  failed: number;
};

const DEFAULT_LIMIT = 100;

async function main(): Promise<void> {
  await loadEnvFiles();
  const options = parseArgs(process.argv.slice(2));

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for pnpm memory:embed:backfill.");
  }

  const registry = createProviderRegistryFromEnv(process.env);
  const provider = registry.getEmbeddingProvider();
  const health = await provider.healthCheck();

  if (!health.available) {
    throw new Error(
      `Embedding provider is unavailable: ${health.message ?? "configure EMBEDDING_PROVIDER first."}`
    );
  }

  console.log(
    `Embedding backfill provider=${provider.name} model=${provider.model ?? provider.name} dimensions=${provider.dimensions} semanticEmbedding=${String(!provider.mock)}`
  );
  console.log(
    `Options dryRun=${String(options.dryRun)} force=${String(options.force)} missingOnly=${String(options.missingOnly)} limit=${options.limit}`
  );

  const pool = new Pool({ connectionString: databaseUrl });
  const summary: BackfillSummary = { scanned: 0, skipped: 0, embedded: 0, failed: 0 };

  try {
    const rows = await listRows(pool, options);
    summary.scanned = rows.length;
    console.log(`Scanned ${rows.length} memory row(s).`);

    for (const [index, row] of rows.entries()) {
      const prefix = `[${index + 1}/${rows.length}] ${row.id}`;
      if (!options.force && hasStoredEmbedding(row)) {
        summary.skipped += 1;
        console.log(`${prefix} skipped: already embedded.`);
        continue;
      }

      const input = buildEmbeddingInput(row);
      if (!input) {
        summary.skipped += 1;
        console.log(`${prefix} skipped: empty embedding input.`);
        continue;
      }

      if (options.dryRun) {
        summary.skipped += 1;
        console.log(`${prefix} dry-run: would embed.`);
        continue;
      }

      try {
        const embedding = await provider.embedText(input);
        if (embedding.length !== provider.dimensions) {
          summary.failed += 1;
          console.error(
            `${prefix} failed: dimension mismatch expectedDimensions=${provider.dimensions} actualDimensions=${embedding.length} provider=${provider.name} model=${provider.model ?? provider.name}`
          );
          continue;
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
        summary.embedded += 1;
        console.log(`${prefix} embedded.`);
      } catch (error) {
        summary.failed += 1;
        console.error(`${prefix} failed: ${safeErrorMessage(error)}`);
      }
    }
  } finally {
    await pool.end();
  }

  console.log(
    `Summary scanned=${summary.scanned} skipped=${summary.skipped} embedded=${summary.embedded} failed=${summary.failed}`
  );

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

async function listRows(pool: Pool, options: BackfillOptions): Promise<BackfillRow[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.missingOnly && !options.force) {
    clauses.push("(embedding is null or embedded_at is null)");
  }
  if (options.scope) {
    values.push(options.scope);
    clauses.push(`scope = $${values.length}`);
  }
  if (options.scopeId) {
    values.push(options.scopeId);
    clauses.push(`scope_id = $${values.length}`);
  }
  if (options.status) {
    values.push(options.status);
    clauses.push(`status = $${values.length}`);
  }

  values.push(options.limit);
  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  const result = await pool.query<BackfillRow>(
    `
      select id, content, summary, tags, scope, scope_id, status, embedding, embedded_at
      from memories
      ${where}
      order by created_at asc
      limit $${values.length}
    `,
    values
  );
  return result.rows;
}

function parseArgs(args: string[]): BackfillOptions {
  const options: BackfillOptions = {
    dryRun: false,
    limit: DEFAULT_LIMIT,
    force: false,
    missingOnly: true
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") {
      options.force = true;
      options.missingOnly = false;
    } else if (arg === "--missing-only") options.missingOnly = true;
    else if (arg === "--limit") options.limit = parsePositiveInteger(args[++index], DEFAULT_LIMIT);
    else if (arg.startsWith("--limit=")) {
      options.limit = parsePositiveInteger(arg.slice("--limit=".length), DEFAULT_LIMIT);
    } else if (arg === "--scope") options.scope = args[++index];
    else if (arg.startsWith("--scope=")) options.scope = arg.slice("--scope=".length);
    else if (arg === "--scopeId") options.scopeId = args[++index];
    else if (arg.startsWith("--scopeId=")) options.scopeId = arg.slice("--scopeId=".length);
    else if (arg === "--status") options.status = args[++index];
    else if (arg.startsWith("--status=")) options.status = arg.slice("--status=".length);
    else throw new Error(`Unsupported option '${arg}'.`);
  }

  return options;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hasStoredEmbedding(row: BackfillRow): boolean {
  return Boolean(row.embedding || row.embedded_at);
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
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]").slice(0, 300);
}

try {
  await main();
} catch (error) {
  console.error(safeErrorMessage(error));
  process.exitCode = 1;
}
