import type { CompanionBusMessage } from "./companion-bus.js";

export const COMPANION_READY_INTERVAL_MS = 250;
export const COMPANION_READY_MAX_ATTEMPTS = 12;
export const COMPANION_READY_HEARTBEAT_MS = 5000;

export interface CompanionReadyPoster {
  post(message: Extract<CompanionBusMessage, { kind: "companion-ready" }>): void;
}

/**
 * Re-announces "companion-ready" until the main window acknowledges with a
 * "voice-enabled" message. BroadcastChannel has no replay, so a companion
 * window that mounts before (or after) the main window still converges on the
 * current voice-enabled state after it is recreated. After the initial sync a
 * slow heartbeat keeps announcing so a main window that is reopened later can
 * reconnect and re-sync without waiting for the companion to restart.
 */
export function createCompanionReadyAnnouncer(bus: CompanionReadyPoster): {
  start(): void;
  markSynced(): void;
  stop(): void;
} {
  let synced = false;
  let attempts = 0;
  let fastTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (fastTimer !== null) {
      clearInterval(fastTimer);
      fastTimer = null;
    }
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const announce = (): void => {
    if (synced) return;
    attempts += 1;
    bus.post({ kind: "companion-ready" });
    if (attempts >= COMPANION_READY_MAX_ATTEMPTS && fastTimer !== null) {
      clearInterval(fastTimer);
      fastTimer = null;
    }
  };

  return {
    start(): void {
      announce();
      if (!synced && fastTimer === null) {
        fastTimer = setInterval(announce, COMPANION_READY_INTERVAL_MS);
      }
      if (heartbeatTimer === null) {
        heartbeatTimer = setInterval(
          () => bus.post({ kind: "companion-ready" }),
          COMPANION_READY_HEARTBEAT_MS
        );
      }
    },
    markSynced(): void {
      synced = true;
      if (fastTimer !== null) {
        clearInterval(fastTimer);
        fastTimer = null;
      }
    },
    stop
  };
}
