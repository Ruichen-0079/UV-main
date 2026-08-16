/**
 * Frontend reducer for desktop service status.
 * Does not start processes — only reflects supervisor snapshots / events.
 */

export type ServiceLifecycle =
  | "starting"
  | "healthy"
  | "degraded"
  | "unavailable"
  | "stopped"
  | "restarting";

export type ServiceOwnership = "owned" | "external" | "none";

export type UiServiceId =
  | "runtime"
  | "mem0"
  | "ollama"
  | "postgres"
  | "tts_wrapper"
  | "tts_upstream";

export type UiServiceSnapshot = {
  id: UiServiceId;
  label: string;
  status: ServiceLifecycle;
  ownership: ServiceOwnership;
  url: string | null;
  summary: string;
  detail: string | null;
  lastError: string | null;
  managed: boolean;
  canRestart: boolean;
  canStop: boolean;
  checkedAt: string;
};

export type ServiceStatusState = {
  ready: boolean;
  connected: boolean;
  shuttingDown: boolean;
  instanceId: string | null;
  services: UiServiceSnapshot[];
  updatedAt: string | null;
  lastError: string | null;
};

export type ServiceStatusAction =
  | { type: "reset" }
  | { type: "supervisor-connected"; instanceId: string }
  | { type: "supervisor-disconnected"; error?: string }
  | {
      type: "snapshot";
      instanceId: string;
      shuttingDown: boolean;
      services: UiServiceSnapshot[];
      updatedAt: string;
    }
  | { type: "local-error"; error: string };

const SERVICE_IDS: readonly UiServiceId[] = [
  "runtime",
  "mem0",
  "ollama",
  "postgres",
  "tts_wrapper",
  "tts_upstream"
];

const SERVICE_LIFECYCLES: readonly ServiceLifecycle[] = [
  "starting",
  "healthy",
  "degraded",
  "unavailable",
  "stopped",
  "restarting"
];

const SERVICE_OWNERSHIPS: readonly ServiceOwnership[] = ["owned", "external", "none"];

export const initialServiceStatusState: ServiceStatusState = {
  ready: false,
  connected: false,
  shuttingDown: false,
  instanceId: null,
  services: [],
  updatedAt: null,
  lastError: null
};

/** Validate supervisor service records before they can reach UI projection code. */
export function normalizeUiServiceSnapshot(value: unknown): UiServiceSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = record["id"];
  const status = record["status"];
  const ownership = record["ownership"];
  if (
    !isOneOf(id, SERVICE_IDS) ||
    !isOneOf(status, SERVICE_LIFECYCLES) ||
    !isOneOf(ownership, SERVICE_OWNERSHIPS)
  ) {
    return null;
  }
  return {
    id,
    label: stringOr(record["label"], id),
    status,
    ownership,
    url: nullableString(record["url"]),
    summary: stringOr(record["summary"], ""),
    detail: nullableString(record["detail"]),
    lastError: nullableString(record["lastError"]),
    managed: typeof record["managed"] === "boolean" ? record["managed"] : ownership === "owned",
    canRestart: record["canRestart"] === true,
    canStop: record["canStop"] === true,
    checkedAt: stringOr(record["checkedAt"], "")
  };
}

export function normalizeUiServiceSnapshots(value: unknown): UiServiceSnapshot[] | null {
  if (!Array.isArray(value)) return null;
  const result: UiServiceSnapshot[] = [];
  for (const item of value) {
    const normalized = normalizeUiServiceSnapshot(item);
    if (!normalized) return null;
    result.push(normalized);
  }
  return result;
}

/** Compare UI-relevant service fields; ignore checkedAt/updatedAt clock churn. */
export function servicesUiEqual(a: UiServiceSnapshot[], b: UiServiceSnapshot[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.id !== right.id ||
      left.status !== right.status ||
      left.ownership !== right.ownership ||
      left.summary !== right.summary ||
      left.detail !== right.detail ||
      left.lastError !== right.lastError ||
      left.url !== right.url ||
      left.managed !== right.managed ||
      left.canRestart !== right.canRestart ||
      left.canStop !== right.canStop ||
      left.label !== right.label
    ) {
      return false;
    }
  }
  return true;
}

