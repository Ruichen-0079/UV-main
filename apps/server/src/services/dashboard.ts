import type { RuntimeEvent } from "@companion/protocol";
import { sanitizeUrlUserinfo } from "../runtime-settings.js";

export class DashboardStateService {
  private readonly events: RuntimeEvent[] = [];

  recordEvent(event: RuntimeEvent): void {
    this.events.unshift(redactEvent(event));
    if (this.events.length > 200) {
      this.events.length = 200;
    }
  }

  listRecentEvents(limit = 50): RuntimeEvent[] {
    return this.events.slice(0, limit);
  }
}

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        result[key] = "[redacted]";
        continue;
      }
      result[key] =
        isUrlKey(key) && typeof nested === "string"
          ? sanitizeUrlUserinfo(nested)
          : redactValue(nested);
    }
    return result;
  }

  return value;
}

function redactEvent(event: RuntimeEvent): RuntimeEvent {
  return {
    ...event,
    payload: redactValue(event.payload)
  };
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("apikey") ||
    normalized.includes("api_key") ||
    normalized.includes("authorization") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password")
  );
}

function isUrlKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === "url" || normalized.endsWith("url") || normalized.includes("baseurl");
}
