import { describe, expect, it, vi } from "vitest";
import {
  parseSupervisorSnapshot,
  STATUS_FALLBACK_POLL_MS,
  subscribeServiceStatus,
  subscribeServiceStatusState
} from "./service-supervisor-client.js";
import type { SupervisorSnapshotDto } from "./service-supervisor-client.js";

function snapshot(status: "healthy" | "stopped" = "healthy"): SupervisorSnapshotDto {
  return {
    instanceId: "instance-a",
    shuttingDown: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    services: [
      {
        id: "runtime",
        label: "runtime",
        status,
        ownership: "owned",
        url: null,
        summary: status,
        detail: null,
        lastError: null,
        managed: true,
        canRestart: false,
        canStop: false,
        checkedAt: "2026-01-01T00:00:00.000Z"
      }
    ]
  };
}

describe("service supervisor snapshot boundary", () => {
  it("accepts normalized service records", () => {
    expect(
      parseSupervisorSnapshot({
        instanceId: "instance-a",
        shuttingDown: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
        services: [
          {
            id: "runtime",
            status: "healthy",
            ownership: "owned",
            label: "Runtime"
          }
        ]
      })
    ).toMatchObject({
      instanceId: "instance-a",
      services: [{ id: "runtime", status: "healthy", ownership: "owned" }]
    });
  });

  it("rejects malformed supervisor envelopes", () => {
    expect(parseSupervisorSnapshot(null)).toBeNull();
    expect(
      parseSupervisorSnapshot({
        instanceId: "",
        shuttingDown: false,
        updatedAt: "now",
        services: []
      })
    ).toBeNull();
    expect(
      parseSupervisorSnapshot({
        instanceId: "instance-a",
        shuttingDown: false,
        updatedAt: "not-a-date",
        services: [{ id: "not-a-service", status: "healthy", ownership: "owned" }]
      })
    ).toBeNull();
    expect(
      parseSupervisorSnapshot({
        instanceId: "instance-a",
        shuttingDown: false,
        updatedAt: "not-a-date",
        services: []
      })
    ).toBeNull();
  });

  it("fences a poll that resolves after transport loss and accepts a fresh poll", async () => {
    vi.useFakeTimers();
    try {
      let resolvePending!: (value: SupervisorSnapshotDto) => void;
      const pending = new Promise<SupervisorSnapshotDto>((resolve) => {
        resolvePending = resolve;
      });
      let calls = 0;
      const states: Array<{ connected: boolean; instanceId: string | null }> = [];
      const unsubscribe = subscribeServiceStatusState(
        (state) => states.push({ connected: state.connected, instanceId: state.instanceId }),
        {
          getStatus: () => {
            calls += 1;
            if (calls === 2) return pending;
            if (calls === 3) return Promise.reject(new Error("transport lost"));
            return Promise.resolve(snapshot());
          }
        }
      );

      await Promise.resolve();
      await Promise.resolve();
      expect(states.at(-1)).toEqual({ connected: true, instanceId: "instance-a" });

      await vi.advanceTimersByTimeAsync(STATUS_FALLBACK_POLL_MS);
      await vi.advanceTimersByTimeAsync(STATUS_FALLBACK_POLL_MS);
      expect(states.at(-1)).toEqual({ connected: false, instanceId: "instance-a" });

      resolvePending(snapshot());
      await Promise.resolve();
      expect(states.at(-1)).toEqual({ connected: false, instanceId: "instance-a" });

      await vi.advanceTimersByTimeAsync(STATUS_FALLBACK_POLL_MS);
      expect(states.at(-1)).toEqual({ connected: true, instanceId: "instance-a" });
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a pending subscription after cleanup while a replacement subscribes", async () => {
    let resolveOld!: (value: SupervisorSnapshotDto) => void;
    const oldRequest = new Promise<SupervisorSnapshotDto>((resolve) => {
      resolveOld = resolve;
    });
    let resolveCurrent!: (value: SupervisorSnapshotDto) => void;
    const currentRequest = new Promise<SupervisorSnapshotDto>((resolve) => {
      resolveCurrent = resolve;
    });
    const oldAccepted: SupervisorSnapshotDto[] = [];
    const currentAccepted: SupervisorSnapshotDto[] = [];
    const unsubscribeOld = subscribeServiceStatus(
      {
        onConnected: () => undefined,
        onSnapshot: (value) => oldAccepted.push(value),
        onDisconnected: () => undefined
      },
      { getStatus: () => oldRequest }
    );
    unsubscribeOld();
    const unsubscribeCurrent = subscribeServiceStatus(
      {
        onConnected: () => undefined,
        onSnapshot: (value) => currentAccepted.push(value),
        onDisconnected: () => undefined
      },
      { getStatus: () => currentRequest }
    );

    resolveOld(snapshot());
    resolveCurrent(snapshot());
    await Promise.resolve();
    await Promise.resolve();
    expect(oldAccepted).toHaveLength(0);
    expect(currentAccepted).toHaveLength(1);
    unsubscribeCurrent();
  });
});
