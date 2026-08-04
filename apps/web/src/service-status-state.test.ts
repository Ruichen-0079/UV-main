import { describe, expect, it } from "vitest";
import {
  initialServiceStatusState,
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
    expect(
      runtimeChatAvailability([svc({ id: "runtime", status: "healthy" })])
    ).toEqual({ available: true, reason: null });
  });
});
