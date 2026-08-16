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
      updatedAt: "t1",
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

  it("identical service snapshots do not replace state (no re-render)", () => {
    const services = [svc({ id: "runtime", status: "healthy", ownership: "owned", summary: "ok" })];
    let state = reduceServiceStatus(initialServiceStatusState, {
      type: "snapshot",
      instanceId: "i1",
      shuttingDown: false,
      updatedAt: "t1",
      services
    });
    const next = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "i1",
      shuttingDown: false,
      updatedAt: "t2",
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
    expect(next).toBe(state);
    expect(next.updatedAt).toBe("t1");
  });

  it("status change updates snapshot state", () => {
    let state = reduceServiceStatus(initialServiceStatusState, {
      type: "snapshot",
      instanceId: "i1",
      shuttingDown: false,
      updatedAt: "t1",
      services: [svc({ id: "runtime", status: "healthy" })]
    });
    state = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "i1",
      shuttingDown: false,
      updatedAt: "t2",
      services: [svc({ id: "runtime", status: "unavailable", summary: "down" })]
    });
    expect(state.services[0]?.status).toBe("unavailable");
    expect(state.updatedAt).toBe("t2");
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
      updatedAt: "t1",
      services: [svc({ id: "runtime", status: "healthy" })]
    });
    state = reduceServiceStatus(state, { type: "supervisor-disconnected" });
    const late = reduceServiceStatus(state, {
      type: "snapshot",
      instanceId: "instance-a",
      shuttingDown: false,
      updatedAt: "t2",
      services: [svc({ id: "runtime", status: "stopped" })]
    });
    expect(late).toBe(state);
  });
});
