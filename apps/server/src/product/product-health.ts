import type { ProviderHealth, ProviderObservedState, ProviderReadinessState } from "@companion/providers";
import type { MemoryRetrievalStatus } from "@companion/memory";

export const ProductConnectionStates = [
  "ready",
  "connecting",
  "unavailable",
  "misconfigured",
  "error",
  "disabled"
] as const;
export type ProductConnectionState = (typeof ProductConnectionStates)[number];

export type ProductHealthTone = "ok" | "warn" | "bad" | "idle";

export type ProductHealthItem = {
  id: string;
  label: string;
  state: ProductConnectionState;
  tone: ProductHealthTone;
  summary: string;
  detail?: string | undefined;
  epistemic?: MemoryRetrievalStatus | undefined;
};

export function mapProviderHealth(input: {
  id: string;
  label: string;
  health?: Pick<
    ProviderHealth,
    "readiness" | "observed" | "configured" | "mock" | "status" | "message" | "missingFields"
  >;
  enabled?: boolean;
}): ProductHealthItem {
  const health = input.health;
  if (input.enabled === false) {
    return {
      id: input.id,
      label: input.label,
      state: "disabled",
      tone: "idle",
      summary: "Disabled"
    };
  }
  if (!health) {
    return {
      id: input.id,
      label: input.label,
      state: "unavailable",
      tone: "warn",
      summary: "Unavailable"
    };
  }
  if (health.configured === false || (health.missingFields && health.missingFields.length > 0)) {
    return {
      id: input.id,
      label: input.label,
      state: "misconfigured",
      tone: "warn",
      summary: "Misconfigured",
      detail: health.message ?? missingFieldsMessage(health.missingFields)
    };
  }
  const readiness = (health.readiness ?? "not_ready") as ProviderReadinessState;
  const observed = (health.observed ?? "unknown") as ProviderObservedState;
  if (health.status === "unavailable" || observed === "unavailable") {
    return {
      id: input.id,
      label: input.label,
      state: "unavailable",
      tone: "bad",
      summary: "Unavailable",
      detail: health.message
    };
  }
  if (health.status === "degraded" || observed === "degraded") {
    return {
      id: input.id,
      label: input.label,
      state: "error",
      tone: "warn",
      summary: "Degraded",
      detail: health.message
    };
  }
  if (readiness === "ready") {
    return {
      id: input.id,
      label: input.label,
      state: "ready",
      tone: "ok",
      summary: health.mock ? "Ready (mock)" : "Ready",
      detail: health.message
    };
  }
  return {
    id: input.id,
    label: input.label,
    state: "connecting",
    tone: "warn",
    summary: "Not ready",
    detail: health.message
  };
}

export function mapMemoryEpistemic(status: MemoryRetrievalStatus | undefined): {
  state: ProductConnectionState;
  tone: ProductHealthTone;
  summary: string;
  epistemic: MemoryRetrievalStatus;
} {
  if (status === "unavailable") {
    return { state: "unavailable", tone: "warn", summary: "Unavailable", epistemic: "unavailable" };
  }
  if (status === "error") {
    return { state: "error", tone: "bad", summary: "Error", epistemic: "error" };
  }
  if (status === "partial") {
    return { state: "ready", tone: "warn", summary: "Partial", epistemic: "partial" };
  }
  if (status === "empty") {
    return { state: "ready", tone: "idle", summary: "Empty", epistemic: "empty" };
  }
  return { state: "ready", tone: "ok", summary: "Ready", epistemic: status ?? "ok" };
}

function missingFieldsMessage(fields: string[] | undefined): string | undefined {
  if (!fields || fields.length === 0) return undefined;
  return `Missing: ${fields.join(", ")}.`;
}
