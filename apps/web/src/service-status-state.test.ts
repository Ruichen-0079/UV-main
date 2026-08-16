import { describe, expect, it } from "vitest";
import {
  initialServiceStatusState,
  normalizeUiServiceSnapshot,
  normalizeUiServiceSnapshots,
  reduceServiceStatus,
  runtimeChatAvailability,
  selectPrimaryServices,
  type UiServiceSnapshot
} from "./service-status-state.js";

function svc(
  partial: Partial<UiServiceSnapshot> & Pick<UiServiceSnapshot, "id" | "status">
): UiServiceSnapshot {
  return {
    label: partial.id,
    ownership: "none",
    url: null,
    summary: "",
    detail: null,
    lastError: null,
    managed: true,
    canRestart: false,
    canStop: false,
    checkedAt: new Date().toISOString(),
    ...partial
  };
}

describe("service status reducer", () => {
  it("applies snapshots without losing connection", () => {
    let state = reduceServiceStatus(initialServiceStatusState, {
      type: "supervisor-connected",
      instanceId: "i1"
    });
    state = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "i1",
      shuttingDown: false,
      updatedAt: "2026-01-01T00:00:01.000Z",
      services: [svc({ id: "runtime", status: "healthy", ownership: "owned" })]
    });
    expect(state.connected).toBe(true);
    expect(state.services).toHaveLength(1);
    expect(state.services[0]?.ownership).toBe("owned");
  });

  it("records disconnect errors", () => {
    const state = reduceServiceStatus(initialServiceStatusState, {
      type: "supervisor-disconnected",
      error: "supervisor offline"
    });
    expect(state.connected).toBe(false);
    expect(state.lastError).toBe("supervisor offline");
  });

  it("selectPrimaryServices keeps chat-critical order", () => {
    const selected = selectPrimaryServices([
      svc({ id: "tts_wrapper", status: "stopped" }),
      svc({ id: "runtime", status: "healthy" }),
      svc({ id: "mem0", status: "unavailable" }),
      svc({ id: "postgres", status: "healthy" }),
      svc({ id: "ollama", status: "healthy" }),
      svc({ id: "tts_upstream", status: "stopped" })
    ]);
    expect(selected.map((s) => s.id)).toEqual([
      "runtime",
      "mem0",
      "ollama",
      "postgres",
      "tts_wrapper"
    ]);
  });

  it("runtimeChatAvailability blocks chat when runtime is down", () => {
    expect(
      runtimeChatAvailability([svc({ id: "runtime", status: "unavailable", summary: "down" })])
    ).toEqual({ available: false, reason: "down" });
    expect(runtimeChatAvailability([svc({ id: "runtime", status: "healthy" })])).toEqual({
      available: true,
      reason: null
    });
  });

  it("identical service snapshots advance recency without replacing UI references", () => {
    const services = [svc({ id: "runtime", status: "healthy", ownership: "owned", summary: "ok" })];
    let state = reduceServiceStatus(initialServiceStatusState, {
      type: "snapshot",
      instanceId: "i1",
      shuttingDown: false,
      updatedAt: "2026-01-01T00:00:01.000Z",
      services
    });
    const next = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "i1",
      shuttingDown: false,
      updatedAt: "2026-01-01T00:00:02.000Z",
      services: [
        svc({
          id: "runtime",
          status: "healthy",
          ownership: "owned",
          summary: "ok",
          checkedAt: "different-clock"
        })
      ]
    });
    expect(next).not.toBe(state);
    expect(next.services).toBe(state.services);
    expect(next.updatedAt).toBe("2026-01-01T00:00:02.000Z");
  });

  it("status change updates snapshot state", () => {
    let state = reduceServiceStatus(initialServiceStatusState, {
      type: "snapshot",
      instanceId: "i1",
      shuttingDown: false,
      updatedAt: "2026-01-01T00:00:01.000Z",
      services: [svc({ id: "runtime", status: "healthy" })]
    });
    state = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "i1",
      shuttingDown: false,
      updatedAt: "2026-01-01T00:00:02.000Z",
      services: [svc({ id: "runtime", status: "unavailable", summary: "down" })]
    });
    expect(state.services[0]?.status).toBe("unavailable");
    expect(state.updatedAt).toBe("2026-01-01T00:00:02.000Z");
  });

  it("normalizes only supported supervisor service records", () => {
    expect(
      normalizeUiServiceSnapshot({ id: "runtime", status: "healthy", ownership: "owned" })
    ).toMatchObject({ id: "runtime", status: "healthy", ownership: "owned" });
    expect(normalizeUiServiceSnapshot({ id: "unknown", status: "healthy" })).toBeNull();
    expect(
      normalizeUiServiceSnapshots([
        { id: "runtime", status: "healthy", ownership: "owned" },
        { id: "malformed", status: "healthy", ownership: "owned" }
      ])
    ).toBeNull();
  });

  it("rejects older timestamped snapshots and stale supervisor instances", () => {
    let state = reduceServiceStatus(initialServiceStatusState, {
      type: "supervisor-connected",
      instanceId: "instance-a"
    });
    state = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "instance-a",
      shuttingDown: false,
      updatedAt: "2026-01-01T00:00:02.000Z",
      services: [svc({ id: "runtime", status: "healthy" })]
    });
    const older = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "instance-a",
      shuttingDown: false,
      updatedAt: "2026-01-01T00:00:01.000Z",
      services: [svc({ id: "runtime", status: "stopped" })]
    });
    expect(older).toBe(state);

    state = reduceServiceStatus(state, { type: "supervisor-disconnected" });
    state = reduceServiceStatus(state, {
      type: "supervisor-connected",
      instanceId: "instance-b"
    });
    state = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "instance-b",
      shuttingDown: false,
      updatedAt: "2026-01-01T00:00:04.000Z",
      services: [svc({ id: "runtime", status: "healthy" })]
    });
    expect(state.services[0]?.status).toBe("healthy");
    const stale = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "instance-a",
      shuttingDown: false,
      updatedAt: "2026-01-01T00:00:03.000Z",
      services: [svc({ id: "runtime", status: "stopped" })]
    });
    expect(stale).toBe(state);
  });

  it("requires a new connection edge after supervisor transport loss", () => {
    let state = reduceServiceStatus(initialServiceStatusState, {
      type: "supervisor-connected",
      instanceId: "instance-a"
    });
    state = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "instance-a",
      shuttingDown: false,
      updatedAt: "2026-01-01T00:00:01.000Z",
      services: [svc({ id: "runtime", status: "healthy" })]
    });
    state = reduceServiceStatus(state, { type: "supervisor-disconnected" });
    const late = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "instance-a",
      shuttingDown: false,
      updatedAt: "2026-01-01T00:00:02.000Z",
      services: [svc({ id: "runtime", status: "stopped" })]
    });
    expect(late).toBe(state);
  });

  it("rejects malformed timestamps before they become authoritative", () => {
    const state = reduceServiceStatus(initialServiceStatusState, {
      type: "snapshot",
      instanceId: "instance-a",
      shuttingDown: false,
      updatedAt: "not-a-date",
      services: [svc({ id: "runtime", status: "stopped" })]
    });
    expect(state).toBe(initialServiceStatusState);
  });

  it("adopts a replacement instance independently of the retired clock", () => {
    let state = reduceServiceStatus(initialServiceStatusState, {
      type: "snapshot",
      instanceId: "instance-a",
      shuttingDown: false,
      updatedAt: "2026-01-01T12:00:00.000Z",
      services: [svc({ id: "runtime", status: "healthy" })]
    });

    state = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "instance-b",
      shuttingDown: false,
      updatedAt: "2026-01-01T11:59:00.000Z",
      services: [svc({ id: "runtime", status: "starting" })]
    });
    expect(state.instanceId).toBe("instance-b");
    expect(state.services[0]?.status).toBe("starting");

    const staleB = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "instance-b",
      shuttingDown: false,
      updatedAt: "2026-01-01T11:58:00.000Z",
      services: [svc({ id: "runtime", status: "stopped" })]
    });
    expect(staleB).toBe(state);

    state = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "instance-b",
      shuttingDown: false,
      updatedAt: "2026-01-01T12:01:00.000Z",
      services: [svc({ id: "runtime", status: "healthy" })]
    });
    expect(state.services[0]?.status).toBe("healthy");

    const lateA = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "instance-a",
      shuttingDown: false,
      updatedAt: "2026-01-01T12:30:00.000Z",
      services: [svc({ id: "runtime", status: "stopped" })]
    });
    expect(lateA).toBe(state);
  });

  it("accepts a replacement instance with an equal retired timestamp", () => {
    let state = reduceServiceStatus(initialServiceStatusState, {
      type: "snapshot",
      instanceId: "instance-a",
      shuttingDown: false,
      updatedAt: "2026-01-01T12:00:00.000Z",
      services: [svc({ id: "runtime", status: "healthy" })]
    });
    state = reduceServiceStatus(state, {
      type: "supervisor-connected",
      instanceId: "instance-b"
    });
    state = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "instance-b",
      shuttingDown: false,
      updatedAt: "2026-01-01T12:00:00.000Z",
      services: [svc({ id: "runtime", status: "healthy" })]
    });
    expect(state.instanceId).toBe("instance-b");
    expect(state.updatedAt).toBe("2026-01-01T12:00:00.000Z");
  });
});
