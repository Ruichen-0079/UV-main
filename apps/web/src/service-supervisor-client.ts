/**
 * Bridge to the desktop supervisor.
 * In Tauri: invoke Rust commands (which proxy to the supervisor HTTP control plane).
 * Outside Tauri: optional env VITE_YUVI_SUPERVISOR_URL for local debugging only.
 */

import { isTauriRuntime } from "./tauri-window.js";

export type SupervisorSnapshotDto = {
  instanceId: string;
  shuttingDown: boolean;
  services: Array<Record<string, unknown>>;
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
        unlisten = await listen<SupervisorSnapshotDto>("service.status.changed", (event) => {
          if (cancelled) return;
          lastEventAt = Date.now();
          handlers.onConnected(event.payload.instanceId);
          handlers.onSnapshot(event.payload);
        });
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
    return invoke<SupervisorSnapshotDto>("get_service_status");
  }
  if (debugSupervisorUrl) {
    const response = await fetch(`${debugSupervisorUrl.replace(/\/$/, "")}/v1/status`);
    if (!response.ok) throw new Error(`supervisor HTTP ${response.status}`);
    return (await response.json()) as SupervisorSnapshotDto;
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
      return invoke<SupervisorSnapshotDto>("refresh_services");
    }
    if (!serviceId) {
      return invoke<SupervisorSnapshotDto>("refresh_services");
    }
    return invoke<SupervisorSnapshotDto>("service_action", { action, serviceId });
  }
  if (debugSupervisorUrl) {
    const base = debugSupervisorUrl.replace(/\/$/, "");
    if (action === "refresh") {
      const response = await fetch(`${base}/v1/refresh`, { method: "POST" });
      return (await response.json()) as SupervisorSnapshotDto;
    }
    if (!serviceId) return getServiceStatus();
    const response = await fetch(`${base}/v1/services/${serviceId}/${action}`, {
      method: "POST"
    });
    return (await response.json()) as SupervisorSnapshotDto;
  }
  return null;
}
