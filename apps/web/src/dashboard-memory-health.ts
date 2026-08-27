import type { HealthResponse } from "./api/client.js";

export function memoryModeFromHealth(health: HealthResponse | null): string {
  const message = health?.database.message?.toLowerCase() ?? "";
  if (message.includes("in-memory")) {
    return "in-memory";
  }
  if (health?.database.status === "healthy" && !message.includes("in-memory")) {
    return "postgres";
  }
  return "unknown";
}
