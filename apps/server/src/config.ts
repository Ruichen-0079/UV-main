export type ServerConfig = {
  host: string;
  port: number;
  logLevel: string;
  runtimeMode: "development" | "test" | "production";
  eventBus: "in-memory" | "nats";
  memoryExtractor: "rule-based" | "llm";
  directContext: {
    enabled: boolean;
    maxTurns: number;
    maxChars: number;
  };
  memoryMaintenance: {
    enabled: boolean;
    runOnStartup: boolean;
    intervalMinutes: number;
    limit: number;
  };
  dashboardDevToken?: string | undefined;
};

export function loadServerConfig(
  env: Record<string, string | undefined> = process.env
): ServerConfig {
  return {
    host: env["SERVER_HOST"] ?? "127.0.0.1",
    port: Number.parseInt(env["SERVER_PORT"] ?? "6121", 10),
    logLevel: env["LOG_LEVEL"] ?? "info",
    runtimeMode: parseRuntimeMode(env["RUNTIME_MODE"] ?? env["NODE_ENV"]),
    eventBus: parseEventBus(env["EVENT_BUS"] ?? env["EVENT_BUS_DRIVER"]),
    memoryExtractor: parseMemoryExtractor(env["MEMORY_EXTRACTOR"]),
    directContext: {
      enabled: parseBoolean(env["DIRECT_CONTEXT_ENABLED"], true),
      maxTurns: parsePositiveInteger(env["DIRECT_CONTEXT_MAX_TURNS"], 6),
      maxChars: parsePositiveInteger(env["DIRECT_CONTEXT_MAX_CHARS"], 6000)
    },
    memoryMaintenance: {
      enabled: parseBoolean(env["MEMORY_MAINTENANCE_ENABLED"], false),
      runOnStartup: parseBoolean(env["MEMORY_MAINTENANCE_RUN_ON_STARTUP"], false),
      intervalMinutes: parsePositiveInteger(env["MEMORY_MAINTENANCE_INTERVAL_MINUTES"], 0),
      limit: parseStrictPositiveInteger(env["MEMORY_MAINTENANCE_LIMIT"], 500)
    },
    dashboardDevToken: emptyToUndefined(env["DASHBOARD_DEV_TOKEN"])
  };
}

function parseRuntimeMode(value: string | undefined): "development" | "test" | "production" {
  if (value === "production" || value === "test" || value === "development") {
    return value;
  }

  return "development";
}

function parseEventBus(value: string | undefined): "in-memory" | "nats" {
  if (!value || value === "in-memory" || value === "memory") {
    return "in-memory";
  }
  if (value === "nats") {
    return "nats";
  }

  throw new Error(`Unsupported EVENT_BUS '${value}'. Supported values: in-memory, nats.`);
}

function parseMemoryExtractor(value: string | undefined): "rule-based" | "llm" {
  if (!value || value === "llm") {
    return "llm";
  }
  if (value === "rule-based") {
    return "rule-based";
  }

  throw new Error(`Unsupported MEMORY_EXTRACTOR '${value}'. Supported values: rule-based, llm.`);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  return value === "true" || value === "1" || value === "yes";
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseStrictPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
