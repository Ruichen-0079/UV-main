import { applyRuntimeEnv, readRuntimeEnvFiles } from "../packages/config/src/index.js";
import {
  MigrationError,
  MissingDatabaseUrlError,
  loadMigrationRegistry,
  migrateYuviSchema
} from "../packages/memory/src/migrations.js";

async function main(): Promise<void> {
  const runtimeEnvFiles = await readRuntimeEnvFiles();
  applyRuntimeEnv(runtimeEnvFiles.env);
  logLoadedEnvFiles(runtimeEnvFiles);

  const databaseUrl = runtimeEnvFiles.env["DATABASE_URL"];
  if (!databaseUrl?.trim()) {
    throw new MissingDatabaseUrlError();
  }
  const registry = await loadMigrationRegistry();
  if (registry.length === 0) {
    throw new Error("No SQL migration files found in packages/memory/migrations.");
  }

  console.log(`Running ${registry.length} PostgreSQL memory migration(s).`);
  const result = await migrateYuviSchema({
    databaseUrl,
    settings: {
      "yuvi.memory_vector_index_enabled":
        runtimeEnvFiles.env["MEMORY_VECTOR_INDEX_ENABLED"] ?? "true",
      "yuvi.memory_vector_index_type": runtimeEnvFiles.env["MEMORY_VECTOR_INDEX_TYPE"] ?? "hnsw",
      "yuvi.memory_vector_distance": runtimeEnvFiles.env["MEMORY_VECTOR_DISTANCE"] ?? "cosine",
      "yuvi.memory_vector_dimensions": runtimeEnvFiles.env["EMBEDDING_DIMENSIONS"] ?? "1536"
    },
    logger: console
  });
  console.log(
    `schemaReady=${result.diagnostics.schemaReady} memorySearch=${result.diagnostics.memorySearch.status}`
  );
  if (result.diagnostics.memorySearch.status === "failed") {
    const failed = result.diagnostics.memorySearch.failedMigration ?? "unknown";
    const code = result.diagnostics.memorySearch.errorCode ?? "MIGRATION_FAILED";
    console.error(`${code}: optional memory-search migration failed: ${failed}`);
    process.exitCode = 1;
    return;
  }
  if (result.diagnostics.memorySearch.status === "unavailable") {
    console.log("Core schema is ready. Optional memory-search track is unavailable.");
  }
  console.log("PostgreSQL memory migrations completed.");
}

function logLoadedEnvFiles(runtimeEnvFiles: Awaited<ReturnType<typeof readRuntimeEnvFiles>>): void {
  console.log(`[env] runtimeEnvDir=${runtimeEnvFiles.runtimeEnvDir}`);
  for (const [label, file] of [
    [".env", runtimeEnvFiles.base],
    [".env.local", runtimeEnvFiles.local]
  ] as const) {
    if (file.exists) {
      console.log(`[env] Loaded ${label}: keys=${Object.keys(file.values).sort().join(",")}`);
    }
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof MissingDatabaseUrlError) {
    console.error(
      "DATABASE_URL is missing. Copy .env.example to .env or export DATABASE_URL before running pnpm db:migrate."
    );
    process.exitCode = 1;
  } else if (error instanceof MigrationError) {
    console.error(`${error.code}: ${error.message}`);
    process.exitCode = 1;
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
