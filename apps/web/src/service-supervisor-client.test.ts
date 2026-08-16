import { describe, expect, it } from "vitest";
import { parseSupervisorSnapshot } from "./service-supervisor-client.js";

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
        updatedAt: "now",
        services: [{ id: "not-a-service", status: "healthy", ownership: "owned" }]
      })
    ).toBeNull();
  });
});
