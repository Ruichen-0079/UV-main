/**
 * Bridge to the desktop supervisor.
 * In Tauri: invoke Rust commands (which proxy to the supervisor HTTP control plane).
 * Outside Tauri: optional env VITE_YUVI_SUPERVISOR_URL for local debugging only.
 */

import { isTauriRuntime } from "./tauri-window.js";
import {
  initialServiceStatusState,
  normalizeUiServiceSnapshots,
  reduceServiceStatus,
  type ServiceStatusState,
  type ServiceStatusAction
} from "./service-status-state.js";
import type { UiServiceSnapshot } from "./service-status-state.js";

export type SupervisorSnapshotDto = {
  instanceId: string;
  shuttingDown: boolean;
  services: UiServiceSnapshot[];
  updatedAt: string;
};

type StatusHandlers = {
  onSnapshot(snapshot: SupervisorSnapshotDto): void;
  onConnected(instanceId: string): void;
  onDisconnected(error?: string): void;
};

let debugSupervisorUrl: string | null =
  typeof import.meta !== "undefined" &&
  typeof (import.meta as { env?: Record<string, string> }).env?.["VITE_YUVI_SUPERVISOR_URL"] ===
    "string"
    ? (import.meta as { env?: Record<string, string> }).env!["VITE_YUVI_SUPERVISOR_URL"]!
    : null;

export function isServiceSupervisorAvailable(): boolean {
  return isTauriRuntime() || Boolean(debugSupervisorUrl);
}

/** Fallback poll when events are quiet. Prefer event-driven updates. */
const STATUS_FALLBACK_POLL_MS = 5_000;

export function subscribeServiceStatus(handlers: StatusHandlers): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unlisten: (() => void) | null = null;
  /** Skip redundant fallback poll briefly after a live event. */
  let lastEventAt = 0;

  const tick = async (source: "poll" | "event" | "boot") => {
    if (cancelled) return;
    if (source === "poll" && Date.now() - lastEventAt < STATUS_FALLBACK_POLL_MS - 250) {
      return;
    }
    try {
      const snapshot = await getServiceStatus();
      if (cancelled || !snapshot) return;
      handlers.onConnected(snapshot.instanceId);
      handlers.onSnapshot(snapshot);
    } catch (error) {
      if (cancelled) return;
      handlers.onDisconnected(error instanceof Error ? error.message : String(error));
    }
  };

  void tick("boot");
  // Low-frequency fallback only — live path is service.status.changed.
  timer = setInterval(() => {
    void tick("poll");
  }, STATUS_FALLBACK_POLL_MS);

  if (isTauriRuntime()) {
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        const remove = await listen<unknown>("service.status.changed", (event) => {
          if (cancelled) return;
          const snapshot = parseSupervisorSnapshot(event.payload);
          if (!snapshot) return;
          lastEventAt = Date.now();
          handlers.onConnected(snapshot.instanceId);
          handlers.onSnapshot(snapshot);
        });
        if (cancelled) {
          remove();
        } else {
          unlisten = remove;
        }
      } catch {
        // fall back to interval only
      }
    })();
  }

  return () => {
    cancelled = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}

export async function getServiceStatus(): Promise<SupervisorSnapshotDto | null> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return parseSupervisorSnapshot(await invoke<unknown>("get_service_status"));
  }
  if (debugSupervisorUrl) {
    const response = await fetch(`${debugSupervisorUrl.replace(/\/$/, "")}/v1/status`);
    if (!response.ok) throw new Error(`supervisor HTTP ${response.status}`);
    return parseSupervisorSnapshot(await response.json());
  }
  return null;
}

export async function invokeServiceAction(
  action: "refresh" | "restart" | "stop" | "start",
  serviceId: string | null
): Promise<SupervisorSnapshotDto | null> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    if (action === "refresh") {
      return parseSupervisorSnapshot(await invoke<unknown>("refresh_services"));
    }
    if (!serviceId) {
      return parseSupervisorSnapshot(await invoke<unknown>("refresh_services"));
    }
    return parseSupervisorSnapshot(await invoke<unknown>("service_action", { action, serviceId }));
  }
  if (debugSupervisorUrl) {
    const base = debugSupervisorUrl.replace(/\/$/, "");
    if (action === "refresh") {
      const response = await fetch(`${base}/v1/refresh`, { method: "POST" });
      return parseSupervisorSnapshot(await response.json());
    }
    if (!serviceId) return getServiceStatus();
    const response = await fetch(`${base}/v1/services/${serviceId}/${action}`, {
      method: "POST"
    });
    return parseSupervisorSnapshot(await response.json());
  }
  return null;
}

/** Shared reducer-backed subscription for surfaces that need projection inputs. */
export function subscribeServiceStatusState(
  onState: (state: ServiceStatusState) => void
): () => void {
  let state = initialServiceStatusState;
  const apply = (action: ServiceStatusAction): void => {
    const next = reduceServiceStatus(state, action);
    if (next === state) return;
    state = next;
    onState(state);
  };
  return subscribeServiceStatus({
    onConnected: (instanceId) => apply({ type: "supervisor-connected", instanceId }),
    onSnapshot: (snapshot) =>
      apply({
        type: "snapshot",
        instanceId: snapshot.instanceId,
        shuttingDown: snapshot.shuttingDown,
        services: snapshot.services,
        updatedAt: snapshot.updatedAt
      }),
    onDisconnected: (error) =>
      apply(
        error ? { type: "supervisor-disconnected", error } : { type: "supervisor-disconnected" }
      )
  });
}

export function parseSupervisorSnapshot(value: unknown): SupervisorSnapshotDto | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const instanceId = record["instanceId"];
  const shuttingDown = record["shuttingDown"];
  const updatedAt = record["updatedAt"];
  const services = normalizeUiServiceSnapshots(record["services"]);
  if (
    typeof instanceId !== "string" ||
    instanceId.trim().length === 0 ||
    typeof shuttingDown !== "boolean" ||
    typeof updatedAt !== "string" ||
    updatedAt.trim().length === 0 ||
    services === null
  ) {
    return null;
  }
  return { instanceId, shuttingDown, services, updatedAt };
}
