export type ServerConfig = {
  host: string;
  port: number;
  logLevel: string;
  runtimeMode: "development" | "test" | "production";
  eventBus: "in-memory" | "nats";
  memoryExtractor: "rule-based" | "llm";
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
