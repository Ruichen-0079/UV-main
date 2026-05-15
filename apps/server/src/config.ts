export type ServerConfig = {
  host: string;
  port: number;
  logLevel: string;
  runtimeMode: "development" | "test" | "production";
};

export function loadServerConfig(
  env: Record<string, string | undefined> = process.env
): ServerConfig {
  return {
    host: env["SERVER_HOST"] ?? "127.0.0.1",
    port: Number.parseInt(env["SERVER_PORT"] ?? "6121", 10),
    logLevel: env["LOG_LEVEL"] ?? "info",
    runtimeMode: parseRuntimeMode(env["RUNTIME_MODE"] ?? env["NODE_ENV"])
  };
}

function parseRuntimeMode(value: string | undefined): "development" | "test" | "production" {
  if (value === "production" || value === "test" || value === "development") {
    return value;
  }

  return "development";
}
