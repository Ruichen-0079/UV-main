import { readFile } from "node:fs/promises";
import {
  MemoryMaintenanceService,
  createMemoryRepositoryFromEnv,
  type MemoryMaintenanceOptions,
  type MemoryScope
} from "../packages/memory/src/index.js";

const DEFAULT_LIMIT = 100;

async function main(): Promise<void> {
  await loadEnvFiles();
  const options = parseArgs(process.argv.slice(2));
  const repository = createMemoryRepositoryFromEnv(process.env);
  const service = new MemoryMaintenanceService(repository);

  try {
    console.log(
      `Memory maintenance repository=${repository.kind} dryRun=${String(options.dryRun)} limit=${options.limit ?? DEFAULT_LIMIT}`
    );
    if (options.scope) {
      console.log(`Scope ${options.scope}${options.scopeId ? `:${options.scopeId}` : ""}`);
    }

    const summary = await service.run(options);
    for (const warning of summary.warnings) {
      console.warn(
        `warning kind=${warning.kind} memoryId=${warning.memoryId} relatedId=${warning.relatedId ?? "none"} fixed=${String(Boolean(warning.fixed))}`
      );
    }
    console.log(
      `Summary scanned=${summary.scanned} expired=${summary.expired} stale=${summary.stale} supersessionWarnings=${summary.supersessionWarnings} skipped=${summary.skipped} failed=${summary.failed}`
    );
    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await repository.close?.();
  }
}

function parseArgs(args: string[]): MemoryMaintenanceOptions {
  const options: MemoryMaintenanceOptions = {
    dryRun: false,
    limit: DEFAULT_LIMIT
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--include-archived") options.includeArchived = true;
    else if (arg === "--include-superseded") options.includeSuperseded = true;
    else if (arg === "--limit") options.limit = parsePositiveInteger(args[++index], DEFAULT_LIMIT);
    else if (arg.startsWith("--limit=")) {
      options.limit = parsePositiveInteger(arg.slice("--limit=".length), DEFAULT_LIMIT);
    } else if (arg === "--scope") options.scope = parseScope(args[++index]);
    else if (arg.startsWith("--scope=")) options.scope = parseScope(arg.slice("--scope=".length));
    else if (arg === "--scopeId") options.scopeId = args[++index];
    else if (arg.startsWith("--scopeId=")) options.scopeId = arg.slice("--scopeId=".length);
    else if (arg === "--now") options.now = args[++index];
    else if (arg.startsWith("--now=")) options.now = arg.slice("--now=".length);
    else throw new Error(`Unsupported option '${arg}'.`);
  }

  return options;
}

function parseScope(value: string | undefined): MemoryScope {
  if (
    value === "user" ||
    value === "project" ||
    value === "agent" ||
    value === "plugin" ||
    value === "session"
  ) {
    return value;
  }
  throw new Error("Unsupported --scope. Valid values: user, project, agent, plugin, session.");
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
