import { MigrationError, migrateYuviSchema, type MigrationDiagnostics } from "@companion/memory";
import {
  PRIVATE_POSTGRES_DATABASE,
  PRIVATE_POSTGRES_HOST,
  PRIVATE_POSTGRES_USER
} from "./postgres-layout.js";
import type { SupervisorConfig } from "./types.js";

export type SupervisorMigrateInput = {
  databaseUrl: string;
  migrationsDir?: string | undefined;
  settings?: Record<string, string | undefined> | undefined;
  logger?: Pick<Console, "log"> | undefined;
};

export type SupervisorMigrateResult = {
  ok: boolean;
  schemaReady: boolean;
  diagnostics: MigrationDiagnostics;
};

export type SupervisorMigrationTarget =
  | {
      kind: "private";
      host: string;
      port: number;
      user: string;
      database: string;
      password: string;
    }
  | {
      kind: "external";
      databaseUrl: string;
    };

export function resolveSupervisorMigrationTarget(
  config: SupervisorConfig,
  privatePassword: string | null
): SupervisorMigrationTarget | null {
  const mode = config.postgresMode ?? "external";
  if (mode === "private") {
    const port = config.postgresListenPort;
    if (!port || !privatePassword) return null;
    return {
      kind: "private",
      host: PRIVATE_POSTGRES_HOST,
      port,
      user: PRIVATE_POSTGRES_USER,
      database: PRIVATE_POSTGRES_DATABASE,
      password: privatePassword
    };
  }
  const databaseUrl = config.databaseUrl?.trim();
  if (!databaseUrl) return null;
  return { kind: "external", databaseUrl };
}

export function buildPrivateDatabaseUrl(target: {
  host: string;
  port: number;
  user: string;
  database: string;
  password: string;
}): string {
  const user = encodeURIComponent(target.user);
  const password = encodeURIComponent(target.password);
  return `postgres://${user}:${password}@${target.host}:${target.port}/${target.database}`;
}

export async function migrateSupervisorPostgres(
  input: SupervisorMigrateInput
): Promise<SupervisorMigrateResult> {
  const result = await migrateYuviSchema({
    databaseUrl: input.databaseUrl,
    migrationsDir: input.migrationsDir,
    settings: input.settings,
    logger: input.logger
  });
  if (!result.diagnostics.schemaReady) {
    throw new MigrationError(
      result.diagnostics.lastErrorCode ?? "SCHEMA_POSTCONDITION_FAILED",
      "Yuvi schema postconditions were not met."
    );
  }
  return {
    ok: true,
    schemaReady: true,
    diagnostics: result.diagnostics
  };
}

export async function migrateSupervisorTarget(
  target: SupervisorMigrationTarget,
  options: Omit<SupervisorMigrateInput, "databaseUrl"> = {}
): Promise<SupervisorMigrateResult> {
  const databaseUrl =
    target.kind === "private" ? buildPrivateDatabaseUrl(target) : target.databaseUrl;
  return migrateSupervisorPostgres({
    databaseUrl,
    migrationsDir: options.migrationsDir,
    settings: options.settings,
    logger: options.logger
  });
}

export function migrationSettingsFromEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  return {
    "yuvi.memory_vector_index_enabled": env["MEMORY_VECTOR_INDEX_ENABLED"] ?? "true",
    "yuvi.memory_vector_index_type": env["MEMORY_VECTOR_INDEX_TYPE"] ?? "hnsw",
    "yuvi.memory_vector_distance": env["MEMORY_VECTOR_DISTANCE"] ?? "cosine",
    "yuvi.memory_vector_dimensions": env["EMBEDDING_DIMENSIONS"] ?? "1536"
  };
}
