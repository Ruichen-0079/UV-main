import { describe, expect, it } from "vitest";
import { isCompanionBusMessage } from "./companion-bus.js";

const request = {
  version: "embodied-presentation-request-7ad.v1" as const,
  effectId: "runtime-effect:7af:bus",
  behavior: {
    version: "embodied-behavior-7b.v1" as const,
    behavior: {
      version: "embodied-behavior-7a.v1" as const,
      kind: "SILENCE" as const,
      cause: { kind: "attention" as const, reference: "cause:7af:bus" }
    },
    sourceInstance: { reference: "source:7af:bus", createdAtMs: 1 },
    correlation: { kind: "turn" as const, reference: "turn:7af:bus" }
  }
};

describe("Companion embodied Presentation transport", () => {
  it("accepts only canonical device-neutral requests", () => {
    expect(isCompanionBusMessage({ kind: "embodied-presentation-request", request })).toBe(true);
    expect(
      isCompanionBusMessage({
        kind: "embodied-presentation-request",
        request: { ...request, renderer: "live2d" }
      })
    ).toBe(false);
  });
});
