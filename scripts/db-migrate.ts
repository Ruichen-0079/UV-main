import { readFile } from "node:fs/promises";
import {
  MissingDatabaseUrlError,
  readSqlMigrations,
  resolveDatabaseUrl,
  runPostgresMigrations
} from "../packages/memory/src/migrations.js";

async function main(): Promise<void> {
  const envFileText = await readLocalEnvFile();
  const databaseUrl = resolveDatabaseUrl(process.env, envFileText);
  const migrations = await readSqlMigrations();

  if (migrations.length === 0) {
    throw new Error("No SQL migration files found in packages/memory/migrations.");
  }

  console.log(`Running ${migrations.length} PostgreSQL memory migration(s).`);
  await runPostgresMigrations({
    databaseUrl,
    migrations,
    logger: console
  });
  console.log("PostgreSQL memory migrations completed.");
}

async function readLocalEnvFile(): Promise<string | undefined> {
  try {
    return await readFile(".env", "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
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
