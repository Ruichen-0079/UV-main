export type ServerConfig = {
  host: string;
  port: number;
  logLevel: string;
};

export function loadServerConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return {
    host: env["SERVER_HOST"] ?? "127.0.0.1",
    port: Number.parseInt(env["SERVER_PORT"] ?? "3000", 10),
    logLevel: env["LOG_LEVEL"] ?? "info"
  };
}