export function reduceServiceStatus(
  state: ServiceStatusState,
  action: ServiceStatusAction
): ServiceStatusState {
  switch (action.type) {
    case "reset":
      return { ...initialServiceStatusState };
    case "supervisor-connected":
      if (state.connected && state.instanceId === action.instanceId && !state.lastError) {
        return state;
      }
      if (state.instanceId !== null && state.connected && state.instanceId !== action.instanceId) {
        // A snapshot carrying a replacement instance establishes the new
        // connection. The snapshot itself is admitted below only when its
        // timestamp is newer than the current instance, so a late poll from
        // the retired instance cannot roll the reducer backwards.
        return state;
      }
      if (state.instanceId !== null && state.instanceId !== action.instanceId) {
        return {
          ...state,
          ready: true,
          connected: true,
          instanceId: action.instanceId,
          services: [],
          shuttingDown: false,
          updatedAt: null,
          lastError: null
        };
      }
      return {
        ...state,
        ready: true,
        connected: true,
        instanceId: action.instanceId,
        lastError: null
      };
    case "supervisor-disconnected":
      return {
        ...state,
        connected: false,
        lastError: action.error ?? state.lastError
      };
    case "snapshot": {
      // A late response from a previous supervisor instance must not replace
      // the current instance. A snapshot after transport loss also requires
      // a fresh supervisor-connected edge first.
      if (state.instanceId !== null && !state.connected) {
        return state;
      }
      if (
        state.instanceId !== null &&
        state.instanceId !== action.instanceId &&
        !isNewerSnapshot(state.updatedAt, action.updatedAt)
      ) {
        return state;
      }
      if (isOlderSnapshot(state.updatedAt, action.updatedAt)) return state;
      if (
        state.connected &&
        state.instanceId === action.instanceId &&
        state.shuttingDown === action.shuttingDown &&
        state.lastError === null &&
        servicesUiEqual(state.services, action.services)
      ) {
        // Same UI-visible snapshot — skip re-render (updatedAt alone is noise).
        return state;
      }
      return {
        ...state,
        ready: true,
        connected: true,
        instanceId: action.instanceId,
        shuttingDown: action.shuttingDown,
        services: action.services,
        updatedAt: action.updatedAt,
        lastError: null
      };
    }
    case "local-error":
      if (state.lastError === action.error) return state;
      return { ...state, lastError: action.error };
    default:
      return state;
  }
}

function isOlderSnapshot(current: string | null, incoming: string): boolean {
  if (!current) return false;
  const currentTime = Date.parse(current);
  const incomingTime = Date.parse(incoming);
  if (!Number.isFinite(currentTime) || !Number.isFinite(incomingTime)) return false;
  return incomingTime <= currentTime;
}

function isNewerSnapshot(current: string | null, incoming: string): boolean {
  if (!current) return true;
  const currentTime = Date.parse(current);
  const incomingTime = Date.parse(incoming);
  if (!Number.isFinite(currentTime) || !Number.isFinite(incomingTime)) return false;
  return incomingTime > currentTime;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : typeof value === "string" ? value : null;
}

/** Primary cards shown in the compact panel (merge TTS upstream into TTS). */
export function selectPrimaryServices(services: UiServiceSnapshot[]): UiServiceSnapshot[] {
  const byId = new Map(services.map((s) => [s.id, s]));
  const order: UiServiceId[] = ["runtime", "mem0", "ollama", "postgres", "tts_wrapper"];
  const result: UiServiceSnapshot[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item) result.push(item);
  }
  return result;
}

export function runtimeChatAvailability(services: UiServiceSnapshot[]): {
  available: boolean;
  reason: string | null;
} {
  const runtime = services.find((s) => s.id === "runtime");
  if (!runtime) return { available: false, reason: "Runtime status unknown." };
  if (runtime.status === "healthy" || runtime.status === "degraded") {
    return { available: true, reason: null };
  }
  return {
    available: false,
    reason: runtime.summary || "Runtime is unavailable."
  };
}
