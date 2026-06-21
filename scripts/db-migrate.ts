import { applyRuntimeEnv, readRuntimeEnvFiles } from "../packages/config/src/index.js";
import {
  MissingDatabaseUrlError,
  readSqlMigrations,
  runPostgresMigrations
} from "../packages/memory/src/migrations.js";

async function main(): Promise<void> {
  const runtimeEnvFiles = await readRuntimeEnvFiles();
  applyRuntimeEnv(runtimeEnvFiles.env);
  logLoadedEnvFiles(runtimeEnvFiles);

  const databaseUrl = runtimeEnvFiles.env["DATABASE_URL"];
  if (!databaseUrl?.trim()) {
    throw new MissingDatabaseUrlError();
  }
  const migrations = await readSqlMigrations();

  if (migrations.length === 0) {
    throw new Error("No SQL migration files found in packages/memory/migrations.");
  }

  console.log(`Running ${migrations.length} PostgreSQL memory migration(s).`);
  await runPostgresMigrations({
    databaseUrl,
    migrations,
    settings: {
      "yuvi.memory_vector_index_enabled":
        runtimeEnvFiles.env["MEMORY_VECTOR_INDEX_ENABLED"] ?? "true",
      "yuvi.memory_vector_index_type": runtimeEnvFiles.env["MEMORY_VECTOR_INDEX_TYPE"] ?? "hnsw",
      "yuvi.memory_vector_distance": runtimeEnvFiles.env["MEMORY_VECTOR_DISTANCE"] ?? "cosine",
      "yuvi.memory_vector_dimensions": runtimeEnvFiles.env["EMBEDDING_DIMENSIONS"] ?? "1536"
    },
    logger: console
  });
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
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
